/**
 * Pre-visit pocket-reference brief (services/previsit-brief.js):
 *  - gate-off = bit-for-bit no-op (no reads, no writes, no LLM)
 *  - a WDO brief is NEVER clobbered (stored type AND classifier guard,
 *    plus the guard riding the UPDATE itself)
 *  - access codes land in the stored brief's deterministic access block
 *    and NEVER appear in the LLM prompt payload
 *  - deterministic template fallback on LLM failure
 *  - input-hash cache: unchanged grounding no-ops regeneration
 *  - lawn visits: product guidance is the protocol window's products ONLY
 *  - forbidden target genera are filtered from deterministic target lists
 */

jest.mock('../models/db', () => {
  const fn = (table) => global.__briefDbMock(table);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/models', () => ({
  TEXT_POLICIES: { visitBrief: { name: 'visitBrief' } },
}));
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

// Priorities are a noun phrase and the summary carries no digits: every
// imperative verb-object is now strictly grounded in instruction fields
// and every digit-run must appear in the grounding, so the CLEAN fixture
// must not depend on words/numbers absent from the minimal groundings.
const CLEAN_LLM_JSON = {
  priorities: ['Ant activity near the garage'],
  mentioned_terms: ['ants'],
  watch_items: ['Chemical-sensitivity note on file'],
  last_visit_summary: 'Routine pest service in July.',
  open_scope: '',
  customer_context: 'Prefers a text before arrival.',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_PREVISIT_BRIEF = 'true';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  global.__dispatch = jest.fn(async () => ({ ok: true, json: { ...CLEAN_LLM_JSON } }));
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
  delete process.env.ANTHROPIC_API_KEY;
});

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
  test('present in the stored access block, absent from the LLM payload', async () => {
    const state = useDb(baseResponses());
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);

    // LLM saw NO code values.
    expect(global.__dispatch).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(global.__dispatch.mock.calls[0]);
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
    const text = global.__dispatch.mock.calls[0][1].text;
    const facts = JSON.parse(text.split('Grounding facts:\n')[1].split('\n\nReturn only')[0]);
    expect(facts.history).toEqual({ available: true });
    expect(facts.visit.newCustomer).toBe(true);
    const { brief } = storedBrief(state);
    expect(brief.access.alerts.map((a) => a.type)).toContain('new_customer');
  });
});

