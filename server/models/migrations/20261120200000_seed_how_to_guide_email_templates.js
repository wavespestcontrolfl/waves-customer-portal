/**
 * howto.* — the Quick Links how-to guides as emails (owner 2026-11-20: the
 * app notification instructions were meant to be an email staff can send,
 * like a prep guide, not steps pasted into a text).
 *
 * One template per guide, sent by hand from Quick Links through
 * services/how-to-guide-sender.js. Email only: a guide has no public page
 * for a text to link to. The steps are the same sentences as the pasted
 * version in client/src/lib/howToGuides.js (its test compares the two), so
 * every step still names a real button label in PortalPage.jsx.
 *
 * The list block renders check marks, so numbered steps are paragraphs.
 * `guide_url` opens the right app screen after sign-in (LoginPage ?next=).
 *
 * Same upsert discipline as 20260905000010: nothing exists under these keys
 * yet, and a re-run updates the active version in place.
 */
const SERVICE_FROM = 'contact@wavespestcontrol.com';
const APP_PAGE = 'https://www.wavespestcontrol.com/app/';

const SIGN_IN = 'Sign in to the Waves app with your phone number.';
const ALERTS_APP_STEP = 'Open the Waves app, tap Visits and scroll down to Service notifications. It should say "This device is connected." If you see Connect this device or Turn on app notifications, tap it.';
const ALERTS_TEXT_CHOICE = 'Want to change which alerts you get, or get some by text instead? Use the choices under Service notifications in the same place.';
const HELP_NOTE = 'Don\'t see one of these buttons? Reply to this email, or call or text {{company_phone}}, and we will help.';

const GUIDES = [
  {
    key: 'add_contact',
    title: 'How to add another contact in the Waves app',
    path: '/?tab=visits',
    steps: [
      SIGN_IN,
      'Tap Visits.',
      'Scroll down to the contacts section.',
      'Type their name, phone number and email. To add more people, tap + Add another contact (up to 3).',
      'Check the box to confirm they agreed to get our texts, then tap Save.',
    ],
    after: 'They will get the visit alerts you have turned on, such as reminders and on-the-way alerts. We may text them once to confirm first. If you have more than one property on your account, they get alerts for all of them.',
  },
  {
    key: 'autopay',
    title: 'How to set up Auto Pay or change your card',
    path: '/?tab=billing&focus=payment-methods',
    steps: [
      SIGN_IN,
      'Tap Billing.',
      'If Auto Pay is off, tap Turn on Auto Pay and follow the steps.',
      'To change the card Auto Pay uses, tap Manage Auto Pay, then Change payment method, and enter the new card.',
      'If Auto Pay is paused, reply here and we will update the card for you.',
    ],
  },
  {
    key: 'notifications',
    title: 'How to choose how we notify you',
    path: '/?tab=visits',
    steps: [
      SIGN_IN,
      'Tap Visits.',
      'Scroll down to Service notifications.',
      'If you see a choice next to an alert, pick how you want it, such as text or email.',
      'To turn an alert on or off, use its switch. If you have more than one property, the switches are lower down, under Appointment notifications. Pick the property first.',
      'Changes save right away.',
    ],
  },
  {
    key: 'get_app',
    title: 'How to get the Waves app',
    path: '/?tab=visits',
    // The pasted version carries the two store links in this step; the email
    // has a button to the app page instead.
    steps: [
      'Install the app. The button below has the iPhone and Android downloads.',
      'Open it and sign in with your phone number.',
      'If your phone asks, allow notifications.',
    ],
    cta: { label: 'Get the Waves app', url: APP_PAGE },
  },
  {
    key: 'alerts_iphone',
    title: 'How to make Waves alerts show on your iPhone',
    path: '/?tab=visits',
    steps: [
      'Open Settings, tap Notifications, then tap Waves.',
      'Turn on Allow Notifications. Under Alerts, check Lock Screen, Notification Center and Banners. Turn on Sounds.',
      'If you see Immediate Delivery, choose it.',
      'Reminders go out in the morning. If you use Sleep, open Settings, tap Focus, then Sleep, then tap Apps under Allow Notifications. If it says Allow Notifications From, tap Add, choose Waves and tap Done. If it says Silence Notifications From, take Waves off that list. Do the same for Do Not Disturb if you use it.',
      ALERTS_APP_STEP,
    ],
    after: ALERTS_TEXT_CHOICE,
  },
  {
    key: 'alerts_android',
    title: 'How to make Waves alerts show on your Android phone',
    path: '/?tab=visits',
    steps: [
      'Press and hold the Waves app icon, then tap App info.',
      'Tap Notifications and turn on Allow notifications.',
      'If you see a list of alert types, tap each one and choose Alert (some phones say Default), not Silent. Turn on Pop on screen if you see it.',
      'Back in App info, tap Battery and choose Unrestricted. On a Samsung phone, also search Settings for Background usage limits and make sure Waves is not under Sleeping apps or Deep sleeping apps.',
      'Reminders go out in the morning. If you use Do Not Disturb or Bedtime mode, search Settings for Do Not Disturb, open its apps list, tap Add apps and choose Waves.',
      ALERTS_APP_STEP,
    ],
    after: ALERTS_TEXT_CHOICE,
  },
  {
    key: 'documents',
    title: 'How to find your service reports and invoices',
    path: '/?tab=documents',
    steps: [
      SIGN_IN,
      'Open Documents. On a phone, tap More, then Documents.',
      'Your reports are under Service Reports. Tap one to open it.',
      'Your balance shows at the top of Billing. Paid receipts are in Billing, under Payment History.',
    ],
  },
  {
    key: 'reschedule',
    title: 'How to reschedule or request a visit',
    path: '/?tab=visits',
    steps: [
      SIGN_IN,
      'Tap Visits.',
      'Find the visit and tap Reschedule. Pick a new time, or if it opens a text to us, send it and we will find you a time.',
      'Need an extra visit or seeing pests? Tap Request, choose what you need and send it. We will get back to you.',
    ],
  },
  {
    key: 'access_notes',
    title: 'How to update your gate code and access notes',
    path: '/?tab=property',
    steps: [
      SIGN_IN,
      'Open My Property. On a phone, tap More, then My Property.',
      'Under Access, fill in Community Gate, Property Gate, Garage Code or Lockbox Code.',
      'Add parking notes and pets too. Changes save on their own.',
      'These fields are for your main home. For another property, reply here with the code and we will add it.',
    ],
    after: 'Your technician sees these before every visit.',
  },
  {
    key: 'add_property',
    title: 'How to add another property to your account',
    path: '/?tab=visits',
    steps: [
      'Reply with the address and the service you want there, or call us at (941) 297-5749. We add it for you.',
      'Once it is added, sign in. To switch homes, tap your initials at the top right to open the Account menu, then pick the home under Service Property.',
    ],
    after: 'Each home has its own visit schedule.',
  },
  {
    key: 'refer',
    title: 'How to refer a friend',
    path: '/?tab=refer',
    steps: [
      SIGN_IN,
      'Tap Refer.',
      'Tap Copy to copy your link, or tap Text or Email to share it.',
      'Or fill in their name and phone number and tap Send SMS invite. You can also enter an email and tap Send email invite.',
      'The Refer page shows the current reward and how you earn it.',
    ],
  },
];

