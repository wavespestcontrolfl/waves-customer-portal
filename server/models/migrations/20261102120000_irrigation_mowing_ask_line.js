'use strict';

/**
 * Monday irrigation email: the mowing-days ask (owner 2026-11-02).
 *
 * Copy (customer copy, owner-approved, do not reword) is built by the sender
 * (irrigation-weekly-email.js MOWING_ASK) and reaches the template as
 * {{mowing_ask}}:
 *   When does your lawn get mowed? Mowing right before or right after a lawn
 *   treatment can undo it. Add your mowing days under Mowing in your portal,
 *   and we'll plan your lawn treatments around them.
 * with a small "Add my mowing days" text link on {{mowing_ask_url}} (the
 * portal property tab, the same URL the setup button uses).
 *
 * The sender fills both variables only while GATE_AUTO_DISPATCH_MOWING_DAYS
 * is 'true', the customer has nothing saved under Mowing, and the ask is due
 * (first 3 sends, then once every 4 weeks). Otherwise both are empty: an
 * empty paragraph renders nothing and a cta block whose url_variable is empty
 * renders nothing, so the email is unchanged. The link is variant 'link': a
 * small text link that never takes the primary button slot.
 *
 * WHERE THE LINE LIVES. The bodies are email_template_versions rows (seeded
 * by migration, edited by migration and by the office editor). Each template
 * the weekly sweep can pick gets a new active version with two blocks, the
 * {{mowing_ask}} paragraph and the link:
 *  - irrigation.weekly_setup_schedule: right after the {{schedule_ask}}
 *    callout; when the tuna-can line (20261101140000) follows the callout it
 *    stays with the ask it belongs to, and the mowing ask goes after it;
 *  - every other weekly template (on_track, cut_back, add_water,
 *    setup_system, rain_report, confirm_schedule, plan): right before the
 *    "Helpful guides from the Waves blog" heading (20260907000010).
 * A version without that anchor (an office edit) takes the crew-note
 * fallbacks (20261022190000): before the standing footer small print, else
 * before the first signature, else at the end.
 *
 * Same discipline as the sibling migrations (20261022190000, 20261026230000,
 * 20261101140000):
 *  - the template row is locked FOR UPDATE first and everything is read under
 *    the lock, so an office edit made before the lock wins;
 *  - exactly once: a representation (blocks, staff text body) that already
 *    places {{mowing_ask}} is left as it is, so a re-run publishes nothing;
 *  - a staff-authored plain-text body wins over block-derived text at render
 *    time, so it gets the line in text form, "{{mowing_ask}} {{mowing_ask_url}}",
 *    in the same place (with the line off that paragraph is blank);
 *  - the two new variables are OPTIONAL (allowed, never required): this
 *    migration runs before the new app version serves and the old sender does
 *    not supply them, which renders exactly like the line being off. An EMPTY
 *    allowed_variables list means "no restriction" and stays empty;
 *  - a version with no cta block on a template with a default CTA is left
 *    whole ('skipped'): any cta block would hide that default button;
 *  - the prior version is archived, never overwritten; one audit_log row per
 *    published template, same transaction.
 *
 * Nothing else changes: subject, preview, other blocks, send conditions,
 * recipients. No send is triggered. down() is a documented no-op: the
 * superseded versions stay archived and can be re-published from the editor,
 * and with the gate off the new blocks render nothing.
 */

const { TUNA_CAN_LINE } = require('./20261101140000_irrigation_tuna_can_line').__private;

const MIGRATION_ID = '20261102120000_irrigation_mowing_ask_line';
const MIGRATION_MARKER = 'migration:20261102120000';
// audit_log.action is varchar(96).
const AUDIT_ACTION = 'email_template.publish';

const SETUP_SCHEDULE_KEY = 'irrigation.weekly_setup_schedule';
const TEMPLATE_KEYS = [
  'irrigation.weekly_on_track',
  'irrigation.weekly_cut_back',
  'irrigation.weekly_add_water',
  SETUP_SCHEDULE_KEY,
  'irrigation.weekly_setup_system',
  'irrigation.weekly_rain_report',
  'irrigation.weekly_confirm_schedule',
  'irrigation.weekly_plan',
];

