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

describe('booking: address-verdict pair locks before the customer-comms fence (pre-push audit P1 after r41)', () => {
  test('the advisory pair locks are acquired ahead of lockCustomerComms in the self-booking transaction', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/booking'), 'utf8');
    const pairLock = src.indexOf("['address-verdict', key]");
    const comms = src.indexOf('await lockCustomerComms(trx, custId);');
    expect(pairLock).toBeGreaterThan(0);
    expect(pairLock).toBeLessThan(comms);
    // …and the verdict's row locks still follow the fence.
    expect(src.indexOf("const lockedDraft = await trx('estimates')")).toBeGreaterThan(comms);
  });
});

describe('codex r42: the proposal editor lifts the hold it is the only path to clear; grouped extensions claim visible siblings', () => {
  test('proposal save clears the locked block on a corrected premise or an explicit confirmAddress, keeps it otherwise', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-estimates'), 'utf8');
    const start = src.indexOf("if (lockedData.addressUnverified === true || lockedData.addressUnverifiedFlag) {");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('// A pending send is judged at the first scheduler tick', start));
    expect(block).toContain('premiseChanged(priorProposalAddress, normalized.propertyAddress)');
    expect(block).toContain("req.body?.confirmAddress === true");
    expect(block).toContain("nextData.addressUnverifiedClearedBy = addressCorrected ? 'address_corrected' : 'staff_confirmed';");
  });
  test('the extension claim stamps link-visible siblings with the same token and releases them with the anchor', () => {
    const src = require('fs').readFileSync(require.resolve('../services/estimate-extension'), 'utf8');
    const claim = src.slice(src.indexOf('const deliveryClaimToken = '), src.indexOf('let smsResult = '));
    expect(claim).toContain(".whereIn('status', ['sent', 'viewed', 'expired'])");
    expect(claim).toContain('.whereRaw(DELIVERY_CLAIM_NOT_LIVE_SQL)\n            .update({');
    expect(src).toContain('adminEstimates.clearGroupSiblingDeliveryClaims(estimate, deliveryClaimToken)');
  });
});

describe('pre-push audit after r42: group lock before claim rows; proposal clear reaches the leads', () => {
  test('both grouped delivery-claim transactions take estimate-group-send before the anchor row lock', () => {
    const ext = require('fs').readFileSync(require.resolve('../services/estimate-extension'), 'utf8');
    const claim = ext.slice(ext.indexOf('const deliveryClaimToken = '), ext.indexOf('let smsResult = '));
    expect(claim.indexOf("'estimate-group-send'")).toBeGreaterThan(0);
    expect(claim.indexOf("'estimate-group-send'")).toBeLessThan(claim.indexOf('.forUpdate()'));
    const adm = require('fs').readFileSync(require.resolve('../routes/admin-estimates'), 'utf8');
    const start = adm.indexOf('const invalidatedNow = await db.transaction');
    const send = adm.slice(start, adm.indexOf('if (invalidatedNow) {', start));
    expect(send.indexOf("'estimate-group-send'")).toBeGreaterThan(0);
    expect(send.indexOf("'estimate-group-send'")).toBeLessThan(send.indexOf('.forUpdate()'));
  });
  test('the proposal save locks the contact pair first and stamps contact-matched leads through the shared helper', () => {
    const adm = require('fs').readFileSync(require.resolve('../routes/admin-estimates'), 'utf8');
    const start = adm.indexOf('const { updatedCount, editVersion: committedEditVersion } = await db.transaction');
    const trxBody = adm.slice(start, adm.indexOf('// A pending send is judged at the first scheduler tick', start));
    expect(trxBody.indexOf("['address-verdict', contactPairLockKey(estimate.customer_email, estimate.customer_phone)]")).toBeLessThan(trxBody.indexOf("['estimate-group-send', String(groupId)]"));
    expect(trxBody).toContain('await stampContactMatchedLeadsClean(trx, {');
    const persistence = require('../services/admin-estimate-persistence');
    expect(typeof persistence.stampContactMatchedLeadsClean).toBe('function');
  });
});

