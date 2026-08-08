/**
 * Re-service request streamline — CONTRACT half of the {reservice_line}
 * expand/contract rollout (owner ruling 2026-08-08; EXPAND half = PR #3288).
 *
 * ⛔ MERGE ONLY AFTER #3288 IS DEPLOYED. Railway runs migrations before the
 * new instance takes traffic, and an unresolved placeholder does not render
 * blank — it suppresses the ENTIRE send (getTemplate's unresolved-placeholder
 * guard, #3121). #3288 supplies `reservice_line` at every render site of
 * these keys (admin-dispatch completion families incl. both
 * service_complete_with_invoice paths, service-report delivery vars,
 * review-request worker, satisfaction promoter, twilio summary), so once it
 * is live this append is safe in both deploy orders.
 *
 * Data-only: appends the {reservice_line} placeholder to the completion /
 * report / review template BODIES (before a trailing "Reply STOP" notice or
 * "— Waves" signature so the clause reads inside the message, else at the
 * end, on its own paragraph). The clause itself is code-built
 * (reservice-link.reserviceLineForCustomer): '' unless
 * GATE_RESERVICE_STREAMLINE + GATE_RESERVICE_SELF_SERVE are both on AND the
 * customer's live plan grants a pest/lawn lane — so existing sends render
 * byte-identical until Adam flips the gate, and ineligible customers never
 * see the line at all.
 *
 * Key set = the owner-ruled delivery list (scope doc §6 ruling 3,
 * 2026-08-08): the service_complete family, the service_report_v1 family —
 * INCLUDING service_report_v1_with_invoice, which the ruling names — and
 * review_request. service_complete_with_invoice is not tokened because it
 * was never in the ruled list (it is the legacy fallback lane the report-v1
 * family replaces, not a family member), NOT because it carries a pay link —
 * service_report_v1_with_invoice carries one too. Its render sites already
 * supply the variable, so adding it later is a data-only change if Adam
 * extends the ruling.
 *
 * Idempotent both ways: up skips rows already carrying the placeholder; down
 * strips it. Owner-customized bodies are preserved — this only appends or
 * removes the token. The `variables` JSON list is updated for the admin
 * template editor. sms_template_variants rows get the same treatment
 * independently of the base row (variant.body outranks the base at render).
 */

const KEYS = [
  'service_complete',
  'service_complete_prepaid',
  'service_complete_annual_prepay',
  'service_complete_paid_receipt',
  'service_report_v1',
  'service_report_v1_with_invoice',
  'review_request',
];
const PLACEHOLDER = '{reservice_line}';
const VAR_NAME = 'reservice_line';

// Byte-identical-until-flip contract: every character this migration adds
// besides the token itself must vanish exactly when the clause renders ''.
// The renderer only collapses \n{3,} → \n\n and trims the ends, so the two
// safe insertions are (a) a BARE token immediately after an existing '\n\n'
// paragraph break — '' leaves the body unchanged, and the clause's own
// trailing '\n\n' supplies the separator when it renders — and (b)
// '\n\n{token}' at the very END, where '' leaves only trailing whitespace
// the trim removes. Single-newline or inline signature anchors are NOT used:
// inserting static newlines before them would survive an empty render as a
// layout change (pre-push audit P1).
function appendPlaceholder(body) {
  const paragraphAnchor = '\n\nReply STOP to opt out';
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
      const update = { body: appendPlaceholder(row.body), updated_at: knex.fn.now() };
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
  // idempotent append, independently of the base row's state.
  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants').whereIn('template_key', KEYS);
    for (const v of variants) {
      if (typeof v.body !== 'string' || v.body.includes(PLACEHOLDER)) continue;
      await knex('sms_template_variants').where({ id: v.id })
        .update({ body: appendPlaceholder(v.body), updated_at: knex.fn.now() });
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
exports.appendPlaceholder = appendPlaceholder;
exports.stripPlaceholder = stripPlaceholder;
