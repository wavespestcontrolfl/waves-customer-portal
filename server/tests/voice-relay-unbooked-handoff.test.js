// Sandy unbooked-call hand-off (GATE_RELAY_UNBOOKED_HANDOFF, dark): a
// production call that ends ai_handled with caller speech, no booking, no lead
// and no transfer rings ONE office bell and enters the lead pipeline, once.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true })) }));
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn(async () => ({ leadId: 'L-1', created: true })) }));
jest.mock('../services/voice-agent/relay-context', () => ({ stampCallLeadLinkage: jest.fn(async () => true) }));

const { triggerNotification } = require('../services/notification-triggers');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');
const { stampCallLeadLinkage } = require('../services/voice-agent/relay-context');
const handoff = require('../services/voice-agent/relay-unbooked-handoff');

const SID = 'CA-unbooked-1';

function makeDb({ claim = [{ id: 'call-row-1', call_summary: 'AI phone assistant call. Caller said: I want quarterly service | I need a quote' }] } = {}) {
  const wheres = [];
  const updates = [];
  const builder = {
    where: jest.fn(() => builder),
    whereRaw: jest.fn((sql) => { wheres.push(sql); return builder; }),
    update: jest.fn(async (patch) => { updates.push(patch); return updates.length === 1 ? claim : 1; }),
    insert: jest.fn(async () => [1]),
  };
  const db = jest.fn(() => builder);
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return { db, builder, wheres, updates };
}

const facts = (over = {}) => ({
  callSid: SID, from: '+19415550133', to: '+19415550100', sandbox: false, sessionKey: 'nonce-1',
  callerVerified: true, language: null, callerTurnCount: 2,
  bookingRequested: false, reserviceFiled: false, transferRequested: false, leadCaptured: false, leadId: null,
  estimateFields: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_RELAY_UNBOOKED_HANDOFF = 'true';
});
afterAll(() => { delete process.env.GATE_RELAY_UNBOOKED_HANDOFF; });

