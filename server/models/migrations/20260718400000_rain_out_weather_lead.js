/**
 * rain_out_moved: forecast-grounded lead (owner call, 2026-07-18).
 *
 * The old body baked "{weather_phrase} rolled through your area" into the
 * template — past-tense "heavy rain" even when the tech was moving a stop
 * AHEAD of a storm. The lead becomes a single {weather_lead} variable that
 * services/rain-out.js composes from live NWS data (tense-aware, quotes the
 * actual % chance), plus two new optional clauses:
 *   {better_day_clause} — " Tomorrow looks a lot better — just a 20% chance
 *   of rain." (only when the forecast supports it)
 *   {efficacy_clause}   — the why-we-move note, dark behind
 *   GATE_RAINOUT_EFFICACY_NOTE
 *
 * Read-modify-write splices on the live body so admin copy edits outside
 * the spliced substrings survive. The transform is exported and
 * fixture-tested against the verbatim prod body in
 * server/tests/rain-out.test.js.
 */

const TEMPLATE_KEY = 'rain_out_moved';

const LEAD_OLD = '{weather_phrase} rolled through your area';
const LEAD_NEW = '{weather_lead}';
const OPTION_OLD = '{new_option}.{alt_clause}';
const OPTION_NEW = '{new_option}.{better_day_clause}{alt_clause}';
const CLAUSES_OLD = '{alt_clause}{forecast_clause}';
const CLAUSES_NEW = '{alt_clause}{efficacy_clause}{forecast_clause}';

const VARIABLES = [
  'first_name', 'weather_lead', 'service_type', 'new_option',
  'better_day_clause', 'alt_clause', 'efficacy_clause', 'forecast_clause',
];
const VARIABLES_OLD = [
  'first_name', 'weather_phrase', 'service_type', 'new_option',
  'alt_clause', 'forecast_clause',
];

function transformBody(body) {
  let next = String(body || '');
  if (next.includes(LEAD_OLD)) next = next.replace(LEAD_OLD, LEAD_NEW);
  if (!next.includes('{better_day_clause}') && next.includes(OPTION_OLD)) {
    next = next.replace(OPTION_OLD, OPTION_NEW);
  }
  if (!next.includes('{efficacy_clause}') && next.includes(CLAUSES_OLD)) {
    next = next.replace(CLAUSES_OLD, CLAUSES_NEW);
  }
  return next;
}

function revertBody(body) {
  let next = String(body || '');
  if (next.includes(LEAD_NEW)) next = next.replace(LEAD_NEW, LEAD_OLD);
  next = next.replace(OPTION_NEW, OPTION_OLD);
  next = next.replace(CLAUSES_NEW, CLAUSES_OLD);
  return next;
}

async function spliceRow(knex, splice, variables) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const row = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!row) return;

  const body = splice(row.body);
  if (body === row.body) return;

  const cols = await knex('sms_templates').columnInfo();
  await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).update({
    body,
    ...(cols.variables ? { variables: JSON.stringify(variables) } : {}),
    ...(cols.updated_at ? { updated_at: new Date() } : {}),
  });
}

// Rendering prefers an active variant's body over the base row
// (admin-sms-templates getTemplate → selectVariant), so variants must get
// the same splice or their sends would silently keep the old lead. Prod has
// zero rain_out_moved variants as of 2026-07-18 (verified read-only) — this
// covers any added later. All statuses are spliced so a retired variant
// can't resurrect old copy on reactivation.
async function spliceVariants(knex, splice) {
  if (!(await knex.schema.hasTable('sms_template_variants'))) return;
  const rows = await knex('sms_template_variants').where({ template_key: TEMPLATE_KEY });
  const cols = rows.length ? await knex('sms_template_variants').columnInfo() : null;
  for (const row of rows) {
    const body = splice(row.body);
    if (body === row.body) continue;
    await knex('sms_template_variants').where({ id: row.id }).update({
      body,
      ...(cols.updated_at ? { updated_at: new Date() } : {}),
    });
  }
}

exports.up = async function up(knex) {
  await spliceRow(knex, transformBody, VARIABLES);
  await spliceVariants(knex, transformBody);
};

exports.down = async function down(knex) {
  await spliceRow(knex, revertBody, VARIABLES_OLD);
  await spliceVariants(knex, revertBody);
};

// Exported for the fixture test against the verbatim prod body.
exports._test = { transformBody, revertBody };
