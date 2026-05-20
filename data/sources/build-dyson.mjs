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

// 3. Pick one recipe per output id. Skip extraction (no-input), skip
//    Fractionator, skip DLC, and de-dup multi-recipe outputs by score.
const eligibleRecipes = raw.recipes.filter(r => {
    if (isDlc(r.id)) return false;
    if (Object.keys(r.in || {}).length === 0) return false;  // extraction
    if (r.producers && r.producers.every(p => PRODUCERS_TO_SKIP.has(p))) {
        return false;
    }
    // Only consider recipes that produce a pickable item as their primary
    // output. `out` is { id -> count }; we use the first key as primary.
    const primary = Object.keys(r.out)[0];
    return colMap[primary] !== undefined;
});

const byOutput = {};
for (const r of eligibleRecipes) {
    const primary = Object.keys(r.out)[0];
    (byOutput[primary] = byOutput[primary] || []).push(r);
}

const chosen = {};
const dedupNotes = [];
for (const [output, candidates] of Object.entries(byOutput)) {
    candidates.sort((a, b) =>
        advancedScore(a.id) - advancedScore(b.id)
        || a.id.localeCompare(b.id),
    );
    chosen[output] = candidates[0];
    if (candidates.length > 1) {
        dedupNotes.push({
            item:    output,
            picked:  candidates[0].id,
            dropped: candidates.slice(1).map(c => c.id),
        });
    }
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

writeFileSync(OUT, JSON.stringify(out, null, 4) + '\n');

// --- report -------------------------------------------------------------
const total = Object.keys(out).length;
const withRecipe = Object.values(out).filter(e => e.recipe).length;
console.log(`Wrote ${OUT}`);
console.log(`  pickable items: ${total}  (${withRecipe} with recipe, ${total - withRecipe} raw leaves)`);
console.log(`  de-duped picks (kept lowest 'advanced' score):`);
for (const s of dedupNotes) {
    console.log(`    ${s.item}: kept ${s.picked}, dropped ${s.dropped.join(', ')}`);
}
