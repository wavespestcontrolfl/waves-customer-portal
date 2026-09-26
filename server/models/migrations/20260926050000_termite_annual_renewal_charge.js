/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN).
 *
 * annual_prepay_terms.renewal_charge_attempted_at — the at-most-once fence
 * for the ONE automatic Stripe attempt the renewal-charge job makes against
 * a newly-minted renewal successor term. Stamped (via a conditional
 * `WHERE renewal_charge_attempted_at IS NULL` UPDATE) BEFORE the Stripe call
 * — never after — so a crash mid-charge, a concurrent double run of the
 * daily sweep, or a retried tick can never re-attempt the charge once this
 * is set. There is no automatic retry (owner ruling A-13: "never charge
 * twice" outranks "always collect"). Additive, nullable — every existing
 * term (which never went through this job) leaves it null.
 *
 * sms_templates row `termite_annual_renewal_charge_failed` — the customer
 * notice queued when the renewal charge declines or the outcome is
 * ambiguous (never for a no-consent/no-method skip, where nothing was ever
 * attempted against Stripe). Same upsert-by-key shape as every other
 * annual-prepay template seed in this file's lineage (see
 * 20260614000001_annual_prepay_terms_checks.js) — column-guarded so this
 * runs safely on a database missing is_active/sort_order.
 */

const TEMPLATE_KEY = 'termite_annual_renewal_charge_failed';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_attempted_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_charge_attempted_at', { useTz: true });
      });
    }
  }

  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    const now = new Date();
    const template = {
      template_key: TEMPLATE_KEY,
      name: 'Termite Annual Renewal — Charge Failed',
      category: 'billing',
      body: "Hi {first_name}, we tried to charge your card on file ${amount} to renew your Waves Subterranean Termite Protection plan, but it didn't go through. Please pay here to keep your coverage active: {pay_url}.\n\nQuestions or need help? Just reply to this message.",
      variables: JSON.stringify(['first_name', 'amount', 'pay_url']),
      ...(cols.is_active ? { is_active: true } : {}),
      ...(cols.sort_order ? { sort_order: 51 } : {}),
      ...(cols.updated_at ? { updated_at: now } : {}),
      ...(cols.created_at ? { created_at: now } : {}),
    };

    const existing = await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).first();
    if (existing) {
      await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).update({
        name: template.name,
        category: template.category,
        body: template.body,
        variables: template.variables,
        ...(cols.is_active ? { is_active: true } : {}),
        ...(cols.updated_at ? { updated_at: now } : {}),
      });
    } else {
      await knex('sms_templates').insert(template);
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).del();
  }

  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_attempted_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_charge_attempted_at');
      });
    }
  }
};
