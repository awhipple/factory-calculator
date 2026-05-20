// Derive ../dyson.json from dsp-raw.json.
// Run: node data/sources/build-dyson.mjs
// See ./README.md for the rules this implements.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, 'dsp-raw.json');
const OUT = resolve(HERE, '..', 'dyson.json');

// Raw/late-game items whose presence as an ingredient marks a recipe as the
// "advanced" alternative when the same output has multiple recipes.
const RARE_INGREDIENTS = new Set([
    'FractalSilicon', 'KimberliteOre', 'FireIce',
    'OpticalGratingCrystal', 'UnipolarMagnet', 'SpiniformStalagmiteCrystal',
    'GravityMatrix',
]);

// Name-based markers as a secondary signal (catches e.g. XRayCracking which
// uses common inputs but is still the advanced variant).
const ADVANCED_NAME_MARKERS = ['Advanced', 'Reformed', 'XRay', 'Xray'];

function advancedScore(recipe) {
    let score = 0;
    for (const ing of recipe.ingredients) {
        if (RARE_INGREDIENTS.has(ing.item)) score += 10;
    }
    for (const m of ADVANCED_NAME_MARKERS) {
        if (recipe.recipe.includes(m)) score += 1;
    }
    return score;
}

// CamelCase -> lowercase with spaces. Handles consecutive caps (XRay -> x ray).
function humanize(name) {
    return name
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase();
}

const raw = JSON.parse(readFileSync(SRC, 'utf8'));
const recipes = Object.values(raw.recipes).filter(r =>
    // Skip extraction/gathering ops: a recipe with no ingredients is harvesting
    // a raw resource (mining, pumping, collection, oil extraction, ray
    // reception). The calculator treats their outputs as leaves.
    r.ingredients.length > 0
    // Skip Fractionator recipes (Deuterium, etc.) — they're recycle loops
    // (e.g. "1 H -> 0.01 D + 0.99 H") which the calculator's consume-all
    // ingredient model can't represent. The non-Fractionator alternative is
    // always the better default.
    && r.made_in !== 'Fractionator'
);

// Group surviving recipes by output item, then pick one per group.
const byOutput = {};
for (const r of recipes) {
    const out = r.results[0].item;
    (byOutput[out] = byOutput[out] || []).push(r);
}

const chosen = [];
const skipped = [];
for (const [output, candidates] of Object.entries(byOutput)) {
    candidates.sort((a, b) =>
        advancedScore(a) - advancedScore(b)
        || a.recipe.localeCompare(b.recipe),
    );
    chosen.push(candidates[0]);
    if (candidates.length > 1) {
        skipped.push({
            item: output,
            picked: candidates[0].recipe,
            dropped: candidates.slice(1).map(c => c.recipe),
        });
    }
}

const out = {};
for (const r of chosen.sort((a, b) =>
    a.results[0].item.localeCompare(b.results[0].item),
)) {
    const itemName = humanize(r.results[0].item);
    const produced = r.results[0].count;
    const mats = {};
    for (const ing of r.ingredients) {
        mats[humanize(ing.item)] = ing.count;
    }
    // `recipe` records the upstream recipe id we picked. Not used by the
    // calculator yet — it's a paper trail for de-dup decisions and a
    // foothold for a future "switch recipe" UI.
    const entry = { recipe: r.recipe, time: r.time };
    if (produced !== 1) entry.produced = produced;
    entry.mats = mats;
    out[itemName] = entry;
}

writeFileSync(OUT, JSON.stringify(out, null, 4) + '\n');
console.log(`Wrote ${OUT}`);
console.log(`  recipes: ${Object.keys(out).length}`);
console.log(`  de-duped picks:`);
for (const s of skipped) {
    console.log(`    ${s.item}: kept ${s.picked}, dropped ${s.dropped.join(', ')}`);
}
