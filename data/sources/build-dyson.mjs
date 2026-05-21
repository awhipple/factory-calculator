// Derive ../dyson.json from factoriolab's src/data/dsp/data.json.
// Run: node data/sources/build-dyson.mjs
// See ./README.md for the rules this implements.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, 'factoriolab-dsp', 'data.json');
const OUT = resolve(HERE, '..', 'dyson.json');
const OUT_BUILDINGS = resolve(HERE, '..', 'dyson-buildings.json');

// Categories whose items can target the calculator (everything else in
// upstream is research / Mecha upgrade and not a factory output).
const PICKABLE_CATEGORIES = new Set(['components', 'buildings']);

// Recipes the calculator's consume-all ingredient model can't represent.
// `producers` is an array; we look for an exact match because some recipes
// list multiple machines (e.g. an assembling recipe + a df- alternative).
const PRODUCERS_TO_SKIP = new Set(['fractionator']);

// Specific recipe ids to exclude entirely — they pass the structural
// filters (no recycle within the single recipe, no DLC, non-extraction)
// but they're "inverse" operations that aren't useful production paths
// AND can create transitive cycles when offered as alternatives. Today
// just `accumulator-discharge`: takes a charged accumulator-full and
// gives back an empty accumulator — that's energy reclaim, not assembly.
const RECIPES_TO_SKIP = new Set(['accumulator-discharge']);

// kebab-case -> "lowercase with spaces". Matches our previous humanization
// (used as dyson.json keys and inside `mats`).
function humanize(id) {
    return id.replace(/-/g, ' ');
}

// Score for picking among multiple recipes that produce the same item.
// Lower wins; ties break alphabetically by recipe id. factoriolab tags
// advanced/alternative variants with consistent suffixes/prefixes.
const ADVANCED_MARKERS = ['-advanced', 'reforming-', 'x-ray-'];
function advancedScore(recipeId) {
    return ADVANCED_MARKERS.reduce(
        (n, m) => n + (recipeId.includes(m) ? 1 : 0),
        0,
    );
}

// Drop DLC items from a name list / object. DLC ids are prefixed `df-`.
const isDlc = id => id.startsWith('df-');

const raw = JSON.parse(readFileSync(SRC, 'utf8'));

// "Net form" a recipe by cancelling out anything that appears in BOTH its
// inputs and outputs. This converts catalytic/cracking-style recipes into
// a shape the calculator's consume-all model can express:
//   x-ray-cracking raw:    1 refined-oil + 2 H -> 3 H + 1 graphite
//   x-ray-cracking net:    1 refined-oil       -> 1 H + 1 graphite
// The math is correct per-second per refinery — the catalytic H cycles
// inside the building, the user just needs to be circulating it. Without
// this, the recycle filter below would drop these recipes entirely and
// they'd never appear as alternatives (which is what prompted this — the
// user noticed x-ray-cracking missing from hydrogen's production choices).
function toNetForm(r) {
    const ins = { ...r.in };
    const outs = { ...r.out };
    for (const k of Object.keys(ins)) {
        if (outs[k] === undefined) continue;
        const minVal = Math.min(ins[k], outs[k]);
        ins[k] -= minVal;
        outs[k] -= minVal;
        // small epsilon to absorb float-arithmetic dust
        if (ins[k]  <= 1e-9) delete ins[k];
        if (outs[k] <= 1e-9) delete outs[k];
    }
    return { ...r, in: ins, out: outs };
}
raw.recipes = raw.recipes.map(toNetForm);

// Icon position lookup. The sprite (factoriolab-dsp/icons.webp) is a 64x64
// grid; each id's `position` is a CSS background-position string like
// "-256px -64px". We inline it into each dyson.json entry so the picker UI
// can render an icon with one HTTP request (the sprite) and zero extra
// lookups at runtime.
const ICON_POS = Object.fromEntries(
    raw.icons.map(ic => [ic.id, ic.position]),
);

// 1. Build the pickable-item universe: components + buildings, base game.
//    Preserve upstream array order so column index = position-in-row.
const pickableItems = raw.items.filter(
    it => PICKABLE_CATEGORIES.has(it.category) && !isDlc(it.id),
);

// 2. Recompute column index per (category, row) after filtering so DLC
//    removals don't leave gaps. Within each row, keep upstream order.
const colMap = {};  // id -> { category, row, col }
{
    const counters = {};
    for (const it of pickableItems) {
        const k = it.category + '/' + it.row;
        const c = counters[k] || 0;
        counters[k] = c + 1;
        colMap[it.id] = { category: it.category, row: it.row, col: c };
    }
}

