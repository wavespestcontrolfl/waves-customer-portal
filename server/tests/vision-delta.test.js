// Vision delta scoring lane (server/services/vision-delta.js):
//  - sweep is entirely inert unless GATE_VISION_DELTA === 'true' (gate inside
//    the service = single source of truth)
//  - comparable + confident verdict persists jsonb + integer score + scored_at
//  - non-comparable / low-confidence verdict stores the jsonb with a NULL
//    score and still stamps scored_at (never re-scored in a loop)
//  - failures increment vision_score_attempts WITHOUT stamping scored_at;
//    the 3rd failure stamps a terminal {error} verdict
//  - sweep selects only both-photo-keys + unscored + attempts<3, oldest first

jest.mock('../models/db', () => {
  const fn = (table) => global.__visionDbMock(table);
  fn.raw = (sql, bindings) => ({ __raw: sql, bindings });
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({
  VISION: 'test-model',
  PROVIDER: { ANTHROPIC: 'anthropic', OPENAI: 'openai', GEMINI: 'gemini' },
  TEXT_POLICIES: {
    visionAnalysis: {
      name: 'visionAnalysis',
      primary: { provider: 'anthropic', model: 'test-model' },
      fallback: { provider: 'openai', model: 'test-openai' },
    },
  },
}));
jest.mock('../services/photos', () => ({
  getPhotoBase64: jest.fn(),
}));
jest.mock('../services/agronomic-wiki', () => ({
  markOutcomePagesStale: jest.fn(async () => 1),
}));
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: jest.fn(async (policy, payload, { validate } = {}) => {
    const result = await global.__visionDispatch(policy, payload);
    if (!result?.ok) return { failures: [], ...result };
    if (validate) {
      const rejection = validate(result, policy?.primary);
      if (rejection) {
        return { ok: false, reason: 'all_providers_failed', failures: [{ provider: 'anthropic', model: 'test-model', reason: String(rejection) }] };
      }
    }
    return { provider: 'anthropic', model: result.model || 'test-model', failures: [], ...result };
  }),
}));

const MODELS = require('../config/models');
const VisionDelta = require('../services/vision-delta');
const PhotoService = require('../services/photos');
const AgronomicWiki = require('../services/agronomic-wiki');

function makeDb(responses = {}) {
  const state = { responses, calls: {}, updates: {} };
  const dbFn = (table) => {
    const rec = { table, ops: [] };
    (state.calls[table] = state.calls[table] || []).push(rec);
    const callIdx = state.calls[table].length - 1;
    const resolveRows = () => {
      const conf = state.responses[table];
      if (typeof conf === 'function') return conf(rec, callIdx) || [];
      if (Array.isArray(conf)) return conf;
      return [];
    };
    const b = {};
    for (const m of ['where', 'andWhere', 'orWhere', 'whereRaw', 'whereIn', 'whereNull', 'whereNotNull', 'orderBy', 'limit', 'select']) {
      b[m] = (...args) => {
        rec.ops.push([m, args]);
        if (typeof args[0] === 'function') args[0].call(b);
        return b;
      };
    }
    b.first = async (...args) => { rec.ops.push(['first', args]); return resolveRows()[0] ?? null; };
    b.update = (patch) => {
      rec.ops.push(['update', [patch]]);
      (state.updates[table] = state.updates[table] || []).push(patch);
      // Row count the UPDATE reports — overridable so tests can simulate a
      // key-pair condition matching 0 rows (pair superseded mid-score).
      const count = typeof state.updateResults?.[table] === 'function'
        ? state.updateResults[table](patch, rec)
        : 1;
      return { then: (res, rej) => Promise.resolve(count).then(res, rej) };
    };
    b.then = (res, rej) => {
      let rows;
      try { rows = resolveRows(); } catch (err) { return Promise.reject(err).then(res, rej); }
      return Promise.resolve(rows).then(res, rej);
    };
    return b;
  };
  dbFn.state = state;
  return dbFn;
}

function useDb(responses) {
  const dbFn = makeDb(responses);
  global.__visionDbMock = dbFn;
  return dbFn.state;
}