describe('pre-push audit after r42: parser and lookup clean-timestamp', () => {
  test('a bare ZIP segment is never the city', () => {
    const { parseDisplayAddress } = require('../services/lead-address-unverified');
    expect(parseDisplayAddress('1260 Example St, 34219')).toMatchObject({ city: '', zip: '34219' });
    expect(parseDisplayAddress('1260 Example St, 34219-1234')).toMatchObject({ city: '', zip: '34219' });
    expect(parseDisplayAddress('1260 Example St, Parrish, FL 34219')).toMatchObject({ city: 'Parrish', zip: '34219', state: 'FL' });
  });
  test('an already-superseded lookup persists the newer clean timestamp found under the lock', () => {
    const { applyLookupVerdictPrecedence } = require('../services/lead-address-unverified');
    const out = applyLookupVerdictPrecedence({
      addressUnverified: null, staffCleanAt: '2026-09-01T00:00:00Z', cachedAuditStale: true,
      lockedCleanAt: '2026-09-03T00:00:00Z', newerFlag: null, newerFlagAt: 0, evidenceAt: 0,
    });
    expect(out).toEqual({ addressUnverified: null, staffCleanAt: '2026-09-03T00:00:00Z', cachedAuditStale: true });
    const src = require('fs').readFileSync(require.resolve('../routes/public-property-lookup'), 'utf8');
    expect(src).toContain('({ addressUnverified, staffCleanAt, cachedAuditStale } = applyLookupVerdictPrecedence({');
  });
});

describe('codex r43', () => {
  test('a grouped extension withholds its notification when any link-visible sibling is off-surface', () => {
    const ext = require('fs').readFileSync(require.resolve('../services/estimate-extension'), 'utf8');
    const claim = ext.slice(ext.indexOf('const deliveryClaimToken = '), ext.indexOf('let smsResult = '));
    // Siblings are LOCKED (id order, after the anchor) before their verdicts
    // are judged, and the claim stamps exactly that locked set.
    expect(claim).toContain(".orderBy('id')\n            .forUpdate()\n            .select('id', 'estimate_data');");
    expect(claim).toContain("if (siblings.some((sib) => estimateOffCustomerSurface({ estimate_data: sib.estimate_data }))) return false;");
    expect(claim.indexOf('return false;')).toBeLessThan(claim.indexOf('const claimedAt = '));
    expect(claim).toContain(".whereIn('id', visibleSiblingIds)");
  });
  test('the customer fan-out relaxes locality exactly as the lead does when the prior estimate had none', () => {
    const src = require('fs').readFileSync(require.resolve('../services/admin-estimate-persistence'), 'utf8');
    expect(src).toContain("samePremiseDisplay(custDisplay, lockedPrior?.address, { requireLocality: priorHasLocality })");
    expect(src).not.toContain("samePremiseDisplay(custDisplay, lockedPrior?.address, { requireLocality: true })");
  });
});