const ASK_VAR = 'mowing_ask';
const URL_VAR = 'mowing_ask_url';
const NEW_VARS = [ASK_VAR, URL_VAR];
const ASK_TOKEN = `{{${ASK_VAR}}}`;
const ASK_BLOCK = { type: 'paragraph', content: ASK_TOKEN };
const LINK_BLOCK = { type: 'cta', variant: 'link', label: 'Add my mowing days', url_variable: URL_VAR };
const ASK_TEXT = `${ASK_TOKEN} {{${URL_VAR}}}`;
const GUIDES_HEADING = 'Helpful guides from the Waves blog';
const SCHEDULE_ASK_TOKEN = '{{schedule_ask}}';

// Editor preview values (a sample, never a customer's): the approved line and the property tab.
const FIXTURE_VALUES = {
  [ASK_VAR]: "When does your lawn get mowed? Mowing right before or right after a lawn treatment can undo it. Add your mowing days under Mowing in your portal, and we'll plan your lawn treatments around them.",
  [URL_VAR]: 'https://portal.wavespestcontrol.com/?tab=property',
};

const json = (v) => JSON.stringify(v);
// A jsonb value as read (pg hands back the parsed value, a test double the JSON text).
const parseJson = (v) => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};
const parseList = (v) => { const p = parseJson(v); return Array.isArray(p) ? p : null; };
const parseObject = (v) => { const p = parseJson(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; };

/**
 * Pure: where the two blocks go (see the header), or -1 when nothing anchors.
 * setup_schedule: after the {{schedule_ask}} callout (and its tuna-can line).
 * Others, or a setup_schedule version without that callout: before the guides heading.
 */
function anchorIndex(blocks, key) {
  const callout = key === SETUP_SCHEDULE_KEY
    ? blocks.findIndex((b) => b?.type === 'callout' && String(b.content || '').includes(SCHEDULE_ASK_TOKEN))
    : -1;
  if (callout >= 0) {
    const next = blocks[callout + 1];
    return next?.type === 'paragraph' && next.content === TUNA_CAN_LINE ? callout + 2 : callout + 1;
  }
  return blocks.findIndex((b) => b?.type === 'heading' && String(b.content || '').trim() === GUIDES_HEADING);
}

/** Pure: the blocks with the ask and its link inserted; as they are when already there. */
function withAsk(blocks, key) {
  if (json(blocks).includes(ASK_TOKEN)) return blocks;
  let at = anchorIndex(blocks, key);
  if (at < 0) {
    const lastNote = blocks.map((b) => b?.type).lastIndexOf('small_note');
    const onlySignaturesAfter = lastNote >= 0 && blocks.slice(lastNote + 1).every((b) => b?.type === 'signature');
    at = onlySignaturesAfter ? lastNote : blocks.findIndex((b) => b?.type === 'signature');
  }
  if (at < 0) at = blocks.length;
  return [...blocks.slice(0, at), ASK_BLOCK, LINK_BLOCK, ...blocks.slice(at)];
}

/** Pure: a staff-authored text body with the text-form line in the same place. No body, or already there: as is. */
function withAskText(text, key) {
  if (typeof text !== 'string' || !text.trim() || text.includes(ASK_TOKEN)) return text;
  const paragraphs = text.replace(/\s+$/, '').split(/\n{2,}/);
  const ask = key === SETUP_SCHEDULE_KEY ? paragraphs.findIndex((p) => p.includes(SCHEDULE_ASK_TOKEN)) : -1;
  let at = ask >= 0
    ? (paragraphs[ask + 1]?.trim() === TUNA_CAN_LINE ? ask + 2 : ask + 1)
    : paragraphs.findIndex((p) => p.trim().toLowerCase() === GUIDES_HEADING.toLowerCase());
  if (at < 0) at = paragraphs.findIndex((p) => /^\s*(This (tip|plan|check-in) is based on|—|-\s*The Waves Team)/.test(p));
  if (at < 0) at = paragraphs.length;
  return [...paragraphs.slice(0, at), ASK_TEXT, ...paragraphs.slice(at)].join('\n\n');
}

/**
 * Publish the new version of one template inside one transaction, template
 * row locked first. Returns 'published', 'already', 'skipped' or 'missing'.
 */
async function publishAsk(knex, key) {
  return knex.transaction(async (trx) => {
    // 1. Lock the template row FIRST; everything below is read under the lock.
    const template = await trx('email_templates').where({ template_key: key }).forUpdate().first();
    const prior = template && await trx('email_template_versions').where({ id: template.active_version_id }).first();
    if (!prior) return 'missing';
    const priorBlocks = parseList(prior.blocks);
    if (!priorBlocks?.length) {
      console.warn(`[${MIGRATION_MARKER}] ${key}: active version has no usable blocks; template left as-is`);
      return 'skipped';
    }
    const relyOnDefaultCta = !priorBlocks.some((b) => b?.type === 'cta') && template.default_cta_label && template.default_cta_url_variable;
    const before = { blocks: priorBlocks, text_body: prior.text_body };
    const after = { blocks: withAsk(priorBlocks, key), text_body: withAskText(prior.text_body, key) };
    const changedFields = Object.keys(before).filter((field) => json(before[field]) !== json(after[field]));
    if (!changedFields.length) return 'already';
    if (relyOnDefaultCta && changedFields.includes('blocks')) {
      console.warn(`[${MIGRATION_MARKER}] ${key}: active version relies on the default CTA; a link block would hide it, template left as-is`);
      return 'skipped';
    }
    // Either representation added here places both variables. Send-time validation rejects a
    // referenced variable missing from a non-empty allowlist, so both are allowed, and optional, never required.
    const vars = NEW_VARS;

    const latest = await trx('email_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'desc')
      .first();
    const now = new Date();
    // 2. Insert the new version (every writer of numbers takes the template
    //    row lock first, so the number is safe).
    const [created] = await trx('email_template_versions').insert({
      template_id: template.id,
      version_number: latest.version_number + 1,
      status: 'active',
      subject: prior.subject,
      preview_text: prior.preview_text,
      blocks: json(after.blocks),
      text_body: after.text_body,
      validation_snapshot: json({
        ok: true,
        source: MIGRATION_MARKER,
        supersedes_version: prior.version_number,
        referenced_variables: vars,
        disallowed_variables: [],
        missing_required_in_template: [],
      }),
      published_at: now,
    }).returning('*');
    // 3. Move the pointer (under the lock; the where is belt and braces) and
    //    allow the new variables. An EMPTY allowlist means "no restriction" and stays empty.
    const allowed = parseList(template.allowed_variables) || [];
    const moved = await trx('email_templates').where({ id: template.id, active_version_id: prior.id }).update({
      active_version_id: created.id,
      allowed_variables: json(allowed.length ? [...new Set([...allowed, ...vars])] : allowed),
      optional_variables: json([...new Set([...(parseList(template.optional_variables) || []), ...vars])]),
      last_published_at: now,
      updated_at: now,
    });
    if (!moved) throw new Error(`[${MIGRATION_MARKER}] ${key}: active pointer moved under the row lock`);
    // 4. Retire only the version this one replaces.
    await trx('email_template_versions')
      .where({ id: prior.id, status: 'active' })
      .update({ status: 'archived', updated_at: now });
    // 5. Editor preview values for the new variables; a value a fixture already has wins.
    const sample = Object.fromEntries(vars.map((name) => [name, FIXTURE_VALUES[name]]));
    const fixtures = await trx('email_template_fixtures').where({ template_id: template.id }).select('id', 'payload');
    for (const f of fixtures) {
      await trx('email_template_fixtures').where({ id: f.id }).update({ payload: json({ ...sample, ...parseObject(f.payload) }) });
    }
    // 6. Audit, same transaction (required lazily so loading this file pulls in nothing).
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system:migration',
      action: AUDIT_ACTION,
      resource_type: 'email_template',
      resource_id: template.id,
      critical: true,
      trx,
      metadata: {
        via: MIGRATION_MARKER,
        migration: MIGRATION_ID,
        template_key: key,
        from_version_id: prior.id,
        from_version_number: prior.version_number,
        to_version_id: created.id,
        to_version_number: created.version_number,
        reason: 'Monday irrigation email: mowing-days ask, shown only while GATE_AUTO_DISPATCH_MOWING_DAYS is true (owner 2026-11-02)',
        changes: Object.fromEntries(changedFields.map((field) => [field, { before: before[field], after: after[field] }])),
        added_variables: vars,
      },
    });
    return 'published';
  });
}

// The template tables (fixtures included) come from 20260518000001; audit_log
// (20260419000005) is older, so both exist wherever email_templates does.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  // Each outcome goes to the deploy log, so a 'skipped' (office-edited body) is visible.
  for (const key of TEMPLATE_KEYS) {
    const outcome = await publishAsk(knex, key);
    console.log(`[${MIGRATION_ID}] ${key}: ${outcome}`);
  }
};

// Intentionally a no-op: see the header.
exports.down = async function down() {};

exports.__private = {
  MIGRATION_ID, MIGRATION_MARKER, AUDIT_ACTION, TEMPLATE_KEYS, ASK_BLOCK, LINK_BLOCK, ASK_TEXT, NEW_VARS, FIXTURE_VALUES,
  withAsk, withAskText, publishAsk,
};
