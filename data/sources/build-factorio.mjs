// Derive ../factorio.json from factoriolab's src/data/spa/data.json
// (Space Age: base + space-age + quality + elevated-rails). Run:
//   node data/sources/build-factorio.mjs
// See ./README.md for the rules this implements. Mirrors build-dyson.mjs
// — same shape output, same dedup/net-form logic; Factorio-specific
// filters (recycling, mining, technology, barrel-empties) handled here.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, 'factoriolab-factorio', 'data.json');
const OUT = resolve(HERE, '..', 'factorio.json');
const OUT_BUILDINGS = resolve(HERE, '..', 'factorio-buildings.json');

// Item categories the calculator surfaces. factoriolab also exposes
// `technology` (research items) and `other` (recycling-only). Neither is
// something a user "plans production of" so we drop both.
const PICKABLE_CATEGORIES = new Set([
    'logistics',
    'production',
    'intermediate-products',
    'space',
    'combat',
    'fluids',
]);

// Recipe flags that indicate a recipe shouldn't appear in our production
// graph at all:
//   mining        - extraction (no inputs); the no-inputs filter also
//                   catches these but the flag is the canonical signal.
//   recycling     - Space Age recycler outputs (25% returns); not a useful
//                   forward production path — would bloat alternatives
//                   with one entry per ingredient.
//   technology    - research recipes (consumes science packs to "produce"
//                   a tech); not factory output.
//   burn          - byproducts of fuel burning (e.g. depleted fuel cells
//                   from a nuclear reactor). User doesn't choose to make
//                   these; they fall out of running a power plant.
//   hideProducer  - auto-generated bookkeeping recipes (spoilage timers,
//                   biolab outputs). factoriolab tags them so its own UI
//                   hides the producer; we shouldn't surface them either.
//   grow          - KEPT. Agricultural tower fruit-growing IS the only way
//                   to produce yumako/jellynut on Gleba.
//   locked        - KEPT. Just means "behind a tech"; doesn't change that
//                   it's a real production recipe.
const SKIP_FLAGS = new Set([
    'mining',
    'recycling',
    'technology',
    'burn',
    'hideProducer',
    // Agricultural-tower fruit growing (yumako-tree, jellystem, tree-plant).
    // These return more seeds than they consume which creates an obvious
    // seed-fruit cycle; in-game the player kickstarts the loop with a
    // handful of seeds and the tower keeps itself fed. Treating yumako /
    // jellynut as raw leaves (and seeds via FORCE_RAW_LEAF below) matches
    // how a planner actually reasons about Gleba — "how much fruit do I
    // need" not "how many seeds do I need to bootstrap".
    'grow',
]);

// Recipe ids to skip explicitly. Several SA recipes pass the structural
// filters but represent in-game cycles the linear calculator can't model
// — keeping them would either create transitive cycles or make natural
// raw resources default to a contrived production path.
function isExplicitSkip(id) {
    // "empty-*-barrel" - unfill barrel back to fluid + empty barrel. Real
    // in-game recipe (used to recover barrels), but it's a SINK, not a
    // production path. The fill side (id'd as the barrel item itself,
    // e.g. `water-barrel`) is kept.
    if (id.startsWith('empty-') && id.endsWith('-barrel')) return true;
    // Asteroid chunk loops. *-reprocessing recipes shuffle one chunk type
    // into a mix of all three — net-form leaves them as "consume 0.8 chunk
    // to produce 0.2 each of two others," which the cycle scanner trips on
    // immediately. *-asteroid-crushing extract ore/carbon/ice from chunks;
    // we treat ores as raw leaves (FORCE_RAW_LEAF) so these would orphan
    // anyway. Skipped wholesale to keep the alternatives panels clean.
    if (id.endsWith('-reprocessing')) return true;
    if (id.endsWith('-asteroid-crushing')) return true;
    // coal-synthesis: carbon + sulfur + water -> coal. Aquilo bootstrap
    // recipe, but it makes coal not-raw across the rest of the game where
    // coal is mined. We keep coal as a raw leaf.
    if (id === 'coal-synthesis') return true;
    // fish-breeding: nutrients + raw-fish + water -> raw-fish (net form:
    // breeds slightly more fish than you start with). Real cycle. raw-fish
    // is a FORCE_RAW_LEAF so this would orphan anyway.
    if (id === 'fish-breeding') return true;
    // Bacteria cultivation: bioflux + bacteria -> bacteria. Cycle similar
    // to fish-breeding; cultivated-iron-bacteria is the SA "iron from
    // Gleba" loop. Skipped; iron-bacteria item stays raw.
    if (id.endsWith('-bacteria-cultivation')) return true;
    return false;
}

