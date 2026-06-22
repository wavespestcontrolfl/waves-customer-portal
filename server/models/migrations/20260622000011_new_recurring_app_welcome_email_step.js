/**
 * Add an "introducing the Waves app" email as step 2 of the New Recurring
 * Customer automation (template_key 'new_recurring').
 *
 * The automation already has step 0 (the welcome / "here's what happens next"
 * email). This adds step_order 1, sent 24h later, introducing the iOS app with
 * screenshots + an App Store link. The runner wraps html_body in
 * wrapServiceEmail() (Waves logo header + footer), so html_body here is inner
 * content only. {{first_name}} is substituted at send time.
 *
 * GATED: inserted with enabled = FALSE so it does NOT send while the app is still
 * in App Review (the App Store link would be dead). Flip it on at launch:
 *   UPDATE automation_steps SET enabled = true
 *   WHERE template_key = 'new_recurring' AND step_order = 1;
 * (or toggle it in the automation admin UI). Swap the screenshots first if you
 * re-capture polished ones — they live at client/public/app-email/.
 *
 * Images are served from the portal static root:
 *   https://portal.wavespestcontrol.com/app-email/app-home.png
 *   https://portal.wavespestcontrol.com/app-email/app-visits.png
 */

const APP_STORE_URL = 'https://apps.apple.com/app/id6782775654';
const IMG_BASE = 'https://portal.wavespestcontrol.com/app-email';

const HTML_BODY = `
<h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.25;color:#102a43;font-weight:800;">Your Waves account is now an app, {{first_name}} 📱</h1>
<p style="margin:0 0 18px 0;">Manage everything from your phone — track every visit, read your service reports, pay invoices, and reach your technician, all in one place.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px 0;"><tr><td style="border-radius:30px;background:#000000;">
  <a href="${APP_STORE_URL}" style="display:inline-block;padding:13px 28px;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;">Download on the App Store</a>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:6px 0;"><img src="${IMG_BASE}/app-home.png" width="270" alt="Waves app — your next visit and account at a glance" style="width:270px;max-width:270px;height:auto;border:1px solid #e6ebf1;border-radius:20px;" /></td></tr>
  <tr><td align="center" style="padding:14px 0 6px 0;"><img src="${IMG_BASE}/app-visits.png" width="270" alt="Waves app — upcoming visits, reminders and reports" style="width:270px;max-width:270px;height:auto;border:1px solid #e6ebf1;border-radius:20px;" /></td></tr>
</table>
<h2 style="margin:24px 0 10px 0;font-size:18px;color:#102a43;font-weight:800;">Everything you can do</h2>
<ul style="margin:0 0 18px 0;padding-left:20px;">
  <li style="margin-bottom:7px;">See your <strong>next visit &amp; full service history</strong></li>
  <li style="margin-bottom:7px;">Read your <strong>service reports &amp; lawn health scores</strong></li>
  <li style="margin-bottom:7px;"><strong>View &amp; pay invoices</strong> and manage autopay securely</li>
  <li style="margin-bottom:7px;">Get <strong>notifications</strong> when a visit is scheduled or completed</li>
  <li style="margin-bottom:7px;">Unlock the app instantly with <strong>Face ID</strong></li>
  <li style="margin-bottom:7px;"><strong>Refer neighbors</strong> and track your rewards</li>
</ul>
<p style="margin:0 0 18px 0;">Sign in with the phone number on your Waves account — we'll text you a code. No new password to remember.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px 0;"><tr><td style="border-radius:30px;background:#0ea5e9;">
  <a href="${APP_STORE_URL}" style="display:inline-block;padding:13px 30px;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;">Get the Waves app</a>
</td></tr></table>
`.trim();

const TEXT_BODY = [
  'Your Waves account is now an app, {{first_name}}.',
  '',
  'Manage everything from your phone — track every visit, read your service reports, pay invoices, and reach your technician.',
  '',
  `Download on the App Store: ${APP_STORE_URL}`,
  '',
  'Everything you can do:',
  '- See your next visit & full service history',
  '- Read your service reports & lawn health scores',
  '- View & pay invoices and manage autopay',
  '- Get notifications when a visit is scheduled or completed',
  '- Unlock instantly with Face ID',
  '- Refer neighbors and track your rewards',
  '',
  "Sign in with the phone number on your Waves account — we'll text you a code. No new password to remember.",
].join('\n');

const STEP = {
  template_key: 'new_recurring',
  step_order: 1,
  delay_hours: 24,
  subject: 'Meet the Waves app, {{first_name}} 📱',
  preview_text: 'Track visits, read reports, and pay invoices — right from your phone.',
  html_body: HTML_BODY,
  text_body: TEXT_BODY,
  enabled: false, // held until the app is live on the App Store
};

exports.up = async function up(knex) {
  const exists = await knex('automation_steps')
    .where({ template_key: 'new_recurring', step_order: 1 })
    .first();
  if (exists) return; // idempotent
  await knex('automation_steps').insert(STEP);
};

exports.down = async function down(knex) {
  await knex('automation_steps')
    .where({ template_key: 'new_recurring', step_order: 1, subject: STEP.subject })
    .del();
};
