/**
 * Completion-SMS past-due balance line — CONTRACT half of the
 * {past_due_line} expand/contract rollout (owner directive 2026-08-15;
 * EXPAND half = PR #3421).
 *
 * ⛔ MERGE ONLY AFTER #3421 IS DEPLOYED. Railway runs migrations before the
 * new instance takes traffic, and an unresolved placeholder does not render
 * blank — it suppresses the ENTIRE send (getTemplate's
 * unresolved-placeholder guard, #3121). #3421 supplies `past_due_line` at
 * every render site of these keys (admin-dispatch completion families incl.
 * both service_complete_with_invoice paths, service-report delivery vars,
 * twilio summary), so once it is live this append is safe in both deploy
 * orders.
 *
 * Data-only: inserts the {past_due_line} placeholder into the two
 * WITH-INVOICE completion template bodies (before the trailing
 * "Questions or requests?" paragraph so the clause reads inside the
 * message, else appended at the end, on its own paragraph). The clause
 * itself is code-built (open-balance.pastDueSmsLineForCustomer): '' unless
 * GATE_COMPLETION_SMS_BALANCE is on AND the customer has an older open
 * self-pay balance beyond the visit's own invoice — so existing sends
 * render byte-identical until Adam approves the copy and flips the gate,
 * and customers with no past-due balance never see the line at all.
 *
 * Key set = the with-invoice pair ONLY: the line reads "separate from
 * today's invoice", which presumes the text carries a bill — the paid /
 * prepaid / report-only completion families are deliberately not tokened
 * (their render sites already supply the variable, so extending later is a
 * data-only change if Adam widens the ruling).
 *
 * Idempotent both ways: up skips rows already carrying the placeholder;
 * down strips it. Owner-customized bodies are preserved — this only inserts
 * or removes the token. The `variables` JSON list is updated for the admin
 * template editor. sms_template_variants rows get the same treatment
 * independently of the base row (variant.body outranks the base at render).
 */

const KEYS = [
  'service_complete_with_invoice',
  'service_report_v1_with_invoice',
];
const PLACEHOLDER = '{past_due_line}';
const VAR_NAME = 'past_due_line';

// Byte-identical-until-flip contract (same rationale as the
// {reservice_line} migration this mirrors, 20260808030000): every character
// added besides the token itself must vanish exactly when the clause
// renders ''. The renderer only collapses \n{3,} → \n\n and trims the ends,
// so the two safe insertions are (a) a BARE token immediately after an
// existing '\n\n' paragraph break — '' leaves the body unchanged, and the
// clause's own trailing '\n\n' supplies the separator when it renders — and
// (b) '\n\n{token}' at the very END, where '' leaves only trailing
// whitespace the trim removes.
function insertPlaceholder(body) {
  const paragraphAnchor = '\n\nQuestions or requests?';
  const idx = body.lastIndexOf(paragraphAnchor);
  if (idx >= 0) {
    const insertAt = idx + 2; // right after the existing '\n\n'
    return `${body.slice(0, insertAt)}${PLACEHOLDER}${body.slice(insertAt)}`;
  }
  return `${body}\n\n${PLACEHOLDER}`;
}

function stripPlaceholder(body) {
  // The '\n\n' belongs to the migration only in the END-append form — the
  // bare mid-body placement sits after a paragraph break the ORIGINAL body
  // owns, which down must not consume.
  const endForm = `\n\n${PLACEHOLDER}`;
  const out = body.endsWith(endForm) ? body.slice(0, -endForm.length) : body;
  return out.split(PLACEHOLDER).join('');
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    for (const key of KEYS) {
      const row = await knex('sms_templates').where({ template_key: key }).first();
      if (!row || typeof row.body !== 'string' || row.body.includes(PLACEHOLDER)) continue;
      const update = { body: insertPlaceholder(row.body), updated_at: knex.fn.now() };
      try {
        const vars = typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables;
        if (Array.isArray(vars) && !vars.includes(VAR_NAME)) {
          update.variables = JSON.stringify([...vars, VAR_NAME]);
        }
      } catch { /* leave variables untouched on unparseable shapes */ }
      await knex('sms_templates').where({ id: row.id }).update(update);
    }
  }
  // Variant bodies render IN PLACE OF the base body (getTemplate prefers
  // variant.body), so every variant row — active or not — gets the same
  // idempotent insert, independently of the base row's state.
  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants').whereIn('template_key', KEYS);
    for (const v of variants) {
      if (typeof v.body !== 'string' || v.body.includes(PLACEHOLDER)) continue;
      await knex('sms_template_variants').where({ id: v.id })
        .update({ body: insertPlaceholder(v.body), updated_at: knex.fn.now() });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    for (const key of KEYS) {
      const row = await knex('sms_templates').where({ template_key: key }).first();
      if (!row || typeof row.body !== 'string' || !row.body.includes(PLACEHOLDER)) continue;
      const update = { body: stripPlaceholder(row.body), updated_at: knex.fn.now() };
      try {
        const vars = typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables;
        if (Array.isArray(vars) && vars.includes(VAR_NAME)) {
          update.variables = JSON.stringify(vars.filter((v) => v !== VAR_NAME));
        }
      } catch { /* leave variables untouched */ }
      await knex('sms_templates').where({ id: row.id }).update(update);
    }
  }
  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants').whereIn('template_key', KEYS);
    for (const v of variants) {
      if (typeof v.body !== 'string' || !v.body.includes(PLACEHOLDER)) continue;
      await knex('sms_template_variants').where({ id: v.id })
        .update({ body: stripPlaceholder(v.body), updated_at: knex.fn.now() });
    }
  }
};

// Exported for tests.
exports.KEYS = KEYS;
exports.PLACEHOLDER = PLACEHOLDER;
exports.VAR_NAME = VAR_NAME;
exports.insertPlaceholder = insertPlaceholder;
exports.stripPlaceholder = stripPlaceholder;
