/**
 * IB schedule_sms (owner ruling 2026-10-28, gap 5 and B1): one plain customer text queued for a later day and time
 * through the shared writer the Communications page route also calls, dark behind GATE_IB_SCHEDULE_SMS (needs
 * GATE_IB_PLATFORM). What the card shows (exact text, customer, number last four, From number, send time in words in
 * Eastern Time), the B1 night rule at its exact boundary, the pins and their drift refusals, gate off, admin only,
 * always a card (never owner-direct), and that the commit runs the shared writer once with the card's own values and a
 * lock-time re-check. The writer itself is mocked here (the route suites and the real-Postgres suite cover it); nothing
 * reaches a provider. Dates are in 2099 so they are always in the future. Synthetic names and numbers only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockQueue = jest.fn();
const mockLinkRefusal = jest.fn();
jest.mock('../services/scheduled-sms-queue', () => ({
  scheduleCustomerSms: (...a) => mockQueue(...a),
  scheduledSmsLinkRefusal: (...a) => mockLinkRefusal(...a),
}));
const mockProposalRefusal = jest.fn();
const mockResolveCustomer = jest.fn();
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  sendSmsProposalRefusal: (...a) => mockProposalRefusal(...a),
  resolveCustomer: (...a) => mockResolveCustomer(...a),
}));

const db = require('../models/db');
const tools = require('../services/intelligence-bar/schedule-sms-tools');
const { executeScheduleSmsTool, SCHEDULE_SMS_TOOLS, cardLines, sendTimeInWords } = tools;
const registry = require('../services/intelligence-bar/action-registry');
const gates = require('../services/intelligence-bar/write-gates');
const { buildContract, previewFingerprint, CUSTOMER_CONTACT_TOOL_NAMES } = require('../services/intelligence-bar/authorization-contract');
const OwnerDirect = require('../services/intelligence-bar/owner-direct');
const TWILIO_NUMBERS = require('../config/twilio-numbers');

const CUST = '00000000-0000-4000-8000-0000000000c1';
const PHONE = '+19415550142';
const ADMIN = { isAdmin: true, technicianId: '00000000-0000-4000-8000-0000000000a1', operationId: 'op-1' };
const FROM = TWILIO_NUMBERS.getOutboundNumber();
const TEXT = 'Hi Robin, we are on our way tomorrow morning. Reply with any questions.';
const base = { customer_id: CUST, message: TEXT, send_date: '2099-01-05', send_time: '10:00' };

let customers;
// A small knex stand-in: plain-object where / whereNull filter the seeded customers. Any write throws.
function makeDb() {
  return (table) => {
    const q = { wheres: [], nulls: [] };
    const rows = () => (table === 'customers' ? customers : []).filter((row) => q.wheres.every((w) => Object.entries(w).every(([k, v]) => String(row[k]) === String(v))) && q.nulls.every((k) => row[k] == null));
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve().then(() => rows()).then(res, rej);
        if (prop === 'where') return (arg) => { if (arg && typeof arg === 'object') q.wheres.push(arg); return b; };
        if (prop === 'whereNull') return (k) => { q.nulls.push(k); return b; };
        if (prop === 'first') return () => Promise.resolve().then(() => rows()[0]);
        if (['insert', 'update', 'del', 'delete', 'upsert'].includes(prop)) throw new Error(`unexpected ${String(prop)} on ${table}`);
        return () => b;
      },
    });
    return b;
  };
}

function envGate(on) {
  if (on) { process.env.GATE_IB_SCHEDULE_SMS = 'true'; process.env.GATE_IB_PLATFORM = 'true'; }
  else { delete process.env.GATE_IB_SCHEDULE_SMS; delete process.env.GATE_IB_PLATFORM; }
}

const preview = (input = {}, ctx = ADMIN) => executeScheduleSmsTool('schedule_sms', { ...base, ...input }, ctx);
const confirm = (card, input = {}, ctx = ADMIN) => executeScheduleSmsTool('schedule_sms',
  { ...base, ...input, confirmed: true, _verified_schedule_sms_version: card._version }, ctx);

beforeEach(() => {
  jest.clearAllMocks();
  customers = [{ id: CUST, first_name: 'Robin', last_name: 'Sample', phone: PHONE, deleted_at: null }];
  db.mockImplementation(makeDb());
  envGate(true);
  mockLinkRefusal.mockResolvedValue(null);
  mockProposalRefusal.mockResolvedValue(null);
  mockResolveCustomer.mockResolvedValue(null);
  mockQueue.mockResolvedValue({ status: 200, body: { success: true, id: 'sms-1', scheduledFor: '2099-01-05T15:00:00.000Z' } });
});
afterEach(() => envGate(false));

describe('registration', () => {
  test('a two-step external action, admin only, never owner-direct, and a customer-contact card', () => {
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('schedule_sms')).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has('schedule_sms')).toBe(true);
    expect(registry.actions.get('schedule_sms')).toMatchObject({ domain: 'comms', kind: 'external_action', role: 'admin', approval: 'ui_confirm', scope: 'record', module: 'schedule-sms-tools.js' });
    expect(registry.policyErrors).not.toContain('schedule_sms');
    expect(SCHEDULE_SMS_TOOLS[0]._sideEffects).toBe(true);
    expect(Object.keys(SCHEDULE_SMS_TOOLS[0].input_schema.properties)).toEqual(['customer_id', 'customer_name', 'message', 'send_date', 'send_time']);
    expect(CUSTOMER_CONTACT_TOOL_NAMES.has('schedule_sms')).toBe(true);
  });

  test('owner-direct never skips this card: not on the owner-direct list, so it is carded on the owner login too', () => {
    expect(OwnerDirect.OWNER_DIRECT_TOOL_NAMES ? OwnerDirect.OWNER_DIRECT_TOOL_NAMES.has('schedule_sms') : false).toBe(false);
    expect(OwnerDirect.executesWithoutCard('schedule_sms', base, { preview: true, tool: 'schedule_sms' }, {}, null)).toBe(false);
  });

  test('offered only while the gate and the platform are on, and never to a technician', () => {
    const offered = (scope) => registry.allowed(registry.actions.get('schedule_sms'), scope);
    expect(offered({ role: 'admin', context: 'comms' })).toBe(true);
    envGate(false);
    expect(offered({ role: 'admin', context: 'comms' })).toBe(false);
    process.env.GATE_IB_SCHEDULE_SMS = 'true'; // the platform gate is still off
    expect(offered({ role: 'admin', context: 'comms' })).toBe(false);
    envGate(true);
    expect(offered({ role: 'technician', context: 'tech' })).toBe(false);
    expect(offered({ role: 'admin', context: 'tech' })).toBe(false);
  });

  test('the description states the B1 rule, the AM/PM question and that send-now is another tool', () => {
    const text = SCHEDULE_SMS_TOOLS[0].description;
    expect(text).toMatch(/8:00 AM to 7:59 PM Eastern/);
    expect(text).toMatch(/ASK which one/);
    expect(text).toMatch(/send_sms/);
  });
});

describe('gate and role', () => {
  test('gate off refuses before any read', async () => {
    envGate(false);
    expect(await preview()).toMatchObject({ code: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('a non-admin is refused, preview and confirm', async () => {
    expect(await preview({}, { isAdmin: false })).toMatchObject({ code: 'permission_denied' });
    const card = await preview();
    expect(await confirm(card, {}, { technicianId: 'x' })).toMatchObject({ code: 'permission_denied' });
    expect(mockQueue).not.toHaveBeenCalled();
  });

  test('a confirmed call without the card pin refuses', async () => {
    expect(await executeScheduleSmsTool('schedule_sms', { ...base, confirmed: true }, ADMIN)).toMatchObject({ code: 'approval_required' });
    expect(mockQueue).not.toHaveBeenCalled();
  });
});

describe('the card', () => {
  test('shows the exact text, the customer, the number last four, the From number and the send time in words', async () => {
    const card = await preview();
    expect(card).toMatchObject({
      preview: true, tool: 'schedule_sms', customer_id: CUST, customer_name: 'Robin Sample', to_last4: '0142', from_number: FROM,
      message: TEXT, send_time_et: 'Monday, January 5 at 10:00 AM', sends_now: false,
    });
    expect(card.send_at).toBe('2099-01-05T15:00:00.000Z');
    const lines = cardLines('schedule_sms', card).map((l) => l.text).join('\n');
    expect(lines).toContain(`Text Robin Sample (…0142) from ${FROM}: “${TEXT}”`);
    expect(lines).toContain('Monday, January 5 at 10:00 AM Eastern');
    expect(lines).toMatch(/Nothing is sent now/);
    expect(lines).toMatch(/cancel_queued_message/);
    expect(JSON.stringify(card)).not.toContain(PHONE);
    expect(JSON.stringify(card)).not.toContain('9415550142');
    expect(mockQueue).not.toHaveBeenCalled();
  });

  test('the contract has a customer-contact card with those lines', async () => {
    const card = await preview();
    const contract = buildContract({ toolName: 'schedule_sms', params: base, displayParams: {}, preview: card, summary: 'x' });
    expect(contract.notifies_customer).toBe(true);
    // A queued text is cancelable until it sends, so the card does not say "Cannot be undone".
    expect(contract.irreversible).toBe(false);
    expect(JSON.stringify(contract.effects)).toContain('Monday, January 5 at 10:00 AM Eastern');
    expect(JSON.stringify(contract.effects)).toContain(FROM);
  });

  test('sendTimeInWords reads Eastern Time in summer and winter', () => {
    expect(sendTimeInWords(new Date('2099-10-30T14:00:00Z'))).toBe('Friday, October 30 at 10:00 AM');
    expect(sendTimeInWords(new Date('2099-01-05T15:00:00Z'))).toBe('Monday, January 5 at 10:00 AM');
  });

  test('the customer can be named instead of picked; an ambiguous name returns the candidates and no card', async () => {
    mockResolveCustomer.mockResolvedValueOnce(customers[0]);
    expect(await preview({ customer_id: undefined, customer_name: 'Robin Sample' })).toMatchObject({ preview: true, customer_id: CUST });
    mockResolveCustomer.mockResolvedValueOnce({ error: 'Multiple customers match that name.', ambiguous: true, candidates: [{ id: 'a' }, { id: 'b' }] });
    expect(await preview({ customer_id: undefined, customer_name: 'Sample' })).toMatchObject({ ambiguous: true });
  });
});

describe('B1: 8:00 AM to 8:00 PM Eastern only', () => {
  test.each([
    ['2099-01-05', '08:00', true], ['2099-01-05', '08:01', true], ['2099-01-05', '12:00', true], ['2099-01-05', '19:59', true],
    ['2099-01-05', '20:00', false], ['2099-01-05', '20:01', false], ['2099-01-05', '21:00', false], ['2099-01-05', '23:59', false],
    ['2099-01-05', '00:00', false], ['2099-01-05', '03:30', false], ['2099-01-05', '07:59', false],
    // Summer time: the same wall-clock boundary in EDT, not UTC.
    ['2099-07-15', '08:00', true], ['2099-07-15', '19:59', true], ['2099-07-15', '20:00', false], ['2099-07-15', '07:59', false],
  ])('%s %s Eastern is %s', async (send_date, send_time, ok) => {
    const result = await preview({ send_date, send_time });
    if (ok) expect(result).toMatchObject({ preview: true });
    else expect(result).toMatchObject({ code: 'night_time_refused', error: expect.stringMatching(/8 AM to 8 PM/) });
  });

  test('the refusal tells the bar to ask for a daytime time and to ask AM or PM, and offers no card', async () => {
    const result = await preview({ send_time: '21:00' });
    expect(result.error).toMatch(/Ask the operator for a time from 8 AM to 8 PM/);
    expect(result.error).toMatch(/ask AM or PM/);
    expect(result.preview).toBeUndefined();
  });

  test('a night time never reaches the writer, on confirm either', async () => {
    const card = await preview();
    expect(await confirm(card, { send_time: '20:00' })).toMatchObject({ code: 'night_time_refused', preview_changed: true });
    expect(mockQueue).not.toHaveBeenCalled();
  });
});

describe('inputs the card refuses', () => {
  test.each([
    [{ send_date: '2099-13-40' }, 'invalid_send_time'], [{ send_date: 'tomorrow' }, 'invalid_send_time'], [{ send_date: '2099-01-05T10:00:00Z' }, 'invalid_send_time'],
    [{ send_time: '9am' }, 'invalid_send_time'], [{ send_time: '25:00' }, 'invalid_send_time'], [{ send_time: '10:00-05:00' }, 'invalid_send_time'],
    [{ send_date: '2001-01-05' }, 'send_time_in_the_past'], [{ message: '   ' }, 'message_required'], [{ message: 'x'.repeat(1601) }, 'message_too_long'],
    [{ customer_id: 'nope' }, 'invalid_target'], [{ customer_id: undefined }, 'invalid_target'],
  ])('%j is refused as %s with no card', async (over, code) => {
    expect(await preview(over)).toMatchObject({ code });
    expect(mockQueue).not.toHaveBeenCalled();
  });

  test('a deleted customer, a customer with no phone and a missing customer are refused', async () => {
    customers[0].deleted_at = new Date();
    expect(await preview()).toMatchObject({ code: 'customer_not_found' });
    customers[0].deleted_at = null;
    customers[0].phone = '';
    expect(await preview()).toMatchObject({ code: 'no_phone' });
    customers = [];
    expect(await preview()).toMatchObject({ code: 'customer_not_found' });
  });

  test('the route\'s immediate-only link fence refuses the card (and an unreadable one refuses closed)', async () => {
    mockLinkRefusal.mockResolvedValueOnce({ status: 400, error: 'Auto Pay setup links expire — send them now, or remove the link before scheduling' });
    expect(await preview()).toMatchObject({ code: 'link_not_schedulable', error: expect.stringMatching(/Auto Pay/) });
    mockLinkRefusal.mockResolvedValueOnce({ status: 503, error: 'Could not verify the links in this message — try again in a moment.' });
    expect(await preview()).toMatchObject({ code: 'link_unverified' });
  });

  test('an opted-out or suppressed number gets no card, in the send path\'s own words', async () => {
    mockProposalRefusal.mockResolvedValueOnce({ success: false, blocked: true, code: 'NO_CONSENT_RECORD', error: 'The customer opted out of texts.' });
    expect(await preview()).toMatchObject({ code: 'NO_CONSENT_RECORD', error: expect.stringMatching(/opted out.*Nothing was scheduled/) });
    expect(mockProposalRefusal).toHaveBeenCalledWith(expect.objectContaining({ customer_id: CUST, phone: PHONE, message_type: 'manual' }));
  });
});

describe('Confirm', () => {
  test('runs the shared writer once with the card\'s own customer, number, From number, text and time as an admin', async () => {
    const card = await preview();
    const done = await confirm(card);
    expect(done).toMatchObject({ success: true, state: 'scheduled', message_id: 'sms-1', customer_id: CUST, sent_to_customer: false, send_time_et: 'Monday, January 5 at 10:00 AM' });
    expect(mockQueue).toHaveBeenCalledTimes(1);
    const [input, actor, hooks] = mockQueue.mock.calls[0];
    expect(input).toEqual({ to: PHONE, body: TEXT, scheduledFor: '2099-01-05T15:00:00.000Z', customerId: CUST, fromNumber: FROM });
    expect(actor).toEqual({ techRole: 'admin', technicianId: ADMIN.technicianId });
    expect(typeof hooks.underLock).toBe('function');
    // The bar never sends the inputs only the page uses.
    for (const key of ['messageType', 'agentDecisionId', 'agentDraft', 'replyToMessageId', 'translationTrialId', 'linkedVisitIds']) expect(input).not.toHaveProperty(key);
  });

  test.each([
    ['the text', { message: `${TEXT} Extra.` }],
    ['the time', { send_time: '10:01' }],
    ['the day', { send_date: '2099-01-06' }],
  ])('a changed %s since the card refuses with preview_changed and queues nothing', async (_label, over) => {
    const card = await preview();
    expect(await confirm(card, over)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(mockQueue).not.toHaveBeenCalled();
  });

  test('a changed phone number refuses with preview_changed and queues nothing', async () => {
    const card = await preview();
    customers[0].phone = '+19415550199';
    expect(await confirm(card)).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(mockQueue).not.toHaveBeenCalled();
  });

  test('a changed From number refuses with preview_changed', async () => {
    const card = await preview();
    const forged = { ...card._version, from: '+19415550000' };
    expect(await confirm({ _version: forged })).toMatchObject({ code: 'preview_changed' });
    expect(mockQueue).not.toHaveBeenCalled();
  });

  test('the pins are digests and ids, never the number or the text', async () => {
    const card = await preview();
    expect(Object.keys(card._version)).toEqual(['customer_id', 'to', 'from', 'text_digest', 'send_at']);
    expect(JSON.stringify(card._version)).not.toContain('9415550142');
    expect(JSON.stringify(card._version)).not.toContain('Robin');
  });

  test('the preview fingerprint the route compares changes with any pinned part', async () => {
    const card = await preview();
    const same = await preview();
    expect(previewFingerprint(same)).toBe(previewFingerprint(card));
    for (const over of [{ message: `${TEXT}!` }, { send_time: '11:00' }, { send_date: '2099-01-06' }]) {
      expect(previewFingerprint(await preview(over))).not.toBe(previewFingerprint(card));
    }
    customers[0].phone = '+19415550199';
    expect(previewFingerprint(await preview())).not.toBe(previewFingerprint(card));
  });

  test('the writer\'s lock-time check refuses a phone change and answers a repeated Confirm with the queued row', async () => {
    const card = await preview();
    await confirm(card);
    const { underLock } = mockQueue.mock.calls[0][2];
    const trx = (rows) => (table) => {
      const b = { where: () => b, whereNull: () => b, forShare: () => b, whereRaw: () => b, first: async () => (table === 'customers' ? rows.customer : rows.existing) };
      return b;
    };
    expect(await underLock(trx({ customer: { phone: PHONE }, existing: null }))).toBeNull();
    expect(await underLock(trx({ customer: { phone: '+19415550199' }, existing: null }))).toMatchObject({ refuse: { status: 409, code: 'preview_changed' } });
    expect(await underLock(trx({ customer: null, existing: null }))).toMatchObject({ refuse: { code: 'preview_changed' } });
    expect(await underLock(trx({ customer: { phone: PHONE }, existing: { id: 'sms-9', scheduled_for: new Date('2099-01-05T15:00:00Z') } }))).toEqual({ existing: { id: 'sms-9', scheduledFor: new Date('2099-01-05T15:00:00Z') } });
  });

  test.each([
    [{ status: 409, body: { error: 'Applicant texts are not scheduled here — send now from the recruiting queue or the reply box' } }, 'schedule_refused', false],
    [{ status: 409, body: { error: 'The customer or their phone number changed after the card was shown. Nothing was scheduled.', code: 'preview_changed' } }, 'preview_changed', true],
    [{ status: 400, body: { error: 'fromNumber must be a Waves Twilio number' } }, 'schedule_refused', false],
    [{ status: 400, body: { error: 'scheduledFor must be in the future' } }, 'schedule_refused', false],
  ])('the writer refusing (%j) is reported with nothing queued', async (answer, code, drift) => {
    mockQueue.mockResolvedValueOnce(answer);
    const result = await confirm(await preview());
    expect(result).toMatchObject({ failed: true, code, error: expect.stringMatching(/was not scheduled/) });
    expect(result.preview_changed === true).toBe(drift);
    expect(result.success).toBeUndefined();
  });

  test('a repeated Confirm that finds the text already queued says so and reports one message', async () => {
    mockQueue.mockResolvedValueOnce({ status: 200, body: { success: true, id: 'sms-1', scheduledFor: '2099-01-05T15:00:00.000Z', alreadyQueued: true } });
    expect(await confirm(await preview())).toMatchObject({ success: true, message_id: 'sms-1', already_queued: true });
  });

  test('a writer that throws is an unknown outcome, never a retry invitation', async () => {
    mockQueue.mockRejectedValueOnce(new Error('connection reset'));
    expect(await confirm(await preview())).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
  });
});
