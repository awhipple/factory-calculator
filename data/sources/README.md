# Upstream source data

Raw recipe dumps from upstream projects, kept verbatim so we can re-derive
`../*.json` if we want to change our schema/de-dup strategy later.

## `dsp-raw.json` — Dyson Sphere Program

- **Source:** https://raw.githubusercontent.com/gamma-delta/center-brain-archive/gh-pages/dsp.json
- **Upstream repo:** https://github.com/gamma-delta/center-brain-archive
- **Fetched:** 2026-05-19
- **Contents:** `tech_tree`, `recipes` (127 entries), `production_methods`,
  `consumption_methods`. Each recipe has `ingredients`, `results`, `time`,
  `made_in`, `handcraftable`, `unlocked_by`.

## Building `../dyson.json`

```
node data/sources/build-dyson.mjs
```

Result: **97 recipes**, down from upstream's 127. The script applies the
rules below; if you want a different recipe chosen for an item, just edit
`../dyson.json` directly — the raw file here is the canonical fallback.

### Rules applied

1. **Drop extraction recipes** — any recipe with **zero ingredients** is a
   resource-gathering op (mining, pumping, orbital collection, oil
   extraction, ray reception). Their outputs become raw leaves, matching
   how Factorio's `iron ore` is raw.
2. **Drop Fractionator recipes** — they're recycle loops like
   `1 H → 0.99 H + 0.01 D` that the calculator's consume-all ingredient
   model can't represent correctly.
3. **De-dup multi-recipe items** by picking the lowest-scoring "advanced"
   alternative. Score = 10 per rare/late-game ingredient
   (`FractalSilicon`, `KimberliteOre`, `FireIce`, `OpticalGratingCrystal`,
   `UnipolarMagnet`, `SpiniformStalagmiteCrystal`, `GravityMatrix`)
   + 1 per advanced name marker (`Advanced`, `Reformed`, `XRay`). Ties
   break alphabetically.
4. **Key each recipe by `results[0]`** — the calculator's schema is one
   recipe per output item, so secondary outputs are silently lost. See
   "Multi-output byproducts" below.
5. **Humanize names** — CamelCase → lowercase-with-spaces, e.g.
   `MagneticCoil` → `magnetic coil`, `XRayCracking` → `x ray cracking`.
6. **Record the upstream recipe id** in a `recipe:` field on each entry.
   The calculator doesn't read it yet; it's there so a human (or a future
   alt-recipe UI) can see which upstream recipe was chosen as the default.

### Exceptions and recipes intentionally left off

#### 1. Extraction recipes (10 dropped)

These have no ingredients in the raw data — the game produces the output
purely from a source vein, ocean, gas giant, or beam. Treating their
outputs as raw leaves in the calculator matches the Factorio file's
treatment of ores.

| Dropped recipe         | Output           | Producer            |
|------------------------|------------------|---------------------|
| `IronOreMining`        | iron ore         | MiningMachine       |
| `CopperOreMining`      | copper ore       | MiningMachine       |
| `CoalMining`           | coal ore         | MiningMachine       |
| `StoneOreMining`       | stone ore        | MiningMachine       |
| `TitaniumMining`       | titanium ore     | MiningMachine       |
| `SiliconMining`        | silicon ore      | MiningMachine       |
| `WaterPumping`         | water            | WaterPump           |
| `OilExtraction`        | crude oil        | OilExtractor        |
| `CriticalPhotonReceiving` | critical photon | RayReceiver       |
| (gas/ice giant collection — already dropped via de-dup)               |

#### 2. Fractionator recipe (1 dropped)

| Dropped recipe         | Output     | Why                                       |
|------------------------|------------|-------------------------------------------|
| `DeuteriumFractionation` | deuterium | `1 H → 0.99 H + 0.01 D`; recycle loop the model can't express. The kept alternative (`DeuteriumInParticleCollider`, `10 H → 5 D`) is the correct default. |

#### 3. De-dup losers (10 dropped)

For each item with multiple craftable recipes, we kept the one that uses
common ingredients and dropped late-game / rare-resource alternatives.

| Item                 | Kept                        | Dropped                                    |
|----------------------|-----------------------------|--------------------------------------------|
| hydrogen             | PlasmaRefining              | XRayCracking                               |
| graphene             | GrapheneFromGraphiteAndSulfuric | GrapheneFromFireIce                    |
| crystal silicon      | CrystalSiliconFromIngot     | CrystalSiliconFromFractal                  |
| diamond              | DiamondFromGraphite         | DiamondFromKimberlite                      |
| organic crystal      | OrganicCrystalFromPlastic   | OrganicCrystalFromWood ⚠️                  |
| photon combiner      | PhotonCombinerFromPrism     | PhotonCombinerFromCrystal                  |
| casimir crystal      | CasimirCrystalFromTitanium  | CasimirCrystalFromOpticalGratingCrystal    |
| carbon nanotube      | CarbonNanotubeFromGraphene  | CarbonNanotubeFromSpiniform                |
| space warper         | SpaceWarperFromLens         | SpaceWarperFromMatrix                      |
| particle container   | ParticleContainerFromEMTurbine | ParticleContainerFromUnipolar           |

⚠️ **Organic crystal**: tied on the rare-ingredient score (neither
recipe uses a rare item — Plastic and Log/PlantFuel are both farmable).
Alphabetic tie-break gave FromPlastic. FromWood is arguably the more
"early-game basic" recipe — hand-edit `../dyson.json` if you prefer it.

#### 4. Multi-output byproducts — silently dropped secondary outputs

The calculator schema is one recipe per output. When a kept recipe
produces multiple items, we record only `results[0]` and silently drop
the rest. After all filters, only two such recipes remain:

| Recipe          | What we record               | Byproduct lost                |
|-----------------|------------------------------|-------------------------------|
| PlasmaRefining  | `hydrogen` ← 2 crude oil     | 2 refined oil (free per run)  |
| DiracInversion  | `antimatter` ← 2 critical photon | 2 hydrogen (free per run) |

Practical consequences:
- **`refined oil` shows up as a raw leaf** even though oil refining
  produces it. Anything needing refined oil (e.g. `organic crystal` via
  the FromPlastic recipe, `sulfuric acid`) treats it as an
  unaccounted-for raw input rather than crediting it against hydrogen
  production. Result: in real factories, refined oil is essentially free
  if you're producing hydrogen; the calculator over-counts its cost.
- **DiracInversion** similarly under-counts the free hydrogen.

To fix this properly would require either (a) modeling recipes with
multiple outputs in the calculator engine, or (b) hand-authoring a
"refining" entry in `../dyson.json` that splits PlasmaRefining's cost
between hydrogen and refined oil.

#### 5. Items that are raw leaves by design

After all the above, the following items have no recipe in
`../dyson.json` and the calculator treats them as raw ingredients:

| Leaf               | Why                                                     |
|--------------------|---------------------------------------------------------|
| iron / copper / coal / stone / titanium ore | mined from veins              |
| water              | pumped from oceans                                      |
| crude oil          | pumped via oil extractor                                |
| critical photon    | received from Dyson Sphere/Swarm via ray receiver       |
| refined oil        | byproduct of PlasmaRefining — see exception 4           |
| full accumulator   | created by *charging* an empty accumulator with energy; not a craft. Used as an ingredient by `OrbitCollector`. |
