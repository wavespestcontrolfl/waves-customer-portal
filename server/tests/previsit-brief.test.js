/**
 * Pre-visit pocket-reference brief (services/previsit-brief.js):
 *  - gate-off = bit-for-bit no-op (no reads, no writes)
 *  - a WDO brief is NEVER clobbered (stored type AND classifier guard,
 *    plus the guard riding the UPDATE itself)
 *  - access codes land in the stored brief's deterministic access block
 *    and NEVER appear in the grounding facts
 *  - every brief is the deterministic template; no provider call
 *  - input-hash cache: unchanged grounding no-ops regeneration
 *  - lawn visits: product guidance is the protocol window's products ONLY
 *  - forbidden target genera are filtered from deterministic target lists
 */

jest.mock('../models/db', () => {
  const fn = (table) => global.__briefDbMock(table);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Tripwire: the brief makes no provider call (the model rewrite was removed,
// owner 2026-10-03). If one is reintroduced through llm/call, the
// not-called assertions below fail.
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: (...args) => global.__dispatch(...args),
}));
const mockGetContext = jest.fn();
jest.mock('../services/context-aggregator', () => {
  // The REAL redactor (not a mock): the payload-boundary redaction tests
  // must exercise the production masking behavior (jest.requireActual per
  // the mock-is-not-a-production-export rule).
  const { redactAccessCodes, customerSafeVisitNotes } = jest.requireActual('../services/context-aggregator');
  return {
    getContextForCustomer: (...args) => mockGetContext(...args),
    redactAccessCodes,
    customerSafeVisitNotes,
  };
});
jest.mock('../services/appointment-tagger', () => ({
  classifyAppointmentType: (serviceType) => (
    /wdo|wood destroying/i.test(String(serviceType || ''))
      ? { tag: 'wdo_inspection', label: 'WDO Inspection' }
      : { tag: 'pest_general', label: 'Pest Control' }
  ),
}));
const mockResolveProfile = jest.fn();
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: (...args) => mockResolveProfile(...args),
}));
const mockCheckLimits = jest.fn();
jest.mock('../services/application-limits', () => ({
  checkLimits: (...args) => mockCheckLimits(...args),
}));
jest.mock('../services/service-report/since-last-visit', () => ({
  buildSinceLastVisitContext: jest.fn(async () => ({
    pressureLine: 'Pressure: 2.0 -> 1.0',
    activityLine: 'Ant trail at garage corner',
  })),
}));
jest.mock('../services/service-report/service-line-configs', () => ({
  // Line-aware (the real classifier's shape matters now): the brief's
  // history must be scoped to the visit's service line.
  detectServiceLine: (serviceType) => {
    const s = String(serviceType || '');
    if (/tree|shrub|palm/i.test(s)) return 'tree_shrub';
    if (/termite|wdo/i.test(s)) return 'termite';
    if (/lawn|turf/i.test(s)) return 'lawn';
    // Real-classifier precedence: a pest mention wins over a rodent
    // token ("Pest & Rodent Control" is the pest line).
    if (/pest/i.test(s)) return 'pest';
    if (/rodent|rat|mouse|mice/i.test(s)) return 'rodent';
    return 'pest';
  },
}));
const mockGrassContext = jest.fn(async () => ({ trackKey: 'st_augustine' }));
jest.mock('../services/lawn-grass-context', () => ({
  loadCustomerGrassContext: (...args) => mockGrassContext(...args),
}));
const mockWindowContext = jest.fn(async () => ({}));
const mockSummarize = jest.fn(() => null);
jest.mock('../services/lawn-protocol-operating-layer', () => ({
  getProtocolWindowContext: (...args) => mockWindowContext(...args),
  summarizeProtocolContext: (...args) => mockSummarize(...args),
}));

const PrevisitBrief = require('../services/previsit-brief');

// ── mock-knex builder (agronomic-wiki-review-tiers pattern + join/update) ──
function makeDb(responses = {}) {
  const state = { responses, calls: {}, updates: {} };
  const dbFn = (table) => {
    // Alias-stripped table name so "scheduled_services as s" resolves.
    const bare = String(table).split(/\s+as\s+/i)[0];
    const rec = { table: bare, ops: [] };
    (state.calls[bare] = state.calls[bare] || []).push(rec);
    const callIdx = state.calls[bare].length - 1;
    const resolveRows = () => {
      const conf = state.responses[bare];
      if (typeof conf === 'function') return conf(rec, callIdx) || [];
      if (Array.isArray(conf)) return conf;
      return [];
    };
    const b = {};
    for (const m of ['where', 'andWhere', 'orWhere', 'whereRaw', 'whereIn', 'whereNotIn', 'whereNull',
      'whereNotNull', 'orWhereNot', 'orWhereNull', 'whereNot', 'whereBetween', 'join', 'leftJoin',
      'orderBy', 'limit', 'offset', 'select', 'groupBy']) {
      b[m] = (...args) => {
        rec.ops.push([m, args]);
        if (typeof args[0] === 'function') args[0].call(b);
        return b;
      };
    }
    b.first = async (...args) => { rec.ops.push(['first', args]); return resolveRows()[0] ?? null; };
    b.update = (patch) => {
      rec.ops.push(['update', [patch]]);
      (state.updates[bare] = state.updates[bare] || []).push(patch);
      return { then: (res, rej) => Promise.resolve(1).then(res, rej), catch: () => Promise.resolve(1) };
    };
    b.then = (res, rej) => {
      let rows;
      try { rows = resolveRows(); } catch (err) { return Promise.reject(err).then(res, rej); }
      return Promise.resolve(rows).then(res, rej);
    };
    b.catch = (onRej) => {
      try { return Promise.resolve(resolveRows()).catch(onRej); } catch (err) { return Promise.resolve(onRej(err)); }
    };
    return b;
  };
  dbFn.state = state;
  return dbFn;
}

function useDb(responses) {
  const dbFn = makeDb(responses);
  global.__briefDbMock = dbFn;
  return dbFn.state;
}

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  service_type: 'Pest Control Service',
  scheduled_date: '2026-08-13',
  status: 'confirmed',
  is_recurring: true,
  notes: '',
  source_estimate_id: null,
  pre_service_brief: null,
  pre_service_brief_type: null,
};

const PREFS = {
  customer_id: 'cust-1',
  property_gate_code: '4545',
  garage_code: '9876',
  pet_count: 1,
  pet_details: 'One dog, friendly',
  chemical_sensitivities: true,
  chemical_sensitivity_details: 'Sensitive to pyrethroids',
};

const SERVICE_RECORD = {
  id: 'rec-1',
  customer_id: 'cust-1',
  service_type: 'Pest Control Service',
  service_line: 'pest',
  service_date: '2026-07-15',
  started_at: null,
  pressure_index: 1.0,
};

const PRODUCT_ROW = {
  service_record_id: 'rec-1',
  product_name: 'Bifen IT',
  active_ingredient: 'Bifenthrin',
  moa_group: '3A',
  application_rate: 1,
  rate_unit: 'oz/gal',
  targets: ['ants', 'Ganoderma'],
  catalog_name: 'Bifen IT',
  catalog_active_ingredient: 'Bifenthrin',
  epa_reg_number: '53883-118',
};

