/**
 * Auto-applied contact corrections (GATE_CONTACT_CORRECTION, dark by
 * default): customer-stated name/email/address corrections from inbound
 * SMS and processed calls apply to the customer record inside ONE
 * transaction (row-locked read, field updates, agent_decisions audit rows,
 * canonical Customer-360 fan-outs), with one FYI bell per batch. NEVER
 * phone, linked customers only, fail-soft at the boundary.
 *
 * Behavioral tests run the real service against a filtering knex stub with
 * SYNTHETIC fixtures only — no real customer data. The stub emulates
 * transaction rollback so the atomicity contract (audit failure rolls the
 * customer mutation back) is covered behaviorally, not as mocked SQL text.
 */

// Synthetic ids only — never real customer data.
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const CALL_ID = '00000000-0000-4000-8000-0000000000a1';

const mockIsEnabled = jest.fn();
jest.mock('../config/feature-gates', () => ({ isEnabled: (key) => mockIsEnabled(key) }));

const mockNotifyAdmin = jest.fn().mockResolvedValue({ id: 'notif-1' });
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
}));

const mockCallAnthropic = jest.fn();
jest.mock('../services/llm/call', () => ({
  callAnthropic: (...args) => mockCallAnthropic(...args),
}));

const mockSyncPrimaryAddress = jest.fn().mockResolvedValue(null);
const mockSyncPrimaryCoords = jest.fn().mockResolvedValue(null);
jest.mock('../services/customer-properties', () => ({
  syncPrimaryAddress: (...args) => mockSyncPrimaryAddress(...args),
  syncPrimaryCoordsFromCustomer: (...args) => mockSyncPrimaryCoords(...args),
}));
const mockAddressFanout = jest.fn().mockResolvedValue(null);
jest.mock('../services/customer-address-fanout', () => ({
  propagateCustomerAddressChange: (...args) => mockAddressFanout(...args),
}));
const mockEmailFanout = jest.fn().mockResolvedValue(null);
const mockResendPendingConfirmation = jest.fn().mockResolvedValue(null);
jest.mock('../services/customer-email-fanout', () => ({
  propagateCustomerEmailChange: (...args) => mockEmailFanout(...args),
  resendPendingConfirmation: (...args) => mockResendPendingConfirmation(...args),
}));
const mockNameFanout = jest.fn().mockResolvedValue(null);
jest.mock('../services/customer-contact-fanout', () => ({
  propagateCustomerNameChange: (...args) => mockNameFanout(...args),
}));
const mockGeocode = jest.fn().mockResolvedValue(null);
const mockRegeocodeGuarded = jest.fn().mockResolvedValue(null);
jest.mock('../services/geocoder', () => ({
  ensureCustomerGeocoded: (...args) => mockGeocode(...args),
  regeocodeCustomerAddressGuarded: (...args) => mockRegeocodeGuarded(...args),
}));
const mockNewsletterResume = jest.fn().mockResolvedValue(null);
jest.mock('../services/lead-first-touch-resume', () => ({
  resumeHeldNewsletterPostCommit: (...args) => mockNewsletterResume(...args),
}));

const {
  detectContactCorrectionIntent,
  extractSmsContactCorrections,
  applyContactCorrections,
  runSmsContactCorrection,
  runCallContactCorrection,
  APPLYABLE_FIELDS,
} = require('../services/contact-correction');

