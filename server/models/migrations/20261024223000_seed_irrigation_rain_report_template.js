'use strict';

/**
 * Seed irrigation.weekly_rain_report: the Monday rain report with no
 * "add your watering schedule" ask (GATE_IRRIGATION_SETUP_ASK_CADENCE,
 * owner 2026-10-24).
 *
 * Since 08-03, 18 customers got the same setup ask 12 Mondays running and
 * never answered. With the gate on, a customer gets the ask on their first 3
 * setup emails, then at most once every 4 weeks; the weeks between send this
 * template instead.
 *
 * The body is a COPY of the active irrigation.weekly_setup_system version at
 * migrate time, minus its callout and cta blocks. Copying the live version
 * (not the 08-01 seed) keeps every later edit: the rain source note, the blog
 * links, the mowing crew note and any office edit. setup_system is the source
 * because its other blocks never assume a sprinkler system. A staff plain-text
 * body is dropped (text_body null) because it would still carry the ask; the
 * text part then renders from the blocks.
 *
 * Same stream, suppression group and variables as the source, so unsubscribes
 * and the Seasonal Lawn Tips opt-out apply the same way. No default CTA.
 * Sends nothing by itself: the sweep picks this key only with the gate on.
 *
 * Idempotent: an existing rain_report template is left alone. No source
 * template (fresh test DB) = nothing seeded; the gate must stay off there.
 * down() is a documented no-op: the template may carry office edits by then,
 * and with the gate off nothing sends it. Retire it from the template editor.
 */

const SOURCE_KEY = 'irrigation.weekly_setup_system';
const TARGET_KEY = 'irrigation.weekly_rain_report';
const DROPPED_BLOCK_TYPES = new Set(['callout', 'cta']);

const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};
const asJson = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? []));
const rainReportBlocks = (blocks) => asArray(blocks).filter((b) => !DROPPED_BLOCK_TYPES.has(b?.type));

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;

  await knex.transaction(async (trx) => {
    if (await trx('email_templates').where({ template_key: TARGET_KEY }).first()) return;
    const source = await trx('email_templates').where({ template_key: SOURCE_KEY }).forUpdate().first();
    if (!source || !source.active_version_id) return;
    const version = await trx('email_template_versions').where({ id: source.active_version_id }).first();
    if (!version) return;
    const blocks = rainReportBlocks(version.blocks);
    if (!blocks.length) return;

    const now = new Date();
    const [template] = await trx('email_templates').insert({
      template_key: TARGET_KEY,
      name: 'Irrigation Weekly — Rain Report (No Ask)',
      description: 'Weekly rainfall check-in for a recurring lawn customer with no usable watering schedule, on a week when the setup ask is held back (GATE_IRRIGATION_SETUP_ASK_CADENCE: ask on the first 3 setup emails, then once every 4 weeks). Same rain and seasonal target as the setup emails, with no callout and no button.',
      mode: source.mode,
      purpose: source.purpose,
      legal_classification: source.legal_classification,
      audience: source.audience,
      message_priority: source.message_priority,
      content_sensitivity: source.content_sensitivity,
      send_stream: source.send_stream,
      suppression_group_key: source.suppression_group_key,
      layout_wrapper_id: source.layout_wrapper_id,
      from_name: source.from_name,
      from_email: source.from_email,
      reply_to: source.reply_to,
      default_cta_label: null,
      default_cta_url_variable: null,
      allowed_variables: asJson(source.allowed_variables),
      required_variables: asJson(source.required_variables),
      optional_variables: asJson(source.optional_variables),
      status: 'active',
      created_at: now,
      updated_at: now,
    }).returning('*');

    const [created] = await trx('email_template_versions').insert({
      template_id: template.id,
      version_number: 1,
      status: 'active',
      subject: version.subject,
      preview_text: version.preview_text || null,
      blocks: JSON.stringify(blocks),
      text_body: null,
      published_at: now,
      created_at: now,
      updated_at: now,
    }).returning('*');

    await trx('email_templates').where({ id: template.id }).update({
      active_version_id: created.id,
      last_published_at: now,
      updated_at: now,
    });

    // The editor's preview reuses the source's default fixture.
    if (await trx.schema.hasTable('email_template_fixtures')) {
      const fixture = await trx('email_template_fixtures').where({ template_id: source.id, is_default: true }).first();
      if (fixture) {
        await trx('email_template_fixtures').insert({
          template_id: template.id, name: fixture.name, payload: asJson(fixture.payload), is_default: true,
          created_at: now, updated_at: now,
        });
      }
    }
  });
};

exports.down = async function down() {
  // No-op on purpose (see the header): rollback must not delete admin-owned content.
};

exports.__private = { SOURCE_KEY, TARGET_KEY, rainReportBlocks };
