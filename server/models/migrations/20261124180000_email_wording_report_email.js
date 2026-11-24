'use strict';

/**
 * EMAIL WORDING, PART 2: THE SERVICE REPORT EMAIL (owner 2026-11-24, "ok do whatever you rec" =
 * changes 1 2 3; plan page NWMRcRWj, change 1). Approved copy, no gate. Data only, no schema.
 *
 * Part 1 (20261124170200, PR #8478) added {{visit_done_line}} to the report payload
 * (service-report/email-delivery.js visitDoneLine: "Jose finished your Quarterly Pest Control
 * Service on Tuesday, December 2."; "We ..." with no technician; "stopped by for" when the visit
 * was inspection-only, declined or incomplete). This publishes the template that reads it, so it
 * ships only after a deploy carrying part 1 is live (Railway runs migrations before new code).
 *
 * service.report_ready:
 *   subject  "Your Waves {{service_label}} report is ready"
 *         -> "Your {{service_label}} report: what we did and what we found"
 *   preview  "Review your completed service summary, ..."
 *         -> "{{visit_done_line}} What we did, what we found, and any re-entry time."
 *   opening  "Hi {{first_name}}, your {{service_label}} report is ready."
 *         -> "Hi {{first_name}}, {{visit_done_line}}"
 *   the "{{technician_name}} completed the visit. The secure report includes ..." paragraph goes;
 *   the button "View full report" -> "See my full report"; one paragraph under the guide link:
 *   "See something between visits? Reply here and tell us what you saw."
 *
 * Mechanics as 20261124170200: template row locked, every anchor block matched exactly (all keys),
 * subject and preview matched exactly, ONE new active version by compare-and-swap on the active
 * version, only the replaced version archived. visit_done_line joins allowed + optional variables;
 * the preview fixtures (rows locked) gain a sample line built from their own technician, service
 * and date, where they lack the key.
 *
 * down: a no-op. To go back, republish the prior version from the template library.
 */

const MIGRATION = '20261124180000';
const MARKER = `migration:${MIGRATION}`;
const KEY = 'service.report_ready';

// A block anchors a move only when it is exactly the seeded block (every key and value), so a
// block an administrator relabeled or reworded leaves the whole template as it is.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
const sameBlock = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const indexOfBlock = (blocks, seeded) => blocks.findIndex((b) => sameBlock(b, seeded));

const REPORT = {
  subject: ['Your Waves {{service_label}} report is ready', 'Your {{service_label}} report: what we did and what we found'],
  preview: [
    'Review your completed service summary, findings, recommendations, and advisories.',
    '{{visit_done_line}} What we did, what we found, and any re-entry time.',
  ],
  open: { type: 'paragraph', content: 'Hi {{first_name}}, your {{service_label}} report is ready.' },
  openAfter: 'Hi {{first_name}}, {{visit_done_line}}',
  includes: {
    type: 'paragraph',
    content: '{{technician_name}} completed the visit. The secure report includes the service summary, photos when available, findings, recommendations, and any customer advisories.',
  },
  cta: { type: 'cta', label: 'View full report', url_variable: 'report_url' },
  ctaAfter: 'See my full report',
  guide: { type: 'cta', label: 'How to read your report', variant: 'link', url_variable: 'first_report_guide_url' },
  replyLine: 'See something between visits? Reply here and tell us what you saw.',
  variable: 'visit_done_line',
};

// A preview fixture's sample line, built from that fixture's own visit details by the same
// function the sender uses, so a lawn fixture's opening names its lawn visit.
function fixtureLine(payload) {
  const { visitDoneLine } = require('../../services/service-report/email-delivery');
  return visitDoneLine({
    technicianName: payload.technician_name,
    serviceLabel: payload.service_label,
    serviceDate: payload.service_date,
    visitOutcome: payload.visit_outcome,
  });
}

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

const unique = (list) => [...new Set(list)];

