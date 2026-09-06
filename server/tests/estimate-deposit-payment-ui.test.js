/** Retired deposit collection: real policy, rendered acceptance, and old return links. */
process.env.JWT_SECRET = 'test-secret';
jest.mock('../models/db', () => jest.fn(() => { throw new Error('Unexpected database access'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/twilio', () => ({}));

const { JSDOM } = require('jsdom');
const { renderPage } = require('../routes/estimate-public');
const { resolveDepositPolicyForEstimate } = require('../services/estimate-deposits');
const db = require('../models/db');

const EST_DATA = {
  result: {
    recurring: { services: [{ name: 'Pest Control', mo: 95 }] },
    oneTime: { items: [] },
    results: { pestTiers: [{ label: 'Quarterly', mo: 95, pa: 285, apps: 4 }] },
  },
};
const TOKEN = 'deposit-retirement-fixture';
const estimate = {
  id: 'estimate-fixture', status: 'sent', customerName: 'Fixture account',
  monthlyTotal: 95, annualTotal: 1140, onetimeTotal: 0, tier: 'Silver',
  existingAppointment: { id: 'visit-fixture', serviceType: 'Pest Control' },
};
let dom;
afterEach(() => {
  const unexpected = dom?.window.unexpectedRequests || [];
  dom?.window.close(); dom = null; jest.clearAllMocks();
  expect(unexpected).toEqual([]);
});

async function renderEstimate(search = '', oneTime = false) {
  const policy = await resolveDepositPolicyForEstimate({ estimate });
  const view = { ...estimate, depositPolicy: policy };
  const data = oneTime ? { result: { recurring: { services: [] }, oneTime: { items: [{ name: 'One-Time Pest Control', total: 280 }] }, results: {} } } : EST_DATA;
  if (oneTime) Object.assign(view, { monthlyTotal: 0, annualTotal: 0, onetimeTotal: 280 });
  const html = renderPage(TOKEN, view, data);
  dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: `https://fixture.invalid/estimate/${TOKEN}${search}` });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  window.unexpectedRequests = [];
  window.fetch = jest.fn(async (url) => {
    if (url === `/api/estimates/${TOKEN}/accept`) {
      return { ok: true, status: 200, json: async () => ({ nextStep: 'pay_invoice', invoicePayUrl: '/pay/invoice-fixture', invoiceAmount: 285 }) };
    }
    if (String(url).includes('/available-slots')) return { ok: true, json: async () => ({ primary: [], alternatives: [] }) };
    if (String(url).startsWith('/api/reviews/featured')) return { ok: true, json: async () => ({ reviews: [] }) };
    window.unexpectedRequests.push(url);
    throw new Error(`Unexpected browser request: ${url}`);
  });
  for (const script of window.document.querySelectorAll('script:not([src])')) {
    if (!script.type || script.type === 'text/javascript') window.eval(script.textContent);
  }
  await new Promise(setImmediate);
  return { html, window, policy };
}

async function confirmExistingAppointment(window, preference) {
  const choice = window.document.querySelector(`[data-pay-pref="${preference}"]`);
  expect(choice).not.toBeNull();
  choice.click();
  expect(window.document.getElementById('review-area').style.display).not.toBe('none');
  window.document.getElementById('confirm-book-btn').click();
  await new Promise(setImmediate);
  const accepts = window.fetch.mock.calls.filter(([url]) => url.endsWith('/accept'));
  expect(accepts).toHaveLength(1);
  expect(window.fetch.mock.calls.some(([url]) => /deposit-(intent|quote|finalize|reset)/.test(url))).toBe(false);
  expect(window.document.getElementById('deposit-overlay')).toBeNull();
  expect(window.document.querySelector('script[src*="js.stripe.com"]')).toBeNull();
  return JSON.parse(accepts[0][1].body);
}

test('real retired policy emits no new collection UI or loader', async () => {
  const { html, policy } = await renderEstimate();
  expect(policy).toEqual({ enforced: false, required: false, slotRequired: false, exemptReason: 'feature_disabled' });
  expect(html).not.toContain('deposit-payment-element');
  expect(html).not.toContain('deposit-due-note');
  expect(html).not.toContain('js.stripe.com/v3/');
  expect(db).not.toHaveBeenCalled();
});

test.each(['pay_at_visit', 'prepay_annual'])('%s acceptance proceeds directly to the invoice action', async (preference) => {
  const { window } = await renderEstimate();
  const payload = await confirmExistingAppointment(window, preference);
  expect(payload).toMatchObject({ existingAppointmentId: 'visit-fixture', paymentMethodPreference: preference, serviceMode: 'recurring' });
  expect(payload).not.toHaveProperty('depositPaymentIntentId');
  expect(window.document.querySelector('a[href="/pay/invoice-fixture"]')).not.toBeNull();
});

test('an annual prepay overlap refusal keeps the appointment and shows the billing explanation', async () => {
  const { window } = await renderEstimate();
  const normalFetch = window.fetch.getMockImplementation();
  window.fetch.mockImplementation((url, options) => url === `/api/estimates/${TOKEN}/accept`
    ? Promise.resolve({
      ok: false, status: 409,
      json: async () => ({ code: 'ANNUAL_PREPAY_OVERLAP', error: 'This account already has an active annual prepay plan. Please call or text us.' }),
    })
    : normalFetch(url, options));

  const payload = await confirmExistingAppointment(window, 'prepay_annual');
  expect(payload).toMatchObject({ existingAppointmentId: 'visit-fixture', paymentMethodPreference: 'prepay_annual' });
  await new Promise(setImmediate);
  const toast = window.document.getElementById('toast');
  expect(toast.textContent).toBe('This account already has an active annual prepay plan. Please call or text us.');
  expect(window.getComputedStyle(toast).opacity).toBe('1');
  // Not a slot conflict: the appointment choice survives and no hold is released.
  expect(window.document.getElementById('review-area').style.display).not.toBe('none');
  expect(window.fetch.mock.calls.some(([url, options]) => /\/reserve\//.test(String(url)) || (options && options.method === 'DELETE'))).toBe(false);
  expect(window.document.getElementById('confirm-book-btn').disabled).toBe(false);
  for (const choice of window.document.querySelectorAll('[data-pay-pref]')) expect(choice.disabled).toBe(false);
  expect(window.document.querySelector('a[href="/pay/invoice-fixture"]')).toBeNull();
  expect(db).not.toHaveBeenCalled();
});

test('one-time acceptance keeps pay-at-visit without collecting a deposit', async () => {
  const { window } = await renderEstimate('', true);
  const payload = await confirmExistingAppointment(window, 'pay_at_visit');
  expect(payload).toMatchObject({ existingAppointmentId: 'visit-fixture', paymentMethodPreference: 'pay_at_visit', serviceMode: 'one_time' });
  expect(payload).not.toHaveProperty('depositPaymentIntentId');
});

test.each(['succeeded', 'failed'])('historical %s return clears payment secrets and preserves unrelated query parameters', async (status) => {
  const { window } = await renderEstimate(`?payment_intent=pi_historical_fixture&payment_intent_client_secret=fixture-secret&redirect_status=${status}&source=return-fixture`);
  expect(window.location.search).toBe('?source=return-fixture');
  const payload = await confirmExistingAppointment(window, 'pay_at_visit');
  if (status === 'succeeded') expect(payload.depositPaymentIntentId).toBe('pi_historical_fixture');
  else expect(payload).not.toHaveProperty('depositPaymentIntentId');
});

test('an older accept server can reject a historical deposit without restarting collection or stranding controls', async () => {
  const { window } = await renderEstimate('?payment_intent=pi_historical_fixture&redirect_status=succeeded');
  const normalFetch = window.fetch.getMockImplementation();
  let respondToAccept;
  const pendingAccept = new Promise((resolve) => { respondToAccept = resolve; });
  window.fetch.mockImplementation((url, options) => url === `/api/estimates/${TOKEN}/accept`
    ? pendingAccept : normalFetch(url, options));

  const firstPayload = await confirmExistingAppointment(window, 'pay_at_visit');
  expect(firstPayload.depositPaymentIntentId).toBe('pi_historical_fixture');
  const confirm = window.document.getElementById('confirm-book-btn');
  const choices = [...window.document.querySelectorAll('[data-pay-pref]')];
  expect(choices.length).toBeGreaterThan(0);
  expect(confirm.disabled).toBe(true);
  for (const choice of choices) expect(choice.disabled).toBe(true);

  respondToAccept({
    ok: false, status: 402,
    json: async () => ({ code: 'DEPOSIT_REQUIRED', error: 'Fixture overlap rejection' }),
  });
  await new Promise(setImmediate);
  const toast = window.document.getElementById('toast');
  expect(toast.textContent).toBe('Fixture overlap rejection');
  expect(window.getComputedStyle(toast).opacity).toBe('1');
  expect(confirm.disabled).toBe(false);
  for (const choice of choices) expect(choice.disabled).toBe(false);
  expect(window.document.querySelector('a[href="/pay/invoice-fixture"]')).toBeNull();
  expect(window.fetch.mock.calls.filter(([url]) => url.endsWith('/accept'))).toHaveLength(1);

  // A deliberate second click can proceed, but the rejected historical PI
  // must not be resubmitted. No automatic retry or new collection is allowed.
  window.fetch.mockImplementation(normalFetch);
  confirm.click();
  await new Promise(setImmediate);
  const accepts = window.fetch.mock.calls.filter(([url]) => url.endsWith('/accept'));
  expect(accepts).toHaveLength(2);
  const retryPayload = JSON.parse(accepts[1][1].body);
  expect(retryPayload).toMatchObject({
    existingAppointmentId: 'visit-fixture', paymentMethodPreference: 'pay_at_visit', serviceMode: 'recurring',
  });
  expect(retryPayload).not.toHaveProperty('depositPaymentIntentId');
  expect(window.document.querySelector('a[href="/pay/invoice-fixture"]')).not.toBeNull();
  expect(window.fetch.mock.calls.some(([url]) => /deposit-(intent|quote|finalize|reset)/.test(url))).toBe(false);
  expect(window.document.getElementById('deposit-overlay')).toBeNull();
  expect(window.document.querySelector('script[src*="js.stripe.com"]')).toBeNull();
  expect(db).not.toHaveBeenCalled();
});
