'use strict';

/**
 * Customer copy audit — Codex round-1 corrections (PR #4874).
 *
 * 20260926120100 and 20260926120200 ran on the PR preview database, so they
 * are frozen. This migration supersedes two of their results:
 *
 *  P1  service_renewal (Automations tab): 120200 changed the preview to
 *      "Your service continues as is", settling the old preview/body
 *      contradiction the wrong way. Owner ruling 2026-07-13
 *      (workflows/renewal-reminder.js): renewal language is reserved for
 *      termite bonds, and a bond stays in force only when it is renewed
 *      (renewal_reminder SMS: "Reply RENEW or call us to keep coverage
 *      active"). The email and its companion text now ask the customer to
 *      renew, reusing only the claims termite.bond_renewal already makes.
 *  P2  payment.microdeposit_verification: 120100 said "a small test
 *      deposit". Stripe sends either one deposit with an SM code or two
 *      deposits with amounts, and sendMicrodepositVerificationEmail does not
 *      know which, so the copy now covers both.
 *
 * Same guards as the originals: exact-text CAS leaves an administrator edit
 * whole; the email publishes a new version, moving the live pointer by CAS
 * before archiving anything; a version-number collision skips the template.
 */

const { applyPatches } = require('./20260926120100_customer_copy_audit_email');

const MIGRATION = '20260926120300_customer_copy_audit_codex_r1';
const MIGRATION_MARKER = 'migration:20260926120300';

const RENEWAL = {
  "key": "service_renewal",
  "before": {
    "subject": "Your Waves service is coming up for renewal",
    "preview_text": [
      "Nothing changes automatically — here's what to know.",
      "Your service continues as is — here's what to know."
    ],
    "html_body": "<h2>Hi {{first_name}} — quick renewal note</h2>\n<p>Your current service term with Waves is coming up. There's nothing you need to do today — this is a heads-up, not a bill.</p>\n\n<h2>What happens next</h2>\n<p>We'll continue on the same schedule at your current rate unless you tell us otherwise. If you want to pause, change frequency, add lawn care, or drop a service, just reply to this email or call <a href=\"tel:+19412975749\">(941) 297-5749</a>.</p>\n\n<h2>If you've had a change of address or billing</h2>\n<p>Let us know. We'd rather update it now than have a bounced payment or a missed visit.</p>\n\n<p>Thanks for trusting us with your home.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "text_body": "Hi {{first_name}} — your current service term with Waves is coming up. Nothing you need to do today. We'll continue on the same schedule at your current rate unless you tell us otherwise. To pause, change frequency, add services, or update billing/address, reply to this email or call (941) 297-5749. — The Waves Pest Control team"
  },
  "after": {
    "subject": "Your termite bond is coming up for renewal",
    "preview_text": "Renew on time to keep your termite coverage continuous.",
    "html_body": "<h2>Hi {{first_name}} — your termite bond is up for renewal</h2>\n<p>Your termite bond with Waves is coming up for renewal. Renewing on time keeps your protection continuous — a lapse can mean re-inspection or re-treatment before coverage can restart.</p>\n\n<h2>How to renew</h2>\n<p>Reply to this email or call <a href=\"tel:+19412975749\">(941) 297-5749</a> and we'll take care of it. Questions about what your bond covers? Ask, and we'll walk you through your specific terms.</p>\n\n<h2>If you've had a change of address or billing</h2>\n<p>Let us know. We'd rather update it now than have a bounced payment or a missed visit.</p>\n\n<p>Thanks for trusting us with your home.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "text_body": "Hi {{first_name}} — your termite bond with Waves is coming up for renewal. Renewing on time keeps your protection continuous; a lapse can mean re-inspection or re-treatment before coverage can restart. To renew, reply to this email or call (941) 297-5749. Moved or changed billing? Let us know. — The Waves Pest Control team"
  },
  "sms": {
    "before": [
      "Hi {first_name}! Your Waves service is coming up for renewal. We just emailed you the details — take a look when you get a chance.\n\nQuestions? Just reply here!",
      "Hi {first_name}! Your Waves service is coming up for renewal. We emailed the details; take a look when you get a chance.\n\nQuestions? Reply here."
    ],
    "after": "Hi {first_name}! Your Waves termite bond is coming up for renewal. We emailed the details. To keep coverage active, reply here or call us."
  }
};

