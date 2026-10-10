/**
 * Intelligence Bar customer-link tools — the composer's Insert Link kinds and
 * the Auto Pay setup link as carded writes, plus the send-side guard.
 *
 * Observable behavior pinned here:
 *   - create_customer_link previews from the customer row alone and never
 *     touches the composer handler; the confirmed run calls the exported
 *     handler with the row's OWN phone and reports its 200 body, or its
 *     plain-reason refusal as a blocked result (nothing sent either way).
 *   - send_autopay_setup_link previews through the service's eligibility
 *     read and reports each service outcome (sent / link_created /
 *     auto_secured / skipped / uncertain) in its own words.
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
  requestAutopaySetupLink: jest.fn(),
}));
jest.mock('../services/composer-customer-links', () => ({
  AUTOPAY_SKIP_REASONS: jest.requireActual('../services/composer-customer-links').AUTOPAY_SKIP_REASONS,
  autopayLinkSendCheck: jest.fn(),
  bearerLinkSendCheck: jest.fn(),
  composerOnlyLinkPresence: jest.fn(async () => ({ present: false, kinds: [] })),
  linkOwnersInBody: jest.fn(async () => ({ owners: [], unresolved: [] })),
  autopaySmsLever: jest.fn(async () => null),
}));
jest.mock('../services/email-template-library', () => ({ loadTemplateByKey: jest.fn(async () => ({ activeVersion: { id: 'v1' } })) }));

const db = require('../models/db');
const routeExports = require('../routes/admin-communications');
const autopay = require('../services/autopay-setup-link');
const links = require('../services/composer-customer-links');
const { CUSTOMER_LINK_TOOLS, executeCustomerLinkTool } = require('../services/intelligence-bar/customer-link-tools');

const CUSTOMER_ID = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';
const CUSTOMER = {
  id: CUSTOMER_ID, first_name: 'Customer', last_name: 'Fixture', phone: '+19415550123', email: 'fixture@example.com',
  billing_mode: 'per_application', autopay_enabled: false, autopay_paused_until: null, payer_id: null,
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
  test('both tools are side-effect flagged, admin-only in the executor, and offer every Insert Link kind the bar builds', () => {
    const byName = Object.fromEntries(CUSTOMER_LINK_TOOLS.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['create_customer_link', 'send_autopay_setup_link']);
    expect(byName.create_customer_link._sideEffects).toBe(true);
    expect(byName.send_autopay_setup_link._sideEffects).toBe(true);
    expect(byName.create_customer_link.input_schema.properties.kind.enum).toEqual([
      'reschedule', 'reservice', 'pay_balance', 'estimate', 'referral', 'consultation', 'appointment',
      'card_request', 'prep_guide', 'service_report', 'receipt', 'project_report',
    ]);
    expect(byName.create_customer_link.input_schema.properties.kind.enum).not.toContain('contract');
    expect(byName.create_customer_link.input_schema.properties.kind.enum).not.toContain('statement');
    expect(byName.create_customer_link.input_schema.properties.kind.enum).not.toContain('review_request');
    expect(byName.create_customer_link.input_schema.properties.kind.enum).not.toContain('autopay_setup');
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

  test('confirmed: card_request auto-secure is a committed enrollment, reported as success with no link', async () => {
    wireCustomer();
    const preview = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'card_request' }, { isAdmin: true });
    expect(preview.auto_secure).toMatch(/enrolls that card/);
    expect(preview.notifies_customer).toBe('may');
    routeExports.customerLinkInsert.mockResolvedValue({ status: 200, body: { kind: 'card_request', url: null, line: '', autoSecured: true, firstName: 'Customer' } });
    const result = await executeCustomerLinkTool('create_customer_link', { customer_id: CUSTOMER_ID, kind: 'card_request', confirmed: true, _verified_link_version: { ...LINK_PIN, kind: 'card_request' } }, { isAdmin: true });
    expect(result).toMatchObject({ success: true, auto_secured: true, url: null, sent: false });
    expect(result.blocked).toBeUndefined();
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
  test('unconfirmed: the eligibility read decides the card; sms needs a phone, email an address', async () => {
    wireCustomer();
    autopay.setupLinkIneligibility.mockResolvedValue({ reason: null, customer: CUSTOMER });
    const preview = await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID }, { isAdmin: true });
    expect(preview).toMatchObject({ preview: true, delivery: 'sms', reaches: 'text to ***0123', customer_name: 'Customer Fixture', notifies_customer: true,
      _version: { customer_id: CUSTOMER_ID, delivery: 'sms', phone_last10: '9415550123', email: 'fixture@example.com' } });
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();

    wireCustomer();
    const emailed = await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID, delivery: 'email' }, { isAdmin: true });
    expect(emailed).toMatchObject({ preview: true, reaches: 'email to f***@example.com' });

    wireCustomer({ ...CUSTOMER, email: null });
    expect((await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID, delivery: 'email' }, { isAdmin: true })).code).toBe('no_customer_email');
    wireCustomer({ ...CUSTOMER, email: 'not-an-address' });
    expect((await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID, delivery: 'email' }, { isAdmin: true })).code).toBe('no_customer_email');

    wireCustomer();
    links.autopaySmsLever.mockResolvedValueOnce('template_inactive');
    const dark = await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID }, { isAdmin: true });
    expect(dark).toMatchObject({ blocked: true, code: 'template_inactive' });
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();

    wireCustomer();
    require('../services/email-template-library').loadTemplateByKey.mockResolvedValueOnce(null);
    expect((await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID, delivery: 'email' }, { isAdmin: true })).code).toBe('email_template_inactive');

    wireCustomer();
    const inline = await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID, delivery: 'inline' }, { isAdmin: true });
    expect(inline).toMatchObject({ preview: true, notifies_customer: 'may' });
    expect(inline.auto_secure).toMatch(/enrollment confirmation email may go out/);

    wireCustomer();
    autopay.setupLinkIneligibility.mockResolvedValue({ reason: 'autopay_already_active' });
    const already = await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID }, { isAdmin: true });
    expect(already).toMatchObject({ blocked: true, code: 'autopay_already_active', error: 'This customer is already on Auto Pay' });
  });

  test.each([
    [{ requested: true, action: 'sent', reason: 'sent', channel: 'sms' }, { success: true, sent: true, channel: 'sms' }],
    [{ requested: true, action: 'link_created', secureUrl: 'https://portal.wavespestcontrol.com/secure/tok', expiresAt: '2026-11-09T00:00:00Z' }, { success: true, sent: false, url: 'https://portal.wavespestcontrol.com/secure/tok' }],
    [{ requested: true, action: 'auto_secured' }, { success: true, sent: false, auto_secured: true }],
    [{ requested: false, action: 'skipped', reason: 'template_inactive' }, { blocked: true, code: 'template_inactive', error: 'The Auto Pay setup text is inactive in Templates — activate it before texting a setup link' }],
    [{ requested: false, action: 'skipped', reason: 'send_outcome_uncertain' }, { outcome_unknown: true, code: 'send_outcome_uncertain' }],
  ])('confirmed: service outcome %j is reported as %j', async (serviceResult, expected) => {
    wireCustomer();
    autopay.setupLinkIneligibility.mockResolvedValue({ reason: null, customer: CUSTOMER });
    autopay.requestAutopaySetupLink.mockResolvedValue(serviceResult);
    const delivery = serviceResult.action === 'link_created' ? 'inline' : 'sms';
    const result = await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID, delivery, confirmed: true,
      _verified_autopay_version: { customer_id: CUSTOMER_ID, delivery, phone_last10: '9415550123', email: 'fixture@example.com' } }, { isAdmin: true });
    expect(autopay.requestAutopaySetupLink).toHaveBeenCalledWith({ customerId: CUSTOMER_ID, delivery: serviceResult.action === 'link_created' ? 'inline' : 'sms', trigger: 'admin' });
    expect(result).toMatchObject(expected);
  });

  const AUTOPAY_PIN = { customer_id: CUSTOMER_ID, delivery: 'sms', phone_last10: '9415550123', email: 'fixture@example.com' };

  test('confirmed: a throw after approval is an unknown outcome, never a retry invitation', async () => {
    wireCustomer();
    autopay.setupLinkIneligibility.mockResolvedValue({ reason: null, customer: CUSTOMER });
    autopay.requestAutopaySetupLink.mockRejectedValue(new Error('provider down'));
    const result = await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID, confirmed: true, _verified_autopay_version: AUTOPAY_PIN }, { isAdmin: true });
    expect(result).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });

  test('confirmed: a contact changed since the card, or a missing pin, never reaches the service', async () => {
    autopay.setupLinkIneligibility.mockResolvedValue({ reason: null, customer: CUSTOMER });
    wireCustomer({ ...CUSTOMER, email: 'new@example.com' });
    const drifted = await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID, confirmed: true, _verified_autopay_version: AUTOPAY_PIN }, { isAdmin: true });
    expect(drifted).toMatchObject({ preview_changed: true });
    wireCustomer();
    expect(await executeCustomerLinkTool('send_autopay_setup_link', { customer_id: CUSTOMER_ID, confirmed: true }, { isAdmin: true }))
      .toEqual({ error: 'Use the confirmation card to approve this change.' });
    expect(autopay.requestAutopaySetupLink).not.toHaveBeenCalled();
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

    links.linkOwnersInBody.mockResolvedValue({ owners: [], unresolved: [{ kind: 'estimate', token: 'gone' }] });
    expect(await customerLinkSendRefusal('See: portal.wavespestcontrol.com/estimate/gone', '+19415550123', CUSTOMER_ID)).toMatchObject({ code: 'customer_link_unverified' });
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

  test('an Auto Pay setup link is refused toward send_autopay_setup_link / the composer', async () => {
    links.autopayLinkSendCheck.mockResolvedValue({ present: true, ok: true, tokens: ['tok'] });
    const refusal = await customerLinkSendRefusal('Set up Auto Pay here: portal.wavespestcontrol.com/secure/tok', '+19415550123', CUSTOMER_ID);
    expect(refusal).toMatchObject({ blocked: true, code: 'customer_link_composer_only' });
    expect(refusal.error).toMatch(/send_autopay_setup_link/);
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
    const tabbed = 'Click <a href="https://portal.wavespestcontrol.com/\treceipt/AbCdEfGhIjKlMnOpQrSt">here</a>';
    expect(renderedTextForLinkCheck(tabbed).split(/\s+/)).toContain('portal.wavespestcontrol.com/receipt/AbCdEfGhIjKlMnOpQrSt');
    expect(renderedTextForLinkCheck('Thanks, see you Tuesday.')).toBe('Thanks, see you Tuesday.');
  });
});