// Items that should ALWAYS render as raw leaves, even if some recipe
// produces them as a primary OR byproduct. These are the natural game
// resources — mined, grown, pumped, or emergent from gameplay (spoilage).
// Without this, a stray byproduct registration drags them into the
// production tree with absurd ratios (e.g. defaulting `stone` to
// `molten-iron-from-lava` because that's the only candidate left after
// stone-mining is filtered out).
const FORCE_RAW_LEAF = new Set([
    // Mineable ores / minerals (mining flag filters their extraction
    // recipe; without this they'd back-fill from asteroid crushing or
    // bacteria recipes).
    'iron-ore', 'copper-ore', 'stone', 'coal', 'calcite',
    'uranium-ore', 'tungsten-ore', 'scrap', 'holmium-ore',
    // Aquilo / Fulgora natural fluids and ices.
    'water', 'lava', 'ice', 'fluorine', 'lithium-brine',
    'ammoniacal-solution', 'fluoroketone-cold',
    // Gleba farming inputs. yumako-tree/jellystem are skipped (`grow`),
    // and yumako-processing returns seeds as a byproduct — without
    // FORCE_RAW the seeds would default to "consume 50 fruit per seed",
    // which is nonsense for a self-sustaining farm.
    'yumako', 'jellynut', 'yumako-seed', 'jellynut-seed', 'tree-seed',
    'raw-fish', 'iron-bacteria', 'copper-bacteria',
    'biter-egg', 'pentapod-egg',
    // Spoilage isn't "produced" in any meaningful sense — every spoilable
    // item turns into it after a timer. Bacteria recipes list it as a
    // byproduct; without FORCE_RAW it would default to "make iron-bacteria
    // (consuming jelly) for the spoilage byproduct," which inverts the
    // gameplay relationship.
    'spoilage',
    // Asteroid chunks. Reprocessing recipes are skipped, but planet-travel
    // recipes (nauvis-vulcanus etc.) generate chunks with no inputs and
    // are filtered as extraction — leaving chunks as raw is correct
    // because they're "found in space," not assembled.
    'metallic-asteroid-chunk', 'carbonic-asteroid-chunk',
    'oxide-asteroid-chunk', 'promethium-asteroid-chunk',
]);

// kebab-case -> "lowercase with spaces". Mirrors the DSP build's humanize
// so the picker / dropdown reads the same way.
function humanize(id) {
    return id.replace(/-/g, ' ');
}

// Score for picking a default among multiple recipes producing the same
// item. Lower wins; ties break alphabetically by recipe id. Each marker
// adds 1 to the score, pushing that recipe behind "non-marker" candidates.
//
//   casting-         - SA foundry path (molten-iron/copper instead of
//                      smelting raw ore). Real recipes, but for the
//                      DEFAULT pick we prefer the simpler smelter; the
//                      foundry variant shows up under "alternatives".
//   kovarex-         - uranium-enrichment loop. Net-form converts it to
//                      3 U-238 -> 1 U-235; mathematically valid but it
//                      out-ranks plain `uranium-processing` alphabetically
//                      without this marker, which would be the wrong
//                      default for U-235.
//   coal-liquefaction - alternative oil path that takes coal + steam +
//                      heavy-oil (catalyst) to make more oil. Penalize so
//                      `advanced-oil-processing` stays the default for
//                      heavy-oil. Substring match covers
//                      `simple-coal-liquefaction` and the steam-165
//                      variant too.
//   biosulfur        - Gleba sulfur recipe (spoilage + bioflux -> sulfur).
//                      Penalize so the chem-plant `sulfur` recipe (water +
//                      petroleum-gas) stays the default everywhere else.
//   burnt-spoilage   - Gleba carbon recipe (spoilage -> carbon). Penalize
//                      so chem-plant `carbon` (coal + sulfuric-acid) stays
//                      the default.
const ADVANCED_MARKERS = [
    // Foundry path - molten-metal -> plate/gear/etc. The molten-X recipes
    // themselves are PRIMARY for their own item; casting-X are the SA
    // foundry alternatives we want to demote.
    'casting-',
    // Uranium enrichment loop - net-forms to 3 U238 -> 1 U235; valid math
    // but `uranium-processing` is the canonical primary for U235.
    'kovarex-',
    // Coal-based oil-cracking variants (coal-liquefaction,
    // simple-coal-liquefaction, coal-liquefaction-steam-165). Substring
    // match. Demoted so `advanced-oil-processing` stays the oil primary.
    'coal-liquefaction',
    // Gleba-specific alternates for things that have a vanilla / Nauvis
    // recipe (the alphabetic tiebreak otherwise picks the bio variant).
    'biosulfur', 'biolubricant', 'bioplastic', 'burnt-spoilage',
    'rocket-fuel-from-jelly',
    // Aquilo-specific alternates (ammonia / cryogenic chemistry).
    'solid-fuel-from-ammonia', 'ammonia-rocket-fuel', 'acid-neutralisation',
    // SA "advanced-thruster-*" variants for space-platform thrusters.
    // The plain `thruster-fuel` / `thruster-oxidizer` recipes are the
    // base versions worth defaulting to.
    'advanced-thruster-',
];
function advancedScore(recipeId) {
    return ADVANCED_MARKERS.reduce(
        (n, m) => n + (recipeId.includes(m) ? 1 : 0),
        0,
    );
}

