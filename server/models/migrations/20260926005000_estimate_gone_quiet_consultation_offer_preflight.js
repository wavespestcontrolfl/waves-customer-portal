'use strict';

/**
 * Preflight for the gone-quiet consultation-offer chain (Codex #4918 r10
 * P2). 20260926010000 → 010100 → 010200 → 010300 each commit in their own
 * migration transaction, and the later ones throw for manual review on a
 * template shape they cannot place the link in safely. A throw in a later
 * file rolls back only that file — the earlier files' publications stay
 * after Railway rejects the deploy. The chain is pushed and frozen, so this
 * file sorts AHEAD of it and runs every abort condition the chain would
 * reach, before anything is published:
 *
 *   - the active version exists;
 *   - no custom plaintext body (010200/010300: the library renders text_body
 *     in place of the block text, so the link would reach HTML readers only);
 *   - a CTA to anchor on (010000), and a first button CTA that is guaranteed
 *     to render (010200/010300 — reused from 010300, never re-derived).
 *
 * Read-only. Runs only while the chain has not started (010000 absent from
 * knex_migrations); an environment where it already ran is past this point.
 * Absent template = the chain no-ops too, so nothing to check. down() is a
 * no-op (nothing written).
 */

const base = require('./20260926010000_estimate_gone_quiet_consultation_offer_cta');
const anchor = require('./20260926010300_estimate_gone_quiet_consultation_offer_anchor');

const { TEMPLATE_KEY, primaryCtaAnchorIndex } = base._private;
const { normalizedBlocks } = anchor._private;
const CHAIN_START = '20260926010000_estimate_gone_quiet_consultation_offer_cta.js';

function json(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  if (await knex.schema.hasTable('knex_migrations')) {
    const started = await knex('knex_migrations').where({ name: CHAIN_START }).first();
    if (started) return;
  }
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template) return;
  if (!template.active_version_id) throw new Error(`${TEMPLATE_KEY}: has no active version`);
  const active = await knex('email_template_versions')
    .where({ id: template.active_version_id, template_id: template.id })
    .first();
  if (!active) throw new Error(`${TEMPLATE_KEY}: active version is missing`);
  if (String(active.text_body || '').trim()) {
    throw new Error(`${TEMPLATE_KEY}: the active version has a custom plaintext body — add the consultation line to it by hand`);
  }
  const blocks = json(active.blocks, []);
  primaryCtaAnchorIndex(blocks);
  normalizedBlocks(blocks, json(template.required_variables, []));
};

exports.down = async function down() {};

exports._private = { CHAIN_START };
