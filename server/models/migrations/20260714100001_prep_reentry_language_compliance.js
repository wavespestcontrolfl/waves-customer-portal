'use strict';

/**
 * Re-entry language compliance on the prep guides (2026-07-14 audit).
 *
 * Site-compliance rule: customer-facing re-entry guidance never says
 * "safe" (and never promises fixed re-entry minutes) — the compliant house
 * phrasing is the one prep.interior_pest already uses ("until the
 * technician says they are ready"). prep.termite and prep.bed_bug still
 * carried "…until the technician confirms it is safe to return."
 *
 * Read-modify-write, admin-edit preserving (same posture as
 * 20260705010020): each block is only rewritten when it still carries the
 * exact shipped copy — an admin-edited block is left alone. Verified
 * verbatim against the prod active versions read-only on 2026-07-14.
 */

const SWAPS = [
  {
    templateKey: 'prep.bed_bug',
    from: 'Secure pets and plan to keep people and animals out of treated areas until the technician confirms it is safe to return.',
    to: 'Secure pets and plan to keep people and animals out of treated areas until the technician says they are ready.',
  },
  {
    templateKey: 'prep.termite',
    from: 'Keep people and pets away from active treatment areas until the technician confirms it is safe to return.',
    to: 'Keep people and pets away from active treatment areas until the technician says they are ready.',
  },
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function swapContent(blocks, from, to) {
  return asArray(blocks).map((b) => (
    b && typeof b.content === 'string' && b.content === from
      ? { ...b, content: to }
      : b
  ));
}

async function rewrite(knex, swaps) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  const now = new Date();

  for (const { templateKey, from, to } of swaps) {
    const template = await knex('email_templates').where({ template_key: templateKey }).first();
    if (!template?.active_version_id) continue;
    const version = await knex('email_template_versions')
      .where({ id: template.active_version_id })
      .first();
    if (!version) continue;
    await knex('email_template_versions').where({ id: version.id }).update({
      blocks: JSON.stringify(swapContent(version.blocks, from, to)),
      updated_at: now,
    });
  }
}

exports.up = async function up(knex) {
  await rewrite(knex, SWAPS);
};

exports.down = async function down(knex) {
  await rewrite(knex, SWAPS.map(({ templateKey, from, to }) => ({ templateKey, from: to, to: from })));
};
