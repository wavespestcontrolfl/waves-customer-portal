// The Call button on an admin bell row about one caller (alert-call-button.js, kind call_back; owner 2026-11-02).
// What the emitters store, which buttons the bell serves under each gate, and what one Call tap reads and runs:
// the linked page's own Call step, with the body that page's button sends. The runner's claim and close rules are
// in admin-alert-buttons.test.js; the call step's own checks in admin-communications-call.test.js.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  alertCallButtonLive: jest.fn(() => true),
  alertCloseButtonsLive: jest.fn(() => true),
}));
jest.mock('../routes/admin-communications', () => ({ placeCallFromAlert: jest.fn() }));
jest.mock('../services/admin-alert-buttons', () => ({
  closeNoteButtons: (id) => ({ kind: 'close_note', items: [{ id, label: id === 'handled' ? 'Handled' : 'Called back' }] }),
  _private: { closeNoteHandler: { run: jest.fn() } },
}));

jest.mock('../services/notification-service', () => ({ _private: { NOTIFICATION_VERSION_SQL: 'md5(content)' } }));

// Rows by table, matched on the where() and whereNull() the module asks for.
const mockTables = { call_log: [], customers: [], leads: [], sms_log: [], notifications: [] };
const mockQueries = [];
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const query = { table, where: null, nulls: [] };
    mockQueries.push(query);
    const q = {
      where: jest.fn((cond) => { query.where = cond; return q; }),
      whereNull: jest.fn((column) => { query.nulls.push(column); return q; }),
      first: jest.fn(async () => (mockTables[table] || []).find((row) => Object.entries(query.where || {})
        .every(([k, v]) => row[k] === v) && query.nulls.every((column) => row[column] == null))),
    };
    return q;
  });
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  return db;
});

const gates = require('../config/feature-gates');
const { placeCallFromAlert } = require('../routes/admin-communications');
const { _private: { closeNoteHandler } } = require('../services/admin-alert-buttons');
const { buttonViolations } = jest.requireActual('../services/admin-alert-compose');
const { callButtons, buttonHandler, pushCallAction, _private: { CALL_PROMPT } } = require('../services/alert-call-button');

const CALL_ID = '00000000-0000-4000-8000-0000000000d1';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const CALL_SID = `CA${'0123456789abcdef'.repeat(2)}`;
const CALLER = '+19415550188';
const OTHER = '+19415550142';
const MAIN_LINE = '+19412975749';
const LEAD_ID = '00000000-0000-4000-8000-0000000000e1';
const SMS_SID = `SM${'fedcba9876543210'.repeat(2)}`;
const ROW_ID = '00000000-0000-4000-8000-0000000000f1';
const ROW_VERSION = 'b'.repeat(32);
const call = (args) => ({ id: 'call', label: 'Call', prompt: CALL_PROMPT, args });
const tap = (args, id = 'call') => buttonHandler.run({ row: { id: 'n1' }, item: { id, ...(args ? { args } : {}) }, technicianId: 't-admin', claimedVersion: 'v' });

beforeEach(() => {
  jest.clearAllMocks();
  mockQueries.length = 0;
  mockTables.call_log = [{ id: CALL_ID, twilio_call_sid: CALL_SID, direction: 'inbound', from_phone: CALLER, to_phone: MAIN_LINE, customer_id: CUSTOMER_ID }];
  mockTables.customers = [{ id: CUSTOMER_ID, phone: '(941) 555-0188', deleted_at: null }];
  mockTables.leads = [{ id: LEAD_ID, phone: OTHER, customer_id: CUSTOMER_ID, deleted_at: null }];
  mockTables.sms_log = [{ twilio_sid: SMS_SID, direction: 'inbound', from_phone: OTHER, customer_id: null }];
  mockTables.notifications = [];
  gates.alertCallButtonLive.mockReturnValue(true);
  gates.alertCloseButtonsLive.mockReturnValue(true);
  placeCallFromAlert.mockResolvedValue({ status: 200, json: { success: true, callSid: 'CAx', callLogId: 'cl-new' } });
});