// ---------------------------------------------------------------------------
// Filtering knex stub with transactional rollback — supports exactly the
// shapes the service issues.
// ---------------------------------------------------------------------------
function makeStubKnex(rowsByTable = {}) {
  let data = {};
  for (const [table, rows] of Object.entries(rowsByTable)) data[table] = rows.map((r) => ({ ...r }));
  const inserts = [];
  const forUpdates = [];
  const failInsertOn = { table: null };

  function builder(table) {
    if (!data[table]) data[table] = [];
    const preds = [];
    const chain = {
      where(a, b, c) {
        if (typeof a === 'function') {
          const branches = [[]];
          const current = () => branches[branches.length - 1];
          const group = {
            where(col, op, val) {
              if (val !== undefined && op === '>=') current().push((r) => r[col] != null && Number(r[col]) >= Number(val));
              else current().push((r) => r[col] === op);
              return group;
            },
            orWhere(fn2) {
              branches.push([]);
              if (typeof fn2 === 'function') { const inner = builderGroup(fn2); current().push(inner); return group; }
              return group;
            },
            whereNull(col) { current().push((r) => r[col] == null); return group; },
          };
          function builderGroup(fn2) {
            const g2preds = [];
            const g2 = {
              where(col, val) { g2preds.push((r) => r[col] === val); return g2; },
              whereNull(col) { g2preds.push((r) => r[col] == null); return g2; },
            };
            fn2.call(g2, g2);
            return (r) => g2preds.every((p) => p(r));
          }
          a.call(group, group);
          preds.push((row) => branches.some((br) => br.every((p) => p(row))));
        } else if (typeof a === 'object') preds.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (c !== undefined && b === '>=') preds.push((r) => r[a] != null && Number(r[a]) >= Number(c));
        else preds.push((r) => r[a] === b);
        return chain;
      },
      whereNull(col) { preds.push((r) => r[col] == null); return chain; },
      whereNot(obj) { preds.push((r) => !Object.entries(obj).every(([k, v]) => r[k] === v)); return chain; },
      whereRaw(sql, params) {
        if (/LOWER\(email\)/.test(sql)) {
          preds.push((r) => String(r.email || '').toLowerCase() === String(params[0]).toLowerCase());
          return chain;
        }
        if (/dedupeKey/.test(sql)) {
          preds.push((r) => (r.metadata && r.metadata.dedupeKey) === params[0]);
          return chain;
        }
        throw new Error(`stub knex: unsupported whereRaw ${sql}`);
      },
      whereNotNull(col) { preds.push((r) => r[col] != null); return chain; },
      whereIn(col, list) { preds.push((r) => list.includes(r[col])); return chain; },
      orderBy() { return chain; }, // fixtures are pre-sorted newest-first
      forUpdate() { forUpdates.push(table); return chain; },
      first(cols) {
        const row = data[table].find((r) => preds.every((p) => p(r)));
        if (!row) return Promise.resolve(undefined);
        if (Array.isArray(cols)) {
          const out = {};
          for (const c of cols) out[c] = row[c];
          return Promise.resolve(out);
        }
        return Promise.resolve({ ...row });
      },
      select(...cols) {
        const flat = cols.flat();
        return Promise.resolve(data[table]
          .filter((r) => preds.every((p) => p(r)))
          .map((r) => {
            const out = {};
            for (const c of flat) out[c] = r[c];
            return out;
          }));
      },
      update(obj) {
        let count = 0;
        for (const row of data[table]) {
          if (preds.every((p) => p(row))) { Object.assign(row, obj); count += 1; }
        }
        return Promise.resolve(count);
      },
      insert(obj) {
        if (failInsertOn.table === table) return Promise.reject(new Error(`induced ${table} insert failure`));
        inserts.push({ table, row: obj });
        data[table].push({ ...obj });
        return Promise.resolve([obj]);
      },
    };
    return chain;
  }

  builder.transaction = async (fn) => {
    const snapshot = JSON.parse(JSON.stringify(data));
    const insertMark = inserts.length;
    try {
      return await fn(builder);
    } catch (err) {
      data = snapshot; // rollback
      inserts.length = insertMark;
      throw err;
    }
  };
  builder.raw = jest.fn().mockResolvedValue({ rows: [] }); // advisory locks are no-ops in the stub
  builder.schema = { hasTable: () => Promise.resolve(true) };
  Object.defineProperty(builder, '_data', { get: () => data });
  builder._inserts = inserts;
  builder._forUpdates = forUpdates;
  builder._failInsertOn = failInsertOn;
  return builder;
}

const PRIMARY_PHONE = '+15550001111';
const baseCustomer = () => ({
  id: CUSTOMER_ID,
  deleted_at: null,
  first_name: 'Jordan',
  last_name: 'Riverz',
  email: 'jordan.riverz@example.com',
  phone: PRIMARY_PHONE,
  address_line1: '12 Oak St',
  address_line2: 'Unit 4',
  city: 'Testville',
  state: 'FL',
  zip: '34200',
});
// Diarized transcript (the call-recording processor's "Agent:"/"Caller:"
// format) covering every caller quote the call-lane fixtures use — candidate
// quotes must ground against a CALLER line or the lane fails closed.
const DIARIZED_TRANSCRIPT = [
  'Agent: thanks for calling, how can I help you today?',
  'Caller: you spelled my name wrong, it is Rivers with an S',
  'Caller: my last name is spelled wrong, it is Rivers',
  'Caller: you have the wrong email, it is jordan dot rivers at example dot com',
  'Caller: the email is wrong, it is jordan dot rivers at example dot com',
  'Caller: the address is wrong, we are at 99 Pine Ave',
  'Caller: this is Jordan Rivers calling about my lawn',
].join('\n');
const callLogRow = (over = {}) => ({ id: CALL_ID, from_phone: PRIMARY_PHONE, transcription: DIARIZED_TRANSCRIPT, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockImplementation((key) => key === 'contactCorrection');
  mockNotifyAdmin.mockResolvedValue({ id: 'notif-1' });
});