// 3. Filter eligible recipes. We keep a recipe if it has inputs, isn't DLC,
//    isn't run on a skipped producer (Fractionator), isn't a recycle loop,
//    and produces AT LEAST ONE pickable output.
const eligibleRecipes = raw.recipes.filter(r => {
    if (isDlc(r.id)) return false;
    if (RECIPES_TO_SKIP.has(r.id)) return false;
    if (Object.keys(r.in || {}).length === 0) return false;  // extraction
    if (r.producers && r.producers.every(p => PRODUCERS_TO_SKIP.has(p))) {
        return false;
    }
    // Drop recycle-loop recipes — any recipe whose output also appears in
    // its inputs (e.g. reforming-refine: 2 refined-oil + ... -> 3
    // refined-oil; deuterium-fractionation: 1 H -> 0.99 H + 0.01 D). The
    // calculator's consume-all model would compute "to make 1 X, spend N X"
    // and recurse infinitely in the material tree. The Fractionator filter
    // above is a special case; this catches the rest, no matter the producer.
    const outputs = new Set(Object.keys(r.out));
    if (Object.keys(r.in).some(i => outputs.has(i))) return false;
    return Object.keys(r.out).some(o => colMap[o] !== undefined);
});

// 4. For each pickable item, pick a DEFAULT recipe AND collect alternatives.
//    factoriolab recipes can have multiple outputs (plasma-refining yields
//    BOTH hydrogen and refined-oil); the first key of `out` is the recipe's
//    PRIMARY output, the rest are byproducts.
//
//    Default = lowest-scored recipe across primary AND byproduct producers
//    of an item. Score = advancedScore + (byproduct ? BYPRODUCT_PENALTY : 0).
//    The small byproduct penalty (0.5) means:
//      - a clean (score 0) PRIMARY beats a clean BYPRODUCT      (0.0 vs 0.5)
//      - a clean BYPRODUCT beats an advanced (score 1) PRIMARY  (0.5 vs 1.0)
//    So refined-oil correctly picks plasma-refining-byproduct over
//    reforming-refine-primary, but hydrogen correctly stays with the
//    primary plasma-refining over the byproducts of mass-energy-storage /
//    graphene-advanced — even though all three have advancedScore 0.
//
//    Alternatives = every OTHER recipe that produces this item. The
//    calculator emits these so the user can swap which recipe they use.
const BYPRODUCT_PENALTY = 0.5;
const byOutput = {};  // itemId -> [{ recipe, score, isPrimary }, ...]
for (const r of eligibleRecipes) {
    const keys = Object.keys(r.out);
    for (let i = 0; i < keys.length; i++) {
        const out = keys[i];
        const isPrimary = i === 0;
        const score = advancedScore(r.id) + (isPrimary ? 0 : BYPRODUCT_PENALTY);
        (byOutput[out] = byOutput[out] || [])
            .push({ recipe: r, score, isPrimary });
    }
}

const chosen = {};        // itemId -> default recipe
const altRecipes = {};    // itemId -> [recipe, ...]  (every non-default)
const dedupNotes = [];
for (const [output, candidates] of Object.entries(byOutput)) {
    const sorted = candidates.slice().sort((a, b) =>
        a.score - b.score || a.recipe.id.localeCompare(b.recipe.id),
    );
    chosen[output] = sorted[0].recipe;
    const alts = sorted.slice(1).map(c => c.recipe);
    if (alts.length > 0) altRecipes[output] = alts;
    if (sorted.length > 1) {
        dedupNotes.push({
            item: output,
            kept: sorted[0].recipe.id,
            kind: sorted[0].isPrimary ? 'primary' : 'byproduct',
            altsAdded: alts.map(c => c.id),
        });
    }
}

// Build a recipe-data block for a given (recipe, output-item) pair. Shape
// matches the inline default-recipe fields on each item entry so the
// runtime swaps an alternative in without special-casing. Stored RAW;
// divide_item_time_and_mats_and_add_name normalizes per-output at load.
function recipeBlock(r, outputItem) {
    const mats = {};
    for (const [id, count] of Object.entries(r.in)) {
        if (isDlc(id)) continue;
        mats[humanize(id)] = count;
    }
    const byproducts = {};
    for (const [id, count] of Object.entries(r.out)) {
        if (id === outputItem) continue;
        byproducts[humanize(id)] = count;
    }
    const block = {
        recipe:   r.id,
        time:     r.time,
        produced: r.out[outputItem],
        mats,
    };
    if (Object.keys(byproducts).length > 0) block.byproducts = byproducts;
    const producers = (r.producers || []).filter(p => !isDlc(p));
    if (producers.length > 0) block.producers = producers;
    return block;
}