const OUTCOME = {
  id: 'o1',
  pre_best_photo_key: 'lawn/pre.jpg',
  post_best_photo_key: 'lawn/post.jpg',
  vision_scored_at: null,
  vision_score_attempts: 0,
};

function verdictResponse(verdict) {
  return { ok: true, text: JSON.stringify(verdict), model: 'test-model' };
}

const GOOD_VERDICT = {
  overall_change: 42,
  density_change: 30,
  color_change: 25,
  weed_coverage_change: 10,
  confidence: 0.85,
  comparable: true,
  notes: 'Denser, greener turf visible in the after photo.',
};

const savedGate = process.env.GATE_VISION_DELTA;

beforeEach(() => {
  delete process.env.GATE_VISION_DELTA;
  PhotoService.getPhotoBase64.mockReset();
  PhotoService.getPhotoBase64.mockResolvedValue({ data: 'aGk=', mimeType: 'image/jpeg' });
  AgronomicWiki.markOutcomePagesStale.mockClear();
  global.__visionDispatch = jest.fn(async () => verdictResponse(GOOD_VERDICT));
});

afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_VISION_DELTA;
  else process.env.GATE_VISION_DELTA = savedGate;
});

// ── gate ───────────────────────────────────────────────────────────────────

describe('sweepUnscoredOutcomes gating', () => {
  test('gate unset → {skipped:"gated"}, no DB reads, no LLM calls', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    const res = await VisionDelta.sweepUnscoredOutcomes();
    expect(res).toEqual({ skipped: 'gated' });
    expect(state.calls.treatment_outcomes).toBeUndefined();
    expect(global.__visionDispatch).not.toHaveBeenCalled();
  });

  test('gate must be exactly "true" — "1" stays gated', async () => {
    process.env.GATE_VISION_DELTA = '1';
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    const res = await VisionDelta.sweepUnscoredOutcomes();
    expect(res).toEqual({ skipped: 'gated' });
    expect(state.calls.treatment_outcomes).toBeUndefined();
  });
});

// ── scoreOutcome ───────────────────────────────────────────────────────────

