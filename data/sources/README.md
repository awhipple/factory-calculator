# Upstream source data

Raw recipe/icon dumps from upstream projects, kept verbatim so we can
re-derive `../*.json` if we want to change our schema or filtering later.

## `factoriolab-dsp/` — Dyson Sphere Program (canonical)

- **Source:** https://github.com/factoriolab/factoriolab — `src/data/dsp/`
- **License:** MIT (© 2020-2024 Doug Broad). Note: the underlying game
  assets (item names, icon art) are © Youthcat Studio; we use them under
  the same fair-use posture as the wiki and every other fan calculator.
- **Fetched:** 2026-05-19
- **Files:**
  - `data.json` (262 KB) — items, recipes, categories, icon metadata,
    producers, technologies. The authoritative DSP data the upstream
    extracts from the game files.
  - `icons.webp` (795 KB) — sprite sheet of every item/recipe/tech icon.
    **64×64 cells**; positions in `data.json` `icons[].position` are CSS
    `background-position` values (negative offsets).
  - `map.json` (23 KB) — id → in-game numeric ID lookup (e.g. iron-ingot
    is 1101). Not used by the build; kept for cross-reference.
  - `defaults.json` (1 KB) — factoriolab's default-flag values.
  - `hash.json` (33 KB) — short-id hashes used by their app URL state.
    Unused here, kept for completeness.

Each item in `data.json` carries `category` ("components", "buildings",
"technologies", "upgrades") and `row` (0-indexed row inside that
category). Items in the same `(category, row)` appear in the upstream
`items` array in **column order**, exactly matching the in-game
Replicator panel layout — array position is the column.

## Building `../dyson.json`

```
node data/sources/build-dyson.mjs
```

Result: **base-game DSP only** — DarkFog DLC items (`df-*` prefix) are
filtered out. Components + buildings only (technologies/upgrades aren't
craftable in the replicator). Hand-edit the output if you need a
different recipe for a specific item; the upstream files here are the
canonical fallback.

### Rules applied

1. **Skip DLC items** — anything with id starting `df-` (148 items in
   upstream; not in our scope today).
2. **Skip non-craftable categories** — only items in `components` and
   `buildings` make it into `dyson.json`. Technologies and upgrades are
   research goals, not factory outputs.
3. **Skip recipes the calculator can't model**:
   - Recipes with no inputs (mining/pumping/extraction/ray-reception).
     Their outputs become **raw leaves** in the picker — pickable, but no
     ingredient tree.
   - Recipes run on a Fractionator producer.
   - **Recycle-loop recipes** — anything whose output also appears in its
     inputs (e.g. `reforming-refine`: `2 refined-oil + ... → 3
     refined-oil`). The consume-all model would compute "to make 1 X,
     spend N X" and recurse forever. Caught generally regardless of
     producer; the Fractionator filter above is a special case.
4. **Two-pass recipe dedup**:
   - **Pass 1 (primary outputs)** — for each item, pick the best recipe
     where it's the *first* key in `out` (the recipe's headline output).
     Score = 1 per advanced-marker substring in the recipe id
     (`-advanced`, `reforming-`, `x-ray-`); lowest score wins, ties break
     alphabetically.
   - **Pass 2 (byproducts)** — items still without a recipe fall back to
     recipes where they're a co-output. This is how `refined-oil`
     correctly resolves to `plasma-refining` (which is primarily
     `hydrogen`'s recipe but yields refined-oil as a byproduct), rather
     than being orphaned.
   - The build script's stdout marks each pick `[primary]` or
     `[byproduct]` so you can audit.
5. **Column index is recomputed after filtering** — base-game-only rows
   end up contiguous (no gaps from removed DLC items), at the cost of
   not matching a DLC-enabled save's exact column positions.
6. **Each entry records the upstream `recipe` id** as a paper trail and a
   foothold for a future "switch recipe" UI.

### Output schema

```json
"magnetic coil": {
  "recipe":   "magnetic-coil",
  "category": "components",
  "row":      2,
  "col":      5,
  "time":     1,
  "produced": 2,
  "mats":     { "magnet": 2, "copper ingot": 1 }
}
```

Raw leaves omit `recipe`, `time`, `produced`, and `mats`:

```json
"iron ore": {
  "category": "components",
  "row":      0,
  "col":      0
}
```

The calculator's existing logic tolerates entries with no `mats` (the
material tree just bottoms out at the item).

### Icons

