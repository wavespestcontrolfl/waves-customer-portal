'use strict';

/**
 * Referral email template polish — ships as its OWN migration because the
 * templates were seeded by 20260705010040 in the PARENT PR of this stack:
 * environments that deploy the parent first record that filename in
 * knex_migrations, so any in-place edit to it would be a silent no-op there
 * (knex tracks migrations by filename). This migration patches the seeded
 * rows regardless of which seed version ran.
 *
 * 1. referral.invite renders in SERVICE chrome while keeping its
 *    marketing_referral suppression stream — the pin is
 *    layout_wrapper_id = 'service_pinned_v1', honored at sendTemplate's
 *    modeOverride site (owner directive 2026-07-06).
 * 2. referral.reward_earned's CTA becomes the {{cta_label}} variable so the
 *    sender can point account-credit payouts at the billing tab and
 *    referral-balance payouts at the refer tab (the label used to be
 *    hard-coded "View my referral balance", wrong for deferred rewards).
 */

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;

  // 1. Service-chrome pin for the invite. mode also flips to 'service' so
  //    the column reflects the render intent (the parent seed says
  //    'marketing'); suppression/unsubscribe still key on the
  //    marketing_referral stream, which is untouched.
  await knex('email_templates')
    .where({ template_key: 'referral.invite' })
    .update({ layout_wrapper_id: 'service_pinned_v1', mode: 'service', updated_at: new Date() });

  // 2. Variable CTA for the reward email: template variable lists + the
  //    active version's CTA block label.
  const template = await knex('email_templates')
    .where({ template_key: 'referral.reward_earned' })
    .first('id', 'active_version_id', 'allowed_variables', 'required_variables');
  if (!template) return;

  const parseList = (value) => {
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value || '[]'); } catch { return []; }
  };
  const allowed = parseList(template.allowed_variables);
  const required = parseList(template.required_variables);
  if (!allowed.includes('cta_label')) allowed.push('cta_label');
  if (!required.includes('cta_label')) required.push('cta_label');
  await knex('email_templates')
    .where({ id: template.id })
    .update({
      allowed_variables: JSON.stringify(allowed),
      required_variables: JSON.stringify(required),
      description: 'A referral converted — confirm the reward. The reward line, CTA label, and CTA destination come from the sender (referral-balance vs account-credit payouts point at different ledgers).',
      updated_at: new Date(),
    });

  // Default preview fixture must satisfy the new required variable or the
  // admin preview/test-send path fails with a missing-variable error.
  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first('id', 'payload');
    if (fixture) {
      let payload = {};
      try { payload = typeof fixture.payload === 'object' && fixture.payload !== null ? fixture.payload : JSON.parse(fixture.payload || '{}'); } catch { payload = {}; }
      if (!payload.cta_label) {
        payload.cta_label = 'View my referral balance';
        await knex('email_template_fixtures')
          .where({ id: fixture.id })
          .update({ payload: JSON.stringify(payload), updated_at: new Date() });
      }
    }
  }

  if (!template.active_version_id) return;
  const version = await knex('email_template_versions')
    .where({ id: template.active_version_id })
    .first('id', 'blocks');
  if (!version) return;
  const blocks = parseList(version.blocks).map((block) => (
    block && block.type === 'cta'
      ? { ...block, label: '{{cta_label}}' }
      : block
  ));
  await knex('email_template_versions')
    .where({ id: version.id })
    .update({ blocks: JSON.stringify(blocks), updated_at: new Date() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates')
    .where({ template_key: 'referral.invite' })
    .update({ layout_wrapper_id: 'service_default_v1', updated_at: new Date() });
  // The reward CTA revert is intentionally best-effort: restore the fixed label.
  const template = await knex('email_templates')
    .where({ template_key: 'referral.reward_earned' })
    .first('active_version_id');
  if (!template?.active_version_id) return;
  const version = await knex('email_template_versions')
    .where({ id: template.active_version_id })
    .first('id', 'blocks');
  if (!version) return;
  let blocks;
  try { blocks = Array.isArray(version.blocks) ? version.blocks : JSON.parse(version.blocks || '[]'); } catch { return; }
  blocks = blocks.map((block) => (
    block && block.type === 'cta'
      ? { ...block, label: 'View my referral balance' }
      : block
  ));
  await knex('email_template_versions')
    .where({ id: version.id })
    .update({ blocks: JSON.stringify(blocks), updated_at: new Date() });
};
