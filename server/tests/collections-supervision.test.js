/**
 * callSupervision — the ONE reader of per-call supervision for in-call
 * surfaces (codex #3560 P2/P0 + hook rounds): the immutable call_log stamp
 * is the only source; anything else is unsupervised (fail closed).
 */
const { callSupervision } = require('../services/collections/outbound-voice/supervision');

test.each([
  [{ collectionsSupervised: true }, true],
  [{ collectionsSupervised: false }, false],
  [{ collectionCaseId: 'case-1' }, false], // legacy stamp-less row
  [{ collectionsSupervised: 'true' }, false], // only a real boolean counts
  [{}, false],
  [null, false],
  [undefined, false],
])('callSupervision(%o) ⇒ %s', (meta, expected) => {
  expect(callSupervision(meta)).toBe(expected);
});
