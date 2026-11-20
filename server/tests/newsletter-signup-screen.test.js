/**
 * Bot check on the public newsletter signup (owner 2026-11-20). The website
 * form sends a hidden `website` field and `formMs` (time from the form
 * appearing to the submit). A signup that fills the hidden field, a
 * website-form signup with too-short timing, or one with no timing that does
 * not come from a fleet page's browser, is dropped before any row is written
 * or any confirmation email is sent, and gets the same answer as a real
 * signup. A form built before the check (no formMs) still works from a
 * browser on a fleet page.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('no db in this test'); });
  fn.raw = jest.fn(async () => { throw new Error('no db in this test'); });
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/newsletter-confirm', () => ({ sendConfirmationEmail: jest.fn(async () => {}) }));
jest.mock('../services/newsletter-subscribers', () => ({
  ...jest.requireActual('../services/newsletter-subscribers'),
  subscribeOrResubscribe: jest.fn(async () => ({
    action: 'confirmation_sent',
    subscriber: { id: 11, email: 'reader@example.com', status: 'pending', tags: [] },
  })),
}));

const logger = require('../services/logger');
const { sendConfirmationEmail } = require('../services/newsletter-confirm');
const { subscribeOrResubscribe } = require('../services/newsletter-subscribers');
const { screenPublicSignup, sourceLabel, MIN_FORM_MS } = require('../services/newsletter-signup-screen');
const router = require('../routes/public-newsletter');

function subscribeHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/subscribe' && l.route.methods.post);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const HUB = 'https://www.wavespestcontrol.com';
function post(body, origin = HUB) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    subscribeHandler()({ body, headers: origin ? { origin } : {} }, res, reject);
  });
}

const person = { email: 'reader@example.com', source: 'astro-website', website: '', formMs: 4200 };
const oldForm = { email: 'reader@example.com', source: 'astro-website' };

beforeEach(() => jest.clearAllMocks());

describe('screenPublicSignup', () => {
  test('a person on the website form passes', () => {
    expect(screenPublicSignup(person)).toEqual({ drop: false, reason: null });
    expect(screenPublicSignup({ ...person, source: 'out_of_area_waitlist' }).drop).toBe(false);
    expect(screenPublicSignup({ ...person, formMs: MIN_FORM_MS }).drop).toBe(false);
  });

  test('a filled hidden field drops the signup, whatever the source', () => {
    expect(screenPublicSignup({ ...person, website: 'http://spam.example' })).toEqual({ drop: true, reason: 'hidden_field' });
    expect(screenPublicSignup({ email: 'reader@example.com', source: 'public_form', website: 'x' }).reason).toBe('hidden_field');
    expect(screenPublicSignup({ ...person, website: 0 }).reason).toBe('hidden_field');
    expect(screenPublicSignup({ ...person, website: ['x'] }).reason).toBe('hidden_field');
  });

  test('a crafted hidden-field object is a drop, never a throw', () => {
    const crafted = { toString: 'not a function', valueOf: null };
    expect(screenPublicSignup({ ...person, website: crafted })).toEqual({ drop: true, reason: 'hidden_field' });
  });

  test('whitespace or null in the hidden field does not drop a person', () => {
    expect(screenPublicSignup({ ...person, website: '   ' }).drop).toBe(false);
    expect(screenPublicSignup({ ...person, website: null }).drop).toBe(false);
  });

  test('a form built before the check (no form time) passes from a browser on a fleet page', () => {
    expect(screenPublicSignup(oldForm, { origin: HUB })).toEqual({ drop: false, reason: null });
    expect(screenPublicSignup({ ...oldForm, source: 'out_of_area_waitlist' }, { origin: 'https://wavespestcontrol.com' }).drop).toBe(false);
  });

  test('no form time and no fleet Origin is a direct post: dropped', () => {
    expect(screenPublicSignup(oldForm)).toEqual({ drop: true, reason: 'no_form_timing' });
    expect(screenPublicSignup(oldForm, { origin: 'https://spam.example' }).reason).toBe('no_form_timing');
    expect(screenPublicSignup(oldForm, { origin: ['https://www.wavespestcontrol.com'] }).reason).toBe('no_form_timing');
    expect(screenPublicSignup({ ...oldForm, source: 'out_of_area_waitlist' }, { origin: '' }).reason).toBe('no_form_timing');
  });

  test('a form time faster than a person can type, or not a number, is dropped even from a fleet page', () => {
    expect(screenPublicSignup({ ...person, formMs: 0 }, { origin: HUB })).toEqual({ drop: true, reason: 'too_fast' });
    expect(screenPublicSignup({ ...person, formMs: MIN_FORM_MS - 1 }, { origin: HUB }).reason).toBe('too_fast');
    expect(screenPublicSignup({ ...person, formMs: '4200' }, { origin: HUB }).reason).toBe('too_fast');
    expect(screenPublicSignup({ ...person, formMs: Number.NaN }, { origin: HUB }).reason).toBe('too_fast');
    expect(screenPublicSignup({ ...person, formMs: null }, { origin: HUB }).reason).toBe('too_fast');
  });

  test('the new form with a person-speed time passes without an Origin check', () => {
    expect(screenPublicSignup(person).drop).toBe(false);
  });

  test('other sources need no form time (the portal form, call signups)', () => {
    expect(screenPublicSignup({ email: 'reader@example.com', source: 'public_form' }).drop).toBe(false);
    expect(screenPublicSignup({ email: 'reader@example.com' }).drop).toBe(false);
    expect(screenPublicSignup(undefined).drop).toBe(false);
  });

  test('the log label never echoes free text', () => {
    expect(sourceLabel(person)).toBe('astro-website');
    expect(sourceLabel({ source: 'evil\nline' })).toBe('other');
    expect(sourceLabel(null)).toBe('other');
  });
});

describe('POST /subscribe with the bot check', () => {
  test('a person: row + confirmation email, normal answer', async () => {
    const r = await post(person);
    expect(r).toEqual({ status: 200, body: { success: true, pending: true } });
    expect(subscribeOrResubscribe).toHaveBeenCalledTimes(1);
    expect(sendConfirmationEmail).toHaveBeenCalledTimes(1);
  });

  test('a form built before the check, from a fleet page: row + email as before', async () => {
    const r = await post(oldForm, HUB);
    expect(r.body).toEqual({ success: true, pending: true });
    expect(subscribeOrResubscribe).toHaveBeenCalledTimes(1);
    expect(sendConfirmationEmail).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['hidden field', { ...person, website: 'http://spam.example' }, HUB, 'hidden_field'],
    ['direct post', oldForm, null, 'no_form_timing'],
    ['too fast', { ...person, formMs: 120 }, HUB, 'too_fast'],
  ])('%s: no row, no email, the same answer, one log line without the address', async (_n, body, origin, reason) => {
    const r = await post(body, origin);
    expect(r).toEqual({ status: 200, body: { success: true, pending: true } });
    expect(subscribeOrResubscribe).not.toHaveBeenCalled();
    expect(sendConfirmationEmail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0][0];
    expect(line).toContain(`reason=${reason}`);
    expect(line).not.toContain('reader@example.com');
  });

  test('a dropped signup with a bad address still answers like a real one', async () => {
    const r = await post({ email: 'not-an-email', source: 'astro-website' }, null);
    expect(r).toEqual({ status: 200, body: { success: true, pending: true } });
  });

  test('the portal form source is unchanged: no form time or Origin needed', async () => {
    const r = await post({ email: 'reader@example.com', source: 'public_form' }, null);
    expect(r.body).toEqual({ success: true, pending: true });
    expect(subscribeOrResubscribe).toHaveBeenCalledTimes(1);
  });
});
