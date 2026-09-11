/**
 * Second pass of the STOP-line policy: take "Reply STOP to opt out." off the
 * remaining customer-transactional SMS templates, plus the two WaveGuard
 * upsells (owner directive 2026-09-11).
 *
 * Extends 20260810000060_stop_line_off_customer_transactional. That pass
 * cleaned the operational fleet but left a keep-list built on two ideas that
 * a prod audit on 2026-09-11 (139 rows, 22 active rows still carrying the
 * line) showed were too broad:
 *
 *   - "onboarding welcomes are plausibly the first SMS a new customer
 *     receives" — they aren't. Booking sends appointment_confirmation INLINE
 *     (services/appointment-reminders.js deliverConfirmation, called from the
 *     booking path before AppointmentTagger.onServiceScheduled fires), and
 *     auto_new_recurring is queued ~60 min later by
 *     services/new-recurring-welcome-sms.js. auto_new_appointment needs an
 *     admin to enrol the customer (services/email-automations.js:58), and
 *     auto_prep_guide_link / auto_sprinkler_timer go out from
 *     services/prep-guide-sender.js to a customer who already has the visit
 *     (or, for the sprinkler how-to, an existing lawn customer).
 *   - "review requests are marketing solicitations" — they carry no offer.
 *     They go to a customer whose visit we just completed
 *     (services/review-request.js), asking for a Google review. Nothing is
 *     being sold, so they are not telemarketing copy.
 *
 * Also cleaned here: autopay_setup_link (admin-triggered from the comms UI
 * for an existing customer who asked for the link — services/autopay-setup-
 * link.js:415), renewal_reminder (cron at 30/15/7 days before a termite bond
 * lapses — services/workflows/renewal-reminder.js; same shape as
 * annual_prepay_renewal_reminder, which 20260810000060 already stripped), and
 * appointment_recurring_placement_confirmed (seeded by
 * 20260906000040_recurring_dispatch_sms, sent from routes/admin-dispatch.js
 * when a recurring placement is confirmed — an existing recurring customer
 * being told the date of their next visit).
 *
 * upsell_add_service and upsell_tier_upgrade are an EXPLICIT owner ruling
 * against this file's own recommendation (2026-09-11): both pitch a paid
 * add-on to an existing member, which is marketing content, and consent to
 * service texts is not consent to marketing texts. The owner's call is that
 * a WaveGuard member hearing about their own plan is account servicing. The
 * recommendation was to keep the line on both; it is recorded here so a
 * future reader does not "fix" this back by accident.
 *
 * WHAT KEEPS THE LINE (unchanged, and deliberately so):
 *   - recipient_optin_request — the CTIA opt-in copy itself.
 *   - Lead first contact, where we text someone who is not a customer:
 *     missed_call, lead_auto_reply_biz, voicemail_quote_link,
 *     dropped_call_address_request, booking_abandonment_recovery.
 *   - Estimate delivery / program entry: estimate_sent, estimate_extended,
 *     estimate_followup_deposit, quote_wizard_booking_invite, and the
 *     hardcoded lawn-program-overview body in routes/admin-service-outlines.js
 *     (audience can be 'lead').
 *   - Third-party first touch: referral_invite (a stranger the referrer
 *     named) and referral_nudge (a $25-off pitch).
 *
 * The STOP keyword keeps working either way — it is registered on the
 * approved A2P campaign and enforced by Twilio number-level opt-out plus
 * services/messaging/opt-out-detector.js. This migration changes the visible
 * disclosure, never the mechanism.
 *
 * ADMIN-EDIT SAFETY (same contract as 20260810000060): each swap carries the
 * exact prod body audited 2026-09-11 (read-only SELECT). A row whose body
 * drifted since gets the mechanical STOP-drop only, so admin wording
 * survives. Updates are compare-and-swap on the body that was read, so an
 * admin save landing mid-migration wins instead of being overwritten.
 * Experiment variants render INSTEAD of the base body, so
 * sms_template_variants gets the same treatment.
 *
 * ROLLBACK SAFETY: up() records the rows it actually rewrote in
 * system_settings under this migration's own stamp, and down() restores only
 * those. Body alone is not evidence — a row that already equalled the
 * post-sweep body (a fresh seed, an admin who took the line off by hand)
 * looks identical to one this file rewrote, and a body-only rollback would
 * print the opt-out line onto copy this migration never touched. No record
 * means no restore.
 */

