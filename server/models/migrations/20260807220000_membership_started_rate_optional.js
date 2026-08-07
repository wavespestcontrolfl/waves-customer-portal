/**
 * membership.started: monthly_rate becomes OPTIONAL (#3140 resolution).
 *
 * The welcome email is now lane-gated (account-membership-email.js): only a
 * monthly_membership customer sees a monthly rate; a per-application
 * customer sees the acceptance-stamped per-application fee — which is
 * intentionally BLANK on multi-service accepts (no customer-level fee
 * exists by design) — and an annual-prepay customer sees no rate at all
 * ("12 months prepaid"). Blank values ride the details renderer's
 * empty-row dropping, but requiredPayloadMissing fails a send on any blank
 * REQUIRED variable, so monthly_rate must move to the optional set or the
 * gated sends fail outright instead of dropping the row.
 *
 * billing_cadence stays required — every lane provides a non-empty label.
 *
 * Read-modify-write on the live arrays (admin contract edits to OTHER
 * variables are preserved); the down() moves the variable back.
 */

const TEMPLATE_KEY = 'membership.started';
const VARIABLE = 'monthly_rate';

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function moveVariable(knex, { toOptional }) {
  const hasTable = await knex.schema.hasTable('email_templates');
  if (!hasTable) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template) return;
  const required = asArray(template.required_variables).filter((key) => key !== VARIABLE);
  const optional = asArray(template.optional_variables).filter((key) => key !== VARIABLE);
  if (toOptional) optional.push(VARIABLE);
  else required.push(VARIABLE);
  await knex('email_templates').where({ id: template.id }).update({
    required_variables: JSON.stringify(required),
    optional_variables: JSON.stringify(optional),
    updated_at: new Date(),
  });
}

exports.up = async function up(knex) {
  await moveVariable(knex, { toOptional: true });
};

exports.down = async function down(knex) {
  await moveVariable(knex, { toOptional: false });
};
