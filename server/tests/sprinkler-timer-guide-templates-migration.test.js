/**
 * 20260905000010 / 20260905000011 — the one-time sprinkler timer guide
 * (email + text). Guards what the seed must keep true:
 *  1. The email renders through the production renderer with its own
 *     fixture (no missing required payload), carrying the five hub brand
 *     buttons and the watering callout.
 *  2. The keys the sender sends are the keys the seeds create.
 *  3. Copy compliance: no "safe" claims, brand is "Waves", the manual-first
 *     stance (OFF between runs, Monday's email carries the minutes) and no
 *     weekday / hour-window promise the policy cannot make.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false), sendOne: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({}));

const emailSeed = require('../models/migrations/20260905000010_seed_sprinkler_timer_prep_email_template');
const smsSeed = require('../models/migrations/20260905000011_seed_sprinkler_timer_prep_sms');
const { renderTemplate, normalizeBlocks } = require('../services/email-template-library');
const { PREP_CONFIG } = require('../services/prep-guide-sender');

const { TEMPLATE, TEMPLATE_KEY, HUB_GUIDES, templateRow, PREVIEW_PAYLOAD, REQUIRED } = emailSeed.__private;

function render(payload = PREVIEW_PAYLOAD) {
  return renderTemplate({
    template: templateRow(TEMPLATE),
    version: { subject: TEMPLATE.subject, preview_text: TEMPLATE.preview, blocks: TEMPLATE.blocks },
    payload,
  });
}

function allCopy() {
  const chunks = [TEMPLATE.subject, TEMPLATE.preview];
  for (const b of TEMPLATE.blocks) {
    if (typeof b.content === 'string') chunks.push(b.content);
    if (typeof b.label === 'string') chunks.push(b.label);
    for (const item of b.items || []) chunks.push(item);
  }
  for (const t of smsSeed.NEW_TEMPLATES) chunks.push(t.body);
  return chunks;
}

describe('sprinkler timer guide email seed', () => {
  test('renders with its fixture — no missing payload, five hub brand buttons, the watering callout', () => {
    const out = render();
    expect(out.missingPayload).toEqual([]);
    expect(out.subject).toBe('Running your sprinklers by hand, Dorothy');
    for (const path of ['rain-bird', 'hunter', 'orbit-b-hyve', 'rachio', 'identify']) {
      expect(out.html).toContain(`${HUB_GUIDES}/${path}/`);
    }
    expect(normalizeBlocks(TEMPLATE.blocks).filter((b) => b.type === 'cta')).toHaveLength(5);
    // Rendered through escapeHtml (apostrophes become entities), so match a
    // stretch of the fixture without one.
    expect(out.html).toContain('one watering day a week (SWFWMD Modified Phase III water shortage order)');
    expect(out.html).toContain('run each grass zone about 35 minutes.');
    // The support number renders from the payload, never a typed-in number.
    expect(out.html).toContain(PREVIEW_PAYLOAD.company_phone);
  });

  test('required variables are exactly what the sender fills, and each is referenced', () => {
    expect(REQUIRED.sort()).toEqual(['first_name', 'watering_block']);
    const copy = allCopy().join('\n');
    for (const key of REQUIRED) expect(copy).toContain(`{{${key}}}`);
    expect(render({ first_name: 'Dorothy' }).missingPayload).toEqual(['watering_block']);
  });

  test('the sender and the seeds agree on keys; the row is a protected prep template', () => {
    expect(PREP_CONFIG.sprinkler_timer.emailTemplateKey).toBe(TEMPLATE_KEY);
    expect(smsSeed.NEW_TEMPLATES.map((t) => t.template_key)).toEqual([PREP_CONFIG.sprinkler_timer.smsStandaloneKey]);
    const row = templateRow(TEMPLATE);
    expect(row.purpose).toBe('prep');
    expect(row.status).toBe('active');
    expect(row.default_cta_label).toBeNull();
    const source = require('fs').readFileSync(require.resolve('../routes/admin-email-templates'), 'utf8');
    expect(source).toContain(`'${TEMPLATE_KEY}',`);
  });

  test('copy compliance: manual-first, no safe claims, no weekday or hour-window promise', () => {
    const copy = allCopy().join('\n');
    expect(copy).not.toMatch(/\bsafe(ly)?\b/i);
    expect(copy).not.toMatch(/Waves Lawn/);
    expect(copy).toMatch(/leave the dial on OFF/);
    expect(copy).toMatch(/Monday/);
    expect(copy).not.toMatch(/\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day is\b/);
    expect(copy).not.toMatch(/\d{1,2}:\d{2}/);
    // The referral line, never a repair claim.
    expect(copy).toMatch(/does not repair sprinklers/);
  });

  test('the text carries the hub guide link and the opt-out', () => {
    const [sms] = smsSeed.NEW_TEMPLATES;
    expect(sms.body).toContain('https://www.wavespestcontrol.com/sprinkler-timers/');
    expect(sms.body).toMatch(/Reply STOP/);
    expect(sms.body).not.toMatch(/emailed/);
    expect(JSON.parse(sms.variables)).toEqual(['first_name']);
  });
});
