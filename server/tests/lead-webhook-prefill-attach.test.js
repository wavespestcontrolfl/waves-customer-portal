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
const { attachVoicemailPrefillLead, attachOpenCallLeadByPhone } = _test;

const LEAD_ID = '3f2f7b9c-1111-4222-8333-abcdefabcdef';

// Update-chain builder: update() records the payload and stays chainable so
// .returning('*') can resolve the scripted row list (mirrors knex). first()
// serves the phone-match candidate select; select builders (no update call)
// and update builders share the shape.
let state;
function makeBuilder(table) {
  const b = { table, wheres: [], whereRaws: [], whereIns: [], whereNotIns: [], whereNulls: [] };
  b.where = jest.fn((arg) => { b.wheres.push(arg); return b; });
  b.whereRaw = jest.fn((sql, bindings) => { b.whereRaws.push([sql, bindings]); return b; });
  b.whereIn = jest.fn((col, vals) => { b.whereIns.push([col, vals]); return b; });
  b.whereNotIn = jest.fn((col, vals) => { b.whereNotIns.push([col, vals]); return b; });
  b.whereNull = jest.fn((col) => { b.whereNulls.push(col); return b; });
  b.orderBy = jest.fn(() => b);
  b.limit = jest.fn(() => {
    state.selects.push({ table, builder: b });
    return Promise.resolve(state.customerRows);
  });
  b.first = jest.fn(() => {
    state.selects.push({ table, builder: b });
    return state.selectError ? Promise.reject(state.selectError) : Promise.resolve(state.candidateRow);
  });
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
  state = { updates: [], selects: [], returningRows: [], candidateRow: null, customerRows: [], updateError: null, selectError: null };
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

// ---------------------------------------------------------------------------
// Phone-match fallback (attachOpenCallLeadByPhone) — the token-less path for
// a prospect who left a voicemail but submitted a form without the text-back
// prefill link. Pins: the candidate filters (call-channel only, open, not
// deleted), the cross-customer and first-name conflict guards, the
// non-empty-fields-only merge, and the shared attach UPDATE semantics.
// ---------------------------------------------------------------------------

const CALL_LEAD_ID = '9a8b7c6d-2222-4333-9444-fedcbafedcba';

function phoneArgs(overrides = {}) {
  return {
    phoneFormatted: '+19415550101',
    typedFirstName: 'Dana',
    fields: {
      first_name: 'Dana', last_name: 'Rivera',
      phone: '+19415550101', email: 'dana@example.com',
      address: '123 Palm Ave', city: 'Bradenton',
      service_interest: 'termite', customer_id: 'cust-1',
      ...overrides.fields,
    },
    webhookStage: overrides.webhookStage || { stage: 'lead_webhook_received' },
    ...overrides.top,
  };
}

describe('attachOpenCallLeadByPhone — candidate gate', () => {
  test('unusable phone → null, no db read', async () => {
    const result = await attachOpenCallLeadByPhone(phoneArgs({ top: { phoneFormatted: '555' } }));
    expect(result).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('no open call lead on the number → null, no update', async () => {
    state.candidateRow = null;
    const result = await attachOpenCallLeadByPhone(phoneArgs());
    expect(result).toBeNull();
    expect(state.updates).toHaveLength(0);

    // Candidate select is scoped to open CALL-channel leads only — form/SMS
    // dups belong to the upstream customer dedup, never to this attach.
    // Positive open-status membership (shared lead-statuses set), NOT a
    // not-in-terminal filter: an office-closed 'unresponsive' lead must not
    // resurrect on a bare phone match (codex P1) — only the signed token
    // proves the prospect is responding to THAT lead.
    const { builder } = state.selects[0];
    expect(builder.wheres).toContainEqual({ first_contact_channel: 'call' });
    expect(builder.whereRaws[0][1]).toEqual(['9415550101']);
    expect(builder.whereIns).toContainEqual(['status', ['new', 'contacted', 'estimate_sent', 'estimate_viewed']]);
    expect(builder.whereNotIns).toHaveLength(0);
    expect(builder.whereNulls).toContain('converted_at');
    expect(builder.whereNulls).toContain('deleted_at');
  });

  test('phone shared by 2+ customer rows → null, no update (ambiguous account pick)', async () => {
    state.candidateRow = { id: CALL_LEAD_ID, first_name: null, customer_id: null };
    state.customerRows = [{ id: 'cust-1' }, { id: 'cust-2' }];
    const result = await attachOpenCallLeadByPhone(phoneArgs());
    expect(result).toBeNull();
    expect(state.updates).toHaveLength(0);
  });

  test('candidate linked to a DIFFERENT customer → null, no update (shared line)', async () => {
    state.candidateRow = { id: CALL_LEAD_ID, first_name: 'Dana', customer_id: 'cust-OTHER' };
    const result = await attachOpenCallLeadByPhone(phoneArgs());
    expect(result).toBeNull();
    expect(state.updates).toHaveLength(0);
  });

  test('typed first name conflicts with captured first name → null, no update', async () => {
    state.candidateRow = { id: CALL_LEAD_ID, first_name: 'Miguel', customer_id: null };
    const result = await attachOpenCallLeadByPhone(phoneArgs());
    expect(result).toBeNull();
    expect(state.updates).toHaveLength(0);
  });

  test("webhook 'Unknown' placeholder is not a typed name — attach proceeds", async () => {
    state.candidateRow = { id: CALL_LEAD_ID, first_name: 'Miguel', customer_id: null };
    state.returningRows = [{ id: CALL_LEAD_ID }];
    const result = await attachOpenCallLeadByPhone(phoneArgs({
      top: { typedFirstName: 'Unknown' },
      fields: { first_name: 'Unknown', last_name: '' },
    }));
    expect(result).toMatchObject({ id: CALL_LEAD_ID });
    // ...but the placeholder never overwrites the captured name.
    expect(state.updates[0].payload).not.toHaveProperty('first_name');
    expect(state.updates[0].payload).not.toHaveProperty('last_name');
  });
});

describe('attachOpenCallLeadByPhone — attach semantics', () => {
  test('open nameless voicemail lead attaches; update keyed to candidate id with open guards', async () => {
    state.candidateRow = { id: CALL_LEAD_ID, first_name: null, customer_id: null };
    state.returningRows = [{ id: CALL_LEAD_ID, status: 'new' }];
    const result = await attachOpenCallLeadByPhone(phoneArgs());
    expect(result).toMatchObject({ id: CALL_LEAD_ID });

    const { payload, builder } = state.updates[0];
    expect(state.updates[0].table).toBe('leads');
    expect(payload).toMatchObject({
      first_name: 'Dana', last_name: 'Rivera',
      phone: '+19415550101', customer_id: 'cust-1',
    });
    // Atomic re-check (codex P2): the candidate guards ride inside the
    // UPDATE's WHERE so a concurrent claim/edit makes the UPDATE miss.
    expect(builder.wheres).toContainEqual({ id: CALL_LEAD_ID });
    expect(builder.whereIns).toContainEqual(['status', ['new', 'contacted', 'estimate_sent', 'estimate_viewed']]);
    expect(builder.whereNulls).toContain('converted_at');
    // Ownership guard: unlinked-or-same-customer, as a grouped where.
    expect(builder.wheres.some((w) => typeof w === 'function')).toBe(true);
    // Name guard: captured first name absent or normalizes to the typed one.
    expect(builder.whereRaws.some(([sql, bindings]) =>
      sql.includes("lower(regexp_replace(first_name") && bindings[0] === 'dana')).toBe(true);
    // Shared updater semantics: jsonb MERGE (reopen CASE is unreachable here
    // — phone-match candidates are already open — but harmless).
    expect(String(payload.status.__raw)).toContain("WHEN status = 'unresponsive' THEN 'new'");
    expect(String(payload.extracted_data.__raw)).toContain("COALESCE(extracted_data, '{}'::jsonb) ||");
  });

  test('no typed first name → no name guard in the UPDATE (nothing to conflict)', async () => {
    state.candidateRow = { id: CALL_LEAD_ID, first_name: 'Miguel', customer_id: null };
    state.returningRows = [{ id: CALL_LEAD_ID }];
    await attachOpenCallLeadByPhone(phoneArgs({
      top: { typedFirstName: 'Unknown' },
      fields: { first_name: 'Unknown', last_name: '' },
    }));
    const { builder } = state.updates[0];
    expect(builder.whereRaws.some(([sql]) => sql.includes('regexp_replace(first_name'))).toBe(false);
  });

  test('empty typed values never blank captured data (token attach stays typed-wins)', async () => {
    state.candidateRow = { id: CALL_LEAD_ID, first_name: 'Dana', customer_id: null };
    state.returningRows = [{ id: CALL_LEAD_ID }];
    await attachOpenCallLeadByPhone(phoneArgs({
      fields: { last_name: '', email: null, address: '', service_interest: null },
    }));
    const { payload } = state.updates[0];
    expect(payload).toMatchObject({ first_name: 'Dana', customer_id: 'cust-1' });
    expect(payload).not.toHaveProperty('last_name');
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('address');
    expect(payload).not.toHaveProperty('service_interest');
  });

  test('closed-between-lookup-and-update → UPDATE matches nothing → null', async () => {
    state.candidateRow = { id: CALL_LEAD_ID, first_name: null, customer_id: null };
    state.returningRows = [];
    await expect(attachOpenCallLeadByPhone(phoneArgs())).resolves.toBeNull();
  });

  test('select error → null (caller falls back), never throws', async () => {
    state.selectError = new Error('timeout');
    await expect(attachOpenCallLeadByPhone(phoneArgs())).resolves.toBeNull();
  });

  test('update error → null (caller falls back), never throws', async () => {
    state.candidateRow = { id: CALL_LEAD_ID, first_name: null, customer_id: null };
    state.updateError = new Error('deadlock');
    await expect(attachOpenCallLeadByPhone(phoneArgs())).resolves.toBeNull();
  });
});
