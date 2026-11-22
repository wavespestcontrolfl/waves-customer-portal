/**
 * The tokenized public preview of an automation step must never show the
 * consultation-booking template syntax (Codex #4813 r4 P2) — it renders the
 * step as a non-recurring lead receives it.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const preview = require('../routes/public-automation-preview');

const fill = preview._test?.fill;

describe('public automation preview — consultation placeholders', () => {
  test('fill() strips both placeholders (spaced or not) and their trailing newline', () => {
    expect(typeof fill).toBe('function');
    const html = "<h2>Hi {{first_name}}</h2>\n{{consultation_booking}}\n<h2>What's next</h2>";
    const text = 'Hi {{first_name}}. {{ consultation_booking_text }}\nReply with your address.';
    expect(fill(html)).toBe("<h2>Hi Friend</h2>\n<h2>What's next</h2>");
    expect(fill(text)).toBe('Hi Friend. Reply with your address.');
    expect(fill(html)).not.toContain('{{');
  });
});

describe('public automation preview — the referral_nudge words (GATE_REFERRAL_STEP2)', () => {
  const engine = require('../services/referral-engine');
  const { gates } = require('../config/feature-gates');
  const { _STEP_SWAPS: swaps } = require('../models/migrations/20260926120200_customer_copy_audit_automations');
  const seed = (field) => swaps.find((x) => x.key === 'referral_nudge' && x.field === field).after;
  const step = () => ({ template_key: 'referral_nudge', subject: 'S', preview_text: seed('preview_text'), html_body: seed('html_body') });
  let savedGate;
  beforeEach(() => { savedGate = gates.referralStep2; });
  afterEach(() => { gates.referralStep2 = savedGate; jest.restoreAllMocks(); });

  test('gate off: the step is shown exactly as stored, and no read is made', async () => {
    gates.referralStep2 = false;
    const spy = jest.spyOn(engine, 'referralOfferDecision');
    const shown = await preview._test.withNudgeOffer(step());
    expect(shown).toEqual(step());
    expect(spy).toHaveBeenCalledWith(expect.anything(), null);
  });

  test('gate on: the summary and the HTML show the approved words with the live amounts (a member under the limit)', async () => {
    jest.spyOn(engine, 'referralOfferDecision').mockResolvedValue({ gateOn: true, skip: false, atLimit: false, memberCents: 2500, refereeCents: 5000 });
    const shown = await preview._test.withNudgeOffer(step());
    expect(shown.preview_text).toBe('Refer a neighbor: they get a $50 credit, you get a $25 credit.');
    expect(shown.html_body).toContain('they get a <strong>$50 account credit</strong> after their first service. After we complete their first service, you get a <strong>$25 account credit</strong>.</p>');
  });

  test('gate on, the program paused or its settings unreadable: no reward is shown, as a real send is deferred', async () => {
    for (const reason of ['program paused', 'settings unavailable']) {
      jest.spyOn(engine, 'referralOfferDecision').mockResolvedValue({ gateOn: true, skip: true, atLimit: false, reason });
      const shown = await preview._test.withNudgeOffer(step());
      expect(shown.preview_text).toBe('Refer a neighbor.');
      expect(shown.html_body).toContain('<p>Share your personal referral link — it\'s in the Refer tab of your customer portal.</p>');
      expect(shown.html_body).not.toMatch(/account credit/);
    }
  });

  test('any other step is shown as stored, with no read', async () => {
    const spy = jest.spyOn(engine, 'referralOfferDecision');
    const other = { template_key: 'new_lead', subject: 'S', preview_text: 'p', html_body: '<p>x</p>' };
    expect(await preview._test.withNudgeOffer(other)).toBe(other);
    expect(spy).not.toHaveBeenCalled();
  });
});
