'use strict';

/**
 * Customer copy audit (2026-09-26) — email templates.
 *
 * Exact-match text patches over each template's CURRENT active version,
 * published as a new active version (the prep-guide v3 publish pattern).
 * Patching the live version instead of baking whole templates keeps every
 * untouched block exactly as the office last saved it. A template whose
 * patches do not each match exactly once (an administrator edited it after
 * this audit) is skipped whole and logged, never half-patched.
 *
 * What changes, and why:
 *  - Estimate follow-ups promised "same-day service, on time, every time";
 *    the website's own claim is that same-day service is usually available
 *    (call before noon), and arrivals are a two-hour window. "Straight to our
 *    team in Bradenton": the office is in Lakewood Ranch. "Real answers in
 *    minutes" is not a promise anyone can keep overnight.
 *  - accepted_onboarding: "No need to be home for most services" — interior
 *    work needs someone home; now scoped to exterior services.
 *  - invoice.followup_3/7_day ended a sentence with a colon, and the
 *    signature block renders between it and the Pay button. Rephrased.
 *  - invoice.followup_30_day was titled "Final reminder" although the
 *    late-payment job sends 60- and 90-day notices after it.
 *  - Late-payment 60/90 day: "before the account remains on hold" (no hold
 *    exists) and "sent to collections or further recovery action" (broken
 *    sentence). Same policy, plain wording; the office decides on any pause.
 *  - ACH: "3-5 business days" vs the five business days the webhook stamps.
 *  - Micro-deposits: Stripe's default is now one deposit with an SM code,
 *    not two amounts; the copy now covers both.
 *  - Refund timing matches the cancellation-refund email (5-10 days).
 *  - "Autopay"/"Auto Pay" spelled one way; membership paused/canceled and
 *    resolution/cancellation wording made readable; an unsourced "#1 cause"
 *    irrigation claim softened.
 */

const MIGRATION_MARKER = 'migration:20260926120100';