describe('grounded allowlist validation of LLM output', () => {
  const CATALOG = [
    { name: 'Termidor SC', target_pests: ['termites'] },
    { name: 'Bifen IT', target_pests: ['ants', 'chinch bugs'] },
  ];

  test('an invented product name falls back to the deterministic template', async () => {
    global.__dispatch = jest.fn(async () => ({
      ok: true,
      json: { ...CLEAN_LLM_JSON, priorities: ['Apply Termidor SC to the slab edge'] },
    }));
    const state = useDb(baseResponses({ products_catalog: CATALOG }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.via).toBe('template');
    expect(storedBrief(state).brief.generated_via).toBe('template');
  });

  test('an ungrounded pest-target claim falls back to the deterministic template', async () => {
    global.__dispatch = jest.fn(async () => ({
      ok: true,
      json: { ...CLEAN_LLM_JSON, watch_items: ['Watch for termites along the fence line'] },
    }));
    useDb(baseResponses({ products_catalog: CATALOG }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.via).toBe('template');
  });

  test('mentioning a GROUNDED product and target is accepted', async () => {
    global.__dispatch = jest.fn(async () => ({
      ok: true,
      // Bifen IT is in the grounded history product names; "ants" appears
      // in the grounded call summary.
      json: { ...CLEAN_LLM_JSON, priorities: ['Re-check the ants treated with Bifen IT'] },
    }));
    useDb(baseResponses({ products_catalog: CATALOG }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.via).toBe('llm');
  });

  test('an unreadable catalog makes the LLM output unvalidatable — template', async () => {
    useDb(baseResponses({ products_catalog: () => { throw new Error('catalog down'); } }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    expect(out.via).toBe('template');
  });

  test('a WHOLLY NOVEL product name (in no catalog) is rejected — template', async () => {
    global.__dispatch = jest.fn(async () => ({
      ok: true,
      json: { ...CLEAN_LLM_JSON, priorities: ['Apply PhantomGuard X for emerald ash borer'] },
    }));
    const state = useDb(baseResponses({ products_catalog: CATALOG }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.via).toBe('template');
    expect(storedBrief(state).brief.generated_via).toBe('template');
    expect(JSON.stringify(storedBrief(state).brief)).not.toContain('PhantomGuard');
  });

  test('a novel target claim is rejected even when the product is grounded', async () => {
    global.__dispatch = jest.fn(async () => ({
      ok: true,
      // Bifen IT is grounded history; "emerald ash borer" appears nowhere
      // in the facts and matches no catalog term.
      json: { ...CLEAN_LLM_JSON, priorities: ['Spot-treat with Bifen IT for emerald ash borer'] },
    }));
    useDb(baseResponses({ products_catalog: CATALOG }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.via).toBe('template');
  });

  test('novel-reference rejection carries a typed reason (unit)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      // mentioned_terms empty: the model failed to self-report — the prose
      // regexes must still catch the novel references.
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Apply PhantomGuard X for emerald ash borer'] },
      grounding,
    );
    expect(verdict.reason).toMatch(/^ungrounded_novel_(product|target):/);
  });

  test('an all-common-word instruction the grounding never states is rejected (codex P1)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    // "interior" is a reference STOPWORD and "treat" is common prose — the
    // old all-common skip accepted this instruction unvalidated even on an
    // exterior-only visit whose grounding never mentions the interior.
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Treat interior'] },
      grounding,
    );
    expect(verdict.reason).toBe('ungrounded_instruction:interior');
  });

  test('non-treatment imperatives are grounded too — "Inspect interior" rejects on an exterior-only grounding (codex P1)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const directive of ['Inspect interior', 'Check the interior']) {
      const verdict = validateBriefJson(
        { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [directive] },
        grounding,
      );
      expect(verdict.reason).toBe('ungrounded_instruction:interior');
    }
  });

  test('a grounded non-treatment imperative passes', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { flags: [{ detail: 'customer asked for an interior look this visit' }] },
    };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Inspect interior'] },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });

  test('generic business prose self-grounds — no literal grounding demanded (08-15 tuning)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    // Live briefs template-fell ~96% on ordinary vocabulary ("perform",
    // "provide", "availability") the grounding JSON never spells out.
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      {
        ...CLEAN_LLM_JSON,
        mentioned_terms: [],
        priorities: ['Perform a walkthrough and provide an update on arrival'],
      },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });

  test('common-prose target phrases pass the fuzzy tier with stemming (08-15 tuning)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    // "camera" is customer equipment (never common prose) — it grounds here
    // via the flag detail; "monitors" grounds on stemmed common "monitor".
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { flags: [{ detail: 'security camera at the front door' }] },
    };
    const verdict = validateBriefJson(
      {
        ...CLEAN_LLM_JSON,
        mentioned_terms: [],
        priorities: [],
        watch_items: ['Ask about a prior scheduled service', 'Customer monitors camera near the driveway'],
      },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });

  test('ungrounded cadence and acceptance claims reject (codex #3423 r4)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const claim of ['Apply Initial Treatment', 'Apply Recurring Treatment', 'Payment accepted', 'Customer available Monday']) {
      const verdict = validateBriefJson(
        { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [], watch_items: [claim] },
        grounding,
      );
      expect(verdict.reason).toBeTruthy();
    }
  });

  test('ungrounded equipment directives and service-history claims reject (codex #3423 r3)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const claim of ['Check cameras', 'Inspect irrigation', 'Missed application']) {
      const verdict = validateBriefJson(
        { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [], watch_items: [claim] },
        grounding,
      );
      expect(verdict.reason).toBeTruthy();
    }
  });

  test('a GROUNDED tier name in descriptive prose is not product-shaped (08-15 tuning)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      // 'accepted' is grounded-only vocabulary (r4) — grounded here via the
      // estimate status, as real acceptance groundings are.
      llmFacts: {
        membership: { tier: 'Bronze' },
        serviceType: 'Quarterly Pest Control Service',
        openScope: { pendingEstimate: { status: 'accepted' } },
      },
    };
    const verdict = validateBriefJson(
      {
        ...CLEAN_LLM_JSON,
        mentioned_terms: [],
        priorities: [],
        customer_context: 'Accepted Bronze pest control after the visit.',
      },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });

  test('product-shaped common phrases park as products in instructions (codex #3423 r2)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Apply Structural Control along the slab'] },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
    expect(verdict.reason).toMatch(/structural|control/i);
  });

  test('condition-bearing target phrases stay grounded (codex #3423 r2)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [], watch_items: ['Watch for severe regrowth'] },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
    expect(verdict.reason).toMatch(/severe|regrowth/i);
  });

  test('an UNGROUNDED tier claim is an invented account fact — rejected (codex #3423 r1)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      {
        ...CLEAN_LLM_JSON,
        mentioned_terms: [],
        priorities: [],
        customer_context: 'Accepted Bronze pest control after the visit.',
      },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
    expect(verdict.reason).toMatch(/bronze/i);
  });

  test('a tier-named verb object still parks as a product even when the tier is grounded (codex #3423 r1)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { membership: { tier: 'Silver' } },
    };
    const verdict = validateBriefJson(
      {
        ...CLEAN_LLM_JSON,
        mentioned_terms: [],
        priorities: ['Apply Silver Control along the fence'],
      },
      grounding,
    );
    expect(verdict.reason).toMatch(/^ungrounded_novel_product:/);
  });

  test('allowlisted action verbs still ground their objects in instructions (codex #3423 r1)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const instruction of ['Retrieve credentials from the lockbox', 'Vacuum rooms before treating']) {
      const verdict = validateBriefJson(
        { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [instruction] },
        grounding,
      );
      expect(verdict.reason).toBeTruthy();
    }
  });

  test('room instructions violate an interior opt-out like "interior" does (codex #3423 r1)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { servicePreferences: { interiorSpray: false }, notes: 'vacuum rooms weekly' },
    };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Vacuum rooms before treating'] },
      grounding,
    );
    expect(verdict.reason).toBe('ungrounded_preference_conflict:interior');
  });

  test('an ungrounded organism still rejects even inside common prose (08-15 tuning)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      {
        ...CLEAN_LLM_JSON,
        mentioned_terms: [],
        priorities: ['Perform an inspection for chinch bugs'],
      },
      grounding,
    );
    expect(verdict.reason).toMatch(/^ungrounded_novel_target:chinch/);
  });

  test('an invented dollar amount is rejected; a grounded one passes (codex P1)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { openScope: { pendingEstimate: { monthlyTotal: 100 } } },
    };
    const invented = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [], open_scope: '$500 monthly estimate pending' },
      grounding,
    );
    expect(invented.reason).toBe('ungrounded_numeric:500');
    const grounded = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [], open_scope: '$100 monthly estimate pending' },
      grounding,
    );
    expect(grounded.body).toBeTruthy();
    // "$100.00" grounds on the bare 100; "$100.50" must not.
    expect(validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [], open_scope: '$100.00 monthly estimate pending' },
      grounding,
    ).body).toBeTruthy();
    expect(validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [], open_scope: '$100.50 monthly estimate pending' },
      grounding,
    ).reason).toBe('ungrounded_numeric:100.50');
  });

  test('an instruction against a current service opt-out is rejected even when grounded (codex P1)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    // The preference text itself grounds the word "interior" — grounding
    // cannot express negation, so the conflict check must be
    // deterministic off the hashed flag.
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: {
        servicePreferences: { interiorSpray: false },
        flags: [{ detail: 'EXTERIOR ONLY — no interior treatment' }],
      },
    };
    for (const directive of ['Treat interior', 'Inspect inside near the kitchen']) {
      const verdict = validateBriefJson(
        { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [directive] },
        grounding,
      );
      expect(verdict.reason).toBe('ungrounded_preference_conflict:interior');
    }
  });

  test('descriptive prose may still mention the opted-out scope (history is a fact)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: {
        servicePreferences: { interiorSpray: false },
        flags: [{ detail: 'EXTERIOR ONLY — no interior treatment' }],
        recentCalls: ['Asked about ants in garage'],
      },
    };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], last_visit_summary: 'Interior baseboards treated in March.' },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });

  test('a bare short ALLCAPS product token with no verb is rejected (codex P1)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['DDT'] },
      grounding,
    );
    expect(verdict.reason).toBe('ungrounded_novel_product:DDT');
    // Ordinary abbreviation prose and grounded acronyms still pass:
    // "PM" is allowlisted, "IT" grounds on the historical "Bifen IT".
    const ok = validateBriefJson(
      {
        ...CLEAN_LLM_JSON,
        mentioned_terms: ['bifen it'],
        priorities: [],
        last_visit_summary: 'Applied Bifen IT.',
        customer_context: 'Prefers PM arrivals.',
      },
      { catalogVocabulary: { names: [], targets: [] }, llmFacts: { lastVisit: { productNames: ['Bifen IT'] } } },
    );
    expect(ok.body).toBeTruthy();
  });

  test('a short (≤3-letter) ungrounded product in an instruction is rejected, not vacuously grounded', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    // 'ddt' is under every length-gated pass (rare-word scan and catalog
    // vocabulary both start at 4 chars) and under instructedClaimGrounded's
    // significant-word threshold — with the whole-phrase check failed, no
    // remaining words must mean REJECT, not accept.
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Use DDT'] },
      grounding,
    );
    expect(verdict.reason).toBe('ungrounded_instruction:ddt');
  });

  test('the same common-word instruction passes when the grounding states it', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { flags: [{ detail: 'customer asked for interior attention this visit' }] },
    };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Treat interior'] },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });

  test('descriptive fields keep the all-common skip (no over-rejection of prose)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    // 'ants' grounded for CLEAN's fixed priority; the summary's verb-object
    // ("front walk") is all-common prose the grounding never states — the
    // strict instructional check must NOT apply to descriptive fields.
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { recentCalls: ['Asked about ants in garage'] },
    };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], last_visit_summary: 'Treated front walk during the last visit.' },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });

  test('extraction finds mixed-cap, cap-run, verb-object and for-target references', () => {
    const { extractOutputReferences } = PrevisitBrief._test;
    const refs = extractOutputReferences('Apply PhantomGuard X for emerald ash borer. Re-check the ants treated with Bifen IT.');
    expect(refs.products).toEqual(expect.arrayContaining(['phantomguard', 'bifen it']));
    // Application-verb objects surface separately — instruction fields
    // validate them against the fixed visit list.
    expect(refs.instructed).toEqual(expect.arrayContaining(['phantomguard x', 'bifen it']));
    expect(refs.targets).toEqual(expect.arrayContaining(['emerald ash borer']));
    // Date-shaped phrases are not product-shaped.
    expect(extractOutputReferences('Routine pest service on July 15.').products).toEqual([]);
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
    const text = global.__dispatch.mock.calls[0][1].text;
    const facts = JSON.parse(text.split('Grounding facts:\n')[1].split('\n\nReturn only')[0]);
    expect(facts.serviceHistory).toEqual([
      { type: 'Pest Control Service', date: '2026-07-15', notes: 'Treated exterior perimeter. Activity limited to the garage corner.' },
    ]);
    expect(text).not.toContain('pre-emergent');
    expect(text).not.toContain('bait stations');
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
    const text = global.__dispatch.mock.calls[0][1].text;
    const facts = JSON.parse(text.split('Grounding facts:\n')[1].split('\n\nReturn only')[0]);
    expect(facts.serviceHistory).toEqual([
      { type: 'Pest Control Service', date: '2026-07-15', notes: null },
    ]);
    expect(text).not.toContain('4482');
  });
});