describe('scoreOutcome', () => {
  test('comparable + confident verdict persists jsonb, integer score, scored_at, attempts+1', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(true);
    expect(res.score).toBe(42);

    const [patch] = state.updates.treatment_outcomes;
    expect(patch.vision_delta_score).toBe(42);
    expect(patch.vision_scored_at).toBeInstanceOf(Date);
    expect(patch.vision_score_attempts).toBe(1);
    expect(JSON.parse(patch.vision_delta)).toEqual(GOOD_VERDICT);

    // Both photos fetched, one vision call with both images labeled
    expect(PhotoService.getPhotoBase64).toHaveBeenCalledWith('lawn/pre.jpg');
    expect(PhotoService.getPhotoBase64).toHaveBeenCalledWith('lawn/post.jpg');
    expect(global.__visionDispatch).toHaveBeenCalledTimes(1);
    const [policy, payload] = global.__visionDispatch.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.visionAnalysis);
    expect(payload.images).toHaveLength(2);
    expect(payload.text).toContain('FIRST image is BEFORE');

    // A persisted score marks the outcome's wiki pages regenerate-eligible
    expect(AgronomicWiki.markOutcomePagesStale).toHaveBeenCalledTimes(1);
    expect(AgronomicWiki.markOutcomePagesStale).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1' }),
    );
  });

  test('a genuine out-of-range number is clamped, not rejected', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    global.__visionDispatch = jest.fn(async () => verdictResponse({ ...GOOD_VERDICT, overall_change: 250 }));
    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(true);
    expect(res.score).toBe(100);
    expect(state.updates.treatment_outcomes[0].vision_delta_score).toBe(100);
  });

  test('non-comparable verdict stores jsonb with NULL score and still stamps scored_at', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    const verdict = { ...GOOD_VERDICT, comparable: false, notes: 'Different angles.' };
    global.__visionDispatch = jest.fn(async () => verdictResponse(verdict));

    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(true);
    expect(res.score).toBeNull();

    const [patch] = state.updates.treatment_outcomes;
    expect(patch.vision_delta_score).toBeNull();
    expect(patch.vision_scored_at).toBeInstanceOf(Date);
    expect(JSON.parse(patch.vision_delta)).toEqual(verdict);
  });

  test('low confidence (<0.4) also leaves score NULL but stamps scored_at', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    global.__visionDispatch = jest.fn(async () => verdictResponse({ ...GOOD_VERDICT, confidence: 0.2 }));

    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(true);
    expect(res.score).toBeNull();
    const [patch] = state.updates.treatment_outcomes;
    expect(patch.vision_delta_score).toBeNull();
    expect(patch.vision_scored_at).toBeInstanceOf(Date);
  });

  test('LLM failure increments attempts WITHOUT stamping scored_at', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    global.__visionDispatch = jest.fn(async () => { throw new Error('overloaded'); });

    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(false);
    expect(res.terminal).toBe(false);

    const [patch] = state.updates.treatment_outcomes;
    expect(patch).toEqual({ vision_score_attempts: 1 });
  });

  test('3rd failure (photo missing from S3) stamps terminal {error} verdict + scored_at', async () => {
    const state = useDb({ treatment_outcomes: [{ ...OUTCOME, vision_score_attempts: 2 }] });
    PhotoService.getPhotoBase64.mockRejectedValue(new Error('NoSuchKey'));

    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(false);
    expect(res.terminal).toBe(true);

    const [patch] = state.updates.treatment_outcomes;
    expect(patch.vision_score_attempts).toBe(3);
    expect(patch.vision_scored_at).toBeInstanceOf(Date);
    expect(JSON.parse(patch.vision_delta)).toEqual({ error: 'NoSuchKey' });
    expect(patch.vision_delta_score).toBeUndefined();
  });

  test('already-scored row is never re-scored', async () => {
    const state = useDb({ treatment_outcomes: [{ ...OUTCOME, vision_scored_at: new Date('2026-08-01') }] });
    const res = await VisionDelta.scoreOutcome('o1');
    expect(res).toEqual({ ok: false, reason: 'already_scored' });
    expect(state.updates.treatment_outcomes).toBeUndefined();
    expect(global.__visionDispatch).not.toHaveBeenCalled();
  });

  test('missing photo key rows are refused without burning an attempt', async () => {
    const state = useDb({ treatment_outcomes: [{ ...OUTCOME, post_best_photo_key: null }] });
    const res = await VisionDelta.scoreOutcome('o1');
    expect(res).toEqual({ ok: false, reason: 'missing_photo_keys' });
    expect(state.updates.treatment_outcomes).toBeUndefined();
  });

  test('a fallback-leg success (Anthropic outage → OpenAI) persists normally', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    global.__visionDispatch = jest.fn(async () => ({
      ok: true,
      text: JSON.stringify(GOOD_VERDICT),
      model: 'test-openai',
      fallbackUsed: true,
    }));

    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(true);
    expect(res.score).toBe(42);
    const [patch] = state.updates.treatment_outcomes;
    expect(patch.vision_delta_score).toBe(42);
    expect(patch.vision_scored_at).toBeInstanceOf(Date);
  });

  test('unparseable model output counts as a failed attempt', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    global.__visionDispatch = jest.fn(async () => ({ ok: true, text: 'not json' }));
    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(false);
    expect(state.updates.treatment_outcomes).toEqual([{ vision_score_attempts: 1 }]);
  });

  test.each([
    ['overall_change is a numeric string', { ...GOOD_VERDICT, overall_change: '42' }],
    ['overall_change is null', { ...GOOD_VERDICT, overall_change: null }],
    ['overall_change is NaN', { ...GOOD_VERDICT, overall_change: NaN }],
    ['comparable is a string', { ...GOOD_VERDICT, comparable: 'true' }],
    ['comparable is missing', (() => { const v = { ...GOOD_VERDICT }; delete v.comparable; return v; })()],
    ['confidence is a string', { ...GOOD_VERDICT, confidence: '0.9' }],
    ['confidence above 1', { ...GOOD_VERDICT, confidence: 1.5 }],
    ['confidence below 0', { ...GOOD_VERDICT, confidence: -0.1 }],
    ['notes is a number', { ...GOOD_VERDICT, notes: 42 }],
  ])('invalid verdict (%s) is a failed attempt — no stamp, no trusted zero, no stale-flagging', async (_label, verdict) => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    global.__visionDispatch = jest.fn(async () => verdictResponse(verdict));

    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(false);
    expect(state.updates.treatment_outcomes).toEqual([{ vision_score_attempts: 1 }]);
    expect(AgronomicWiki.markOutcomePagesStale).not.toHaveBeenCalled();
  });

  test('persistence writes are conditioned on the loaded photo-key pair + still-unscored', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    await VisionDelta.scoreOutcome('o1');

    // calls[0] = the .first() load; calls[1] = the verdict UPDATE
    const updateRec = state.calls.treatment_outcomes[1];
    expect(updateRec.ops).toContainEqual(['where', [{
      id: 'o1',
      pre_best_photo_key: 'lawn/pre.jpg',
      post_best_photo_key: 'lawn/post.jpg',
    }]]);
    expect(updateRec.ops).toContainEqual(['whereNull', ['vision_scored_at']]);
  });

  test('photo pair re-elected mid-score → verdict DISCARDED: no stamp, no stale-flag, reason superseded', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    state.updateResults = { treatment_outcomes: () => 0 }; // key-pair WHERE matches nothing

    const res = await VisionDelta.scoreOutcome('o1');
    expect(res).toEqual({ ok: false, reason: 'superseded' });
    // Exactly one write was ATTEMPTED (the conditioned verdict update) and
    // nothing else — no follow-up stamp, no attempt charge.
    expect(state.updates.treatment_outcomes).toHaveLength(1);
    expect(AgronomicWiki.markOutcomePagesStale).not.toHaveBeenCalled();
  });

  test('failed attempt against a superseded pair is not charged to the new pair', async () => {
    const state = useDb({ treatment_outcomes: [{ ...OUTCOME, vision_score_attempts: 2 }] });
    state.updateResults = { treatment_outcomes: () => 0 };
    global.__visionDispatch = jest.fn(async () => { throw new Error('overloaded'); });

    const res = await VisionDelta.scoreOutcome('o1');
    // Would have been the terminal 3rd failure — but the row now belongs to a
    // NEW pair with a fresh budget; the conditioned update wrote nothing.
    expect(res).toEqual({ ok: false, reason: 'superseded' });
    const failRec = state.calls.treatment_outcomes[1];
    expect(failRec.ops).toContainEqual(['where', [{
      id: 'o1',
      pre_best_photo_key: 'lawn/pre.jpg',
      post_best_photo_key: 'lawn/post.jpg',
    }]]);
    // The failure write is also guarded against a concurrently stamped
    // verdict and a double-charged attempt slot.
    expect(failRec.ops).toContainEqual(['whereNull', ['vision_scored_at']]);
    expect(failRec.ops).toContainEqual(['where', ['vision_score_attempts', 2]]);
  });

  test('null-score verdicts and failures never stale-flag wiki pages', async () => {
    useDb({ treatment_outcomes: [OUTCOME] });
    global.__visionDispatch = jest.fn(async () => verdictResponse({ ...GOOD_VERDICT, comparable: false }));
    await VisionDelta.scoreOutcome('o1');
    expect(AgronomicWiki.markOutcomePagesStale).not.toHaveBeenCalled();

    useDb({ treatment_outcomes: [OUTCOME] });
    global.__visionDispatch = jest.fn(async () => { throw new Error('overloaded'); });
    await VisionDelta.scoreOutcome('o1');
    expect(AgronomicWiki.markOutcomePagesStale).not.toHaveBeenCalled();
  });
});

