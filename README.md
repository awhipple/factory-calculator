# factory-calculator

Recipe / ratio calculator for factory games. Started life as a Factorio
calculator (single-page jQuery + sigma.js graph); now covers both
Factorio (Space Age) and Dyson Sphere Program with a layout-faithful
in-game-style item picker. Pure static site — `index.html` +
`calculator.js` + per-game JSON data + a sigma.js bundle. No build step
for the runtime; optional Node scripts regenerate each game's data file
from a factoriolab snapshot.

**Deployed under [dojo-gateway](https://github.com/awhipple/dojo) at
`https://dojo.whipple.ninja/factory/`** (Aaron's WSL box, Cloudflare
tunnel + Access). The dojo gateway's `static_apps.py` lists this repo
as a static mount; no extra deployment ceremony is needed beyond a
`git pull` on that machine.

## Running locally

```
python3 -m http.server          # any static server works
# then visit http://localhost:8000/
```

Opening `index.html` via `file://` won't work — the JS uses `fetch()`
for the JSON data files and browsers block that on the file scheme.

## Top-level layout

```
index.html                  # markup + CSS (all inline) + script tags
calculator.js               # everything — IIFE inside $(function(){})
sigma/                      # sigma.js 1.x bundle (vendored, untouched)
data/
  factorio.json             # 303 entries, factoriolab-derived rich schema
                            #   (Space Age: base 2.0 + space-age + quality)
  factorio-buildings.json   # id -> { name, speed, icon } for producers
  dyson.json                # 130 entries (114 recipes + 16 raw leaves),
                            #   with category/row/col/icon/byproducts/
                            #   alternatives for the picker + recipe picker
  dyson-buildings.json      # id -> { name, speed } for production buildings
  sources/
    README.md               # data provenance + build-script rules
    build-dyson.mjs         # node script: regenerates dyson.json +
                            #   dyson-buildings.json from factoriolab-dsp/
    build-factorio.mjs      # ditto for factorio.json + factorio-buildings.json
    factoriolab-dsp/        # upstream snapshot (MIT, Doug Broad)
    factoriolab-factorio/   # upstream snapshot (Factorio SA, src/data/spa)
reference/                  # scratch screenshots etc. (gitignored)
```

## URL state

`?game=<id>&item=<name>` — bookmarkable; both halves are restored on
load (falls back to localStorage `last_game` / `last_item`). Updated
via `history.replaceState()` on every change, so the back button doesn't
fill up with intermediate states.

## Per-game data schema

### Rich shape (`factorio.json` and `dyson.json`)

Both games use the same shape, derived from a factoriolab snapshot.

```json
"hydrogen": {
  "recipe":   "plasma-refining",    // upstream recipe id (paper trail)
  "category": "components",         // picker tab
  "row":      0,                    // picker row within tab
  "col":      8,                    // picker column within row
  "icon":     "-128px -128px",      // CSS background-position into icons.webp
  "time":     4,                    // recipe seconds (per unit AFTER load-time
                                    //   divide-by-produced; raw in JSON)
  "produced": 1,                    // outputs per craft (omit if 1)
  "mats":     { "crude oil": 2 },   // ingredients per output unit
  "producers": ["oil-refinery"],    // buildings that make this recipe
  "byproducts": { "refined oil": 2 }, // other outputs of this recipe (info only)
  "alternatives": [
    {
      "recipe": "x-ray-cracking",
      "time": 4, "produced": 1,
      "mats": { "refined oil": 1 },
      "byproducts": { "energetic graphite": 1 },
      "producers": ["oil-refinery"]
    },
    ...
  ]
}
```

Raw resources (iron ore, water, crude oil, etc.) are first-class entries
with `{ category, row, col, icon }` and no recipe — so they're pickable
from both the dropdown and the in-game-style picker, and rendered green
in the graph.

### Regenerating data

```
node data/sources/build-dyson.mjs
node data/sources/build-factorio.mjs
```

See `data/sources/README.md` for what gets filtered per game and how
recipe defaults are picked. Common patterns:

- **Base game only** — DLC items (`df-*` ids) are dropped.
- **Net form** is applied to all recipes before filtering — anything
  appearing in both inputs and outputs is cancelled out. Converts
  catalytic recipes (`x-ray-cracking`: `1 refined-oil + 2 H → 3 H + 1 graphite`)
  into a shape the calculator can express (`1 refined-oil → 1 H + 1 graphite`).
- **Fractionator recipes** (`deuterium-fractionation`) are still
  filtered — the net form makes them mathematically valid but the
  **physical layout** requires circulating ~100 H/s through 100
  fractionators for 1 D/s output, which the graph can't capture.
  Accepted limitation.
- **Default recipe** is picked by `advancedScore + byproduct penalty`:
  a clean (score 0) primary beats a clean byproduct; a clean byproduct
  beats an advanced primary. So `refined oil` defaults to
  `plasma-refining` (byproduct of hydrogen, score 0+0.5) over
  `reforming-refine` (primary, score 1).
- **Cycle scan** runs after building — fails the script loudly if a
  recipe cycle slipped through (rather than crashing the browser).

## Calculator architecture

Everything in `calculator.js` lives inside one `$(function(){})` IIFE.
The state worth knowing about:

| Var | Purpose |
|---|---|
| `items` | The active game's data (read from `dyson.json` / `factorio.json`). |
| `buildings` | Active game's `dyson-buildings.json` (or null). Used by tooltip "buildings" section. |
| `current_game` | One of the keys in `GAMES`. URL + localStorage drive this. |
| `collapsed: Set` | Items the user clicked in the graph to "treat as raw." |
| `recipe_overrides: Map` | item → recipe-id the user picked from the alternatives panel. |
| `total_materials` | Last computed `{ raw: {}, built: {} }` totals — module-scope so the hover tooltip can read counts without recomputing. |

`active_recipe(name)` resolves the recipe an item should use right now
— the override if set, else the inline default fields. All tree walkers
(`count_material_list`, `makeNodes`, `makeEdges`, the tooltip) go
through it so swapping an alternative re-routes the whole UI.

A `visited: Set` argument in `count_material_list` defends against
transitive cycles from combined alternative picks.

### UI surfaces

- **Top toolbar** — game dropdown, item dropdown, picker button (⊞,
  DSP-only), per-second rate input.
- **Item picker modal** (⊞ button) — both games. Sprite-sheet icons from
  the active game's `icons.webp` (DSP: 1472×1472; Factorio SA: 1978×1978
  with 2px gaps). Sprite URL + natural width are set on body via CSS
  variables (`--sprite-url`, `--sprite-natural-w`) so every selector
  consumes them; calculator.js swaps them on game change. Dynamic icon
  sizing scans the active game's widest row and clamps to 36-64 px.
  Tabs come from distinct `category` values. Click an icon → writes
  into the item dropdown.
