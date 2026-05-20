// Derive ../dyson.json from factoriolab's src/data/dsp/data.json.
// Run: node data/sources/build-dyson.mjs
// See ./README.md for the rules this implements.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, 'factoriolab-dsp', 'data.json');
const OUT = resolve(HERE, '..', 'dyson.json');

// Categories whose items can target the calculator (everything else in
// upstream is research / Mecha upgrade and not a factory output).
const PICKABLE_CATEGORIES = new Set(['components', 'buildings']);

// Recipes the calculator's consume-all ingredient model can't represent.
// `producers` is an array; we look for an exact match because some recipes
// list multiple machines (e.g. an assembling recipe + a df- alternative).
const PRODUCERS_TO_SKIP = new Set(['fractionator']);

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

// 4. Two-pass dedup. factoriolab recipes can have multiple outputs (e.g.
//    plasma-refining yields BOTH hydrogen and refined-oil); the first key
//    of `out` is the recipe's PRIMARY output, the rest are byproducts.
//    Pass 1: for each pickable item, pick the best recipe where it's
//    primary. Pass 2: for items still uncovered, fall back to recipes
//    where it's a byproduct. This way "refined oil" correctly resolves
//    to plasma-refining (its only producer is a byproduct) instead of
//    orphaning to a recycle recipe (or to nothing).
const primaryRecipes = {};
const secondaryRecipes = {};
for (const r of eligibleRecipes) {
    const keys = Object.keys(r.out);
    for (let i = 0; i < keys.length; i++) {
        const bucket = i === 0 ? primaryRecipes : secondaryRecipes;
        const out = keys[i];
        (bucket[out] = bucket[out] || []).push(r);
    }
}

function pickBest(candidates) {
    return candidates.slice().sort((a, b) =>
        advancedScore(a.id) - advancedScore(b.id)
        || a.id.localeCompare(b.id),
    );
}

const chosen = {};
const dedupNotes = [];
for (const [output, candidates] of Object.entries(primaryRecipes)) {
    const sorted = pickBest(candidates);
    chosen[output] = sorted[0];
    if (sorted.length > 1) {
        dedupNotes.push({
            item:    output,
            picked:  sorted[0].id,
            dropped: sorted.slice(1).map(c => c.id),
            kind:    'primary',
        });
    }
}
for (const [output, candidates] of Object.entries(secondaryRecipes)) {
    if (chosen[output]) continue;
    const sorted = pickBest(candidates);
    chosen[output] = sorted[0];
    dedupNotes.push({
        item:    output,
        picked:  sorted[0].id,
        dropped: sorted.slice(1).map(c => c.id),
        kind:    'byproduct',
    });
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
    // Inline `mats` keyed by humanized ingredient ids. Filter DLC inputs
    // out (shouldn't happen for base-game recipes, but defensive).
    const mats = {};
    for (const [id, count] of Object.entries(r.in)) {
        if (isDlc(id)) continue;
        mats[humanize(id)] = count;
    }
    const produced = r.out[it.id];
    const entry = {
        recipe:   r.id,
        category: loc.category,
        row:      loc.row,
        col:      loc.col,
        icon:     ICON_POS[it.id] || '0px 0px',
        time:     r.time,
    };
    if (produced !== 1) entry.produced = produced;
    entry.mats = mats;
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

// --- report -------------------------------------------------------------
const total = Object.keys(out).length;
const withRecipe = Object.values(out).filter(e => e.recipe).length;
console.log(`Wrote ${OUT}`);
console.log(`  pickable items: ${total}  (${withRecipe} with recipe, ${total - withRecipe} raw leaves)`);
console.log(`  recipe picks (primary = dedicated recipe, byproduct = chosen from co-output):`);
for (const s of dedupNotes) {
    const drop = s.dropped.length
        ? `, dropped ${s.dropped.join(', ')}`
        : '';
    console.log(`    ${s.item} [${s.kind}]: kept ${s.picked}${drop}`);
}