// ── setOutcomeBestPhotoKey ─────────────────────────────────────────────────

describe('setOutcomeBestPhotoKey', () => {
  test('writes the key and guards every vision field behind an IS DISTINCT FROM case', async () => {
    const state = useDb({ treatment_outcomes: [] });
    await VisionDelta.setOutcomeBestPhotoKey('o1', 'post_best_photo_key', 'new.jpg');

    const [patch] = state.updates.treatment_outcomes;
    expect(patch.post_best_photo_key).toBe('new.jpg');
    // Same-key writes must be a no-op on vision state; changed keys clear it —
    // both live in the CASE so the compare + write are one atomic UPDATE.
    for (const field of ['vision_delta', 'vision_delta_score', 'vision_scored_at']) {
      expect(patch[field].__raw).toContain('post_best_photo_key IS DISTINCT FROM ?');
      expect(patch[field].__raw).toContain('THEN NULL');
      expect(patch[field].bindings).toEqual(['new.jpg']);
    }
    // attempts reset to 0 for the new pair (fresh 3, and the sweep re-selects)
    expect(patch.vision_score_attempts.__raw).toContain('THEN 0');
  });

  test('a key change that clears an existing score stale-flags the outcome pages', async () => {
    const scoredRow = { ...OUTCOME, vision_delta_score: 42, vision_scored_at: new Date('2026-08-10') };
    useDb({ treatment_outcomes: [scoredRow] });
    await VisionDelta.setOutcomeBestPhotoKey('o1', 'post_best_photo_key', 'new.jpg');
    expect(AgronomicWiki.markOutcomePagesStale).toHaveBeenCalledTimes(1);
    expect(AgronomicWiki.markOutcomePagesStale).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1' }),
    );
  });

  test('same-key rewrite and never-scored rows do not stale-flag', async () => {
    // Same key on a scored row — vision state survives, pages still accurate.
    useDb({ treatment_outcomes: [{ ...OUTCOME, vision_delta_score: 42 }] });
    await VisionDelta.setOutcomeBestPhotoKey('o1', 'post_best_photo_key', OUTCOME.post_best_photo_key);
    expect(AgronomicWiki.markOutcomePagesStale).not.toHaveBeenCalled();

    // Changed key on a never-scored row — nothing consumed a score.
    useDb({ treatment_outcomes: [{ ...OUTCOME, vision_delta_score: null }] });
    await VisionDelta.setOutcomeBestPhotoKey('o1', 'post_best_photo_key', 'new.jpg');
    expect(AgronomicWiki.markOutcomePagesStale).not.toHaveBeenCalled();
  });

  test('rejects columns outside the photo-key allowlist', async () => {
    useDb({ treatment_outcomes: [] });
    await expect(VisionDelta.setOutcomeBestPhotoKey('o1', 'customer_id', 'x'))
      .rejects.toThrow('invalid column');
  });
});

