/**
 * Service-completion SMS copy (owner ruling 2026-08-01).
 *
 * Two changes to service_report_v1 / service_report_v1_with_invoice:
 *
 *  1. Name the service — "Your {service_type} report is ready" instead of the
 *     generic "Your service report is ready". Matches the sibling
 *     service_complete_with_invoice / service_complete_paid_receipt rows, which
 *     already render {service_type}.
 *  2. Drop {reentry_line}. Re-entry timing stays on the linked report; the text
 *     exists to get the customer to that report in one segment.
 *
 * The `variables` column MUST move with the body. The admin editor reads it for
 * its placeholder list, and — more importantly — an unresolved placeholder does
 * not render blank, it suppresses the whole send (#3121). The code side of this
 * change supplies `service_type` and keeps supplying `reentry_line` as an empty
 * string, so neither ordering of code-deploy vs migration can silence a text.
 *
 * Admin-edit guard: the expected body is part of the UPDATE predicate, so a row
 * an operator has edited since is skipped rather than overwritten.
 */

const REWRITES = [
  ['service_report_v1',
    'Hello {first_name}! Your service report is ready: {report_url}{reentry_line}',
    'Hello {first_name}! Your {service_type} report is ready: {report_url}',
    ['first_name', 'service_type', 'report_url']],
  ['service_report_v1_with_invoice',
    'Hello {first_name}! Your service report is ready: {report_url}{reentry_line}\n\nInvoice for today\'s visit: {pay_url}',
    'Hello {first_name}! Your {service_type} report is ready: {report_url}\n\nInvoice for today\'s visit: {pay_url}',
    ['first_name', 'service_type', 'report_url', 'pay_url']],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  if (!cols.body) return;

  let updated = 0;
  const skipped = [];
  for (const [templateKey, expected, next, variables] of REWRITES) {
    const patch = { body: next };
    if (cols.updated_at) patch.updated_at = new Date();
    if (cols.variables) patch.variables = JSON.stringify(variables);
    const matched = await knex('sms_templates')
      .where({ template_key: templateKey, body: expected })
      .update(patch);
    if (matched) updated += 1;
    else skipped.push(templateKey);
  }

  console.log(`[service-report-sms] named the service on ${updated}; skipped ${skipped.length}${skipped.length ? ` (edited since, or missing): ${skipped.join(', ')}` : ''}`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  if (!cols.body) return;

  // Reverse only rows still carrying EXACTLY what up() wrote — anything edited
  // since is left alone, same guard in the other direction.
  for (const [templateKey, expected, next] of REWRITES) {
    const patch = { body: expected };
    if (cols.updated_at) patch.updated_at = new Date();
    if (cols.variables) {
      patch.variables = JSON.stringify(
        templateKey === 'service_report_v1'
          ? ['first_name', 'report_url', 'reentry_line']
          : ['first_name', 'report_url', 'reentry_line', 'pay_url'],
      );
    }
    await knex('sms_templates')
      .where({ template_key: templateKey, body: next })
      .update(patch);
  }
};

exports.REWRITES = REWRITES;
