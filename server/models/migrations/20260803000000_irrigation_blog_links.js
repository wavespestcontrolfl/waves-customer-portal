/**
 * Add the two UF/IFAS-cited background links to every irrigation weekly email.
 *
 * The email tells the customer how much rain fell and what their grass needs.
 * These two posts explain WHY that matters — the agronomy of over- and
 * underwatering, and mowing height by grass type — both citing UF/IFAS EDIS
 * publications (ENH9/LH025, ENH10/LH028, ENH5/LH010).
 *
 * Rendered as an inline markdown link in a small_note, not as cta blocks: a cta
 * renders as a full-width gold bar, and three stacked gold bars in one email
 * would bury the primary action (update your watering schedule / confirm it).
 *
 * Follows the same publish-a-new-version discipline as the rain_source_note
 * migration — email_template_versions is append-only history, so overwriting
 * the active row would erase the copy customers were already sent and remove
 * the rollback target. Idempotent: a template that already carries the link is
 * skipped.
 */

const TEMPLATE_KEYS = [
  'irrigation.weekly_on_track',
  'irrigation.weekly_cut_back',
  'irrigation.weekly_add_water',
  'irrigation.weekly_setup_schedule',
  'irrigation.weekly_setup_system',
  'irrigation.weekly_confirm_schedule',
];

const HUB = 'https://www.wavespestcontrol.com';
const WATERING_URL = `${HUB}/lawn-care/overwatering-lawn-vs-underwatering/`;
const MOWING_URL = `${HUB}/lawn-care/mowing-height-by-grass-type/`;

// Identity is the block's EXACT content, never a separately-maintained
// substring. An earlier version kept a MARKER slug constant here; when the
// post was renamed, WATERING_URL moved and MARKER did not, so the idempotency
// guard silently stopped matching and a second `up()` inserted the note twice.
// One source of truth removes that whole class of drift.
const BLOCK = {
  type: 'small_note',
  content: `Want the detail? [What overwatering and underwatering actually do to a Southwest Florida lawn](${WATERING_URL}) — and [the right mowing height for your grass type](${MOWING_URL}). Both cite University of Florida turf research.`,
};

const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  for (const key of TEMPLATE_KEYS) {
    const tpl = await knex('email_templates').where({ template_key: key }).first();
    if (!tpl || !tpl.active_version_id) continue;
    const version = await knex('email_template_versions').where({ id: tpl.active_version_id }).first();
    if (!version) continue;

    const blocks = asArray(version.blocks);
    if (!blocks.length) continue;
    // Already linked — compare against the exact block we would insert.
    if (blocks.some((b) => b && b.type === BLOCK.type && b.content === BLOCK.content)) continue;

    // Sit ABOVE the standing footer note (the unsubscribe/restrictions small
    // print), so the reading suggestion reads as content rather than legal tail.
    let at = blocks.findIndex((b) => b && b.type === 'small_note');
    if (at < 0) at = blocks.findIndex((b) => b && b.type === 'signature');
    if (at < 0) at = blocks.length;
    const next = [...blocks.slice(0, at), BLOCK, ...blocks.slice(at)];

    const latest = await knex('email_template_versions')
      .where({ template_id: tpl.id })
      .max('version_number as max')
      .first();
    const [published] = await knex('email_template_versions').insert({
      template_id: tpl.id,
      version_number: Number(latest?.max || 0) + 1,
      status: 'active',
      subject: version.subject,
      preview_text: version.preview_text,
      blocks: JSON.stringify(next),
      // A staff-authored text body wins over block-derived text at render time,
      // so the links have to be appended there as well or text-part readers
      // never see them.
      text_body: version.text_body
        ? `${String(version.text_body).replace(/\s+$/, '')}\n\n${BLOCK.content}`
        : null,
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('*');

    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'archived', updated_at: new Date(),
    });
    await knex('email_templates').where({ id: tpl.id }).update({
      active_version_id: published.id, last_published_at: new Date(), updated_at: new Date(),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  // Same conservative rule as the rain_source_note rollback: undo only the
  // version this migration published, identified structurally — it carries the
  // link, nothing has been published on top of it, and stripping the block
  // reproduces its published predecessor exactly. Anything else means a human
  // has edited since, and the rollback declines.
  for (const key of TEMPLATE_KEYS) {
    const tpl = await knex('email_templates').where({ template_key: key }).first();
    if (!tpl || !tpl.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: tpl.active_version_id }).first();
    if (!current) continue;

    const all = await knex('email_template_versions')
      .where({ template_id: tpl.id })
      .orderBy('version_number', 'desc');

    // EXACT-CONTENT identity, not "contains the marker URL" (codex #3169 P1).
    // A staff edit that reworded the link block while keeping the URL would
    // still strip back to the pre-migration blocks and be mistaken for this
    // migration's own insertion — archiving their work. Requiring the block to
    // match byte-for-byte means any edit at all makes the rollback decline.
    const ourBlock = (v) => asArray(v.blocks)
      .filter((b) => b && b.type === BLOCK.type && b.content === BLOCK.content);
    const carries = (v) => ourBlock(v).length === 1
      || String(v.text_body || '').includes(BLOCK.content);
    const isNewest = !all.some((v) => Number(v.version_number) > Number(current.version_number));
    if (!carries(current) || !isNewest) continue;

    const stripped = JSON.stringify(asArray(current.blocks)
      .filter((b) => !(b && b.type === BLOCK.type && b.content === BLOCK.content)));
    const trim = (t) => String(t || '').replace(/\s+$/, '');
    const currentText = trim(String(current.text_body || '').replace(BLOCK.content, ''));

    const previous = all.find((v) => Number(v.version_number) < Number(current.version_number)
      && v.status !== 'draft'
      && v.published_at != null
      && !carries(v)
      && JSON.stringify(asArray(v.blocks)) === stripped
      && trim(v.text_body) === currentText
      && (v.subject || null) === (current.subject || null)
      && (v.preview_text || null) === (current.preview_text || null));
    if (!previous) continue;

    await knex('email_template_versions').where({ id: previous.id }).update({ status: 'active', updated_at: new Date() });
    await knex('email_template_versions').where({ id: current.id }).update({ status: 'archived', updated_at: new Date() });
    await knex('email_templates').where({ id: tpl.id }).update({
      active_version_id: previous.id, last_published_at: new Date(), updated_at: new Date(),
    });
  }
};

exports.__private = { TEMPLATE_KEYS, BLOCK, WATERING_URL, MOWING_URL };
