/**
 * Voicemail text-back prefill attach (routes/lead-webhook.js).
 *
 * attachVoicemailPrefillLead is the ONE data path shared by both webhook
 * branches — the acquisition path AND the existing-customer early return
 * (which previously skipped the attach entirely, stranding the open
 * call-pipeline lead when the office had already converted the prospect).
 * Pins the contract both callers rely on: the token gate (invalid/missing
 * token → null, no db write), the attachability filters (terminal statuses +
 * converted leads never re-attach), the 'unresponsive' reopen, the jsonb
 * MERGE of the provenance stage (never a replace), and the error fallback
 * (attach failure returns null so callers fall back to their default path).
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/lead-prefill-token', () => ({
  verifyLeadPrefillToken: jest.fn(() => true),
}));

const db = require('../models/db');
const { verifyLeadPrefillToken } = require('../utils/lead-prefill-token');
const { _test } = require('../routes/lead-webhook');
const { attachVoicemailPrefillLead } = _test;

const LEAD_ID = '3f2f7b9c-1111-4222-8333-abcdefabcdef';

// Update-chain builder: update() records the payload and stays chainable so
// .returning('*') can resolve the scripted row list (mirrors knex).
let state;
function makeBuilder(table) {
  const b = { table, wheres: [], whereNotIns: [], whereNulls: [] };
  b.where = jest.fn((arg) => { b.wheres.push(arg); return b; });
  b.whereNotIn = jest.fn((col, vals) => { b.whereNotIns.push([col, vals]); return b; });
  b.whereNull = jest.fn((col) => { b.whereNulls.push(col); return b; });
  b.update = jest.fn((payload) => {
    state.updates.push({ table, payload, builder: b });
    if (state.updateError) return { returning: () => Promise.reject(state.updateError) };
    return b;
  });
  b.returning = jest.fn(() => Promise.resolve(state.returningRows));
  return b;
}

beforeEach(() => {
  jest.clearAllMocks();
  state = { updates: [], returningRows: [], updateError: null };
  db.mockImplementation((table) => makeBuilder(table));
  db.raw.mockImplementation((sql, bindings) => ({ __raw: sql, bindings }));
  verifyLeadPrefillToken.mockReturnValue(true);
});

function callArgs(overrides = {}) {
  return {
    body: { prefill_lead_id: LEAD_ID, prefill_token: '1760000000.sig', ...overrides.body },
    fields: {
      first_name: 'Dana', last_name: 'Rivera',
      phone: '+19415550101', email: 'dana@example.com',
      address: '123 Palm Ave', city: 'Bradenton',
      service_interest: 'termite', customer_id: 'cust-1',
      ...overrides.fields,
    },
    webhookStage: overrides.webhookStage || { stage: 'lead_webhook_received' },
  };
}

describe('attachVoicemailPrefillLead — token gate', () => {
  test('missing prefill pair → null, no db write', async () => {
    const result = await attachVoicemailPrefillLead(callArgs({ body: { prefill_lead_id: '', prefill_token: '' } }));
    expect(result).toBeNull();
    expect(db).not.toHaveBeenCalled();
    expect(verifyLeadPrefillToken).not.toHaveBeenCalled();
  });

  test('non-UUID lead id → null before signature verification', async () => {
    const result = await attachVoicemailPrefillLead(callArgs({ body: { prefill_lead_id: 'not-a-uuid' } }));
    expect(result).toBeNull();
    expect(verifyLeadPrefillToken).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('bad signature → null, no db write', async () => {
    verifyLeadPrefillToken.mockReturnValue(false);
    const result = await attachVoicemailPrefillLead(callArgs());
    expect(result).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('camelCase body keys are accepted too', async () => {
    state.returningRows = [{ id: LEAD_ID }];
    const result = await attachVoicemailPrefillLead(callArgs({
      body: { prefill_lead_id: undefined, prefill_token: undefined, prefillLeadId: LEAD_ID, prefillToken: '1760000000.sig' },
    }));
    expect(result).toMatchObject({ id: LEAD_ID });
  });
});

describe('attachVoicemailPrefillLead — attach semantics', () => {
  test('valid token updates the lead and returns the attached row', async () => {
    state.returningRows = [{ id: LEAD_ID, status: 'new' }];
    const result = await attachVoicemailPrefillLead(callArgs());
    expect(result).toMatchObject({ id: LEAD_ID });

    const { payload, builder } = state.updates[0];
    expect(state.updates[0].table).toBe('leads');
    // Typed values win.
    expect(payload).toMatchObject({
      first_name: 'Dana', last_name: 'Rivera',
      phone: '+19415550101', customer_id: 'cust-1',
    });
    // Keyed to the token's lead id only.
    expect(builder.wheres).toContainEqual({ id: LEAD_ID });
  });

  test('terminal and converted leads are excluded by the query filters', async () => {
    state.returningRows = [];
    const result = await attachVoicemailPrefillLead(callArgs());
    // No row matched (e.g. status won / converted_at set) → null, caller
    // falls back to its default path instead of resurrecting a closed lead.
    expect(result).toBeNull();

    const { builder } = state.updates[0];
    expect(builder.whereNotIns).toContainEqual(['status', ['won', 'lost', 'disqualified', 'duplicate']]);
    expect(builder.whereNulls).toContain('converted_at');
  });

  test("reopens an 'unresponsive' lead (closed bucket in the admin UI)", async () => {
    state.returningRows = [{ id: LEAD_ID, status: 'new' }];
    await attachVoicemailPrefillLead(callArgs());
    const { payload } = state.updates[0];
    expect(String(payload.status.__raw)).toContain("WHEN status = 'unresponsive' THEN 'new'");
  });

  test('provenance stage is MERGED into extracted_data, never a replace', async () => {
    state.returningRows = [{ id: LEAD_ID }];
    const stage = { stage: 'lead_webhook_received', existing_customer_attach: true };
    await attachVoicemailPrefillLead(callArgs({ webhookStage: stage }));
    const { payload } = state.updates[0];
    expect(String(payload.extracted_data.__raw)).toContain("COALESCE(extracted_data, '{}'::jsonb) ||");
    expect(payload.extracted_data.bindings[0]).toBe(JSON.stringify(stage));
  });

  test('attach error → null (caller falls back), never throws', async () => {
    state.updateError = new Error('deadlock');
    await expect(attachVoicemailPrefillLead(callArgs())).resolves.toBeNull();
  });
});
