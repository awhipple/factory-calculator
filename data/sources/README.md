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
   - Fractionator recipes (e.g. `deuterium-fractionation`,
     `1 H → 0.99 H + 0.01 D`) — recycle loops the consume-all model can't
     express. The Particle Collider alternative for Deuterium is kept.
4. **One recipe per output item** — when multiple recipes produce the
   same item, prefer the basic one. Score = 1 per "advanced" name marker
   in the recipe id (`-advanced`, `reforming-`, `x-ray-`); lowest wins,
   ties break alphabetically. factoriolab tags advanced recipes with a
   `-advanced` suffix consistently, so this is simpler than our previous
   ingredient-shape scoring.
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