function baseResponses(overrides = {}) {
  return {
    scheduled_services: [{ ...SVC }],
    customers: [{ id: 'cust-1', first_name: 'Test', last_name: 'Fixture' }],
    property_preferences: [PREFS],
    service_records: [SERVICE_RECORD],
    service_products: [PRODUCT_ROW],
    estimates: [],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_PREVISIT_BRIEF = 'true';
  global.__dispatch = jest.fn();
  // Persistent defaults (never ...Once): generateVisitBrief re-reads the
  // deterministic grounding right before persisting, so every source is
  // consulted twice per generation.
  mockGrassContext.mockResolvedValue({ trackKey: 'st_augustine' });
  mockWindowContext.mockResolvedValue({});
  mockResolveProfile.mockResolvedValue({ companions: [] });
  mockCheckLimits.mockResolvedValue({ allowed: true, warnings: [], blocks: [] });
  mockSummarize.mockReturnValue(null);
  mockGetContext.mockResolvedValue({
    serviceHistory: [{ type: 'Pest Control Service', date: '2026-07-15', notes: 'Treated exterior perimeter.' }],
    propertyProfile: { accessNotes: 'gate code [redacted]', pets: 'One dog, friendly' },
    flags: [{ type: 'sensitivity', severity: 'medium', detail: 'Sensitive to pyrethroids' }],
    recentCalls: [{ summary: 'Asked about ants in garage', direction: 'inbound', date: '2026-08-01' }],
    recentInteractions: [],
    pendingEstimate: null,
  });
});

afterEach(() => {
  delete process.env.GATE_PREVISIT_BRIEF;
});

// The redacted grounding facts for svc-1 (grounding.llmFacts), JSON
// round-tripped. They no longer go to a model (the rewrite was removed,
// owner 2026-10-03) but they still feed the template and the grounding hash.
async function groundedFacts() {
  const db = require('../models/db');
  const svc = await db('scheduled_services').where({ 'scheduled_services.id': 'svc-1' }).first();
  const grounding = await PrevisitBrief._test.assembleGrounding(svc, db);
  return JSON.parse(JSON.stringify(grounding.llmFacts));
}

function storedBrief(state) {
  const patches = state.updates.scheduled_services || [];
  expect(patches.length).toBeGreaterThan(0);
  const patch = patches[patches.length - 1];
  return { patch, brief: JSON.parse(patch.pre_service_brief) };
}

describe('gate off = bit-for-bit no-op', () => {
  test('generateVisitBrief does nothing dark', async () => {
    process.env.GATE_PREVISIT_BRIEF = 'false';
    const state = useDb(baseResponses());
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out).toEqual({ skipped: true, reason: 'gate_off' });
    expect(Object.keys(state.calls)).toHaveLength(0);
    expect(global.__dispatch).not.toHaveBeenCalled();
  });

  test('runSweep does nothing dark (unset gate too)', async () => {
    delete process.env.GATE_PREVISIT_BRIEF;
    const state = useDb(baseResponses());
    const out = await PrevisitBrief.runSweep();
    expect(out).toEqual({ skipped: true, reason: 'gate_off' });
    expect(Object.keys(state.calls)).toHaveLength(0);
  });
});

describe('no model call: every brief is the template (owner 2026-10-03)', () => {
  test('template body stored, no provider call, stamped gate_off', async () => {
    const state = useDb(baseResponses());
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    expect(out.via).toBe('template');
    expect(global.__dispatch).not.toHaveBeenCalled();
    const { brief } = storedBrief(state);
    expect(brief.generated_via).toBe('template');
    expect(brief.llm_miss_kind).toBe('gate_off');
    expect(brief.llm_attempts).toBe(0);
  });

  test('the removed gate cannot turn the rewrite back on', async () => {
    process.env.GATE_PREVISIT_BRIEF_LLM = 'true';
    try {
      const state = useDb(baseResponses());
      const out = await PrevisitBrief.generateVisitBrief('svc-1');
      expect(out.via).toBe('template');
      expect(global.__dispatch).not.toHaveBeenCalled();
      expect(storedBrief(state).brief.generated_via).toBe('template');
    } finally {
      delete process.env.GATE_PREVISIT_BRIEF_LLM;
    }
  });

  test('a stored gate_off template with the same grounding is a cache hit: no write', async () => {
    const state1 = useDb(baseResponses());
    await PrevisitBrief.generateVisitBrief('svc-1');
    const stored = storedBrief(state1).patch;
    const state2 = useDb(baseResponses({
      scheduled_services: [{ ...SVC, ...stored, pre_service_brief_generated_at: new Date('2026-08-13T09:19:00Z') }],
    }));
    const second = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(second).toMatchObject({ skipped: true, reason: 'unchanged' });
    expect(state2.updates.scheduled_services || []).toEqual([]);
  });

  test.each([
    ['a stored model rewrite', { generated_via: 'llm', llm_miss_kind: undefined }],
    ['a template stuck on a validator rejection', { generated_via: 'template', llm_miss_kind: 'validator', llm_attempts: 2 }],
    ['a template stuck on a transient miss', { generated_via: 'template', llm_miss_kind: 'transient', llm_attempts: 0 }],
  ])('%s with the same grounding is replaced with a gate_off template', async (_label, overrides) => {
    const state1 = useDb(baseResponses());
    await PrevisitBrief.generateVisitBrief('svc-1');
    const stored = storedBrief(state1);
    const older = { ...stored.brief, ...overrides };
    const state2 = useDb(baseResponses({
      scheduled_services: [{
        ...SVC,
        pre_service_brief: JSON.stringify(older),
        pre_service_brief_type: stored.patch.pre_service_brief_type,
        pre_service_brief_generated_at: new Date('2026-08-13T09:19:00Z'),
      }],
    }));
    const second = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(second.generated).toBe(true);
    expect(global.__dispatch).not.toHaveBeenCalled();
    const { brief } = storedBrief(state2);
    expect(brief).toMatchObject({ generated_via: 'template', llm_miss_kind: 'gate_off', llm_attempts: 0 });
  });
});

describe('WDO precedence', () => {
  test('a stored WDO brief is never overwritten', async () => {
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, pre_service_brief: '{"risk_score":"High"}', pre_service_brief_type: 'wdo_inspection' }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out).toEqual({ skipped: true, reason: 'wdo_brief_present' });
    expect(state.updates.scheduled_services).toBeUndefined();
    expect(global.__dispatch).not.toHaveBeenCalled();
  });

  test('a WDO-classified visit is skipped even without a stored brief', async () => {
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'WDO Inspection' }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out).toEqual({ skipped: true, reason: 'wdo_visit' });
    expect(state.updates.scheduled_services).toBeUndefined();
  });

  test('the UPDATE itself carries the not-WDO guard (race window)', async () => {
    const state = useDb(baseResponses());
    await PrevisitBrief.generateVisitBrief('svc-1');
    const updateRec = (state.calls.scheduled_services || []).find((rec) => rec.ops.some(([m]) => m === 'update'));
    const guardOps = updateRec.ops.filter(([m]) => m === 'whereNull' || m === 'orWhereNot');
    expect(guardOps.map(([m]) => m)).toEqual(expect.arrayContaining(['whereNull', 'orWhereNot']));
    expect(guardOps.find(([m]) => m === 'orWhereNot')[1]).toEqual(['pre_service_brief_type', 'wdo_inspection']);
  });
});

describe('access codes', () => {
  test('present in the stored access block, absent from the grounding facts', async () => {
    const state = useDb(baseResponses());
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);

    // The grounding facts carry NO code values.
    const payload = JSON.stringify(await groundedFacts());
    expect(payload).not.toContain('4545');
    expect(payload).not.toContain('9876');

    // Stored brief carries them deterministically.
    const { patch, brief } = storedBrief(state);
    expect(patch.pre_service_brief_type).toBe('visit_brief_v1');
    expect(patch.pre_service_brief_generated_at).toBeInstanceOf(Date);
    expect(brief.access.codes.propertyGate).toBe('4545');
    expect(brief.access.codes.garage).toBe('9876');
    expect(brief.access.chemicalSensitivities).toBe('Sensitive to pyrethroids');
    expect(brief.access.pets).toBe('One dog, friendly');
    expect(brief.access.alerts).toEqual(expect.arrayContaining([
      { type: 'gate', text: 'Yard: 4545' },
      { type: 'gate', text: 'Garage: 9876' },
    ]));
  });
});