const PATCHES = [
  {
    "key": "payment.microdeposit_verification",
    "field": "preview",
    "from": "Verify the small test deposit in your bank account.",
    "to": "Verify your bank account to finish your payment."
  },
  {
    "key": "payment.microdeposit_verification",
    "field": "content",
    "from": "Our payment processor, Stripe, is sending a small test deposit to your bank account. In 1–2 business days, look for it on your statement, then open the verification link in the email Stripe sent you and enter what it asks for: a short code starting with SM, or the deposit amounts. As soon as you confirm them,",
    "to": "Our payment processor, Stripe, is sending one or two small test deposits to your bank account. In 1–2 business days, look for them on your statement, then open the verification link in the email Stripe sent you and enter what it asks for: a short code starting with SM, or the deposit amounts. As soon as you do,"
  }
];

const json = (v) => JSON.stringify(v);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function publishPatched(knex, key) {
  const template = await knex('email_templates').where({ template_key: key }).first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';
  if (prior.text_body != null && String(prior.text_body).trim()) return 'skipped';
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
  let created;
  try {
    // Savepoint: an admin draft taking the same max + 1 number skips this
    // template instead of aborting the migration transaction.
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
    return 'raced';
  }
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  await knex('email_template_versions')
    .where({ id: prior.id, status: 'active' })
    .update({ status: 'archived', updated_at: now });
  return 'published';
}

async function audit(knex, resourceType, id, field) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action: 'automation_copy_updated',
    // audit_log.resource_id is a uuid; automation_templates rows are keyed
    // by their text key, which rides in metadata.
    resource_type: resourceType, resource_id: id == null ? null : String(id),
    metadata: { migration: MIGRATION, template_key: RENEWAL.key, field },
    critical: true, trx: knex,
  });
}

async function rewriteRenewal(knex) {
  if (await knex.schema.hasTable('automation_steps')) {
    const { subject, preview_text: previews, html_body: html, text_body: text } = RENEWAL.before;
    // One row CAS over every field: the email changes whole or not at all.
    const rows = await knex('automation_steps')
      .where({ template_key: RENEWAL.key, subject, html_body: html, text_body: text })
      .whereIn('preview_text', previews)
      .select('id');
    for (const { id } of rows) {
      const changed = await knex('automation_steps')
        .where({ id, subject, html_body: html, text_body: text })
        .whereIn('preview_text', previews)
        .update({ ...RENEWAL.after, updated_at: knex.fn.now() });
      if (changed) await audit(knex, 'automation_steps', id, 'email');
    }
  }
  if (await knex.schema.hasTable('automation_templates')) {
    const changed = await knex('automation_templates')
      .where({ key: RENEWAL.key })
      .whereIn('sms_template', RENEWAL.sms.before)
      .update({ sms_template: RENEWAL.sms.after, updated_at: knex.fn.now() });
    if (changed) await audit(knex, 'automation_templates', null, 'sms_template');
  }
}

exports.RENEWAL = RENEWAL;
exports.PATCHES = PATCHES;
exports.MIGRATION_MARKER = MIGRATION_MARKER;
exports._publishPatched = publishPatched;

exports.up = async function up(knex) {
  await rewriteRenewal(knex);
  if ((await knex.schema.hasTable('email_templates')) && (await knex.schema.hasTable('email_template_versions'))) {
    for (const key of [...new Set(PATCHES.map((p) => p.key))]) await publishPatched(knex, key);
  }
};

exports.down = async function down(knex) {
  // Automation copy: intentionally no-op (reverting would erase later admin
  // edits). Email: CAS back to the version this migration superseded.
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const now = new Date();
  for (const key of [...new Set(PATCHES.map((p) => p.key))]) {
    const template = await knex('email_templates').where({ template_key: key }).first();
    if (!template?.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
    const snap = current && parse(current.validation_snapshot);
    if (snap?.source !== MIGRATION_MARKER) continue;
    const prior = await knex('email_template_versions')
      .where({ template_id: template.id, version_number: snap.supersedes_version })
      .first();
    if (!prior) continue;
    const moved = await knex('email_templates')
      .where({ id: template.id, active_version_id: current.id })
      .update({ active_version_id: prior.id, updated_at: now });
    if (!moved) continue;
    await knex('email_template_versions').where({ id: prior.id }).update({ status: 'active', updated_at: now });
    await knex('email_template_versions').where({ id: current.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  }
};
