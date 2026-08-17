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
        if (/RIGHT\(regexp_replace/.test(sql)) {
          preds.push((r) => String(r.phone || '').replace(/\D/g, '').slice(-10) === String(params[0]));
          return chain;
        }
        throw new Error(`stub knex: unsupported whereRaw ${sql}`);
      },
      limit() { return chain; },
      whereNotNull(col) { preds.push((r) => r[col] != null); return chain; },
      whereIn(col, list) { preds.push((r) => list.includes(r[col])); return chain; },
      modify(cb) { cb(chain); return chain; },
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
  'Caller: you have my name wrong, it is Jordan Rivers',
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
          // Last-name-scoped quote — an UNQUALIFIED "name" quote with only
          // one component would drop under the round-14 whole-name rule.
          { field: 'last_name', new_value: 'Rivers', quote: 'last name is spelled Rivers', confidence: 'high' },
          { field: 'email', new_value: 'a@b.co', quote: 'email is a@b.co', confidence: 'medium' },
          { field: 'phone', new_value: '5551234567', quote: 'call me at', confidence: 'high' },
          // Fabricated evidence: the quote does not appear in the message.
          { field: 'city', new_value: 'Elsewhere', quote: 'we are in Elsewhere now', confidence: 'high' },
        ],
      },
    });
    const out = await extractSmsContactCorrections({ body: 'My name is wrong — last name is spelled Rivers, with an S' });
    expect(out).toEqual([{ field: 'last_name', newValue: 'Rivers', quote: 'last name is spelled Rivers' }]);
  });

  it('skips the LLM entirely when the prefilter does not match', async () => {
    const out = await extractSmsContactCorrections({ body: 'Thank you' });
    expect(out).toEqual([]);
    expect(mockCallAnthropic).not.toHaveBeenCalled();
  });

  it('surfaces a provider error as null (retryable), never as "no corrections"', async () => {
    // (round-19) The durable queue retries only a distinguishable
    // extraction failure — collapsing a provider outage into [] would
    // permanently mark the job done and drop the customer's correction.
    mockCallAnthropic.mockRejectedValue(new Error('boom'));
    expect(await extractSmsContactCorrections({ body: 'my email is wrong, it is a@b.co' })).toBeNull();
    mockCallAnthropic.mockResolvedValue({ ok: false });
    expect(await extractSmsContactCorrections({ body: 'my email is wrong, it is a@b.co' })).toBeNull();
    mockCallAnthropic.mockResolvedValue({ ok: true, json: { nope: true } });
    expect(await extractSmsContactCorrections({ body: 'my email is wrong, it is a@b.co' })).toBeNull();
  });

  it('a provider failure reaches the runner as the retryable error shape', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()] });
    mockCallAnthropic.mockRejectedValue(new Error('boom'));
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'My email is wrong, it is a@b.co', knex });
    expect(res.reason).toBe('error');
    expect(res.applied).toEqual([]);
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

  it('applies a complete address group, clears the stale unit on a MOVE, and runs address fan-outs', async () => {
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
      // The quotes state a move — the unit auto-clear is move-only (round-12).
      moveContext: true,
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
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
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
      { field: 'last_name', oldValue: 'Riverz', newValue: 'Rivers', quote: 'my last name is spelled wrong, it is Rivers' },
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
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
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
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
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
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
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
          'Agent: my last name is spelled wrong, it is Rivers',
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
    const knex = makeStubKnex({ customers: [{ ...baseCustomer(), zip: '31401' }], agent_decisions: [] });
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
    const quote = 'my last name is spelled wrong, it is MCGOWAN';
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
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
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
          'Speaker 2: my last name is spelled wrong, it is Rivers',
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
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
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

describe('round-9 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('a CAS miss on one address component rejects the whole staged group', async () => {
    // Admin changed the CITY while extraction was in flight; the staged
    // street+zip must not commit against it.
    const knex = makeStubKnex({ customers: [{ ...baseCustomer(), city: 'Freshville' }], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '99 Pine Ave' },
        { field: 'city', newValue: 'Sarasota' },
        { field: 'zip', newValue: '34231' },
      ],
      source: 'sms',
      knex,
      expectedValues: { ...baseCustomer() }, // snapshot still says Testville
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'address_line1', reason: 'concurrent_change' });
    expect(res.skipped).toContainEqual({ field: 'zip', reason: 'concurrent_change' });
    expect(knex._data.customers[0].address_line1).toBe('12 Oak St');
    expect(mockAddressFanout).not.toHaveBeenCalled();
  });

  it('correction language in one clause never licenses a field mentioned in another', async () => {
    const body = 'My email is wrong, use jordan.rivers@example.com. My name is Jane Smith';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'email', new_value: 'jordan.rivers@example.com', quote: 'my email is wrong, use jordan.rivers@example.com', confidence: 'high' },
          { field: 'first_name', new_value: 'Jane', quote: 'My email is wrong, use jordan.rivers@example.com. My name is Jane Smith', confidence: 'high' },
          { field: 'last_name', new_value: 'Smith', quote: 'My email is wrong, use jordan.rivers@example.com. My name is Jane Smith', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['email']);
  });

  it('a routine email statement beside an address correction never applies (bare "email is")', async () => {
    const body = 'Fix my address: 99 Pine Ave, Sarasota 34231. My email is jordan.riverz@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'fix my address: 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'fix my address: 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'fix my address: 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'email', new_value: 'jordan.riverz@example.com', quote: 'my email is jordan.riverz@example.com', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['address_line1', 'city', 'zip']);
  });

  it('an ungrounded address candidate cannot license the group', async () => {
    // The fabricated "my new address" quote is absent from the SMS; the
    // grounded candidates carry only routine language — nothing licenses
    // the group.
    const body = 'My email is wrong, use jordan.rivers@example.com. Service is at 99 Pine Ave, Sarasota 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'email', new_value: 'jordan.rivers@example.com', quote: 'my email is wrong, use jordan.rivers@example.com', confidence: 'high' },
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'my new address is 99 Pine Ave', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'Service is at 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'Service is at 99 Pine Ave, Sarasota 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['email']);
  });

  it('a stale processing pass never rings the proposal bell (fence held through emission)', async () => {
    const quote = 'the email is wrong, it is jordan dot rivers at example dot com';
    const stale = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ processing_token: 'tok-live', transcription: `Caller: ${quote}` })],
      customer_field_candidates: [candidate({ id: 'e1', field_name: 'email', final_recommended_value: 'jordan.rivers@example.com', evidence_quote: quote, confidence: null })],
      notifications: [],
    });
    // Peer reclaims between the pre-check read and the bell: simulate by
    // running with a token the row no longer carries.
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex: stale, procToken: 'tok-stale' });
    expect(res.reason).toBe('fence_lost');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();

    const owning = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ processing_token: 'tok-live', transcription: `Caller: ${quote}` })],
      customer_field_candidates: [candidate({ id: 'e1', field_name: 'email', final_recommended_value: 'jordan.rivers@example.com', evidence_quote: quote, confidence: null })],
      notifications: [],
    });
    const resOwn = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex: owning, procToken: 'tok-live' });
    expect(resOwn.reason).toBe('proposed_only');
    expect(mockNotifyAdmin).toHaveBeenCalledTimes(1);
    // The bell emission itself held the token-conditioned row lock.
    expect(owning._forUpdates).toContain('call_log');
  });

  it('an explicit unit clear propagates to the primary-property mirror', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'address_line2', newValue: '' }],
      source: 'sms',
      knex,
    });
    expect(res.applied.map((a) => a.field)).toEqual(['address_line2']);
    expect(mockSyncPrimaryAddress).toHaveBeenCalledWith(
      expect.objectContaining({ address_line2: null }),
      expect.anything(),
      expect.objectContaining({ explicitLine2: true }),
    );
  });

  it('a locality-only typo fix leaves the primary line2 fallback intact', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'city', newValue: 'Sarasota' }],
      source: 'sms',
      knex,
    });
    expect(res.applied.map((a) => a.field)).toEqual(['city']);
    expect(mockSyncPrimaryAddress).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ explicitLine2: false }),
    );
  });
});

