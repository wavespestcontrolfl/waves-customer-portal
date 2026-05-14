/**
 * Patch existing automation_steps rows to include CAN-SPAM § 7704(a)(5)
 * compliant footers: a valid physical postal address and a visible
 * unsubscribe link in the email body.
 *
 * The original seed migrations (20260424000007_seed_automation_default_steps,
 * 20260424000009_seed_estimate_sent_automation) shipped a footer with only
 * a sign-off line. The List-Unsubscribe header alone is not sufficient
 * under CAN-SPAM — a visible opt-out mechanism must appear in the message
 * body. This migration patches existing rows; the seed files have been
 * updated in lockstep so fresh installs get the compliant footer.
 *
 * Idempotent via the NOT LIKE '%13649 Luxe Ave%' guard — re-running this
 * migration on already-patched rows is a no-op. Operator-edited rows
 * that have replaced the original footer entirely will be skipped (no
 * pattern match) and must be re-audited in the admin UI.
 */

const SHARED_FOOTER_TRAILING_LINE = '<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>';

const SHARED_FOOTER_HTML_APPEND = `
<hr style="border:none;border-top:1px solid #E4E4E7;margin:24px 0 16px;">
<p style="color:#71717A;font-size:11px;line-height:1.5;margin:0;">
Waves Pest Control, LLC<br>
13649 Luxe Ave #110, Bradenton, FL 34211<br>
You're receiving this because you're a Waves customer or signed up for updates. <a href="{{unsubscribe_url}}" style="color:#71717A;text-decoration:underline;">Unsubscribe</a>.
</p>`;

const ESTIMATE_FOOTER_TRAILING_LINE = '<p>— The Waves Pest Control team</p>';

const TEXT_SIGNOFF = '— The Waves Pest Control team';
const TEXT_LEGAL_FOOTER = '\n\n--\nWaves Pest Control, LLC · 13649 Luxe Ave #110, Bradenton, FL 34211\nUnsubscribe: {{unsubscribe_url}}';

exports.up = async function (knex) {
  // 1. Templates seeded via 20260424000007 — share BRAND_FOOTER ending in the
  //    "Reply to this email anytime" line. Append the legal block after it.
  await knex.raw(
    `UPDATE automation_steps
     SET html_body = REPLACE(html_body, ?, ? || ?)
     WHERE html_body LIKE ?
       AND html_body NOT LIKE '%13649 Luxe Ave%'`,
    [
      SHARED_FOOTER_TRAILING_LINE,
      SHARED_FOOTER_TRAILING_LINE,
      SHARED_FOOTER_HTML_APPEND,
      `%${SHARED_FOOTER_TRAILING_LINE}%`,
    ]
  );

  // 2. estimate_sent template (20260424000009) — uses a shorter footer with
  //    just the sign-off line. Scoped by template_key to avoid double-applying
  //    to any other rows that happen to end in the same line.
  await knex.raw(
    `UPDATE automation_steps
     SET html_body = REPLACE(html_body, ?, ? || ?)
     WHERE template_key = 'estimate_sent'
       AND html_body LIKE ?
       AND html_body NOT LIKE '%13649 Luxe Ave%'`,
    [
      ESTIMATE_FOOTER_TRAILING_LINE,
      ESTIMATE_FOOTER_TRAILING_LINE,
      SHARED_FOOTER_HTML_APPEND,
      `%${ESTIMATE_FOOTER_TRAILING_LINE}%`,
    ]
  );

  // 3. All text_body rows — append the legal footer if the canonical sign-off
  //    line is present and the legal block isn't already there.
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
  // Reverse: strip the appended legal blocks. We match by the unique
  // address string so we don't accidentally remove anything else.

  // 1 + 2. Strip the HTML legal block (same string for both shared and estimate).
  await knex.raw(
    `UPDATE automation_steps
     SET html_body = REPLACE(html_body, ?, '')
     WHERE html_body LIKE '%13649 Luxe Ave%'`,
    [SHARED_FOOTER_HTML_APPEND]
  );

  // 3. Strip the appended text legal block.
  await knex.raw(
    `UPDATE automation_steps
     SET text_body = REPLACE(text_body, ?, '')
     WHERE text_body LIKE '%13649 Luxe Ave%'`,
    [TEXT_LEGAL_FOOTER]
  );
};
