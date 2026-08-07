// Fill target_pests for the lawn products still carrying NONE (owner request
// 2026-08-07: "fix the fertilizer targets, also any lawn product that doesn't
// have a target — use the labels of each to fill in the gaps, no more than 6
// per").
//
// Why the fertilizers are empty even though 20260723000001 "filled" them:
// 20260712000051 deduped the catalog and DEACTIVATED the short-name duplicate
// rows (keeper = the full bag name, display_name = the short name). Eleven
// days later 20260723000001 keyed its nutrition fills on the SHORT names with
// a plain `LOWER(name) =` match — so the values landed on the deactivated
// duplicates, and the active keepers the product picker actually serves
// (admin-dispatch loads `active: true` only) kept NULL target_pests. This
// migration re-keys those fills on the keeper names and fills the rest of the
// lawn gap list found in the 2026-08-07 catalog audit.
//
// Same hard rule as 20260801300000: every statement only ever writes into an
// EMPTY field (`target_pests IS NULL OR = '[]'`) on an ACTIVE row. Add, never
// replace — a curated list beats a derived one every time.
//
// List discipline (owner 2026-08-07): max 6 targets per product, ordered by
// SWFL relevance — order is load-bearing because the completion prefill shows
// the top MAX_LABEL_TARGET_PREFILL (3).
//
// Rows deliberately NOT filled, and why:
// - Adjuvants, surfactants, dyes, soil amendments, moisture aids, and growth
//   regulators: productControlsTargets() hides the Targets picker for those
//   categories entirely (owner design 2026-07-23), so a fill would be inert.
//   That covers BRANDT Indicate 5, Endurant colorant, LESCO 90/10, Tracker
//   dye, LESCO-Wet Plus, Dispatch, LESCO Moisture Manager, CarbonPro-L,
//   Humic DG, Espoma Soil Acidifier, Primo Maxx, T-Nex, Anuew EZ, Shortstop.
// - Hydretain: hygroscopic moisture aid, no target by design (20260801300000
//   ruling stands; its Uncategorized category shows a picker but there is
//   still nothing honest to claim).
// - "Quali-Pro" (bare Insecticide row): no product identity, no label to
//   derive from.
// - "The Andersons Turf Fertilizer with Grub/Crabgrass Control": the catalog
//   row conflates TWO SKUs (15-0-4 + 0.2% imidacloprid GrubOut, EPA 9198-236,
//   vs Crabgrass Preventer 26-0-6 with dithiopyr) — no single such product
//   exists. The row needs splitting/pinning before a target list is
//   meaningful.
// - Heritage Action + LESCO Manicure 6FL: see the fungicide section note.
// - Palm / tree & shrub products (NUTRIROOT, Palm-Jet, Mn-Jet Fe, the 8-0-10 /
//   8-2-12 Palm & Tropical ferts, Foliage-Pro, kelp/biostimulant/ornamental
//   inputs, Propizol): not lawn products — out of this request's scope.
//
// Ganoderma butt rot and Thielaviopsis trunk rot appear nowhere below and must
// never be added (no chemical control exists — UF/IFAS).
//
// Nutrition tokens use the PLAIN forms ("Manganese deficiency"), never the
// "(palms)" variants — the completion classifier files "(palm)"-marked tokens
// onto tree & shrub only, and these are turf fertilizers.

