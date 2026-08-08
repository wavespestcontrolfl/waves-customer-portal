/**
 * Remove the {reservice_line} clause from the automatic post-service texts
 * (owner directive 2026-08-08, reversing the 2026-08-08 streamline ruling that
 * added it in 20260808030000).
 *
 * The live copy read:
 *
 *   If a covered issue comes back, book a free re-service: {short_url}
 *
 * appended to the completion / report / review bodies. Adam does not want the
 * automatic texts carrying it. This strips the token from those bodies (and
 * from the `variables` list the admin template editor renders) so the clause
 * cannot come back with a gate flip.
 *
 * Safe in BOTH deploy orders, unlike the append it reverses. The code half of
 * this change makes reserviceLineForCustomer return '' unconditionally, so:
 *   - migration first / old code: the token is gone, the supplied value is
 *     ignored — nothing to render;
 *   - new code first / migration pending: the token is still there and
 *     resolves to '' — byte-identical to a stripped body after the renderer's
 *     \n{3,} collapse and trim.
 * Neither ordering can leave an UNRESOLVED placeholder, which would suppress
 * the entire send (#3121).
 *
 * Placement-aware inverse of 20260808030000's append, re-stated here rather
 * than imported (migrations are immutable snapshots): the END form owns the
 * '\n\n' it added and gives it back, while the mid-body form sits after a
 * paragraph break the ORIGINAL body owns, which must survive. Owner-customized
 * bodies are otherwise untouched — only the token is removed.
 *
 * Idempotent both ways: up skips rows without the token, down re-appends only
 * where it is absent. Variant bodies outrank the base at render (getTemplate
 * prefers variant.body), so they get the same treatment independently.
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

function stripPlaceholder(body) {
  const endForm = `\n\n${PLACEHOLDER}`;
  const out = body.endsWith(endForm) ? body.slice(0, -endForm.length) : body;
  return out.split(PLACEHOLDER).join('');
}

// Mirrors 20260808030000's append, so down() restores the exact prior bodies.
function appendPlaceholder(body) {
  const paragraphAnchor = '\n\nReply STOP to opt out';
  const idx = body.lastIndexOf(paragraphAnchor);
  if (idx >= 0) {
    const insertAt = idx + 2; // right after the existing '\n\n'
    return `${body.slice(0, insertAt)}${PLACEHOLDER}${body.slice(insertAt)}`;
  }
  return `${body}\n\n${PLACEHOLDER}`;
}

async function rewrite(knex, { transform, skipWhen, vars: rewriteVars }) {
  if (await knex.schema.hasTable('sms_templates')) {
    for (const key of KEYS) {
      const row = await knex('sms_templates').where({ template_key: key }).first();
      if (!row || typeof row.body !== 'string' || skipWhen(row.body)) continue;
      const update = { body: transform(row.body), updated_at: knex.fn.now() };
      try {
        const parsed = typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables;
        if (Array.isArray(parsed)) {
          const next = rewriteVars(parsed);
          if (next) update.variables = JSON.stringify(next);
        }
      } catch { /* leave variables untouched on unparseable shapes */ }
      await knex('sms_templates').where({ id: row.id }).update(update);
    }
  }
  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants').whereIn('template_key', KEYS);
    for (const v of variants) {
      if (typeof v.body !== 'string' || skipWhen(v.body)) continue;
      await knex('sms_template_variants').where({ id: v.id })
        .update({ body: transform(v.body), updated_at: knex.fn.now() });
    }
  }
}

exports.up = async function up(knex) {
  await rewrite(knex, {
    transform: stripPlaceholder,
    skipWhen: (body) => !body.includes(PLACEHOLDER),
    vars: (parsed) => (parsed.includes(VAR_NAME) ? parsed.filter((v) => v !== VAR_NAME) : null),
  });
};

exports.down = async function down(knex) {
  await rewrite(knex, {
    transform: appendPlaceholder,
    skipWhen: (body) => body.includes(PLACEHOLDER),
    vars: (parsed) => (parsed.includes(VAR_NAME) ? null : [...parsed, VAR_NAME]),
  });
};

// Exported for tests.
exports.KEYS = KEYS;
exports.PLACEHOLDER = PLACEHOLDER;
exports.VAR_NAME = VAR_NAME;
exports.stripPlaceholder = stripPlaceholder;
exports.appendPlaceholder = appendPlaceholder;