const PATCHES = [
  {
    "key": "estimate.engage_expiring",
    "field": "content",
    "from": "We actually show up — same-day service, on time, every time.",
    "to": "We actually show up — inside the arrival window we give you, and same-day service is often available."
  },
  {
    "key": "estimate.engage_expiring_unseen",
    "field": "content",
    "from": "We actually show up — same-day service, on time, every time.",
    "to": "We actually show up — inside the arrival window we give you, and same-day service is often available."
  },
  {
    "key": "estimate.engage_gone_quiet",
    "field": "content",
    "from": "We actually show up — same-day service, on time, every time.",
    "to": "We actually show up — inside the arrival window we give you, and same-day service is often available."
  },
  {
    "key": "estimate.engage_high_intent",
    "field": "content",
    "from": "We actually show up — same-day service, on time, every time.",
    "to": "We actually show up — inside the arrival window we give you, and same-day service is often available."
  },
  {
    "key": "estimate.engage_return_after_dark",
    "field": "content",
    "from": "We actually show up — same-day service, on time, every time.",
    "to": "We actually show up — inside the arrival window we give you, and same-day service is often available."
  },
  {
    "key": "estimate.engage_return_visit",
    "field": "content",
    "from": "We actually show up — same-day service, on time, every time.",
    "to": "We actually show up — inside the arrival window we give you, and same-day service is often available."
  },
  {
    "key": "estimate.engage_unopened",
    "field": "content",
    "from": "We actually show up — same-day service, on time, every time.",
    "to": "We actually show up — inside the arrival window we give you, and same-day service is often available."
  },
  {
    "key": "estimate.engage_expiring",
    "field": "content",
    "from": "it goes straight to our team in Bradenton.",
    "to": "it goes straight to our local team."
  },
  {
    "key": "estimate.engage_expiring_unseen",
    "field": "content",
    "from": "it goes straight to our team in Bradenton.",
    "to": "it goes straight to our local team."
  },
  {
    "key": "estimate.engage_high_intent",
    "field": "content",
    "from": "it goes straight to our team in Bradenton.",
    "to": "it goes straight to our local team."
  },
  {
    "key": "estimate.engage_return_after_dark",
    "field": "content",
    "from": "it goes straight to our team in Bradenton.",
    "to": "it goes straight to our local team."
  },
  {
    "key": "estimate.engage_unopened",
    "field": "content",
    "from": "it goes straight to our team in Bradenton.",
    "to": "it goes straight to our local team."
  },
  {
    "key": "estimate.engage_gone_quiet",
    "field": "preview",
    "from": "Reply and ask — real answers in minutes.",
    "to": "Reply and ask — a real person answers."
  },
  {
    "key": "estimate.engage_return_visit",
    "field": "preview",
    "from": "Reply to this email and a real person answers in minutes.",
    "to": "Reply to this email and a real person answers."
  },
  {
    "key": "estimate.accepted_onboarding",
    "field": "content",
    "from": "No need to be home for most services.",
    "to": "For most exterior services, you don’t need to be home."
  },
  {
    "key": "invoice.followup_3_day",
    "field": "content",
    "from": "You can securely pay your invoice here:",
    "to": "Use the Pay invoice button below to pay securely online."
  },
  {
    "key": "invoice.followup_7_day",
    "field": "content",
    "from": "Please use the secure link below to make payment:",
    "to": "Use the Pay invoice button below to pay securely online."
  },
  {
    "key": "invoice.followup_7_day",
    "field": "content",
    "from": "Already paid? Thank you - no further action is needed.",
    "to": "Already paid? Thank you — no further action is needed."
  },
  {
    "key": "invoice.followup_14_day",
    "field": "content",
    "from": "receipt matching",
    "to": "a payment you already made"
  },
  {
    "key": "billing_late_payment_14_day",
    "field": "content",
    "from": "receipt matching",
    "to": "a payment you already made"
  },
  {
    "key": "invoice.followup_30_day",
    "field": "subject",
    "from": "Final reminder: Waves invoice still open",
    "to": "Reminder: your Waves invoice is still unpaid"
  },
  {
    "key": "invoice.followup_30_day",
    "field": "preview",
    "from": "Final reminder for an open Waves invoice.",
    "to": "Your Waves invoice still has an open balance."
  },
  {
    "key": "invoice.followup_30_day",
    "field": "content",
    "from": "Final reminder: your Waves invoice for",
    "to": "Your Waves invoice for"
  },
  {
    "key": "billing_late_payment_60_day",
    "field": "content",
    "from": "Please pay today or reply to discuss payment options before the account remains on hold.",
    "to": "Please pay today, or reply so we can work out a payment plan."
  },
  {
    "key": "billing_late_payment_60_day",
    "field": "content",
    "from": "Your account may remain on service hold until the past-due balance is resolved.",
    "to": "Future service may be paused until the past-due balance is resolved."
  },
  {
    "key": "billing_late_payment_90_day",
    "field": "content",
    "from": "If payment is not received and we do not hear from you, this account may be sent to collections or further recovery action.",
    "to": "If we don’t receive payment or hear from you, this balance may be sent to collections."
  },
  {
    "key": "payment.ach_processing",
    "field": "preview",
    "from": "it typically clears in 3-5 business days.",
    "to": "it usually clears within 5 business days."
  },
  {
    "key": "payment.ach_processing",
    "field": "content",
    "from": "ACH bank transfers typically take 3-5 business days to clear.",
    "to": "Bank transfers usually clear within 5 business days."
  },
  {
    "key": "payment.microdeposit_verification",
    "field": "preview",
    "from": "Verify the two small deposits in your bank account.",
    "to": "Verify the small test deposit in your bank account."
  },
  {
    "key": "payment.microdeposit_verification",
    "field": "content",
    "from": "Our payment processor, Stripe, sent two small deposits to your account. In 1–2 business days, look for them on your bank statement, then enter the two amounts using the verification link in the email Stripe sent you.",
    "to": "Our payment processor, Stripe, is sending a small test deposit to your bank account. In 1–2 business days, look for it on your statement, then open the verification link in the email Stripe sent you and enter what it asks for: a short code starting with SM, or the deposit amounts."
  },
  {
    "key": "payment.refund_issued",
    "field": "content",
    "from": "Most banks and card providers take a few business days to post refunds after they are issued.",
    "to": "Refunds usually take 5–10 business days to appear on your statement, depending on your bank."
  },
  {
    "key": "payment.autopay_enabled",
    "field": "subject",
    "from": "Autopay is now active for your Waves account",
    "to": "Auto Pay is now on for your Waves account"
  },
  {
    "key": "payment.autopay_enabled",
    "field": "preview",
    "from": "Autopay is active for future eligible Waves invoices.",
    "to": "Auto Pay is on for future eligible Waves invoices."
  },
  {
    "key": "payment.autopay_enabled",
    "field": "content",
    "from": "autopay is now active for your Waves account.",
    "to": "Auto Pay is now on for your Waves account."
  },
  {
    "key": "payment.autopay_enabled",
    "field": "content",
    "from": "If you did not authorize autopay,",
    "to": "If you did not turn on Auto Pay,"
  },
  {
    "key": "membership.paused",
    "field": "preview",
    "from": "Your Waves service has been paused or placed on hold.",
    "to": "Your Waves service is paused."
  },
  {
    "key": "membership.paused",
    "field": "content",
    "from": "your Waves service has been paused or placed on hold.",
    "to": "your Waves service is paused."
  },
  {
    "key": "membership.paused",
    "field": "content",
    "from": "Future service may remain on hold until the pause is removed or the account issue is resolved.",
    "to": "Service stays on hold until the pause ends or the account issue is resolved."
  },
  {
    "key": "membership.canceled",
    "field": "content",
    "from": "Any remaining open invoices, scheduled follow-up items, or completed-service charges still need to be resolved separately.",
    "to": "Charges for completed visits and any open invoices still need to be paid."
  },
  {
    "key": "account.resolution_accepted",
    "field": "content",
    "from": "This creates no term and no fee — you can still cancel any time from your portal.",
    "to": "This doesn’t lock you into a term or add a fee — you can still cancel any time from your portal."
  },
  {
    "key": "account.cancellation_received",
    "field": "content",
    "from": "We received your cancellation request and sent it to the Waves team. Our team will follow up to confirm the details with you.",
    "to": "We received your cancellation request. Someone from our team will follow up to confirm the details with you."
  },
  {
    "key": "irrigation.weekly_cut_back",
    "field": "content",
    "from": "Too much water is the #1 thing we see feeding fungus, mushrooms, and weeds in SWFL lawns — easing back actually makes your lawn healthier.",
    "to": "Overwatering is one of the most common causes of fungus, mushrooms, and weeds we see in SWFL lawns — easing back actually makes your lawn healthier."
  }
];