describe('round-10 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('a concurrent phone change stales the whole batch (identity anchor)', async () => {
    const body = 'You spelled my last name wrong, it is Rivers';
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockImplementation(async () => {
      // Admin reassigns the customer's phone DURING the in-flight extraction
      // — the sender is no longer this record's identity anchor.
      knex._data.customers[0].phone = '+15559998888';
      return {
        ok: true,
        json: { corrections: [{ field: 'last_name', new_value: 'Rivers', quote: 'you spelled my last name wrong, it is Rivers', confidence: 'high' }] },
      };
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'last_name', reason: 'concurrent_change' });
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('a fabricated replacement value never applies even under a genuine quote', async () => {
    const body = 'My email is wrong, please fix it';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          // Genuine grounded quote, invented value — the customer never
          // typed an address to replace it with.
          { field: 'email', new_value: 'jordan.rivers@example.com', quote: 'my email is wrong, please fix it', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res).toEqual([]);
  });

  it('moving an OBJECT is not move evidence — destination language required', async () => {
    const body = 'I moved the traps to the garage. Service is at 99 Pine Ave, Sarasota 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'service is at 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'service is at 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'service is at 99 Pine Ave, Sarasota 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res).toEqual([]);
  });

  it('routine identity collection on a call never rings a proposal bell', async () => {
    const quote = 'my email is jane at example dot com';
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [candidate({ id: 'e1', field_name: 'email', final_recommended_value: 'jane@example.com', evidence_quote: quote, confidence: null })],
      notifications: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('round-11 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('binds the batch to the ORIGINAL sender, not the re-read phone', async () => {
    // Phone reassigned between the webhook's match and the post-ack runner:
    // the snapshot would self-compare, but the senderPhone anchor catches it.
    const body = 'You spelled my last name wrong, it is Rivers';
    const knex = makeStubKnex({ customers: [{ ...baseCustomer(), phone: '+15559998888' }], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'last_name', new_value: 'Rivers', quote: 'you spelled my last name wrong, it is Rivers', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex, senderPhone: PRIMARY_PHONE });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'last_name', reason: 'concurrent_change' });
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('a matching sender still applies (positive path with senderPhone)', async () => {
    const body = 'You spelled my last name wrong, it is Rivers';
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'last_name', new_value: 'Rivers', quote: 'you spelled my last name wrong, it is Rivers', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex, senderPhone: PRIMARY_PHONE });
    expect(res.applied.map((a) => a.field)).toEqual(['last_name']);
    expect(knex._data.customers[0].last_name).toBe('Rivers');
  });

  it('a hallucinated replacement value never auto-applies from a call', async () => {
    const quote = 'my last name is wrong';
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [candidate({ id: 'h1', final_recommended_value: 'Fabricated', evidence_quote: quote })],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].last_name).toBe('Riverz');
    expect(knex._data.customer_field_candidates[0].status).toBe('pending');
  });

  it('comma-joined clauses: correction word binds its NEAREST topic', async () => {
    const body = 'My email is wrong, my name is Jane Smith. Use jordan.rivers@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'email', new_value: 'jordan.rivers@example.com', quote: 'my email is wrong, my name is Jane Smith', confidence: 'high' },
          { field: 'first_name', new_value: 'Jane', quote: 'my email is wrong, my name is Jane Smith', confidence: 'high' },
          { field: 'last_name', new_value: 'Smith', quote: 'my email is wrong, my name is Jane Smith', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['email']);
  });

  it('comma-joined clauses: an email correction never licenses a trailing address', async () => {
    const body = 'My email is wrong, service address is 99 Pine Ave, Sarasota 34231. Use jordan.rivers@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'email', new_value: 'jordan.rivers@example.com', quote: 'my email is wrong, service address is 99 Pine Ave', confidence: 'high' },
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'my email is wrong, service address is 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'my email is wrong, service address is 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'my email is wrong, service address is 99 Pine Ave, Sarasota 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['email']);
  });

  it('an empty unit clear needs explicit removal language', async () => {
    const body = 'My unit is wrong, please fix it';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'address_line2', new_value: '', quote: 'my unit is wrong, please fix it', confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res).toEqual([]);
  });

  it('explicit removal language still clears the unit', async () => {
    const body = 'There is no unit, that was our old apartment';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'address_line2', new_value: '', quote: 'no unit, that was our old apartment', confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res).toEqual([{ field: 'address_line2', newValue: '', quote: 'no unit, that was our old apartment' }]);
  });
});

describe('round-12 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('a short hallucinated value cannot ground inside another word ("Lee" vs "please")', async () => {
    const quote = 'my last name is wrong, please fix it';
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [candidate({ id: 'lee', final_recommended_value: 'Lee', evidence_quote: quote })],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('concurrent SMS corrections serialize per customer — the newest message wins', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    let releaseFirst;
    mockCallAnthropic
      // msg1 (older): extraction hangs until released
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({
          ok: true,
          json: { corrections: [{ field: 'last_name', new_value: 'Riverson', quote: 'my last name is wrong, it should be Riverson', confidence: 'high' }] },
        });
      }))
      // msg2 (newer): fast extraction
      .mockImplementationOnce(async () => ({
        ok: true,
        json: { corrections: [{ field: 'last_name', new_value: 'Rivers', quote: 'actually my last name is Rivers', confidence: 'high' }] },
      }));
    const p1 = runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'My last name is wrong, it should be Riverson', knex });
    const p2 = runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'Actually my last name is Rivers', knex });
    // Let msg1 reach its (hung) extraction, then release it — msg2 must not
    // have started; it runs only after msg1 commits.
    await new Promise((r) => { setImmediate(r); });
    expect(mockCallAnthropic).toHaveBeenCalledTimes(1);
    releaseFirst();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.applied.map((a) => a.field)).toEqual(['last_name']);
    expect(r2.applied.map((a) => a.field)).toEqual(['last_name']);
    expect(r2.applied[0].oldValue).toBe('Riverson'); // snapshot taken AFTER msg1 committed
    expect(knex._data.customers[0].last_name).toBe('Rivers'); // newest message wins
  });

  it('a street-spelling fix preserves the existing unit (no move stated)', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '12 Oakes St', quote: 'the street is spelled wrong' },
        { field: 'city', newValue: 'Testville', quote: 'the street is spelled wrong' },
        { field: 'zip', newValue: '34200', quote: 'the street is spelled wrong' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied.map((a) => a.field)).toEqual(['address_line1']);
    expect(knex._data.customers[0].address_line2).toBe('Unit 4'); // unit preserved
  });

  it('a whole-name batch rejects as a group when one component hits a CAS miss', async () => {
    // Admin changed first_name to James while extraction was in flight —
    // applying only the surname would commit the hybrid "James Doe".
    const knex = makeStubKnex({ customers: [{ ...baseCustomer(), first_name: 'James' }], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'first_name', newValue: 'Jane', quote: 'my name is wrong, it is Jane Doe' },
        { field: 'last_name', newValue: 'Doe', quote: 'my name is wrong, it is Jane Doe' },
      ],
      source: 'sms',
      knex,
      expectedValues: { ...baseCustomer() }, // snapshot still says Jordan
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'first_name', reason: 'concurrent_change' });
    expect(res.skipped).toContainEqual({ field: 'last_name', reason: 'concurrent_change' });
    expect(knex._data.customers[0].first_name).toBe('James');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });
});

describe('round-13 hardening', () => {
  it('SMS replacement values also match on token boundaries ("Lee" vs "please")', async () => {
    const body = 'My last name is wrong, please fix it';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'last_name', new_value: 'Lee', quote: 'my last name is wrong, please fix it', confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res).toEqual([]);
  });

  // Webhook arrival ordering, cancelled-reservation release, and the
  // crash backstop moved to the DB-backed queue in round-17 — covered in
  // contact-correction-queue.test.js.

  it('a move to a same-named street in a new city still clears the old unit', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '12 Oak St', quote: 'we moved to 12 Oak St in Sampleton' }, // same street text
        { field: 'city', newValue: 'Sampleton', quote: 'we moved' },
        { field: 'zip', newValue: '34299', quote: 'we moved' },
      ],
      source: 'sms',
      knex,
      moveContext: true,
    });
    expect(res.applied.map((a) => a.field).sort()).toEqual(['address_line2', 'city', 'zip']);
    expect(knex._data.customers[0].address_line2).toBeNull(); // old unit gone with the move
    expect(knex._data.customers[0].city).toBe('Sampleton');
  });

  it('prefilter admits explicit unit-removal messages', () => {
    expect(detectContactCorrectionIntent('Please remove the apartment from my address')).toBe(true);
    expect(detectContactCorrectionIntent('The unit no longer applies')).toBe(true);
  });

  it('an explicit removal message clears the unit end to end', async () => {
    const body = 'Please remove the apartment from my address';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'address_line2', new_value: '', quote: 'remove the apartment from my address', confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res).toEqual([{ field: 'address_line2', newValue: '', quote: 'remove the apartment from my address' }]);
  });
});