// [template_key, expected prod body 2026-09-11, new body]
const SWAPS = [
  ['appointment_recurring_placement_confirmed',
    'Hello {first_name}! Your next Waves visit is set for {start_date}{window_text}. Later visits will be arranged within 3 days of each new due date. Existing commitments stay unchanged until we review them with you. Reply STOP to opt out.',
    'Hello {first_name}! Your next Waves visit is set for {start_date}{window_text}. Later visits will be arranged within 3 days of each new due date. Existing commitments stay unchanged until we review them with you.'],
  ['autopay_setup_link',
    'Hi {first_name}! Set up Auto Pay for your Waves service here: {secure_link}\nSave a payment method and each completed service is paid automatically. Nothing is charged today. We never take card numbers by phone. Reply STOP to opt out.',
    'Hi {first_name}! Set up Auto Pay for your Waves service here: {secure_link}\nSave a payment method and each completed service is paid automatically. Nothing is charged today. We never take card numbers by phone.'],
  ['review_request',
    'Thanks for having us out, {first_name}! A Google review would mean a lot: {review_url}\n\nReply STOP to opt out.',
    'Thanks for having us out, {first_name}! A Google review would mean a lot: {review_url}'],
  ['review_request_followup',
    'No pressure, {first_name}. If you have a minute, your review helps other SWFL families find a pest company they can trust: {google_review_url}\n\nReply STOP to opt out.',
    'No pressure, {first_name}. If you have a minute, your review helps other SWFL families find a pest company they can trust: {google_review_url}'],
  ['renewal_reminder',
    'Hello {first_name}! Your {renewal_label} {urgency}.\n\nReply RENEW or call us to keep coverage active.\n\nReply STOP to opt out.',
    'Hello {first_name}! Your {renewal_label} {urgency}.\n\nReply RENEW or call us to keep coverage active.'],
  ['auto_new_appointment',
    'Hello {first_name}! We just emailed what to expect for your first service.\n\nReply STOP to opt out.',
    'Hello {first_name}! We just emailed what to expect for your first service.'],
  ['auto_new_recurring',
    'Hello {first_name}, welcome to Waves!\n\nYou can manage everything in the free Waves app: upcoming visits, live tech tracking, rescheduling, and invoices. Get it at wavespestcontrol.com/app\n\nReply STOP to opt out.',
    'Hello {first_name}, welcome to Waves!\n\nYou can manage everything in the free Waves app: upcoming visits, live tech tracking, rescheduling, and invoices. Get it at wavespestcontrol.com/app'],
  ['auto_prep_guide_link',
    'Hello {first_name}! Your {prep_label} prep guide is here: {prep_url}\n\nPlease read it before your visit so everything goes as smoothly as possible.\n\nQuestions or requests? Reply here. Reply STOP to opt out.',
    'Hello {first_name}! Your {prep_label} prep guide is here: {prep_url}\n\nPlease read it before your visit so everything goes as smoothly as possible.\n\nQuestions or requests? Reply here.'],
  ['auto_sprinkler_timer',
    'Hello {first_name}! Run your sprinklers by hand for your Monday watering plan: https://www.wavespestcontrol.com/sprinkler-timers/ Tap your timer brand and follow the photos. Stuck? Reply with a timer photo for help. Reply STOP to opt out.',
    'Hello {first_name}! Run your sprinklers by hand for your Monday watering plan: https://www.wavespestcontrol.com/sprinkler-timers/ Tap your timer brand and follow the photos. Stuck? Reply with a timer photo for help.'],
  ['upsell_add_service',
    'Hello {first_name}! Adam from Waves here. Since you are already a WaveGuard member, we can add {service_name} to your plan with bundled service savings. Want details? Reply YES.\n\nReply STOP to opt out.',
    'Hello {first_name}! Adam from Waves here. Since you are already a WaveGuard member, we can add {service_name} to your plan with bundled service savings. Want details? Reply YES.'],
  ['upsell_tier_upgrade',
    'Hello {first_name}! Adam from Waves here. Upgrading to WaveGuard {next_tier} can add more coverage and service savings. Want me to run the numbers? Reply YES and I will send a breakdown.\n\nReply STOP to opt out.',
    'Hello {first_name}! Adam from Waves here. Upgrading to WaveGuard {next_tier} can add more coverage and service savings. Want me to run the numbers? Reply YES and I will send a breakdown.'],
];

const KEYS = SWAPS.map(([key]) => key);

// Keys that must NEVER lose the line here — a drifted body on one of these is
// left exactly as the admin wrote it. Listed so the guard test can assert the
// keep-list is still intact after this migration runs.
const KEEP_STOP_KEYS = [
  'recipient_optin_request',
  'missed_call',
  'lead_auto_reply_biz',
  'voicemail_quote_link',
  'dropped_call_address_request',
  'booking_abandonment_recovery',
  'estimate_sent',
  'estimate_extended',
  'estimate_followup_deposit',
  'quote_wizard_booking_invite',
  'referral_invite',
  'referral_nudge',
];

