// Standardize the warm-season turf disease token on "Large patch"
// (owner approval 2026-08-02: "large patch is fine").
//
// Three spellings of the same disease were in circulation:
//   "Brown patch / large patch"  — 15 rows (20260723000001 + 20260801300000)
//   "Brown patch"                —  4 rows (older label backfills)
//   "Large patch"                —  3 rows (older label backfills)
//
// They are the same pathogen (Rhizoctonia solani), but on warm-season turf —
// which is all of our service area — the correct name is large patch; "brown
// patch" is the cool-season expression. Since the completion chips become the
// customer's service report, three names for one disease read as three
// different findings across reports.
//
// Two shapes:
//  - Straight rename where the row carries one combined or cool-season token.
//  - DEDUPE where a row carries BOTH "Brown patch" and "Large patch" as
//    separate entries (Armada, Headway G, Torque SC). Those collapse to one
//    entry, which shortens the list by one — deliberate, and it changes what
//    falls inside MAX_LABEL_TARGET_PREFILL. Ordering is otherwise preserved:
//    reordering these lists is a separate judgement the owner has not made.
//
// Admin-edit-preserving, same contract as the migrations before it: each row
// is rewritten ONLY when its current target_pests is byte-for-byte the value
// recorded here (captured from prod 2026-08-02). Anything else is an admin
// edit and is left alone. down() restores the exact prior value, and only on
// rows still holding exactly what up() wrote.

// [name, before, after]
const RENAMES = [
  // ---- combined token -> large patch (order and length unchanged) ----
  ['Artavia 2 SC (Azoxy)',
    ['Brown patch / large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring'],
    ['Large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring']],
  ['Headway Fungicide',
    ['Brown patch / large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring'],
    ['Large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring']],
  ['Heritage G',
    ['Brown patch / large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring'],
    ['Large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring']],
  ['Heritage TL',
    ['Brown patch / large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring'],
    ['Large patch', 'Gray leaf spot', 'Take-all root rot', 'Fairy ring']],
  ['Atticus Gunner',
    ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot'],
    ['Large patch', 'Gray leaf spot', 'Dollar spot']],
  ['BASF Pillar SC Intrinsic Brand Fungicide',
    ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot'],
    ['Large patch', 'Gray leaf spot', 'Dollar spot']],
  ['Compass Fungicide',
    ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot'],
    ['Large patch', 'Gray leaf spot', 'Dollar spot']],
  ['Eagle 20EW Fungicide',
    ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot'],
    ['Large patch', 'Gray leaf spot', 'Dollar spot']],
  ['Gravex 20 EW',
    ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot'],
    ['Large patch', 'Gray leaf spot', 'Dollar spot']],
  ['Pillar G Intrinsic',
    ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot'],
    ['Large patch', 'Gray leaf spot', 'Dollar spot']],
  ['Quali-Pro PPZ 14.3 Propiconazole',
    ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot'],
    ['Large patch', 'Gray leaf spot', 'Dollar spot']],
  ['Velista',
    ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot'],
    ['Large patch', 'Gray leaf spot', 'Dollar spot']],
  ['LESCO T-Storm 2G Fungicide',
    ['Brown patch / large patch', 'Dollar spot', 'Gray leaf spot'],
    ['Large patch', 'Dollar spot', 'Gray leaf spot']],
  ['LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide',
    ['Brown patch / large patch', 'Dollar spot', 'Gray leaf spot'],
    ['Large patch', 'Dollar spot', 'Gray leaf spot']],
  ['Nufarm Cleary 3336F Fungicide',
    ['Brown patch / large patch', 'Dollar spot', 'Gray leaf spot'],
    ['Large patch', 'Dollar spot', 'Gray leaf spot']],

  // ---- cool-season token alone -> large patch ----
  ['Medallion SC',
    ['Brown patch', 'Leaf spot', 'Gray leaf spot', 'Anthracnose', 'Summer patch'],
    ['Large patch', 'Leaf spot', 'Gray leaf spot', 'Anthracnose', 'Summer patch']],

  // ---- carried BOTH names: collapse to one entry ----
  ['Armada 50 WDG',
    ['Dollar spot', 'Brown patch', 'Large patch', 'Leaf spot', 'Anthracnose', 'Fairy ring'],
    ['Dollar spot', 'Large patch', 'Leaf spot', 'Anthracnose', 'Fairy ring']],
  ['Headway G',
    ['Brown patch', 'Large patch', 'Gray leaf spot', 'Dollar spot', 'Anthracnose', 'Fairy ring'],
    ['Large patch', 'Gray leaf spot', 'Dollar spot', 'Anthracnose', 'Fairy ring']],
  ['Torque SC',
    ['Dollar spot', 'Brown patch', 'Large patch', 'Anthracnose'],
    ['Dollar spot', 'Large patch', 'Anthracnose']],
];

exports.RENAMES = RENAMES;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, before, after] of RENAMES) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereRaw('target_pests = ?::jsonb', [JSON.stringify(before)])
      .update({ target_pests: JSON.stringify(after), updated_at: new Date() });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  // Safe to reverse by value here — unlike a fill, every row this migration
  // touches was NON-empty and is restored to the exact prior list, so a match
  // on the post-value really does identify a row up() rewrote.
  for (const [name, before, after] of RENAMES) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereRaw('target_pests = ?::jsonb', [JSON.stringify(after)])
      .update({ target_pests: JSON.stringify(before), updated_at: new Date() });
  }
};