describe('gate', () => {
  test('off: no database read or write, no bell, no lead', async () => {
    delete process.env.GATE_RELAY_UNBOOKED_HANDOFF;
    const { db } = makeDb();
    await expect(handoff.runUnbookedHandoff({ ...facts(), db })).resolves.toMatchObject({ claimed: false, belled: false });
    expect(db).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

  test('registered dark in feature-gates with its own reader', () => {
    const gates = require('../config/feature-gates');
    expect(gates.relayUnbookedHandoffLive()).toBe(true);
    process.env.GATE_RELAY_UNBOOKED_HANDOFF = '1';
    expect(gates.relayUnbookedHandoffLive()).toBe(false);
    delete process.env.GATE_RELAY_UNBOOKED_HANDOFF;
    expect(gates.relayUnbookedHandoffLive()).toBe(false);
    expect(gates.gates.relayUnbookedHandoff).toBe(false);
  });
});

describe('an unbooked, uncaptured, untransferred call', () => {
  test('claims the stamp, writes one lead, rings one bell keyed by CallSid', async () => {
    const { db, updates } = makeDb();
    const out = await handoff.runUnbookedHandoff({ ...facts({ estimateFields: { first_name: 'Pat', email: 'pat@example.test' } }), db });
    expect(out).toEqual({ claimed: true, leadId: 'L-1', belled: true });
    expect(updates[0].metadata.sql).toContain('relay_unbooked_alerted_at');
    expect(createLeadFromExtraction).toHaveBeenCalledTimes(1);
    const [extracted, opts] = createLeadFromExtraction.mock.calls[0];
    expect(extracted).toMatchObject({ first_name: 'Pat', email: 'pat@example.test' });
    expect(extracted.call_summary).toContain('quarterly service');
    expect(opts).toMatchObject({ summarySource: 'sandy_unbooked', phone: '+19415550133', callSid: SID, aniVerified: true, sessionKey: 'nonce-1' });
    expect(stampCallLeadLinkage).toHaveBeenCalledWith(SID, 'L-1', { sessionKey: 'nonce-1' });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(triggerNotification).toHaveBeenCalledWith('relay_unbooked_call', expect.objectContaining({ callLogId: 'call-row-1', callSid: SID, phone: '+19415550133' }),
      { dedupeKey: `relay-unbooked:${SID}` });
  });

  test('the claim re-proves every "an artifact exists" fact on the row, and excludes the sandbox', async () => {
    const { db, wheres, builder } = makeDb();
    await handoff.runUnbookedHandoff({ ...facts(), db });
    const all = wheres.join(' | ');
    expect(all).toContain("COALESCE(??, '') <> ?"); // whereNotSandboxCall
    expect(all).toContain('relay_unbooked_alerted_at');
    expect(all).toContain('relay_lead_id');
    expect(all).toContain('relay_reservice_filed');
    expect(all).toContain('relay_handoff');
    expect(all).toContain('outbound_booking_review');
    expect(all).toContain('FROM leads');
    expect(builder.where).toHaveBeenCalledWith('call_outcome', 'ai_handled');
  });

  test('the session fence rides the claim statement', async () => {
    const { db } = makeDb();
    const fence = jest.fn((q) => q);
    await handoff.runUnbookedHandoff({ ...facts(), db, fence });
    expect(fence).toHaveBeenCalledTimes(1);
  });

  test('an unusable number: no lead write, the bell still rings', async () => {
    const { db } = makeDb();
    await expect(handoff.runUnbookedHandoff({ ...facts({ from: '' }), db })).resolves.toEqual({ claimed: true, leadId: null, belled: true });
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('an existing customer (the writer creates no lead): the bell still rings', async () => {
    createLeadFromExtraction.mockResolvedValueOnce({ leadId: null, customerId: 'c-1', created: false });
    const { db } = makeDb();
    await expect(handoff.runUnbookedHandoff({ ...facts(), db })).resolves.toEqual({ claimed: true, leadId: null, belled: true });
  });

  test('a lead failure never costs the bell', async () => {
    createLeadFromExtraction.mockRejectedValueOnce(new Error('db down'));
    const { db } = makeDb();
    await expect(handoff.runUnbookedHandoff({ ...facts(), db })).resolves.toEqual({ claimed: true, leadId: null, belled: true });
  });

  test('a bell that never landed, with no lead, gives the claim back so a later close may retry', async () => {
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, prefsUnavailable: true });
    createLeadFromExtraction.mockResolvedValueOnce({ leadId: null });
    const { db, updates } = makeDb();
    await handoff.runUnbookedHandoff({ ...facts(), db });
    expect(updates).toHaveLength(2);
    expect(updates[1].metadata.sql).toContain("- 'relay_unbooked_alerted_at'");
  });
});

describe('nothing to do', () => {
  test.each([
    ['a booked call', { bookingRequested: true }],
    ['a lead already captured', { leadCaptured: true }],
    ['a lead id already linked', { leadId: 'L-9' }],
    ['a re-service filed', { reserviceFiled: true }],
    ['a transfer to the office', { transferRequested: true }],
    ['a sandbox call', { sandbox: true }],
    ['a caller who never spoke', { callerTurnCount: 0 }],
  ])('%s: the database is never touched', async (_n, over) => {
    const { db } = makeDb();
    await expect(handoff.runUnbookedHandoff({ ...facts(over), db })).resolves.toMatchObject({ claimed: false });
    expect(db).not.toHaveBeenCalled();
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

  test('a second reconcile for the same call: the claim matches 0 rows, no bell, no lead', async () => {
    const first = makeDb();
    await handoff.runUnbookedHandoff({ ...facts(), db: first.db });
    jest.clearAllMocks();
    const second = makeDb({ claim: [] }); // the stamp is on the row now
    await expect(handoff.runUnbookedHandoff({ ...facts(), db: second.db })).resolves.toEqual({ claimed: false, leadId: null, belled: false });
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

  test('a database error is swallowed (the close is already durable)', async () => {
    const { db, builder } = makeDb();
    builder.update.mockRejectedValueOnce(new Error('boom'));
    await expect(handoff.runUnbookedHandoff({ ...facts(), db })).resolves.toEqual({ claimed: false, leadId: null, belled: false });
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});

describe('the trigger', () => {
  test('relay_unbooked_call is a high-priority Communication bell that opens the call', () => {
    jest.isolateModules(() => {
      jest.unmock('../services/notification-triggers');
      jest.doMock('../models/db', () => jest.fn());
      jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
      jest.doMock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn() }));
      jest.doMock('../services/admin-unread', () => ({ getUnreadCountForAdmin: jest.fn() }));
      const real = require('../services/notification-triggers');
      const t = real.TRIGGER_REGISTRY.relay_unbooked_call;
      expect(t).toMatchObject({ label: 'Sandy call ended without a booking', priority: 'high', group: 'Communication', allowContactDetails: true });
      const built = t.build({ callLogId: 'call-1', phone: '+19415550133', summary: 'Caller said: I need a quote' });
      expect(built.title).toBe('Sandy call ended without a booking');
      expect(built.body).toContain('+19415550133');
      expect(built.body).toContain('I need a quote');
      expect(built.link).toBe('/admin/communications#tab=calls&call=call-1');
    });
  });
});