describe('detectContactCorrectionIntent', () => {
  it('matches explicit correction statements', () => {
    expect(detectContactCorrectionIntent(
      'Got your quote. Email and name wrong. Email is jordan.rivers@example.com. name is spelled Rivers, with an S.',
    )).toBe(true);
    expect(detectContactCorrectionIntent('my email is wrong, it should be jane@example.com')).toBe(true);
    expect(detectContactCorrectionIntent('you have the wrong address, we moved to 14 Elm St')).toBe(true);
  });

  it('ignores routine messages', () => {
    expect(detectContactCorrectionIntent('Thank you')).toBe(false);
    expect(detectContactCorrectionIntent('Awesome')).toBe(false);
    expect(detectContactCorrectionIntent('Can we reschedule to Friday?')).toBe(false);
    expect(detectContactCorrectionIntent('')).toBe(false);
  });
});

describe('extractSmsContactCorrections', () => {
  it('keeps only high-confidence, transcript-backed corrections on applyable fields', async () => {
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'last_name', new_value: 'Rivers', quote: 'name is spelled Rivers', confidence: 'high' },
          { field: 'email', new_value: 'a@b.co', quote: 'email is a@b.co', confidence: 'medium' },
          { field: 'phone', new_value: '5551234567', quote: 'call me at', confidence: 'high' },
          // Fabricated evidence: the quote does not appear in the message.
          { field: 'city', new_value: 'Elsewhere', quote: 'we are in Elsewhere now', confidence: 'high' },
        ],
      },
    });
    const out = await extractSmsContactCorrections({ body: 'My name is wrong — name is spelled Rivers, with an S' });
    expect(out).toEqual([{ field: 'last_name', newValue: 'Rivers', quote: 'name is spelled Rivers' }]);
  });

  it('skips the LLM entirely when the prefilter does not match', async () => {
    const out = await extractSmsContactCorrections({ body: 'Thank you' });
    expect(out).toEqual([]);
    expect(mockCallAnthropic).not.toHaveBeenCalled();
  });

  it('fails soft on provider error', async () => {
    mockCallAnthropic.mockRejectedValue(new Error('boom'));
    const out = await extractSmsContactCorrections({ body: 'my email is wrong, it is a@b.co' });
    expect(out).toEqual([]);
  });
});

describe('applyContactCorrections', () => {
  it('does nothing when the gate is off', async () => {
    mockIsEnabled.mockReturnValue(false);
    const knex = makeStubKnex({ customers: [baseCustomer()] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'last_name', newValue: 'Rivers' }],
      source: 'sms',
      knex,
    });
    expect(res.reason).toBe('gate_off');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('applies valid corrections with audit rows, fan-outs, and one FYI bell', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], call_log: [callLogRow()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'last_name', newValue: 'Rivers', quote: 'name is spelled Rivers' },
        { field: 'email', newValue: 'jordan.rivers@example.com', quote: 'email is jordan.rivers@example.com' },
      ],
      source: 'sms',
      sourceId: 'sms-log-1',
      knex,
    });
    expect(res.applied).toEqual([
      { field: 'last_name', oldValue: 'Riverz', newValue: 'Rivers', quote: 'name is spelled Rivers' },
      { field: 'email', oldValue: 'jordan.riverz@example.com', newValue: 'jordan.rivers@example.com', quote: 'email is jordan.rivers@example.com' },
    ]);
    expect(knex._data.customers[0].last_name).toBe('Rivers');
    expect(knex._data.customers[0].email).toBe('jordan.rivers@example.com');
    const audits = knex._inserts.filter((i) => i.table === 'agent_decisions');
    expect(audits).toHaveLength(2);
    expect(audits[0].row.workflow).toBe('contact_correction');
    expect(audits[0].row.status).toBe('auto_applied');
    expect(JSON.parse(audits[0].row.input_snapshot)).toMatchObject({
      field: 'last_name', old_value: 'Riverz', new_value: 'Rivers',
    });
    // Canonical fan-outs ran inside the same transaction connection.
    expect(mockNameFanout).toHaveBeenCalledTimes(1);
    expect(mockEmailFanout).toHaveBeenCalledTimes(1);
    expect(mockAddressFanout).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, , options] = mockNotifyAdmin.mock.calls[0];
    expect(category).toBe('customer');
    expect(title).toContain('Jordan');
    expect(options.bell).toBe(true);
    expect(options.link).toBe(`/admin/customers?customerId=${CUSTOMER_ID}`);
  });

  it('rolls the customer mutation back when the audit insert fails', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], call_log: [callLogRow()], agent_decisions: [] });
    knex._failInsertOn.table = 'agent_decisions';
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'last_name', newValue: 'Rivers' }],
      source: 'sms',
      knex,
    });
    expect(res.reason).toBe('error');
    expect(res.applied).toEqual([]);
    expect(knex._data.customers[0].last_name).toBe('Riverz'); // rolled back
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('rejects invalid values, unknown fields, and phone', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'email', newValue: 'not-an-email' },
        { field: 'phone', newValue: '5551234567' },
        { field: 'zip', newValue: 'ABCDE' },
        { field: 'password', newValue: 'x' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toHaveLength(4);
    expect(knex._data.customers[0].email).toBe('jordan.riverz@example.com');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('applies case-only NAME corrections but skips case-only email changes', async () => {
    const knex = makeStubKnex({ customers: [{ ...baseCustomer(), last_name: 'Mcdonald' }] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'last_name', newValue: 'McDonald' },
        { field: 'email', newValue: 'JORDAN.RIVERZ@example.com' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([
      { field: 'last_name', oldValue: 'Mcdonald', newValue: 'McDonald', quote: null },
    ]);
    expect(res.skipped).toContainEqual({ field: 'email', reason: 'unchanged' });
    expect(knex._data.customers[0].last_name).toBe('McDonald');
  });

  it('rejects a new street without its city and zip (no hybrid addresses)', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'address_line1', newValue: '99 Pine Ave' }],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'address_line1', reason: 'incomplete_address' });
    expect(knex._data.customers[0].address_line1).toBe('12 Oak St');
    expect(mockAddressFanout).not.toHaveBeenCalled();
  });

  it('applies a complete address group, clears the stale unit, and runs address fan-outs', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], call_log: [callLogRow()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '99 Pine Ave', quote: 'we moved to 99 Pine Ave' },
        { field: 'city', newValue: 'Sampleton', quote: 'we moved' },
        { field: 'zip', newValue: '34299', quote: 'we moved' },
      ],
      source: 'sms',
      knex,
    });
    const fields = res.applied.map((a) => a.field).sort();
    expect(fields).toEqual(['address_line1', 'address_line2', 'city', 'zip']);
    expect(knex._data.customers[0].address_line1).toBe('99 Pine Ave');
    expect(knex._data.customers[0].address_line2).toBeNull(); // stale unit cleared
    expect(knex._data.customers[0].city).toBe('Sampleton');
    expect(mockSyncPrimaryAddress).toHaveBeenCalledTimes(1);
    expect(mockAddressFanout).toHaveBeenCalledTimes(1);
  });

  it('supports an explicit unit clear (empty address_line2)', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], call_log: [callLogRow()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'address_line2', newValue: '', quote: 'no unit, that was the old apartment' }],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([
      { field: 'address_line2', oldValue: 'Unit 4', newValue: null, quote: 'no unit, that was the old apartment' },
    ]);
    expect(knex._data.customers[0].address_line2).toBeNull();
  });
});

