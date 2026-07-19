/**
 * rain_out_moved_v2: forecast-grounded rain-out SMS template.
 *
 * A NEW row instead of splicing rain_out_moved in place, so the rollout has
 * no cross-version render hazard in either direction:
 *   - new code renders rain_out_moved_v2 ({weather_lead} + optional
 *     {better_day_clause}/{efficacy_clause}, composed from live NWS data);
 *   - old code (or a rolled-back deploy) keeps rendering the untouched
 *     legacy rain_out_moved row;
 *   - a rolled-back MIGRATION alone is also safe: new code falls back to
 *     the legacy row with legacy variables when v2 is missing/inactive.
 * The legacy row is retired in a follow-up cleanup PR once this deploy is
 * verified (#2872).
 *
 * The v2 body is derived from the LIVE legacy body via the same splice used
 * everywhere (read-modify-write), so admin copy edits outside the splice
 * points carry over; transform is fixture-tested against the verbatim prod
 * body in server/tests/rain-out.test.js. A missing legacy row (shouldn't
 * happen — the 20260611000002 seed precedes this) falls back to the
 * canonical seed text.
 */

const TEMPLATE_KEY = 'rain_out_moved_v2';
const LEGACY_KEY = 'rain_out_moved';

const LEAD_OLD = '{weather_phrase} rolled through your area';
const LEAD_NEW = '{weather_lead}';
const OPTION_OLD = '{new_option}.{alt_clause}';
const OPTION_NEW = '{new_option}.{better_day_clause}{alt_clause}';
const CLAUSES_OLD = '{alt_clause}{forecast_clause}';
const CLAUSES_NEW = '{alt_clause}{efficacy_clause}{forecast_clause}';

const FALLBACK_LEGACY_BODY = 'Hello {first_name} — {weather_phrase} rolled through your area, so we moved your {service_type} to {new_option}.{alt_clause}{forecast_clause}\n\nQuestions or requests? Reply to this message.';

const VARIABLES = [
  'first_name', 'weather_lead', 'service_type', 'new_option',
  'better_day_clause', 'alt_clause', 'efficacy_clause', 'forecast_clause',
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

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (existing) return;

  const legacy = await knex('sms_templates').where({ template_key: LEGACY_KEY }).first();
  const body = transformBody(legacy?.body || FALLBACK_LEGACY_BODY);

  await knex('sms_templates').insert({
    template_key: TEMPLATE_KEY,
    name: 'Rain Out - Appointment Moved (Forecast)',
    category: 'service',
    body,
    variables: JSON.stringify(VARIABLES),
    sort_order: (legacy?.sort_order ?? 9) + 1,
    is_active: true,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).del();
};

// Exported for the fixture test against the verbatim prod body.
exports._test = { transformBody };
