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

// getTemplate prefers an active variant body over the base row
// (server/routes/admin-sms-templates.js — `variant?.body || t.body`), so a
// migration that rewrites sms_templates alone leaves variant recipients on the
// old copy. Same guarded swap the billing-copy migration uses.
//
// Two generations are swept on the way forward: the body this migration
// expects, and the pre-house-voice body a variant created before that sweep
// would still carry (20260801000001 rewrote sms_templates only). Rollback
// restores one body — `expected` — so a corrected variant stays consistent
// with the base row rather than resurrecting copy two generations old.
//
// Prod carries ZERO variant rows for any key (verified read-only 2026-08-03),
// so this is defensive: it covers a variant authored in /admin between now and
// the deploy, and any created later against the old copy.
const LEGACY_VARIANT_BODIES = {
  service_report_v1: [
    'Hello {first_name}! Your Waves service report is ready: {report_url}{reentry_line}\n\nQuestions or requests? Reply here.',
  ],
  service_report_v1_with_invoice: [
    "Hello {first_name}! Your Waves service report is ready: {report_url}{reentry_line}\n\nInvoice for today's visit: {pay_url}\n\nQuestions or requests? Reply here.",
  ],
};

async function rewriteVariants(knex, reverse = false) {
  if (!(await knex.schema.hasTable('sms_template_variants'))) return 0;
  const cols = await knex('sms_template_variants').columnInfo();
  if (!cols.body) return 0;

  let changed = 0;
  for (const [templateKey, expected, next] of REWRITES) {
    const froms = reverse ? [next] : [expected, ...(LEGACY_VARIANT_BODIES[templateKey] || [])];
    const to = reverse ? expected : next;
    for (const from of froms) {
      const patch = { body: to };
      if (cols.updated_at) patch.updated_at = new Date();
      changed += await knex('sms_template_variants')
        .where({ template_key: templateKey, body: from })
        .update(patch);
    }
  }
  return changed;
}

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

  const variants = await rewriteVariants(knex);
  console.log(`[service-report-sms] named the service on ${updated} base row(s) + ${variants} variant(s); skipped ${skipped.length}${skipped.length ? ` (edited since, or missing): ${skipped.join(', ')}` : ''}`);
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

  await rewriteVariants(knex, true);
};

exports.REWRITES = REWRITES;
