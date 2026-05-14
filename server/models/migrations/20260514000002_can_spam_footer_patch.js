/**
 * Patch existing automation_steps rows to include a CAN-SPAM § 7704(a)(5)
 * compliant text-mode footer (physical postal address + visible
 * unsubscribe link).
 *
 * HTML bodies are wrapped at send time by `wrapNewsletter()` in
 * server/services/email-template.js — its chrome footer carries the
 * full street address and an `<%asm_group_unsubscribe_raw_url%>`-driven
 * unsubscribe line, so HTML doesn't need a body-level patch. Plain-text
 * bodies are sent raw and need an inline footer, which is what this
 * migration appends.
 *
 * The unsubscribe placeholder uses SendGrid's ASM substitution token
 * (`<%asm_group_unsubscribe_raw_url%>`) so it resolves correctly via
 * both the automation send path (`sendgrid.sendOne` — attaches asm) and
 * the newsletter path (`sendgrid.sendBatch` / `sendBroadcast` — also
 * attaches asm). The Mailchimp-style `{{unsubscribe_url}}` token would
 * only work in `sendBatch` and would render as literal text on automation
 * sends.
 *
 * Idempotent via NOT LIKE '%13649 Luxe Ave%' — re-running is a no-op.
 * Operator-edited rows that have replaced the sign-off line entirely
 * will be skipped (pattern won't match) and must be re-audited manually.
 */

const TEXT_SIGNOFF = '— The Waves Pest Control team';
const TEXT_LEGAL_FOOTER = '\n\n--\nWaves Pest Control, LLC · 13649 Luxe Ave #110, Bradenton, FL 34211\nUnsubscribe: <%asm_group_unsubscribe_raw_url%>';

exports.up = async function (knex) {
  await knex.raw(
    `UPDATE automation_steps
     SET text_body = text_body || ?
     WHERE text_body LIKE ?
       AND text_body NOT LIKE '%13649 Luxe Ave%'`,
    [
      TEXT_LEGAL_FOOTER,
      `%${TEXT_SIGNOFF}%`,
    ]
  );
};

exports.down = async function (knex) {
  await knex.raw(
    `UPDATE automation_steps
     SET text_body = REPLACE(text_body, ?, '')
     WHERE text_body LIKE '%13649 Luxe Ave%'`,
    [TEXT_LEGAL_FOOTER]
  );
};