describe('runCallContactCorrection', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'you spelled my name wrong, it is Rivers with an S',
    confidence: 0.95,
    ...over,
  });

  it('auto-applies NAME candidates with correction-intent quotes and stamps them in the same transaction', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [candidate({ id: 'cand-1' })],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied).toEqual([
      { field: 'last_name', oldValue: 'Riverz', newValue: 'Rivers', quote: 'you spelled my name wrong, it is Rivers with an S' },
    ]);
    expect(knex._data.customers[0].last_name).toBe('Rivers');
    expect(knex._data.customer_field_candidates[0].status).toBe('auto_applied');
    expect(knex._data.customer_field_candidates[0].reviewed_at).toBeInstanceOf(Date);
  });

  it('rolls the candidate stamp back with the correction (same transaction)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [candidate({ id: 'cand-1' })],
      agent_decisions: [],
    });
    knex._failInsertOn.table = 'agent_decisions';
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied).toEqual([]);
    expect(knex._data.customers[0].last_name).toBe('Riverz');
    expect(knex._data.customer_field_candidates[0].status).toBe('pending');
  });

  it('PROPOSES email/address candidates via FYI bell without writing (spoken values are not auto-applied)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [
        candidate({ id: 'em', field_name: 'email', final_recommended_value: 'jordan.rivers@example.com', evidence_quote: 'you have the wrong email, it is jordan dot rivers at example dot com' }),
        candidate({ id: 'ad', field_name: 'address_line1', final_recommended_value: '99 Pine Ave', evidence_quote: 'the address is wrong, we are at 99 Pine Ave' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('proposed_only');
    expect(res.applied).toEqual([]);
    expect(knex._data.customers[0].email).toBe('jordan.riverz@example.com');
    expect(knex._data.customers[0].address_line1).toBe('12 Oak St');
    expect(knex._data.customer_field_candidates.every((c) => c.status === 'pending')).toBe(true);
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    const [, title, body] = mockNotifyAdmin.mock.calls[0];
    expect(title).toContain('proposed from a call');
    expect(body).toContain('jordan.rivers@example.com');
  });

  it('ignores routine mentions — an evidence quote without correction intent is not a mandate', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [
        candidate({ id: 'routine', evidence_quote: 'this is Jordan Rivers calling about my lawn' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('ignores candidates not linked to this customer (relinked-call safety)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [
        candidate({ id: 'other', customer_id: '00000000-0000-4000-8000-0000000000ff' }),
        candidate({ id: 'nullc', customer_id: null }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('stamps only the candidate whose value was actually applied', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [
        candidate({ id: 'winner' }),
        candidate({ id: 'loser', final_recommended_value: 'Riverssen' }),
      ],
      agent_decisions: [],
    });
    await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    const byId = Object.fromEntries(knex._data.customer_field_candidates.map((c) => [c.id, c.status]));
    expect(byId.winner).toBe('auto_applied');
    expect(byId.loser).toBe('pending');
  });

  it('ignores low-confidence, unquoted, phone, and non-pending candidates', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [
        candidate({ id: 'lo', confidence: 0.5 }),
        candidate({ id: 'nq', evidence_quote: null }),
        candidate({ id: 'ph', field_name: 'phone', final_recommended_value: '+15551234567' }),
        candidate({ id: 'done', status: 'rejected' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('does nothing for unlinked calls or with the gate off', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], call_log: [callLogRow()], customer_field_candidates: [candidate()] });
    expect((await runCallContactCorrection({ callId: CALL_ID, customerId: null, knex })).reason).toBe('unlinked');
    mockIsEnabled.mockReturnValue(false);
    expect((await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex })).reason).toBe('gate_off');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });
});