describe('service-preference opt-outs in grounding', () => {
  test('non-secret opt-out flags reach llmFacts from the CUSTOMER row and an opted-out instruction falls to the template', async () => {
    global.__dispatch = jest.fn(async () => ({
      ok: true,
      json: { ...CLEAN_LLM_JSON, priorities: ['Treat interior'] },
    }));
    useDb(baseResponses({
      // customers.service_preferences is the source of truth (estimate
      // acceptance writes there); scheduled_services has no such column.
      customers: [{ id: 'cust-1', first_name: 'Test', last_name: 'Fixture', service_preferences: { interior_spray: false, exterior_sweep: true } }],
    }));
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    expect(out.via).toBe('template');
    const text = global.__dispatch.mock.calls[0][1].text;
    const facts = JSON.parse(text.split('Grounding facts:\n')[1].split('\n\nReturn only')[0]);
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
    const text = global.__dispatch.mock.calls[0][1].text;
    const facts = JSON.parse(text.split('Grounding facts:\n')[1].split('\n\nReturn only')[0]);
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
    const text = global.__dispatch.mock.calls[0][1].text;
    const facts = JSON.parse(text.split('Grounding facts:\n')[1].split('\n\nReturn only')[0]);
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

describe('typed response validation (validateBriefJson + dispatcher validate)', () => {
  // llmFacts carries the call summary so CLEAN_LLM_JSON's self-reported
  // 'ants' is grounded at the unit level too.
  const GROUNDING = { catalogVocabulary: { names: [], targets: [] }, llmFacts: { recentCalls: ['Asked about ants in garage'] } };
  const { validateBriefJson } = PrevisitBrief._test;

  test('shape rejections carry typed reasons', () => {
    expect(validateBriefJson(null, GROUNDING).reason).toBe('not_an_object');
    expect(validateBriefJson([], GROUNDING).reason).toBe('not_an_object');
    expect(validateBriefJson({}, GROUNDING).reason).toBe('priorities_not_array');
    expect(validateBriefJson({ priorities: 'do things' }, GROUNDING).reason).toBe('priorities_not_array');
    expect(validateBriefJson({ priorities: [] }, GROUNDING).reason).toBe('watch_items_not_array');
    expect(validateBriefJson({ priorities: [], watch_items: [], open_scope: 42 }, GROUNDING).reason).toBe('open_scope_not_string');
  });

  test('banned genera ANYWHERE in the raw response reject the leg', () => {
    expect(validateBriefJson({ priorities: ['Check for Ganoderma conks'], watch_items: [] }, GROUNDING).reason).toBe('forbidden_genus');
    expect(validateBriefJson({ priorities: [], watch_items: [], customer_context: 'thielaviopsis risk' }, GROUNDING).reason).toBe('forbidden_genus');
  });

  test('ungrounded catalog claims reject with the offending term', () => {
    const grounding = { catalogVocabulary: { names: ['termidor sc'], targets: [] }, llmFacts: {} };
    expect(validateBriefJson({ priorities: ['Apply Termidor SC'], watch_items: [], mentioned_terms: [] }, grounding).reason).toBe('ungrounded_product:termidor sc');
  });

  test('a missing mentioned_terms list rejects the leg', () => {
    const { mentioned_terms, ...rest } = CLEAN_LLM_JSON;
    expect(validateBriefJson(rest, GROUNDING).reason).toBe('mentioned_terms_not_array');
  });

  test('a listed but ungrounded term rejects the leg', () => {
    const verdict = validateBriefJson({ ...CLEAN_LLM_JSON, mentioned_terms: ['emerald ash borer'] }, GROUNDING);
    expect(verdict.reason).toBe('ungrounded_term:emerald ash borer');
  });

  test('an organism named without a preposition is still caught (regression)', () => {
    // "Emerald ash borer activity warrants inspection" — no for/targeting/
    // against shape, not self-reported: the activity-noun regex must catch
    // it (codex round: narrow sentence shapes let this through).
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Emerald ash borer activity warrants inspection'] },
      GROUNDING,
    );
    expect(verdict.reason).toMatch(/^ungrounded_(novel_target:|term:)/);
  });

  test('a novel organism in an unrecognized sentence shape is still caught (rare-word pass)', () => {
    // No preposition, no activity-noun, not self-reported — the rare-word
    // pass is the layer that must reject it.
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Inspect unicorn beetles near the garage'] },
      GROUNDING,
    );
    // The directive pass (imperative-verb grounding) may claim this
    // first; either way the invented organism must reject the leg.
    expect(verdict.reason).toMatch(/^ungrounded_(novel_term|instruction):/);
  });

  test('a recombined product name never rides on a grounded sibling', () => {
    // Grounding carries "Bifen IT"; "Bifen SC" shares every significant
    // word ("sc" is under the threshold) — exact-phrase grounding must
    // reject it (codex round: fixed-product rule).
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { products: ['Bifen IT'], recentCalls: ['Asked about ants in garage'] },
    };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Apply Bifen SC to the perimeter'] },
      grounding,
    );
    expect(verdict.reason).toMatch(/^ungrounded_novel_product:/);
  });

  test('an instruction naming a product outside the fixed visit list is rejected', () => {
    // "Prodiamine 65 WDG" is grounded (last visit's product in llmFacts)
    // but absent from the CURRENT window's fixed list — as an instruction
    // it must reject; as last-visit description it is legitimate.
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: {
        recentCalls: ['Asked about ants in garage'],
        lastVisit: { products: ['Prodiamine 65 WDG'] },
        productGuidance: { productNames: ['0-0-7 Fert'] },
      },
    };
    const rejected = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: ['prodiamine 65 wdg'], priorities: ['Apply Prodiamine 65 WDG to the front turf'] },
      grounding,
    );
    expect(rejected.reason).toMatch(/^ungrounded_novel_product:/);

    const descriptive = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: ['prodiamine 65 wdg'], priorities: [], last_visit_summary: 'Applied Prodiamine 65 WDG across the lawn in July.' },
      grounding,
    );
    expect(descriptive.reason).toBeUndefined();
  });

  test('a BARE historical product as a priority is rejected when off the fixed list', () => {
    // No application verb at all — "priorities: ['Bifen IT']" still
    // directs the technician; grounded-as-history is not enough when the
    // current window excludes it.
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: {
        recentCalls: ['Asked about ants in garage'],
        lastVisit: { productNames: ['Bifen IT'] },
        productGuidance: { productNames: ['0-0-7 Fert'] },
      },
    };
    const rejected = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: ['bifen it'], priorities: ['Bifen IT on the perimeter'] },
      grounding,
    );
    expect(rejected.reason).toMatch(/^ungrounded_novel_product:/);
  });

  test('a short hallucinated organism (4 letters) is caught by the rare-word pass', () => {
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: ['Inspect mice near the garage'] },
      GROUNDING,
    );
    expect(verdict.reason).toMatch(/^ungrounded_(novel_(term|target)|instruction):mice/);
  });

  test('short ungrounded organisms are caught with word-boundary grounding', () => {
    for (const prose of ['Rat activity warrants inspection', 'Inspect grubs near the lawn']) {
      const verdict = validateBriefJson(
        { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [prose] },
        GROUNDING,
      );
      expect(verdict.reason).toMatch(/^ungrounded_(novel_target|instruction):/);
    }
    // Grounded short organisms still pass ('ants' is in the call summary).
    const ok = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: ['ants'], priorities: ['Knock down ant trails at the garage'] },
      GROUNDING,
    );
    expect(ok.reason).toBeUndefined();
  });

  test('a LOWERCASE bare known product off the fixed list is rejected in priorities', () => {
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: {
        recentCalls: ['Asked about ants in garage'],
        lastVisit: { productNames: ['Bifen IT'] },
        productGuidance: { productNames: [] },
      },
    };
    const rejected = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: ['bifen it'], priorities: ['bifen it along the fence'] },
      grounding,
    );
    expect(rejected.reason).toMatch(/^ungrounded_novel_product:/);
  });

  test('a clean response yields the sanitized body', () => {
    const verdict = validateBriefJson({ ...CLEAN_LLM_JSON }, GROUNDING);
    expect(verdict.reason).toBeUndefined();
    expect(verdict.body.priorities).toEqual(CLEAN_LLM_JSON.priorities);
  });

  test('the validator is handed to dispatchWithFallback so a bad primary fails over pre-template', async () => {
    useDb(baseResponses());
    await PrevisitBrief.generateVisitBrief('svc-1');
    // Token budget pinned: 1000 truncated real briefs mid-JSON in prod
    // (empty_json legs, 08-14/15) — a silent revert would re-break the lane.
    // reasoningEffort pinned with it: 2000 crosses the OpenAI reasoning
    // floor, and the raise must never silently enable fallback reasoning.
    expect(global.__dispatch.mock.calls[0][1].maxTokens).toBe(2000);
    expect(global.__dispatch.mock.calls[0][1].reasoningEffort).toBe('none');
    const opts = global.__dispatch.mock.calls[0][2];
    expect(typeof opts.validate).toBe('function');
    expect(opts.validate({ json: {} })).toBe('priorities_not_array');
    expect(opts.validate({ json: null })).toBe('no_json');
    expect(opts.validate({ json: { ...CLEAN_LLM_JSON } })).toBeNull();
  });

  test('an empty-object response is never stored as an LLM brief', async () => {
    global.__dispatch = jest.fn(async () => ({ ok: true, json: {} }));
    const state = useDb(baseResponses());
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.via).toBe('template');
    expect(storedBrief(state).brief.generated_via).toBe('template');
  });
});

