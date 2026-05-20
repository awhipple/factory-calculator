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