describe('SMS safety rails (round-2)', () => {
  it('detects bare move statements', () => {
    expect(detectContactCorrectionIntent('We moved to 99 Pine Ave, Sarasota 34231')).toBe(true);
    expect(detectContactCorrectionIntent("I've moved recently")).toBe(true);
  });

  it('rejects a corrected email already owned by another account', async () => {
    const knex = makeStubKnex({
      customers: [
        baseCustomer(),
        { id: '00000000-0000-4000-8000-0000000000ee', account_id: null, deleted_at: null, email: 'taken@example.com', first_name: 'Other', last_name: 'Person' },
      ],
    });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'email', newValue: 'taken@example.com' }],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'email', reason: 'email_in_use' });
    expect(knex._data.customers[0].email).toBe('jordan.riverz@example.com');
  });

  it('clears coords and re-geocodes after an applied address change', async () => {
    const knex = makeStubKnex({ customers: [{ ...baseCustomer(), latitude: 27.1, longitude: -82.4 }], agent_decisions: [] });
    mockGeocode.mockResolvedValue({ lat: 27.2, lng: -82.5 });
    await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '99 Pine Ave' },
        { field: 'city', newValue: 'Sampleton' },
        { field: 'zip', newValue: '34299' },
      ],
      source: 'sms',
      knex,
    });
    expect(knex._data.customers[0].latitude).toBeNull();
    expect(knex._data.customers[0].longitude).toBeNull();
    await new Promise((r) => setImmediate(r));
    // Address-guarded variant: the coord write + primary-property mirror
    // happen inside the geocoder helper, guarded on the address it read.
    expect(mockRegeocodeGuarded).toHaveBeenCalledWith(CUSTOMER_ID);
    expect(mockGeocode).not.toHaveBeenCalled();
  });

  it('runs deferred email fan-out actions after commit', async () => {
    mockEmailFanout.mockResolvedValueOnce({
      pendingConfirmation: { token: 'pc-1' },
      heldNewsletterResume: { id: 'hn-1' },
    });
    const knex = makeStubKnex({ customers: [baseCustomer()], call_log: [callLogRow()], agent_decisions: [] });
    await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'email', newValue: 'jordan.rivers@example.com' }],
      source: 'sms',
      knex,
    });
    await new Promise((r) => setImmediate(r));
    expect(mockResendPendingConfirmation).toHaveBeenCalledWith({ token: 'pc-1' });
    expect(mockNewsletterResume).toHaveBeenCalledWith({ id: 'hn-1' });
  });
});

