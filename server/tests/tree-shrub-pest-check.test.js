// GATE_TS_PEST_CHECK freeze: the technician's "Live insects found?" answer and
// insect types are validated against the enum and frozen on the service record
// (structured_notes.treeShrubPestCheck). Tech-facing storage only. Synthetic data.
const fs = require('fs');
const path = require('path');
const {
  INSECT_TYPE_KEYS, normalizePestCheck, freezePestCheck,
} = require('../services/tree-shrub-pest-check');

const saved = process.env.GATE_TS_PEST_CHECK;
afterEach(() => {
  if (saved === undefined) delete process.env.GATE_TS_PEST_CHECK; else process.env.GATE_TS_PEST_CHECK = saved;
});

const NOW = new Date('2026-10-05T15:00:00.000Z');

test('the enum is the six approved types', () => {
  expect(INSECT_TYPE_KEYS).toEqual(['armored_scale', 'soft_scale', 'whitefly', 'caterpillars', 'mites', 'other']);
});

describe('normalizePestCheck', () => {
  test('Yes keeps enum types once each, in enum order', () => {
    expect(normalizePestCheck({ liveInsectsFound: true, insectTypes: ['mites', 'armored_scale', 'mites'] }))
      .toEqual({ liveInsectsFound: true, insectTypes: ['armored_scale', 'mites'] });
  });
  test('Yes with no types is a valid answer', () => {
    expect(normalizePestCheck({ liveInsectsFound: true })).toEqual({ liveInsectsFound: true, insectTypes: [] });
  });
  test('Yes drops values outside the enum', () => {
    expect(normalizePestCheck({ liveInsectsFound: true, insectTypes: ['aphids', 'Armored scale', 5, null, {}, 'soft_scale'] }))
      .toEqual({ liveInsectsFound: true, insectTypes: ['soft_scale'] });
  });
  test('No stores no types, whatever was sent', () => {
    expect(normalizePestCheck({ liveInsectsFound: false, insectTypes: ['whitefly'] }))
      .toEqual({ liveInsectsFound: false, insectTypes: [] });
  });
  test('anything but a real boolean is no answer', () => {
    for (const bad of ['true', 'yes', 1, 0, null, undefined]) {
      expect(normalizePestCheck({ liveInsectsFound: bad, insectTypes: ['mites'] })).toBeNull();
    }
    for (const bad of [undefined, null, 'x', 5, [], true]) expect(normalizePestCheck(bad)).toBeNull();
  });
  test('a flood of types is bounded', () => {
    const flood = Array.from({ length: 5000 }, (_, i) => `junk_${i}`);
    expect(normalizePestCheck({ liveInsectsFound: true, insectTypes: [...flood, 'mites'] }).insectTypes).toEqual([]);
  });
});

describe('freezePestCheck', () => {
  const review = { pestCheck: { liveInsectsFound: true, insectTypes: ['armored_scale', 'whitefly'] } };

  test('gate off: nothing is stored and the body field is ignored', () => {
    delete process.env.GATE_TS_PEST_CHECK;
    expect(freezePestCheck(review, { now: NOW })).toBeNull();
    process.env.GATE_TS_PEST_CHECK = 'false';
    expect(freezePestCheck(review, { now: NOW })).toBeNull();
    process.env.GATE_TS_PEST_CHECK = '1';
    expect(freezePestCheck(review, { now: NOW })).toBeNull();
  });
  test('gate on: the structured_notes fields', () => {
    process.env.GATE_TS_PEST_CHECK = 'true';
    expect(freezePestCheck(review, { now: NOW })).toEqual({
      treeShrubPestCheck: { liveInsectsFound: true, insectTypes: ['armored_scale', 'whitefly'] },
      treeShrubPestCheckDecidedAt: NOW.toISOString(),
    });
    expect(freezePestCheck({ pestCheck: { liveInsectsFound: false } }, { now: NOW }).treeShrubPestCheck)
      .toEqual({ liveInsectsFound: false, insectTypes: [] });
  });
  test('gate on: unanswered or garbage = null, never a throw', () => {
    process.env.GATE_TS_PEST_CHECK = 'true';
    for (const bad of [undefined, null, {}, 'garbage', { pestCheck: null }, { pestCheck: { insectTypes: ['mites'] } }]) {
      expect(freezePestCheck(bad)).toBeNull();
    }
  });
  test('it rides a review that was never signed (no scores, no signature)', () => {
    process.env.GATE_TS_PEST_CHECK = 'true';
    expect(freezePestCheck({ pestCheck: review.pestCheck }, { now: NOW }).treeShrubPestCheck.insectTypes).toHaveLength(2);
  });
});

describe('completion wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  test('the freeze reads the request body alone, T&S only, outside the signature branch', () => {
    const start = src.indexOf('const treeShrubPestCheckFreeze');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(src.indexOf('const reviewSigned'));
    const block = src.slice(start, start + 300);
    expect(block).toContain("reportServiceLine === 'tree_shrub' || typedFindingsType === 'tree_shrub'");
    expect(block).toContain('freezePestCheck(completionInput.body?.treeShrubReview)');
  });
  test('one chokepoint: spread into the structuredNotes object the insert writes', () => {
    const notesStart = src.indexOf('const structuredNotes = {');
    const spread = src.indexOf('...(treeShrubPestCheckFreeze || {}),');
    expect(spread).toBeGreaterThan(notesStart);
    expect(src.indexOf('structured_notes: serializeJsonb(structuredNotes)')).toBeGreaterThan(spread);
  });
  test('nothing customer-facing reads the frozen answers', () => {
    const readers = ['services/service-report', 'routes/reports-public.js', 'routes/admin-schedule.js']
      .flatMap((rel) => {
        const full = path.join(__dirname, '..', rel);
        return fs.statSync(full).isDirectory()
          ? fs.readdirSync(full).filter((f) => f.endsWith('.js')).map((f) => path.join(full, f))
          : [full];
      });
    for (const file of readers) expect(fs.readFileSync(file, 'utf8')).not.toContain('treeShrubPestCheck');
  });
});
