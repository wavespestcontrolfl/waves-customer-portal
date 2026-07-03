// Populate label-verified safety fields for the pesticides whose EPA labels the
// owner reviewed (2026-07-03): FIFRA signal word, re-entry, rainfast, and the
// rain/irrigation timing that belongs on each product.
//
// Owner-confirmed safety fork: for RESIDENTIAL / non-agricultural turf use the
// re-entry is "until sprays have dried", NOT the label's WPS agricultural REI
// (Armada 12h, Medallion 12h, Drive 12h, SpeedZone 24h, Three-Way 48h). Those
// WPS hours apply only to Worker-Protection-Standard-covered agricultural uses,
// so they are deliberately NOT stored. rei_hours = 0 is the residential value:
// maxProductReentryMinutes floors it against the lawn service-line default
// (30 min) so it renders as "~30 min / until dry", never "0 hours".
//
// The customer-facing re-entry text is our own operational summary ("Keep people
// and pets off treated areas until dry."), not a label quote — the verbatim
// label wording (which for Armada/Drive/Medallion says "protective clothing"
// and does not mention pets) stays in the linked label_url rather than a new
// unrendered column.
//
// Rain / irrigation timing is routed into the existing, consumed fields:
// rainfast_minutes (only where the label states a rainfast time — SpeedZone's
// 3 h) and irrigation_notes (Drive's 24 h no-irrigation, Three-Way's 24 h
// irrigation delay + 4 h rain-forecast avoidance, Acelepryn's 48 h runoff
// advisory). No speculative rain_avoid/irrigation_delay columns are added.
//
// Matched by EPA reg number (stable; covers every duplicate name-variant and the
// two SpeedZone rows that share 2217-1031). Guarded to fill only empty fields —
// re-entry text additionally replaces the generic placeholder — so a real owner
// edit is never clobbered.

const REENTRY_PLACEHOLDER =
  'Follow the product label and technician service report before re-entering treated areas.';
const CUSTOMER_REENTRY = 'Keep people and pets off treated areas until dry.';

// SpeedZone Southern / EW (EPA 2217-1031), owner-verified against the current
// specimen label + EPA PPLS. do_not_tank_mix_with is the label's spray-prep /
// tank-mix restriction, stored as the existing jsonb-array convention.
const SPEEDZONE_TANK_MIX = [
  'Additives that alter spray-solution pH below 5 or above 8.',
  'Liquid fertilizers or mixtures that fail jar-test compatibility, or that form flakes, sludge, gels, precipitates, a separate oily layer, or oil globules.',
  'Adjuvant or spray-additive combinations, unless prior experience shows the tank mixture will not cause objectionable turf injury.',
];
// Operational SOUTHERN warm-season annual cap: 1.5 fl oz/1K max rate x 2
// broadcast applications/site/year = 3.00. The broader label-wide seasonal
// ceiling (4.41 fl oz/1K = 12 pt/A) is recorded in rate_notes only, so it does
// not become the active southern-turf cap.
const SPEEDZONE_MAX_ANNUAL_PER_1000 = 3.0;
const SPEEDZONE_RATE_NOTES =
  'Waves / SW Florida warm-season turf listed on the label: 0.7–1.5 fl oz/1,000 sq ft (2–4 pt/A). ' +
  'Max operational annual/seasonal broadcast total is 3.00 fl oz/1,000 sq ft — the label allows at most 2 broadcast applications per site per year. ' +
  'Cool-season listed turf: 1.5–2.2 fl oz/1,000 sq ft (4–6 pt/A). ' +
  'Label-wide broadcast ceiling is 2.2 fl oz/1,000 sq ft per application and 4.41 fl oz/1,000 sq ft per season/year (12 pt/A); do not use that higher cap for southern warm-season residential turf unless the container label/site permits. ' +
  'Minimum retreatment interval: 30 days (non-cropland), 21 days (sod farms). Spot treatment cannot exceed 1,000 sq ft in any given acre.';

