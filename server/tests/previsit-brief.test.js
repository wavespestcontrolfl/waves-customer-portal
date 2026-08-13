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
    return /lawn|turf/i.test(s) ? 'lawn' : 'pest';
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
  service_preferences: null,
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

const CLEAN_LLM_JSON = {
  priorities: ['Check garage corner ant trail'],
  mentioned_terms: ['ants'],
  watch_items: ['Chemical-sensitivity note on file'],
  last_visit_summary: 'Routine pest service on July 15.',
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

  test('briefServableForDate matches ET calendar day incl. the UTC-midnight DATE shape, fails closed on a move or missing stamp', () => {
    const { briefServableForDate } = PrevisitBrief;
    expect(briefServableForDate({ for_date: '2026-08-13' }, '2026-08-13')).toBe(true);
    // node-postgres materializes DATE columns as UTC-midnight Dates.
    expect(briefServableForDate({ for_date: '2026-08-13' }, new Date('2026-08-13T00:00:00Z'))).toBe(true);
    expect(briefServableForDate({ for_date: '2026-08-13' }, '2026-08-15')).toBe(false);
    expect(briefServableForDate({ priorities: [] }, '2026-08-13')).toBe(false);
    expect(briefServableForDate(null, '2026-08-13')).toBe(false);
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
    expect(verdict.reason).toMatch(/^ungrounded_novel_term:/);
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
      { ...CLEAN_LLM_JSON, mentioned_terms: ['prodiamine 65 wdg'], priorities: [], last_visit_summary: 'Applied Prodiamine 65 WDG across the lawn on July 15.' },
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
    expect(verdict.reason).toMatch(/^ungrounded_novel_(term|target):mice/);
  });

  test('short ungrounded organisms are caught with word-boundary grounding', () => {
    for (const prose of ['Rat activity warrants inspection', 'Inspect grubs near the lawn']) {
      const verdict = validateBriefJson(
        { ...CLEAN_LLM_JSON, mentioned_terms: [], priorities: [prose] },
        GROUNDING,
      );
      expect(verdict.reason).toMatch(/^ungrounded_novel_target:/);
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