describe('round-14 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('call-name intent is clause-bound — an identity statement beside an email correction never renames', async () => {
    const quote = 'my email is wrong, my name is Jane Smith';
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [
        candidate({ id: 'n1', field_name: 'first_name', final_recommended_value: 'Jane', evidence_quote: quote }),
        candidate({ id: 'n2', field_name: 'last_name', final_recommended_value: 'Smith', evidence_quote: quote }),
      ],
      notifications: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].first_name).toBe('Jordan');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('a licensed address correction does not cover a second property in another sentence', async () => {
    const body = 'My city is wrong, it should be Sarasota. Service at the rental is 99 Pine Ave, Sarasota 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'city', new_value: 'Sarasota', quote: 'my city is wrong, it should be Sarasota', confidence: 'high' },
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'Service at the rental is 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'Service at the rental is 99 Pine Ave, Sarasota 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['city']);
  });

  it('scopes call consumption to the candidates this pass staged', async () => {
    const stale = candidate({ id: 'stale-1', final_recommended_value: 'Rivera', evidence_quote: 'my last name is wrong, it is Rivera' });
    const own = candidate({ id: 'own-1', final_recommended_value: 'Rivers', evidence_quote: 'my last name is wrong, it is Rivers' });
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({
        transcription: [
          'Caller: my last name is wrong, it is Rivera',
          'Caller: my last name is wrong, it is Rivers',
        ].join('\n'),
      })],
      // Stale worker's row listed first (newest-first fixtures) — without
      // provenance scoping the newest-wins dedupe would pick it.
      customer_field_candidates: [stale, own],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex, candidateIds: ['own-1'] });
    expect(res.applied.map((a) => a.newValue)).toEqual(['Rivers']);
    expect(knex._data.customers[0].last_name).toBe('Rivers');
    expect(knex._data.customer_field_candidates.find((c) => c.id === 'stale-1').status).toBe('pending');

    // An empty staging pass consumes nothing at all.
    const empty = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow()],
      customer_field_candidates: [candidate({ id: 'c1' })],
    });
    const resEmpty = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex: empty, candidateIds: [] });
    expect(resEmpty.reason).toBe('no_candidates');
    expect(empty._data.customers[0].last_name).toBe('Riverz');
  });

  it('an unqualified whole-name quote with only one extracted component never applies', async () => {
    const body = 'You have my name wrong, it is Jane Smith';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'first_name', new_value: 'Jane', quote: 'you have my name wrong, it is Jane Smith', confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res).toEqual([]);
  });

  it('an unqualified whole-name quote with BOTH components still applies', async () => {
    const body = 'You have my name wrong, it is Jane Smith';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'first_name', new_value: 'Jane', quote: 'you have my name wrong, it is Jane Smith', confidence: 'high' },
          { field: 'last_name', new_value: 'Smith', quote: 'you have my name wrong, it is Jane Smith', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field).sort()).toEqual(['first_name', 'last_name']);
  });

  // The round-15 backstop-drop contract (a run that lost its reserved
  // position must never execute out of order) is now enforced by the
  // DB queue's per-sender fence — covered in
  // contact-correction-queue.test.js.
});

describe('round-15 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('an unqualified whole-name CALL quote with only one staged component never applies', async () => {
    const quote = 'you have my name wrong, it is Jordan Rivers';
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [candidate({ id: 'lone', evidence_quote: quote })],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].last_name).toBe('Riverz');
    expect(knex._data.customer_field_candidates[0].status).toBe('pending');
  });

  it('an unqualified whole-name CALL quote with BOTH components staged still applies', async () => {
    const quote = 'you have my name wrong, it is Jordan Rivers';
    const knex = makeStubKnex({
      customers: [baseCustomer()], call_log: [callLogRow()],
      customer_field_candidates: [
        candidate({ id: 'fn', field_name: 'first_name', final_recommended_value: 'Jordan', evidence_quote: quote }),
        candidate({ id: 'ln', field_name: 'last_name', final_recommended_value: 'Rivers', evidence_quote: quote }),
      ],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied.map((a) => a.field)).toContain('last_name');
    expect(knex._data.customers[0].last_name).toBe('Rivers');
  });

  it('"cannot" never satisfies the call-name correction bar (`not` is word-bounded)', async () => {
    const quote = 'I cannot spell my name, it is Jane Smith';
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [
        candidate({ id: 'fn', field_name: 'first_name', final_recommended_value: 'Jane', evidence_quote: quote }),
        candidate({ id: 'ln', field_name: 'last_name', final_recommended_value: 'Smith', evidence_quote: quote }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].first_name).toBe('Jordan');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('"renew" never licenses an SMS correction (`new` is word-bounded in the correction vocabulary)', async () => {
    const body = 'Time to renew, my email is jordan.rivers@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'jordan.rivers@example.com', quote: 'time to renew, my email is jordan.rivers@example.com', confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res).toEqual([]);
  });

  it('a city-only correction on a SPARSE customer mirror never syncs (and so never rekeys) the primary property', async () => {
    const sparse = { ...baseCustomer(), address_line1: null, address_line2: null, zip: null };
    const knex = makeStubKnex({ customers: [sparse], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'city', newValue: 'Sarasota', quote: 'the city is wrong, it is Sarasota' }],
      source: 'sms',
      knex,
    });
    expect(res.applied.map((a) => a.field)).toEqual(['city']);
    expect(knex._data.customers[0].city).toBe('Sarasota');
    expect(mockSyncPrimaryAddress).not.toHaveBeenCalled();
  });

  it('a city correction on a COMPLETE mirror still syncs the primary property', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'city', newValue: 'Sarasota', quote: 'the city is wrong, it is Sarasota' }],
      source: 'sms',
      knex,
    });
    expect(res.applied.map((a) => a.field)).toEqual(['city']);
    expect(mockSyncPrimaryAddress).toHaveBeenCalledTimes(1);
  });

  it('the CAS baselines against the MATCHED row — an admin edit while the message queued stales the batch', async () => {
    // Admin fixed the surname AFTER the webhook matched this message but
    // BEFORE the runner started; a runner-start snapshot would post-date
    // the edit and accept the older SMS as a valid overwrite.
    const adminEdited = { ...baseCustomer(), last_name: 'Updated' };
    const knex = makeStubKnex({ customers: [adminEdited], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'last_name', new_value: 'Rivers', quote: 'you spelled my last name wrong, it is Rivers', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({
      customer: { id: CUSTOMER_ID },
      body: 'You spelled my last name wrong, it is Rivers',
      knex,
      matchedSnapshot: { ...baseCustomer() }, // as matched: still Riverz
    });
    expect(res.applied).toEqual([]);
    expect(knex._data.customers[0].last_name).toBe('Updated');
  });

  it('a PARTIAL matched snapshot is ignored — the runner falls back to its own read', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'last_name', new_value: 'Rivers', quote: 'you spelled my last name wrong, it is Rivers', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({
      customer: { id: CUSTOMER_ID },
      body: 'You spelled my last name wrong, it is Rivers',
      knex,
      matchedSnapshot: { last_name: 'Riverz' }, // missing the other CAS fields
    });
    expect(res.applied.map((a) => a.field)).toEqual(['last_name']);
    expect(knex._data.customers[0].last_name).toBe('Rivers');
  });
});