const SAFETY_BY_EPA = [
  {
    epa: '100-1680', // Acelepryn Xtra
    signal_word: 'Caution',
    rei_hours: 0,
    reentry: CUSTOMER_REENTRY,
    irrigation_notes: 'Avoid application when rainfall is forecast within 48 hours to reduce runoff.',
  },
  {
    epa: '101563-142', // Armada 50 WDG
    signal_word: 'Caution',
    rei_hours: 0,
    reentry: CUSTOMER_REENTRY,
  },
  {
    epa: '7969-272', // Drive XLR8
    signal_word: 'Caution',
    rei_hours: 0,
    reentry: CUSTOMER_REENTRY,
    irrigation_notes: 'For best results, do not water or irrigate for 24 hours after application.',
  },
  {
    epa: '100-1448', // Medallion SC
    signal_word: 'Caution',
    rei_hours: 0,
    reentry: CUSTOMER_REENTRY,
  },
  {
    epa: '10404-43', // LESCO Three-Way Selective Herbicide
    signal_word: 'Danger',
    rei_hours: 0,
    reentry: CUSTOMER_REENTRY,
    irrigation_notes: 'Delay irrigation for 24 hours after application; do not apply if rain is expected within 4 hours.',
  },
  {
    epa: '2217-1031', // SpeedZone Southern + SpeedZone Southern EW
    signal_word: 'Caution',
    rei_hours: 0,
    reentry: CUSTOMER_REENTRY,
    rainfast_minutes: 180,
    do_not_tank_mix_with: SPEEDZONE_TANK_MIX,
    max_annual_per_1000: SPEEDZONE_MAX_ANNUAL_PER_1000,
    rate_notes: SPEEDZONE_RATE_NOTES,
  },
];

function isBlank(v) {
  return v == null || v === '';
}

exports.up = async function up(knex) {
  for (const f of SAFETY_BY_EPA) {
    const rows = await knex('products_catalog')
      .where({ epa_reg_number: f.epa })
      .select('id', 'signal_word', 'rei_hours', 'rainfast_minutes', 'reentry_text', 'reentry_summary',
        'irrigation_notes', 'do_not_tank_mix_with', 'max_annual_per_1000', 'rate_notes');
    for (const row of rows) {
      const patch = {};
      if (f.signal_word && isBlank(row.signal_word)) patch.signal_word = f.signal_word;
      if (f.rei_hours != null && row.rei_hours == null) patch.rei_hours = f.rei_hours;
      if (f.rainfast_minutes != null && row.rainfast_minutes == null) patch.rainfast_minutes = f.rainfast_minutes;
      if (f.irrigation_notes && isBlank(row.irrigation_notes)) patch.irrigation_notes = f.irrigation_notes;
      // jsonb columns: only fill when null (a deliberate empty [] is left alone),
      // and JSON.stringify so knex doesn't bind an array as multi-value params.
      if (f.do_not_tank_mix_with && row.do_not_tank_mix_with == null) {
        patch.do_not_tank_mix_with = JSON.stringify(f.do_not_tank_mix_with);
      }
      if (f.max_annual_per_1000 != null && row.max_annual_per_1000 == null) {
        patch.max_annual_per_1000 = f.max_annual_per_1000;
      }
      if (f.rate_notes && row.rate_notes == null) {
        patch.rate_notes = JSON.stringify(f.rate_notes);
      }
      // Re-entry text: fill when empty OR still the generic placeholder; never
      // overwrite a real prior value.
      if (f.reentry && (isBlank(row.reentry_text) || row.reentry_text === REENTRY_PLACEHOLDER)) {
        patch.reentry_text = f.reentry;
      }
      if (f.reentry && (isBlank(row.reentry_summary) || row.reentry_summary === REENTRY_PLACEHOLDER)) {
        patch.reentry_summary = f.reentry;
      }
      if (Object.keys(patch).length) {
        patch.updated_at = knex.fn.now();
        await knex('products_catalog').where({ id: row.id }).update(patch);
      }
    }
  }
};

exports.down = async function down() {
  // Intentional no-op. `up` is fill-only (it writes a field only when it was
  // empty or the generic placeholder), so it can't be reversed without a
  // per-row snapshot of the prior state. A value-matching rollback would erase
  // pre-existing values this migration never wrote — e.g. SpeedZone Southern's
  // rainfast_minutes (180) already set by 20260430000010, which `up` leaves
  // alone. Leave the seeded safety data in place on rollback rather than risk
  // clobbering owner/earlier-migration values.
};
