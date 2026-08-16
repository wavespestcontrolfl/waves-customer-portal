// Delegating db mock — staging tests install a per-test stub; the pure
// builder tests never touch it.
let mockDbStub = null;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockDbStub(...args);
  proxy.fn = { now: () => 'NOW' };
  proxy.schema = { hasTable: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  buildCustomerFieldCandidates,
  stageCustomerFieldCandidates,
  __resetForTests,
} = require('../services/call-field-candidates');

function validV2Extraction(overrides = {}) {
  const base = {
    meta: {
      schema_version: '1.0.0',
      is_voicemail: false,
      is_spam: false,
    },
    caller: {
      name_full: 'Maria Rodriguez',
      first_name: 'Maria',
      last_name: 'Rodriguez',
      phone_e164: '+19415551234',
      email: null,
    },
    property: {
      service_address: {
        street_line_1: '8224 Abalone Loop',
        city: 'Parrish',
        state: 'FL',
        postal_code: '34219',
      },
    },
    service_request: {
      primary_service_category: 'pest_general',
    },
    evidence: [
      {
        field_path: '/caller/name_full',
        quote: 'My name is Maria Rodriguez.',
        speaker: 'caller',
      },
      {
        field_path: '/property/service_address',
        quote: "I'm at 8224 Abalone Loop in Parrish.",
        speaker: 'caller',
      },
      {
        field_path: '/service_request/primary_service_category',
        quote: 'I need pest control for roaches.',
        speaker: 'caller',
      },
    ],
    confidence: {
      caller_identity: 0.9,
      service_address: 0.95,
      primary_service_category: 0.94,
    },
  };

  return merge(base, overrides);
}

function merge(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(source || {})) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && target[key]
      && typeof target[key] === 'object'
      && !Array.isArray(target[key])
    ) {
      out[key] = merge(target[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

describe('call field candidates', () => {
  test('builds v2 candidates with evidence, confidence, and mapped service values', () => {
    const rows = buildCustomerFieldCandidates({
      callId: '11111111-1111-4111-8111-111111111111',
      customerId: '22222222-2222-4222-8222-222222222222',
      extraction: { first_name: 'Legacy' },
      v2Extraction: validV2Extraction(),
    });

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field_name: 'first_name',
        final_recommended_value: 'Maria',
        evidence_quote: 'My name is Maria Rodriguez.',
        source: 'gemini_v2',
        confidence: 0.9,
      }),
      expect.objectContaining({
        field_name: 'address_line1',
        final_recommended_value: '8224 Abalone Loop',
        evidence_quote: "I'm at 8224 Abalone Loop in Parrish.",
        source: 'gemini_v2',
        confidence: 0.95,
      }),
      expect.objectContaining({
        field_name: 'matched_service',
        final_recommended_value: 'General Pest Control',
        evidence_quote: 'I need pest control for roaches.',
        source: 'gemini_v2',
        confidence: 0.94,
      }),
    ]));
  });

  test('falls back to legacy extraction when v2 is unavailable', () => {
    const rows = buildCustomerFieldCandidates({
      callId: '11111111-1111-4111-8111-111111111111',
      extraction: {
        first_name: 'Ada',
        phone: '+19415550000',
        matched_service: 'General Pest Control',
      },
    });

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field_name: 'first_name',
        final_recommended_value: 'Ada',
        evidence_quote: null,
        source: 'legacy_gemini',
        confidence: null,
      }),
      expect.objectContaining({
        field_name: 'matched_service',
        final_recommended_value: 'General Pest Control',
        source: 'legacy_gemini',
      }),
    ]));
  });
});

describe('staging dedupe linkage (codex #3413 r17)', () => {
  const CALL_ID = '11111111-1111-4111-8111-111111111111';
  const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
  const OTHER_CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';

  // Minimal chainable stub over an in-memory candidates table.
  function installDbStub(rows = []) {
    const data = rows.map((r) => ({ ...r }));
    let nextId = 100;
    mockDbStub = (table) => {
      if (table !== 'customer_field_candidates') throw new Error(`unexpected table ${table}`);
      const preds = [];
      const chain = {
        where(a, b) {
          if (typeof a === 'object') for (const [k, v] of Object.entries(a)) preds.push((r) => r[k] === v);
          else preds.push((r) => r[a] === b);
          return chain;
        },
        first(...cols) {
          const row = data.find((r) => preds.every((p) => p(r)));
          if (!row) return Promise.resolve(undefined);
          return Promise.resolve(Object.fromEntries(cols.map((c) => [c, row[c]])));
        },
        update(vals) {
          const matched = data.filter((r) => preds.every((p) => p(r)));
          for (const r of matched) Object.assign(r, vals);
          return Promise.resolve(matched.length);
        },
        insert(row) {
          const stored = { id: `cand-${++nextId}`, ...row };
          data.push(stored);
          const result = Promise.resolve([{ id: stored.id }]);
          result.returning = () => Promise.resolve([{ id: stored.id }]);
          return result;
        },
      };
      return chain;
    };
    return data;
  }

  const existingRow = (over = {}) => ({
    id: 'cand-1',
    call_log_id: CALL_ID,
    customer_id: null,
    field_name: 'last_name',
    final_recommended_value: 'Rodriguez',
    source: 'gemini_v2',
    status: 'pending',
    ...over,
  });

  const stageArgs = () => ({
    callId: CALL_ID,
    customerId: CUSTOMER_ID,
    extraction: {},
    v2Extraction: validV2Extraction({
      caller: { name_full: null, first_name: null, email: null, phone_e164: null },
      property: { service_address: null },
      service_request: { primary_service_category: null },
      confidence: {},
    }),
  });

  beforeEach(() => { __resetForTests(); });
  afterEach(() => { mockDbStub = null; });

  test('relinks a still-pending same-value row to the newly linked customer', async () => {
    // A force-reprocessed call that was unlinked at first staging: the
    // dedupe row carries customer_id NULL, and without the relink the
    // runner's customer scope silently drops the correction.
    const data = installDbStub([existingRow({ customer_id: null })]);
    const res = await stageCustomerFieldCandidates(stageArgs());
    expect(res.stagedIds).toEqual(['cand-1']);
    expect(data[0].customer_id).toBe(CUSTOMER_ID);
  });

  test('reuses a same-value row already carrying the current linkage untouched', async () => {
    const data = installDbStub([existingRow({ customer_id: CUSTOMER_ID })]);
    const res = await stageCustomerFieldCandidates(stageArgs());
    expect(res.stagedIds).toEqual(['cand-1']);
    expect(res.staged).toBe(0);
    expect(data[0].customer_id).toBe(CUSTOMER_ID);
  });

  test('a row already resolved under the OLD linkage is history — a fresh row is staged', async () => {
    const data = installDbStub([existingRow({ customer_id: OTHER_CUSTOMER_ID, status: 'auto_applied' })]);
    const res = await stageCustomerFieldCandidates(stageArgs());
    expect(res.staged).toBe(1);
    expect(res.stagedIds).toHaveLength(1);
    expect(res.stagedIds[0]).not.toBe('cand-1');
    // The resolved row keeps its original linkage and status.
    expect(data[0].customer_id).toBe(OTHER_CUSTOMER_ID);
    expect(data[0].status).toBe('auto_applied');
    expect(data[1].customer_id).toBe(CUSTOMER_ID);
  });
});