describe('round-3 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'you spelled my name wrong, it is Rivers with an S',
    confidence: 0.95,
    ...over,
  });

  it('never renames the account owner from a service-contact caller', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ from_phone: '+15559998888' })], // tenant/spouse handset
      customer_field_candidates: [candidate()],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied).toEqual([]);
    expect(res.reason).toBe('caller_not_primary');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
    expect(knex._data.customer_field_candidates[0].status).toBe('pending');
  });

  it('newest pending candidate wins when re-staging left two for one field', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      // pre-sorted newest-first (stub orderBy is a no-op)
      customer_field_candidates: [
        candidate({ id: 'newest', final_recommended_value: 'Rivers' }),
        candidate({ id: 'older', final_recommended_value: 'Riverson' }),
      ],
      agent_decisions: [],
    });
    await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(knex._data.customers[0].last_name).toBe('Rivers');
    const byId = Object.fromEntries(knex._data.customer_field_candidates.map((c) => [c.id, c.status]));
    expect(byId.newest).toBe('auto_applied');
    expect(byId.older).toBe('pending');
  });

  it('proposes NULL-confidence email candidates (staging never scores email)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [
        candidate({ id: 'em', field_name: 'email', final_recommended_value: 'jordan.rivers@example.com', confidence: null, evidence_quote: 'the email is wrong, it is jordan dot rivers at example dot com' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('proposed_only');
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    expect(knex._data.customers[0].email).toBe('jordan.riverz@example.com');
  });

  it('canonicalizes extracted values into house shape', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], call_log: [callLogRow()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'last_name', newValue: 'MCGOWAN' },
        { field: 'state', newValue: 'fl' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied).toContainEqual({ field: 'last_name', oldValue: 'Riverz', newValue: 'McGowan', quote: null });
    // state 'fl' canonicalizes to 'FL' — identical to stored → unchanged.
    expect(res.skipped).toContainEqual({ field: 'state', reason: 'unchanged' });
    expect(knex._data.customers[0].last_name).toBe('McGowan');
  });

  it('blocks an email held by an unrelated account even when a sibling shares it', async () => {
    const sibling = { id: '00000000-0000-4000-8000-0000000000s1', account_id: CUSTOMER_ID, deleted_at: null, email: 'shared@example.com' };
    const stranger = { id: '00000000-0000-4000-8000-0000000000x1', account_id: null, deleted_at: null, email: 'shared@example.com' };
    const knex = makeStubKnex({ customers: [baseCustomer(), sibling, stranger], call_log: [callLogRow()] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'email', newValue: 'shared@example.com' }],
      source: 'sms',
      knex,
    });
    expect(res.skipped).toContainEqual({ field: 'email', reason: 'email_in_use' });
    expect(knex._data.customers[0].email).toBe('jordan.riverz@example.com');
  });
});

describe('round-4 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'you spelled my name wrong, it is Rivers with an S',
    confidence: 0.95,
    ...over,
  });

  it('a last-name-only quote never touches the first name (shared name_full evidence)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [
        candidate({ id: 'ln', field_name: 'last_name', final_recommended_value: 'Rivers', evidence_quote: 'my last name is spelled wrong, it is Rivers' }),
        candidate({ id: 'fn', field_name: 'first_name', final_recommended_value: 'Jordon', evidence_quote: 'my last name is spelled wrong, it is Rivers' }),
      ],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied.map((a) => a.field)).toEqual(['last_name']);
    expect(knex._data.customers[0].first_name).toBe('Jordan'); // untouched
    const byId = Object.fromEntries(knex._data.customer_field_candidates.map((c) => [c.id, c.status]));
    expect(byId.fn).toBe('pending');
  });

  it('rings the proposal bell once per call, ever (reprocess dedupe)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [
        candidate({ id: 'em', field_name: 'email', final_recommended_value: 'jordan.rivers@example.com', evidence_quote: 'the email is wrong, it is jordan dot rivers at example dot com' }),
      ],
      notifications: [
        { id: 'n1', recipient_type: 'admin', metadata: { dedupeKey: `contact-correction-proposal:${CALL_ID}` } },
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('proposed_only');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('prefilter matches standalone new-detail statements', () => {
    expect(detectContactCorrectionIntent('My new email is jane@example.com')).toBe(true);
    expect(detectContactCorrectionIntent('new address: 99 Pine Ave, Sarasota 34231')).toBe(true);
  });

  it('prefilter matches should-be and update-to forms', () => {
    expect(detectContactCorrectionIntent('My email should be jane@example.com, not jan@example.com')).toBe(true);
    expect(detectContactCorrectionIntent('Please update my email to jane@example.com')).toBe(true);
    expect(detectContactCorrectionIntent('Can you change the address to 99 Pine Ave')).toBe(true);
  });
});

describe('round-6 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'you spelled my name wrong, it is Rivers with an S',
    confidence: 0.95,
    ...over,
  });

  it('a plain self-identification never auto-applies a name (explicit correction language required)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      // Grounded as a caller line, so it is the INTENT bar that rejects it.
      call_log: [callLogRow({ transcription: 'Caller: hi, my name is Jordan Rivers, I need a quote' })],
      customer_field_candidates: [
        candidate({ id: 'weak', evidence_quote: 'my name is Jordan Rivers' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
    expect(knex._data.customer_field_candidates[0].status).toBe('pending');
  });

  it('rejects a quote that only appears on an AGENT line (both lanes)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({
        transcription: [
          'Agent: you spelled my name wrong, it is Rivers with an S',
          'Agent: the email is wrong, it is jordan dot rivers at example dot com',
          'Caller: sure, whatever works',
        ].join('\n'),
      })],
      customer_field_candidates: [
        candidate({ id: 'nm' }),
        candidate({ id: 'em', field_name: 'email', final_recommended_value: 'jordan.rivers@example.com', evidence_quote: 'the email is wrong, it is jordan dot rivers at example dot com' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('fails closed when the call has no stored transcript', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: null })],
      customer_field_candidates: [
        candidate({ id: 'nm' }),
        candidate({ id: 'em', field_name: 'email', final_recommended_value: 'jordan.rivers@example.com', evidence_quote: 'the email is wrong, it is jordan dot rivers at example dot com' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('rejects a fabricated quote absent from the transcript', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: 'Caller: calling about my mosquito service' })],
      customer_field_candidates: [candidate({ id: 'fab' })],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customer_field_candidates[0].status).toBe('pending');
  });

  it('canonicalizes BEFORE validating — a spelled-out state becomes its code instead of being discarded', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'state', newValue: 'Georgia' }],
      source: 'sms',
      knex,
    });
    expect(res.applied).toContainEqual({ field: 'state', oldValue: 'FL', newValue: 'GA', quote: null });
    expect(knex._data.customers[0].state).toBe('GA');
  });

  it('stamps the applied candidate even when its raw value needed canonicalization', async () => {
    const quote = 'you spelled my name wrong, it is MCGOWAN';
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [
        candidate({ id: 'raw', final_recommended_value: 'MCGOWAN', evidence_quote: quote }),
      ],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied).toContainEqual(expect.objectContaining({ field: 'last_name', newValue: 'McGowan' }));
    expect(knex._data.customers[0].last_name).toBe('McGowan');
    expect(knex._data.customer_field_candidates[0].status).toBe('auto_applied');
  });
});

