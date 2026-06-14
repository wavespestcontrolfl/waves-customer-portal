const { buildConsensus, reconcile, _internals } = require('../services/turf-height-ocr');

const m = (model, height_in, confidence, readable = true) => ({ model, height_in, confidence, readable });

describe('turf-ocr: parseGaugeJson', () => {
  test('parses + clamps confidence, requires a finite height for readable', () => {
    expect(_internals.parseGaugeJson('{"height_in":4,"confidence":0.9,"readable":true}'))
      .toEqual({ height_in: 4, confidence: 0.9, readable: true });
    expect(_internals.parseGaugeJson('```json\n{"height_in":3.5,"confidence":1.4,"readable":true}\n```'))
      .toEqual({ height_in: 3.5, confidence: 1, readable: true }); // confidence clamped
    expect(_internals.parseGaugeJson('{"height_in":null,"confidence":0.2,"readable":true}'))
      .toEqual({ height_in: null, confidence: 0.2, readable: false }); // no height → not readable
  });
  test('null / unparseable → null', () => {
    expect(_internals.parseGaugeJson('')).toBeNull();
    expect(_internals.parseGaugeJson('not json')).toBeNull();
  });
});

describe('turf-ocr: buildConsensus', () => {
  test('both readable + agree → mean, full confidence', () => {
    const c = buildConsensus([m('claude', 4.0, 0.9), m('gemini', 4.0, 0.8)]);
    expect(c.ocr_height_in).toBe(4.0);
    expect(c.ocr_confidence).toBeCloseTo(0.85, 2);
    expect(c.readableCount).toBe(2);
  });
  test('both readable but differ > 0.5" → confidence halved', () => {
    const c = buildConsensus([m('claude', 4.0, 0.9), m('gemini', 5.0, 0.9)]); // spread 0.5 from mean 4.5
    expect(c.ocr_height_in).toBe(4.5);
    expect(c.ocr_confidence).toBeCloseTo(0.45, 2); // 0.9 × 0.5
  });
  test('one readable → discounted confidence', () => {
    const c = buildConsensus([m('claude', 4.0, 1.0), null]);
    expect(c.ocr_height_in).toBe(4.0);
    expect(c.ocr_confidence).toBeCloseTo(0.7, 2);
    expect(c.readableCount).toBe(1);
  });
  test('none readable → null height, readableCount 0', () => {
    const c = buildConsensus([m('claude', null, 0, false), m('gemini', 3, 0.2, false)]);
    expect(c.ocr_height_in).toBeNull();
    expect(c.readableCount).toBe(0);
  });
  test('modelCount separates infra miss (no responders) from unreadable gauge', () => {
    // both calls failed / were skipped → no model responded (infra) → stay pending
    const infra = buildConsensus([null, null]);
    expect(infra.modelCount).toBe(0);
    expect(infra.readableCount).toBe(0);
    // both responded but neither could read the gauge → genuine ocr_failed
    const unreadable = buildConsensus([m('claude', null, 0, false), m('gemini', 3, 0.2, false)]);
    expect(unreadable.modelCount).toBe(2);
    expect(unreadable.readableCount).toBe(0);
  });
});

describe('turf-ocr: reconcile vs manual (source of truth)', () => {
  test('within 0.5" + confident → verified', () => {
    expect(reconcile(4.0, { ocr_height_in: 4.0, ocr_confidence: 0.85, readableCount: 2 })).toBe('verified');
    expect(reconcile(4.0, { ocr_height_in: 3.5, ocr_confidence: 0.6, readableCount: 2 })).toBe('verified'); // exactly 0.5
  });
  test('diverges > 0.5" → discrepancy', () => {
    expect(reconcile(4.0, { ocr_height_in: 5.0, ocr_confidence: 0.9, readableCount: 2 })).toBe('discrepancy');
  });
  test('low confidence → discrepancy even if close', () => {
    expect(reconcile(4.0, { ocr_height_in: 4.0, ocr_confidence: 0.3, readableCount: 2 })).toBe('discrepancy');
  });
  test('nothing readable → ocr_failed', () => {
    expect(reconcile(4.0, { ocr_height_in: null, ocr_confidence: 0, readableCount: 0 })).toBe('ocr_failed');
    expect(reconcile(4.0, null)).toBe('ocr_failed');
  });
});
