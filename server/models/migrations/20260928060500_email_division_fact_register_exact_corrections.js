'use strict';

/**
 * Corrects the three product facts ONLY when the row is byte-for-byte the
 * seeded one, and shields a row a person has edited from the looser
 * correction that follows.
 *
 * Why this file exists, and why it sorts BEFORE
 * 20260928061000_email_division_fact_register_label_corrections.js: that
 * migration (pushed, so frozen — waves-db: supersede, never edit) decides a
 * row is "still the seed" by a marker phrase. A person can correct a title,
 * a citation or part of the text and leave that phrase in place, and the
 * marker test would then overwrite their edit wholesale. Running first,
 * this migration makes that impossible:
 *
 *   - row fingerprint (sha256 of title, content, summary) equals the seeded
 *     fingerprint → rewrite it to the label / manufacturer wording. The
 *     marker phrase is gone afterwards, so 061000 skips the row.
 *   - row differs from the seed but still carries the marker phrase → a
 *     person edited it. Its text is left exactly as they wrote it and its
 *     `source` is re-labelled, so 061000's `where({ slug, source })` no
 *     longer matches and cannot overwrite it. The row stays in category
 *     'facts' and keeps listing.
 *   - anything else (already corrected, or never seeded here) → no-op.
 *
 * Idempotent, and every write is audited in this migration's transaction.
 */
const crypto = require('crypto');
const { CORRECTIONS } = require('./20260928061000_email_division_fact_register_label_corrections')._internals;

const SOURCE = 'email-division-fact-register';
const EDITED_SOURCE = 'email-division-fact-register:edited';
const STAMP = '20260928060500_email_division_fact_register_exact_corrections';
const VERIFIED_ON = '2026-09-28';

// sha256 of [title, content, summary].join('\n') exactly as
// 20260928050000 seeded each row.
const SEEDED_FINGERPRINTS = {
  'fact-taurus-sc-non-repellent': '9aac33a363539a32c2158c1efd2d93771c5558c1c55428ce32733ea4e5200e43',
  'fact-bifenthrin-talstar-p-residual': '9d387b5d36fbf2a7ac72e2411e8ad8384e5490b40e827ec49549f3c6118edc19',
  'fact-gentrol-igr-hydroprene': '7e8f5eb2d297ef32d23f7dfea9a3f6bc8a74fb729d3e551db894f66ad3af8a0d',
};

function fingerprint(row) {
  return crypto.createHash('sha256')
    .update([row.title, row.content, row.summary].map((v) => String(v ?? '')).join('\n'))
    .digest('hex');
}

async function audit(knex, hasAuditLog, action, row, slug) {
  if (!hasAuditLog) return;
  await require('../../services/audit-log').recordAuditEvent({
    actor_type: 'migration',
    actor_id: null,
    action,
    resource_type: 'knowledge_base',
    resource_id: row.id,
    metadata: { slug, migration: STAMP, source: SOURCE },
    trx: knex,
    critical: true,
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const hasAuditLog = await knex.schema.hasTable('audit_log');

  for (const fix of CORRECTIONS) {
    const row = await knex('knowledge_base')
      .where({ slug: fix.slug, source: SOURCE })
      .first('id', 'title', 'content', 'summary', 'version');
    if (!row) continue;

    if (fingerprint(row) === SEEDED_FINGERPRINTS[fix.slug]) {
      await knex('knowledge_base').where({ id: row.id }).update({
        title: fix.title,
        content: fix.content,
        summary: fix.quote,
        metadata: JSON.stringify({
          source_url: fix.sourceUrl,
          source_urls: fix.sourceUrls,
          quote: fix.quote,
          verified_on: VERIFIED_ON,
          corrected_by: STAMP,
          correction: 'seeded text cited a retailer page; replaced with label and manufacturer wording',
        }),
        version: Number(row.version || 1) + 1,
        last_verified_at: new Date(`${VERIFIED_ON}T00:00:00Z`),
        verified_by: SOURCE,
        updated_at: new Date(),
      });
      await audit(knex, hasAuditLog, 'knowledge_base.fact_corrected', row, fix.slug);
      continue;
    }

    // Not the seed. If the marker phrase survives, a person edited around
    // it: keep their text and take the row out of 061000's reach.
    if (String(row.content || '').includes(fix.seededMarker)) {
      await knex('knowledge_base').where({ id: row.id }).update({
        source: EDITED_SOURCE,
        updated_at: new Date(),
      });
      await audit(knex, hasAuditLog, 'knowledge_base.fact_correction_held', row, fix.slug);
    }
  }
};

// Documented no-op, for the same reasons as the migrations around it: the
// seeded text was wrong, and a person may have edited the row since.
exports.down = async function down() {};

module.exports._internals = { SEEDED_FINGERPRINTS, fingerprint, EDITED_SOURCE };
