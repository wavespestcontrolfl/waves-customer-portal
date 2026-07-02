'use strict';

/**
 * Add a "Reschedule appointment" CTA to the appointment confirmation / 72h /
 * 24h reminder emails, driven by the new reschedule_url payload variable
 * (the /reschedule/:token self-serve link the senders now mint).
 *
 * Read-modify-write throughout (admin-edit preserving, per the DB rules):
 *   - email_templates: 'reschedule_url' is appended to allowed/optional
 *     variables — required for renderBlocks' allowlist validation.
 *   - active email_template_versions row: the CTA block is inserted before
 *     the existing "View appointment" CTA only when no block already
 *     references reschedule_url; admin-reordered/edited blocks are kept.
 *   - default fixture payload gains a sample URL for the admin preview.
 *
 * renderBlocks skips a cta whose href resolves empty, so templates updated
 * here render identically for sends that carry no reschedule_url.
 */

const TEMPLATE_KEYS = [
  'appointment.confirmation',
  'appointment.reminder_72h',
  'appointment.reminder_24h',
];

const RESCHEDULE_CTA = {
  type: 'cta',
  label: 'Reschedule appointment',
  url_variable: 'reschedule_url',
};

const FIXTURE_SAMPLE_URL = 'https://portal.wavespestcontrol.com/l/r3sch';

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

function withVariable(list, variable) {
  const arr = asArray(list);
  return arr.includes(variable) ? arr : [...arr, variable];
}

function referencesRescheduleUrl(blocks) {
  return asArray(blocks).some((b) => b && (
    b.url_variable === 'reschedule_url'
    || /\{\{\s*reschedule_url\s*\}\}/.test(String(b.content || ''))
  ));
}

function insertRescheduleCta(blocks) {
  const arr = asArray(blocks);
  const ctaIdx = arr.findIndex((b) => b && b.type === 'cta');
  const sigIdx = arr.findIndex((b) => b && b.type === 'signature');
  const idx = ctaIdx !== -1 ? ctaIdx : (sigIdx !== -1 ? sigIdx : arr.length);
  return [...arr.slice(0, idx), { ...RESCHEDULE_CTA }, ...arr.slice(idx)];
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  const now = new Date();

  for (const key of TEMPLATE_KEYS) {
    const template = await knex('email_templates').where({ template_key: key }).first();
    if (!template) continue;

    await knex('email_templates').where({ id: template.id }).update({
      allowed_variables: JSON.stringify(withVariable(template.allowed_variables, 'reschedule_url')),
      optional_variables: JSON.stringify(withVariable(template.optional_variables, 'reschedule_url')),
      updated_at: now,
    });

    if (template.active_version_id) {
      const version = await knex('email_template_versions')
        .where({ id: template.active_version_id })
        .first();
      if (version && !referencesRescheduleUrl(version.blocks)) {
        await knex('email_template_versions').where({ id: version.id }).update({
          blocks: JSON.stringify(insertRescheduleCta(version.blocks)),
          updated_at: now,
        });
      }
    }

    if (await knex.schema.hasTable('email_template_fixtures')) {
      const fixture = await knex('email_template_fixtures')
        .where({ template_id: template.id, is_default: true })
        .first();
      if (fixture) {
        let payload = fixture.payload;
        if (typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch { payload = null; }
        }
        if (payload && typeof payload === 'object' && !payload.reschedule_url) {
          await knex('email_template_fixtures').where({ id: fixture.id }).update({
            payload: JSON.stringify({ ...payload, reschedule_url: FIXTURE_SAMPLE_URL }),
            updated_at: now,
          });
        }
      }
    }
  }
};

exports.down = async function down(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  const now = new Date();

  for (const key of TEMPLATE_KEYS) {
    const template = await knex('email_templates').where({ template_key: key }).first();
    if (!template) continue;

    await knex('email_templates').where({ id: template.id }).update({
      allowed_variables: JSON.stringify(asArray(template.allowed_variables).filter((v) => v !== 'reschedule_url')),
      optional_variables: JSON.stringify(asArray(template.optional_variables).filter((v) => v !== 'reschedule_url')),
      updated_at: now,
    });

    if (template.active_version_id) {
      const version = await knex('email_template_versions')
        .where({ id: template.active_version_id })
        .first();
      if (version) {
        const blocks = asArray(version.blocks)
          .filter((b) => !(b && b.type === 'cta' && b.url_variable === 'reschedule_url'));
        await knex('email_template_versions').where({ id: version.id }).update({
          blocks: JSON.stringify(blocks),
          updated_at: now,
        });
      }
    }
  }
};

exports.__private = { insertRescheduleCta, referencesRescheduleUrl, withVariable };