const raw = JSON.parse(readFileSync(SRC, 'utf8'));

// "Net form" a recipe by cancelling out anything that appears in BOTH its
// inputs and outputs. Same trick as the DSP build: converts catalytic
// recipes (kovarex, coal-liquefaction) into a consume-all form the
// calculator can express. The Factorio dataset annotates catalysts
// explicitly via `catalyst` but the math here works without consulting
// that — purely on the in/out diff.
function toNetForm(r) {
    const ins = { ...r.in };
    const outs = { ...r.out };
    for (const k of Object.keys(ins)) {
        if (outs[k] === undefined) continue;
        const minVal = Math.min(ins[k], outs[k]);
        ins[k] -= minVal;
        outs[k] -= minVal;
        if (ins[k]  <= 1e-9) delete ins[k];
        if (outs[k] <= 1e-9) delete outs[k];
    }
    return { ...r, in: ins, out: outs };
}
raw.recipes = raw.recipes.map(toNetForm);

// Icon position lookup. The Space Age sprite (factoriolab-factorio/icons.webp)
// is a 1978x1978 sheet of 64x64 cells with 2px gaps (66-px stride). Stored
// positions use 64-px-cell coordinates relative to the 2px stride, so a
// position like "-66px 0px" lands the 2nd cell across at native scale. The
// runtime scales background-size + position by `--icon-size / 64` and the
// transparent gap pixels stay transparent inside the rendered cell box.
const ICON_POS = Object.fromEntries(
    raw.icons.map(ic => [ic.id, ic.position]),
);
// Items can carry an `icon` field overriding which sprite id to look up
// (e.g. steam-165 -> steam). Build a per-item resolver.
function iconFor(it) {
    return ICON_POS[it.icon || it.id] || '0px 0px';
}

// 1. Pickable items: filter to the categories we surface. Preserve
//    upstream array order so column index = position-in-row.
const pickableItems = raw.items.filter(
    it => PICKABLE_CATEGORIES.has(it.category),
);

// 2. Recompute column per (category, row) after filtering so any DLC /
//    skipped items leave no gaps. Within each row, preserve upstream order
//    — matches the in-game crafting menu position-for-position.
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

// 3. Eligible recipes: must have inputs (else it's extraction), no
//    forbidden flags, not an empty-barrel sink, not a single-recipe
//    recycle loop, and must produce at least one pickable output.
const eligibleRecipes = raw.recipes.filter(r => {
    if (isExplicitSkip(r.id)) return false;
    const flags = r.flags || [];
    if (flags.some(f => SKIP_FLAGS.has(f))) return false;
    if (Object.keys(r.in || {}).length === 0) return false;  // extraction
    // Recycle-loop guard: any recipe whose output also appears in its
    // inputs (after net-form, this is the case when out > in for the same
    // item, but the cancellation already left only the residual on the
    // out side -- so the only recipes hitting this branch are ones whose
    // net-form STILL has the same key on both sides, which shouldn't
    // happen). Kept as a defensive net regardless.
    const outputs = new Set(Object.keys(r.out));
    if (Object.keys(r.in).some(i => outputs.has(i))) return false;
    return Object.keys(r.out).some(o => colMap[o] !== undefined);
});

