// Fill target_pests for products that carry NONE (owner request 2026-08-01).
//
// A full audit of the 137 active control products found 60 with target_pests
// NULL or [] — they prefill nothing on a completion no matter what the
// filtering code does. Artavia 2 SC is the sharpest case: 6 logged uses and
// not a single target, despite being azoxystrobin, the same active as
// Heritage G, which already carries the full turf-disease list.
//
// THE HARD RULE HERE: this migration only ever writes into an EMPTY field.
// Every statement is gated on `target_pests IS NULL OR = '[]'`. It can add,
// never replace. That is deliberate — the previous pass at this problem
// derived targets from the recorded active ingredient and let the guess
// overwrite curated lists, which turned Termidor SC into an ant product,
// Trelona into a cockroach product and HexPro into a rodent product (its
// active ingredient reads "No Bait", which a substring rule matched). Those
// were caught in review and never shipped. A curated list beats a derived one
// every time, so a derived one is not allowed near a populated field.
//
// Rows deliberately NOT filled, and why:
// - Non-selective herbicides (Roundup QuikPro, SureGuard, Fusilade, Segment
//   II): used in beds and edges, not broadcast turf. There is no honest
//   existing token for "whatever is growing where it shouldn't be", and
//   inventing vocabulary is how you get a chip nothing recognizes.
// - Products whose catalog identity is itself in question (Heritage Action,
//   Recognition, Advion WDG Granular, Monument, Tenacity, Tribute Total,
//   T-Zone, Manicure, Snapshot): the product/active/site data needs fixing
//   before any target is meaningful.
// - Propizol and KPHITE: palm disease claims need a current-container-label
//   check first.
// - Hydretain: a hygroscopic soil moisture aid, neither pesticide nor
//   fertilizer. It has no target and should not pretend to.
//
// Ganoderma butt rot and Thielaviopsis trunk rot appear nowhere below and must
// never be added: UF/IFAS is explicit that neither has any chemical control,
// so a chip claiming one was treated is a claim no product can support. The
// completion classifier now refuses to prefill them regardless of catalog
// contents.

