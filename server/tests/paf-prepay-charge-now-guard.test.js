// GATE_PAF_PREPAY: Charge Now at the door must read a deferred annual-prepay
// hold strictly. A failed read refuses (503, retryable) and a held visit
// refuses (409), both BEFORE the invoice mint, so no door invoice sits beside
// the year's charge.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

describe('Charge Now deferred annual-prepay guard (source pins)', () => {
  const guard = src.indexOf("pafDeferredPrepayCoversVisit(svc, db, { throwOnError: true })");
  const coveredBlock = src.indexOf("annualPrepayCoversVisit(svc)) {\n      return res.status(409)");
  const mint = src.indexOf('const applyPrepaidCredit = async (invoice) => {');

  test('the strict deferred read runs before the stamped-coverage block and the mint', () => {
    expect(guard).toBeGreaterThan(0);
    expect(coveredBlock).toBeGreaterThan(guard);
    expect(mint).toBeGreaterThan(coveredBlock);
  });

  test('a failed read refuses with a retryable 503 and a held visit with 409', () => {
    const block = src.slice(guard - 400, coveredBlock);
    expect(block).toMatch(/if \(!svc\.prepaid_method\) \{/);
    expect(block).toMatch(/return res\.status\(503\)\.json\(\{[^}]*code: 'deferred_prepay_lookup_failed' \}\)/);
    expect(block).toMatch(/if \(deferredCovered\) \{\s*return res\.status\(409\)/);
  });
});