describe('LLM-boundary redaction of free text', () => {
  test('codes in flag details and call summaries are masked in the payload, not in the access block', async () => {
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

    const payload = JSON.stringify(global.__dispatch.mock.calls[0]);
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

    const text = global.__dispatch.mock.calls[0][1].text;
    const facts = JSON.parse(text.split('Grounding facts:\n')[1].split('\n\nReturn only')[0]);
    expect(facts.visit.scheduledDate).toBe('2026-08-13');
    expect(facts.lastVisit.date).toBe('2026-07-15');
    expect(facts.recentCalls[0].date).toBe('2026-08-13');
  });
});

describe('LLM failure fallback', () => {
  test('provider miss stores the deterministic template brief', async () => {
    global.__dispatch = jest.fn(async () => ({ ok: false, reason: 'all_providers_down' }));
    const state = useDb(baseResponses());
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    expect(out.via).toBe('template');
    const { brief } = storedBrief(state);
    expect(brief.generated_via).toBe('template');
    expect(brief.version).toBe('visit_brief_v1');
    // Deterministic sections still populated.
    expect(brief.last_visit.date).toBe('2026-07-15');
    expect(brief.last_visit.products[0].name).toBe('Bifen IT');
    expect(brief.access.codes.propertyGate).toBe('4545');
  });

  test('a thrown dispatch also falls back to the template', async () => {
    global.__dispatch = jest.fn(async () => { throw new Error('boom'); });
    const state = useDb(baseResponses());
    const out = await PrevisitBrief.generateVisitBrief('svc-1');
    expect(out.generated).toBe(true);
    expect(out.via).toBe('template');
    expect(storedBrief(state).brief.generated_via).toBe('template');
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
    expect(mockCheckLimits).toHaveBeenCalledWith('cust-1', 'prod-pro', expect.any(Date));
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
    const llmPayload = JSON.stringify(global.__dispatch.mock.calls[0]);
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
    const text = global.__dispatch.mock.calls[0][1].text;
    const facts = JSON.parse(text.split('Grounding facts:\n')[1].split('\n\nReturn only')[0]);
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

describe('grounded-only words require WORD-BOUNDARY grounding (codex #3423 r5)', () => {
  test('a tier word never grounds on a substring host (silverfish/marigold)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { target: 'silverfish', note: 'marigold bed by the door' },
    };
    for (const claim of ['Silver membership on file', 'Gold membership on file']) {
      const verdict = validateBriefJson(
        { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: claim },
        grounding,
      );
      expect(verdict.reason).toBeTruthy();
    }
  });

  test('stem variants of grounded-only words never downgrade to substring (codex #3423 r6)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    // wordVariants('accepted') -> 'accept', which is not itself in the
    // grounded-only set — the strictness must follow the BASE word.
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { note: 'unaccepted offer, acceptable balance' },
    };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'Payment accepted' },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
  });

  test('fabricated preference and account-state prose rejects (codex #3423 r6)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const claim of ['Customer requests quiet arrival', 'Account in good standing', 'Resident will be onsite', 'Someone will be onsite', 'Interior service included', 'Customer prefers phone communication', 'Customer prefers SMS', 'Past due', 'Site shows damage']) {
      const verdict = validateBriefJson(
        { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: claim },
        grounding,
      );
      expect(verdict.reason).toBeTruthy();
    }
  });

  test('a boundary-grounded tier word still passes', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { membership: { tier: 'Silver' } },
    };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'Silver membership on file' },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });
});