describe('history outage — generation aborts, cached brief survives', () => {
  test('a service_records failure aborts the write instead of erasing guidance', async () => {
    const state = useDb(baseResponses({
      service_records: () => { throw new Error('history db down'); },
    }));
    // Unreadable history must NOT hash into a brief with last-visit and
    // product guidance erased (and can never manufacture a first-visit
    // claim) — the visit throws, runSweep counts it failed, and the
    // previously stored brief stays untouched.
    await expect(PrevisitBrief.generateVisitBrief('svc-1'))
      .rejects.toThrow(/service history unreadable/);
    expect(global.__dispatch).not.toHaveBeenCalled();
    expect(state.updates.scheduled_services || []).toEqual([]);
  });

  test('genuinely-empty history (readable) still claims new customer', async () => {
    const state = useDb(baseResponses({ service_records: [] }));
    await PrevisitBrief.generateVisitBrief('svc-1');
    const facts = await groundedFacts();
    expect(facts.history).toEqual({ available: true });
    expect(facts.visit.newCustomer).toBe(true);
    const { brief } = storedBrief(state);
    expect(brief.access.alerts.map((a) => a.type)).toContain('new_customer');
  });

  test('visit.oneTime is present only when the whole recurring-lineage trio is clear', async () => {
    const factsFor = async (svc) => {
      global.__dispatch.mockClear();
      useDb(baseResponses({ scheduled_services: [{ ...SVC, ...svc }] }));
      await PrevisitBrief.generateVisitBrief('svc-1');
      return groundedFacts();
    };
    expect((await factsFor({ is_recurring: false, recurring_parent_id: null, recurring_pattern: null })).visit.oneTime).toBe(true);
    // A series booster: is_recurring false WITH a parent id.
    expect((await factsFor({ is_recurring: false, recurring_parent_id: 'parent-1', recurring_pattern: null })).visit.oneTime).toBeUndefined();
    // A legacy top-level series row: pattern alone marks recurrence.
    expect((await factsFor({ is_recurring: false, recurring_parent_id: null, recurring_pattern: 'quarterly' })).visit.oneTime).toBeUndefined();
    expect((await factsFor({ is_recurring: true })).visit.oneTime).toBeUndefined();
    // A free re-service callback: no lineage markers, but a plan visit.
    expect((await factsFor({ is_recurring: false, recurring_parent_id: null, recurring_pattern: null, is_callback: true })).visit.oneTime).toBeUndefined();
  });
});

