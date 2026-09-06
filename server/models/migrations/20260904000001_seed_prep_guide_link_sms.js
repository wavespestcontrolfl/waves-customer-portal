/**
 * Prep guide LINK text — the one text template the manual prep sender
 * (services/prep-guide-sender.js) uses for every prep guide when the
 * customer has an upcoming visit of that type: it carries the tokened
 * /prep/:token guide page (the same content as the emailed guide, with a PDF
 * download), so a guide can be TEXTED instead of emailed (owner ruling
 * 2026-09-03: text only / email only / both, operator's choice).
 *
 * Date-free by design (20260602000002: a prep text that embedded the visit
 * date went stale after a reschedule). {prep_label} names the guide,
 * {prep_url} is the page link; the renderer nulls on an unresolved
 * placeholder, so the sender only picks this template when a token exists.
 * Visit-neutral wording: the same text carries prep.rodent for a "Rodent
 * Inspection Service" (that guide covers inspections), so it never promises
 * a treatment (GH Codex #3856 r26 P2).
 *
 * Seed-only, onConflict-ignore (matches 20260711400000): an admin edit to
 * the body is preserved on redeploy.
 */
const NEW_TEMPLATES = [
  {
    template_key: 'auto_prep_guide_link',
    name: 'Prep Guide Link',
    category: 'onboarding',
    body: "Hello {first_name}! Your {prep_label} prep guide is here: {prep_url}\n\nPlease read it before your visit so everything goes as smoothly as possible.\n\nQuestions or requests? Reply here. Reply STOP to opt out.",
    description: 'Texts the tokened prep guide page for any treatment type. Sent by the Communications "Send prep guide" action on the Text and Both channels when the customer has an upcoming visit of that type.',
    variables: JSON.stringify(['first_name', 'prep_label', 'prep_url']),
    is_active: true,
    is_internal: false,
    sort_order: 104,
  },
];

exports.NEW_TEMPLATES = NEW_TEMPLATES;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const t of NEW_TEMPLATES) {
    await knex('sms_templates').insert(t).onConflict('template_key').ignore();
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  // up() is onConflict-ignore, so a row with this key may pre-date this
  // migration or carry an admin edit — only remove the exact seeded body.
  for (const t of NEW_TEMPLATES) {
    await knex('sms_templates').where({ template_key: t.template_key, body: t.body }).del();
  }
};