describe('codex #3423 r9 — value-scoped strict grounding + retired name + instruction evidence', () => {
  test('a fact KEY never grounds a business-state claim (history.available)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { history: { available: false } },
    };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'Customer available Monday' },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
  });

  test('an availability fact VALUE still grounds the claim', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { flags: [{ detail: 'customer said they are available Monday mornings' }] },
    };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'Customer available Monday' },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });

  test('the retired company name is rejected outright', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [], customer_context: 'Waves Lawn & Pest visited in July.' },
      grounding,
    );
    expect(verdict.reason).toBe('retired_company_name');
  });

  test('money/treatment directive objects require fact-value evidence', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const claim of ['Provide estimate', 'Discuss payment', 'Perform treatment']) {
      const verdict = validateBriefJson(
        { priorities: [claim], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
        grounding,
      );
      expect(verdict.reason).toBeTruthy();
    }
  });

  test('an evidenced money directive passes', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { flags: [{ detail: 'customer asked to discuss payment on arrival' }] },
    };
    const verdict = validateBriefJson(
      { priorities: ['Discuss payment'], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });
});

describe('codex #3423 r10 — recurring boolean evidence + money words grounded everywhere', () => {
  test('visit.isRecurring:true grounds a truthful recurring claim', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { visit: { isRecurring: true } },
    };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: 'Recurring service.', customer_context: null },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });

  test('without the boolean, an ungrounded recurring claim still rejects', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: { visit: { isRecurring: false } } };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: 'Recurring service.', customer_context: null },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
  });

  test('an estimate status value cannot ground "Payment accepted" (r10 scoping case)', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { openScope: { sourceEstimate: { status: 'accepted' } } },
    };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'Payment accepted' },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
    expect(verdict.reason).toMatch(/payment/i);
  });

  test('a real payment fact value grounds the same sentence', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { billing: { note: 'card payment accepted 08-13' } },
    };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'Payment accepted' },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });
});

