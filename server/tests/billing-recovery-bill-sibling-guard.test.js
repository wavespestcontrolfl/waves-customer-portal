/**
 * billing-recovery-bill.js — the Bill mint runs #5237's in-lock
 * covered-member guard. The real-Postgres suite
 * (billing-recovery-sibling-coverage.postgres.test.js) proves the assessment
 * refusal; this pins the race half it cannot force: a stamp that lands after
 * the assessment is refused under createFromService's visit row lock.
 */
const fs = require('fs');
const path = require('path');

describe('billing-recovery-bill.js — in-lock covered-member guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/billing-recovery-bill.js'), 'utf8');

  test('billVisit passes refuseCoveredMemberMintInTrx to createFromService', () => {
    expect(source).toContain("const { refuseCoveredMemberMintInTrx } = require('./estimate-first-application-invoice');");
    const mintAt = source.indexOf('const created = await InvoiceService.createFromService(visit.service_record_id, {');
    expect(mintAt).toBeGreaterThan(-1);
    const call = source.slice(mintAt, source.indexOf('});', mintAt));
    expect(call).toContain('recheckInTrx: (conn) => refuseCoveredMemberMintInTrx(conn, scheduledServiceId),');
  });

  test('the coverage assessment ends with the sibling-coverage refusal', () => {
    expect(source).toContain('return siblingCoverageRefusal(visit, database);');
  });
});
