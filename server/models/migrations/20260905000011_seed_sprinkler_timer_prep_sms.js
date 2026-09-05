/**
 * Text for the one-time sprinkler timer guide (prep.sprinkler_timer,
 * 20260905000010). Same seed shape as the pest prep texts (20260711400000).
 * One variant only: the guide hangs on no visit, so there is no tokened
 * page to text — the hub guide link IS the text, with or without the email.
 *
 * Seed-only, onConflict-ignore: an admin edit to a body is preserved on
 * redeploy.
 */

const NEW_TEMPLATES = [
  {
    template_key: 'auto_sprinkler_timer',
    name: 'Sprinkler Timer Guide',
    category: 'onboarding',
    body: "Hello {first_name}! Here's a short guide for running your sprinklers by hand from your Monday watering plan - find the brand on your timer box, tap it, and follow the photos: https://www.wavespestcontrol.com/sprinkler-timers/ Stuck? Reply here with a photo of your timer and we'll point you to the right page. Reply STOP to opt out.",
    description: 'Text for the one-time sprinkler timer guide: carries the hub guide link, so it stands alone with or without the email.',
    variables: JSON.stringify(['first_name']),
    is_active: true,
    is_internal: false,
    sort_order: 104,
  },
];

exports.NEW_TEMPLATES = NEW_TEMPLATES;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const template of NEW_TEMPLATES) {
    await knex('sms_templates')
      .insert(template)
      .onConflict('template_key')
      .ignore();
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates')
    .whereIn('template_key', NEW_TEMPLATES.map((t) => t.template_key))
    .del();
};