describe('codex #3423 r12 — evidence check precedes the whole-phrase fast path', () => {
  test('null-valued estimate keys never ground "Provide estimate"', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    // Real payloads always carry these keys; the values are null here.
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { openScope: { sourceEstimate: null, pendingEstimate: null } },
    };
    const verdict = validateBriefJson(
      { priorities: ['Provide estimate'], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
  });

  test('a real estimate value still grounds the directive', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { flags: [{ detail: 'customer asked us to provide estimate for lawn care' }] },
    };
    const verdict = validateBriefJson(
      { priorities: ['Provide estimate'], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });
});

describe('codex #3423 r13 — interior room nouns trip the interior opt-out for any verb', () => {
  test('"Vacuum basement" violates an interiorSpray=false preference', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { servicePreferences: { interiorSpray: false } },
    };
    for (const claim of ['Vacuum basement', 'Check kitchen']) {
      const verdict = validateBriefJson(
        { priorities: [claim], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
        grounding,
      );
      expect(verdict.reason).toBe('ungrounded_preference_conflict:interior');
    }
  });
});

describe('codex #3423 r14 — punctuated retired name, first-visit token, condition words', () => {
  test('punctuation-separated retired names reject', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const name of ['Waves Lawn-Pest', 'Waves Lawn/Pest', 'Waves Lawn + Pest', 'Waves Lawn and Pest']) {
      const verdict = validateBriefJson(
        { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: `${name} visited.` },
        grounding,
      );
      expect(verdict.reason).toBe('retired_company_name');
    }
  });

  test('visit.newCustomer:true grounds a truthful initial-visit claim; absent it rejects', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const groundedNew = { catalogVocabulary: { names: [], targets: [] }, llmFacts: { visit: { newCustomer: true } } };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: 'Initial visit.', customer_context: null },
      groundedNew,
    ).body).toBeTruthy();
    const empty = { catalogVocabulary: { names: [], targets: [] }, llmFacts: { visit: { newCustomer: false } } };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: 'Initial visit.', customer_context: null },
      empty,
    ).reason).toBeTruthy();
  });

  test('"Baseline damage documented" rejects on empty facts', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: ['Baseline damage documented'], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
  });
});