const FILLS = [
  // ---- Turf fertilizers → the nutrition goal of the application --------
  // The analysis is printed on the bag; no external label needed.

  // The three keeper rows the 20260723000001 fills missed (re-keyed values):
  ['LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer',
    ['Potassium deficiency', 'Root strength & stress tolerance']],
  ['LESCO 24-0-11 with PolyPlus OPTI',
    ['Nitrogen green-up', 'Color & density', 'Potassium root support']],
  ['LESCO Chelated Iron Plus',
    ['Iron chlorosis (yellowing turf)', 'Deep green color']],

  // Straight-nitrogen sources.
  ['46-0-0 Urea Professional Fertilizer', ['Nitrogen green-up', 'Deep green color']],
  ['LESCO 6-0-0 Liquid', ['Nitrogen green-up', 'Deep green color']],

  // High-potassium / stress-and-root products.
  ['LESCO 0-0-18 Bio KMAG 1% Fe 1% Mg 1% Mn 2.17% S Organic Turf Granular Fertilizer',
    ['Potassium deficiency', 'Magnesium deficiency', 'Micronutrient deficiency', 'Root strength & stress tolerance']],
  ['LESCO 0-0-62 AM MOP Turfgrass Soluble Fertilize', // (sic — catalog name lacks the final "r")
    ['Potassium deficiency', 'Root strength & stress tolerance']],
  ['LESCO 9-0-24 56% PolyPlus',
    ['Potassium deficiency', 'Root strength & winter hardiness', 'Slow-release feeding']],
  ['LESCO Elite 0-0-28 AM 7.5% Fe 6.5% Mn 9% S Turfgrass Granular Fertilizer',
    ['Potassium deficiency', 'Iron chlorosis (yellowing turf)', 'Manganese deficiency', 'Root strength & stress tolerance']],
  ['LESCO Green Flo Phyte Plus 0-0-26 + Micros Liquid Fertilizer',
    ['Potassium deficiency', 'Root strength & stress tolerance', 'Micronutrient deficiency']],

  // Balanced / maintenance blends.
  ['LESCO 13-0-13 60% PolyPlus Landscape',
    ['Nitrogen green-up', 'Potassium root support', 'Slow-release feeding']],
  ['LESCO 13-24-6 Landscape Starter',
    ['Starter root support (new plantings)', 'Balanced feeding']],
  ['LESCO 15-0-15 30% PolyPlus 1% Fe',
    ['Nitrogen green-up', 'Potassium root support', 'Iron chlorosis (yellowing turf)']],
  ['LESCO 16-4-8 50% PolyPlus OPTI 0.05%Cu 1%Fe 0.4%Mn 0.15%Zn MOP Turfgrass Granular',
    ['Balanced feeding', 'Nitrogen green-up', 'Micronutrient deficiency']],
  ['LESCO 17-0-10 50% CRN Mini Granular',
    ['Nitrogen green-up', 'Slow-release feeding', 'Potassium root support']],
  ['LESCO 20-0-0 60% CRN Plus Micros Turfgrass Liquid Fertilizer',
    ['Nitrogen green-up', 'Slow-release feeding', 'Micronutrient deficiency']],
  ['LESCO 20-2-10 30% PolyPlus',
    ['Nitrogen green-up', 'Balanced feeding', 'Slow-release feeding']],
  ['LESCO 20-20-20 Soluble', ['Balanced feeding', 'Nitrogen green-up']],
  ['LESCO 24-0-10 75% PolyPlus OPTI45 Spar-TECH 10% Cl MOP Turfgrass Granular Fertilizer 50 lb. Bag',
    ['Nitrogen green-up', 'Slow-release feeding', 'Potassium root support']],
  ['LESCO 24-2-11 50% NOS Plus BIO 6% Fe',
    ['Nitrogen green-up', 'Iron chlorosis (yellowing turf)', 'Deep green color']],
  ['LESCO 7-1-7 40% PolyPlus', ['Balanced feeding', 'Slow-release feeding']],
  ['LESCO 8-0-10 100% PolyPlus Landscape',
    ['Potassium root support', 'Slow-release feeding']],
  ['PGF Complete 16-4-8',
    ['Balanced feeding', 'Nitrogen green-up', 'Micronutrient deficiency']],

  // ---- Turf fungicides (labels read 2026-08-07) ------------------------
  // NOT filled, deliberately: Heritage Action (EPA 100-1550, label says
  // "DO NOT apply to residential lawns") and LESCO Manicure 6FL (EPA
  // 60063-7-10404, label prohibits home lawns outright). A chip on either
  // would document an off-label application on a customer report — those two
  // need an owner decision (deactivate/restrict), not a target list.
  // Also note: NO product in this catalog carries a St. Augustine take-all
  // root rot claim — TARR must not be chipped onto any of these.

  // Fluopicolide: Pythium only, and the label REQUIRES a tank-mix partner
  // with a different mode of action.
  ['ADORN Fungicide', ['Pythium blight', 'Pythium damping-off']],
  // Fosetyl-Al: Pythium + yellow tuft standalone; the anthracnose claim is
  // the label's tank-mix table (Signature is a mix partner by design).
  ['Chipco Signature', ['Pythium blight', 'Yellow tuft (downy mildew)', 'Anthracnose']],
  // Potassium phosphite: broad turf list on the label — but NOT take-all,
  // despite the extension-lore reputation. Label says "Brown patch", not
  // large patch, so the chip follows the label.
  ['KPHITE 7LP Systemic Fungicide',
    ['Gray leaf spot', 'Pythium blight', 'Brown patch', 'Dollar spot', 'Anthracnose', 'Turf algae']],
  // The two coppers claim ALGAE ONLY on turf — every fungal-disease row on
  // their labels is fruit/veg/ornamental, not turfgrass. Both labels also
  // prohibit tank-mixing with fosetyl-Al (severe phytotoxicity) — the
  // catalog sells both sides of that incompatibility.
  ['Badge SC Bactericide/Fungicide', ['Turf algae']],
  ['Southern Ag Copper Fungicide 27.15%', ['Turf algae']],

  // ---- Turf herbicides (labels read 2026-08-07, EPA reg in parens) -----
  // FIT WARNINGS surfaced to the owner alongside this PR — the lists below
  // are label-accurate, but several of these products are NOT labeled for
  // St. Augustine: Monument (100-1134) and Tribute Total (101563-147) are
  // bermuda/zoysia-only (Tribute names St. Aug in its do-not-use list),
  // Tenacity (100-1267) allows St. Aug only as sod-farm production, and
  // T-Zone SE (2217-976) prohibits St. Aug outright and caps broadcast at
  // 85°F. Target list accuracy and product selection are separate problems
  // (precedent: SpeedZone, #3162).
  // Torpedograss carries an explicit "(suppression)" marker wherever the
  // label claims suppression rather than control — every trifloxysulfuron
  // torpedograss claim is suppression-only.
  ['Monument 75WG',
    ['Purple nutsedge', 'Yellow nutsedge', 'Green kyllinga', 'Dollarweed', 'Poa annua', 'Torpedograss (suppression)']],
  // Recognition is the St. Augustine-safe trifloxysulfuron SKU — label names
  // Floratam/Raleigh/Palmetto/SunClipse as verified-safe varieties, and the
  // Recognition + Fusilade II bermudagrass/torpedograss program in St. Aug is
  // on this label.
  ['Recognition Post Emergent Herbicide',
    ['Purple nutsedge', 'Yellow nutsedge', 'Green kyllinga', 'Dollarweed', 'Torpedograss (suppression)', 'Spurge']],
  ['Tribute Total WDG',
    ['Purple nutsedge', 'Yellow nutsedge', 'Doveweed', 'Green kyllinga', 'Virginia buttonweed', 'Crabgrass']],
  ['Tenacity Herbicide',
    ['Crabgrass', 'Goosegrass', 'Florida pusley', 'Yellow nutsedge', 'Lawn burweed']],
  ['T-Zone SE',
    ['Virginia buttonweed', 'Spurge', 'Florida pusley', 'Lawn burweed', 'Chickweed', 'Clover']],

  // ---- Bed / non-selective herbicides (labels read 2026-08-07) ---------
  // These work landscape beds, borders, and hardscape on a lawn visit — not
  // broadcast turf. 20260801300000 skipped them because no honest token
  // existed; the bed-work chips below are that vocabulary. Bed-only labels
  // here: SureGuard (green-turf use prohibited outside dormant bermuda),
  // Fusilade II (turf = zoysia/fescue only; St. Aug is a susceptible
  // non-target), Segment II (centipede/fine fescue only), Snapshot (not a
  // turf product). Specticle Flo IS labeled for St. Augustine lawns
  // (Floratam named, 6 fl oz/A cap) — its list is turf pre-emergence.
  ['Roundup QuikPro SC',
    ['Non-selective weed control (spot treatment)', 'Driveway & sidewalk crack weeds', 'broadleaf weeds', 'annual grassy weeds']],
  ['SureGuard SC',
    ['Landscape bed weeds (pre-emergent)', 'Chamberbitter', 'Spurge', 'Florida pusley', 'Doveweed', 'Crabgrass (pre-emergent)']],
  // Fusilade II: grass-only product; torpedograss is a full Table-1 claim —
  // in BEDS and non-crop, never over St. Augustine. Bahiagrass is NOT on its
  // weed table.
  ['Fusilade II Post Emergent Liquid Herbicide',
    ['Torpedograss', 'Bed & border grassy weeds', 'annual grassy weeds', 'Crabgrass']],
  // Segment II: no torpedograss claim — do not add one.
  ['Segment II Herbicide',
    ['Bed & border grassy weeds', 'Bahiagrass', 'annual grassy weeds', 'Crabgrass', 'Goosegrass']],
  // Snapshot: Florida pusley is only "partially controlled" at the max rate
  // and doveweed is absent — neither is chipped.
  ['Snapshot 2.5TG',
    ['Landscape bed weeds (pre-emergent)', 'Chamberbitter', 'Spurge', 'Crabgrass (pre-emergent)', 'Annual bluegrass (Poa annua)', 'Chickweed']],
  // Bare duplicate of the Envu Specticle Flo row (filled by 20260801300000
  // with the first three below); same label, fuller list — add-never-replace
  // keeps the Envu row as-is.
  ['Specticle Flo',
    ['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)', 'Doveweed', 'Florida pusley', 'Chamberbitter']],

  // Micronutrient correctors.
  ['LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer',
    ['Manganese deficiency', 'Iron chlorosis (yellowing turf)', 'Micronutrient deficiency']],
  ['LESCO Chelated AM + Micros Turf & Ornamental Liquid Micronutrient',
    ['Micronutrient deficiency', 'Iron chlorosis (yellowing turf)', 'Deep green color']],
  ['Sequestar 6% Fe EDDHA Soluble Micronutrient',
    ['Iron chlorosis (yellowing turf)', 'Deep green color']],
  // Brand still TBD in the catalog, but chelated iron is chelated iron — the
  // goal is unambiguous regardless of which label lands on the row.
  ['Chelated Liquid Iron (brand TBD)',
    ['Iron chlorosis (yellowing turf)', 'Deep green color']],

  // Cytokinin biostimulant (EPA 90022-1) — dedicated TURF section on the
  // label (lawns at spring green-up + monthly; sod establishment; deficiency
  // correction tank-mix). Fertilizer-category row, so its picker shows the
  // nutrition suggestions.
  ['Cytogro Liquid Biostimulant',
    ['Root strength & stress tolerance', 'Turf root development & nutrient uptake', 'Micronutrient deficiency']],
];

exports.FILLS = FILLS;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, targets] of FILLS) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereRaw("(target_pests IS NULL OR target_pests = '[]'::jsonb)")
      .update({
        target_pests: JSON.stringify(targets),
        updated_at: new Date(),
      });
  }
};

// Reverting by value is unsafe: matching the list does not prove this
// migration wrote it (exact-value equality is not provenance — the P0 caught
// on 20260801300000's original down()). up() only fills EMPTY fields, so a
// row that already carried data was never touched; deliberate no-op.
exports.down = async function down() {};