describe('serviceHistory is line-scoped from the paged walk', () => {
  // The aggregator's serviceHistory is CROSS-LINE and capped to the newest
  // visits — building the section from it (post-cap filter) both leaked
  // other lines' work and, for a multi-line customer whose newest visits
  // are all other lines, silently EMPTIED the section (codex P2). The
  // section now comes from loadRecentLineServices' same-line walk, with
  // notes through the reviewed customer-safe parse.
  test('a pest brief never summarizes lawn work, and same-line notes survive newer other-line visits', async () => {
    mockGetContext.mockResolvedValue({
      // Aggregator history: the newest visits are ALL other-line — under
      // the old post-cap filter this emptied the pest section entirely.
      serviceHistory: [
        { type: 'Lawn Care Service', date: '2026-08-05', notes: 'Applied pre-emergent to turf.' },
        { type: 'Termite Monitoring', date: '2026-06-01', notes: 'Checked bait stations.' },
      ],
      propertyProfile: null,
      flags: [],
      recentCalls: [],
      recentInteractions: [],
      pendingEstimate: null,
    });
    useDb(baseResponses({
      service_records: [
        { id: 'rec-lawn-new', customer_id: 'cust-1', service_type: 'Lawn Care Service', service_line: 'lawn', service_date: '2026-08-05', started_at: null, pressure_index: null },
        {
          ...SERVICE_RECORD,
          technician_notes: 'WHAT WE DID\n\nTreated exterior perimeter.\n\nWHAT WE FOUND\n\nActivity limited to the garage corner.',
        },
      ],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const facts = await groundedFacts();
    expect(facts.serviceHistory).toEqual([
      { type: 'Pest Control Service', date: '2026-07-15', notes: 'Treated exterior perimeter. Activity limited to the garage corner.' },
    ]);
    expect(JSON.stringify(facts)).not.toContain('pre-emergent');
    expect(JSON.stringify(facts)).not.toContain('bait stations');
  });

  test('raw internal notes (unparseable shape) render as null, never raw text', async () => {
    mockGetContext.mockResolvedValue({
      serviceHistory: [],
      propertyProfile: null,
      flags: [],
      recentCalls: [],
      recentInteractions: [],
      pendingEstimate: null,
    });
    useDb(baseResponses({
      service_records: [{ ...SERVICE_RECORD, technician_notes: 'gate code 4482, invoice unpaid — chase office' }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const facts = await groundedFacts();
    expect(facts.serviceHistory).toEqual([
      { type: 'Pest Control Service', date: '2026-07-15', notes: null },
    ]);
    expect(JSON.stringify(facts)).not.toContain('4482');
  });
});

describe('service-preference opt-outs in grounding', () => {
  test('non-secret opt-out flags reach llmFacts from the CUSTOMER row', async () => {
    useDb(baseResponses({
      // customers.service_preferences is the source of truth (estimate
      // acceptance writes there); scheduled_services has no such column.
      customers: [{ id: 'cust-1', first_name: 'Test', last_name: 'Fixture', service_preferences: { interior_spray: false, exterior_sweep: true } }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    expect(out.via).toBe('template');
    const facts = await groundedFacts();
    expect(facts.servicePreferences).toEqual({ interiorSpray: false, exteriorSweep: true });
  });

  test('the deterministic EXTERIOR ONLY alert fires from the customer-row preferences', async () => {
    const state = useDb(baseResponses({
      customers: [{ id: 'cust-1', first_name: 'Test', last_name: 'Fixture', service_preferences: JSON.stringify({ interior_spray: false }) }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const { brief } = storedBrief(state);
    expect(brief.access.alerts.some((a) => a.type === 'service_pref' && /EXTERIOR ONLY/.test(a.text))).toBe(true);
  });
});

describe('combined visits (completion-profile companions)', () => {
  test('a companion line gets its own line-scoped guidance block (hashed + stored)', async () => {
    // "Pest & Rodent Control" — ONE appointment, pest primary + rodent
    // bait companion (docs/design/combined-service-completions.md). The
    // companion's guidance must ride the brief instead of being dropped
    // by the single-category branch.
    mockResolveProfile.mockResolvedValue({ companions: [{ type: 'rodent_bait_station', delivery: 'internal_only' }] });
    const RODENT_RECORD = { id: 'rec-rb', customer_id: 'cust-1', service_type: 'Rodent Bait Station Check', service_line: 'rodent', service_date: '2026-07-20', started_at: null, pressure_index: null };
    const RODENT_PRODUCT = {
      ...PRODUCT_ROW,
      service_record_id: 'rec-rb',
      product_name: 'ContraPest',
      catalog_name: 'ContraPest',
      active_ingredient: 'Triptolide',
      catalog_active_ingredient: 'Triptolide',
      targets: ['rodents'],
    };
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Pest & Rodent Control' }],
      service_records: [SERVICE_RECORD, RODENT_RECORD],
      // Honor the whereIn — the primary and companion walks must not
      // leak each other's product rows through the mock.
      service_products: (rec) => {
        const whereIn = rec.ops.find(([m, a]) => m === 'whereIn' && a[0] === 'sp.service_record_id');
        const ids = whereIn ? whereIn[1][1] : [];
        return [PRODUCT_ROW, RODENT_PRODUCT].filter((p) => ids.includes(p.service_record_id));
      },
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const facts = await groundedFacts();
    expect(facts.productGuidance.companions).toEqual([
      { line: 'rodent', source: 'service_history', productNames: ['ContraPest'] },
    ]);
    // Primary guidance unchanged — the pest line's own history.
    expect(facts.productGuidance.productNames).toEqual(['Bifen IT']);
    const stored = JSON.parse(state.updates.scheduled_services.at(-1).pre_service_brief);
    expect(stored.product_guidance.companions[0].line).toBe('rodent');
    expect(stored.product_guidance.companions[0].products[0].name).toBe('ContraPest');
  });

  test('a companion-profile resolution outage aborts generation (strict — never hashes an empty companion list)', async () => {
    mockResolveProfile.mockRejectedValue(new Error('profiles schema probe down'));
    const state = useDb(baseResponses());
    await expect(PrevisitBrief.generateVisitBrief('svc-1')).rejects.toThrow('profiles schema probe down');
    expect(state.updates.scheduled_services || []).toHaveLength(0);
    // The caller must ask for strict resolution — the resolver's default
    // swallows the probe failure into companions: [].
    expect(mockResolveProfile).toHaveBeenCalledWith(expect.anything(), expect.anything(), { strict: true });
  });

  test('a companion on the visit\'s own line adds no duplicate block', async () => {
    mockResolveProfile.mockResolvedValue({ companions: [{ type: 'rodent_bait_station', delivery: 'internal_only' }] });
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Rodent Control' }],
      service_records: [{ ...SERVICE_RECORD, service_type: 'Rodent Control', service_line: 'rodent' }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const facts = await groundedFacts();
    expect(facts.productGuidance.companions).toBeUndefined();
    expect(state.updates.scheduled_services.length).toBeGreaterThan(0);
  });
});

describe('briefClearOnReclassification (update-details service switch)', () => {
  const { briefClearOnReclassification } = PrevisitBrief;
  const CLEAR = {
    pre_service_brief: null,
    pre_service_brief_type: null,
    pre_service_brief_generated_at: null,
  };

  test('WDO→non-WDO switch clears the stored WDO brief (was stranded: WDO regen branch + overwrite refusal)', () => {
    expect(briefClearOnReclassification('pest_general', 'wdo_inspection')).toEqual(CLEAR);
  });

  test('non-WDO→WDO switch clears the stored visit brief', () => {
    expect(briefClearOnReclassification('wdo_inspection', 'visit_brief_v1')).toEqual(CLEAR);
  });

  test('briefStaleReason: ET calendar day incl. the UTC-midnight DATE shape, service identity, fail-closed stamps', () => {
    const { briefStaleReason } = PrevisitBrief;
    const stamped = { for_date: '2026-08-13', for_service: 'Pest Control Service' };
    expect(briefStaleReason(stamped, { scheduled_date: '2026-08-13', service_type: 'Pest Control Service' })).toBeNull();
    // node-postgres materializes DATE columns as UTC-midnight Dates.
    expect(briefStaleReason(stamped, { scheduled_date: new Date('2026-08-13T00:00:00Z'), service_type: 'Pest Control Service' })).toBeNull();
    expect(briefStaleReason(stamped, { scheduled_date: '2026-08-15', service_type: 'Pest Control Service' })).toBe('date_moved');
    // Direct service_type writers (estimate acceptance, call flows) never
    // pass through update-details' clearing — the read must fail closed.
    expect(briefStaleReason(stamped, { scheduled_date: '2026-08-13', service_type: 'Lawn Care Service' })).toBe('service_changed');
    // Suffix-only label edit (same service): must stay servable — the
    // stamp shares the hashed grounding fact's derivation, so a raw
    // comparison would withdraw the brief forever while the sweep's
    // unchanged-hash cache branch never restamps it.
    expect(briefStaleReason(stamped, { scheduled_date: '2026-08-13', service_type: 'Pest Control Service - 30 min' })).toBeNull();
    // Specialty rewrite that normalizeServiceType would COLLAPSE
    // ("Tree & Shrub Fertilization" and "Lawn Fertilization" both map to
    // "Lawn Fertilization"): the suffix-stripped identity keeps them
    // distinct, so the switch withdraws the brief.
    const treeStamp = { for_date: '2026-08-13', for_service: 'Tree & Shrub Fertilization' };
    expect(briefStaleReason(treeStamp, { scheduled_date: '2026-08-13', service_type: 'Tree & Shrub Fertilization - 1 hour' })).toBeNull();
    expect(briefStaleReason(treeStamp, { scheduled_date: '2026-08-13', service_type: 'Lawn Fertilization' })).toBe('service_changed');
    expect(briefStaleReason({ priorities: [] }, { scheduled_date: '2026-08-13', service_type: 'Pest Control Service' })).toBe('date_moved');
    expect(briefStaleReason({ for_date: '2026-08-13' }, { scheduled_date: '2026-08-13', service_type: 'Pest Control Service' })).toBe('service_changed');
    expect(briefStaleReason(null, { scheduled_date: '2026-08-13', service_type: 'Pest Control Service' })).toBe('date_moved');
  });

  test('ANY service change clears a generic visit brief (guidance is service-scoped)', () => {
    // e.g. pest → lawn: history products must not survive as guidance for
    // a lawn visit (protocol-window authority) — the stale row would stay
    // servable until a later sweep tick, or past 19:49, all night. The
    // caller only invokes this on an ACTUAL service_type change.
    expect(briefClearOnReclassification('pest_general', 'visit_brief_v1')).toEqual(CLEAR);
  });

  test('WDO-to-WDO relabels and briefless/legacy rows keep the stored state', () => {
    expect(briefClearOnReclassification('wdo_inspection', 'wdo_inspection')).toBeNull();
    expect(briefClearOnReclassification('pest_general', null)).toBeNull();
    expect(briefClearOnReclassification('pest_general', undefined)).toBeNull();
    // Untyped/legacy brief — not this lane's write, left alone.
    expect(briefClearOnReclassification('pest_general', 'legacy_note')).toBeNull();
  });
});

describe('LLM-boundary redaction of free text', () => {
  test('codes in flag details and call summaries are masked in the grounding facts, not in the access block', async () => {
    mockGetContext.mockResolvedValue({
      serviceHistory: [],
      propertyProfile: null,
      flags: [{ type: 'pet_alert', severity: 'info', detail: 'Dog in yard, gate code 2468 to enter' }],
      recentCalls: [{ summary: 'Customer said the garage code is 1357', direction: 'inbound', date: '2026-08-01T15:00:00Z' }],
      recentInteractions: [],
      pendingEstimate: null,
    });
    const state = useDb(baseResponses());
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);

    const payload = JSON.stringify(await groundedFacts());
    expect(payload).not.toContain('2468');
    expect(payload).not.toContain('1357');
    expect(payload).toContain('[redacted]');

    // The deterministic stored access block keeps the real codes.
    const { brief } = storedBrief(state);
    expect(brief.access.codes.propertyGate).toBe('4545');
    expect(brief.access.codes.garage).toBe('9876');
  });
});

describe('ET calendar-day labeling (UTC host)', () => {
  test('pg DATE values keep their calendar day; late-ET timestamps do not roll to the next day', async () => {
    mockGetContext.mockResolvedValue({
      serviceHistory: [],
      propertyProfile: null,
      flags: [],
      // 2026-08-14T01:30Z is 2026-08-13 9:30pm ET — must label as 08-13.
      recentCalls: [{ summary: 'Evening call about ants', direction: 'inbound', date: new Date('2026-08-14T01:30:00Z') }],
      recentInteractions: [],
      pendingEstimate: null,
    });
    const state = useDb(baseResponses({
      // pg DATE columns materialize as UTC-midnight Dates on a UTC box.
      scheduled_services: [{ ...SVC, scheduled_date: new Date('2026-08-13T00:00:00Z') }],
      service_records: [{ ...SERVICE_RECORD, service_date: new Date('2026-07-15T00:00:00Z') }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);

    const { brief } = storedBrief(state);
    expect(brief.last_visit.date).toBe('2026-07-15');

    const facts = await groundedFacts();
    expect(facts.visit.scheduledDate).toBe('2026-08-13');
    expect(facts.lastVisit.date).toBe('2026-07-15');
    expect(facts.recentCalls[0].date).toBe('2026-08-13');
  });
});

describe('input-hash cache', () => {
  test('unchanged grounding no-ops regeneration', async () => {
    const state1 = useDb(baseResponses());
    const first = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(first.generated).toBe(true);
    const stored = storedBrief(state1).patch;

    const state2 = useDb(baseResponses({
      scheduled_services: [{
        ...SVC,
        pre_service_brief: stored.pre_service_brief,
        pre_service_brief_type: stored.pre_service_brief_type,
      }],
    }));
    global.__dispatch.mockClear();
    const second = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('unchanged');
    expect(state2.updates.scheduled_services).toBeUndefined();
    expect(global.__dispatch).not.toHaveBeenCalled();
  });

  test('changed grounding regenerates', async () => {
    const state1 = useDb(baseResponses());
    await PrevisitBrief.generateVisitBrief('svc-1');
    const stored = storedBrief(state1).patch;

    const state2 = useDb(baseResponses({
      property_preferences: [{ ...PREFS, property_gate_code: '1111' }],
      scheduled_services: [{
        ...SVC,
        pre_service_brief: stored.pre_service_brief,
        pre_service_brief_type: stored.pre_service_brief_type,
      }],
    }));
    const second = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(second.generated).toBe(true);
    expect(storedBrief(state2).brief.access.codes.propertyGate).toBe('1111');
  });

  test('a recent-calls lookup OUTAGE aborts generation (sentinel)', async () => {
    // sourceHealth 'unavailable' = the aggregator's calls query FAILED —
    // hashing "no calls" would overwrite a valid cached brief.
    mockGetContext.mockResolvedValue({
      serviceHistory: [{ type: 'Pest Control Service', date: '2026-07-15', notes: 'Treated exterior perimeter.' }],
      propertyProfile: {},
      flags: [],
      recentCalls: [],
      recentInteractions: [],
      pendingEstimate: null,
      sourceHealth: { recentCalls: 'unavailable' },
    });
    const state = useDb(baseResponses());
    await expect(PrevisitBrief.generateVisitBrief('svc-1'))
      .rejects.toThrow(/recent-calls lookup unavailable/);
    expect(state.updates.scheduled_services).toBeUndefined();
  });

  test('a legitimately emptied section regenerates (resolved flag)', async () => {
    const state1 = useDb(baseResponses());
    await PrevisitBrief.generateVisitBrief('svc-1');
    const stored = storedBrief(state1).patch;

    // The flag resolved during the day — a SUCCESSFUL empty read is
    // truth and must refresh the cached brief, never read as an outage.
    mockGetContext.mockResolvedValue({
      serviceHistory: [{ type: 'Pest Control Service', date: '2026-07-15', notes: 'Treated exterior perimeter.' }],
      propertyProfile: { accessNotes: 'gate code [redacted]', pets: 'One dog, friendly' },
      flags: [],
      recentCalls: [{ summary: 'Asked about ants in garage', direction: 'inbound', date: '2026-08-01' }],
      recentInteractions: [],
      pendingEstimate: null,
      sourceHealth: { recentCalls: 'ok' },
    });
    const state2 = useDb(baseResponses({
      scheduled_services: [{
        ...SVC,
        pre_service_brief: stored.pre_service_brief,
        pre_service_brief_type: stored.pre_service_brief_type,
      }],
    }));
    const second = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(second.generated).toBe(true);
    expect(storedBrief(state2)).toBeTruthy();
  });
});

describe('lawn bounded product section', () => {
  test('lawn visits list ONLY the protocol window products', async () => {
    mockSummarize.mockReturnValue({
      window: { key: 'aug', month: 8, title: 'August window', visitType: 'granular', goal: 'Summer stress' },
      products: [
        { productName: 'Prodiamine 65 WDG', role: 'pre_emergent', applicationMode: 'spray', ratePer1000: 0.185, rateUnit: 'oz', defaultInPlan: true },
        { productName: '0-0-7 Fert', role: 'fertility', applicationMode: 'granular', ratePer1000: 3, rateUnit: 'lb', defaultInPlan: true },
      ],
    });
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service' }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const { brief } = storedBrief(state);
    expect(brief.product_guidance.source).toBe('lawn_protocol_window');
    expect(brief.product_guidance.products.map((p) => p.name)).toEqual(['Prodiamine 65 WDG', '0-0-7 Fert']);
    // The history product must NOT leak into the guidance list.
    expect(JSON.stringify(brief.product_guidance)).not.toContain('Bifen IT');
    expect(mockWindowContext).toHaveBeenCalled();
    // Track came from the customer's profile, never a default.
    expect(mockWindowContext.mock.calls[0][1].grassTrack).toBe('st_augustine');
  });

  describe('the city hold on the lawn brief (North Port Nutra-TECH, June to September)', () => {
    const NUTRA = 'LESCO Nutra-TECH T&O Micronutrient Package';
    const june = () => mockSummarize.mockReturnValue({
      window: { key: 'jun', month: 6, title: 'June Nutra-TECH + Pre-Emergent', visitType: 'hose', goal: 'Micronutrients and pre-emergent' },
      products: [
        { productName: NUTRA, productId: 'nt', role: 'micronutrients', applicationMode: 'broadcast', ratePer1000: 12, rateUnit: 'fl oz', defaultInPlan: true, gates: { requiresZeroNP: true, northPortProductWindow: true } },
        { productName: 'Dimension 2EW', productId: 'dim', role: 'pre_emergent', applicationMode: 'broadcast', ratePer1000: 0.5, rateUnit: 'fl oz', defaultInPlan: true, gates: {} },
      ],
    });
    const briefFor = async (extra) => {
      june();
      const state = useDb(baseResponses({ scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service', ...extra }] }));
      expect((await PrevisitBrief.generateVisitBrief('svc-1')).generated).toBe(true);
      return storedBrief(state).brief.product_guidance;
    };

    test('North Port: the product is a hold with the plan\'s text and no dose, not a conditional product', async () => {
      const guidance = await briefFor({ service_address_city: 'North Port' });
      expect(guidance.products.map((p) => p.name)).toEqual(['Dimension 2EW']);
      expect(guidance.conditional_products.map((p) => p.name)).toEqual([]);
      expect(guidance.held_products).toHaveLength(1);
      expect(guidance.held_products[0]).toMatchObject({ name: NUTRA, hold: true });
      expect(guidance.held_products[0].message).toBe(`${NUTRA}: North Port holds this product from June to September until the city confirms. The plan holds it back; do not apply it at this visit.`);
      expect(JSON.stringify(guidance.held_products)).not.toMatch(/ratePer1000|rateUnit|12/);
    });

    test('another city: the product is guidance as before (conditional, with its rate) and nothing is held', async () => {
      const guidance = await briefFor({ service_address_city: 'Sarasota' });
      expect(guidance.held_products).toEqual([]);
      expect(guidance.conditional_products.map((p) => [p.name, p.ratePer1000])).toEqual([[NUTRA, 12]]);
      expect(guidance.products.map((p) => p.name)).toEqual(['Dimension 2EW']);
    });
  });

  test('a customer at an application limit demotes the fixed product to conditional (codex P1)', async () => {
    mockSummarize.mockReturnValue({
      window: { key: 'aug', month: 8, title: 'August window', visitType: 'granular', goal: 'Summer stress' },
      products: [
        { productId: 'prod-pro', productName: 'Prodiamine 65 WDG', role: 'pre_emergent', applicationMode: 'spray', ratePer1000: 0.185, rateUnit: 'oz', defaultInPlan: true },
        { productId: 'prod-fert', productName: '0-0-7 Fert', role: 'fertility', applicationMode: 'granular', ratePer1000: 3, rateUnit: 'lb', defaultInPlan: true },
      ],
    });
    mockCheckLimits.mockImplementation(async (_customerId, productId) => (
      productId === 'prod-pro'
        ? { allowed: false, warnings: [], blocks: [{ type: 'annual_max_apps', message: 'Annual max applications reached (2/2)' }] }
        : { allowed: true, warnings: [], blocks: [] }
    ));
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service' }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const { brief } = storedBrief(state);
    // The limited product must NOT present as fixed guidance…
    expect(brief.product_guidance.products.map((p) => p.name)).toEqual(['0-0-7 Fert']);
    // …it demotes to conditional with the violation attached.
    const demoted = brief.product_guidance.conditional_products.find((p) => p.name === 'Prodiamine 65 WDG');
    expect(demoted).toBeTruthy();
    expect(demoted.gates.applicationLimits).toEqual([
      { severity: 'block', type: 'annual_max_apps', message: 'Annual max applications reached (2/2)' },
    ]);
    expect(demoted.trigger).toBe('Annual max applications reached (2/2)');
    expect(mockCheckLimits).toHaveBeenCalledWith('cust-1', 'prod-pro', expect.any(Date), undefined, { propertyId: null, excludeScheduledServiceId: 'svc-1' });
  });

  test('the limit check is scoped to the scheduled visit\'s property and leaves the visit\'s own ledger rows out', async () => {
    mockSummarize.mockReturnValue({
      window: { key: 'oct', month: 10, title: 'October window', visitType: 'granular', goal: 'Fall feeding' },
      products: [
        { productId: 'prod-dim', productName: 'Dimension fixture', role: 'fall_pre_emergent_nutrition', applicationMode: 'granular', ratePer1000: 4.04, rateUnit: 'lb', defaultInPlan: true },
      ],
    });
    mockCheckLimits.mockResolvedValue({ allowed: true, warnings: [], blocks: [] });
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service', property_id: 'prop-A' }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    expect(storedBrief(state)).toBeTruthy();
    expect(mockCheckLimits).toHaveBeenCalledWith('cust-1', 'prod-dim', expect.any(Date), undefined, { propertyId: 'prop-A', excludeScheduledServiceId: 'svc-1' });
  });

  test('a limit-checker outage aborts generation instead of hashing a limit-blind fixed list', async () => {
    mockSummarize.mockReturnValue({
      window: { key: 'aug', month: 8, title: 'August window', visitType: 'granular', goal: 'Summer stress' },
      products: [
        { productId: 'prod-pro', productName: 'Prodiamine 65 WDG', role: 'pre_emergent', applicationMode: 'spray', ratePer1000: 0.185, rateUnit: 'oz', defaultInPlan: true },
      ],
    });
    mockCheckLimits.mockRejectedValue(new Error('limits db down'));
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service' }],
    }));
    await expect(PrevisitBrief.generateVisitBrief('svc-1')).rejects.toThrow('limits db down');
    expect(state.updates.scheduled_services || []).toHaveLength(0);
  });

  test('a protocol-wide gate demotes every product to conditional (fail closed)', async () => {
    mockSummarize.mockReturnValue({
      window: { key: 'aug', month: 8, title: 'August window', visitType: 'granular', goal: 'Summer stress' },
      products: [
        { productName: 'Prodiamine 65 WDG', role: 'pre_emergent', applicationMode: 'spray', ratePer1000: 0.185, rateUnit: 'oz', defaultInPlan: true },
      ],
      gates: [
        { key: 'valid_calibration_required', type: 'equipment', severity: 'blocking', title: 'Calibration current', ruleText: 'Spreader calibration must be within 30 days.' },
      ],
    });
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service' }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const { brief } = storedBrief(state);
    // A blocked product must never present as the fixed list — it ships
    // conditional, with the protocol gates attached for the tech.
    expect(brief.product_guidance.products).toEqual([]);
    expect(brief.product_guidance.conditional_products.map((p) => p.name)).toEqual(['Prodiamine 65 WDG']);
    expect(brief.product_guidance.protocol_gates.map((g) => g.key)).toEqual(['valid_calibration_required']);
  });

  test('unknown grass track (no assignment) fails CLOSED — no guessed window', async () => {
    mockGrassContext.mockResolvedValue({ trackKey: null });
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service' }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const { brief } = storedBrief(state);
    expect(brief.product_guidance.available).toBe(false);
    expect(brief.product_guidance.reason).toBe('unknown_grass_track');
    expect(brief.product_guidance.products).toEqual([]);
    expect(brief.product_guidance.conditional_products).toEqual([]);
    expect(mockWindowContext).not.toHaveBeenCalled();
  });

  // GATE_LAWN_V13 has no bahia program: bahia in ANY recorded profile field leaves the lawn with no
  // track, whichever other track the other field names, so the brief never serves another grass's window.
  test.each([
    [{ grass_type: 'bahia', track_key: 'st_augustine' }],
    [{ grass_type: 'st_augustine', track_key: 'bahia' }],
    [{ grass_type: 'bahia', track_key: null }],
  ])('GATE_LAWN_V13: profile %j fails closed with no guessed window', async (profile) => {
    process.env.GATE_LAWN_V13 = 'true';
    try {
      mockGrassContext.mockImplementation((...args) => jest.requireActual('../services/lawn-grass-context').loadCustomerGrassContext(...args));
      const state = useDb(baseResponses({
        scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service' }],
        customer_turf_profiles: [{ customer_id: 'cust-1', active: true, ...profile }],
      }));
      const out = await PrevisitBrief.generateVisitBrief('svc-1');
      expect(out.generated).toBe(true);
      const { brief } = storedBrief(state);
      expect(brief.product_guidance.available).toBe(false);
      expect(brief.product_guidance.reason).toBe('lawn_v13_bahia_no_program');
      expect(mockWindowContext).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_LAWN_V13;
    }
  });

  // A visit assigned a protocol window keeps that window ONLY for a lawn that has a program: a bahia
  // lawn under v13 gets no guidance from another grass's pinned assignment.
  describe('GATE_LAWN_V13 with a pinned assignment', () => {
    const PINNED = {
      ...SVC, service_type: 'Lawn Care Service',
      lawn_protocol_window_key: 'jun_blackout_stress', lawn_protocol_key: 'sa_swfl', lawn_protocol_version: 3,
    };
    const WINDOW = {
      window: { key: 'jun_blackout_stress', month: 6, title: 'Blackout stress', visitType: 'spray', goal: 'Survive blackout' },
      products: [{ productName: 'Fe/Mn Micros', role: 'micronutrients', applicationMode: 'spray', ratePer1000: null, rateUnit: 'label_rate', defaultInPlan: true, gates: {} }],
    };
    beforeEach(() => {
      process.env.GATE_LAWN_V13 = 'true';
      mockGrassContext.mockImplementation((...args) => jest.requireActual('../services/lawn-grass-context').loadCustomerGrassContext(...args));
      mockSummarize.mockReturnValue(WINDOW);
    });
    afterEach(() => { delete process.env.GATE_LAWN_V13; });

    test.each([
      [{ grass_type: 'bahia', track_key: null }],
      [{ grass_type: 'bahia', track_key: 'st_augustine' }],
      [{ grass_type: 'st_augustine', track_key: 'bahia' }],
    ])('a bahia lawn (%j) pinned to a St. Augustine protocol shows no guidance', async (profile) => {
      const state = useDb(baseResponses({
        scheduled_services: [PINNED],
        lawn_protocols: [{ id: 'proto-1' }],
        customer_turf_profiles: [{ customer_id: 'cust-1', active: true, ...profile }],
      }));
      await PrevisitBrief.generateVisitBrief('svc-1');
      const { brief } = storedBrief(state);
      expect(brief.product_guidance.available).toBe(false);
      expect(brief.product_guidance.reason).toBe('lawn_v13_bahia_no_program');
      expect(brief.product_guidance.products).toEqual([]);
      expect(mockWindowContext).not.toHaveBeenCalled();
    });

    test('a St. Augustine lawn with the same pinned assignment keeps its window guidance', async () => {
      const state = useDb(baseResponses({
        scheduled_services: [PINNED],
        lawn_protocols: [{ id: 'proto-1' }],
        customer_turf_profiles: [{ customer_id: 'cust-1', active: true, grass_type: 'st_augustine', track_key: 'st_augustine' }],
      }));
      await PrevisitBrief.generateVisitBrief('svc-1');
      const { brief } = storedBrief(state);
      expect(brief.product_guidance.available).toBe(true);
      expect(brief.product_guidance.products.map((p) => p.name)).toEqual(['Fe/Mn Micros']);
      expect(mockWindowContext).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ windowKey: 'jun_blackout_stress', protocolId: 'proto-1' }));
    });

    test('gate off, a bahia lawn keeps its pinned window as before', async () => {
      delete process.env.GATE_LAWN_V13;
      useDb(baseResponses({
        scheduled_services: [PINNED],
        lawn_protocols: [{ id: 'proto-1' }],
        customer_turf_profiles: [{ customer_id: 'cust-1', active: true, grass_type: 'bahia' }],
      }));
      await PrevisitBrief.generateVisitBrief('svc-1');
      expect(mockWindowContext).toHaveBeenCalledTimes(2);
    });
  });

  test('gate off, a conflicting profile keeps the old resolution (the explicit track key)', async () => {
    mockGrassContext.mockImplementation((...args) => jest.requireActual('../services/lawn-grass-context').loadCustomerGrassContext(...args));
    useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service' }],
      customer_turf_profiles: [{ customer_id: 'cust-1', active: true, grass_type: 'bahia', track_key: 'st_augustine' }],
    }));
    await PrevisitBrief.generateVisitBrief('svc-1');
    expect(mockWindowContext).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ grassTrack: 'st_augustine' }));
  });

  test('an assigned protocol window wins over date derivation (unknown track included)', async () => {
    mockGrassContext.mockResolvedValue({ trackKey: null });
    mockSummarize.mockReturnValue({
      window: { key: 'jun_blackout_stress', month: 6, title: 'Blackout stress', visitType: 'spray', goal: 'Survive blackout' },
      products: [
        { productName: 'Fe/Mn Micros', role: 'micronutrients', applicationMode: 'spray', ratePer1000: null, rateUnit: 'label_rate', defaultInPlan: true, gates: {} },
      ],
    });
    const state = useDb(baseResponses({
      scheduled_services: [{
        ...SVC,
        service_type: 'Lawn Care Service',
        lawn_protocol_window_key: 'jun_blackout_stress',
        lawn_protocol_key: 'sa_swfl',
        lawn_protocol_version: 3,
      }],
      lawn_protocols: [{ id: 'proto-1' }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const query = mockWindowContext.mock.calls[0][1];
    expect(query.windowKey).toBe('jun_blackout_stress');
    expect(query.protocolId).toBe('proto-1');
    expect(query.grassTrack).toBeUndefined();
    const { brief } = storedBrief(state);
    expect(brief.product_guidance.assignedWindowKey).toBe('jun_blackout_stress');
    expect(brief.product_guidance.products.map((p) => p.name)).toEqual(['Fe/Mn Micros']);
  });

  test('a staged spot row\'s broadened trigger (20261007182000) reaches the brief whole, under the 120 character cut', async () => {
    const round2 = require('../models/migrations/20261007182000_lawn_v13_matrix_adds_round2');
    mockSummarize.mockReturnValue({
      window: { key: 'oct_v13_spreader_fall', month: 10, title: 'October', visitType: 'granular', goal: 'Fall feeding' },
      products: round2.TRIGGERS.map(([, product, , trigger]) => ({
        productName: product, role: 'fungicide_spot', applicationMode: 'spot', ratePer1000: null, rateUnit: 'label_rate', defaultInPlan: false, gates: { trigger },
      })),
    });
    const state = useDb(baseResponses({ scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service' }] }));
    await PrevisitBrief.generateVisitBrief('svc-1');
    const { brief } = storedBrief(state);
    expect(brief.product_guidance.conditional_products.map((p) => p.trigger)).toEqual(round2.TRIGGERS.map(([, , , trigger]) => trigger));
    expect(brief.product_guidance.conditional_products[0].trigger).toMatch(/fairy_ring_dollar_spot_rust_leaf_spot$/);
  });

  test('conditional/gated products are split out, labeled, and never sent to the LLM as fixed', async () => {
    mockSummarize.mockReturnValue({
      window: { key: 'jun_blackout_stress', month: 6, title: 'Blackout stress', visitType: 'spray', goal: 'Survive blackout' },
      products: [
        { productName: 'Dispatch Sprayable', role: 'wetting_agent', applicationMode: 'spray', ratePer1000: 0.37, rateUnit: 'fl oz', defaultInPlan: true, gates: {} },
        // default_in_plan but GATED — still conditional, full gates kept.
        { productName: 'Fe/Mn Micros', role: 'micronutrients', applicationMode: 'spray', ratePer1000: null, rateUnit: 'label_rate', defaultInPlan: true, gates: { requiresZeroNP: true } },
        { productName: 'Talstar P', role: 'insect_curative', applicationMode: 'spot', ratePer1000: 1.0, rateUnit: 'fl oz', defaultInPlan: false, gates: { trigger: 'confirmed_chinch_pressure', maxTempF: 88 } },
      ],
    });
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Lawn Care Service' }],
    }));
    await PrevisitBrief.generateVisitBrief('svc-1');
    const { brief } = storedBrief(state);
    // Fixed list = default-in-plan AND gate-free only.
    expect(brief.product_guidance.products.map((p) => p.name)).toEqual(['Dispatch Sprayable']);
    // Conditional entries keep the COMPLETE gate object, not just trigger.
    expect(brief.product_guidance.conditional_products).toEqual([
      expect.objectContaining({ name: 'Fe/Mn Micros', conditional: true, gates: { requiresZeroNP: true }, trigger: null }),
      expect.objectContaining({
        name: 'Talstar P',
        conditional: true,
        gates: { trigger: 'confirmed_chinch_pressure', maxTempF: 88 },
        trigger: 'confirmed_chinch_pressure',
      }),
    ]);
    // The LLM's fixed product names exclude every conditional row.
    const llmPayload = JSON.stringify(await groundedFacts());
    expect(llmPayload).toContain('Dispatch Sprayable');
    expect(llmPayload).not.toContain('Fe/Mn Micros');
    expect(llmPayload).not.toContain('Talstar P');
  });

  test('non-lawn visits: history products only, forbidden targets filtered', async () => {
    const state = useDb(baseResponses());
    await PrevisitBrief.generateVisitBrief('svc-1');
    const { brief } = storedBrief(state);
    expect(brief.product_guidance.source).toBe('service_history');
    expect(brief.product_guidance.products.map((p) => p.name)).toEqual(['Bifen IT']);
    // ⛔ Ganoderma never prefilled as a target; known targets survive.
    expect(brief.product_guidance.products[0].targets).toEqual(['ants']);
    expect(brief.last_visit.products[0].targets).toEqual(['ants']);
  });
});

describe('line-scoped product history', () => {
  const LAWN_RECORD = {
    id: 'rec-lawn',
    customer_id: 'cust-1',
    service_type: 'Lawn Care Service',
    service_line: 'lawn',
    service_date: '2026-08-01',
    started_at: null,
    pressure_index: null,
  };
  const LAWN_PRODUCT_ROW = {
    service_record_id: 'rec-lawn',
    product_name: 'Prodiamine 65 WDG',
    active_ingredient: 'Prodiamine',
    moa_group: '3',
    application_rate: 0.3,
    rate_unit: 'oz',
    targets: ['crabgrass'],
    catalog_name: 'Prodiamine 65 WDG',
    catalog_active_ingredient: 'Prodiamine',
    epa_reg_number: '66222-40',
  };

  function whereInAwareProducts(rows) {
    return (rec) => {
      const whereIn = rec.ops.find(([m, args]) => m === 'whereIn' && args[0] === 'sp.service_record_id');
      const ids = whereIn ? whereIn[1][1] : [];
      return rows.filter((r) => ids.includes(r.service_record_id));
    };
  }

  test('a pest visit never surfaces products from lawn records, even newer ones', async () => {
    const state = useDb(baseResponses({
      // Lawn record is NEWER than the pest record.
      service_records: [LAWN_RECORD, SERVICE_RECORD],
      service_products: whereInAwareProducts([LAWN_PRODUCT_ROW, PRODUCT_ROW]),
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const { brief } = storedBrief(state);
    // last_visit = the PEST record, not the newer lawn one.
    expect(brief.last_visit.date).toBe('2026-07-15');
    expect(brief.product_guidance.source).toBe('service_history');
    expect(brief.product_guidance.products.map((p) => p.name)).toEqual(['Bifen IT']);
    expect(JSON.stringify(brief)).not.toContain('Prodiamine');
  });

  test('no same-line history = EMPTY section, never a cross-line fallback', async () => {
    const state = useDb(baseResponses({
      service_records: [LAWN_RECORD],
      service_products: whereInAwareProducts([LAWN_PRODUCT_ROW, PRODUCT_ROW]),
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const { brief } = storedBrief(state);
    expect(brief.last_visit.date).toBeNull();
    expect(brief.last_visit.products).toEqual([]);
    expect(brief.product_guidance.products).toEqual([]);
    expect(JSON.stringify(brief.product_guidance)).not.toContain('Prodiamine');
    // History WAS readable — the lawn record still proves not-new-customer.
    const facts = await groundedFacts();
    expect(facts.history).toEqual({ available: true });
    expect(facts.visit.newCustomer).toBe(false);
    expect(facts.lastVisit).toBeNull();
  });
});

describe('product guidance is ordered by visit recency, not child-row created_at', () => {
  test('an edited old recap (reinserted rows, newest created_at) cannot displace the latest visit\'s products', async () => {
    const NEW_RECORD = { ...SERVICE_RECORD, id: 'rec-new', service_date: '2026-08-01' };
    const FRESH_ROW = { ...PRODUCT_ROW, service_record_id: 'rec-new', product_name: 'Fresh Prod', catalog_name: 'Fresh Prod' };
    const OLD_EDITED_ROW = { ...PRODUCT_ROW, service_record_id: 'rec-1', product_name: 'Old Edited Prod', catalog_name: 'Old Edited Prod' };
    const state = useDb(baseResponses({
      // service_date desc — rec-new is the latest visit.
      service_records: [NEW_RECORD, SERVICE_RECORD],
      // Simulates the DB's created_at DESC answer AFTER the old recap was
      // reopened: pest-recap.js deletes+reinserts its rows, so the OLD
      // record's row carries the newest created_at and comes back first.
      service_products: [OLD_EDITED_ROW, FRESH_ROW],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    const { brief } = storedBrief(state);
    // Visit recency wins: the latest visit's product leads the guidance.
    expect(brief.product_guidance.products.map((p) => p.name)).toEqual(['Fresh Prod', 'Old Edited Prod']);
    // last_visit stays the newest record and lists ITS products only.
    expect(brief.last_visit.date).toBe('2026-08-01');
    expect(brief.last_visit.products.map((p) => p.name)).toEqual(['Fresh Prod']);
  });
});

describe('tree & shrub visits are never lawn', () => {
  test('a Tree & Shrub Fertilization visit gets NO lawn window guidance — line-scoped history only', async () => {
    // normalizeServiceType maps this to "Lawn Fertilization"; category must
    // come from the RAW type or the visit gets turf protocol products.
    const TS_RECORD = {
      id: 'rec-ts',
      customer_id: 'cust-1',
      service_type: 'Tree & Shrub Care',
      service_line: 'tree_shrub',
      service_date: '2026-06-20',
      started_at: null,
      pressure_index: null,
    };
    const TS_PRODUCT_ROW = {
      service_record_id: 'rec-ts',
      product_name: 'Bio-Neem',
      active_ingredient: 'Azadirachtin',
      moa_group: 'UN',
      application_rate: 1,
      rate_unit: 'oz/gal',
      targets: ['scale'],
      catalog_name: 'Bio-Neem',
      catalog_active_ingredient: 'Azadirachtin',
      epa_reg_number: '70051-2',
    };
    const state = useDb(baseResponses({
      scheduled_services: [{ ...SVC, service_type: 'Tree & Shrub Fertilization' }],
      service_records: [SERVICE_RECORD, TS_RECORD],
      service_products: (rec) => {
        const whereIn = rec.ops.find(([m, args]) => m === 'whereIn' && args[0] === 'sp.service_record_id');
        const ids = whereIn ? whereIn[1][1] : [];
        return [TS_PRODUCT_ROW, PRODUCT_ROW].filter((r) => ids.includes(r.service_record_id));
      },
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    // The turf protocol machinery is never consulted.
    expect(mockGrassContext).not.toHaveBeenCalled();
    expect(mockWindowContext).not.toHaveBeenCalled();
    const { brief } = storedBrief(state);
    expect(brief.product_guidance.source).toBe('service_history');
    // Only the tree/shrub line's own history.
    expect(brief.product_guidance.products.map((p) => p.name)).toEqual(['Bio-Neem']);
    expect(brief.last_visit.date).toBe('2026-06-20');
    expect(JSON.stringify(brief)).not.toContain('Bifen IT');
  });
});

describe('sweep', () => {
  test('iterates today, tallies outcomes, one failure never stops the rest', async () => {
    const state = useDb({
      ...baseResponses(),
      // Per-visit routing (not call counting — generation reads the visit
      // row twice now: initial load + the pre-write grounding re-read):
      // svc-1 always resolves, svc-2's reads always fail.
      scheduled_services: (rec) => {
        const isSweepSelect = rec.ops.some(([m]) => m === 'join');
        if (isSweepSelect) return [{ id: 'svc-1' }, { id: 'svc-2' }];
        const whereObj = rec.ops.find(([m, a]) => m === 'where' && a[0] && typeof a[0] === 'object')?.[1][0];
        const id = whereObj?.['scheduled_services.id'] || whereObj?.id;
        if (id === 'svc-2') throw new Error('db down');
        return [{ ...SVC }];
      },
    });
    const out = await PrevisitBrief.runSweep();
    expect(out.considered).toBe(2);
    expect(out.generated).toBe(1);
    expect(out.failed).toBe(1);
    expect(state.updates.scheduled_services).toHaveLength(1);
  });
});