describe('codex #3423 r15 — cache bump, reversed retired name, access objects, durations', () => {
  test('reversed and punctuated retired names reject; the real brand does not', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const name of ['Waves Pest & Lawn', 'Waves Pest and Lawn']) {
      expect(validateBriefJson(
        { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: `${name} visited.` },
        grounding,
      ).reason).toBe('retired_company_name');
    }
    const real = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'Waves Pest Control and Lawn Care visited.' },
      grounding,
    );
    expect(real.reason).not.toBe('retired_company_name');
  });

  test('access-object directives require fact-value evidence', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const empty = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const claim of ['Retrieve gate key', 'Retrieve access card']) {
      expect(validateBriefJson(
        { priorities: [claim], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
        empty,
      ).reason).toBeTruthy();
    }
    const grounded = { catalogVocabulary: { names: [], targets: [] }, llmFacts: { flags: [{ detail: 'gate key hidden under the planter' }] } };
    expect(validateBriefJson(
      { priorities: ['Retrieve gate key'], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      grounded,
    ).body).toBeTruthy();
  });

  test('spelled-out duration claims reject without grounding', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: ['Dry after ten minutes'], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
  });
});

describe('codex #3423 r16 — short organisms, indirect objects, do-not-call claims', () => {
  test('"bat damage" and indirect-object money directives reject on empty facts', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const body of [
      { watch_items: ['Watch for bat damage'], priorities: [] },
      { watch_items: ['Damage activity'], priorities: [] },
      { watch_items: [], priorities: ['Provide customer with an estimate'] },
      { watch_items: [], priorities: ['Provide customer an estimate'] },
      { watch_items: [], priorities: [], customer_context: 'Customer is not on do not call list' },
    ]) {
      const verdict = validateBriefJson(
        { mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null, ...body },
        grounding,
      );
      expect(verdict.reason).toBeTruthy();
    }
  });

  test('a grounded bat mention still passes', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { flags: [{ detail: 'bat damage in the attic; bats reported in vents' }] },
    };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: ['Watch for bat damage'], mentioned_terms: ['bats'], last_visit_summary: null, open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });
});

describe('codex #3423 r17 — waves as product, ALL-CAPS directives, account state', () => {
  test('ungrounded claims reject: Apply Waves, PERFORM TREATMENT, Account state: paid', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const body of [
      { priorities: ['Apply Waves'] },
      { priorities: ['PERFORM TREATMENT'] },
      { priorities: [], customer_context: 'Account state: paid' },
    ]) {
      const verdict = validateBriefJson(
        { watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null, ...body },
        grounding,
      );
      expect(verdict.reason).toBeTruthy();
    }
  });

  test('the approved company name still reads as prose', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: 'Waves Pest Control serviced the yard in July.', open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });
});

describe('codex #3423 r19 — scheduling evidence, room-as-spacing, canonical name only', () => {
  test('"Discuss scheduling" rejects without a scheduling fact', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { priorities: ['Discuss scheduling'], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
  });

  test('singular "room" as spacing does not trip the interior conflict', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { servicePreferences: { interiorSpray: false }, flags: [{ detail: 'leave room around the exterior gate for the trailer' }] },
    };
    const verdict = validateBriefJson(
      { priorities: ['Leave room around the exterior gate'], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.reason).not.toBe('ungrounded_preference_conflict:interior');
  });
});

describe('codex #3423 r20 — noncanonical suffix, field-wide evidence', () => {
  test('a suffixed canonical name rejects', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const name of ['Waves Pest Control & Lawn', 'Waves Pest Control and Lawn Care', 'Waves Pest Control Pest Services']) {
      expect(validateBriefJson(
        { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: `${name} visited.` },
        grounding,
      ).reason).toBe('noncanonical_company_name');
    }
  });

  test('evidence words are caught field-wide regardless of capture geometry', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { priorities: ['Provide customer with more information on estimate'], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      grounding,
    );
    // r24: 'estimate' graduated to GROUNDED_ONLY — the rare-word pass now
    // owns it field-wide; the reason label moved but the rejection stands.
    expect(verdict.reason).toMatch(/estimate/);
  });
});