- **Left panel: Recipe Picker** (`#recipe_picker` / `render_recipe_picker`)
  — for each item in the current tree with at least one alternative,
  shows a radio group. Selecting a non-default sets `recipe_overrides`
  and re-renders. Replaced the old Total Materials panel; that info
  now lives in the hover tooltip.
- **Right panel: Material Graph** — sigma.js force-directed canvas.
  Nodes are blue (root) / yellow (collapsed) / green (raw) / slate
  (intermediate). Click a node to toggle "collapsed." Reload (⟳)
  re-rolls the layout. Legend in the bottom-right (collapsible).
- **Hover tooltip** — shows `needed/s`, `production units`, per-tier
  buildings count, and any byproducts. Tooltip is the per-item info
  surface; the left panel is for *choices*, the tooltip is for *facts*.

### Philosophy: surface info, let the user do some math

A few things are intentionally *not* solved end-to-end:

- **Byproducts** are surfaced ("also produces: 2 refined oil/s") but
  not credited against demand. If a user produces 10 H/s via
  plasma-refining and also needs 5 refined oil/s, the calculator says
  "20 crude oil for H + 5 crude oil for refined oil = 25" while the
  real answer is 20 (the 20 refined oil byproduct covers their need).
  User figures it out.
- **Fractionator** physical layout isn't modeled. See data section.
- **Linear-program-style "optimal mix" of multiple recipes for one
  item** — every recipe is either the default or one of the
  alternatives a user picks; you can't run "30% plasma + 70%
  x-ray-cracking" through the calculator. The graph wouldn't show that
  cleanly anyway.

These are all known limitations; the calculator is designed to take 80%
of the math off the user's plate and surface the remaining 20% so they
can finish in their head.

## Adding a new game

1. Drop a `data/<game>.json` with at least the flat-shape schema. If
   you want the picker, include `category`, `row`, `col`, `icon`
   (with a sibling sprite file). If you want the buildings tooltip
   section, ship `data/<game>-buildings.json`.
2. Add an entry to `GAMES` in `calculator.js`:

   ```js
   var GAMES = {
     factorio: { label: 'Factorio', file: './data/factorio.json' },
     dyson:    { label: 'DSP', file: './data/dyson.json',
                 buildings: './data/dyson-buildings.json' },
     newgame:  { label: 'New Game', file: './data/newgame.json' },
   };
   ```
3. (Optional) If the data comes from an upstream that needs munging,
   add a sibling `data/sources/build-<game>.mjs` and document it in
   `data/sources/README.md`. Treat factoriolab's recipe schema as a
   reasonable common template.

## Open ideas / things discussed but not built

- **Vanilla-Factorio variant.** Today's `factorio.json` is built from
  factoriolab's `spa` snapshot (Space Age). Swapping to
  `src/data/2.0/` (Factorio 2.0 vanilla, base mod only) or
  `src/data/1.1/` (Factorio 1.1) would lose all the Gleba / Vulcanus /
  Aquilo / asteroid items but keep the structure intact. Adding it as
  a separate `GAMES.factorio-vanilla` entry would let players pick.
- **LP solver for byproduct credits.** A small simplex implementation
  (~few hundred lines) could give correct min-raw-input answers for
  multi-output recipes. Would need a UI to express constraints ("I
  want 10 H/s AND 5 refined oil/s, optimize total crude oil"). The
  answer would be a *number*, not a *factory layout*, so it doesn't
  obviously replace the current graph view — would augment it.
- **Production splits.** Sliders for "30% via A, 70% via B" per item.
  Aggregates demand from both. UI is the hard part.
- **Persisting `collapsed` + `recipe_overrides` to the URL.** Right
  now they're session-only. A query param like
  `?collapsed=a,b&recipes=hydrogen:x-ray-cracking,...` would make
  whole planning sessions bookmarkable.
- **Mobile/touch.** Picker modal scales OK; graph hover doesn't work
  without a mouse, and the recipe picker radios are small. Nothing's
  been done specifically for touch.
