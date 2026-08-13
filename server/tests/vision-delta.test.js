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
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({
  VISION: 'test-model',
  PROVIDER: { ANTHROPIC: 'anthropic', OPENAI: 'openai', GEMINI: 'gemini' },
}));
jest.mock('../services/photos', () => ({
  getPhotoBase64: jest.fn(),
}));
jest.mock('@anthropic-ai/sdk', () => {
  return class MockAnthropic {
    constructor() {
      this.messages = { create: (...args) => global.__anthropicCreate(...args) };
    }
  };
});

const VisionDelta = require('../services/vision-delta');
const PhotoService = require('../services/photos');

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
      return { then: (res, rej) => Promise.resolve(1).then(res, rej) };
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
  return { content: [{ text: JSON.stringify(verdict) }], model: 'test-model' };
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
  global.__anthropicCreate = jest.fn(async () => verdictResponse(GOOD_VERDICT));
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
    expect(global.__anthropicCreate).not.toHaveBeenCalled();
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
    expect(global.__anthropicCreate).toHaveBeenCalledTimes(1);
    const request = global.__anthropicCreate.mock.calls[0][0];
    expect(request.model).toBe('test-model');
    const content = request.messages[0].content;
    expect(content.filter((c) => c.type === 'image')).toHaveLength(2);
  });

  test('non-comparable verdict stores jsonb with NULL score and still stamps scored_at', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    const verdict = { ...GOOD_VERDICT, comparable: false, notes: 'Different angles.' };
    global.__anthropicCreate = jest.fn(async () => verdictResponse(verdict));

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
    global.__anthropicCreate = jest.fn(async () => verdictResponse({ ...GOOD_VERDICT, confidence: 0.2 }));

    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(true);
    expect(res.score).toBeNull();
    const [patch] = state.updates.treatment_outcomes;
    expect(patch.vision_delta_score).toBeNull();
    expect(patch.vision_scored_at).toBeInstanceOf(Date);
  });

  test('LLM failure increments attempts WITHOUT stamping scored_at', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    global.__anthropicCreate = jest.fn(async () => { throw new Error('overloaded'); });

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
    expect(global.__anthropicCreate).not.toHaveBeenCalled();
  });

  test('missing photo key rows are refused without burning an attempt', async () => {
    const state = useDb({ treatment_outcomes: [{ ...OUTCOME, post_best_photo_key: null }] });
    const res = await VisionDelta.scoreOutcome('o1');
    expect(res).toEqual({ ok: false, reason: 'missing_photo_keys' });
    expect(state.updates.treatment_outcomes).toBeUndefined();
  });

  test('unparseable model output counts as a failed attempt', async () => {
    const state = useDb({ treatment_outcomes: [OUTCOME] });
    global.__anthropicCreate = jest.fn(async () => ({ content: [{ text: 'not json' }] }));
    const res = await VisionDelta.scoreOutcome('o1');
    expect(res.ok).toBe(false);
    expect(state.updates.treatment_outcomes).toEqual([{ vision_score_attempts: 1 }]);
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
    expect(global.__anthropicCreate).toHaveBeenCalledTimes(2);
  });

  test('default limit is 25', async () => {
    process.env.GATE_VISION_DELTA = 'true';
    const state = useDb({ treatment_outcomes: [] });
    const res = await VisionDelta.sweepUnscoredOutcomes();
    expect(res).toEqual({ candidates: 0, scored: 0, failed: 0 });
    expect(state.calls.treatment_outcomes[0].ops).toContainEqual(['limit', [25]]);
  });
});