describe('codex #3423 r21 — scheduling statuses, punctuation after canonical name', () => {
  test('"Scheduling confirmed" rejects in descriptive fields without a scheduling fact', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const claim of ['Scheduling confirmed', 'Scheduling cancelled']) {
      expect(validateBriefJson(
        { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: claim },
        grounding,
      ).reason).toBeTruthy();
    }
  });

  test('bare punctuation after the canonical name is ordinary prose', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: 'Waves Pest Control - routine service in July.', open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.body).toBeTruthy();
  });
});

describe('codex #3423 r23 — treatment claims ground in descriptive fields too', () => {
  test('"Performed treatment" rejects without a treatment fact; grounded passes', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const empty = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: 'Performed treatment', open_scope: null, customer_context: null },
      empty,
    ).reason).toBeTruthy();
    const grounded = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { lastVisit: { recap: 'perimeter treatment completed 07-14' } },
    };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: 'Performed treatment', open_scope: null, customer_context: null },
      grounded,
    ).body).toBeTruthy();
  });
});

describe('codex #3423 r24 — estimate claims, treatment inflections, transition', () => {
  test('"Estimate provided" rejects descriptively without an estimate; passes with one', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const empty = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: 'Estimate provided', open_scope: null, customer_context: null },
      empty,
    ).reason).toBeTruthy();
    const grounded = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { openScope: { pendingEstimate: { tier: 'Bronze', status: 'sent' } } },
    };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: 'Estimate provided', customer_context: null },
      grounded,
    ).body).toBeTruthy();
  });

  test('"Performed treatment" grounds on treated/treating history wording', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { lastVisit: { recap: 'Treated exterior perimeter with Bifen IT' } },
    };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: 'Performed treatment', open_scope: null, customer_context: null },
      grounding,
    ).body).toBeTruthy();
  });

  test('"Account transition pending" rejects on empty facts', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'Account transition pending' },
      grounding,
    ).reason).toBeTruthy();
  });
});

describe('codex #3423 r25 — singular keys, canonical name in prose, quote claims', () => {
  test('"Retrieve door key" rejects without an access fact', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const claim of ['Retrieve door key', 'Retrieve office key']) {
      expect(validateBriefJson(
        { priorities: [claim], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
        grounding,
      ).reason).toBeTruthy();
    }
  });

  test('the canonical name inside ordinary prose passes; beside a novel token it parks', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'Call Waves Pest Control before arrival.' },
      grounding,
    ).body).toBeTruthy();
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'PhantomGuard Waves Pest Control formula.' },
      grounding,
    ).reason).toBeTruthy();
  });

  test('"Quote provided" rejects without an estimate; passes with one', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const empty = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: 'Quote provided', open_scope: null, customer_context: null },
      empty,
    ).reason).toBeTruthy();
    const grounded = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { openScope: { pendingEstimate: { tier: 'Bronze' } } },
    };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: 'Quote provided', customer_context: null },
      grounded,
    ).body).toBeTruthy();
  });
});

describe('codex #3423 r26 — self-report is not evidence; canonical-name boundaries', () => {
  test('mentioned_terms cannot launder a grounded-only word past null estimate keys', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { openScope: { sourceEstimate: null, pendingEstimate: null } },
    };
    const verdict = validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: ['estimate'], last_visit_summary: 'Estimate provided', open_scope: null, customer_context: null },
      grounding,
    );
    expect(verdict.reason).toBeTruthy();
  });

  test('glued canonical-name suffixes reject', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const name of ['Waves Pest Controls', 'Waves Pest Controller']) {
      expect(validateBriefJson(
        { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: `${name} visited.` },
        grounding,
      ).reason).toBe('noncanonical_company_name');
    }
  });
});

describe('codex #3423 r27 — sensitivity directives, corporate suffixes, overdue-balance evidence', () => {
  test('chemical-sensitivity directives need a sensitivity fact', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const empty = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    expect(validateBriefJson(
      { priorities: ['Discuss chemical sensitivity'], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      empty,
    ).reason).toBeTruthy();
    const grounded = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { flags: [{ type: 'chemical_sensitivity', detail: 'customer reports chemical sensitivity — fragrance-free products' }] },
    };
    expect(validateBriefJson(
      { priorities: ['Discuss chemical sensitivity'], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: null },
      grounded,
    ).body).toBeTruthy();
  });

  test('corporate suffixes on the canonical name reject', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = { catalogVocabulary: { names: [], targets: [] }, llmFacts: {} };
    for (const name of ['Waves Pest Control LLC', 'Waves Pest Control, LLC', 'Waves Pest Control Inc']) {
      expect(validateBriefJson(
        { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: `${name} visited.` },
        grounding,
      ).reason).toBe('noncanonical_company_name');
    }
  });

  test('the overdue_balance flag grounds truthful billing summaries', () => {
    const { validateBriefJson } = PrevisitBrief._test;
    const grounding = {
      catalogVocabulary: { names: [], targets: [] },
      llmFacts: { flags: [{ type: 'overdue_balance', severity: 'medium', detail: '$100.00 outstanding' }] },
    };
    expect(validateBriefJson(
      { priorities: [], watch_items: [], mentioned_terms: [], last_visit_summary: null, open_scope: null, customer_context: 'Invoice balance outstanding' },
      grounding,
    ).body).toBeTruthy();
  });
});
