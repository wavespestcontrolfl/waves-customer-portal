/**
 * Add the measured-rainfall attribution line to every irrigation weekly email.
 *
 * GATE_RAIN_MRMS went live 2026-08-01, so the rainfall these emails quote can
 * now be NOAA gauge-corrected radar rather than a model estimate. Two things
 * follow: the customer should be told where the number came from, and they
 * should be told it can differ from their own yard.
 *
 * Measured 2026-08-01 across one SWFL service week: MRMS 3.23", Open-Meteo
 * 1.15", and a volunteer rain gauge a few miles away 1.38". Radar resolves
 * rain at the property far better than a city cell, but a summer cell really
 * can drop an inch more on one yard than the next — "local totals may vary" is
 * a statement of fact here, not legal boilerplate.
 *
 * Conditional by design: `rain_source_note` is OPTIONAL and the sender fills it
 * only when the week's figure is actually MRMS-derived (see rainSourceNote in
 * irrigation-weekly-email.js). On a pure Open-Meteo week it renders as an empty
 * paragraph, exactly like forecast_line — the note must never claim radar
 * provenance for a model number.
 *
 * Touches all six irrigation templates (3 advice + 2 setup + 1 confirm) by
 * appending the variable to allowed/optional and inserting one paragraph block
 * before the footer note. Idempotent: skips a template that already has it.
 */

const TEMPLATE_KEYS = [
  'irrigation.weekly_on_track',
  'irrigation.weekly_cut_back',
  'irrigation.weekly_add_water',
  'irrigation.weekly_setup_schedule',
  'irrigation.weekly_setup_system',
  'irrigation.weekly_confirm_schedule',
];

const VARIABLE = 'rain_source_note';
const BLOCK = { type: 'paragraph', content: '{{rain_source_note}}' };

const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  for (const key of TEMPLATE_KEYS) {
    const tpl = await knex('email_templates').where({ template_key: key }).first();
    if (!tpl) continue;

    const allowed = asArray(tpl.allowed_variables);
    const optional = asArray(tpl.optional_variables);
    if (!allowed.includes(VARIABLE)) {
      await knex('email_templates').where({ id: tpl.id }).update({
        allowed_variables: JSON.stringify([...allowed, VARIABLE]),
        optional_variables: JSON.stringify([...optional, VARIABLE]),
        updated_at: new Date(),
      });
    }

    if (!tpl.active_version_id) continue;
    const version = await knex('email_template_versions').where({ id: tpl.active_version_id }).first();
    if (!version) continue;

    const blocks = asArray(version.blocks);
    if (!blocks.length) continue;
    // Already present (re-run, or a template seeded with it) → leave alone.
    if (JSON.stringify(blocks).includes(VARIABLE)) continue;

    // Insert immediately BEFORE the small_note footer so the attribution reads
    // as part of the explanation rather than after the sign-off; fall back to
    // just before the signature, then to the end.
    let at = blocks.findIndex((b) => b && b.type === 'small_note');
    if (at < 0) at = blocks.findIndex((b) => b && b.type === 'signature');
    if (at < 0) at = blocks.length;
    const next = [...blocks.slice(0, at), BLOCK, ...blocks.slice(at)];

    // PUBLISH A NEW VERSION rather than editing the active row in place
    // (codex #3153 P1). email_template_versions is an append-only history —
    // rewriting the live row erases what was actually sent to customers before
    // today and leaves no way to roll a bad edit back to the previous copy.
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
      // A staff-authored text body wins over the block-derived text at render
      // time and is variable-substituted, so the attribution has to be
      // appended there as well or text-part recipients get the rainfall
      // number with no provenance (codex #3156 r1). Empty stays empty — the
      // block-derived text already carries the new paragraph.
      text_body: version.text_body
        ? `${String(version.text_body).replace(/\s+$/, '')}\n\n{{${VARIABLE}}}`
        : null,
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('*');

    // Retire the previous active row so two versions never both read 'active'.
    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'archived', updated_at: new Date(),
    });
    await knex('email_templates').where({ id: tpl.id }).update({
      active_version_id: published.id,
      last_published_at: new Date(),
      updated_at: new Date(),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  for (const key of TEMPLATE_KEYS) {
    const tpl = await knex('email_templates').where({ template_key: key }).first();
    if (!tpl) continue;

    await knex('email_templates').where({ id: tpl.id }).update({
      allowed_variables: JSON.stringify(asArray(tpl.allowed_variables).filter((v) => v !== VARIABLE)),
      optional_variables: JSON.stringify(asArray(tpl.optional_variables).filter((v) => v !== VARIABLE)),
      updated_at: new Date(),
    });

    // ROLLBACK IS DELIBERATELY CONSERVATIVE (codex #3156 r1-r3).
    //
    // Two goals conflict once anyone else touches the template: remove the
    // note, and don't destroy newer copy. Earlier attempts traded one failure
    // for the other — picking the numeric predecessor could reactivate a
    // version that still had the note, and picking the newest note-free
    // version could throw away an administrator's later edit (or, before the
    // previous fix, publish an unapproved draft).
    //
    // So this only undoes the case it actually created: the active version is
    // the one this migration published (it carries the note AND nothing has
    // been published on top of it), and its immediate predecessor is a
    // published, note-free row. Anything else means a human has moved the
    // template on since, and a rollback has no business overwriting them —
    // skip it and leave the note in place for them to remove deliberately.
    if (!tpl.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: tpl.active_version_id }).first();
    if (!current) continue;

    const all = await knex('email_template_versions')
      .where({ template_id: tpl.id })
      .orderBy('version_number', 'desc');

    const currentCarriesNote = JSON.stringify(asArray(current.blocks)).includes(VARIABLE)
      || String(current.text_body || '').includes(VARIABLE);
    const isNewest = !all.some((v) => Number(v.version_number) > Number(current.version_number));
    if (!currentCarriesNote || !isNewest) continue;

    // Identify OUR version structurally: stripping the note must reproduce the
    // predecessor EXACTLY. If an administrator changed anything else — even
    // while inheriting the note paragraph — the comparison fails and we leave
    // their copy alone. `isNewest` alone can't tell the two apart, since their
    // version also carries the note and also sits on top.
    const stripNote = (blocks) => asArray(blocks)
      .filter((b) => !(b && b.type === 'paragraph' && String(b.content || '').includes(VARIABLE)));
    const stripNoteText = (text) => String(text || '').replace(`{{${VARIABLE}}}`, '').replace(/\s+$/, '');
    const currentStripped = JSON.stringify(stripNote(current.blocks));
    const currentText = stripNoteText(current.text_body);

    const previous = all.find((v) => Number(v.version_number) < Number(current.version_number)
      && v.status !== 'draft'
      && v.published_at != null
      && !JSON.stringify(asArray(v.blocks)).includes(VARIABLE)
      && !String(v.text_body || '').includes(VARIABLE)
      && JSON.stringify(asArray(v.blocks)) === currentStripped
      && String(v.text_body || '').replace(/\s+$/, '') === currentText);
    if (!previous) continue;

    await knex('email_template_versions').where({ id: previous.id }).update({
      status: 'active', updated_at: new Date(),
    });
    await knex('email_template_versions').where({ id: current.id }).update({
      status: 'archived', updated_at: new Date(),
    });
    await knex('email_templates').where({ id: tpl.id }).update({
      active_version_id: previous.id, last_published_at: new Date(), updated_at: new Date(),
    });
  }
};

exports.__private = { TEMPLATE_KEYS, VARIABLE, BLOCK };