// ── sweep selection ────────────────────────────────────────────────────────

describe('sweepUnscoredOutcomes selection', () => {
  test('selects only both-keys + unscored + attempts<3, oldest first, bounded, and scores each', async () => {
    process.env.GATE_VISION_DELTA = 'true';
    const candidates = [
      { ...OUTCOME, id: 'o1' },
      { ...OUTCOME, id: 'o2' },
    ];
    const state = useDb({
      treatment_outcomes: (rec, callIdx) => {
        if (callIdx === 0) return candidates; // the sweep's candidate query
        // scoreOutcome's per-row .first() load
        const whereOp = rec.ops.find(([m]) => m === 'where');
        const id = whereOp?.[1]?.[0]?.id;
        return candidates.filter((c) => c.id === id);
      },
    });

    const res = await VisionDelta.sweepUnscoredOutcomes({ limit: 5 });
    expect(res).toEqual({ candidates: 2, scored: 2, failed: 0 });

    const ops = state.calls.treatment_outcomes[0].ops;
    expect(ops).toContainEqual(['whereNotNull', ['pre_best_photo_key']]);
    expect(ops).toContainEqual(['whereNotNull', ['post_best_photo_key']]);
    expect(ops).toContainEqual(['whereNull', ['vision_scored_at']]);
    expect(ops).toContainEqual(['where', ['vision_score_attempts', '<', 3]]);
    expect(ops).toContainEqual(['orderBy', ['treatment_date', 'asc']]);
    expect(ops).toContainEqual(['limit', [5]]);

    // Both rows got a persisted verdict
    expect(state.updates.treatment_outcomes).toHaveLength(2);
    expect(global.__visionDispatch).toHaveBeenCalledTimes(2);
  });

  test('default limit is 25', async () => {
    process.env.GATE_VISION_DELTA = 'true';
    const state = useDb({ treatment_outcomes: [] });
    const res = await VisionDelta.sweepUnscoredOutcomes();
    expect(res).toEqual({ candidates: 0, scored: 0, failed: 0 });
    expect(state.calls.treatment_outcomes[0].ops).toContainEqual(['limit', [25]]);
  });
});