describe('callButtons: what an emitter stores on the row', () => {
  test('one record to read again at the tap: the call, else its Twilio id, else the customer', () => {
    expect(callButtons({ callLogId: CALL_ID, callSid: CALL_SID, customerId: CUSTOMER_ID })).toEqual({ kind: 'call_back', items: [call({ callLogId: CALL_ID })] });
    expect(callButtons({ callSid: CALL_SID, customerId: CUSTOMER_ID })).toEqual({ kind: 'call_back', items: [call({ callSid: CALL_SID })] });
    expect(callButtons({ callSid: 'CA-not-a-sid', customerId: CUSTOMER_ID })).toEqual({ kind: 'call_back', items: [call({ customerId: CUSTOMER_ID })] });
  });

  test('a new-lead alert names its lead, else the customer, else an unknown sender\'s text', () => {
    expect(callButtons({ leadId: LEAD_ID, customerId: CUSTOMER_ID, smsSid: SMS_SID })).toEqual({ kind: 'call_back', items: [call({ leadId: LEAD_ID })] });
    expect(callButtons({ leadId: null, customerId: CUSTOMER_ID, smsSid: SMS_SID })).toEqual({ kind: 'call_back', items: [call({ customerId: CUSTOMER_ID })] });
    expect(callButtons({ smsSid: SMS_SID })).toEqual({ kind: 'call_back', items: [call({ smsSid: SMS_SID })] });
    expect(callButtons({ smsSid: 'SM-not-a-sid' })).toBeNull();
  });

  test('a close button rides after Call; with no record the row keeps only its close button, or none', () => {
    expect(callButtons({ callLogId: CALL_ID, close: 'called_back' }))
      .toEqual({ kind: 'call_back', items: [call({ callLogId: CALL_ID }), { id: 'called_back', label: 'Called back' }] });
    expect(callButtons({ callLogId: 'not-a-uuid', close: 'handled' })).toEqual({ kind: 'close_note', items: [{ id: 'handled', label: 'Handled' }] });
    expect(callButtons({ customerId: null })).toBeNull();
    expect(callButtons()).toBeNull();
  });

  test('the stored shape passes the alert composer (one-sentence prompt, short label, short args)', () => {
    expect(buttonViolations(callButtons({ callLogId: CALL_ID, close: 'called_back' }))).toEqual([]);
    expect(buttonViolations(callButtons({ callSid: CALL_SID }))).toEqual([]);
    expect(buttonViolations(callButtons({ customerId: CUSTOMER_ID, close: 'handled' }))).toEqual([]);
  });
});

describe('visibleItems: each stored button follows its own gate', () => {
  const rows = [
    { id: 'n1', metadata: { buttons: { kind: 'call_back', items: [call({ callLogId: CALL_ID }), { id: 'called_back', label: 'Called back' }] } } },
    { id: 'n2', metadata: { buttons: { kind: 'call_back', items: [call({ customerId: CUSTOMER_ID })] } } },
  ];

  test.each([
    [true, true, ['call', 'called_back'], ['call']],
    [false, true, ['called_back'], []],
    [true, false, ['call'], ['call']],
    [false, false, [], []],
  ])('Call gate %s, close gate %s', (callOn, closeOn, first, second) => {
    gates.alertCallButtonLive.mockReturnValue(callOn);
    gates.alertCloseButtonsLive.mockReturnValue(closeOn);
    const allowed = buttonHandler.visibleItems(rows);
    expect(allowed.get('n1')).toEqual(first);
    expect(allowed.get('n2')).toEqual(second);
    expect(buttonHandler.live()).toBe(callOn || closeOn);
    expect(mockQueries).toEqual([]);
  });
});