describe('round-7 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'you spelled my name wrong, it is Rivers with an S',
    confidence: 0.95,
    ...over,
  });

  it('spelling language alone never auto-applies a call name (routine identity collection)', async () => {
    const quote = 'let me spell my name, it is Jane Rivers';
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [candidate({ id: 'spell', evidence_quote: quote })],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
    expect(knex._data.customer_field_candidates[0].status).toBe('pending');
  });

  it('fails closed on the unlabeled Speaker-diarization fallback (no Caller lines)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({
        transcription: [
          'Speaker 1: thanks for calling, how can I help?',
          'Speaker 2: you spelled my name wrong, it is Rivers with an S',
        ].join('\n'),
      })],
      customer_field_candidates: [candidate({ id: 'sp' })],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('a stale processing pass never applies its extraction (token fence)', async () => {
    const stale = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ processing_token: 'tok-live' })],
      customer_field_candidates: [candidate({ id: 'c1' })],
      agent_decisions: [],
    });
    const resStale = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex: stale, procToken: 'tok-stale' });
    expect(resStale.reason).toBe('fence_lost');
    expect(stale._data.customers[0].last_name).toBe('Riverz');
    expect(stale._data.customer_field_candidates[0].status).toBe('pending');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();

    const owning = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ processing_token: 'tok-live' })],
      customer_field_candidates: [candidate({ id: 'c1' })],
      agent_decisions: [],
    });
    const resOwn = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex: owning, procToken: 'tok-live' });
    expect(resOwn.applied.map((a) => a.field)).toEqual(['last_name']);
    expect(owning._data.customers[0].last_name).toBe('Rivers');
  });

  it('binds each SMS name correction to its own component (shared-quote leak)', async () => {
    const body = 'My last name is spelled Rivers, not Riverz';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'last_name', new_value: 'Rivers', quote: 'my last name is spelled Rivers, not Riverz', confidence: 'high' },
          { field: 'first_name', new_value: 'Jordon', quote: 'my last name is spelled Rivers, not Riverz', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['last_name']);
  });

  it('rejects a stated move that extracts locality fields without a street', async () => {
    const body = 'Hi, we moved to Tampa, zip is 33602';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'city', new_value: 'Tampa', quote: 'we moved to Tampa', confidence: 'high' },
          { field: 'zip', new_value: '33602', quote: 'zip is 33602', confidence: 'high' },
        ],
      },
    });
    const knex = makeStubKnex({ customers: [baseCustomer()] });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'city', reason: 'incomplete_address' });
    expect(res.skipped).toContainEqual({ field: 'zip', reason: 'incomplete_address' });
    expect(knex._data.customers[0].city).toBe('Testville');
    expect(mockAddressFanout).not.toHaveBeenCalled();
  });

  it('canonicalizes a typo-level unit fix through the whole-address parser', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'address_line2', newValue: '4b' }],
      source: 'sms',
      knex,
    });
    expect(res.applied).toContainEqual(expect.objectContaining({ field: 'address_line2', newValue: 'Unit 4B' }));
    expect(knex._data.customers[0].address_line2).toBe('Unit 4B');
  });

  it('rejects the whole group on an inline-unit vs line2 conflict', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '99 Pine Ave Apt 4' },
        { field: 'address_line2', newValue: 'Unit 7' },
        { field: 'city', newValue: 'Sampleton' },
        { field: 'zip', newValue: '34299' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped.filter((s) => s.reason === 'unit_conflict').map((s) => s.field).sort())
      .toEqual(['address_line1', 'address_line2', 'city', 'zip']);
    expect(knex._data.customers[0].address_line1).toBe('12 Oak St');
    expect(mockAddressFanout).not.toHaveBeenCalled();
  });
});