const templateKeyFor = (key) => `howto.${key}`;

function template(guide) {
  return {
    key: templateKeyFor(guide.key),
    name: guide.title,
    description: `How-to guide sent by hand from Quick Links: ${guide.title.replace(/^How to /, '')}.`,
    subject: guide.title,
    preview: 'Step by step, with a button that opens the right screen.',
    // A guide with its own button target needs no deep link from the sender.
    required: guide.cta ? ['first_name'] : ['first_name', 'guide_url'],
    blocks: [
      { type: 'heading', content: guide.title },
      { type: 'paragraph', content: 'Hi {{first_name}}, here are the steps.' },
      ...guide.steps.map((step, index) => ({ type: 'paragraph', content: `${index + 1}. ${step}` })),
      ...(guide.after ? [{ type: 'paragraph', content: guide.after }] : []),
      guide.cta
        ? { type: 'cta', label: guide.cta.label, url: guide.cta.url }
        : { type: 'cta', label: 'Open the Waves app', url_variable: 'guide_url' },
      { type: 'small_note', content: HELP_NOTE },
      { type: 'signature', content: '— The Waves Team' },
    ],
  };
}

const TEMPLATES = GUIDES.map(template);
const SHARED_VARIABLES = ['first_name', 'guide_url', 'company_phone', 'company_email'];

const PREVIEW_PAYLOAD = {
  first_name: 'Dorothy',
  guide_url: 'https://portal.wavespestcontrol.com/login?next=%2F%3Ftab%3Dvisits',
  company_phone: '(941) 297-5749',
  company_email: SERVICE_FROM,
};

function templateRow(t) {
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: 'howto',
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'service',
    send_stream: 'service_operational',
    suppression_group_key: 'service_operational',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: null,
    default_cta_url_variable: null,
    allowed_variables: JSON.stringify(SHARED_VARIABLES),
    required_variables: JSON.stringify(t.required),
    optional_variables: JSON.stringify(SHARED_VARIABLES.filter((key) => !t.required.includes(key))),
    status: 'active',
    updated_at: new Date(),
  };
}

async function upsertTemplate(knex, t) {
  const row = templateRow(t);
  let tpl = await knex('email_templates').where({ template_key: t.key }).first();
  if (tpl) {
    await knex('email_templates').where({ id: tpl.id }).update(row);
  } else {
    [tpl] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  }

  const versionFields = {
    status: 'active',
    subject: t.subject,
    preview_text: t.preview,
    blocks: JSON.stringify(t.blocks),
    text_body: null,
    published_at: new Date(),
    updated_at: new Date(),
  };
  let versionId = tpl.active_version_id;
  if (versionId) {
    await knex('email_template_versions').where({ id: versionId }).update(versionFields);
  } else {
    const latest = await knex('email_template_versions').where({ template_id: tpl.id }).max('version_number as max').first();
    const [version] = await knex('email_template_versions').insert({
      template_id: tpl.id,
      version_number: Number(latest?.max || 0) + 1,
      created_at: new Date(),
      ...versionFields,
    }).returning('id');
    versionId = version?.id ?? version;
  }
  await knex('email_templates').where({ id: tpl.id }).update({
    active_version_id: versionId, last_published_at: new Date(), updated_at: new Date(),
  });

  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixture = await knex('email_template_fixtures').where({ template_id: tpl.id, is_default: true }).first();
    const payload = JSON.stringify(PREVIEW_PAYLOAD);
    if (fixture) {
      await knex('email_template_fixtures').where({ id: fixture.id }).update({ name: 'Happy path', payload, updated_at: new Date() });
    } else {
      await knex('email_template_fixtures').insert({
        template_id: tpl.id, name: 'Happy path', payload, is_default: true, created_at: new Date(), updated_at: new Date(),
      });
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const t of TEMPLATES) await upsertTemplate(knex, t);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates').whereIn('template_key', TEMPLATES.map((t) => t.key)).del();
};

exports.GUIDES = GUIDES;
exports.TEMPLATES = TEMPLATES;
exports.__private = { templateRow, templateKeyFor, PREVIEW_PAYLOAD, APP_PAGE };