describe('a Call tap: the linked page\'s own Call step, the row left open', () => {
  test('a call: the Call Log\'s "Call back" body, the caller\'s number, the customer named when it is their number', async () => {
    const result = await tap({ callLogId: CALL_ID });
    expect(placeCallFromAlert).toHaveBeenCalledWith({
      body: { to: CALLER, customerId: CUSTOMER_ID, source: 'call-log-callback', relatedCallId: CALL_ID },
      technicianId: 't-admin',
    });
    expect(result).toEqual({ ok: true, keepOpen: true, message: 'Calling your phone now. Press 1 to connect.' });
  });

  test('the record is read at the tap: a caller who is not the customer\'s own number is dialed without naming them', async () => {
    mockTables.call_log[0].from_phone = OTHER;
    await tap({ callLogId: CALL_ID });
    expect(placeCallFromAlert.mock.calls[0][0].body).toEqual({ to: OTHER, source: 'call-log-callback', relatedCallId: CALL_ID });
  });

  test('an outbound call dials the number it called; a call found by its Twilio id is the same call', async () => {
    mockTables.call_log[0] = { ...mockTables.call_log[0], direction: 'outbound-api', from_phone: MAIN_LINE, to_phone: OTHER };
    await tap({ callSid: CALL_SID });
    expect(placeCallFromAlert.mock.calls[0][0].body).toEqual({ to: OTHER, source: 'call-log-callback', relatedCallId: CALL_ID });
  });

  test('a caller number that is no line (withheld, or one of ours) falls back to the linked customer\'s number', async () => {
    for (const from of ['anonymous', MAIN_LINE, '+10005550188']) {
      placeCallFromAlert.mockClear();
      mockTables.call_log[0].from_phone = from;
      await tap({ callLogId: CALL_ID });
      expect(placeCallFromAlert.mock.calls[0][0].body).toEqual({ to: CALLER, customerId: CUSTOMER_ID, source: 'call-log-callback', relatedCallId: CALL_ID });
    }
  });

  test('a customer or a lead: their page\'s Call body, from the customer row as it stands now', async () => {
    await tap({ customerId: CUSTOMER_ID });
    expect(placeCallFromAlert).toHaveBeenCalledWith({ body: { to: CALLER, customerIdHint: CUSTOMER_ID }, technicianId: 't-admin' });
  });

  test('a lead: the Leads page\'s Call Now body, the lead\'s own number with its customer as the hint', async () => {
    await tap({ leadId: LEAD_ID });
    expect(placeCallFromAlert).toHaveBeenCalledWith({ body: { to: OTHER, customerIdHint: CUSTOMER_ID }, technicianId: 't-admin' });
    placeCallFromAlert.mockClear();
    mockTables.leads[0].customer_id = null;
    await tap({ leadId: LEAD_ID });
    expect(placeCallFromAlert.mock.calls[0][0].body).toEqual({ to: OTHER });
    placeCallFromAlert.mockClear();
    mockTables.leads[0].deleted_at = new Date();
    expect(await tap({ leadId: LEAD_ID })).toMatchObject({ ok: false, code: 'no_number' });
    expect(placeCallFromAlert).not.toHaveBeenCalled();
  });

  test('an unknown sender\'s text: the thread\'s Call back body, the sender\'s number; never an outbound text', async () => {
    await tap({ smsSid: SMS_SID });
    expect(placeCallFromAlert).toHaveBeenCalledWith({ body: { to: OTHER }, technicianId: 't-admin' });
    placeCallFromAlert.mockClear();
    mockTables.sms_log[0].direction = 'outbound';
    expect(await tap({ smsSid: SMS_SID })).toMatchObject({ ok: false, code: 'no_number' });
    expect(placeCallFromAlert).not.toHaveBeenCalled();
  });

  test('nothing to dial refuses before the call step: no call, a deleted customer, no usable number', async () => {
    const refused = { ok: false, code: 'no_number', message: 'No number to call. Open the alert to act on it.' };
    expect(await tap({ callLogId: '00000000-0000-4000-8000-0000000000ff' })).toEqual(refused);
    mockTables.customers[0].deleted_at = new Date();
    expect(await tap({ customerId: CUSTOMER_ID })).toEqual(refused);
    mockTables.call_log[0].from_phone = 'anonymous';
    expect(await tap({ callLogId: CALL_ID })).toEqual(refused);
    expect(await tap({})).toEqual(refused);
    expect(await tap(null)).toEqual(refused);
    expect(placeCallFromAlert).not.toHaveBeenCalled();
  });

  test('the call step\'s own refusal is shown as it reads; any other answer refuses with a short note', async () => {
    placeCallFromAlert.mockResolvedValueOnce({ status: 409, json: { error: 'A callback is already ringing or connected. Wait for it to finish.' } });
    expect(await tap({ callLogId: CALL_ID })).toEqual({ ok: false, code: 'busy', message: 'A callback is already ringing or connected. Wait for it to finish.' });
    const couldNot = { ok: false, code: 'refused', message: 'That call could not start. Open the alert to call them.' };
    placeCallFromAlert.mockResolvedValueOnce({ status: 200, json: { success: false, error: 'Voice gate is disabled' } });
    expect(await tap({ callLogId: CALL_ID })).toEqual(couldNot);
    placeCallFromAlert.mockResolvedValueOnce({ status: 400, json: { error: 'to must be a customer phone, not the admin bridge phone' } });
    expect(await tap({ callLogId: CALL_ID })).toEqual(couldNot);
  });

  test('a call step that throws rejects the tap (the runner records it and answers 500)', async () => {
    placeCallFromAlert.mockRejectedValueOnce(new Error('twilio down'));
    await expect(tap({ callLogId: CALL_ID })).rejects.toThrow('twilio down');
  });

  test('with its gate off, Call refuses and places nothing', async () => {
    gates.alertCallButtonLive.mockReturnValue(false);
    expect(await tap({ callLogId: CALL_ID })).toEqual({ ok: false, code: 'off', message: 'These buttons are turned off. Open the alert to act on it.' });
    expect(placeCallFromAlert).not.toHaveBeenCalled();
    expect(mockQueries).toEqual([]);
  });
});

