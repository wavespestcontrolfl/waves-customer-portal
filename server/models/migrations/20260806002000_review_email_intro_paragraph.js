/**
 * Make the review-cadence email's opening paragraph payload-driven
 * ({{intro_paragraph}}) so the personalized drafter (GATE_REVIEW_ASK_PERSONALIZED,
 * owner spec 2026-08-05) can slot a grounded opener above the CTA while the
 * generic copy stays the fallback — ReviewService._sendOutreachEmail always
 * supplies intro_paragraph (drafted || canonical generic copy).
 *
 * Read-modify-write, never wholesale: only the one matching paragraph block
 * is rewritten (exact seeded copy first, else the first paragraph block);
 * every other block — including any operator edits — is preserved. Idempotent:
 * a version already carrying {{intro_paragraph}} is left untouched.
 */

const TEMPLATE_KEY = 'review_request_email';
const SEEDED_INTRO = "We're a small, family-owned pest and lawn company here in Southwest Florida, and word of mouth is how neighbors find us. If your recent service hit the mark, would you take 15 seconds to share a quick review?";
const VARIABLE_PARAGRAPH = '{{intro_paragraph}}';

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function loadActiveVersion(knex) {
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template?.active_version_id) return { template: template || null, version: null };
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  return { template, version };
}

async function swapIntroParagraph(knex, fromContent, toContent, { addVariable }) {
  const { template, version } = await loadActiveVersion(knex);
  if (!template || !version) return;

  const blocks = parseJson(version.blocks, []);
  if (!Array.isArray(blocks) || blocks.length === 0) return;

  if (!blocks.some((b) => String(b?.content || '').includes(toContent))) {
    let target = blocks.findIndex((b) => b?.type === 'paragraph' && String(b.content || '').trim() === fromContent);
    if (target === -1) target = blocks.findIndex((b) => b?.type === 'paragraph');
    if (target === -1) return;
    blocks[target] = { ...blocks[target], content: toContent };
    await knex('email_template_versions').where({ id: version.id }).update({
      blocks: JSON.stringify(blocks),
      updated_at: new Date(),
    });
  }

  const allowed = parseJson(template.allowed_variables, []);
  const optional = parseJson(template.optional_variables, []);
  const has = (arr) => Array.isArray(arr) && arr.includes('intro_paragraph');
  const nextAllowed = addVariable
    ? (has(allowed) ? allowed : [...allowed, 'intro_paragraph'])
    : (Array.isArray(allowed) ? allowed.filter((v) => v !== 'intro_paragraph') : allowed);
  const nextOptional = addVariable
    ? (has(optional) ? optional : [...optional, 'intro_paragraph'])
    : (Array.isArray(optional) ? optional.filter((v) => v !== 'intro_paragraph') : optional);
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: JSON.stringify(nextAllowed),
    optional_variables: JSON.stringify(nextOptional),
    updated_at: new Date(),
  });

  // Keep the default preview fixture rendering a realistic email.
  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();
    if (fixture) {
      const payload = parseJson(fixture.payload, {});
      if (addVariable) payload.intro_paragraph = SEEDED_INTRO;
      else delete payload.intro_paragraph;
      await knex('email_template_fixtures').where({ id: fixture.id }).update({
        payload: JSON.stringify(payload),
        updated_at: new Date(),
      });
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_versions'))) return;
  await swapIntroParagraph(knex, SEEDED_INTRO, VARIABLE_PARAGRAPH, { addVariable: true });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_versions'))) return;
  await swapIntroParagraph(knex, VARIABLE_PARAGRAPH, SEEDED_INTRO, { addVariable: false });
};