const json = (v) => JSON.stringify(v);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

function countIn(text, from) {
  return typeof text === 'string' ? text.split(from).length - 1 : 0;
}

/**
 * Apply every patch for one template to a { subject, preview_text, blocks }
 * version. Returns { version, misses } — misses lists patches that did not
 * match exactly once; the caller must not publish when misses is non-empty.
 */
function applyPatches(version, patches) {
  let subject = version.subject;
  let preview = version.preview_text;
  let blocks = parse(version.blocks).map((b) => ({ ...b }));
  const misses = [];
  for (const p of patches) {
    if (p.field === 'subject' || p.field === 'preview') {
      const cur = p.field === 'subject' ? subject : preview;
      if (countIn(cur, p.from) !== 1) { misses.push(p); continue; }
      const next = cur.replace(p.from, p.to);
      if (p.field === 'subject') subject = next; else preview = next;
      continue;
    }
    let hits = 0;
    for (const b of blocks) {
      hits += countIn(b.content, p.from);
      for (const item of b.items || []) hits += countIn(item, p.from);
      for (const row of b.rows || []) hits += countIn(row.value, p.from);
    }
    if (hits !== 1) { misses.push(p); continue; }
    const swap = (s) => (typeof s === 'string' ? s.replace(p.from, p.to) : s);
    blocks = blocks.map((b) => ({
      ...b,
      ...(typeof b.content === 'string' ? { content: swap(b.content) } : {}),
      ...(Array.isArray(b.items) ? { items: b.items.map(swap) } : {}),
      ...(Array.isArray(b.rows) ? { rows: b.rows.map((row) => ({ ...row, value: swap(row.value) })) } : {}),
    }));
  }
  return { version: { subject, preview_text: preview, blocks }, misses };
}

