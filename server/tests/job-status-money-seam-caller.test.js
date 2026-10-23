/**
 * transitionJobStatus `moneySeam: 'caller'` (opt-in; the Intelligence Bar cancel card's Dispatch replay). The shared
 * writer's post-commit invoice void + inspection-credit reversal runs UNPINNED on live money state; a caller that
 * runs that cleanup itself on the effects it was shown passes moneySeam 'caller' so the unpinned seam stands down.
 * Every other caller keeps the seam. Source-text guard, in the style of this repo's other writer guards.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../services/job-status.js'), 'utf8');

test('the unpinned money seam is skipped only for moneySeam "caller"', () => {
  expect(src).toMatch(/if \(moneySeam !== 'caller'\) \{\s*\n\s*void require\('\.\/invoice'\)\.voidOpenInvoicesForCancelledService\(jobId\)/);
  // The seam still exists for the default path, in the same non-live branch (cancelled / skipped / no_show).
  expect(src.match(/voidOpenInvoicesForCancelledService\(jobId\)/g)).toHaveLength(1);
});

test('moneySeam is an explicit, opt-in parameter with no default that skips the seam', () => {
  expect(src).toMatch(/holdCompletionOutcome = 'performed',\s*\n(?:\s*\/\/.*\n)*\s*moneySeam,/);
});
