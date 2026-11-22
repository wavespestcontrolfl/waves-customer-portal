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
 * The paragraph is the payload variable {{estimate_no_visit_line}}, not fixed text. estimate.delivery also carries a
 * commercial estimate that has no proposal, and the sentence speaks of a home and yard, so the sender fills the
 * variable for a home estimate only (server/services/estimate-no-visit-line.js, the one home of the sentence; the
 * office's call script line reads it from there too). renderBlocks drops a paragraph whose content renders blank,
 * so every other estimate's email renders byte-identical to today, and so does every email the old code sends while
 * a deploy is in progress.
 *
 * Only estimate.delivery, the mail that first carries an estimate. Never touched: estimate.updated_delivery and the
 * follow-up mails (the customer already has the estimate) and estimate.proposal_delivery (the commercial proposal).
 *
 * Publish pattern of 20261019200000 (estimate PDF note): read-modify-write of the live template, so admin edits are
 * kept. The template row is locked first (the lock the admin editor takes before it numbers a draft), ONE new active
 * version is published, and only the version it replaces is archived. Older versions are never edited: a reviewed
 * send pins a version's content (email-template-reviewed-content.test.js), and an in-place edit would make that
 * send refuse. The variable joins the template's allowed and optional variables together with the publish, and the
 * preview fixtures get the sentence as their sample (a value an admin already set is kept).
 *
 * A template that already has the variable, or the sentence itself, in any block (a paragraph, a note, a list item,
 * a details row), has no active version, or has a custom plain-text body (the renderer's generated text would not
 * carry the line) is left whole and logged, never half-patched. "Price rows" means the details block that shows
 * {{price_summary}}.
 *
 * `down` is a documented no-op: a blanket revert would erase admin edits made after this published. To take the
 * line out, republish the prior version from the admin template library.
 */

const MIGRATION = '20261122030000';
const MARKER = `migration:${MIGRATION}`;
const TEMPLATE_KEY = 'estimate.delivery';
const VARIABLE = 'estimate_no_visit_line';
const NOTE = `{{${VARIABLE}}}`;
// The preview sample. A literal copy on purpose: a data migration must not change meaning when the live sentence
// in server/services/estimate-no-visit-line.js is reworded later.
const LINE = 'We measure your home and yard from county records and satellite images, so most quotes need no visit.';

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function unique(list) {
  return [...new Set(list)];
}

// The variable, or the sentence itself, anywhere the email shows text: a paragraph, a note, a list item, a details
// row. Neither holds a character that JSON escapes, so one search of the serialized blocks covers every field.
const LINE_VARIABLE = /\{\{\s*estimate_no_visit_line\s*\}\}/;
const carriesLine = (blocks) => {
  const text = JSON.stringify(blocks);
  return LINE_VARIABLE.test(text) || text.includes(LINE);
};

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
  blocks.splice(at, 0, { type: 'paragraph', content: NOTE });
  return blocks;
}

// The preview and the admin test send read these. A key that is already there, even blank, is an admin's value.
async function seedFixtures(knex, template) {
  if (!(await knex.schema.hasTable('email_template_fixtures'))) return 0;
  let seeded = 0;
  for (const fixture of await knex('email_template_fixtures').where({ template_id: template.id })) {
    const payload = json(fixture.payload, null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload[VARIABLE] !== undefined) continue;
    await knex('email_template_fixtures').where({ id: fixture.id })
      .update({ payload: JSON.stringify({ ...payload, [VARIABLE]: LINE }), updated_at: new Date() });
    seeded += 1;
  }
  return seeded;
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
  const allowed = unique([...json(template.allowed_variables, []), VARIABLE]);
  const optional = unique([...json(template.optional_variables, []), VARIABLE])
    .filter((v) => !json(template.required_variables, []).includes(v));
  const now = new Date();

  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor({ ...template, allowed_variables: allowed }, { ...prior, blocks: nextBlocks });
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${TEMPLATE_KEY}: new version failed variable validation; template left as-is`);
    return 'skipped';
  }
  // The template row lock above is the one the admin editor takes before it numbers a draft (createDraftVersion),
  // so no other writer can take this number or move the active version while this runs. An insert conflict or a
  // missed swap is therefore unexpected: it throws, the transaction rolls back, and the migration stays unrecorded
  // and runs again on the next deploy. An unexpected conflict is never recorded as a finished migration.
  const latest = await knex('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
  const [created] = await knex('email_template_versions').insert({
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
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({
      active_version_id: created.id,
      // Widened only together with the swap, so a template that is left whole keeps its variables.
      allowed_variables: JSON.stringify(allowed),
      optional_variables: JSON.stringify(optional),
      last_published_at: now,
      updated_at: now,
    });
  if (!moved) throw new Error(`[${MARKER}] ${TEMPLATE_KEY}: the active version changed under the template row lock`);
  await knex('email_template_versions').where({ id: prior.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  const fixturesSeeded = await seedFixtures(knex, template);
  return {
    outcome: 'published',
    template_id: template.id,
    from_version: prior.version_number,
    to_version: created.version_number,
    fixtures_seeded: fixturesSeeded,
  };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    // 'published' comes back with the template id and what changed; every other outcome is a bare word.
    const published = await publish(trx);
    const result = published.outcome || published;
    const done = result === 'published';
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
          // Before and after: the version the email sent from and the one it sends from now, and what was added.
          from_version: done ? published.from_version : null,
          to_version: done ? published.to_version : null,
          added_block: done ? { type: 'paragraph', content: NOTE } : null,
          added_variable: done ? VARIABLE : null,
          fixtures_seeded: done ? published.fixtures_seeded : null,
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

exports._private = { TEMPLATE_KEY, VARIABLE, NOTE, LINE, insertLine, carriesLine };
