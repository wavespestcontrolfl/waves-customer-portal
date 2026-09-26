'use strict';

/**
 * Final shape for the gone-quiet consultation link (Codex #4918 r1 P2s).
 * 20260926010000 and 20260926010100 are pushed and frozen, so this
 * supersedes both. It normalizes the template's ACTIVE version and
 * publishes the result as its own version:
 *
 *   - exactly one consultation link, directly after the PRIMARY button —
 *     the first non-link CTA, which is what email-template-library.js draws
 *     as the button (the earlier migrations anchored on the first CTA of any
 *     variant, so a link-style CTA a staff edit placed above the button
 *     would have pulled the offer above it). No button CTA → the migration
 *     fails for manual review rather than guess.
 *   - a custom plaintext body fails the migration for manual review: the
 *     library renders text_body in place of the block-generated text, so
 *     the link would reach HTML readers only. Verified 2026-09-26: prod's
 *     active version (v1, the seed) has none.
 *
 * down() is a documented no-op: a rollback never rewrites curated,
 * admin-editable template content (the app-onboarding precedent's rule).
 * Because up() always leaves this migration's OWN version active, the
 * earlier migrations' reverting downs find nothing of theirs active and
 * no-op as well. Idempotent: an active version already published by this
 * migration in the normalized shape is left alone.
 */

const { validationFor } = require('../../services/email-template-library');
const { recordAuditEvent } = require('../../services/audit-log');
const base = require('./20260926010000_estimate_gone_quiet_consultation_offer_cta');

const { NEW_VARIABLE, TEMPLATE_KEY, LINK_LABEL } = base._private;
const MIGRATION = '20260926010200';
const LINK_BLOCK = { type: 'cta', variant: 'link', label: LINK_LABEL, url_variable: NEW_VARIABLE };

function json(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// jsonb stores object keys in its own order, so blocks read back never
// string-match freshly built ones — compare with keys sorted.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

// The active blocks with exactly one consultation link, right after the
// first non-link CTA (the rendered button).
function normalizedBlocks(blocks) {
  const stripped = blocks.filter((b) => !(b?.type === 'cta' && b.url_variable === NEW_VARIABLE));
  const button = stripped.findIndex((b) => b?.type === 'cta' && b.variant !== 'link');
  if (button < 0) {
    throw new Error(`${TEMPLATE_KEY}: no primary button CTA in the active version — place the consultation link by hand`);
  }
  const next = [...stripped];
  next.splice(button + 1, 0, { ...LINK_BLOCK });
  return next;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const template = await trx('email_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
    if (!template) return;
    if (!template.active_version_id) throw new Error(`${TEMPLATE_KEY}: has no active version`);
    const active = await trx('email_template_versions')
      .where({ id: template.active_version_id, template_id: template.id })
      .first();
    if (!active) throw new Error(`${TEMPLATE_KEY}: active version is missing`);
    if (String(active.text_body || '').trim()) {
      throw new Error(`${TEMPLATE_KEY}: the active version has a custom plaintext body — add the consultation line to it by hand`);
    }

    const blocks = json(active.blocks, []);
    const nextBlocks = normalizedBlocks(blocks);
    const ownVersion = json(active.validation_snapshot, {}).migration === MIGRATION;
    if (ownVersion && JSON.stringify(canonical(nextBlocks)) === JSON.stringify(canonical(blocks))) return;

    const allowed = [...new Set([...json(template.allowed_variables, []), NEW_VARIABLE])];
    const versionFields = {
      subject: active.subject,
      preview_text: active.preview_text,
      blocks: JSON.stringify(nextBlocks),
      text_body: active.text_body,
    };
    const validation = validationFor(
      { ...template, allowed_variables: allowed, required_variables: json(template.required_variables, []) },
      versionFields,
    );
    if (!validation.ok) {
      throw new Error(`${TEMPLATE_KEY}: normalized consultation-offer version failed variable validation: ${JSON.stringify(validation)}`);
    }
    versionFields.validation_snapshot = JSON.stringify({ ...validation, migration: MIGRATION, prior_version_id: active.id });

    const latest = await trx('email_template_versions').where({ template_id: template.id }).max('version_number as max').first();
    await trx('email_template_versions')
      .where({ template_id: template.id, status: 'active' })
      .update({ status: 'archived', updated_at: new Date() });
    const [version] = await trx('email_template_versions').insert({
      ...versionFields,
      template_id: template.id,
      version_number: Number(latest?.max || 0) + 1,
      status: 'active',
      published_at: new Date(),
    }).returning('id');

    await trx('email_templates').where({ id: template.id }).update({
      allowed_variables: JSON.stringify(allowed),
      optional_variables: JSON.stringify([...new Set([...json(template.optional_variables, []), NEW_VARIABLE])]),
      active_version_id: version.id,
      last_published_at: new Date(),
      updated_at: new Date(),
    });

    if (await trx.schema.hasTable('email_template_fixtures')) {
      const fixtures = await trx('email_template_fixtures').where({ template_id: template.id });
      for (const fixture of fixtures) {
        const payload = json(fixture.payload, {});
        if (payload[NEW_VARIABLE] === undefined) payload[NEW_VARIABLE] = '';
        await trx('email_template_fixtures').where({ id: fixture.id }).update({ payload: JSON.stringify(payload), updated_at: new Date() });
      }
    }

    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:publish`,
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { template_key: TEMPLATE_KEY, prior_version_id: active.id, version_id: version.id },
      critical: true,
      trx,
    });
  });
};

// Documented no-op: curated template content is never rewritten by a
// rollback (see header).
exports.down = async function down() {};

exports._private = { MIGRATION, normalizedBlocks };
