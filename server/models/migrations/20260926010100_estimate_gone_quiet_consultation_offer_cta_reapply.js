'use strict';

/**
 * Supersedes 20260926010000's idempotency (pre-push Codex P1). That
 * migration's up() returns early whenever its marker version row exists —
 * even after its own down() archived that version — so a rollback followed
 * by a re-run recorded success with the consultation link absent. It is
 * pushed, so it is frozen (never edited in place); this migration carries
 * the fix.
 *
 * up() publishes the link whenever the template's ACTIVE version lacks it —
 * content-based, no marker check — deriving from the active version exactly
 * as 20260926010000 does (link block right after the primary CTA,
 * consultation_url allowed + optional, fixtures get '', the replaced
 * version archived, audited). On a normal deploy 20260926010000 has just
 * published the link and this is a no-op; after a rollback of both, the
 * older one re-runs as a no-op and this one republishes.
 *
 * down() reverts only its OWN publication, and only while that version is
 * still the active one — a later staff edit is never discarded, and
 * 20260926010000's down() still owns reverting what it published.
 */

const { validationFor } = require('../../services/email-template-library');
const { recordAuditEvent } = require('../../services/audit-log');
const base = require('./20260926010000_estimate_gone_quiet_consultation_offer_cta');

const {
  primaryCtaAnchorIndex, alreadyHasConsultationLink, NEW_VARIABLE, TEMPLATE_KEY, LINK_LABEL,
} = base._private;
const MIGRATION = '20260926010100';

function json(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function tablesPresent(knex) {
  return (await knex.schema.hasTable('email_templates')) && (await knex.schema.hasTable('email_template_versions'));
}

exports.up = async function up(knex) {
  if (!(await tablesPresent(knex))) return;
  await knex.transaction(async (trx) => {
    const template = await trx('email_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
    if (!template) return;
    if (!template.active_version_id) throw new Error(`${TEMPLATE_KEY}: has no active version`);
    const active = await trx('email_template_versions')
      .where({ id: template.active_version_id, template_id: template.id })
      .first();
    if (!active) throw new Error(`${TEMPLATE_KEY}: active version is missing`);

    const blocks = json(active.blocks, []);
    if (alreadyHasConsultationLink(blocks)) return;

    const nextBlocks = [...blocks];
    nextBlocks.splice(primaryCtaAnchorIndex(blocks) + 1, 0, {
      type: 'cta', variant: 'link', label: LINK_LABEL, url_variable: NEW_VARIABLE,
    });
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
      throw new Error(`${TEMPLATE_KEY}: consultation-offer version failed variable validation: ${JSON.stringify(validation)}`);
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

exports.down = async function down(knex) {
  if (!(await tablesPresent(knex))) return;
  await knex.transaction(async (trx) => {
    const template = await trx('email_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
    if (!template?.active_version_id) return;
    const active = await trx('email_template_versions')
      .where({ id: template.active_version_id, template_id: template.id })
      .first();
    const snapshot = json(active?.validation_snapshot, {});
    if (snapshot.migration !== MIGRATION || !snapshot.prior_version_id) return;
    const prior = await trx('email_template_versions')
      .where({ id: snapshot.prior_version_id, template_id: template.id })
      .first('id');
    if (!prior) return;
    await trx('email_template_versions').where({ id: active.id }).update({ status: 'archived', updated_at: new Date() });
    await trx('email_template_versions').where({ id: prior.id }).update({ status: 'active', updated_at: new Date() });
    await trx('email_templates').where({ id: template.id }).update({ active_version_id: prior.id, updated_at: new Date() });
  });
};

exports._private = { MIGRATION };