describe('codex r44', () => {
  test('the extension withholds notification unless every visible sibling took the claim', () => {
    const ext = require('fs').readFileSync(require.resolve('../services/estimate-extension'), 'utf8');
    // …by rolling the claim transaction back, never by committing partial stamps.
    expect(ext).toContain("if (Number(stamped) !== visibleSiblingIds.length) {\n            throw Object.assign(new Error('sibling delivery claim unavailable'), { code: 'SIBLING_CLAIM_UNAVAILABLE' });");
    const adm = require('fs').readFileSync(require.resolve('../routes/admin-estimates'), 'utf8');
    expect(adm).toContain("if (Number(stamped) !== siblingIds.length) {\n            throw Object.assign(new Error('sibling delivery claim unavailable'), { code: 'SIBLING_CLAIM_UNAVAILABLE' });");
    expect(adm).toContain("if (claimErr?.code === 'SIBLING_CLAIM_UNAVAILABLE') return 'sibling_claim_unavailable';");
  });
  test('never-published expired siblings are outside both link-visible selectors', () => {
    const adm = require('fs').readFileSync(require.resolve('../routes/admin-estimates'), 'utf8');
    expect(adm.split("COALESCE(disposition, '') <> 'expired_unsent'").length - 1).toBeGreaterThanOrEqual(2);
  });
  test('one shared contact-pair verdict read and precedence decision', () => {
    const svc = require('../services/lead-address-unverified');
    expect(typeof svc.loadContactVerdicts).toBe('function');
    const flag = { address_line1: '1260 Example St', flagged_at: '2026-09-02T00:00:00Z' };
    const verdicts = { newestFlag: flag, newestFlagAt: Date.parse(flag.flagged_at), newestCleanAt: Date.parse('2026-09-03T00:00:00Z') };
    expect(svc.reconcileVerdictPrecedence({ verdicts, blocked: null, cleanAt: 0 })).toEqual({});
    expect(svc.reconcileVerdictPrecedence({ verdicts: { ...verdicts, newestCleanAt: 0 }, blocked: null, cleanAt: Date.parse('2026-09-01T00:00:00Z') })).toEqual({ newerFlag: flag });
    expect(svc.reconcileVerdictPrecedence({ verdicts, blocked: flag })).toEqual({ newerClean: '2026-09-03T00:00:00.000Z' });
    const older = { address_line1: '1260 Example St', flagged_at: '2026-08-01T00:00:00Z' };
    expect(svc.reconcileVerdictPrecedence({ verdicts: { ...verdicts, newestCleanAt: 0 }, blocked: older, extraFlags: [older] })).toEqual({ newerFlag: flag });
    const pq = require('fs').readFileSync(require.resolve('../routes/public-quote'), 'utf8');
    const ppl = require('fs').readFileSync(require.resolve('../routes/public-property-lookup'), 'utf8');
    expect(pq).toContain('const verdicts = await loadContactVerdicts(trx, { email: contactEmail, phone: contactPhone, premise: normalizedAddress');
    expect(ppl).toContain('const verdicts = await loadContactVerdicts(conn, { email, phone: normPhone, premise: normalizedAddress, ownLeadId: lead.id });');
  });
});

describe('codex r45', () => {
  test('the accept recheck answers the re-price 409 before the generic off-surface 404', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/estimate-public'), 'utf8');
    const start = src.indexOf("const freshLinkRow = await trx('estimates')");
    const block = src.slice(start, start + 4000);
    expect(block.indexOf('repricePendingActive(eng)')).toBeLessThan(block.indexOf("estimateOffCustomerSurface({ estimate_data: freshLinkData })"));
  });
  test('/calculate holds a delivery claim on the linked estimate across the email and SMS sends', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/public-quote'), 'utf8');
    const claim = src.indexOf('let quoteDeliveryClaimToken = null;');
    expect(claim).toBeGreaterThan(0);
    expect(claim).toBeLessThan(src.indexOf('await sendQuoteRequestEmail({'));
    const block = src.slice(claim, src.indexOf('await sendQuoteRequestEmail({'));
    expect(block).toContain('.whereRaw(ADDRESS_UNVERIFIED_ABSENT_SQL)');
    expect(block).toContain('.whereRaw(DELIVERY_CLAIM_NOT_LIVE_SQL)');
    expect(block).toContain("jsonb_build_object('delivering_at', ?::text, 'delivering_token', ?::text)");
    const release = src.indexOf("require('./admin-estimates').clearEstimateDeliveryClaim(draftEstimateId, quoteDeliveryClaimToken)");
    expect(release).toBeGreaterThan(src.indexOf('Customer SMS failed'));
  });
  test('the lookup lifts legacy blocks through the withdrawal service', () => {
    const w = require('../services/website-quote-withdrawal');
    expect(typeof w.liftLegacyBlocksForCleanVerdict).toBe('function');
    const src = require('fs').readFileSync(require.resolve('../routes/public-property-lookup'), 'utf8');
    expect(src).toContain('const lifted = await liftLegacyBlocksForCleanVerdict(trx, {');
  });
});
