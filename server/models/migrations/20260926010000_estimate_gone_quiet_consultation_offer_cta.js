'use strict';

/**
 * Adds the "Rather have us come look first?" consultation-offer link to the
 * estimate.engage_gone_quiet follow-up email (owner ruling 2026-09-26,
 * decision 2 of the estimate-email consultation-offer lane: "a link under
 * the main button"). ONE text-link CTA block right after the template's
 * existing PRIMARY CTA button — renders ONLY when the send-time build
 * (server/services/estimate-email-consultation-offer.js) computes a
 * non-blank `consultation_url`; every other send (gate off, ineligible
 * lead, wrong recipient, build error) keeps the email byte-identical to
 * before this migration (email-template-library.js's cta block renders
 * nothing for a blank url_variable).
 *
 * Mechanics follow 20260907000090_app_onboarding_email_versions.js:
 * publish a NEW version derived from the template's CURRENT ACTIVE VERSION
 * — never the original 20260715200000 seed content, and never any later
 * migration's transform of it (20260723300000 video modules,
 * 20260724100000 round 2 copy) — so every owner/admin edit made through the
 * email template admin since any of those survives. Idempotent, guarded by
 * a `validation_snapshot.migration` marker the same way that precedent's
 * publish does. `consultation_url` is added to allowed_variables ONLY
 * (never required) — a dark gate or an ineligible send must never fail
 * validation or block the send on a missing variable.
 *
 * down() reverts active_version_id to the version this migration replaced
 * (recorded in the published version's own validation_snapshot), but ONLY
 * while that inserted version is STILL the active one — a version
 * published since (a staff edit, or a later migration) is never discarded
 * by this rollback. The version row this migration inserted is never
 * deleted, so history is retained either way (same rule the app-onboarding
 * precedent's own no-op down protects).
 */

const { validationFor } = require('../../services/email-template-library');
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20260926010000';
const TEMPLATE_KEY = 'estimate.engage_gone_quiet';
const NEW_VARIABLE = 'consultation_url';
const LINK_LABEL = 'Rather have us come look first? Pick a time for a free consultation →';

function json(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// The template's existing PRIMARY CTA — the first cta-type block in
// whatever the CURRENT active version actually holds (never assumed from
// the original seed, which staff or a later migration may have re-ordered,
// relabeled, or added blocks around since). The gone_quiet seed's primary
// CTA is "Take another look" (url_variable: estimate_url); a secondary
// "products & safety" chip CTA follows it. Insert right after the primary
// one, per the owner's placement ruling.
function primaryCtaAnchorIndex(blocks) {
  const index = blocks.findIndex((b) => b?.type === 'cta');
  if (index < 0) {
    throw new Error(`${TEMPLATE_KEY}: no primary CTA block found in the active version — review before publishing`);
  }
  return index;
}

function alreadyHasConsultationLink(blocks) {
  return blocks.some((b) => b?.type === 'cta' && b.url_variable === NEW_VARIABLE);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const template = await trx('email_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
    if (!template) return; // Not seeded in this environment — nothing to version.
    if (!template.active_version_id) throw new Error(`${TEMPLATE_KEY}: has no active version`);

    // Idempotent: a version this migration already published is marked with
    // its own migration id (same convention as 20260907000090).
    const alreadyPublished = await trx('email_template_versions')
      .where({ template_id: template.id })
      .whereRaw("validation_snapshot->>'migration' = ?", [MIGRATION])
      .first('id');
    if (alreadyPublished) return;

    const active = await trx('email_template_versions')
      .where({ id: template.active_version_id, template_id: template.id })
      .first();
    if (!active) throw new Error(`${TEMPLATE_KEY}: active version is missing`);

    const blocks = json(active.blocks, []);
    // Belt-and-suspenders idempotency: an active version that already
    // carries the block (a re-run, or a hand-authored equivalent) is left
    // alone — never a second copy of the link.
    if (alreadyHasConsultationLink(blocks)) return;

    const anchor = primaryCtaAnchorIndex(blocks);
    const nextBlocks = [...blocks];
    nextBlocks.splice(anchor + 1, 0, { type: 'cta', variant: 'link', label: LINK_LABEL, url_variable: NEW_VARIABLE });

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
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const template = await trx('email_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
    if (!template) return;
    const published = await trx('email_template_versions')
      .where({ template_id: template.id })
      .whereRaw("validation_snapshot->>'migration' = ?", [MIGRATION])
      .first();
    if (!published) return; // Nothing this migration published — nothing to revert.
    // Only roll back while OUR version is still the active one — a version
    // published since (a staff edit through the admin template library, or
    // a later migration) must never be silently discarded by this
    // rollback. The version row itself is never deleted either way, so
    // history is retained.
    if (template.active_version_id !== published.id) return;
    const priorId = json(published.validation_snapshot, {}).prior_version_id;
    if (!priorId) return;
    const prior = await trx('email_template_versions').where({ id: priorId, template_id: template.id }).first('id');
    if (!prior) return;
    await trx('email_templates').where({ id: template.id }).update({
      active_version_id: prior.id,
      updated_at: new Date(),
    });
  });
};

exports._private = { primaryCtaAnchorIndex, alreadyHasConsultationLink, NEW_VARIABLE, TEMPLATE_KEY, LINK_LABEL, MIGRATION };