The picker UI loads icons from `factoriolab-dsp/icons.webp` (one sprite
sheet, 64×64 cells). Each `dyson.json` key's icon position is looked up
at runtime by joining the upstream id (the `recipe:` field — or the key
humanized back to kebab-case for leaves) to `data.json`'s `icons[]`
array. We don't materialize per-item PNGs; the sprite is one HTTP
request and stays in the browser cache.

## `factoriolab-factorio/` — Factorio Space Age

- **Source:** https://github.com/factoriolab/factoriolab — `src/data/spa/`
  (Space Age: base 2.0 + space-age + quality + elevated-rails).
- **License:** MIT (© 2020-2024 Doug Broad). Underlying game assets are
  © Wube Software (the SA expansion is paid DLC) — same fair-use posture
  as the wiki and every other fan calculator.
- **Fetched:** 2026-05-20
- **Files:**
  - `data.json` (450 KB) — items, recipes, categories, icon metadata,
    producers, technologies, locations (Nauvis / Vulcanus / Gleba /
    Fulgora / Aquilo / space-platform).
  - `icons.webp` (1.74 MB) — sprite sheet, **64×64 cells with a 2px
    gap** (positions are stepped by 66px). Sheet is 1978×1978. The CSS
    cell box (64×64) hides the gap, so the same `--icon-size / 64`
    scaling math from the DSP build still works.
  - `defaults.json`, `hash.json` — kept for completeness; not consumed.
  - No `map.json` here — factoriolab only ships that for DSP.

Vanilla Factorio (no Space Age) is `src/data/2.0/` upstream; 1.1 is
`src/data/1.1/`. We don't snapshot those today; if you want to swap in a
vanilla build, point `build-factorio.mjs`'s `SRC` at a different
snapshot, drop the SA-specific markers from `ADVANCED_MARKERS`, and
prune `FORCE_RAW_LEAF` of Gleba/Aquilo/asteroid items.

## Building `../factorio.json`

```
node data/sources/build-factorio.mjs
```

Mirrors `build-dyson.mjs` — same JSON shape, same net-form / dedup /
cycle-scan structure. Factorio-specific tweaks:

1. **Skip more recipe flags.** Beyond `mining` (extraction): skip
   `recycling` (recycler outputs are 25% returns — not forward
   production), `technology` (research isn't factory output), `burn`
   (fuel-burning byproducts like depleted fuel cells), `hideProducer`
   (auto-generated spoilage bookkeeping), and `grow` (agricultural
   tower fruit growing — yields more seeds than consumed, which would
   create a seed-fruit cycle).
2. **Explicit id-pattern skips.** `empty-*-barrel` (unfill is a sink,
   not production), `*-reprocessing` and `*-asteroid-crushing` (space
   ore loops the linear calculator can't model), `coal-synthesis` and
   `fish-breeding` (artificial / cycling recipes for items we treat as
   raw), `*-bacteria-cultivation` (bacteria-self-replication loop).
3. **`FORCE_RAW_LEAF` set.** Items that should ALWAYS be raw leaves
   even if some recipe lists them as a byproduct — all natural game
   resources (ores, fluids, asteroid chunks, fruit, seeds, eggs,
   spoilage, scrap, etc.). Without this, e.g. `stone` would default to
   `molten-iron-from-lava` because that's the only non-mining recipe
   left after filtering.
4. **Extended `ADVANCED_MARKERS`.** The DSP score-by-suffix trick still
   applies; the markers cover the SA alternates we want to demote so
   the vanilla / Nauvis recipe stays the default: `casting-*`,
   `kovarex-*`, `coal-liquefaction`, `biosulfur`, `biolubricant`,
   `bioplastic`, `burnt-spoilage`, `acid-neutralisation`,
   `solid-fuel-from-ammonia`, `ammonia-rocket-fuel`,
   `rocket-fuel-from-jelly`, `advanced-thruster-*`.

The resulting defaults: iron-plate → smelter (alt: casting-iron via
foundry); heavy-oil → advanced-oil-processing; petroleum-gas →
basic-oil-processing; uranium-235 → uranium-processing (alt: kovarex);
steam → heat-exchanger boil; sulfur → chem-plant; everything else
single-recipe items.

### Sibling buildings file

`../factorio-buildings.json` carries `id -> { name, speed, icon }` for
every producer referenced by a kept recipe — feeds the hover tooltip's
buildings counts. Speeds straight from factoriolab's
`items[i].machine.speed`: assembler 1/2/3 = 0.5 / 0.75 / 1.25; stone /
steel / electric furnace = 1 / 2 / 2; foundry 4×; biochamber 2×;
electromagnetic-plant 2×; cryogenic-plant 2×; oil-refinery / chemical-
plant / centrifuge 1×; recycler 0.5×.
