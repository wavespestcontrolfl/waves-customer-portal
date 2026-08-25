/**
 * Per-customer schedule copy in two irrigation weekly emails.
 *
 * setup_schedule — the static callout said "we have a sprinkler system on
 * file for you, but not how much you run it". A customer with days, zones
 * and per-zone minutes all on file read that as "you lost my schedule"
 * (reply 2026-08-17). The callout becomes {{schedule_ask}}: the sender
 * names exactly what is on file and the ONE thing still missing.
 *
 * confirm_schedule — the static callout said the schedule "came from our
 * records rather than from you". That is right for a technician-recorded
 * reading and wrong for a figure DERIVED from the customer's own portal
 * entries (minutes × days × head type). The callout becomes
 * {{schedule_note}}: the sender says where the number came from.
 *
 * Both variables are OPTIONAL on the template (allowed + optional, not
 * required): the migration runs pre-deploy while the previous app version
 * is still serving, and a required variable the old sender does not supply
 * would fail every send closed in that window. An empty optional block is
 * dropped by renderBlocks, so the worst case in the window is a check-in
 * without the callout — never a rejected send.
 *
 * Publish-a-new-version discipline (20260803000000 precedent): versions are
 * append-only history; the active row is archived, not overwritten.
 * Idempotent via EXACT block content; a staff-edited callout is left alone.
 */

const TARGETS = [
  {
    key: 'irrigation.weekly_setup_schedule',
    variable: 'schedule_ask',
    // The seeded callout this migration replaces — exact content identity.
    seededCallout: "We have a sprinkler system on file for you, but not how much you run it. Add your weekly watering schedule in the portal and these check-ins become real recommendations — ease back this week, add a few minutes, or you're right on track.",
    fixtureValue: "We have your sprinkler system on file — 4 watering days and spray heads — but not how many minutes each zone runs. Add that under Irrigation in your portal (or your weekly inches, if you know them) and these check-ins become real recommendations — ease back this week, add a few minutes, or you're right on track.",
  },
  {
    key: 'irrigation.weekly_confirm_schedule',
    variable: 'schedule_note',
    seededCallout: "That schedule came from our records rather than from you, so it may be out of date. If it looks right, you're all set — we'll keep checking the numbers every week. If it's changed, update it under Irrigation in your portal, or just reply to this email and tell us how you water.",
    fixtureValue: "We worked that figure out from what you entered under Irrigation in your portal — 20 minutes per zone, 4 days a week on spray heads — using the typical spray-head rate from University of Florida turf guidance (about 1.5\" per hour). If you know your actual weekly inches, enter them there and we'll use your number instead.",
  },
];

function addVariable(list, name) {
  const vars = Array.isArray(list) ? list : JSON.parse(list || '[]');
  if (!vars.includes(name)) vars.push(name);
  return JSON.stringify(vars);
}