const KEYS = [...new Set(PATCHES.map((p) => p.key))];

async function publishPatched(knex, key) {
  const template = await knex('email_templates').where({ template_key: key }).first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';
  // An administrator-authored plain-text body would be replaced by the
  // renderer's generated text (text_body: null below). None of the audited
  // templates carried one on 2026-09-26; if one does now, leave it whole.
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MIGRATION_MARKER}] ${key}: custom plain-text body present; template left as-is`);
    return 'skipped';
  }
  const { version, misses } = applyPatches(prior, PATCHES.filter((p) => p.key === key));
  if (misses.length) {
    console.warn(`[${MIGRATION_MARKER}] ${key}: ${misses.length} patch(es) no longer match; template left as-is`);
    return 'skipped';
  }
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const now = new Date();
  // Savepoint: the admin editor allocates draft version numbers the same way
  // (max + 1, no lock), so a draft created mid-deploy can take this number.
  // A unique-violation then skips this template instead of aborting the whole
  // migration transaction.
  let created;
  try {
    created = await knex.transaction(async (sp) => {
      const [row] = await sp('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: version.subject,
        preview_text: version.preview_text,
        blocks: json(version.blocks),
        text_body: null,
        validation_snapshot: json({
          ok: true,
          source: MIGRATION_MARKER,
          supersedes_version: prior.version_number,
          referenced_variables: [],
          disallowed_variables: [],
          missing_required_in_template: [],
        }),
        published_at: now,
      }).returning('*');
      return row;
    });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    console.warn(`[${MIGRATION_MARKER}] ${key}: version number taken by a concurrent draft; template left as-is`);
    return 'raced';
  }
  // CAS on the version we patched, BEFORE touching any other version's
  // status: a concurrent admin publish wins and its version stays active.
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  // Won: retire only the version this one replaces.
  await knex('email_template_versions')
    .where({ id: prior.id, status: 'active' })
    .update({ status: 'archived', updated_at: now });
  return 'published';
}

exports.PATCHES = PATCHES;
exports.KEYS = KEYS;
exports.MIGRATION_MARKER = MIGRATION_MARKER;
exports.applyPatches = applyPatches;
exports._publishPatched = publishPatched;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const key of KEYS) await publishPatched(knex, key);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const now = new Date();
  for (const key of KEYS) {
    const template = await knex('email_templates').where({ template_key: key }).first();
    if (!template?.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
    const snap = current && parse(current.validation_snapshot);
    if (snap?.source !== MIGRATION_MARKER) continue; // an admin published since; leave it
    const prior = await knex('email_template_versions')
      .where({ template_id: template.id, version_number: snap.supersedes_version })
      .first();
    if (!prior) continue;
    // Pointer CAS first, as in up(): an administrator publish that lands
    // after the marker check wins, and no version statuses change.
    const moved = await knex('email_templates')
      .where({ id: template.id, active_version_id: current.id })
      .update({ active_version_id: prior.id, updated_at: now });
    if (!moved) continue;
    await knex('email_template_versions').where({ id: prior.id }).update({ status: 'active', updated_at: now });
    await knex('email_template_versions').where({ id: current.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  }
};
