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
jest.mock('../services/customer-properties', () => ({
  syncPrimaryAddress: (...args) => mockSyncPrimaryAddress(...args),
}));
const mockAddressFanout = jest.fn().mockResolvedValue(null);
jest.mock('../services/customer-address-fanout', () => ({
  propagateCustomerAddressChange: (...args) => mockAddressFanout(...args),
}));
const mockEmailFanout = jest.fn().mockResolvedValue(null);
jest.mock('../services/customer-email-fanout', () => ({
  propagateCustomerEmailChange: (...args) => mockEmailFanout(...args),
}));
const mockNameFanout = jest.fn().mockResolvedValue(null);
jest.mock('../services/customer-contact-fanout', () => ({
  propagateCustomerNameChange: (...args) => mockNameFanout(...args),
}));

const {
  detectContactCorrectionIntent,
  extractSmsContactCorrections,
  applyContactCorrections,
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
      whereNotNull(col) { preds.push((r) => r[col] != null); return chain; },
      whereIn(col, list) { preds.push((r) => list.includes(r[col])); return chain; },
      forUpdate() { return chain; },
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
  builder.schema = { hasTable: () => Promise.resolve(true) };
  Object.defineProperty(builder, '_data', { get: () => data });
  builder._inserts = inserts;
  builder._failInsertOn = failInsertOn;
  return builder;
}

const baseCustomer = () => ({
  id: CUSTOMER_ID,
  deleted_at: null,
  first_name: 'Jordan',
  last_name: 'Riverz',
  email: 'jordan.riverz@example.com',
  address_line1: '12 Oak St',
  address_line2: 'Unit 4',
  city: 'Testville',
  state: 'FL',
  zip: '34200',
});

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
  it('keeps only high-confidence corrections on applyable fields', async () => {
    mockCallAnthropic.mockResolvedValue({
      ok: true,
      json: {
        corrections: [
          { field: 'last_name', new_value: 'Rivers', quote: 'name is spelled Rivers', confidence: 'high' },
          { field: 'email', new_value: 'a@b.co', quote: 'email is a@b.co', confidence: 'medium' },
          { field: 'phone', new_value: '5551234567', quote: 'call me at', confidence: 'high' },
        ],
      },
    });
    const out = await extractSmsContactCorrections({ body: 'name is wrong, it is spelled Rivers' });
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
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
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
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
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
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
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
    const knex = makeStubKnex({ customers: [baseCustomer()], agent_decisions: [] });
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
    status: 'pending',
    field_name: 'email',
    final_recommended_value: 'jordan.rivers@example.com',
    evidence_quote: 'you have the wrong email, it is jordan dot rivers at example dot com',
    confidence: 0.95,
    ...over,
  });

  it('applies evidence-pinned candidates whose quote carries correction intent, and stamps them', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      customer_field_candidates: [candidate({ id: 'cand-1' })],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied).toEqual([
      { field: 'email', oldValue: 'jordan.riverz@example.com', newValue: 'jordan.rivers@example.com', quote: 'you have the wrong email, it is jordan dot rivers at example dot com' },
    ]);
    expect(knex._data.customers[0].email).toBe('jordan.rivers@example.com');
    expect(knex._data.customer_field_candidates[0].status).toBe('auto_applied');
    expect(knex._data.customer_field_candidates[0].reviewed_at).toBeInstanceOf(Date);
  });

  it('ignores routine mentions — an evidence quote without correction intent is not a mandate', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      customer_field_candidates: [
        candidate({ id: 'routine', field_name: 'last_name', final_recommended_value: 'Rivers', evidence_quote: 'this is Jordan Rivers calling about my lawn' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].last_name).toBe('Riverz');
  });

  it('accepts NULL-confidence email candidates (the staging writer never scores email)', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      customer_field_candidates: [candidate({ id: 'nullconf', confidence: null })],
      agent_decisions: [],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.applied.map((a) => a.field)).toEqual(['email']);
  });

  it('stamps only the candidate whose value was actually applied', async () => {
    const knex = makeStubKnex({
      customers: [baseCustomer()],
      customer_field_candidates: [
        candidate({ id: 'winner' }),
        candidate({ id: 'loser', final_recommended_value: 'other.value@example.com' }),
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
      customers: [baseCustomer()],
      customer_field_candidates: [
        candidate({ id: 'lo', field_name: 'last_name', confidence: 0.5 }),
        candidate({ id: 'nq', evidence_quote: null }),
        candidate({ id: 'ph', field_name: 'phone', final_recommended_value: '+15551234567' }),
        candidate({ id: 'done', status: 'rejected' }),
      ],
    });
    const res = await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex });
    expect(res.reason).toBe('no_candidates');
    expect(knex._data.customers[0].email).toBe('jordan.riverz@example.com');
  });

  it('does nothing for unlinked calls or with the gate off', async () => {
    const knex = makeStubKnex({ customers: [baseCustomer()], customer_field_candidates: [candidate()] });
    expect((await runCallContactCorrection({ callId: CALL_ID, customerId: null, knex })).reason).toBe('unlinked');
    mockIsEnabled.mockReturnValue(false);
    expect((await runCallContactCorrection({ callId: CALL_ID, customerId: CUSTOMER_ID, knex })).reason).toBe('gate_off');
    expect(knex._data.customers[0].email).toBe('jordan.riverz@example.com');
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
