'use strict';

// Owner pick 2026-11-25 ("standard"): the prep.bed_bug_heat customer email signs off like every other prep guide.
// 20261102190000 seeded it with the retired v3 sign-off (office, the owner's mobile and a toll-free line).
// 20260924000002 had already replaced that sign-off on every other guide with the owner-approved
// "— The Waves Team" (the 20260721100020 ruling; the email footer carries the office lines).
//
// Rule: publish a NEW active version only when the active version carries the exact seeded sign-off, in a
// signature block or inside a nonempty text_body (the renderer sends text_body instead of text built from the
// blocks). Only that exact text changes; every other block and character (an office edit) is copied unchanged.
// Any other sign-off is an office choice and is left alone. A second run finds nothing and does nothing.
// It is a system publication: last_published_by is cleared, as publishVersion does with no staff id.
//
// down(): documented no-op (owner rule 2026-08-09): version rows are history; roll back by publishing the
// earlier version from the email template library.

const TEMPLATE_KEY = 'prep.bed_bug_heat';
const OLD_SIGNATURE = '— The Waves Pest Control Team\nOffice (941) 318-7612 · Mobile (941) 599-3489 · Toll-free (855) 926-0203\ncontact@wavespestcontrol.com · wavespestcontrol.com';
const NEW_SIGNATURE = '— The Waves Team';
const MIGRATION_MARKER = 'migration:20261125230002';

const parse = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

/** The blocks with the seeded signature swapped, or null when there is nothing to change. */
function convertBlocks(blocks) {
  if (!Array.isArray(blocks)) return null;
  let changed = false;
  const next = blocks.map((b) => {
    if (b && b.type === 'signature' && b.content === OLD_SIGNATURE) {
      changed = true;
      return { ...b, content: NEW_SIGNATURE };
    }
    return b;
  });
  return changed ? next : null;
}

/** text_body with the seeded sign-off swapped, or null when there is nothing to change. */
function convertTextBody(text) {
  if (typeof text !== 'string' || !text.includes(OLD_SIGNATURE)) return null;
  return text.split(OLD_SIGNATURE).join(NEW_SIGNATURE);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
  if (!template || !template.active_version_id) return;
  const active = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!active) return;
  const blocks = convertBlocks(parse(active.blocks));
  const textBody = convertTextBody(active.text_body);
  if (!blocks && textBody === null) return;

  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const snapshot = parse(active.validation_snapshot);
  const now = new Date();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (Number(latest?.version_number) || 0) + 1,
    status: 'active',
    subject: active.subject,
    preview_text: active.preview_text,
    blocks: blocks ? JSON.stringify(blocks) : (typeof active.blocks === 'string' ? active.blocks : JSON.stringify(active.blocks ?? [])),
    text_body: textBody ?? active.text_body ?? null,
    validation_snapshot: JSON.stringify({ ...(snapshot && typeof snapshot === 'object' ? snapshot : {}), source: MIGRATION_MARKER }),
    published_at: now,
  }).returning('*');
  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: now });
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: now,
    last_published_by: null,
    updated_at: now,
  });
};

exports.down = async function down() {
  // Documented no-op: see the header.
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.OLD_SIGNATURE = OLD_SIGNATURE;
exports.NEW_SIGNATURE = NEW_SIGNATURE;
exports.convertBlocks = convertBlocks;
exports.convertTextBody = convertTextBody;