// Disabled in production today, so no sweep has touched them — but each would
// pass one of the two tests the moment it went live (estimate chasers reach
// prospects; reactivation and cancellation-save copy is selling). Listed so a
// later pass reading the keep-list does not mistake them for leftovers.
const KEEP_STOP_IF_REACTIVATED = [
  'estimate_followup_unviewed',
  'estimate_followup_viewed',
  'estimate_followup_final',
  'estimate_followup_expiring',
  'seasonal_reactivation',
  'cancellation_save_accepted_offer',
  'cancellation_save_callback_requested',
  'cancellation_save_cancelled',
  'cancellation_save_step1_default',
  'cancellation_save_step1_moving',
  'cancellation_save_step1_price',
  'cancellation_save_step1_quality',
  'cancellation_save_step2_default',
  'cancellation_save_step2_moving',
  'cancellation_save_step2_price',
  'cancellation_save_step2_quality',
  'cancellation_save_step3',
];

// Same strip as 20260810000060: handles the "\n\nReply STOP…" tail and the
// same-line "phone. Reply STOP…" form, then tidies whitespace.
function dropStop(body) {
  return String(body)
    .replace(/\n{1,2}Reply STOP to opt out\.?/g, '')
    .replace(/ ?Reply STOP to opt out\.?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trimEnd();
}

// Rollback evidence. A row that ALREADY equalled the post-sweep body before
// this migration ran (a fresh seed, or an admin who took the line off by hand)
// is indistinguishable by body alone from one this migration rewrote — so a
// body-only down() would print the opt-out line onto copy this file never
// touched. up() records the rows it actually rewrote; down() restores only
// those. Derived from this migration's own stamp, per the house convention.
const STATE_KEY = 'migration.20260911000010.state';

async function readState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed.rewritten) ? parsed.rewritten : [];
  } catch {
    return [];
  }
}

async function sweep(knex, table) {
  if (!(await knex.schema.hasTable(table))) return [];
  const swapByKey = new Map(SWAPS.map(([key, expect, set]) => [key, { expect, set }]));
  const rows = await knex(table).whereIn('template_key', KEYS).select('id', 'template_key', 'body');
  const rewritten = [];
  for (const row of rows) {
    if (typeof row.body !== 'string') continue;
    const swap = swapByKey.get(row.template_key);
    // Exact audited body → the reviewed replacement. Drifted (admin edited
    // since the audit) → mechanical STOP-drop only, admin wording preserved.
    const audited = Boolean(swap) && row.body === swap.expect;
    const next = audited ? swap.set : dropStop(row.body);
    if (next === row.body) continue;
    // Compare-and-swap on the body we read: an admin save landing between the
    // read and this update wins instead of being overwritten.
    const changed = await knex(table).where({ id: row.id, body: row.body }).update({ body: next, updated_at: new Date() });
    // Only an audited rewrite is restorable — a mechanical strip has no
    // snapshot of the admin wording it removed the line from.
    if (audited && changed !== 0) rewritten.push([table, row.id]);
  }
  return rewritten;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const rewritten = await sweep(knex, 'sms_templates');
  // Variants render INSTEAD of the base body (getTemplate prefers an active
  // variant), so a variant left carrying the line would defeat the sweep.
  rewritten.push(...(await sweep(knex, 'sms_template_variants')));

  if (await knex.schema.hasTable('system_settings')) {
    const prior = (await readState(knex)) || [];
    const seen = new Set(prior.map((e) => JSON.stringify(e)));
    const merged = [...prior, ...rewritten.filter((e) => !seen.has(JSON.stringify(e)))];
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({
      key: STATE_KEY,
      value: JSON.stringify({ rewritten: merged }),
      category: 'migration',
      description: 'Rows 20260911000010 rewrote, so down() restores only those.',
    });
  }
};

exports.down = async function down(knex) {
  // Copy-only migration: restore the audited body ONLY on rows up() recorded
  // as rewritten, and only while the body is still exactly what up() left.
  // No evidence (state row missing, system_settings absent, a body edited
  // since) → restore nothing. Failing closed is the right direction here: the
  // cost of skipping a restore is a template missing a line it does not need,
  // and the cost of a wrong restore is printing an opt-out line on copy
  // somebody wrote deliberately.
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const rewritten = await readState(knex);
  if (!rewritten || rewritten.length === 0) return;

  const setByKey = new Map(SWAPS.map(([key, expect, set]) => [key, { expect, set }]));
  for (const [table, id] of rewritten) {
    if (!(await knex.schema.hasTable(table))) continue;
    const row = await knex(table).where({ id }).first('id', 'template_key', 'body');
    if (!row) continue;
    const swap = setByKey.get(row.template_key);
    if (!swap || row.body !== swap.set) continue;
    await knex(table).where({ id: row.id, body: swap.set }).update({ body: swap.expect, updated_at: new Date() });
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports._SWAPS = SWAPS;
exports._KEYS = KEYS;
exports._KEEP_STOP_KEYS = KEEP_STOP_KEYS;
exports._KEEP_STOP_IF_REACTIVATED = KEEP_STOP_IF_REACTIVATED;
exports._STATE_KEY = STATE_KEY;
exports._dropStop = dropStop;