// Pure: { outcome: 'changed' | 'already' | 'skipped', blocks?, subject?, preview_text?, note? }.
function planVersion(prior) {
  const blocks = json(prior.blocks, null);
  if (!Array.isArray(blocks)) return { outcome: 'skipped', note: 'active blocks unreadable' };
  if (JSON.stringify(blocks).includes(`{{${REPORT.variable}}}`)) return { outcome: 'already' };
  const open = indexOfBlock(blocks, REPORT.open);
  const includes = indexOfBlock(blocks, REPORT.includes);
  const cta = indexOfBlock(blocks, REPORT.cta);
  const guide = indexOfBlock(blocks, REPORT.guide);
  if (open < 0 || includes < 0 || cta < 0 || guide < 0) {
    return { outcome: 'skipped', note: 'opening, "secure report includes" line, report button or guide link not as seeded' };
  }
  if (prior.subject !== REPORT.subject[0]) return { outcome: 'skipped', note: 'subject edited since seeding' };
  if (prior.preview_text !== REPORT.preview[0]) return { outcome: 'skipped', note: 'preview edited since seeding' };
  if (prior.text_body != null && String(prior.text_body).trim()) return { outcome: 'skipped', note: 'custom plain-text body present' };
  const out = [];
  blocks.forEach((b, i) => {
    if (i === includes) return;
    if (i === open) out.push({ ...b, content: REPORT.openAfter });
    else if (i === cta) out.push({ ...b, label: REPORT.ctaAfter });
    else out.push(b);
    if (i === guide) out.push({ type: 'paragraph', content: REPORT.replyLine });
  });
  return { outcome: 'changed', blocks: out, subject: REPORT.subject[1], preview_text: REPORT.preview[1] };
}

// Locked: the fixture editor saves the whole payload, so an unlocked read could drop its edit.
// A fixture that already has the key keeps its value.
async function addFixtureSample(knex, templateId) {
  if (!(await knex.schema.hasTable('email_template_fixtures'))) return;
  const rows = await knex('email_template_fixtures').where({ template_id: templateId }).forUpdate();
  for (const f of rows) {
    const payload = json(f.payload, {});
    if (payload[REPORT.variable] !== undefined) continue;
    await knex('email_template_fixtures').where({ id: f.id })
      .update({ payload: JSON.stringify({ ...payload, [REPORT.variable]: fixtureLine(payload) }), updated_at: new Date() });
  }
}

async function publish(knex) {
  const template = await knex('email_templates').where({ template_key: KEY }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';

  const next = planVersion(prior);
  if (next.outcome !== 'changed') {
    if (next.outcome === 'skipped') console.warn(`[${MARKER}] ${KEY}: ${next.note}; template left as-is`);
    return next.outcome;
  }

  const required = json(template.required_variables, []);
  const allowed = unique([...json(template.allowed_variables, []), REPORT.variable]);
  const optional = required.includes(REPORT.variable)
    ? json(template.optional_variables, [])
    : unique([...json(template.optional_variables, []), REPORT.variable]);
  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor({ ...template, allowed_variables: allowed }, { ...prior, ...next });
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${KEY}: new version failed variable validation (${JSON.stringify(validation)}); template left as-is`);
    return 'skipped';
  }

  const now = new Date();
  const latest = await knex('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
  // No savepoint or 23505 catch: the admin draft editor (createDraftVersion) takes the same
  // email_templates row lock before it numbers a version, so a clash here is unexpected and must
  // fail the migration rather than mark it run with the old wording still active.
  const [created] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: next.subject,
    preview_text: next.preview_text,
    blocks: JSON.stringify(next.blocks),
    text_body: prior.text_body ?? null,
    validation_snapshot: JSON.stringify({ ...validation, source: MARKER, supersedes_version: prior.version_number }),
    published_at: now,
  }).returning('*');
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({
      active_version_id: created.id,
      allowed_variables: JSON.stringify(allowed),
      optional_variables: JSON.stringify(optional),
      last_published_at: now,
      updated_at: now,
    });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  await knex('email_template_versions').where({ id: prior.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  await addFixtureSample(knex, template.id);
  return 'published';
}

async function run(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const result = await publish(trx);
    console.log(`[${MARKER}] ${KEY}: ${result}`);
    if (await trx.schema.hasTable('audit_log')) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system',
        action: `${MARKER}:publish`,
        resource_type: 'email_template',
        resource_id: null,
        metadata: { results: { [KEY]: result } },
        critical: true,
        trx,
      });
    }
  });
}

exports.up = (knex) => run(knex);

exports.down = async function down() {
  // Intentionally no-op: a revert by content could erase an administrator's edit (see the header).
};

exports._private = { REPORT, planVersion, fixtureLine };
