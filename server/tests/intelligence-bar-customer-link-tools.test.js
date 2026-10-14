/**
 * Intelligence Bar customer-link tool — the composer's Insert Link kinds as a
 * carded write, plus the send-side guard.
 *
 * Observable behavior pinned here:
 *   - create_customer_link previews from the customer row alone and never
 *     touches the composer handler; the confirmed run calls the exported
 *     handler with the row's OWN phone and reports its 200 body, or its
 *     plain-reason refusal as a blocked result (nothing sent either way).
 *   - The bar's text senders refuse a body carrying an Auto Pay link or a
 *     composer-recorded bearer (card request, contract, prep, statement,
 *     project report, consultation), pass a verified-only bearer and a plain
 *     text, and fail closed when the check cannot run.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-communications', () => ({
  customerLinkInsert: jest.fn(),
  rescheduleLinkInsert: jest.fn(),
  reserviceLinkInsert: jest.fn(),
}));
jest.mock('../services/autopay-setup-link', () => ({
  setupLinkIneligibility: jest.fn(),
  findSavedMethodForAutoSecure: jest.fn(),
  setupLinkReuse: jest.fn(),
  autopayDeliveryPreflight: jest.fn(),
  requestAutopaySetupLink: jest.fn(),
}));
jest.mock('../services/composer-customer-links', () => ({
  AUTOPAY_SKIP_REASONS: jest.requireActual('../services/composer-customer-links').AUTOPAY_SKIP_REASONS,
  autopayLinkSendCheck: jest.fn(),
  bearerLinkSendCheck: jest.fn(),
  composerOnlyLinkPresence: jest.fn(async () => ({ present: false, kinds: [] })),
  linkOwnersInBody: jest.fn(async () => ({ owners: [], unresolved: [] })),
  // The real scanner: send_email_reply's rendered text surfaces nested links through it.
  nestedOwnedLinkRuns: jest.requireActual('../services/composer-customer-links').nestedOwnedLinkRuns,
  wrappedOwnedLinkIn: jest.requireActual('../services/composer-customer-links').wrappedOwnedLinkIn,
  linkTextUnstable: jest.requireActual('../services/composer-customer-links').linkTextUnstable,
}));

const db = require('../models/db');
const routeExports = require('../routes/admin-communications');
const autopay = require('../services/autopay-setup-link');
const links = require('../services/composer-customer-links');
const { CUSTOMER_LINK_TOOLS, executeCustomerLinkTool } = require('../services/intelligence-bar/customer-link-tools');

const CUSTOMER_ID = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';
const CUSTOMER = {
  id: CUSTOMER_ID, first_name: 'Customer', last_name: 'Fixture', phone: '+19415550123', email: 'fixture@example.com',
};

function wireCustomer(row = CUSTOMER) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.first = jest.fn(async () => row);
  db.mockImplementation((table) => (table === 'customers' ? b : { where: () => b, first: async () => null }));
  return b;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockReset();
});

describe('tool definitions', () => {
  test('the tool is side-effect flagged, admin-only in the executor, and offers every Insert Link kind the bar builds', () => {
    const byName = Object.fromEntries(CUSTOMER_LINK_TOOLS.map((t) => [t.name, t]));
    expect(Object.keys(byName)).toEqual(['create_customer_link', 'send_autopay_setup_link']);
    expect(byName.create_customer_link._sideEffects).toBe(true);
    expect(byName.send_autopay_setup_link._sideEffects).toBe(true);
    // No link-only mode from the bar: sms or email, and the description says where a link-only link lives.
    expect(byName.send_autopay_setup_link.input_schema.properties.delivery.enum).toEqual(['sms', 'email']);
    expect(byName.send_autopay_setup_link.description).toMatch(/link-only Auto Pay link .* stays on the Customers page/);
    expect(byName.send_autopay_setup_link.description).toMatch(/saved card .* billing change/);
    expect(byName.create_customer_link.input_schema.properties.kind.enum).toEqual([
      'reschedule', 'reservice', 'pay_balance', 'estimate', 'referral', 'consultation', 'appointment',
      'prep_guide', 'service_report', 'receipt', 'project_report',
    ]);
    expect(byName.create_customer_link.input_schema.properties.kind.enum).not.toContain('contract');
    expect(byName.create_customer_link.input_schema.properties.kind.enum).not.toContain('statement');
    expect(byName.create_customer_link.input_schema.properties.kind.enum).not.toContain('review_request');
    expect(byName.create_customer_link.input_schema.properties.kind.enum).not.toContain('autopay_setup');
    expect(byName.create_customer_link.input_schema.properties.kind.enum).not.toContain('card_request');
  });

  test('a technician token is refused before any read', async () => {
    const result = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'referral' }, { isAdmin: false });
    expect(result).toMatchObject({ code: 'permission_denied' });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('create_customer_link', () => {
  test('unconfirmed: a preview from the customer row, no handler call', async () => {
    wireCustomer();
    const preview = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'pay_balance' }, { isAdmin: true });
    expect(preview).toMatchObject({
      preview: true, kind: 'pay_balance', label: 'Pay balance link', customer_id: CUSTOMER_ID, customer_name: 'Customer Fixture', phone: '***0123',
      _version: { customer_id: CUSTOMER_ID, kind: 'pay_balance', phone_last10: '9415550123' },
    });
    expect(preview.send_how).toMatch(/send_sms/);
    expect(routeExports.customerLinkInsert).not.toHaveBeenCalled();
  });

  test('the reschedule card discloses the office-approval write inside the notice window', async () => {
    wireCustomer();
    const preview = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'reschedule' }, { isAdmin: true });
    expect(preview.preview).toBe(true);
    expect(preview.builds).toMatch(/records the office's approval for the customer to move it/);
  });

  test('composer-only kinds say so on the card', async () => {
    wireCustomer();
    const preview = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'prep_guide' }, { isAdmin: true });
    expect(preview.preview).toBe(true);
    expect(preview.send_how).toMatch(/Communications composer/);
    expect(preview.send_how).toMatch(/send_sms refuses/);
  });

  test('an unknown kind, a missing customer, or a customer without a full phone is refused before the gate', async () => {
    wireCustomer();
    expect((await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'review_request' }, { isAdmin: true })).code).toBe('invalid_target');
    wireCustomer(null);
    expect((await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'referral' }, { isAdmin: true })).code).toBe('customer_not_found');
    wireCustomer({ ...CUSTOMER, phone: '555' });
    expect((await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'referral' }, { isAdmin: true })).code).toBe('no_phone');
    expect((await executeCustomerLinkTool('create_customer_link', { customer_id: 'not-a-uuid', kind: 'referral' }, { isAdmin: true })).code).toBe('invalid_target');
  });

  const LINK_PIN = { customer_id: CUSTOMER_ID, kind: 'pay_balance', phone_last10: '9415550123' };

  test('confirmed: a missing or stale pin never reaches the handler', async () => {
    wireCustomer();
    expect(await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'pay_balance', confirmed: true }, { isAdmin: true }))
      .toEqual({ error: 'Use the confirmation card to approve this change.' });
    wireCustomer({ ...CUSTOMER, phone: '+19415559999' });
    const stale = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'pay_balance', confirmed: true, _verified_link_version: LINK_PIN }, { isAdmin: true });
    expect(stale).toMatchObject({ preview_changed: true });
    expect(routeExports.customerLinkInsert).not.toHaveBeenCalled();
  });

  test('card_request is composer-only: not an offered kind, and a call for it is refused before any read or build', async () => {
    wireCustomer();
    for (const input of [{}, { confirmed: true, _verified_link_version: { customer_id: CUSTOMER_ID, kind: 'card_request', phone_last10: '9415550123' } }]) {
      const result = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'card_request', ...input }, { isAdmin: true });
      expect(result).toMatchObject({ code: 'invalid_target' });
      expect(result.error).toMatch(/kind must be one of/);
      expect(result.error).not.toMatch(/card_request/);
    }
    expect(routeExports.customerLinkInsert).not.toHaveBeenCalled();
    const tool = CUSTOMER_LINK_TOOLS.find((t) => t.name === 'create_customer_link');
    expect(tool.input_schema.properties.kind.enum).not.toContain('card_request');
    expect(tool.description).toMatch(/card request links \(the Communications composer \/ visit card only/);
    // The preview carries no enrollment keys for any kind.
    const preview = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'pay_balance' }, { isAdmin: true });
    expect(preview).not.toHaveProperty('auto_secure');
    expect(preview).not.toHaveProperty('enrollment_email');
    expect(preview).not.toHaveProperty('notifies_customer');
    expect(preview._version).toEqual({ customer_id: CUSTOMER_ID, kind: 'pay_balance', phone_last10: '9415550123' });
  });

  test('confirmed: a handler 500 (or no answer) is an unknown outcome, never a definite refusal; a 4xx stays a refusal', async () => {
    wireCustomer();
    const run = () => executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'pay_balance', confirmed: true, _verified_link_version: LINK_PIN }, { isAdmin: true });
    for (const answer of [{ status: 500, body: { error: 'Failed to build link' } }, { status: 503, body: {} }, undefined]) {
      routeExports.customerLinkInsert.mockResolvedValue(answer);
      const result = await run();
      expect(result).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
      expect(result.blocked).toBeUndefined();
    }
    routeExports.customerLinkInsert.mockResolvedValue({ status: 404, body: { error: 'No open balance' } });
    expect(await run()).toMatchObject({ blocked: true, error: 'No open balance', code: 'link_404' });
  });

  test('confirmed: runs the composer handler with the row\'s own phone and reports its body; nothing is sent', async () => {
    wireCustomer();
    routeExports.customerLinkInsert.mockResolvedValue({ status: 200, body: {
      kind: 'pay_balance', url: 'portal.wavespestcontrol.com/l/py222',
      line: 'You can view and pay your balance securely here: portal.wavespestcontrol.com/l/py222\n\n',
      balance: { total: 184, count: 2 }, firstName: 'Customer', customerId: undefined,
    } });
    const result = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'pay_balance', confirmed: true, _verified_link_version: LINK_PIN }, { isAdmin: true });
    expect(routeExports.customerLinkInsert).toHaveBeenCalledWith({ phone: '+19415550123', customerId: CUSTOMER_ID, kind: 'pay_balance' });
    expect(result).toMatchObject({
      success: true, sent: false, kind: 'pay_balance', url: 'portal.wavespestcontrol.com/l/py222',
      line: 'You can view and pay your balance securely here: portal.wavespestcontrol.com/l/py222',
      balance: { total: 184, count: 2 },
    });
    expect(result.firstName).toBeUndefined();
  });

  test('confirmed: reschedule and re-service kinds run their own handlers', async () => {
    wireCustomer();
    routeExports.rescheduleLinkInsert.mockResolvedValue({ status: 200, body: { url: 'portal.wavespestcontrol.com/l/rs1', line: 'Move it here: portal.wavespestcontrol.com/l/rs1\n\n', appointment: { id: 'svc-1' } } });
    const moved = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'reschedule', confirmed: true, _verified_link_version: { ...LINK_PIN, kind: 'reschedule' } }, { isAdmin: true });
    expect(routeExports.rescheduleLinkInsert).toHaveBeenCalledWith({ phone: '+19415550123', customerId: CUSTOMER_ID, kind: 'reschedule' });
    expect(moved).toMatchObject({ success: true, appointment: { id: 'svc-1' } });

    wireCustomer();
    routeExports.reserviceLinkInsert.mockResolvedValue({ status: 200, body: { url: 'portal.wavespestcontrol.com/l/rv1', line: 'Book it: portal.wavespestcontrol.com/l/rv1\n\n', lanes: ['pest'] } });
    const again = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'reservice', confirmed: true, _verified_link_version: { ...LINK_PIN, kind: 'reservice' } }, { isAdmin: true });
    expect(routeExports.reserviceLinkInsert).toHaveBeenCalled();
    expect(again).toMatchObject({ success: true, lanes: ['pest'] });
  });

  test('confirmed: the handler\'s plain reason comes back as a blocked result', async () => {
    wireCustomer();
    routeExports.customerLinkInsert.mockResolvedValue({ status: 404, body: { error: 'No open balance on this account' } });
    const result = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'pay_balance', confirmed: true, _verified_link_version: LINK_PIN }, { isAdmin: true });
    expect(result).toMatchObject({ error: 'No open balance on this account', blocked: true, code: 'link_404' });
    expect(result.success).toBeUndefined();
  });

  test('confirmed: a thrown handler is an unknown outcome (writes may have committed), never a retry invitation', async () => {
    wireCustomer();
    routeExports.customerLinkInsert.mockRejectedValue(new Error('boom'));
    const result = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'pay_balance', confirmed: true, _verified_link_version: LINK_PIN }, { isAdmin: true });
    expect(result).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    expect(result.error).toMatch(/may or may not have been built/);
  });
});

describe('send_autopay_setup_link', () => {
  const AP_CUSTOMER = { id: CUSTOMER_ID, first_name: 'Customer', last_name: 'Fixture', phone: '+19415550123', email: 'Fixture@Example.com ', billing_mode: 'per_application' };
  const SMS_PIN = { customer_id: CUSTOMER_ID, delivery: 'sms', phone_last10: '9415550123', link_expires_at: null };
  const EMAIL_PIN = { customer_id: CUSTOMER_ID, delivery: 'email', email: 'fixture@example.com', link_expires_at: null };
  const BEARER = 'https://portal.wavespestcontrol.com/secure/AbCdEfGhIjKlMnOpQrSt';
  const run = (input, ctx = { isAdmin: true }) => executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID, ...input }, ctx);

  beforeEach(() => {
    autopay.setupLinkIneligibility.mockResolvedValue({ reason: null, customer: AP_CUSTOMER });
    autopay.findSavedMethodForAutoSecure.mockResolvedValue(null);
    autopay.autopayDeliveryPreflight.mockResolvedValue({ ok: true });
    autopay.setupLinkReuse.mockResolvedValue({ state: 'new', expiresAt: null });
    autopay.requestAutopaySetupLink.mockResolvedValue({ requested: true, action: 'sent', reason: 'sent', channel: 'sms', secureUrl: BEARER, expiresAt: '2026-11-12T00:00:00Z' });
  });

  test('a technician token is refused before any read', async () => {
    expect(await run({}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    expect(autopay.setupLinkIneligibility).not.toHaveBeenCalled();
  });

  test('preview: a bad delivery (inline included) or customer id is refused before the service is read', async () => {
    for (const delivery of ['inline', 'carrier pigeon']) {
      expect(await run({ delivery })).toMatchObject({ code: 'invalid_target' });
    }
    expect(await run({ customer_id: 'not-a-uuid' })).toMatchObject({ code: 'invalid_target' });
    expect(autopay.setupLinkIneligibility).not.toHaveBeenCalled();
  });

  test.each([
    ['autopay_already_active', 'This customer is already on Auto Pay'],
    ['autopay_paused', /already set up but paused/],
    ['payer_billed', /third-party payer/],
    ['unsupported_billing_lane', /per-visit and per-application/],
    ['gate_off', /switched off/],
    ['customer_not_found', 'Customer not found'],
  ])('preview: the service\'s eligibility reason %s is refused in the operator\'s words, before the card or the channel is read', async (reason, words) => {
    autopay.setupLinkIneligibility.mockResolvedValue({ reason });
    const refused = await run({});
    expect(refused).toMatchObject({ blocked: true, code: reason });
    expect(refused.error).toMatch(words);
    expect(autopay.findSavedMethodForAutoSecure).not.toHaveBeenCalled();
    expect(autopay.autopayDeliveryPreflight).not.toHaveBeenCalled();
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();
  });

  test('preview: a customer with a consented saved card is refused — the bar never enrolls one — and the channel is never read', async () => {
    autopay.findSavedMethodForAutoSecure.mockResolvedValue({ id: 'pm-1', stripe_payment_method_id: 'pm_synthetic' });
    for (const delivery of ['sms', 'email']) {
      const refused = await run({ delivery });
      expect(refused).toMatchObject({ blocked: true, code: 'saved_method_available' });
      expect(refused.error).toBe('This customer has a saved card on file. Enrolling it turns Auto Pay on for the account, which is a billing change the bar does not make — do it from the Customers page.');
    }
    expect(autopay.autopayDeliveryPreflight).not.toHaveBeenCalled();
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();
    expect(JSON.stringify(autopay.findSavedMethodForAutoSecure.mock.calls)).toBe(JSON.stringify([[CUSTOMER_ID], [CUSTOMER_ID]]));
  });

  test.each([
    ['sms', 'no_customer_phone', 'This customer has no phone number on file — nothing to text.'],
    ['sms', 'autopay_sms_gate_off', 'Auto Pay customer texts are switched off (GATE_AUTOPAY_CUSTOMER_SMS)'],
    ['sms', 'template_inactive', 'The Auto Pay setup text is inactive in Templates — activate it before texting a setup link'],
    ['sms', 'sms_policy_check_uncertain', "Could not read this customer's texting consent or suppression state — try again in a moment"],
    ['sms', 'sms_line_type_check_uncertain', 'Could not check whether this number can receive texts — try again in a moment'],
    ['sms', 'Recipient is suppressed (reason: opt_out_keyword)', 'The Auto Pay setup link was not sent: Recipient is suppressed (reason: opt_out_keyword)'],
    ['email', 'no_customer_email', 'This customer has no valid email address on file — nothing to email.'],
    ['email', 'email_opted_out', 'This customer has opted out of email — nothing to email.'],
    ['email', 'email_prefs_check_uncertain', "Could not read this customer's email preference — try again in a moment"],
    ['email', 'email_template_inactive', 'The Auto Pay setup email is inactive in Email Templates — activate it before emailing a setup link.'],
    ['email', 'email_template_check_uncertain', 'Could not check the Auto Pay setup email template — try again in a moment'],
    ['email', 'Suppressed: bounce', 'The Auto Pay setup link was not sent: Suppressed: bounce'],
  ])('preview (%s): the service\'s delivery preflight reason "%s" is refused in the operator\'s words', async (delivery, reason, words) => {
    autopay.autopayDeliveryPreflight.mockResolvedValue({ ok: false, reason });
    expect(await run({ delivery })).toMatchObject({ blocked: true, error: words });
    expect(autopay.autopayDeliveryPreflight).toHaveBeenCalledWith({ customerId: CUSTOMER_ID, customer: AP_CUSTOMER, delivery, trigger: 'admin' });
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();
  });

  test('preview: a text needs a full 10-digit US number (the pin is the last ten digits)', async () => {
    autopay.setupLinkIneligibility.mockResolvedValue({ reason: null, customer: { ...AP_CUSTOMER, phone: '555-0123' } });
    expect(await run({ delivery: 'sms' })).toMatchObject({ blocked: true, code: 'no_customer_phone' });
    expect(autopay.autopayDeliveryPreflight).not.toHaveBeenCalled();
  });

  test('preview: an unexpired existing setup link is RE-SENT as it is — the card says so, with its expiry in ET, and pins it', async () => {
    const expires = new Date(Date.now() + 9 * 24 * 3600 * 1000);
    autopay.setupLinkReuse.mockResolvedValue({ state: 'reuse', expiresAt: expires });
    const sms = await run({});
    expect(sms).toMatchObject({ preview: true, link: 'existing', _version: { ...SMS_PIN, link_expires_at: expires.toISOString() } });
    expect(sms.does).toMatch(/^re-sends the customer's existing Auto Pay setup link, which expires [A-Z][a-z]+ \d{1,2} at \d{1,2}:\d{2} [AP]M ET, by text to \*\*\*0123/);
    const email = await run({ delivery: 'email' });
    expect(email.does).toMatch(/by email to f•••@example\.com/);
    expect(email._version.link_expires_at).toBe(expires.toISOString());
  });

  test('preview: an existing link that expires within 24 hours is refused — it would reach the customer nearly dead — and a link mid-completion is held', async () => {
    autopay.setupLinkReuse.mockResolvedValue({ state: 'reuse', expiresAt: new Date(Date.now() + 3 * 3600 * 1000) });
    const soon = await run({});
    expect(soon).toMatchObject({ blocked: true, code: 'existing_link_expiring' });
    expect(soon.error).toMatch(/^The customer's existing Auto Pay setup link expires .* ET, too soon to re-send\. Once it expires, send again and a fresh 30-day link is created\.$/);
    // Just over 24 hours is fine.
    autopay.setupLinkReuse.mockResolvedValue({ state: 'reuse', expiresAt: new Date(Date.now() + 25 * 3600 * 1000) });
    expect((await run({})).preview).toBe(true);
    autopay.setupLinkReuse.mockResolvedValue({ state: 'completing', expiresAt: null });
    expect(await run({})).toMatchObject({ blocked: true, code: 'completion_in_progress' });
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();
  });

  test('confirmed: the link the card described is pinned — an expiry that changed (new link now, a different one, a lapsed one) refuses before the service', async () => {
    const expires = new Date(Date.now() + 9 * 24 * 3600 * 1000);
    autopay.setupLinkReuse.mockResolvedValue({ state: 'reuse', expiresAt: expires });
    const card = await run({});
    expect(await run({ confirmed: true, _verified_autopay_version: card._version })).toMatchObject({ success: true });
    autopay.requestAutopaySetupLink.mockClear();
    // The existing link lapsed after the card: a new one would be minted — not what the card said.
    autopay.setupLinkReuse.mockResolvedValue({ state: 'new', expiresAt: null });
    expect(await run({ confirmed: true, _verified_autopay_version: card._version })).toMatchObject({ preview_changed: true });
    // ...and the other way round: a card for a new link, an existing one appeared.
    autopay.setupLinkReuse.mockResolvedValue({ state: 'reuse', expiresAt: expires });
    expect(await run({ confirmed: true, _verified_autopay_version: SMS_PIN })).toMatchObject({ preview_changed: true });
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();
  });

  test('preview: the clean card for a text (the default) and for an email — masked recipient, pin, notifies the customer, no link', async () => {
    const sms = await run({});
    expect(sms).toMatchObject({
      preview: true, delivery: 'sms', customer_name: 'Customer Fixture', recipient: '***0123', reaches: 'text to ***0123', notifies_customer: true,
      _version: SMS_PIN,
    });
    expect(sms).toMatchObject({ link: 'new' });
    expect(sms.does).toMatch(/creates a new Auto Pay setup link, valid 30 days, and texts it to \*\*\*0123/);
    const email = await run({ delivery: 'email' });
    expect(email).toMatchObject({
      preview: true, delivery: 'email', recipient: 'f•••@example.com', reaches: 'email to f•••@example.com', notifies_customer: true,
      _version: EMAIL_PIN,
    });
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();
    // The card text never carries the link or the unmasked contact (only the pin, which the route keeps off the card).
    const { _version: _a, ...smsCard } = sms;
    const { _version: _b, ...emailCard } = email;
    expect(JSON.stringify([smsCard, emailCard])).not.toMatch(/secure|9415550123|fixture@example/i);
  });

  test('confirmed: a missing pin or a contact changed since the card never reaches the service', async () => {
    expect(await run({ confirmed: true })).toEqual({ error: 'Use the confirmation card to approve this change.' });
    expect(await run({ confirmed: true, _verified_autopay_version: { ...SMS_PIN, phone_last10: '9415559999' } })).toMatchObject({ preview_changed: true });
    expect(await run({ confirmed: true, delivery: 'email', _verified_autopay_version: { ...EMAIL_PIN, email: 'old@example.com' } })).toMatchObject({ preview_changed: true });
    expect(await run({ confirmed: true, delivery: 'email', _verified_autopay_version: SMS_PIN })).toMatchObject({ preview_changed: true });
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();
  });

  test('confirmed: re-reads the service checks, then makes ONE call with exactly the guarded options and the recipient the card showed', async () => {
    const sent = await run({ confirmed: true, _verified_autopay_version: SMS_PIN });
    expect(autopay.requestAutopaySetupLink).toHaveBeenCalledTimes(1);
    expect(autopay.requestAutopaySetupLink).toHaveBeenCalledWith({
      customerId: CUSTOMER_ID, delivery: 'sms', trigger: 'admin', requireDeliverable: true, allowAutoSecure: false, expectedRecipient: { phoneLast10: '9415550123' },
    });
    expect(sent).toMatchObject({ success: true, sent: true, channel: 'sms', recipient: '***0123', expires_at: '2026-11-12T00:00:00Z' });

    autopay.requestAutopaySetupLink.mockClear();
    autopay.requestAutopaySetupLink.mockResolvedValue({ requested: true, action: 'sent', channel: 'email', secureUrl: BEARER });
    const mailed = await run({ delivery: 'email', confirmed: true, _verified_autopay_version: EMAIL_PIN });
    expect(autopay.requestAutopaySetupLink).toHaveBeenCalledWith({
      customerId: CUSTOMER_ID, delivery: 'email', trigger: 'admin', requireDeliverable: true, allowAutoSecure: false, expectedRecipient: { email: 'fixture@example.com' },
    });
    expect(mailed).toMatchObject({ success: true, channel: 'email', recipient: 'f•••@example.com' });
    expect(mailed.summary).toMatch(/sent by email to f•••@example.com/);
  });

  test('confirmed: a state that turned ineligible, got a saved card, or cannot deliver now is refused before the service', async () => {
    autopay.findSavedMethodForAutoSecure.mockResolvedValue({ id: 'pm-1' });
    expect(await run({ confirmed: true, _verified_autopay_version: SMS_PIN })).toMatchObject({ blocked: true, code: 'saved_method_available' });
    autopay.findSavedMethodForAutoSecure.mockResolvedValue(null);
    autopay.autopayDeliveryPreflight.mockResolvedValue({ ok: false, reason: 'email_opted_out' });
    expect(await run({ delivery: 'email', confirmed: true, _verified_autopay_version: EMAIL_PIN })).toMatchObject({ blocked: true, code: 'email_opted_out' });
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();
  });

  test.each([
    ['recipient_changed', /phone number or email changed after the card was shown/],
    ['saved_method_available', /saved card on file/],
    ['template_inactive', /inactive in Templates/],
    ['autopay_sms_gate_off', /switched off/],
    ['completion_in_progress', /finishing an Auto Pay setup right now/],
    ['Recipient is suppressed (reason: opt_out_keyword)', /was not sent: Recipient is suppressed/],
  ])('confirmed: a service skip "%s" is a definite refusal — nothing was sent', async (reason, words) => {
    autopay.requestAutopaySetupLink.mockResolvedValue({ requested: false, action: 'skipped', reason, secureUrl: BEARER, expiresAt: 'x' });
    const refused = await run({ confirmed: true, _verified_autopay_version: SMS_PIN });
    expect(refused).toMatchObject({ blocked: true, sent: false });
    expect(refused.error).toMatch(words);
    expect(refused.outcome_unknown).toBeUndefined();
    expect(JSON.stringify(refused)).not.toMatch(/secure\/|AbCdEf/);
  });

  test.each(['send_outcome_uncertain', 'request_failed'])('confirmed: "%s" is an unknown outcome — check the customer\'s messages before trying again', async (reason) => {
    autopay.requestAutopaySetupLink.mockResolvedValue({ requested: false, action: 'skipped', reason, secureUrl: BEARER });
    const result = await run({ confirmed: true, _verified_autopay_version: SMS_PIN });
    expect(result).toMatchObject({ outcome_unknown: true, code: reason });
    expect(result.error).toMatch(/Check the customer's messages before trying again/);
    expect(JSON.stringify(result)).not.toMatch(/secure\/|AbCdEf/);
  });

  test('confirmed: a throw after approval is an unknown outcome, never a retry invitation; an unexpected link_created / auto_secured is a refusal', async () => {
    autopay.requestAutopaySetupLink.mockRejectedValue(new Error('provider down'));
    expect(await run({ confirmed: true, _verified_autopay_version: SMS_PIN })).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    for (const action of ['link_created', 'auto_secured']) {
      autopay.requestAutopaySetupLink.mockResolvedValue({ requested: true, action, secureUrl: BEARER });
      const odd = await run({ confirmed: true, _verified_autopay_version: SMS_PIN });
      expect(odd).toMatchObject({ blocked: true, sent: false });
      expect(odd.success).toBeUndefined();
      expect(JSON.stringify(odd)).not.toMatch(/secure\/|AbCdEf/);
    }
  });

  test('an unreadable service check on the preview is not a card (fail closed)', async () => {
    autopay.findSavedMethodForAutoSecure.mockRejectedValue(new Error('db down'));
    expect(await run({})).toEqual({ error: 'Could not prepare the Auto Pay setup link' });
    expect(autopay.autopayDeliveryPreflight).not.toHaveBeenCalled();
  });
});

describe('customerLinkSendRefusal (comms-tools)', () => {
  const { customerLinkSendRefusal } = require('../services/intelligence-bar/comms-tools');

  beforeEach(() => {
    links.composerOnlyLinkPresence.mockResolvedValue({ present: false, kinds: [] });
    links.linkOwnersInBody.mockResolvedValue({ owners: [], unresolved: [] });
  });

  test('a generated bearer must belong to the recipient\'s account, in both phases', async () => {
    links.autopayLinkSendCheck.mockResolvedValue({ present: false });
    links.bearerLinkSendCheck.mockResolvedValue({ ok: true });
    const OTHER = '7a7a7a7a-1111-4111-8111-111111111111';
    const rows = { [CUSTOMER_ID]: { id: CUSTOMER_ID, account_id: null }, [OTHER]: { id: OTHER, account_id: null } };
    db.mockImplementation(() => {
      const b = {}; let ids = [];
      b.where = (w) => { ids = [w.id]; return b; };
      b.whereIn = (_c, list) => { ids = list; return b; };
      b.first = async () => rows[ids[0]] || null;
      b.select = async () => ids.map((id) => rows[id]).filter(Boolean);
      return b;
    });
    links.linkOwnersInBody.mockResolvedValue({ owners: [{ kind: 'pay', token: 'tok', customerId: OTHER }], unresolved: [] });
    const foreign = await customerLinkSendRefusal('Pay here: portal.wavespestcontrol.com/pay/tok', '+19415550123', CUSTOMER_ID, { phase: 'proposal' });
    expect(foreign).toMatchObject({ blocked: true, code: 'customer_link_owner_mismatch' });
    expect(links.bearerLinkSendCheck).not.toHaveBeenCalled();

    links.linkOwnersInBody.mockResolvedValue({ owners: [{ kind: 'pay', token: 'tok', customerId: CUSTOMER_ID }], unresolved: [] });
    expect(await customerLinkSendRefusal('Pay here: portal.wavespestcontrol.com/pay/tok', '+19415550123', CUSTOMER_ID)).toBeNull();
    expect(await customerLinkSendRefusal('Pay here: portal.wavespestcontrol.com/pay/tok', '+19415550123', null)).toMatchObject({ code: 'customer_link_recipient' });
    // A non-US number that shares the customer's last ten digits matched the same customer row: the customer's own
    // link is still refused, at the card and at the send (the seam's non-US refusal does not count these links).
    for (const phase of ['proposal', 'commit']) {
      const abroad = await customerLinkSendRefusal('Pay here: portal.wavespestcontrol.com/pay/tok', '+449415550123', CUSTOMER_ID, { phase });
      expect(abroad).toMatchObject({ blocked: true, code: 'customer_link_recipient', sent_to: '***0123' });
      expect(abroad.error).toMatch(/US numbers only/);
    }
    // A portal link wrapped inside another site's URL (raw or percent-encoded) never rides a text: the checks above
    // would read it as one foreign link.
    for (const phase of ['proposal', 'commit']) {
      for (const wrappedBody of [
        'See https://other.example/?next=https://portal.wavespestcontrol.com/pay/tok',
        'See https://other.example/?next=https%3A%2F%2Fportal.wavespestcontrol.com%2Fpay%2Ftok',
        'See other.example/go#portal.wavespestcontrol.com/pay/tok',
        // The portal link in the userinfo: the real host is other.example, whatever the text prefix says.
        'See https://portal.wavespestcontrol.com%2Fpay%2Ftok@other.example/',
        'See https://portal.wavespestcontrol.com%2Fpay%2Ftok%40other.example/',
      ]) {
        expect(await customerLinkSendRefusal(wrappedBody, '+19415550123', CUSTOMER_ID, { phase })).toMatchObject({ blocked: true, code: 'customer_link_refused' });
      }
    }
    // The link as itself (bare, with a scheme, in brackets, at a sentence end) and a foreign link are not wrapped.
    for (const plainBody of ['Pay: portal.wavespestcontrol.com/pay/tok', 'Pay: https://portal.wavespestcontrol.com/pay/tok.', 'Pay (https://portal.wavespestcontrol.com/pay/tok)', 'Map: https://other.example/?q=1']) {
      expect(await customerLinkSendRefusal(plainBody, '+19415550123', CUSTOMER_ID, { phase: 'proposal' })).toBeNull();
    }
    // A plain text to that number, and an email reply (no phone), are not judged by it.
    links.linkOwnersInBody.mockResolvedValue({ owners: [], unresolved: [] });
    expect(await customerLinkSendRefusal('Running late, sorry!', '+449415550123', CUSTOMER_ID, { phase: 'proposal' })).toBeNull();
    links.linkOwnersInBody.mockResolvedValue({ owners: [{ kind: 'pay', token: 'tok', customerId: CUSTOMER_ID }], unresolved: [] });
    expect(await customerLinkSendRefusal('Pay here: portal.wavespestcontrol.com/pay/tok', '', CUSTOMER_ID, { phase: 'email' })).toBeNull();

    links.linkOwnersInBody.mockResolvedValue({ owners: [], unresolved: [{ kind: 'estimate', token: 'gone' }] });
    expect(await customerLinkSendRefusal('See: portal.wavespestcontrol.com/estimate/gone', '+19415550123', CUSTOMER_ID)).toMatchObject({ code: 'customer_link_unverified' });
  });

  describe('a portal host broken by a URL-dropped character (TAB, CR, LF)', () => {
    const TOKEN = 'AbCdEfGhIjKlMnOpQrSt';
    test.each([['%09'], ['%0A'], ['%0D'], ['%2509']])('inside a foreign URL (%s): refused in both SMS phases and the email phase', async (esc) => {
      links.autopayLinkSendCheck.mockResolvedValue({ present: false });
      links.bearerLinkSendCheck.mockResolvedValue({ ok: true });
      const body = `See https://other.example/?next=https://port${esc}al.wavespestcontrol.com/pay/${TOKEN}`;
      for (const phase of ['proposal', 'commit']) {
        expect(await customerLinkSendRefusal(body, '+19415550123', CUSTOMER_ID, { phase })).toMatchObject({ blocked: true, code: 'customer_link_refused' });
      }
      // The email path: the rendered text surfaces the nested portal link as its own run, and the owned-link refusal sees it.
      const { renderedTextForLinkCheck } = require('../services/intelligence-bar/email-tools');
      expect(renderedTextForLinkCheck(body).split(/\s+/)).toContain(`portal.wavespestcontrol.com/pay/${TOKEN}`);
      links.composerOnlyLinkPresence.mockResolvedValue({ present: true, kinds: ['portal_link'] });
      expect(await customerLinkSendRefusal(renderedTextForLinkCheck(body), '', null, { phase: 'email' })).toMatchObject({ blocked: true, code: 'customer_link_composer_only' });
    });

    test('a raw tab or newline left in an HTML reply body is dropped like the URL parser does, so the email path still surfaces the link', () => {
      const { renderedTextForLinkCheck } = require('../services/intelligence-bar/email-tools');
      for (const gap of ['\t', '\n', '\r']) {
        const run = renderedTextForLinkCheck(`<a href="https://other.example/?next=https://port${gap}al.wavespestcontrol.com/pay/${TOKEN}">x</a>`).split(/\s+/);
        expect(run.some((r) => r.startsWith(`portal.wavespestcontrol.com/pay/${TOKEN}`))).toBe(true);
      }
    });
  });

  describe('a link encoded past the scan cap', () => {
    const enc = (text, times) => { let out = text; for (let i = 0; i < times; i += 1) out = out.replace(/%/g, '%25').replace(/:/g, '%3A').replace(/\//g, '%2F'); return out; };
    const pad = (times) => 'https://other.example/?next=' + enc('https://portal.wavespestcontrol.com/pay/tok', times);

    test('a still-changing body is refused in both SMS phases and the email phase; sane encodings are not', async () => {
      links.autopayLinkSendCheck.mockResolvedValue({ present: false });
      links.bearerLinkSendCheck.mockResolvedValue({ ok: true });
      for (const phase of ['proposal', 'commit']) {
        expect(await customerLinkSendRefusal(`See ${pad(14)}`, '+19415550123', CUSTOMER_ID, { phase })).toMatchObject({ blocked: true, code: 'customer_link_unverified' });
      }
      expect(await customerLinkSendRefusal(`See ${pad(14)}`, '', null, { phase: 'email' })).toMatchObject({ blocked: true, code: 'customer_link_unverified' });
      // A plain %20 / %25 in an ordinary foreign URL settles at once and is not refused.
      for (const phase of ['proposal', 'commit']) {
        expect(await customerLinkSendRefusal('Map: https://other.example/a%20b?q=100%25&r=x%2520y', '+19415550123', CUSTOMER_ID, { phase })).toBeNull();
      }
      expect(await customerLinkSendRefusal('Map: https://other.example/a%20b?q=100%25', '', null, { phase: 'email' })).toBeNull();
    });
  });

  describe('a customer attached only because a typed number matched them', () => {
    const OTHER = '7a7a7a7a-1111-4111-8111-111111111111';
    const MINE = { id: CUSTOMER_ID, account_id: null };
    const THEIRS = { id: OTHER, account_id: null };
    const BODY = 'Pay here: portal.wavespestcontrol.com/pay/tok';
    let numberQueries;

    // customers: where({id}).first() is the recipient row, whereIn(...).select() the owner rows,
    // and whereNull().whereRaw().select() the live customers on the typed number.
    function wireNumber(onNumber) {
      numberQueries = 0;
      db.mockImplementation(() => {
        const b = {}; let ids = null;
        b.where = (w) => { ids = [w.id]; return b; };
        b.whereNull = () => b;
        b.whereRaw = () => b;
        b.whereIn = (_c, list) => { ids = list; return b; };
        b.first = async () => (ids ? { [CUSTOMER_ID]: MINE, [OTHER]: THEIRS }[ids[0]] || null : MINE);
        b.select = async () => {
          if (ids) return ids.map((id) => ({ [CUSTOMER_ID]: MINE, [OTHER]: THEIRS }[id])).filter(Boolean);
          numberQueries += 1;
          return onNumber();
        };
        return b;
      });
    }

    beforeEach(() => {
      links.autopayLinkSendCheck.mockResolvedValue({ present: false });
      links.bearerLinkSendCheck.mockResolvedValue({ ok: true });
      links.linkOwnersInBody.mockResolvedValue({ owners: [{ kind: 'pay', token: 'tok', customerId: CUSTOMER_ID }], unresolved: [] });
    });

    test('two accounts on the number, or an unreadable count, refuse at the card and at the send', async () => {
      for (const phase of ['proposal', 'commit']) {
        wireNumber(() => [MINE, THEIRS]);
        const two = await customerLinkSendRefusal(BODY, '+19415550123', CUSTOMER_ID, { phase, recipientSelected: false });
        expect(two).toMatchObject({ blocked: true, code: 'customer_link_recipient' });
        expect(two.error).toMatch(/pick the customer/);

        wireNumber(() => { throw new Error('db down'); });
        expect(await customerLinkSendRefusal(BODY, '+19415550123', CUSTOMER_ID, { phase, recipientSelected: false }))
          .toMatchObject({ blocked: true, code: 'customer_link_recipient' });

        wireNumber(() => []);
        expect(await customerLinkSendRefusal(BODY, '+19415550123', CUSTOMER_ID, { phase, recipientSelected: false }))
          .toMatchObject({ blocked: true, code: 'customer_link_recipient' });
      }
      expect(links.bearerLinkSendCheck).not.toHaveBeenCalled();
    });

    test('an appointment, report or receipt link (no owner to judge): the seam gets the inferred customer only when the number names one account', async () => {
      links.linkOwnersInBody.mockResolvedValue({ owners: [], unresolved: [] });
      const VISIT = 'Your visit: portal.wavespestcontrol.com/appointment/abc';
      const trustedArg = () => links.bearerLinkSendCheck.mock.calls.at(-1)[2].trustedCustomerId;

      wireNumber(() => [MINE, THEIRS]);
      await customerLinkSendRefusal(VISIT, '+19415550123', CUSTOMER_ID, { recipientSelected: false });
      expect(trustedArg()).toBeNull();
      wireNumber(() => { throw new Error('db down'); });
      await customerLinkSendRefusal(VISIT, '+19415550123', CUSTOMER_ID, { recipientSelected: false });
      expect(trustedArg()).toBeNull();

      wireNumber(() => [MINE]);
      await customerLinkSendRefusal(VISIT, '+19415550123', CUSTOMER_ID, { recipientSelected: false });
      expect(trustedArg()).toBe(CUSTOMER_ID);
      // A selected customer is trusted without a count.
      wireNumber(() => [MINE, THEIRS]);
      await customerLinkSendRefusal(VISIT, '+19415550123', CUSTOMER_ID);
      expect(trustedArg()).toBe(CUSTOMER_ID);
      expect(numberQueries).toBe(0);
      // The seam's own refusal for an unpicked shared number reaches the caller.
      links.bearerLinkSendCheck.mockResolvedValue({ ok: false, error: 'Pick the customer first.' });
      expect(await customerLinkSendRefusal(VISIT, '+19415550123', CUSTOMER_ID, { recipientSelected: false }))
        .toMatchObject({ blocked: true, code: 'customer_link_refused' });
    });

    test('one account on the number (even as two rows) passes; a selected customer is never counted; a plain text is never affected', async () => {
      for (const phase of ['proposal', 'commit']) {
        wireNumber(() => [MINE]);
        expect(await customerLinkSendRefusal(BODY, '+19415550123', CUSTOMER_ID, { phase, recipientSelected: false })).toBeNull();
        wireNumber(() => [{ id: 'a', account_id: 'acct-1' }, { id: 'b', account_id: 'acct-1' }]);
        expect(await customerLinkSendRefusal(BODY, '+19415550123', CUSTOMER_ID, { phase, recipientSelected: false })).toBeNull();

        wireNumber(() => [MINE, THEIRS]);
        expect(await customerLinkSendRefusal(BODY, '+19415550123', CUSTOMER_ID, { phase })).toBeNull();
        expect(await customerLinkSendRefusal(BODY, '+19415550123', CUSTOMER_ID, { phase, recipientSelected: true })).toBeNull();
        expect(numberQueries).toBe(0);

        links.linkOwnersInBody.mockResolvedValue({ owners: [], unresolved: [] });
        expect(await customerLinkSendRefusal('Running late, sorry!', '+19415550123', CUSTOMER_ID, { phase, recipientSelected: false })).toBeNull();
        expect(numberQueries).toBe(0);
        links.linkOwnersInBody.mockResolvedValue({ owners: [{ kind: 'pay', token: 'tok', customerId: CUSTOMER_ID }], unresolved: [] });
      }
    });

    test('send_sms with only a typed phone is judged as inferred at the card; with a customer_id it is not', async () => {
      const { sendSmsProposalRefusal } = require('../services/intelligence-bar/comms-tools');
      const row = { id: CUSTOMER_ID, first_name: 'Customer', last_name: 'Fixture', phone: '+19415550123', account_id: null };
      let selectCalls = 0;
      db.mockImplementation(() => {
        const b = {}; let ids = null;
        b.where = (w) => { ids = w && w.id ? [w.id] : ids; return b; };
        b.whereNull = () => b; b.whereRaw = () => b; b.whereIn = (_c, list) => { ids = list; return b; };
        b.first = async () => row;
        b.select = async () => { if (ids) return [row]; selectCalls += 1; return [row, { id: OTHER, account_id: null }]; };
        return b;
      });
      const inferred = await sendSmsProposalRefusal({ phone: '+19415550123', message: BODY });
      expect(inferred).toMatchObject({ blocked: true, code: 'customer_link_recipient' });
      expect(inferred.error).toMatch(/pick the customer/);
      expect(selectCalls).toBe(1);

      selectCalls = 0;
      await sendSmsProposalRefusal({ customer_id: CUSTOMER_ID, phone: '+19415550123', message: BODY }).catch(() => null);
      expect(selectCalls).toBe(0);
    });
  });

  test('proposal phase runs only the read-only checks — never the seam\'s stateful bearer check', async () => {
    links.autopayLinkSendCheck.mockResolvedValue({ present: false });
    expect(await customerLinkSendRefusal('Your card link: portal.wavespestcontrol.com/secure/abc', '+19415550123', CUSTOMER_ID, { phase: 'proposal' })).toBeNull();
    expect(links.composerOnlyLinkPresence).toHaveBeenCalledWith('Your card link: portal.wavespestcontrol.com/secure/abc', { includeVerifyOnly: false });
    expect(links.bearerLinkSendCheck).not.toHaveBeenCalled();

    links.composerOnlyLinkPresence.mockResolvedValue({ present: true, kinds: ['card_request'] });
    const refusal = await customerLinkSendRefusal('Your card link: portal.wavespestcontrol.com/secure/abc', '+19415550123', CUSTOMER_ID, { phase: 'proposal' });
    expect(refusal).toMatchObject({ blocked: true, code: 'customer_link_composer_only' });
    expect(links.autopayLinkSendCheck).toHaveBeenCalledTimes(1);
    expect(links.bearerLinkSendCheck).not.toHaveBeenCalled();
  });

  test('commit phase refuses a composer-only link before the seam check runs', async () => {
    links.composerOnlyLinkPresence.mockResolvedValue({ present: true, kinds: ['contract'] });
    const refusal = await customerLinkSendRefusal('Sign here: portal.wavespestcontrol.com/contract/abc', '+19415550123', CUSTOMER_ID);
    expect(refusal).toMatchObject({ blocked: true, code: 'customer_link_composer_only' });
    expect(links.autopayLinkSendCheck).not.toHaveBeenCalled();
    expect(links.bearerLinkSendCheck).not.toHaveBeenCalled();
  });

  test('a plain text passes', async () => {
    links.autopayLinkSendCheck.mockResolvedValue({ present: false });
    links.bearerLinkSendCheck.mockResolvedValue({ ok: true });
    expect(await customerLinkSendRefusal('Running 15 minutes late, sorry!', '+19415550123', CUSTOMER_ID)).toBeNull();
    expect(links.bearerLinkSendCheck).toHaveBeenCalledWith('Running 15 minutes late, sorry!', '9415550123', { trustedCustomerId: CUSTOMER_ID, usDestination: true });
  });

  test('an Auto Pay setup link is refused toward the Customers page button / the composer', async () => {
    links.autopayLinkSendCheck.mockResolvedValue({ present: true, ok: true, tokens: ['tok'] });
    const refusal = await customerLinkSendRefusal('Set up Auto Pay here: portal.wavespestcontrol.com/secure/tok', '+19415550123', CUSTOMER_ID);
    expect(refusal).toMatchObject({ blocked: true, code: 'customer_link_composer_only' });
    expect(refusal.error).toMatch(/Customers page Auto Pay button/);
    expect(links.bearerLinkSendCheck).not.toHaveBeenCalled();
  });

  test.each([
    ['cards', [{ id: 'card-1' }]], ['contracts', [{ id: 'c-1' }]], ['preps', [{ id: 'p-1' }]],
    ['statements', ['st-1']], ['projectReports', [{ id: 'pr-1' }]], ['consultationLeadId', 'lead-1'],
  ])('a composer-recorded bearer (%s) is refused toward the composer', async (field, value) => {
    links.autopayLinkSendCheck.mockResolvedValue({ present: false });
    links.bearerLinkSendCheck.mockResolvedValue({ ok: true, [field]: value });
    const refusal = await customerLinkSendRefusal('Sign here: portal.wavespestcontrol.com/sign/abc', '+19415550123', CUSTOMER_ID);
    expect(refusal).toMatchObject({ blocked: true, code: 'customer_link_composer_only' });
    expect(refusal.error).toMatch(/Communications composer/);
  });

  test('a verified-only bearer (appointment page, report, receipt) passes; a failed verification refuses with the seam\'s words', async () => {
    links.autopayLinkSendCheck.mockResolvedValue({ present: false });
    links.bearerLinkSendCheck.mockResolvedValue({ ok: true, customerId: CUSTOMER_ID });
    expect(await customerLinkSendRefusal('Your visit: portal.wavespestcontrol.com/appointment/abc', '+19415550123', null)).toBeNull();

    links.bearerLinkSendCheck.mockResolvedValue({ ok: false, error: 'This link belongs to a different customer — remove it before sending.' });
    const refusal = await customerLinkSendRefusal('Your visit: portal.wavespestcontrol.com/appointment/abc', '+19415550123', null);
    expect(refusal).toMatchObject({ blocked: true, code: 'customer_link_refused', error: 'This link belongs to a different customer — remove it before sending. Nothing was sent.' });
  });

  test('an unreadable check fails closed; a non-US destination is judged as such', async () => {
    links.autopayLinkSendCheck.mockRejectedValue(new Error('db down'));
    expect(await customerLinkSendRefusal('hi portal.wavespestcontrol.com/pay/x', '+19415550123', null)).toMatchObject({ blocked: true, code: 'customer_link_unverified' });

    links.autopayLinkSendCheck.mockResolvedValue({ present: false });
    links.bearerLinkSendCheck.mockResolvedValue({ ok: true });
    await customerLinkSendRefusal('hi', '+447700900123', null);
    expect(links.bearerLinkSendCheck).toHaveBeenLastCalledWith('hi', '7700900123', { trustedCustomerId: null, usDestination: false });
    expect(await customerLinkSendRefusal('   ', '+19415550123', null)).toBeNull();
  });
});

describe('send_email_reply carries the same guard', () => {
  jest.mock('../services/email/gmail-client', () => ({ sendMessage: jest.fn(async () => ({ id: 'gm-1' })) }));
  const gmail = require('../services/email/gmail-client');
  const { executeEmailTool } = require('../services/intelligence-bar/email-tools');

  test('any customer bearer in an email reply is refused before Gmail, with no phone-bound seam check; a plain reply sends', async () => {
    const email = { id: 'em-1', customer_id: CUSTOMER_ID, from_address: 'fixture@example.com', subject: 'Visit', gmail_thread_id: 't1' };
    db.mockImplementation((table) => { const b = {}; b.where = () => b; b.first = async () => (table === 'emails' ? email : null); return b; });
    links.autopayLinkSendCheck.mockResolvedValue({ present: false });
    links.composerOnlyLinkPresence.mockResolvedValue({ present: true, kinds: ['appointment'] });
    const refused = await executeEmailTool('send_email_reply', { email_id: 'em-1', body: 'Your visit: portal.wavespestcontrol.com/appointment/abc' });
    expect(refused).toMatchObject({ blocked: true, code: 'customer_link_composer_only' });
    expect(refused.error).toMatch(/email reply cannot carry a portal link/);
    expect(links.composerOnlyLinkPresence).toHaveBeenCalledWith(expect.stringContaining('portal.wavespestcontrol.com/appointment/abc'), { includeVerifyOnly: true });
    expect(links.bearerLinkSendCheck).not.toHaveBeenCalled();
    expect(gmail.sendMessage).not.toHaveBeenCalled();

    links.composerOnlyLinkPresence.mockResolvedValue({ present: false, kinds: [] });
    const sent = await executeEmailTool('send_email_reply', { email_id: 'em-1', body: 'Thanks, see you Tuesday.' });
    expect(sent).toMatchObject({ success: true });
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('the body is judged as the mail client renders it: entities decoded, hosts inside markup surfaced', () => {
    const { renderedTextForLinkCheck } = require('../services/intelligence-bar/email-tools');
    const encoded = 'Your receipt: https&#58;&#47;&#47;portal.wavespestcontrol.com&#47;receipt&#47;AbCdEfGhIjKlMnOpQrSt';
    expect(renderedTextForLinkCheck(encoded)).toContain('https://portal.wavespestcontrol.com/receipt/AbCdEfGhIjKlMnOpQrSt');
    const hex = 'See https&#x3A;&#x2F;&#x2F;portal.wavespestcontrol.com&#x2F;pay&#x2F;AbCdEfGhIjKlMnOpQrSt';
    expect(renderedTextForLinkCheck(hex)).toContain('https://portal.wavespestcontrol.com/pay/AbCdEfGhIjKlMnOpQrSt');
    const nested = 'See https&amp;#58;//portal.wavespestcontrol.com/pay/AbCdEfGhIjKlMnOpQrSt';
    expect(renderedTextForLinkCheck(nested)).toContain('https://portal.wavespestcontrol.com/pay/AbCdEfGhIjKlMnOpQrSt');
    const markup = 'Click <a href="https://portal.wavespestcontrol.com/appointment/AbCdEfGhIjKlMnOpQrSt">here</a>';
    expect(renderedTextForLinkCheck(markup).split(/\s+/)).toContain('portal.wavespestcontrol.com/appointment/AbCdEfGhIjKlMnOpQrSt');
    const named = 'Click <a href="https://portal.wavespestcontrol.com/&Tab;receipt/AbCdEfGhIjKlMnOpQrSt&NewLine;">here</a>';
    expect(renderedTextForLinkCheck(named).split(/\s+/)).toContain('portal.wavespestcontrol.com/receipt/AbCdEfGhIjKlMnOpQrSt');
    const tabbed = 'Click <a href="https://portal.wavespestcontrol.com/\treceipt/AbCdEfGhIjKlMnOpQrSt">here</a>';
    expect(renderedTextForLinkCheck(tabbed).split(/\s+/)).toContain('portal.wavespestcontrol.com/receipt/AbCdEfGhIjKlMnOpQrSt');
    expect(renderedTextForLinkCheck('Thanks, see you Tuesday.')).toBe('Thanks, see you Tuesday.');
  });

  // A portal bearer nested in a foreign URL reads as one evil.example token; the rendered text
  // must also carry it as its own run so the owned-link refusal sees it.
  const TOKEN = 'AbCdEfGhIjKlMnOpQrSt';
  const NESTED = `portal.wavespestcontrol.com/receipt/${TOKEN}`;
  const runsOf = (body) => require('../services/intelligence-bar/email-tools').renderedTextForLinkCheck(body).split(/\s+/);

  test.each([
    ['raw in the query', `Go to https://evil.example/?next=https://portal.wavespestcontrol.com/receipt/${TOKEN}`],
    ['single-encoded in the query', `Go to https://evil.example/?next=https%3A%2F%2Fportal.wavespestcontrol.com%2Freceipt%2F${TOKEN}`],
    ['double-encoded in the query', `Go to https://evil.example/?next=https%253A%252F%252Fportal.wavespestcontrol.com%252Freceipt%252F${TOKEN}`],
    ['in the fragment', `Go to https://evil.example/page#https://portal.wavespestcontrol.com/receipt/${TOKEN}`],
    ['encoded in the fragment', `Go to https://evil.example/page#https%3A%2F%2Fportal.wavespestcontrol.com%2Freceipt%2F${TOKEN}`],
    ['in the path', `Go to https://evil.example/r/portal.wavespestcontrol.com/receipt/${TOKEN}`],
    ['inside an href', `<a href="https://evil.example/?u=https%3A%2F%2Fportal.wavespestcontrol.com%2Freceipt%2F${TOKEN}">here</a>`],
  ])('a portal link nested %s is surfaced as its own run', (_label, body) => {
    expect(runsOf(body)).toContain(NESTED);
  });

  test('a portal link in the userinfo of a foreign host is surfaced too, so the email is refused', () => {
    expect(runsOf(`Receipt: https://portal.wavespestcontrol.com%2Freceipt%2F${TOKEN}@evil.example/`)).toContain(`portal.wavespestcontrol.com/receipt/${TOKEN}@evil.example/`);
    expect(runsOf(`Receipt: https://portal.wavespestcontrol.com%2Freceipt%2F${TOKEN}%40evil.example/`).some((run) => run.startsWith(`portal.wavespestcontrol.com/receipt/${TOKEN}`))).toBe(true);
  });

  test('the card is not offered for a reply the send would refuse (proposal phase), and the send still re-checks', async () => {
    const { sendEmailReplyProposalRefusal } = require('../services/intelligence-bar/email-tools');
    links.autopayLinkSendCheck.mockResolvedValue({ present: false });
    links.composerOnlyLinkPresence.mockClear();
    links.composerOnlyLinkPresence.mockResolvedValue({ present: true, kinds: ['receipt'] });
    const refused = await sendEmailReplyProposalRefusal({ email_id: 'em-1', body: `Receipt: https://evil.example/?next=https%3A%2F%2Fportal.wavespestcontrol.com%2Freceipt%2F${TOKEN}` });
    expect(refused).toMatchObject({ blocked: true, code: 'customer_link_composer_only' });
    expect(links.composerOnlyLinkPresence).toHaveBeenCalledWith(expect.stringContaining(NESTED), { includeVerifyOnly: true });
    expect(links.bearerLinkSendCheck).not.toHaveBeenCalled();

    links.composerOnlyLinkPresence.mockResolvedValue({ present: false, kinds: [] });
    expect(await sendEmailReplyProposalRefusal({ email_id: 'em-1', body: 'Thanks, see you Tuesday.' })).toBeNull();
    expect(await sendEmailReplyProposalRefusal({ email_id: 'em-1' })).toBeNull();

    // An unreadable check refuses (fail closed) at the card as well.
    links.composerOnlyLinkPresence.mockRejectedValue(new Error('db down'));
    expect(await sendEmailReplyProposalRefusal({ email_id: 'em-1', body: 'See you Tuesday.' })).toMatchObject({ blocked: true, code: 'customer_link_unverified' });

    // The send re-checks: a body that slipped past the card is still refused before Gmail.
    const email = { id: 'em-3', customer_id: CUSTOMER_ID, from_address: 'fixture@example.com', subject: 'Visit', gmail_thread_id: 't3' };
    db.mockImplementation((table) => { const b = {}; b.where = () => b; b.first = async () => (table === 'emails' ? email : null); return b; });
    gmail.sendMessage.mockClear();
    links.composerOnlyLinkPresence.mockResolvedValue({ present: true, kinds: ['receipt'] });
    expect(await executeEmailTool('send_email_reply', { email_id: 'em-3', body: `Receipt: portal.wavespestcontrol.com/receipt/${TOKEN}` })).toMatchObject({ blocked: true });
    expect(gmail.sendMessage).not.toHaveBeenCalled();
    links.composerOnlyLinkPresence.mockResolvedValue({ present: false, kinds: [] });
  });

  describe('reply_via_sms: the card is not offered for a text the send would refuse (proposal phase)', () => {
    const { replyViaSmsProposalRefusal } = require('../services/intelligence-bar/email-tools');
    const OTHER = '7a7a7a7a-1111-4111-8111-111111111111';
    const MINE = { id: CUSTOMER_ID, first_name: 'Customer', last_name: 'Fixture', phone: '+19415550123', email: 'fixture@example.com', account_id: null };
    const THEIRS = { id: OTHER, first_name: 'Other', last_name: 'Fixture', phone: '+19415550123', email: 'other@example.com', account_id: null };
    const BODY = 'Pay here: portal.wavespestcontrol.com/pay/tok';

    // customers: where('id', x) / where({ id }) -> byId; where('email', x) -> byAddress; whereIn().select() -> owner rows;
    // whereNull().whereRaw().select() -> the live customers on the typed number.
    function wireReply({ email = null, byAddress = null, numberRows = [MINE] } = {}) {
      db.mockImplementation((table) => {
        const b = {}; let mode = 'id'; let ids = [];
        const byId = { [CUSTOMER_ID]: MINE, [OTHER]: THEIRS };
        b.where = (a, v) => {
          if (typeof a === 'object') ids = [a.id]; else if (a === 'id') ids = [v]; else if (a === 'email') mode = 'email';
          return b;
        };
        b.whereNull = () => b; b.whereILike = () => b;
        b.whereRaw = () => { mode = 'number'; return b; };
        b.whereIn = (_c, list) => { mode = 'ids'; ids = list; return b; };
        b.first = async () => (table === 'emails' ? email : mode === 'email' ? byAddress : byId[ids[0]] || null);
        b.select = async () => (mode === 'ids' ? ids.map((id) => byId[id]).filter(Boolean) : numberRows);
        return b;
      });
    }
    beforeEach(() => {
      links.autopayLinkSendCheck.mockResolvedValue({ present: false });
      links.bearerLinkSendCheck.mockResolvedValue({ ok: true });
      links.composerOnlyLinkPresence.mockResolvedValue({ present: false, kinds: [] });
      links.linkOwnersInBody.mockResolvedValue({ owners: [], unresolved: [] });
    });

    test('a composer-only link and a foreign-owner link refuse; a clean body passes', async () => {
      wireReply();
      links.composerOnlyLinkPresence.mockResolvedValue({ present: true, kinds: ['prep_guide'] });
      expect(await replyViaSmsProposalRefusal({ customer_id: CUSTOMER_ID, message: 'Prep: portal.wavespestcontrol.com/prep/abc' }))
        .toMatchObject({ blocked: true, code: 'customer_link_composer_only' });

      links.composerOnlyLinkPresence.mockResolvedValue({ present: false, kinds: [] });
      links.linkOwnersInBody.mockResolvedValue({ owners: [{ kind: 'pay', token: 'tok', customerId: OTHER }], unresolved: [] });
      expect(await replyViaSmsProposalRefusal({ customer_id: CUSTOMER_ID, message: BODY })).toMatchObject({ blocked: true, code: 'customer_link_owner_mismatch' });

      links.linkOwnersInBody.mockResolvedValue({ owners: [], unresolved: [] });
      expect(await replyViaSmsProposalRefusal({ customer_id: CUSTOMER_ID, message: 'Running late, sorry!' })).toBeNull();
      expect(links.bearerLinkSendCheck).not.toHaveBeenCalled();
    });

    test('recipientSelected follows the send: a pinned or attributed customer is trusted; one matched by address or name needs a single-account number', async () => {
      links.linkOwnersInBody.mockResolvedValue({ owners: [{ kind: 'pay', token: 'tok', customerId: CUSTOMER_ID }], unresolved: [] });
      const email = { id: 'em-9', customer_id: CUSTOMER_ID, from_address: 'fixture@example.com' };
      // Pinned customer_id, and the email's own attributed customer: never counted.
      wireReply({ email, numberRows: [MINE, THEIRS] });
      expect(await replyViaSmsProposalRefusal({ customer_id: CUSTOMER_ID, message: BODY })).toBeNull();
      expect(await replyViaSmsProposalRefusal({ email_id: 'em-9', message: BODY })).toBeNull();
      // Matched only by the sender's address (no attributed customer) or by name, two accounts on the number: refused.
      wireReply({ email: { id: 'em-9', customer_id: null, from_address: 'fixture@example.com' }, byAddress: MINE, numberRows: [MINE, THEIRS] });
      expect(await replyViaSmsProposalRefusal({ email_id: 'em-9', message: BODY })).toMatchObject({ blocked: true, code: 'customer_link_recipient' });
      wireReply({ numberRows: [MINE, THEIRS], byAddress: MINE });
      // A name-only proposal is resolved as the route pins it: live rows only, and one match only.
      const nameMatches = (rows) => db.mockImplementationOnce(() => {
        const b = { whereNull: jest.fn(() => b), limit: jest.fn(async () => rows) };
        b.where = () => b;
        nameMatches.last = b;
        return b;
      });
      nameMatches([MINE]);
      expect(await replyViaSmsProposalRefusal({ customer_name: 'Customer', message: BODY })).toMatchObject({ blocked: true, code: 'customer_link_recipient' });
      expect(nameMatches.last.whereNull).toHaveBeenCalledWith('deleted_at');
      expect(nameMatches.last.limit).toHaveBeenCalledWith(2);
      // Two live customers share the name, or none has it: not judged here (the pin step refuses), never the first row.
      nameMatches([MINE, THEIRS]);
      expect(await replyViaSmsProposalRefusal({ customer_name: 'Fixture', message: BODY })).toBeNull();
      nameMatches([]);
      expect(await replyViaSmsProposalRefusal({ customer_name: 'Nobody', message: BODY })).toBeNull();
      // The same address match on a one-account number passes.
      wireReply({ email: { id: 'em-9', customer_id: null, from_address: 'fixture@example.com' }, byAddress: MINE, numberRows: [MINE] });
      expect(await replyViaSmsProposalRefusal({ email_id: 'em-9', message: BODY })).toBeNull();
    });

    test('an unresolvable recipient or an empty message is not judged here (the pin step and the send refuse it); an unreadable lookup refuses', async () => {
      wireReply({ email: null, byAddress: null });
      expect(await replyViaSmsProposalRefusal({ email_id: 'em-none', message: BODY })).toBeNull();
      expect(await replyViaSmsProposalRefusal({ customer_id: '00000000-0000-4000-8000-000000000000', message: BODY })).toBeNull();
      expect(await replyViaSmsProposalRefusal({ customer_id: CUSTOMER_ID })).toBeNull();
      db.mockImplementation(() => { throw new Error('db down'); });
      expect(await replyViaSmsProposalRefusal({ customer_id: CUSTOMER_ID, message: BODY })).toMatchObject({ blocked: true, code: 'customer_link_unverified' });
    });

    test('the send still re-checks (execution-time) and uses the same recipient resolution', async () => {
      wireReply();
      links.composerOnlyLinkPresence.mockResolvedValue({ present: true, kinds: ['prep_guide'] });
      const { executeEmailTool: run } = require('../services/intelligence-bar/email-tools');
      expect(await run('reply_via_sms', { customer_id: CUSTOMER_ID, message: 'Prep: portal.wavespestcontrol.com/prep/abc' })).toMatchObject({ blocked: true, code: 'customer_link_composer_only' });
    });
  });

  test('a nested portal link reaches the owned-link refusal; a foreign URL with no owned link still passes', async () => {
    const email = { id: 'em-2', customer_id: CUSTOMER_ID, from_address: 'fixture@example.com', subject: 'Visit', gmail_thread_id: 't2' };
    db.mockImplementation((table) => { const b = {}; b.where = () => b; b.first = async () => (table === 'emails' ? email : null); return b; });
    links.autopayLinkSendCheck.mockResolvedValue({ present: false });
    gmail.sendMessage.mockClear();
    links.composerOnlyLinkPresence.mockClear();
    links.composerOnlyLinkPresence.mockResolvedValue({ present: true, kinds: ['receipt'] });
    const refused = await executeEmailTool('send_email_reply', { email_id: 'em-2', body: `Receipt: https://evil.example/?next=https%3A%2F%2Fportal.wavespestcontrol.com%2Freceipt%2F${TOKEN}` });
    expect(refused).toMatchObject({ blocked: true, code: 'customer_link_composer_only' });
    expect(links.composerOnlyLinkPresence).toHaveBeenCalledWith(expect.stringMatching(new RegExp(` ${NESTED}(?: |$)`)), { includeVerifyOnly: true });
    expect(gmail.sendMessage).not.toHaveBeenCalled();

    // No owned host anywhere in the URL: nothing is surfaced, and the reply goes out.
    const foreign = 'Details: https://evil.example/?next=https%3A%2F%2Fother.example%2Fpage and https://portal.wavespestcontrol.com.evil.example/receipt/x';
    expect(runsOf(foreign).filter((run) => /^portal\.wavespestcontrol\.com(?![.\w-])/.test(run))).toEqual([]);
    links.composerOnlyLinkPresence.mockResolvedValue({ present: false, kinds: [] });
    expect(await executeEmailTool('send_email_reply', { email_id: 'em-2', body: foreign })).toMatchObject({ success: true });
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
  });
});