// 4. Emit dyson.json sorted by humanized item name. Recipes get the full
//    {recipe, category, row, col, time, produced?, mats} record. Items
//    with no recipe (raw leaves) get just {category, row, col}.
const out = {};
const sortedItems = pickableItems.slice().sort(
    (a, b) => humanize(a.id).localeCompare(humanize(b.id)),
);
for (const it of sortedItems) {
    const key = humanize(it.id);
    const loc = colMap[it.id];
    const r = chosen[it.id];
    if (!r) {
        // Raw leaf — pickable but not craftable. Icon id = item id.
        out[key] = {
            category: loc.category,
            row:      loc.row,
            col:      loc.col,
            icon:     ICON_POS[it.id] || '0px 0px',
        };
        continue;
    }
    const def = recipeBlock(r, it.id);
    const entry = {
        recipe:   def.recipe,
        category: loc.category,
        row:      loc.row,
        col:      loc.col,
        icon:     ICON_POS[it.id] || '0px 0px',
        time:     def.time,
    };
    if (def.produced !== 1) entry.produced = def.produced;
    entry.mats = def.mats;
    if (def.producers) entry.producers = def.producers;
    if (def.byproducts) entry.byproducts = def.byproducts;
    // Alternatives are the SAME shape as the inline default minus the
    // item-level fields (category/row/col/icon). Calculator's
    // active_recipe() helper returns either this or the default depending
    // on the user's recipe_overrides selection for this item.
    const alts = (altRecipes[it.id] || [])
        .map(altR => recipeBlock(altR, it.id));
    if (alts.length > 0) entry.alternatives = alts;
    out[key] = entry;
}

// Defensive: scan the result for cycles. The calculator's material tree
// would recurse infinitely on any cycle. The recycle-recipe filter + the
// two-pass dedup above should make this unreachable, but a check here means
// re-running this script after a factoriolab refresh / filter change fails
// loudly instead of silently writing bad JSON — beats finding out via a
// runtime stack overflow in the browser.
{
    const cycles = [];
    function visit(key, stack) {
        const e = out[key];
        if (!e || !e.mats) return;
        for (const m in e.mats) {
            if (stack.includes(m)) {
                cycles.push([...stack, m].join(' -> '));
                continue;
            }
            visit(m, [...stack, m]);
        }
    }
    for (const k of Object.keys(out)) visit(k, [k]);
    if (cycles.length > 0) {
        console.error('FATAL: cycle(s) detected in dyson.json:');
        for (const c of cycles.slice(0, 10)) console.error('  ' + c);
        process.exit(1);
    }
}

writeFileSync(OUT, JSON.stringify(out, null, 4) + '\n');

// --- buildings file --------------------------------------------------------
// Derive id -> { name, speed } for every producer building referenced by a
// kept recipe. Speed comes from factoriolab's items[i].machine.speed (DSP
// vanilla: Assembler Mk.I 0.75 / Mk.II 1.0 / Mk.III 1.5; Arc Smelter 1 /
// Plane Smelter 2; Chemical Plant 1 / Quantum Chemical Plant 2; Oil Refinery
// 1; Particle Collider 1; Matrix Lab 1). Mining/pump/extractor producers
// don't appear here because their recipes are filtered out as extraction
// (zero inputs) — their outputs are vein-rich-and-Sorter-dependent, not
// something this tool can express as "N buildings needed".
const usedProducers = new Set();
for (const e of Object.values(out)) {
    for (const p of (e.producers || [])) usedProducers.add(p);
}
const buildings = {};
for (const it of raw.items) {
    if (!usedProducers.has(it.id)) continue;
    if (!it.machine || typeof it.machine.speed !== 'number') continue;
    buildings[it.id] = {
        name:  it.name,
        speed: it.machine.speed,
        icon:  ICON_POS[it.id] || '0px 0px',  // for tooltip rendering
    };
}
writeFileSync(OUT_BUILDINGS, JSON.stringify(buildings, null, 4) + '\n');

// --- report -------------------------------------------------------------
const total = Object.keys(out).length;
const withRecipe = Object.values(out).filter(e => e.recipe).length;
console.log(`Wrote ${OUT}`);
console.log(`  pickable items: ${total}  (${withRecipe} with recipe, ${total - withRecipe} raw leaves)`);
const withAlts = Object.values(out).filter(e => e.alternatives && e.alternatives.length > 0).length;
console.log(`  items with alternatives: ${withAlts}`);
console.log(`Wrote ${OUT_BUILDINGS}`);
console.log(`  buildings: ${Object.keys(buildings).length}`);
for (const [id, b] of Object.entries(buildings)) {
    console.log(`    ${id.padEnd(32)} ${b.speed}x`);
}
console.log(`  recipe picks (default + alternatives kept; nothing dropped now):`);
for (const s of dedupNotes) {
    const extra = s.altsAdded.length
        ? `  alternatives: ${s.altsAdded.join(', ')}`
        : '';
    console.log(`    ${s.item.padEnd(20)} [${s.kind}] default=${s.kept}${extra ? '\n      ' + extra : ''}`);
}
