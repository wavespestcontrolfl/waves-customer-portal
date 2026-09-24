// Source pins for the codex #4667 r41 P1 fixes: clean address verdicts are
// judged per contact pair at booking, and grouped sends claim every
// link-visible sibling before the provider handoff.
const fs = require('fs');

describe('booking: clean county verdicts supersede only the SAME contact pair\'s flag (codex r41 P1)', () => {
  const src = fs.readFileSync(require.resolve('../routes/booking'), 'utf8');
  const block = src.slice(src.indexOf('const pairKeyOf = '), src.indexOf('// Free re-service lane dedupe'));
  test('clean evidence is keyed by the lead row\'s own email + phone', () => {
    expect(block).toContain('const newestCleanByPair = new Map();');
    expect(block).toContain(".select('id', 'email', 'phone', 'extracted_data')");
    expect(block).toContain('newestCleanByPair.set(key, Math.max(newestCleanByPair.get(key) || 0, at));');
    expect(block).not.toMatch(/\bnewestClean\b(?!ByPair)/);
  });
  test('the named lead and every cross-lead flag compare against their own pair\'s clean verdict', () => {
    expect(block).toContain("forUpdate().first('email', 'phone', 'extracted_data')");
    expect(block).toContain('newestCleanByPair.get(pairKeyOf(lockedLead))');
    expect(block).toContain('for (const { pairKey, snap } of contactSnapshots) {');
    expect(block).toContain('const cleanForPair = newestCleanByPair.get(pairKey) || 0;');
  });
});

describe('admin send: every link-visible group member carries the delivery claim (codex r41 P1)', () => {
  const src = fs.readFileSync(require.resolve('../routes/admin-estimates'), 'utf8');
  test('the claim transaction stamps siblings under the not-live predicate with the same token', () => {
    const claim = src.slice(src.indexOf('const invalidatedNow = await db.transaction'), src.indexOf('if (invalidatedNow) {'));
    expect(claim).toContain("const siblingIds = linkVisibleGroupIds.filter((id) => String(id) !== String(estimate.id));");
    expect(claim).toContain('.whereRaw(DELIVERY_CLAIM_NOT_LIVE_SQL)');
    expect(claim).toContain("jsonb_build_object('delivering_at', ?::text, 'delivering_token', ?::text)");
    expect(claim).toContain('[data.estimatorEngine.delivering_at, deliveryClaimToken]');
  });
  test('the outer finally releases the siblings token-fenced next to the anchor', () => {
    expect(src).toContain('await clearEstimateDeliveryClaim(estimate?.id, deliveryClaimToken);\n    await clearGroupSiblingDeliveryClaims(estimate, deliveryClaimToken);');
    const rel = src.slice(src.indexOf('async function clearGroupSiblingDeliveryClaims'), src.indexOf('async function clearEstimateDeliveryClaim'));
    expect(rel).toContain("estimate_data->'estimatorEngine'->>'delivering_token' = ?");
    expect(rel).toContain("- 'delivering_at' - 'delivering_token'");
  });
});

describe('staff revision of a flagged draft: customer-comms fence before the row locks (pre-push audit P1 after r41)', () => {
  test('property-preferences advisory → customer-comms → customer row → estimate row', () => {
    const src = require('fs').readFileSync(require.resolve('../services/admin-estimate-persistence'), 'utf8');
    const start = src.indexOf("['property-preferences', String(synced.customer_id)]");
    const block = src.slice(start, src.indexOf('const lockedPrior = await trx', start));
    expect(block).toContain(".lockCustomerComms(trx, synced.customer_id);");
    expect(block.indexOf('.lockCustomerComms(')).toBeLessThan(block.indexOf(".forUpdate().first('id')"));
  });
});