// 4. For each pickable item, pick a DEFAULT recipe and collect
//    alternatives. Factorio recipes commonly have multiple outputs
//    (advanced-oil-processing yields heavy + light + petroleum); the
//    FIRST key of `out` is the primary, the rest are byproducts. Default
//    score = advancedScore + (byproduct ? 0.5 : 0) so a clean primary
//    beats a clean byproduct beats an advanced primary.
const BYPRODUCT_PENALTY = 0.5;
const byOutput = {};  // itemId -> [{ recipe, score, isPrimary }, ...]
for (const r of eligibleRecipes) {
    const keys = Object.keys(r.out);
    for (let i = 0; i < keys.length; i++) {
        const out = keys[i];
        // FORCE_RAW_LEAF items never register as a recipe candidate — they
        // stay raw leaves no matter how many recipes happen to spit them
        // out as a byproduct.
        if (FORCE_RAW_LEAF.has(out)) continue;
        const isPrimary = i === 0;
        const score = advancedScore(r.id) + (isPrimary ? 0 : BYPRODUCT_PENALTY);
        (byOutput[out] = byOutput[out] || [])
            .push({ recipe: r, score, isPrimary });
    }
}

const chosen = {};     // itemId -> default recipe
const altRecipes = {}; // itemId -> [recipe, ...]  (every non-default)
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

// Build a recipe-data block for (recipe, output-item). Shape mirrors the
// inline default fields on each item entry so the runtime swaps an
// alternative in without special-casing. Stored RAW;
// divide_item_time_and_mats_and_add_name normalizes per-output at load.
function recipeBlock(r, outputItem) {
    const mats = {};
    for (const [id, count] of Object.entries(r.in)) {
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
    const producers = (r.producers || []);
    if (producers.length > 0) block.producers = producers;
    return block;
}

// 5. Emit factorio.json sorted by humanized item name. Recipe entries get
//    {recipe, category, row, col, icon, time, produced?, mats, ...};
//    raw leaves get just {category, row, col, icon}.
const out = {};
const sortedItems = pickableItems.slice().sort(
    (a, b) => humanize(a.id).localeCompare(humanize(b.id)),
);
for (const it of sortedItems) {
    const key = humanize(it.id);
    const loc = colMap[it.id];
    const r = chosen[it.id];
    if (!r) {
        out[key] = {
            category: loc.category,
            row:      loc.row,
            col:      loc.col,
            icon:     iconFor(it),
        };
        continue;
    }
    const def = recipeBlock(r, it.id);
    const entry = {
        recipe:   def.recipe,
        category: loc.category,
        row:      loc.row,
        col:      loc.col,
        icon:     iconFor(it),
        time:     def.time,
    };
    if (def.produced !== 1) entry.produced = def.produced;
    entry.mats = def.mats;
    if (def.producers) entry.producers = def.producers;
    if (def.byproducts) entry.byproducts = def.byproducts;
    const alts = (altRecipes[it.id] || [])
        .map(altR => recipeBlock(altR, it.id));
    if (alts.length > 0) entry.alternatives = alts;
    out[key] = entry;
}

// Defensive cycle scan. The calculator would recurse forever on any cycle
// — the no-input + recycle filters above should make this unreachable but
// the check fails the build loudly instead of writing bad JSON. Mirrors
// the DSP build.
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
        console.error('FATAL: cycle(s) detected in factorio.json:');
        for (const c of cycles.slice(0, 10)) console.error('  ' + c);
        process.exit(1);
    }
}

writeFileSync(OUT, JSON.stringify(out, null, 4) + '\n');

// --- buildings file --------------------------------------------------------
// id -> { name, speed, icon } for every producer building referenced by a
// kept recipe. factoriolab tags buildings with `machine.speed` (e.g.
// assembling-machine-1 = 0.5, foundry = 4, biochamber = 2). Mining /
// pumping producers don't appear here because their recipes are filtered
// as extraction.
const usedProducers = new Set();
for (const e of Object.values(out)) {
    for (const p of (e.producers || [])) usedProducers.add(p);
    for (const alt of (e.alternatives || [])) {
        for (const p of (alt.producers || [])) usedProducers.add(p);
    }
}
const buildings = {};
for (const it of raw.items) {
    if (!usedProducers.has(it.id)) continue;
    if (!it.machine || typeof it.machine.speed !== 'number') continue;
    buildings[it.id] = {
        name:  it.name,
        speed: it.machine.speed,
        icon:  iconFor(it),
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
console.log(`  recipe picks (showing items with at least one alternative):`);
for (const s of dedupNotes) {
    if (s.altsAdded.length === 0) continue;
    console.log(`    ${s.item.padEnd(28)} [${s.kind}] default=${s.kept}`);
    console.log(`      alts: ${s.altsAdded.join(', ')}`);
}