describe('round-16 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it("someone else's grounded contact data never rides a real correction quote (value/intent co-location)", async () => {
    const body = 'My email is wrong; please fix it. Send the receipt to my accountant at bookkeeper@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'my email is wrong; please fix it', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
    // A model that widens the quote to span both statements gains nothing —
    // the intervening clause keeps the value out of the correcting statement.
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: body, confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('an adjacent clause with its own unrelated business never donates its value even without filler between', async () => {
    const body = 'My email is wrong. Send the receipt to my accountant at bookkeeper@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: body, confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a bare adjacent value statement still corrects ("My email is wrong. It is …")', async () => {
    const body = 'My email is wrong. It is jordan.rivers@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'jordan.rivers@example.com', quote: body, confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['email']);
  });

  it('a topic-named adjacent clause still corrects ("My email is wrong. Email is …")', async () => {
    const body = 'My email is wrong. Email is jordan.rivers@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'jordan.rivers@example.com', quote: body, confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['email']);
  });

  it('a call value spoken on a DIFFERENT caller line than the correction quote never applies', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({
        transcription: [
          'Caller: my last name is spelled wrong',
          'Caller: send the mail to Rivers and Sons Roofing',
        ].join('\n'),
      })],
      customer_field_candidates: [
        candidate({ id: 'split', evidence_quote: 'my last name is spelled wrong' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('rejects an over-column email (151+ chars) without sinking the sibling correction', async () => {
    const longEmail = `${'a'.repeat(145)}@ex.com`; // valid shape, 152 chars > varchar(150)
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'email', newValue: longEmail, quote: 'my email is wrong' },
        { field: 'last_name', newValue: 'Rivers', quote: 'my last name is wrong, it is Rivers' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied.map((a) => a.field)).toEqual(['last_name']);
    expect(res.skipped.some((s) => s.field === 'email')).toBe(true);
    expect(knex._data.customers[0].email).toBe('jordan.riverz@example.com');
    expect(knex._data.customers[0].last_name).toBe('Rivers');
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

describe('round-19 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('an unqualified whole-name pair losing one component in VALIDATION drops both', async () => {
    // The extractor's pair guard runs pre-validation — a surname dying at
    // the validator ("X".repeat(60) fails the 50-char cap) must take the
    // surviving first name with it, or the survivor grafts onto the stored
    // counterpart (hybrid name).
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const quote = 'you have my name wrong, it is Jane ' + 'X'.repeat(60);
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'first_name', newValue: 'Jane', quote },
        { field: 'last_name', newValue: 'X'.repeat(60), quote },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'last_name', reason: 'invalid' });
    expect(res.skipped).toContainEqual({ field: 'first_name', reason: 'name_pair_incomplete' });
    expect(knex._data.customers[0].first_name).toBe('Jordan');
  });

  it('an explicitly scoped first name survives its neighbor failing validation', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'first_name', newValue: 'Jane', quote: 'my first name is wrong, it is Jane' },
        { field: 'last_name', newValue: 'X'.repeat(60), quote: 'my last name is wrong too' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied.map((a) => a.field)).toEqual(['first_name']);
    expect(knex._data.customers[0].first_name).toBe('Jane');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('a stated move does not license another property mentioned in the next sentence', async () => {
    const body = "We moved to Sarasota. Please service my tenants rental at 99 Pine Ave, Sarasota 34231";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'city', new_value: 'Sarasota', quote: 'we moved to sarasota', confidence: 'high' },
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'my tenants rental at 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'my tenants rental at 99 Pine Ave, Sarasota 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['city']);
  });

  it('a move still licenses the bare address fragment in the adjacent sentence', async () => {
    const body = 'We moved to a new place. It is 12 Oak St, Sarasota 34299';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '12 Oak St', quote: 'it is 12 Oak St, Sarasota 34299', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'it is 12 Oak St, Sarasota 34299', confidence: 'high' },
          { field: 'zip', new_value: '34299', quote: 'it is 12 Oak St, Sarasota 34299', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field).sort()).toEqual(['address_line1', 'city', 'zip']);
  });

  it('the claim-time snapshot stales a call candidate against an admin edit made DURING processing', async () => {
    // Admin fixed the surname while transcription/extraction ran; the
    // late runner read would have adopted that edit as the baseline and
    // let the OLDER call-stated value overwrite it.
    const knex = makeStubKnex({
      customers: [{ ...baseCustomer(), last_name: 'AdminFixed' }],
      call_log: [callLogRow()],
      customer_field_candidates: [candidate({ id: 'n1', field_name: 'last_name', final_recommended_value: 'Rivers', evidence_quote: 'my last name is spelled wrong, it is Rivers' })],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({
      callId: CALL_ID,
      customerId: CUSTOMER_ID,
      knex,
      expectedValuesSnapshot: { first_name: 'Jordan', last_name: 'Riverz', phone: PRIMARY_PHONE },
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'last_name', reason: 'concurrent_change' });
    expect(knex._data.customers[0].last_name).toBe('AdminFixed');
  });

  it('an outbound callback NEVER auto-applies — labels are not speaker-reliable there (r22)', async () => {
    // Live outbound recordings can label the WAVES AGENT as "Caller:"
    // (see the inbound-only guard in call-recording-processor), so an
    // agent read-back could ground a rewrite. The external leg still
    // resolves for binding/proposals, but names stay out of auto-apply.
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ direction: 'outbound-api', from_phone: '+19415557777', to_phone: PRIMARY_PHONE })],
      customer_field_candidates: [candidate({ id: 'n1', field_name: 'last_name', final_recommended_value: 'Rivers', evidence_quote: 'my last name is spelled wrong, it is Rivers' })],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'name', reason: 'caller_not_primary' });
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('a proposal value spoken in UNRELATED caller speech never reaches the bell', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({
        transcription: [
          'Caller: the email is wrong, please fix it',
          'Caller: send the receipt to my accountant at bookkeeper at example dot com',
        ].join('\n'),
      })],
      customer_field_candidates: [
        candidate({ id: 'em', field_name: 'email', final_recommended_value: 'bookkeeper@example.com', evidence_quote: 'the email is wrong, please fix it' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('round-20 hardening', () => {
  it('a short LABELED property adjacent to a move never rides the move license', async () => {
    // "Rental:" leaves only the label as residue — a length threshold let
    // it pass as "essentially bare address"; the closed introduction
    // vocabulary does not.
    const body = 'We moved to Sarasota. Rental: 99 Pine Ave, Sarasota 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'city', new_value: 'Sarasota', quote: 'we moved to sarasota', confidence: 'high' },
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'Rental: 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'Rental: 99 Pine Ave, Sarasota 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['city']);
  });

  it('a lost queue lock rolls the customer write back inside the apply transaction', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'last_name', new_value: 'Rivers', quote: 'you spelled my last name wrong, it is Rivers', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({
      customer: { id: CUSTOMER_ID },
      body: 'You spelled my last name wrong, it is Rivers',
      knex,
      ownerFence: async () => { throw new Error('queue_lock_lost'); },
    });
    expect(res.reason).toBe('error');
    expect(res.applied).toEqual([]);
    // Transaction rolled back — the stale worker committed nothing.
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('the owner fence passes through silently while the lock is held', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'last_name', new_value: 'Rivers', quote: 'you spelled my last name wrong, it is Rivers', confidence: 'high' }] },
    });
    const fence = jest.fn().mockResolvedValue(undefined);
    const res = await runSmsContactCorrection({
      customer: { id: CUSTOMER_ID },
      body: 'You spelled my last name wrong, it is Rivers',
      knex,
      ownerFence: fence,
    });
    expect(res.applied.map((a) => a.field)).toEqual(['last_name']);
    expect(knex._data.customers[0].last_name).toBe('Rivers');
    expect(fence).toHaveBeenCalledTimes(1);
  });
});

describe('round-21 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it("a third party's 'new address' never move-licenses the address group", async () => {
    const body = "My email is wrong; use me@example.com. Mail the invoice to my accountants new address: 99 Pine Ave, Sarasota 34231";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'email', new_value: 'me@example.com', quote: 'my email is wrong; use me@example.com', confidence: 'high' },
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'my accountants new address: 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'my accountants new address: 99 Pine Ave, Sarasota 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'my accountants new address: 99 Pine Ave, Sarasota 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['email']);
  });

  it('a cross-state move without a stated state derives it from the ZIP', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '123 Main St', quote: 'we moved to 123 Main St, Savannah 31401' },
        { field: 'city', newValue: 'Savannah', quote: 'we moved' },
        { field: 'zip', newValue: '31401', quote: 'we moved' },
      ],
      source: 'sms',
      knex,
      moveContext: true,
    });
    expect(res.applied.map((a) => a.field).sort()).toEqual(['address_line1', 'address_line2', 'city', 'state', 'zip']);
    expect(knex._data.customers[0].state).toBe('GA');
    expect(knex._data.customers[0].city).toBe('Savannah');
  });

  it('an unresolvable ZIP fails the new-address group closed', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '123 Main St', quote: 'we moved to 123 Main St' },
        { field: 'city', newValue: 'Somewhere', quote: 'we moved' },
        { field: 'zip', newValue: '00100', quote: 'we moved' },
      ],
      source: 'sms',
      knex,
      moveContext: true,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'zip', reason: 'state_unresolved' });
    expect(knex._data.customers[0].address_line1).toBe('12 Oak St');
  });

  it('whole-address REPLACEMENT language clears the old unit without move vocabulary', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '99 Pine Ave', quote: 'you have the wrong address, it should be 99 Pine Ave, Sarasota 34231' },
        { field: 'city', newValue: 'Sarasota', quote: 'you have the wrong address' },
        { field: 'zip', newValue: '34231', quote: 'you have the wrong address' },
      ],
      source: 'sms',
      knex,
      moveContext: false,
    });
    expect(res.applied.map((a) => a.field)).toContain('address_line2');
    expect(knex._data.customers[0].address_line2).toBeNull();
    expect(knex._data.customers[0].address_line1).toBe('99 Pine Ave');
  });

  it('a component spelling fix still preserves the unit (no replacement language)', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '12 Oakes St', quote: 'my street is spelled wrong, it is 12 Oakes St' },
        { field: 'city', newValue: 'Testville', quote: 'my street is spelled wrong' },
        { field: 'zip', newValue: '34200', quote: 'my street is spelled wrong' },
      ],
      source: 'sms',
      knex,
      moveContext: false,
    });
    expect(knex._data.customers[0].address_line2).toBe('Unit 4');
  });

  it('a hallucinated short value cannot ground inside a longer word on the normalized line', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: 'Caller: my state is incorrect, please fix it' })],
      customer_field_candidates: [
        candidate({ id: 'st', field_name: 'state', final_recommended_value: 'IN', evidence_quote: 'my state is incorrect, please fix it' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('round-22 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('the entry prefilter recognizes surname corrections', () => {
    expect(detectContactCorrectionIntent('My surname is wrong; it should be Rivers')).toBe(true);
    expect(detectContactCorrectionIntent('You misspelled my surname')).toBe(true);
  });

  it('an explicitly stated state contradicting the ZIP fails the group closed', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '123 Main St', quote: 'we moved to 123 Main St, Savannah, FL 31401' },
        { field: 'city', newValue: 'Savannah', quote: 'we moved' },
        { field: 'state', newValue: 'FL', quote: 'we moved' },
        { field: 'zip', newValue: '31401', quote: 'we moved' },
      ],
      source: 'sms',
      knex,
      moveContext: true,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'state', reason: 'state_mismatch' });
    expect(knex._data.customers[0].city).toBe('Testville');
  });

  it("a third party's email correction never replaces the customer's email", async () => {
    const body = "My accountant's email is wrong; change it to bookkeeper@example.com";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: "my accountant's email is wrong; change it to bookkeeper@example.com", confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("a third party's name never renames the account holder", async () => {
    const body = "My wife's name is spelled wrong, it is Janet";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'first_name', new_value: 'Janet', quote: "my wife's name is spelled wrong, it is Janet", confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("the customer's own name correction still passes the ownership filter", async () => {
    const body = 'My name is spelled wrong, it is Jordan Rivers';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'first_name', new_value: 'Jordan', quote: 'my name is spelled wrong, it is Jordan Rivers', confidence: 'high' },
          { field: 'last_name', new_value: 'Rivers', quote: 'my name is spelled wrong, it is Jordan Rivers', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field).sort()).toEqual(['first_name', 'last_name']);
  });

  it('a historical/forced pass keeps a primary-caller name correction out of auto-apply', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow()],
      customer_field_candidates: [candidate({ id: 'n1' })],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex, allowNameAutoApply: false });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'name', reason: 'historical_pass' });
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });
});

