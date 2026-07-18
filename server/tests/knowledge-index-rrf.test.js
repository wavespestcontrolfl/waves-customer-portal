const { rrfFuse, RRF_K } = require('../services/knowledge-index/hybrid-search');

const item = (key, extra = {}) => ({ key, source: key.split(':')[0], sourceId: key.split(':')[1], ...extra });

describe('knowledge-index RRF fusion', () => {
  test('empty lists fuse to empty', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[], []])).toEqual([]);
  });

  test('consensus across lists beats a single first-place vote', () => {
    // doc B is rank 2 in three lists; doc A is rank 1 in one list only.
    const lists = [
      [item('kb:a'), item('kb:b')],
      [item('wiki:x'), item('kb:b')],
      [item('service:y'), item('kb:b')],
    ];
    const fused = rrfFuse(lists);
    expect(fused[0].key).toBe('kb:b');
    expect(fused[0].hits).toBe(3);
    // 3/(k+2) > 1/(k+1)
    expect(fused[0].score).toBeCloseTo(3 / (RRF_K + 2), 10);
  });

  test('chunk collapse: repeated keys within one list count once, at best rank', () => {
    const lists = [[item('kb:a'), item('kb:a'), item('kb:a'), item('wiki:b')]];
    const fused = rrfFuse(lists);
    expect(fused).toHaveLength(2);
    const a = fused.find((f) => f.key === 'kb:a');
    expect(a.score).toBeCloseTo(1 / (RRF_K + 1), 10);
    // wiki:b is rank 2 — the duplicate kb:a entries must not push it to rank 4
    const b = fused.find((f) => f.key === 'wiki:b');
    expect(b.score).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  test('payload of first sighting is preserved', () => {
    const fused = rrfFuse([[item('kb:a', { title: 'First', snippet: 'S' })], [item('kb:a', { title: 'Second' })]]);
    expect(fused[0].title).toBe('First');
    expect(fused[0].snippet).toBe('S');
  });

  test('null/empty list entries are ignored', () => {
    const fused = rrfFuse([[null, item('kb:a'), undefined], null, [item('kb:a')]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].hits).toBe(2);
  });
});