const FILLS = [
  // ---- Turf disease --------------------------------------------------
  // Strobilurins / broad-spectrum systemics: the SWFL St. Augustine set.
  ['Artavia 2 SC (Azoxy)', ['Brown patch / large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring']],
  ['Headway Fungicide', ['Brown patch / large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring']],
  ['Heritage TL', ['Brown patch / large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring']],
  ['Compass Fungicide', ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot']],
  ['Velista', ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot']],
  // DMIs.
  ['Atticus Gunner', ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot']],
  ['Quali-Pro PPZ 14.3 Propiconazole', ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot']],
  ['Eagle 20EW Fungicide', ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot']],
  ['Gravex 20 EW', ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot']],
  ['BASF Pillar SC Intrinsic Brand Fungicide', ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot']],
  // Thiophanate-methyl.
  ['LESCO T-Storm 2G Fungicide', ['Brown patch / large patch', 'Dollar spot', 'Gray leaf spot']],
  ['LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide',
    ['Brown patch / large patch', 'Dollar spot', 'Gray leaf spot']],
  ['Nufarm Cleary 3336F Fungicide', ['Brown patch / large patch', 'Dollar spot', 'Gray leaf spot']],
  // Oomycete-specific — these do NOT control true fungi, so the list stays
  // Pythium-only rather than inheriting the broad turf-disease set. And it is
  // the TURF directions specifically: Syngenta's Subdue Maxx label groups
  // "Pythium blight / Pythium damping-off / Yellow tuft" under its turf rate
  // (see the label quote in 20260712100000_catalog_label_rate_backfill.js).
  // Pythium ROOT ROT is an ornamental/nursery use on these labels, and since
  // the classifier reads any "pythium" target as turf, listing it here would
  // have put a root-rot claim on lawn reports (pre-push P1).
  // Banol is propamocarb — Pythium only.
  ['Banol Fungicide', ['Pythium blight', 'Pythium damping-off']],
  // Subdue Maxx is mefenoxam, and the turf rate on the Syngenta label covers
  // yellow tuft alongside the two Pythium entries, so it gets all three.
  ['Subdue Maxx Fungicide', ['Pythium blight', 'Pythium damping-off', 'Yellow tuft (downy mildew)']],

  // ---- Turf herbicide ------------------------------------------------
  ['Barricade 4FL', ['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)']],
  ['Barricade 65WG', ['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)']],
  ['Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide',
    ['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)']],
  ['Envu Specticle Flo Pre-Emergent Liquid Herbicide',
    ['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)']],
  ['LESCO Stonewall 0.37% 18-0-10',
    ['Crabgrass (pre-emergent)', 'Goosegrass (pre-emergent)', 'Annual bluegrass (Poa annua)']],
  // Sedges.
  ['Dismiss 64 oz', ['Purple nutsedge', 'Yellow nutsedge', 'Green kyllinga']],
  ['Certainty Turf Herbicide', ['Purple nutsedge', 'Yellow nutsedge', 'Green kyllinga']],
  ['Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide',
    ['Purple nutsedge', 'Yellow nutsedge', 'Green kyllinga', 'Rice flatsedge']],
  // Broadleaf.
  ['Blindside Herbicide', ['Dollarweed', 'Doveweed', 'Virginia buttonweed', 'Yellow nutsedge']],
  ['LESCO Three-Way Selective Herbicide', ['Dollarweed', 'Clover', 'Spurge', 'Chamberbitter']],
  ['Atrazine 4L', ['Annual bluegrass (Poa annua)', 'Dollarweed', 'Lawn burweed']],
  ['Manor', ['Dollarweed', 'Virginia buttonweed', 'Bahiagrass']],
  ['QP MSM 60DF Turf Herbicide', ['Dollarweed', 'Virginia buttonweed', 'Bahiagrass']],

  // ---- Palm ----------------------------------------------------------
  // Oxytetracycline injection is PREVENTIVE: UF/IFAS PP163 has it repeated
  // every 3-4 months for at least two years on non-symptomatic palms, and
  // notes that once a palm is symptomatic it is usually past saving. The
  // token says "preventive" so a completed visit cannot read as a cure.
  ['Arborjet Arbor OTC Fungicide 1 oz',
    ['Lethal bronzing (palm) — preventive', 'Lethal yellowing (palm) — preventive']],
  ['Arborjet Arbor OTC Fungicide 5 oz',
    ['Lethal bronzing (palm) — preventive', 'Lethal yellowing (palm) — preventive']],
  ['Arborjet PHOSPHO-Jet Systemic Fungicide', ['Palm bud rot (Phytophthora)']],

  // ---- Structural / ornamental insect --------------------------------
  ['Tekko Trio', ['Bed bugs', 'German cockroaches', 'Fleas']],
  // Species-specific per the owner's 2026-07-23 directive — the chips a tech
  // commits become the report's record, so "Wolf spiders" beats "Spiders".
  ['Adjourn SC', ['Wolf spiders', 'American cockroaches', 'Paper wasps', 'Ghost ants']],
  ['Talstar XTRA Granular Insecticide (Verge)', ['Fire ants', 'Fleas', 'Ticks']],
  ['Azatin O Biological Insecticide', ['Aphids', 'Whiteflies', 'Chilli thrips', 'Caterpillars']],
  ['TriTek Spray Oil Emulsion (OMRI)', ['Scale insects', 'Spider mites', 'Aphids', 'Whiteflies']],
  ['Tim-bor Professional Insecticide and Fungicide',
    ['Drywood termites', 'Subterranean termites', 'Wood-boring beetles', 'Wood decay fungi']],
];

exports.FILLS = FILLS;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, targets] of FILLS) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      // Empty ONLY. Never replaces a curated list.
      .whereRaw("(target_pests IS NULL OR target_pests = '[]'::jsonb)")
      .update({
        target_pests: JSON.stringify(targets),
        updated_at: new Date(),
      });
  }
};

// Deliberately a no-op.
//
// The obvious down() — clear every row whose target_pests equals what up()
// wrote — is unsafe, because matching the value does not prove this migration
// authored it. up() only writes into EMPTY fields, so in any environment where
// a row already held that exact list (curated by hand, or seeded by an earlier
// migration), up() skipped it and yet that down() would happily erase it.
// Exact-value equality is not provenance.
//
// Nothing here is destructive to begin with — it only ever fills a field that
// was empty — so there is no state to restore, and the correct reversal is to
// do nothing rather than risk deleting somebody's curated list. To undo a
// specific fill, clear that product's Targets in the admin catalog UI.
exports.down = async function down() {};