describe('round-23 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('the SMS runner forwards BOTH fence arguments so the queue can seal atomically', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'last_name', new_value: 'Rivers', quote: 'you spelled my last name wrong, it is Rivers', confidence: 'high' }] },
    });
    const fence = jest.fn().mockResolvedValue(undefined);
    const res = await runSmsContactCorrection({
      customer: { id: CUSTOMER_ID },
      body: 'You spelled my last name wrong, it is Rivers',
      knex,
      ownerFence: fence,
    });
    expect(res.applied).toHaveLength(1);
    expect(fence).toHaveBeenCalledTimes(1);
    const [trxArg, appliedArg] = fence.mock.calls[0];
    expect(trxArg).toBeTruthy();
    expect(appliedArg).toEqual(res.applied);
  });

  it("a third party's name on a primary-number call neither renames nor bells", async () => {
    const quote = "my wife's name is wrong, it is Janet Smith";
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [
        candidate({ id: 'n1', field_name: 'first_name', final_recommended_value: 'Janet', evidence_quote: quote }),
        candidate({ id: 'n2', field_name: 'last_name', final_recommended_value: 'Smith', evidence_quote: quote }),
      ],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].first_name).toBe('Jordan');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it("a third party's email on a call never rings a proposal bell", async () => {
    const quote = "my accountant's email is wrong, it is bookkeeper at example dot com";
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [
        candidate({ id: 'em', field_name: 'email', final_recommended_value: 'bookkeeper@example.com', evidence_quote: quote }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('state derivation flows through the shared data-hygiene allocation table', () => {
    const { stateForZip, zipMatchesState } = require('../services/data-hygiene/normalizers');
    expect(stateForZip('31401')).toBe('GA');
    expect(stateForZip('34231')).toBe('FL');
    expect(stateForZip('00100')).toBeNull();
    // The two directions agree by construction — same table.
    expect(zipMatchesState('31401', stateForZip('31401'))).toBe(true);
  });
});

describe('round-24 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('a NARROWED quote cannot shed the third-party possessive (SMS)', async () => {
    // The model quotes only the fragment after the possessive — ownership
    // is judged against the containing source clause, which still carries
    // "My accountant's".
    const body = "My accountant's email is wrong; change it to bookkeeper@example.com";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'change it to bookkeeper@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a NARROWED evidence quote cannot shed the possessive on a call', async () => {
    const line = "my wife's name is wrong, it is Janet Smith";
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${line}` })],
      customer_field_candidates: [
        candidate({ id: 'n1', field_name: 'first_name', final_recommended_value: 'Janet', evidence_quote: 'name is wrong, it is Janet Smith' }),
        candidate({ id: 'n2', field_name: 'last_name', final_recommended_value: 'Smith', evidence_quote: 'name is wrong, it is Janet Smith' }),
      ],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].first_name).toBe('Jordan');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it('a historical move phrase beside a spelling fix does not clear the unit', async () => {
    // moveContext keys on the corrected statement — the spelling-fix group
    // in sentence 2 did not ride the move license from sentence 1.
    const body = 'I moved to Sarasota last year. You have my street misspelled; it is 123 Main St, Sarasota 34231';
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '123 Main St', quote: 'my street misspelled; it is 123 Main St, Sarasota 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'my street misspelled; it is 123 Main St, Sarasota 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'my street misspelled; it is 123 Main St, Sarasota 34231', confidence: 'high' },
        ],
      },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex });
    expect(res.applied.map((a) => a.field)).not.toContain('address_line2');
    expect(knex._data.customers[0].address_line2).toBe('Unit 4'); // unit survives the spelling fix
    expect(knex._data.customers[0].address_line1).toBe('123 Main St');
  });

  it('a genuine move through the runner still clears the unit', async () => {
    const body = 'We moved to 99 Pine Ave, Sarasota. Zip is 34231';
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'we moved to 99 Pine Ave', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'we moved to 99 Pine Ave, Sarasota', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'zip is 34231', confidence: 'high' },
        ],
      },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex });
    expect(res.applied.map((a) => a.field)).toContain('address_line2');
    expect(knex._data.customers[0].address_line2).toBeNull();
  });

  it('state- and suite-only corrections pass the entry prefilter', () => {
    expect(detectContactCorrectionIntent('My state is wrong; it should be GA')).toBe(true);
    expect(detectContactCorrectionIntent('My suite is wrong; it should be 4B')).toBe(true);
  });

  it('the shared ZIP inverse honors the USPS exceptional prefixes both ways', () => {
    const { stateForZip, zipMatchesState } = require('../services/data-hygiene/normalizers');
    expect(stateForZip('20147')).toBe('VA');
    expect(stateForZip('20005')).toBe('DC');
    expect(stateForZip('73301')).toBe('TX');
    expect(stateForZip('73101')).toBe('OK');
    expect(stateForZip('88510')).toBe('TX');
    for (const zip of ['20147', '20005', '73301', '73101', '88510']) {
      expect(zipMatchesState(zip, stateForZip(zip))).toBe(true);
    }
  });

  it('numeric ZIP scalars survive the shared admin address normalizer', () => {
    const { normalizeAdminAddressInput } = require('../utils/intake-normalize');
    const out = normalizeAdminAddressInput({ addressLine1: '12 Oak St', city: 'Sarasota', zip: 34231 });
    expect(out.zip).toBe('34231');
  });
});

describe('round-25 hardening', () => {
  it('a typographic apostrophe possessive is still third-party (SMS)', async () => {
    const body = 'My wife’s email is wrong; use spouse@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'spouse@example.com', quote: 'email is wrong; use spouse@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a state-only correction carries its own field intent end to end', async () => {
    const knex = makeStubKnex({ customers: [{ ...baseCustomer(), zip: '31401' }], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'state', new_value: 'GA', quote: 'my state is wrong; it should be GA', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'My state is wrong; it should be GA', knex });
    expect(res.applied.map((a) => a.field)).toEqual(['state']);
    expect(knex._data.customers[0].state).toBe('GA');
  });

  it('a stated unit that fails validation rejects the whole new-address group', async () => {
    // The unit dies in canonicalization; committing the new street while
    // treating the unit as omitted (and clearing the old one) would
    // corrupt the address the customer explicitly stated.
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'address_line1', newValue: '99 Pine Ave', quote: 'we moved to 99 Pine Ave, Sarasota 34231' },
        { field: 'address_line2', newValue: '——', quote: 'unit ——' },
        { field: 'city', newValue: 'Sarasota', quote: 'we moved' },
        { field: 'zip', newValue: '34231', quote: 'we moved' },
      ],
      source: 'sms',
      knex,
      moveContext: true,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toContain('unit_invalid');
    expect(knex._data.customers[0].address_line1).toBe('12 Oak St');
    expect(knex._data.customers[0].address_line2).toBe('Unit 4');
  });

  it('the shared ZIP inverse honors the r25 exceptional prefixes', () => {
    const { stateForZip } = require('../services/data-hygiene/normalizers');
    expect(stateForZip('05501')).toBe('MA');
    expect(stateForZip('05601')).toBe('VT');
    expect(stateForZip('56901')).toBe('DC');
    expect(stateForZip('34001')).toBeNull(); // military AA, never FL
    expect(stateForZip('34231')).toBe('FL');
  });
});

describe('round-26 hardening', () => {
  it('a partial state correction contradicting the stored ZIP fails closed', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] }); // stored FL 34200
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'state', newValue: 'GA', quote: 'my state is wrong; it should be GA' }],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'state', reason: 'state_zip_mismatch' });
    expect(knex._data.customers[0].state).toBe('FL');
  });

  it('a partial ZIP correction contradicting the stored state fails closed', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [{ field: 'zip', newValue: '31401', quote: 'my zip is wrong, it is 31401' }],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'zip', reason: 'state_zip_mismatch' });
    expect(knex._data.customers[0].zip).toBe('34200');
  });

  it('a coherent partial state+zip pair still applies', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'state', newValue: 'GA', quote: 'my state is wrong; it should be GA' },
        { field: 'zip', newValue: '31401', quote: 'zip is 31401' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied.map((a) => a.field).sort()).toEqual(['state', 'zip']);
    expect(knex._data.customers[0].state).toBe('GA');
    expect(knex._data.customers[0].zip).toBe('31401');
  });

  it("a third party's address COMPONENT is rejected, not just 'address'", async () => {
    const body = "My tenant's city is wrong; change it to Tampa";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'city', new_value: 'Tampa', quote: "my tenant's city is wrong; change it to Tampa", confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });
});

describe('round-27 hardening', () => {
  it('ownership context carries across the sentence boundary', async () => {
    const body = "My accountant's email is wrong. The email should be bookkeeper@example.com";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'the email should be bookkeeper@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('multiword modifiers cannot dodge the ownership predicate', async () => {
    const body = "My wife's new work email is wrong; it should be spouse@example.com";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'spouse@example.com', quote: "my wife's new work email is wrong; it should be spouse@example.com", confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('postal-code phrasing passes the entry prefilter and field intent', async () => {
    expect(detectContactCorrectionIntent('My postal code is wrong; it should be 33602')).toBe(true);
    expect(detectContactCorrectionIntent('My zipcode is wrong, it is 33602')).toBe(true);
  });

  it('the ZIP5 exceptions resolve and validate consistently', () => {
    const { stateForZip, zipMatchesState } = require('../services/data-hygiene/normalizers');
    expect(stateForZip('06390')).toBe('NY');
    expect(stateForZip('06032')).toBe('CT');
    expect(stateForZip('83414')).toBe('WY');
    expect(stateForZip('83301')).toBe('ID');
    expect(zipMatchesState('06390', 'NY')).toBe(true);
    expect(zipMatchesState('06390', 'CT')).toBe(false);
  });
});

describe('round-28 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('ownership holds at EVERY occurrence of a repeated SMS quote', async () => {
    const body = "My email is wrong. My accountant's email is wrong; use bookkeeper@example.com";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'email is wrong', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('ownership holds on every caller line matching a repeated call quote', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({
        transcription: [
          'Caller: my name is wrong',
          "Caller: my wife's name is wrong, it is Janet Smith",
        ].join('\n'),
      })],
      customer_field_candidates: [
        candidate({ id: 'n1', field_name: 'first_name', final_recommended_value: 'Janet', evidence_quote: 'name is wrong' }),
        candidate({ id: 'n2', field_name: 'last_name', final_recommended_value: 'Smith', evidence_quote: 'name is wrong' }),
      ],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].first_name).toBe('Jordan');
  });

  it('non-ASCII possessive owners trip the ownership guard', async () => {
    const body = "My fiancé's email is wrong; use spouse@example.com";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'spouse@example.com', quote: "my fiancé's email is wrong; use spouse@example.com", confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });
});

describe('round-29 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('a caller phone shared by two active customers never auto-applies', async () => {
    const knex = makeStubKnex({
      customers: [
        baseCustomer(),
        { id: '00000000-0000-4000-8000-0000000000c2', deleted_at: null, phone: PRIMARY_PHONE, first_name: 'Other', last_name: 'Holder' },
      ],
      call_log: [callLogRow()],
      customer_field_candidates: [candidate({ id: 'n1' })],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(res.skipped).toContainEqual({ field: 'name', reason: 'caller_not_primary' });
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('an applied address correction clears stale coordinates in the same transaction', async () => {
    const knex = makeStubKnex({
      customers: [{ ...baseCustomer(), latitude: 27.1, longitude: -82.4 }],
      agent_decisions: [],
    });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'city', new_value: 'Sarasota', quote: 'my city is wrong, it should be Sarasota', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'My city is wrong, it should be Sarasota', knex });
    expect(res.applied.map((a) => a.field)).toContain('city');
    expect(knex._data.customers[0].latitude).toBeNull();
    expect(knex._data.customers[0].longitude).toBeNull();
  });

  it("inverse ownership: 'the email for my accountant' is third-party", async () => {
    const body = 'The email for my accountant is wrong; change it to bookkeeper@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'the email for my accountant is wrong; change it to bookkeeper@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("inverse ownership: 'the city for my tenant' is third-party", async () => {
    const body = 'The city for my tenant is wrong; change it to Tampa';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'city', new_value: 'Tampa', quote: 'the city for my tenant is wrong; change it to Tampa', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("owner-verb ownership: 'my accountant has a new email' is third-party", async () => {
    const body = 'My accountant has a new email; use bookkeeper@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'my accountant has a new email; use bookkeeper@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });
});

describe('round-30 hardening', () => {
  it("'the email for my account' stays first-person (no determiner backtrack)", async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'me@example.com', quote: 'the email for my account is wrong; use me@example.com', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'The email for my account is wrong; use me@example.com', knex });
    expect(res.applied.map((a) => a.field)).toEqual(['email']);
    expect(knex._data.customers[0].email).toBe('me@example.com');
  });

  it("'the email belongs to my accountant' is third-party", async () => {
    const body = 'The email belongs to my accountant and is wrong; use bookkeeper@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'the email belongs to my accountant and is wrong; use bookkeeper@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("'the email for my accountant' is still third-party after the determiner fix", async () => {
    const body = 'The email for my accountant is wrong; change it to bookkeeper@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'the email for my accountant is wrong; change it to bookkeeper@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });
});

describe('round-31 prefilter + self-owner', () => {
  it('component should-be corrections pass the entry prefilter', () => {
    expect(detectContactCorrectionIntent('My city should be Sarasota')).toBe(true);
    expect(detectContactCorrectionIntent('My state should be GA')).toBe(true);
    expect(detectContactCorrectionIntent('My zip should be 31401')).toBe(true);
  });

  it("'my account has the wrong email' stays first-person", async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'me@example.com', quote: 'my account has the wrong email; change it to me@example.com', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'My account has the wrong email; change it to me@example.com', knex });
    expect(res.applied.map((a) => a.field)).toEqual(['email']);
  });

  it("'my accountant has a new email' still rejects after the self-owner fix", async () => {
    const body = 'My accountant has a new email; use bookkeeper@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'my accountant has a new email; use bookkeeper@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });
});

describe('round-32 ownership', () => {
  it("'the email is for my accountant' is third-party", async () => {
    const body = 'The email is for my accountant and is wrong; change it to bookkeeper@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'the email is for my accountant and is wrong; change it to bookkeeper@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });
});

describe('round-33 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('call ownership carries across adjacent caller lines', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({
        transcription: [
          "Caller: My wife's name is wrong.",
          'Caller: The name should be Janet Smith.',
        ].join('\n'),
      })],
      customer_field_candidates: [
        candidate({ id: 'n1', field_name: 'first_name', final_recommended_value: 'Janet', evidence_quote: 'the name should be Janet Smith' }),
        candidate({ id: 'n2', field_name: 'last_name', final_recommended_value: 'Smith', evidence_quote: 'the name should be Janet Smith' }),
      ],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].first_name).toBe('Jordan');
  });

  it('a state/ZIP mismatch rejects EVERY staged address field in the batch', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const res = await applyContactCorrections({
      customerId: CUSTOMER_ID,
      corrections: [
        { field: 'city', newValue: 'Atlanta', quote: 'my city and state should be Atlanta, GA' },
        { field: 'state', newValue: 'GA', quote: 'my city and state should be Atlanta, GA' },
      ],
      source: 'sms',
      knex,
    });
    expect(res.applied).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toContain('state_zip_mismatch');
    expect(knex._data.customers[0].city).toBe('Testville');
    expect(knex._data.customers[0].state).toBe('FL');
  });
});

describe('round-34 hardening', () => {
  it('an ownership disclaimer in the preceding sentence blocks a narrowed name quote', async () => {
    const body = "The account isn't mine. You have my name wrong; it should be Jane Smith";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'first_name', new_value: 'Jane', quote: 'you have my name wrong; it should be Jane Smith', confidence: 'high' },
          { field: 'last_name', new_value: 'Smith', quote: 'you have my name wrong; it should be Jane Smith', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('inflected change language passes the entry prefilter', () => {
    expect(detectContactCorrectionIntent('My address changed to 12 Oak St, Sarasota 34231')).toBe(true);
    expect(detectContactCorrectionIntent('My email has changed to jane@example.com')).toBe(true);
  });
});

describe('round-35 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('a FOLLOWING ownership clause blocks the correction (SMS)', async () => {
    const body = "The email is wrong; use bookkeeper@example.com. That's my accountant's email.";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'bookkeeper@example.com', quote: 'the email is wrong; use bookkeeper@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a FOLLOWING caller turn blocks the rename (call)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({
        transcription: [
          'Caller: The name should be Janet Smith.',
          "Caller: That's my wife's name.",
        ].join('\n'),
      })],
      customer_field_candidates: [
        candidate({ id: 'n1', field_name: 'first_name', final_recommended_value: 'Janet', evidence_quote: 'the name should be Janet Smith' }),
        candidate({ id: 'n2', field_name: 'last_name', final_recommended_value: 'Smith', evidence_quote: 'the name should be Janet Smith' }),
      ],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].first_name).toBe('Jordan');
  });

  it("a third party's move never rewrites the customer's address", async () => {
    const body = 'My tenant is moving to a new address: 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'my tenant is moving to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'my tenant is moving to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'my tenant is moving to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'my tenant is moving to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("the customer's own move still passes the move-subject guard", async () => {
    const body = 'We are moving to 99 Pine Ave, Sarasota. Zip is 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'we are moving to 99 Pine Ave', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'we are moving to 99 Pine Ave, Sarasota', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'zip is 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field).sort()).toEqual(['address_line1', 'city', 'zip']);
  });
});

describe('round-36 hardening', () => {
  it("a third party's PAST-TENSE move never rewrites the customer's address", async () => {
    const body = 'My tenant moved to a new address: 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'my tenant moved to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'my tenant moved to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'my tenant moved to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'my tenant moved to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("the customer's own past-tense move still passes", async () => {
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
    expect(res.map((c) => c.field).sort()).toEqual(['address_line1', 'city', 'zip']);
  });
});

describe('round-37 hardening', () => {
  it("a third party's FUTURE move never rewrites the customer's address", async () => {
    const body = 'My tenant will move to a new address: 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'my tenant will move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'my tenant will move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'my tenant will move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'my tenant will move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("the customer's own future move carries move context (unit clears)", async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'i will move to 99 Pine Ave', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'i will move to 99 Pine Ave, Sarasota', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'zip is 34231', confidence: 'high' },
        ],
      },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'I will move to 99 Pine Ave, Sarasota. Zip is 34231', knex });
    expect(res.applied.map((a) => a.field)).toContain('address_line2');
    expect(knex._data.customers[0].address_line2).toBeNull();
    expect(knex._data.customers[0].address_line1).toBe('99 Pine Ave');
  });
});

describe('round-38 hardening', () => {
  it('a same-message retraction applies the FINAL stated value', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const body = 'My email is wrong, use first@example.com, sorry actually use final@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'email', new_value: 'first@example.com', quote: 'my email is wrong, use first@example.com', confidence: 'high' },
          { field: 'email', new_value: 'final@example.com', quote: 'sorry actually use final@example.com', confidence: 'high' },
        ],
      },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex });
    expect(res.applied.map((a) => a.newValue)).toEqual(['final@example.com']);
    expect(knex._data.customers[0].email).toBe('final@example.com');
  });

  it("a third party 'going to move' subject never rewrites the address", async () => {
    const body = 'My tenant is going to move to a new address: 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'my tenant is going to move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'my tenant is going to move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'my tenant is going to move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'my tenant is going to move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("the customer's own 'going to move' carries move context (unit clears)", async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: "i'm going to move to 99 Pine Ave", confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: "i'm going to move to 99 Pine Ave, Sarasota", confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'zip is 34231', confidence: 'high' },
        ],
      },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: "I'm going to move to 99 Pine Ave, Sarasota. Zip is 34231", knex });
    expect(res.applied.map((a) => a.field)).toContain('address_line2');
    expect(knex._data.customers[0].address_line2).toBeNull();
  });
});

describe('round-38 retraction license boundary', () => {
  it('a bare same-field mention without retraction language licenses nothing', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const body = 'My email is wrong; please fix it. For receipts, send to billing@vendor.example';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'email', new_value: 'billing@vendor.example', quote: 'send to billing@vendor.example', confidence: 'high' },
        ],
      },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex });
    expect(res.applied).toEqual([]);
    expect(knex._data.customers[0].email).toBe('jordan.riverz@example.com');
  });
});

describe('round-39 hardening', () => {
  it('a discourse marker fronting unrelated business is NOT a retraction', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const body = 'My email is wrong; use jane@example.com. Actually, send the receipt to billing@vendor.example';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'email', new_value: 'jane@example.com', quote: 'my email is wrong; use jane@example.com', confidence: 'high' },
          { field: 'email', new_value: 'billing@vendor.example', quote: 'actually, send the receipt to billing@vendor.example', confidence: 'high' },
        ],
      },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex });
    expect(res.applied.map((a) => a.newValue)).toEqual(['jane@example.com']);
    expect(knex._data.customers[0].email).toBe('jane@example.com');
  });

  it("a third party 'plans to move' subject never rewrites the address", async () => {
    const body = 'My tenant plans to move to a new address: 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'my tenant plans to move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'my tenant plans to move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'my tenant plans to move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'my tenant plans to move to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("the customer's own 'plan to move' carries move context", async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'i plan to move to 99 Pine Ave', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'i plan to move to 99 Pine Ave, Sarasota', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'zip is 34231', confidence: 'high' },
        ],
      },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'I plan to move to 99 Pine Ave, Sarasota. Zip is 34231', knex });
    expect(res.applied.map((a) => a.field)).toContain('address_line2');
    expect(knex._data.customers[0].address_line2).toBeNull();
  });
});

describe('round-40 hardening', () => {
  it("a NAMED third party moving never rewrites the customer's address", async () => {
    const body = 'John is moving to a new address: 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'john is moving to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'john is moving to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'john is moving to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'john is moving to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a historical move beside a later spelling fix keeps the unit (post-dedupe context)', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    const body = 'I moved to 99 Pine Ave last year. Your street spelling is wrong; it should be 99 Pine Ave. My city is wrong, it is Sarasota. My zip is wrong, it is 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'i moved to 99 Pine Ave last year', confidence: 'high' },
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'your street spelling is wrong; it should be 99 Pine Ave', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'my city is wrong, it is Sarasota', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'my zip is wrong, it is 34231', confidence: 'high' },
        ],
      },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body, knex });
    expect(res.applied.map((a) => a.field)).not.toContain('address_line2');
    expect(knex._data.customers[0].address_line2).toBe('Unit 4');
    expect(knex._data.customers[0].address_line1).toBe('99 Pine Ave');
  });

  it("the customer's own 'we are moving' still passes the named-subject guard", async () => {
    const body = 'We are moving to 99 Pine Ave, Sarasota. Zip is 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'we are moving to 99 Pine Ave', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'we are moving to 99 Pine Ave, Sarasota', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'zip is 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field).sort()).toEqual(['address_line1', 'city', 'zip']);
  });
});

describe('round-41 hardening', () => {
  it("'John moved to a new address' never rewrites the customer's address", async () => {
    const body = 'John moved to a new address: 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'john moved to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'john moved to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'john moved to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'john moved to a new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("'we have just moved to' still passes the bare-verb guard", async () => {
    const body = 'We have just moved to 99 Pine Ave, Sarasota. Zip is 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'we have just moved to 99 Pine Ave', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'we have just moved to 99 Pine Ave, Sarasota', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'zip is 34231', confidence: 'high' },
        ],
      },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field).sort()).toEqual(['address_line1', 'city', 'zip']);
  });

  it("'Jane changed to a new email' never replaces the customer's email", async () => {
    const body = 'Jane changed to a new email: jane@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'jane@example.com', quote: 'jane changed to a new email: jane@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("'I changed to a new email' still passes the contact-change guard", async () => {
    const body = 'I changed to a new email: me@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'me@example.com', quote: 'i changed to a new email: me@example.com', confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['email']);
  });

  it('an explicitly OLD value with no replacement direction never applies', async () => {
    const body = 'For reference, my old email is retired@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'retired@example.com', quote: 'my old email is retired@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a replacement-directed OLD mention still corrects', async () => {
    const body = 'My old email is dead — use fresh@example.com instead';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'fresh@example.com', quote: 'my old email is dead — use fresh@example.com instead', confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.newValue)).toEqual(['fresh@example.com']);
  });

  it('a purpose-scoped address never rewrites the service address', async () => {
    const body = 'The new address for invoices is 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'the new address for invoices is 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'the new address for invoices is 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'the new address for invoices is 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'the new address for invoices is 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });
});

describe('round-42 hardening', () => {
  it("'do not use my old email' never applies the retired mailbox", async () => {
    const body = 'Do not use my old email old@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'old@example.com', quote: 'do not use my old email old@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a purpose address with intervening direction phrases is still rejected', async () => {
    const body = 'The new address to use for invoices is 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'the new address to use for invoices is 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'the new address to use for invoices is 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'the new address to use for invoices is 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'the new address to use for invoices is 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a unit-only correction keeps the still-valid coordinates', async () => {
    const knex = makeStubKnex({
      customers: [{ ...baseCustomer(), latitude: 27.1, longitude: -82.4 }],
      agent_decisions: [],
    });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'address_line2', new_value: '4B', quote: 'my unit is wrong, it is 4B', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'My unit is wrong, it is 4B', knex });
    expect(res.applied.map((a) => a.field)).toEqual(['address_line2']);
    expect(knex._data.customers[0].latitude).toBe(27.1);
    expect(knex._data.customers[0].longitude).toBe(-82.4);
  });
});

describe('round-43 hardening', () => {
  it('an interrupted negation still vetoes the old-value direction', async () => {
    for (const body of [
      "Please don't ever use my old email old@example.com",
      "I don't want you to use my old email old@example.com",
    ]) {
      mockCallAnthropic.mockResolvedValue({
        ok: true,
        json: { corrections: [{ field: 'email', new_value: 'old@example.com', quote: body.toLowerCase(), confidence: 'high' }] },
      });
      expect(await extractSmsContactCorrections({ body })).toEqual([]);
    }
  });

  it("'the address on my invoices should be …' never rewrites the service address", async () => {
    const body = 'The address on my invoices should be 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'the address on my invoices should be 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'the address on my invoices should be 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'the address on my invoices should be 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'the address on my invoices should be 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a unit-only correction preserves the PRIMARY PROPERTY coordinates', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'address_line2', new_value: '4B', quote: 'my unit is wrong, it is 4B', confidence: 'high' }] },
    });
    const res = await runSmsContactCorrection({ customer: { id: CUSTOMER_ID }, body: 'My unit is wrong, it is 4B', knex });
    expect(res.applied.map((a) => a.field)).toEqual(['address_line2']);
    // The mocked syncPrimaryAddress must receive preserveCoords: true.
    expect(mockSyncPrimaryAddress).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ preserveCoords: true }),
    );
  });
});

describe('round-44 hardening', () => {
  it('an identity disclaimer invalidates every correction in the message', async () => {
    const body = "I'm not John anymore. My email is newholder@example.com — your email is wrong";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'newholder@example.com', quote: 'my email is newholder@example.com — your email is wrong', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it("'I'm not sure' never trips the identity disclaimer", async () => {
    const body = "I'm not sure you have it right — my email is wrong, it is me@example.com";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'me@example.com', quote: 'my email is wrong, it is me@example.com', confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.field)).toEqual(['email']);
  });

  it('modal negations veto the old-value direction', async () => {
    for (const body of [
      'You must not use my old email old@example.com',
      "You shouldn't use my old email old@example.com",
    ]) {
      mockCallAnthropic.mockResolvedValue({
        ok: true,
        json: { corrections: [{ field: 'email', new_value: 'old@example.com', quote: body.toLowerCase(), confidence: 'high' }] },
      });
      expect(await extractSmsContactCorrections({ body })).toEqual([]);
    }
  });

  it('a purpose phrase PRECEDING the address is still rejected', async () => {
    const body = 'Please send invoices to this new address: 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'send invoices to this new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'send invoices to this new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'send invoices to this new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'send invoices to this new address: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });
});

describe('round-45 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it("'this isn't John anymore' invalidates the message", async () => {
    const body = "This isn't John anymore. My email is newholder@example.com — your email is wrong";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'newholder@example.com', quote: 'my email is newholder@example.com — your email is wrong', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('an address-to-purpose construction is rejected', async () => {
    const body = 'Please use this new address to send invoices: 99 Pine Ave, Sarasota, FL 34231';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'address_line1', new_value: '99 Pine Ave', quote: 'use this new address to send invoices: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'city', new_value: 'Sarasota', quote: 'use this new address to send invoices: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'state', new_value: 'FL', quote: 'use this new address to send invoices: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
          { field: 'zip', new_value: '34231', quote: 'use this new address to send invoices: 99 Pine Ave, Sarasota, FL 34231', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a caller identity disclaimer kills the whole call batch', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({
        transcription: [
          "Caller: I'm not John anymore.",
          'Caller: You have my name wrong; it should be Jane Smith.',
        ].join('\n'),
      })],
      customer_field_candidates: [
        candidate({ id: 'n1', field_name: 'first_name', final_recommended_value: 'Jane', evidence_quote: 'you have my name wrong; it should be Jane Smith' }),
        candidate({ id: 'n2', field_name: 'last_name', final_recommended_value: 'Smith', evidence_quote: 'you have my name wrong; it should be Jane Smith' }),
      ],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('identity_disclaimed');
    expect(knex._data.customers[0].first_name).toBe('Jordan');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});

describe('round-46 hardening', () => {
  const candidate = (over = {}) => ({
    id: `cand-${Math.random().toString(36).slice(2, 8)}`,
    call_log_id: CALL_ID,
    customer_id: CUSTOMER_ID,
    status: 'pending',
    field_name: 'last_name',
    final_recommended_value: 'Rivers',
    evidence_quote: 'my last name is spelled wrong, it is Rivers',
    confidence: 0.95,
    ...over,
  });

  it('an ALL-CAPS disclaimer name still trips the identity veto', async () => {
    const body = "This isn't JOHN anymore. My email is newholder@example.com — your email is wrong";
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'newholder@example.com', quote: 'my email is newholder@example.com — your email is wrong', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a NEGATED name statement never renames on a call', async () => {
    const quote = 'my name is not Jane Smith anymore';
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      call_log: [callLogRow({ transcription: `Caller: ${quote}` })],
      customer_field_candidates: [
        candidate({ id: 'n1', field_name: 'first_name', final_recommended_value: 'Jane', evidence_quote: quote }),
        candidate({ id: 'n2', field_name: 'last_name', final_recommended_value: 'Smith', evidence_quote: quote }),
      ],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied || []).toEqual([]);
    expect(knex._data.customers[0].first_name).toBe('Jordan');
  });

  it('a NEGATED name statement never renames over SMS', async () => {
    const body = 'My name is not Jane Smith anymore';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'first_name', new_value: 'Jane', quote: 'my name is not Jane Smith anymore', confidence: 'high' },
          { field: 'last_name', new_value: 'Smith', quote: 'my name is not Jane Smith anymore', confidence: 'high' },
        ],
      },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('future/progressive first-person moves pass the prefilter', () => {
    expect(detectContactCorrectionIntent('I will move to 99 Pine Ave, Sarasota, FL 34231')).toBe(true);
    expect(detectContactCorrectionIntent("I'm moving to 99 Pine Ave, Sarasota")).toBe(true);
    expect(detectContactCorrectionIntent('We plan to move to 99 Pine Ave')).toBe(true);
  });
});

describe('round-47 hardening', () => {
  it('a smart-apostrophe identity disclaimer still trips the veto', async () => {
    const body = 'I’m not John anymore. My email is wrong; use newholder@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'newholder@example.com', quote: 'my email is wrong; use newholder@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('a directly NEGATED value never applies', async () => {
    const body = 'My email is not jane@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'jane@example.com', quote: 'my email is not jane@example.com', confidence: 'high' }] },
    });
    expect(await extractSmsContactCorrections({ body })).toEqual([]);
  });

  it('an affirmed value beside a negated one still applies', async () => {
    const body = 'My email is not jane@example.com, it is joan@example.com';
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: { corrections: [{ field: 'email', new_value: 'joan@example.com', quote: 'my email is not jane@example.com, it is joan@example.com', confidence: 'high' }] },
    });
    const res = await extractSmsContactCorrections({ body });
    expect(res.map((c) => c.newValue)).toEqual(['joan@example.com']);
  });
});
