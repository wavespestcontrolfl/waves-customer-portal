/**
 * Overlapping calls from one phone line are two PEOPLE, not one
 * (estimator-engine audit 2026-08-30 #1). attributeInboundContact used to
 * reuse the newest phone-matched lead unconditionally, clobbering the first
 * call's twilio_call_sid and colliding both callers' extractions on one row.
 * When the lead's linked call is a DIFFERENT sid still in flight, the touch
 * must mint a fresh lead; a completed/stale/absent other call keeps reuse.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-funnel-bridge', () => ({ bridgeLeadFunnelStage: jest.fn() }));

const db = require('../models/db');
const { attributeInboundContact } = require('../services/lead-attribution');

function makeDb({ existingLead = null, otherCall = null, leadUpdateCount = 1 } = {}) {
  const state = { leadInserts: [], activityInserts: [], leadUpdates: [] };
  db.mockImplementation((table) => {
    const b = {
      where: jest.fn((arg) => { if (typeof arg === 'function') arg(b); return b; }),
      whereNull: jest.fn(() => b),
      orWhere: jest.fn(() => b),
      orderBy: jest.fn(() => b),
      first: jest.fn(async () => {
        if (table === 'lead_sources') return null;
        if (table === 'customers') return null;
        if (table === 'leads') return existingLead;
        if (table === 'call_log') return otherCall;
        return null;
      }),
      update: jest.fn(async (payload) => {
        state.leadUpdates.push({ table, payload });
        return table === 'leads' ? leadUpdateCount : 1;
      }),
      insert: jest.fn((payload) => {
        state[table === 'leads' ? 'leadInserts' : 'activityInserts'].push(payload);
        const chain = Promise.resolve([{ id: 'new-lead-1', ...payload }]);
        chain.returning = () => Promise.resolve([{ id: 'new-lead-1', ...payload }]);
        return chain;
      }),
    };
    return b;
  });
  return state;
}

const CALL = { from: '+19415550101', to: '+19415559999', type: 'call', callSid: 'CA-second' };

beforeEach(() => jest.clearAllMocks());

describe('attributeInboundContact concurrent-call guard', () => {
  test('an in-flight other call on the matched lead mints a FRESH lead with the shared-phone note', async () => {
    const state = makeDb({
      existingLead: { id: 'lead-1', twilio_call_sid: 'CA-first', follow_up_count: 0 },
      otherCall: { status: 'in-progress', created_at: new Date() },
    });
    const result = await attributeInboundContact(CALL);
    expect(result.type).toBe('new_lead');
    expect(state.leadInserts).toHaveLength(1);
    expect(state.leadInserts[0].twilio_call_sid).toBe('CA-second');
    expect(state.leadUpdates).toHaveLength(0);
    const activity = state.activityInserts.find((a) => a.activity_type === 'created');
    expect(activity.description).toMatch(/lead-1/);
    expect(JSON.parse(activity.metadata).sharedPhoneWithLeadId).toBe('lead-1');
  });

  test('a COMPLETED other call keeps today’s reuse (sequential caller, same person)', async () => {
    const state = makeDb({
      existingLead: { id: 'lead-1', twilio_call_sid: 'CA-first', follow_up_count: 0 },
      otherCall: { status: 'completed', created_at: new Date() },
    });
    const result = await attributeInboundContact(CALL);
    expect(result).toMatchObject({ type: 'existing_lead', leadId: 'lead-1' });
    expect(state.leadInserts).toHaveLength(0);
  });

  test('a stale non-terminal other call (>30 min) keeps reuse — not concurrent', async () => {
    const state = makeDb({
      existingLead: { id: 'lead-1', twilio_call_sid: 'CA-first', follow_up_count: 0 },
      otherCall: { status: 'in-progress', created_at: new Date(Date.now() - 45 * 60 * 1000) },
    });
    const result = await attributeInboundContact(CALL);
    expect(result).toMatchObject({ type: 'existing_lead', leadId: 'lead-1' });
    expect(state.leadInserts).toHaveLength(0);
  });

  test('no call_log row for the other sid proves nothing — reuse stands', async () => {
    const state = makeDb({
      existingLead: { id: 'lead-1', twilio_call_sid: 'CA-first', follow_up_count: 0 },
      otherCall: null,
    });
    const result = await attributeInboundContact(CALL);
    expect(result).toMatchObject({ type: 'existing_lead', leadId: 'lead-1' });
    expect(state.leadInserts).toHaveLength(0);
  });

  test('same sid on the lead (retry of this call) reuses without a call_log read', async () => {
    const state = makeDb({
      existingLead: { id: 'lead-1', twilio_call_sid: 'CA-second', follow_up_count: 0 },
    });
    const result = await attributeInboundContact(CALL);
    expect(result).toMatchObject({ type: 'existing_lead', leadId: 'lead-1' });
    expect(state.leadInserts).toHaveLength(0);
  });

  test('a lost sid race (guarded update hits 0 rows) mints a fresh lead instead of colliding', async () => {
    // Both calls read the lead while it still pointed at a COMPLETED
    // historical call; the other call won the conditional write first.
    const state = makeDb({
      existingLead: { id: 'lead-1', twilio_call_sid: 'CA-old-completed', follow_up_count: 0 },
      otherCall: { status: 'completed', created_at: new Date(Date.now() - 60 * 60 * 1000) },
      leadUpdateCount: 0,
    });
    const result = await attributeInboundContact(CALL);
    expect(result.type).toBe('new_lead');
    expect(state.leadInserts).toHaveLength(1);
    const activity = state.activityInserts.find((a) => a.activity_type === 'created');
    expect(JSON.parse(activity.metadata).sharedPhoneWithLeadId).toBe('lead-1');
  });

  test('SMS touches never run the guard', async () => {
    const state = makeDb({
      existingLead: { id: 'lead-1', twilio_call_sid: 'CA-first', follow_up_count: 0 },
      otherCall: { status: 'in-progress', created_at: new Date() },
    });
    const result = await attributeInboundContact({
      from: '+19415550101', to: '+19415559999', type: 'sms', messageSid: 'SM-1',
    });
    expect(result).toMatchObject({ type: 'existing_lead', leadId: 'lead-1' });
    expect(state.leadInserts).toHaveLength(0);
  });
});