describe('a close button on a Call row: the close_note step itself, under its own gate', () => {
  test('runs the close step and places no call', async () => {
    closeNoteHandler.run.mockResolvedValueOnce({ ok: true, closed: true, message: 'Marked called back.', resolution: 'Called back' });
    const result = await tap(null, 'called_back');
    expect(closeNoteHandler.run).toHaveBeenCalledWith(expect.objectContaining({ item: { id: 'called_back' }, technicianId: 't-admin', claimedVersion: 'v' }));
    expect(result).toEqual({ ok: true, closed: true, message: 'Marked called back.', resolution: 'Called back' });
    expect(placeCallFromAlert).not.toHaveBeenCalled();
  });

  test('with the close gate off it refuses, even while Call is on', async () => {
    gates.alertCloseButtonsLive.mockReturnValue(false);
    expect(await tap(null, 'handled')).toEqual({ ok: false, code: 'off', message: 'These buttons are turned off. Open the alert to act on it.' });
    expect(closeNoteHandler.run).not.toHaveBeenCalled();
  });
});

describe('pushCallAction: the Call on the Waves Admin push', () => {
  const CALL_ROW = (over = {}) => ({ id: ROW_ID, recipient_type: 'admin', done_at: null, version: ROW_VERSION,
    metadata: { buttons: { kind: 'call_back', items: [call({ callLogId: CALL_ID }), { id: 'called_back', label: 'Called back' }] } }, ...over });

  test('an open row with a Call button names itself and the version the bell serves', async () => {
    mockTables.notifications = [CALL_ROW()];
    expect(await pushCallAction(ROW_ID)).toEqual({ callAction: `${ROW_ID}.${ROW_VERSION}`, apnsCategory: 'WAVES_CALL' });
    // A metadata column read as text is parsed the same way.
    mockTables.notifications = [CALL_ROW({ metadata: JSON.stringify(CALL_ROW().metadata) })];
    expect(await pushCallAction(ROW_ID)).toEqual({ callAction: `${ROW_ID}.${ROW_VERSION}`, apnsCategory: 'WAVES_CALL' });
  });

  test('no Call on the push: gate off, a done or missing row, a row without Call, a bad id', async () => {
    mockTables.notifications = [CALL_ROW()];
    gates.alertCallButtonLive.mockReturnValue(false);
    expect(await pushCallAction(ROW_ID)).toBeNull();
    gates.alertCallButtonLive.mockReturnValue(true);
    mockTables.notifications = [CALL_ROW({ done_at: new Date() })];
    expect(await pushCallAction(ROW_ID)).toBeNull();
    mockTables.notifications = [];
    expect(await pushCallAction(ROW_ID)).toBeNull();
    mockTables.notifications = [CALL_ROW({ metadata: { buttons: { kind: 'close_note', items: [{ id: 'called_back', label: 'Called back' }] } } })];
    expect(await pushCallAction(ROW_ID)).toBeNull();
    expect(await pushCallAction('not-a-uuid')).toBeNull();
    expect(await pushCallAction(null)).toBeNull();
  });
});
