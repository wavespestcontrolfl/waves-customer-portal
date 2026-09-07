// Publish the approved resource section without replacing staff-authored copy
// or rewriting the versions referenced by already-sent emails.
const { BLOCK: LEGACY_LINKS, TEMPLATE_KEYS: LEGACY_KEYS } = require('./20260803000000_irrigation_blog_links').__private;

const TEMPLATE_KEYS = [...LEGACY_KEYS, 'irrigation.weekly_plan'];
const HEADING = 'Helpful guides from the Waves blog';
const GUIDES = [
  { label: 'Find your sprinkler timer and its guide', url: 'https://www.wavespestcontrol.com/sprinkler-timers/' },
  { label: 'Rain Bird: how to run your timer by hand', url: 'https://www.wavespestcontrol.com/lawn-care/rain-bird-sprinkler-timer-guide/' },
  { label: 'Overwatering vs. underwatering', url: 'https://www.wavespestcontrol.com/lawn-care/overwatering-lawn-vs-underwatering/' },
  { label: 'Mowing height for your grass type', url: 'https://www.wavespestcontrol.com/lawn-care/mowing-height-by-grass-type/' },
];
const OLD_OPT_OUT = "Turn off Seasonal Lawn Tips under Notification Preferences in your portal, or just reply and we'll take care of it.";
const NEW_OPT_OUT = "Just reply to this email and we'll take care of it.";
const OLD_TARGET = 'What your {{grass_label}} needs right now';
const NEW_TARGET = 'Weekly target for {{grass_label}}';

function rewriteCopy(text) {
  return text.replace(OLD_OPT_OUT, NEW_OPT_OUT).replace(OLD_TARGET, NEW_TARGET);
}

function updatedBlocks(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || !parsed.length) return null;
  // Only the exact historical seed is replaced. A staff-written link or note
  // stays as authored, and its existing destinations are not added twice.
  const blocks = JSON.parse(rewriteCopy(JSON.stringify(parsed)))
    .filter((block) => !(block?.type === LEGACY_LINKS.type && block.content === LEGACY_LINKS.content));
  const existing = JSON.stringify(blocks);
  const missing = GUIDES.filter(({ url }) => !existing.includes(url));
  if (missing.length) {
    const cta = blocks.findIndex((block) => block?.type === 'cta');
    const footer = blocks.findIndex((block) => ['small_note', 'signature'].includes(block?.type));
    const at = cta >= 0 ? cta + 1 : (footer >= 0 ? footer : blocks.length);
    blocks.splice(at, 0,
      ...(!blocks.some((block) => block?.type === 'heading' && block.content === HEADING)
        ? [{ type: 'heading', content: HEADING }] : []),
      ...missing.map(({ label, url }) => ({ type: 'paragraph', content: `[${label}](${url})` })),
    );
  }
  return blocks;
}

function updatedText(value) {
  if (!value) return value;
  const text = rewriteCopy(String(value)).replace(LEGACY_LINKS.content, '').trimEnd();
  const missing = GUIDES.filter(({ url }) => !text.includes(url));
  if (!missing.length) return text;
  const heading = text.includes(HEADING.toUpperCase()) ? '' : `${HEADING.toUpperCase()}\n\n`;
  return `${text}\n\n${heading}${missing.map(({ label, url }) => `${label} (${url})`).join('\n\n')}`;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_versions'))) return;
  const auditExists = await knex.schema.hasTable('audit_log');
  for (const templateKey of TEMPLATE_KEYS) {
    await knex.transaction(async (trx) => {
      const template = await trx('email_templates').where({ template_key: templateKey }).first();
      if (!template?.active_version_id) return;
      const version = await trx('email_template_versions').where({ id: template.active_version_id }).first();
      if (!version) return;
      const blocks = updatedBlocks(version.blocks);
      if (!blocks) return;
      const textBody = updatedText(version.text_body);
      const previousBlocks = typeof version.blocks === 'string' ? JSON.parse(version.blocks) : version.blocks;
      if (JSON.stringify(blocks) === JSON.stringify(previousBlocks) && textBody === version.text_body) return;

      const latest = await trx('email_template_versions').where({ template_id: template.id })
        .max('version_number as max').first();
      const now = new Date();
      const [published] = await trx('email_template_versions').insert({
        template_id: template.id,
        version_number: Number(latest?.max || 0) + 1,
        status: 'active',
        subject: version.subject,
        preview_text: version.preview_text,
        blocks: JSON.stringify(blocks),
        text_body: textBody,
        validation_snapshot: version.validation_snapshot,
        published_at: now,
      }).returning('id');
      await trx('email_template_versions').where({ id: version.id }).update({ status: 'archived', updated_at: now });
      const changed = await trx('email_templates')
        .where({ id: template.id, active_version_id: version.id })
        .update({ active_version_id: published.id, last_published_at: now, updated_at: now });
      if (changed !== 1) throw new Error(`Irrigation template changed during publication: ${templateKey}`);
      if (auditExists) {
        await require('../../services/audit-log').recordAuditEvent({
          actor_type: 'system', action: 'email_template.published', resource_type: 'email_template',
          resource_id: template.id,
          metadata: { templateKey, previousVersionId: version.id, versionId: published.id, migration: '20260907000010_irrigation_guide_resources' },
          trx, critical: true,
        });
      }
    });
  }
};

exports.down = async function down() {
  // Intentional no-op: preserve administrator edits and append-only history.
  // A previous version can be republished through the template library.
};

exports.__private = { TEMPLATE_KEYS, HEADING, GUIDES, updatedBlocks, updatedText };