describe('round-8 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'you spelled my name wrong, it is Rivers with an S',
    confidence: 0.95,
    ...over,
  });

  it('holds the processing fence with a row lock through the correction commit', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ processing_token: 'tok-live' })],
      customer_field_candidates: [candidate({ id: 'c1' })],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex, procToken: 'tok-live' });
    expect(res.applied.map((a) => a.field)).toEqual(['last_name']);
    // The in-transaction re-check must take a FOR UPDATE lock on call_log so
    // a peer reclaim serializes with the customer write.
    expect(knex._forUpdates).toContain('call_log');
  });

  it('rejects the whole group when a required component dies in normalization', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '99 Pine Ave' },
        { field: 'city', newValue: 'Sarasota' },
        { field: 'zip', newValue: '3423O' }, // letter O — invalid after normalization
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'address_line1', reason: 'incomplete_address' });
    expect(res.skipped).toContainEqual({ field: 'city', reason: 'incomplete_address' });
    expect(knex._data.customers[0].address_line1).toBe('12 Oak St');
    expect(knex._data.customers[0].city).toBe('Testville');
    expect(mockAddressFanout).not.toHaveBeenCalled();
  });

  it('promotes a lone inline unit into address_line2', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '99 Pine Ave Apt 4' },
        { field: 'city', newValue: 'Sarasota' },
        { field: 'zip', newValue: '34231' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied.map((a) => a.field)).toEqual(expect.arrayContaining(['address_line1', 'address_line2']));
    expect(knex._data.customers[0].address_line1).toBe('99 Pine Ave');
    expect(knex._data.customers[0].address_line2).toBe('Apt 4');
  });

  it('rejects an explicit unit clear whose new street embeds a unit (contradiction)', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '99 Pine Ave Apt 4' },
        { field: 'address_line2', newValue: '' },
        { field: 'city', newValue: 'Sarasota' },
        { field: 'zip', newValue: '34231' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'address_line1', reason: 'unit_conflict' });
    expect(knex._data.customers[0].address_line1).toBe('12 Oak St');
  });

  it('skips a field an admin changed while extraction was in flight (compare-and-set)', async () => {
    const body = 'You spelled my last name wrong, it is Rivers';
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockImplementation(async () => {
      // Admin edit lands DURING the in-flight LLM extraction.
      knex._data.customers[0].last_name = 'Rivera';
      return {
        ok: true,
        json: { corrections: [{ field: 'last_name', new_value: 'Rivers', quote: 'you spelled my last name wrong, it is Rivers', confidence: 'high' }] },
      };
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'last_name', reason: 'concurrent_change' });
    expect(knex._data.customers[0].last_name).toBe('Rivera'); // the fresher write survives
  });

  it('drops a routinely mentioned address riding along with a real email correction', async () => {
    const body = 'My email is wrong, it is jordan.rivers@example.com. Service is at 99 Pine Ave, Sarasota 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'email', new_value: 'jordan.rivers@example.com', quote: 'my email is wrong, it is jordan.rivers@example.com', confidence: 'high' },
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'Service is at 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'Service is at 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'Service is at 99 Pine Ave, Sarasota 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['email']);
  });

  it('a stated move still licenses fragment-quoted address candidates as one group', async () => {
    const body = 'We just moved to 99 Pine Ave, Sarasota. Zip is 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'we just moved to 99 Pine Ave', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'we just moved to 99 Pine Ave, Sarasota', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'zip is 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['address_line1', 'city', 'zip']);
  });

  it('never renames the owner from an account-ownership disclaimer (call lane)', async () => {
    const quote = 'the account is not in my name, my name is Jane Smith';
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [
        candidate({ id: 'd1', field_name: 'first_name', final_recommended_value: 'Jane', evidence_quote: quote }),
        candidate({ id: 'd2', field_name: 'last_name', final_recommended_value: 'Smith', evidence_quote: quote }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].first_name).toBe('Jordan');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('never renames from an ownership disclaimer over SMS either', async () => {
    const body = 'The account is not in my name, my name is Jane Smith';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'first_name', new_value: 'Jane', quote: 'the account is not in my name, my name is Jane Smith', confidence: 'high' },
          { field: 'last_name', new_value: 'Smith', quote: 'the account is not in my name, my name is Jane Smith', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res).toEqual([]);
  });

  it('prefilter recognizes explicit old-contact corrections', () => {
    expect(detectContactCorrectionIntent('You have my old address — we are at 12 Oak St now')).toBe(true);
    expect(detectContactCorrectionIntent('You have my old email — use jane@example.com')).toBe(true);
  });
});

describe('field allowlist', () => {
  it('never includes phone', () => {
    expect(APPLYABLE_FIELDS).not.toContain('phone');
    expect(APPLYABLE_FIELDS).toEqual([
      'first_name', 'last_name', 'email',
      'address_line1', 'address_line2', 'city', 'state', 'zip',
    ]);
  });
});
