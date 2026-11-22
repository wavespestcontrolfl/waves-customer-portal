'use strict';

/**
 * THE "NO VISIT NEEDED" LINE IN THE ESTIMATE EMAIL (owner 2026-11-21, his exact words). Data only, no schema.
 *
 * In the four weeks to Nov 15, 9 of 16 calls about how the estimate works asked whether someone comes out to quote.
 * The estimate email (estimate.delivery) now says how Waves prices a home, in one paragraph directly under the
 * price rows:
 *
 *   "We measure your home and yard from county records and satellite images, so most quotes need no visit."
 *
 * The same sentence is the office's call script line (server/services/csr/weekly-call-outcomes.js).
 *
 * Only estimate.delivery, the mail that first carries a home estimate. Never touched: estimate.updated_delivery and
 * the follow-up mails (the customer already has the estimate) and estimate.proposal_delivery (the commercial
 * proposal: the sentence speaks of a home and yard).
 *
 * Publish pattern of 20261019200000 (estimate PDF note): read-modify-write of the live template, so admin edits are
 * kept. The template row is locked first, ONE new active version is published by compare-and-swap on the active
 * version, and only the version it replaces is archived. Older versions are never edited: a reviewed send pins a
 * version's content (email-template-reviewed-content.test.js), and an in-place edit would make that send refuse.
 * A template that already carries the sentence in any block (a paragraph, a note, a list item, a details row), has
 * no active version, or has a custom plain-text body (the renderer's generated text would not carry the line) is left
 * whole and logged, never half-patched. "Price rows" means the details block that shows {{price_summary}}. No
 * variable is added, so allowed/optional/required variables and the preview fixtures stay as they are.
 *
 * `down` is a documented no-op: a blanket revert would erase admin edits made after this published. To take the
 * line out, republish the prior version from the admin template library.
 */

const MIGRATION = '20261122030000';
const MARKER = `migration:${MIGRATION}`;
const TEMPLATE_KEY = 'estimate.delivery';
const LINE = 'We measure your home and yard from county records and satellite images, so most quotes need no visit.';

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

// The sentence anywhere the email shows text: a paragraph, a note, a list item, a details row. The sentence holds no
// character that JSON escapes, so one search of the serialized blocks covers every field.
const carriesLine = (blocks) => JSON.stringify(blocks).includes(LINE);

// Directly under the price rows: the details block that shows {{price_summary}}, never just the first details block
// (an admin can put property rows or a question list above the price). A template rebuilt without price rows gets
// the line above its first button, and one with no button gets it at the end.
const PRICE_VARIABLE = /\{\{\s*price_summary\s*\}\}/;
const showsPrice = (block) => block?.type === 'details' && PRICE_VARIABLE.test(JSON.stringify(block));

function insertLine(blocksIn) {
  const blocks = blocksIn.map((b) => ({ ...b }));
  const priceRows = blocks.findIndex(showsPrice);
  const button = blocks.findIndex((b) => b?.type === 'cta');
  let at = blocks.length;
  if (priceRows >= 0) at = priceRows + 1;
  else if (button >= 0) at = button;
  blocks.splice(at, 0, { type: 'paragraph', content: LINE });
  return blocks;
}

async function publish(knex) {
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';

  const blocks = json(prior.blocks, null);
  if (!Array.isArray(blocks)) {
    console.warn(`[${MARKER}] ${TEMPLATE_KEY}: active blocks unreadable; template left as-is`);
    return 'skipped';
  }
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MARKER}] ${TEMPLATE_KEY}: custom plain-text body present; template left as-is`);
    return 'skipped';
  }
  if (carriesLine(blocks)) return 'already';

  const nextBlocks = insertLine(blocks);
  const now = new Date();

  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor(template, { ...prior, blocks: nextBlocks });
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${TEMPLATE_KEY}: new version failed variable validation; template left as-is`);
    return 'skipped';
  }
  const latest = await knex('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
  let created;
  try {
    // Savepoint: the admin editor allocates draft numbers the same way (max + 1, no lock), so a concurrent draft
    // can take this number.
    created = await knex.transaction(async (sp) => {
      const [row] = await sp('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: prior.subject,
        preview_text: prior.preview_text,
        blocks: JSON.stringify(nextBlocks),
        text_body: null,
        validation_snapshot: JSON.stringify({ ...validation, source: MARKER, supersedes_version: prior.version_number }),
        published_at: now,
      }).returning('*');
      return row;
    });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    console.warn(`[${MARKER}] ${TEMPLATE_KEY}: version number taken by a concurrent draft; template left as-is`);
    return 'raced';
  }
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  await knex('email_template_versions').where({ id: prior.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  return { outcome: 'published', template_id: template.id, from_version: prior.version_number, to_version: created.version_number };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    // 'published' comes back with the template id and the two version numbers; every other outcome is a bare word.
    const published = await publish(trx);
    const result = published.outcome || published;
    console.log(`[${MARKER}] ${TEMPLATE_KEY}: ${result}`);
    if (await trx.schema.hasTable('audit_log')) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system',
        action: `${MARKER}:publish`,
        resource_type: 'email_template',
        resource_id: published.template_id || null,
        metadata: {
          results: { [TEMPLATE_KEY]: result },
          // Before and after: the version the email sent from, and the one it sends from now.
          from_version: published.from_version ?? null,
          to_version: published.to_version ?? null,
          added_paragraph: result === 'published' ? LINE : null,
        },
        critical: true,
        trx,
      });
    }
  });
};

exports.down = async function down() {
  // Data-only publish: a blanket revert would erase admin edits made after it.
  // Staff can republish the prior version from the template library.
};

exports._private = { TEMPLATE_KEY, LINE, insertLine, carriesLine };
