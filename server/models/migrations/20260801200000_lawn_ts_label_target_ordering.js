// Lawn + tree & shrub target prefill: per label, best-fit target first
// (owner request 2026-08-01).
//
// The completion card now caps the label prefill at the three most relevant
// targets (MAX_LABEL_TARGET_PREFILL in SchedulePage.jsx), which makes the
// ORDER of products_catalog.target_pests load-bearing for the first time —
// whatever sits in positions 4+ is never seen. 20260723000001 wrote these
// lists back when order was cosmetic, so several of them bury the target the
// product is actually bought for in SWFL. This migration reorders (and in one
// case completes) the lawn and ornamental lists so the first three are the
// ones that apply here.
//
// Every change is label-supported; where the label is broader than SWFL
// practice, the SWFL-relevant target leads and the rest keep their place:
//
// - Southern chinch bug is the most damaging pest of St. Augustinegrass — the
//   dominant turf in our service area — and does damage March–November in
//   south Florida (UF/IFAS ENY-325). Where a product controls it, it leads.
// - Tropical sod webworm outranks white grubs on St. Augustinegrass here;
//   grubs get markedly less emphasis in the Florida turf literature.
// - Acelepryn (chlorantraniliprole alone) does NOT control chinch bugs — that
//   gap is the entire reason Acelepryn Xtra adds thiamethoxam — so plain
//   Acelepryn leads with caterpillars instead, and Xtra leads with chinch.
// - Tetrino (tetraniliprole) IS labeled for chinch bugs; the list omitted them.
// - Merit 2F is deliberately left alone: imidacloprid is suppression-only on
//   southern chinch bug with documented Florida resistance, so grubs staying
//   its lone turf target is correct, not an oversight.
//
// Same admin-edit-preserving contract as 20260723000001, tightened: a row is
// rewritten ONLY when its current target_pests is byte-for-byte what that
// migration wrote (jsonb equality is order- and case-sensitive). NULL/[] rows
// are intentionally NOT matched here — 20260723000001 already filled them, so
// a NULL today means someone cleared it on purpose. Anything else is an admin
// edit and is never touched. down() reverts only rows still holding exactly
// what this migration wrote.

// [name, next, prev] — `prev` is the verbatim array 20260723000001 wrote.
const TARGET_REORDERS = [
  // ---- Turf insect control ----

  // The chinch-bug line is why this product is chosen over plain Acelepryn;
  // at position 4 the cap dropped it entirely.
  [
    'Acelepryn Xtra',
    ['Southern chinch bugs', 'Tropical sod webworms', 'White grubs', 'Fall armyworms'],
    ['White grubs', 'Tropical sod webworms', 'Fall armyworms', 'Southern chinch bugs'],
  ],
  // No chinch activity on this one — its SWFL job is the caterpillar complex.
  [
    'Acelepryn Insecticide',
    ['Tropical sod webworms', 'Fall armyworms', 'White grubs', 'Billbugs'],
    ['White grubs', 'Tropical sod webworms', 'Fall armyworms', 'Billbugs'],
  ],
  // Labeled for chinch bugs and billbugs (apply when adults first appear in
  // June/July) as well as the grub/caterpillar complex — chinch was missing.
  [
    'Tetrino Insecticide',
    ['Southern chinch bugs', 'Tropical sod webworms', 'Fall armyworms', 'White grubs'],
    ['White grubs', 'Tropical sod webworms', 'Fall armyworms'],
  ],
  // Clothianidin's turf value here is chinch control; grubs are secondary.
  [
    'Arena 50 WDG',
    ['Southern chinch bugs', 'White grubs'],
    ['White grubs', 'Southern chinch bugs'],
  ],
  [
    'Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide',
    ['Southern chinch bugs', 'White grubs'],
    ['White grubs', 'Southern chinch bugs'],
  ],
  // Trichlorfon is the curative/rescue material — the calls it gets written on
  // are active webworm and armyworm feeding and mole cricket tunnelling.
  [
    'Dylox 420 SL T&O Insecticide',
    ['Tropical sod webworms', 'Tawny mole crickets', 'White grubs'],
    ['White grubs', 'Tawny mole crickets', 'Tropical sod webworms'],
  ],

  // ---- Turf disease ----

  // Dollar spot is largely a bermuda/golf problem; on St. Augustinegrass the
  // pair that actually shows up is large patch and gray leaf spot.
  [
    'Pillar G Intrinsic',
    ['Brown patch / large patch', 'Gray leaf spot', 'Dollar spot'],
    ['Brown patch / large patch', 'Dollar spot', 'Gray leaf spot'],
  ],

  // ---- Ornamental / tree & shrub ----

  // IMA-jet's labeled borers (emerald ash borer, Asian longhorned beetle,
  // bronze birch borer) are temperate species we do not have. What these
  // injections actually treat here is sap feeders on ficus and palms, all of
  // which are on the same label — so those lead and borers keep last place.
  [
    'Arborjet Ima-Jet 10',
    ['Ficus whitefly', 'Scale insects', 'Aphids', 'Wood borers'],
    ['Wood borers', 'Aphids', 'Scale insects', 'Whiteflies'],
  ],
  [
    'Arborjet Ima-Jet Systemic Insecticide',
    ['Ficus whitefly', 'Scale insects', 'Aphids', 'Wood borers'],
    ['Wood borers', 'Aphids', 'Scale insects', 'Whiteflies'],
  ],
];

// Exported for the contract test — the `prev` arrays must stay byte-identical
// to what 20260723000001 wrote or every update silently matches nothing.
exports.TARGET_REORDERS = TARGET_REORDERS;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, next, prev] of TARGET_REORDERS) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereRaw('target_pests = ?::jsonb', [JSON.stringify(prev)])
      .update({
        target_pests: JSON.stringify(next),
        updated_at: new Date(),
      });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [name, next, prev] of TARGET_REORDERS) {
    await knex('products_catalog')
      .whereRaw('LOWER(name) = LOWER(?)', [name])
      .whereRaw('target_pests = ?::jsonb', [JSON.stringify(next)])
      .update({
        target_pests: JSON.stringify(prev),
        updated_at: new Date(),
      });
  }
};