function parseBlocks(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const calloutFor = (variable) => ({ type: 'callout', content: `{{${variable}}}` });

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;

  for (const target of TARGETS) {
    const tpl = await knex('email_templates').where({ template_key: target.key }).first();
    if (!tpl) continue;

    // The allowlist entry always lands — send-time validation rejects a
    // referenced-but-not-allowed variable.
    await knex('email_templates').where({ id: tpl.id }).update({
      allowed_variables: addVariable(tpl.allowed_variables, target.variable),
      optional_variables: addVariable(tpl.optional_variables, target.variable),
      updated_at: new Date(),
    });

    if (await knex.schema.hasTable('email_template_fixtures')) {
      const fixtures = await knex('email_template_fixtures').where({ template_id: tpl.id }).select('id', 'payload');
      for (const f of fixtures) {
        const payload = typeof f.payload === 'string' ? JSON.parse(f.payload || '{}') : (f.payload || {});
        if (payload[target.variable] === undefined) {
          payload[target.variable] = target.fixtureValue;
          await knex('email_template_fixtures').where({ id: f.id }).update({ payload: JSON.stringify(payload) });
        }
      }
    }

    if (!tpl.active_version_id) continue;
    const version = await knex('email_template_versions').where({ id: tpl.active_version_id }).first();
    if (!version) continue;
    const blocks = parseBlocks(version.blocks);
    if (!blocks || !blocks.length) continue;

    const replacement = calloutFor(target.variable);
    // Already published (or a human already references the variable).
    if (blocks.some((b) => b && b.type === 'callout' && b.content === replacement.content)) continue;
    const at = blocks.findIndex((b) => b && b.type === 'callout' && b.content === target.seededCallout);
    // Staff reworded the callout since seeding — leave their copy alone.
    if (at < 0) continue;
    // A staff-authored text body that does NOT contain the seeded sentence
    // cannot be migrated consistently: renderTemplate prefers a nonempty
    // text_body, so publishing swapped HTML blocks beside it would leave
    // text-part recipients on the pre-migration copy while HTML recipients
    // get the new variable. Leave the whole version alone instead.
    if (typeof version.text_body === 'string' && version.text_body.trim() && !version.text_body.includes(target.seededCallout)) continue;

    const next = blocks.map((b, i) => (i === at ? replacement : b));
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
      // A staff-authored text body wins over block-derived text at render
      // time, so the swap has to happen there too.
      text_body: typeof version.text_body === 'string' && version.text_body.includes(target.seededCallout)
        ? version.text_body.replace(target.seededCallout, replacement.content)
        : version.text_body,
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
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;

  for (const target of TARGETS) {
    const tpl = await knex('email_templates').where({ template_key: target.key }).first();
    if (!tpl || !tpl.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: tpl.active_version_id }).first();
    if (!current) continue;

    // Undo only the version THIS migration published, identified
    // structurally: active, carries exactly our callout, and an ARCHIVED
    // version whose blocks equal current-with-the-seeded-callout-restored.
    // The predecessor is found by that structural identity, NOT by
    // version_number - 1 — an unpublished draft can hold an intermediate
    // number (active v3 + draft v4 → up() published v5, predecessor is v3).
    // Anything else means a human has edited since, and rollback declines.
    const blocks = parseBlocks(current.blocks) || [];
    const replacement = calloutFor(target.variable);
    const at = blocks.findIndex((b) => b && b.type === 'callout' && b.content === replacement.content);
    if (at < 0) continue;

    const restored = blocks.map((b, i) => (i === at ? { type: 'callout', content: target.seededCallout } : b));
    const restoredJson = JSON.stringify(restored);
    // Identity must hold across EVERY field up() authored, not blocks alone
    // — a staff republish that keeps the blocks but changes the subject,
    // preview text, or text body would otherwise be mistaken for our
    // version and their changes discarded on rollback.
    const textBodyMatches = (prev) => {
      if (typeof prev.text_body === 'string' && prev.text_body.includes(target.seededCallout)) {
        return current.text_body === prev.text_body.replace(target.seededCallout, replacement.content);
      }
      return (current.text_body ?? null) === (prev.text_body ?? null);
    };
    const archived = await knex('email_template_versions')
      .where({ template_id: tpl.id, status: 'archived' });
    const previous = (archived || [])
      .slice()
      .sort((a, b) => Number(b.version_number) - Number(a.version_number))
      .find((v) => JSON.stringify(parseBlocks(v.blocks) || []) === restoredJson
        && v.subject === current.subject
        && (v.preview_text ?? null) === (current.preview_text ?? null)
        && textBodyMatches(v));
    if (!previous) continue;

    await knex('email_template_versions').where({ id: previous.id }).update({ status: 'active', updated_at: new Date() });
    await knex('email_templates').where({ id: tpl.id }).update({
      active_version_id: previous.id, last_published_at: new Date(), updated_at: new Date(),
    });
    await knex('email_template_versions').where({ id: current.id }).update({ status: 'archived', updated_at: new Date() });

    // The allowlist entry AND the fixture values stay on down. An inert
    // allowed variable is harmless, while removing one a re-edited body
    // still references would break sends — and up() preserved any fixture
    // value that already existed, so down() cannot tell a staff-authored
    // value from the one it seeded; deleting either would destroy data this
    // migration did not create. An extra fixture key on an optional variable
    // renders nothing.
  }
};

exports.__private = { TARGETS, calloutFor };
