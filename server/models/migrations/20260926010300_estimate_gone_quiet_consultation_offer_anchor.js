'use strict';

/**
 * Fixes the anchor bug in 20260926010200 (Codex #4918 r2 P2). That
 * migration anchored the consultation link after the first NON-LINK CTA in
 * the active version's blocks, on the assumption that block is always the
 * one email-template-library.js's renderBlocks() actually draws as the
 * primary button. That assumption breaks when the first non-link CTA's
 * `url_variable` is OPTIONAL and blank for a given send: renderBlocks()
 * skips a CTA with a falsy href entirely, so that block disappears from the
 * rendered email and the NEXT non-link CTA becomes the real, rendered
 * button — leaving the consultation link sitting before the actual button
 * instead of after it.
 *
 * 20260926010000/010100/010200 are pushed and frozen, so this supersedes
 * 010200. It re-derives the normalized shape from the template's ACTIVE
 * version with one added rule: the first non-link CTA is only used as the
 * anchor when it is GUARANTEED to render for every send — a static `url`
 * (no url_variable at all), or a url_variable that is one of the
 * template's own `required_variables` (never blank by contract). When the
 * first non-link CTA is not guaranteed, this fails the migration for
 * manual review rather than guess which later CTA is the "real" one, or
 * silently keep the earlier migrations' potentially-wrong placement.
 *
 * Other rules carried over unchanged from 010200: a custom plaintext body
 * fails for manual review (the library renders text_body verbatim in place
 * of the block-generated text, so a mechanically-added link block would
 * reach HTML readers only); down() is a documented no-op, same rule as
 * 010200 (a rollback never rewrites curated, admin-editable template
 * content — the app-onboarding precedent's rule). Because up() always
 * leaves either 010200's or this migration's OWN version active, the
 * earlier migrations' reverting downs find nothing of theirs active and
 * no-op as well.
 *
 * Idempotent, but deliberately NOT "publish only when I'm not already the
 * owner": when the active version's blocks already canonically equal what
 * this migration would produce AND that version is owned by 010200 OR by
 * this migration, nothing is published. 010200 already anchors correctly
 * whenever the first non-link CTA happens to be guaranteed (true for the
 * seeded gone_quiet template today, whose primary CTA's url_variable is
 * `estimate_url`, a required variable) — so a normal deploy that runs
 * 010200 immediately before this migration finds an already-correct shape
 * and this migration is a no-op, leaving 010200's version as the active
 * one. That is safe for rollback: this migration's own down() never
 * touches anything (documented no-op, same as 010200's), so skipping the
 * publish here never leaves a dangling version this migration would need
 * to unwind, and 010200's/010100's/010000's own downs are unaffected by
 * which of 010200/010300 happens to own the active version — none of them
 * revert a version they didn't publish. A version NOT owned by 010200 or
 * this migration (e.g. a staff edit, or a pre-010200 marker) is always
 * (re-)normalized, even if it happens to already match byte-for-byte,
 * so this migration's own ownership marker — and its guarantee check —
 * is always the one covering the active version going forward.
 */

const { validationFor } = require('../../services/email-template-library');
const { recordAuditEvent } = require('../../services/audit-log');
const base = require('./20260926010000_estimate_gone_quiet_consultation_offer_cta');
const prior = require('./20260926010200_estimate_gone_quiet_consultation_offer_normalize');

const { NEW_VARIABLE, TEMPLATE_KEY, LINK_LABEL } = base._private;
const MIGRATION = '20260926010300';
const LINK_BLOCK = { type: 'cta', variant: 'link', label: LINK_LABEL, url_variable: NEW_VARIABLE };
// A version already in the normalized shape and owned by either this
// migration or 010200 (the migration whose output this one confirms
// rather than blindly republishes) needs no new version.
const ALREADY_NORMALIZED_OWNERS = new Set([prior._private.MIGRATION, MIGRATION]);

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

// A CTA is guaranteed to render (renderBlocks() never drops it for a
// falsy href) when it carries a static `url` and no url_variable at all,
// or when its url_variable is one of the template's required_variables —
// contractually never blank for any send.
function isGuaranteedCta(block, requiredVariables) {
  if (block.url_variable) return requiredVariables.includes(block.url_variable);
  return Boolean(block.url);
}

// The active blocks with exactly one consultation link, right after the
// first non-link CTA — but ONLY when that CTA is guaranteed to render.
function normalizedBlocks(blocks, requiredVariables) {
  const stripped = blocks.filter((b) => !(b?.type === 'cta' && b.url_variable === NEW_VARIABLE));
  const buttonIndex = stripped.findIndex((b) => b?.type === 'cta' && b.variant !== 'link');
  if (buttonIndex < 0) {
    throw new Error(`${TEMPLATE_KEY}: no primary button CTA in the active version — place the consultation link by hand`);
  }
  const button = stripped[buttonIndex];
  if (!isGuaranteedCta(button, requiredVariables || [])) {
    throw new Error(
      `${TEMPLATE_KEY}: the first non-link CTA ("${button.label}") has an optional url_variable `
      + `("${button.url_variable}") that may render blank — it is not safe to anchor the consultation `
      + 'link to it automatically. Place the link by hand after reviewing which CTA actually renders.',
    );
  }
  const next = [...stripped];
  next.splice(buttonIndex + 1, 0, { ...LINK_BLOCK });
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

    const requiredVariables = json(template.required_variables, []);
    const blocks = json(active.blocks, []);
    const nextBlocks = normalizedBlocks(blocks, requiredVariables);
    const activeMigration = json(active.validation_snapshot, {}).migration;
    const alreadyNormalizedOwner = ALREADY_NORMALIZED_OWNERS.has(activeMigration);
    if (alreadyNormalizedOwner && JSON.stringify(canonical(nextBlocks)) === JSON.stringify(canonical(blocks))) return;

    const allowed = [...new Set([...json(template.allowed_variables, []), NEW_VARIABLE])];
    const versionFields = {
      subject: active.subject,
      preview_text: active.preview_text,
      blocks: JSON.stringify(nextBlocks),
      text_body: active.text_body,
    };
    const validation = validationFor(
      { ...template, allowed_variables: allowed, required_variables: requiredVariables },
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

exports._private = { MIGRATION, normalizedBlocks, isGuaranteedCta };
