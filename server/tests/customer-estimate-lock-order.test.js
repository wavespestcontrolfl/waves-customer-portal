/**
 * The per-customer estimate lock (utils/customer-estimate-lock.js, a leaf) is taken only by writers that
 * CREATE or REOPEN an estimate for a customer, because start_program's guard asks one question: does this
 * customer have ANY open estimate? Reopening sites take the estimate ROW lock first, then the leaf lock,
 * and no other lock after it. A pure revision of an already-open estimate (reprice, service opt-in/out,
 * the lead-webhook triage rewrite, the existing intake shell rewrite) cannot change the answer and takes
 * no leaf lock.
 */
const fs = require('fs');

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8');
const LOCKS_AFTER = /pg_advisory_xact_lock|lockCustomerComms\(|lockInspectionCreditCustomer\(/;

// [name, file, anchor of the advisory (leaf) lock call]
const SITES = [
  ['public-quote refresh', '../routes/public-quote', 'lockCustomerEstimatesForEstimate(trx, { ...existingEst, ...estFields })'],
  ['admin unarchive', '../routes/admin-estimates', 'lockCustomerEstimatesForEstimate(trx, locked)'],
  ['admin proposal revival', '../routes/admin-estimates', 'lockCustomerEstimatesForEstimate(trx, { ...estimate, ...locked })'],
  ['extendEstimate', '../services/estimate-extension', 'lockCustomerEstimatesForEstimate(trx, anchor)'],
];

// Round 13: customer row (KEY SHARE) -> estimate row (FOR UPDATE) -> advisory lock, at every reopening site. The merge
// locks customer rows first and repoints estimates second; a site that held the estimate row and then asked for the
// customer row could deadlock with it.
const ROW_FIRST = [
  ['public-quote refresh', '../routes/public-quote', 'lockCustomerRowsForEstimate(trx, { ...existingEst, ...estFields })', "trx('estimates')\n            .where({ id: existingEst.id })\n            .forUpdate()"],
  ['admin unarchive', '../routes/admin-estimates', 'lockCustomerRowsForEstimate(trx, estimate)', "const locked = await trx('estimates').where({ id: req.params.id }).forUpdate().first();"],
  ['admin proposal revival', '../routes/admin-estimates', 'if (revivingBid) await require(\'../utils/customer-estimate-lock\').lockCustomerRowsForEstimate(trx, estimate)', "const locked = await trx('estimates').where({ id: estimate.id }).forUpdate().first();"],
  ['extendEstimate', '../services/estimate-extension', 'lockCustomerRowsForEstimate(trx, estimate)', "const locked = await trx('estimates').where({ estimate_group_id: estimate.estimate_group_id })"],
];

describe('customer estimate lock order (customer row, then estimate row, then the leaf lock)', () => {
  test.each(ROW_FIRST)('%s takes the customer row share before the estimate row lock', (name, rel, customerLock, rowLock) => {
    const src = read(rel);
    const customerAt = src.indexOf(customerLock);
    expect(customerAt).toBeGreaterThan(-1);
    const rowAt = src.indexOf(rowLock, customerAt);
    expect(rowAt).toBeGreaterThan(customerAt);
    // no estimate row lock sits between the start of the same transaction and the customer lock
    const txStart = src.lastIndexOf('db.transaction(', customerAt);
    expect(src.slice(txStart, customerAt)).not.toMatch(/trx\('estimates'\)[^;]*\.forUpdate\(\)/);
  });

  test.each(SITES)('%s takes the advisory lock after the estimate row lock', (name, rel, anchor) => {
    const src = read(rel);
    const at = src.indexOf(anchor);
    expect(at).toBeGreaterThan(-1);
    const rowLock = ROW_FIRST.find((r) => r[0] === name)[3];
    const rowAt = src.indexOf(rowLock, src.indexOf(ROW_FIRST.find((r) => r[0] === name)[2]));
    expect(rowAt).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(rowAt);
  });

  test.each([
    ['admin unarchive', '../routes/admin-estimates', "if ((locked.customer_id || null) !== (estimate.customer_id || null)) return { ownerChanged: true };"],
    ['admin proposal revival', '../routes/admin-estimates', 'if (revivingBid && (locked.customer_id'],
    ['extendEstimate', '../services/estimate-extension', "code = 'estimate_owner_changed'"],
  ])('%s refuses when the locked estimate moved to another customer', (name, rel, anchor) => {
    expect(read(rel)).toContain(anchor);
  });

  test('public-quote refresh refuses to refresh a draft that moved to another customer', () => {
    expect(read('../routes/public-quote')).toContain("(lockedEst.customer_id || null) !== (existingEst.customer_id || null)) return;");
  });

  test('the customer-row helper locks rows only (no advisory lock)', async () => {
    const RecurringCof = require('../services/recurring-card-on-file');
    const spy = jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: 'c2', lookupFailed: false });
    const calls = [];
    const trx = Object.assign((table) => {
      const b = { where: (w) => { calls.push(['where', table, w.id]); return b; }, forKeyShare: () => { calls.push(['forKeyShare']); return b; }, first: async () => ({}) };
      return b;
    }, { raw: jest.fn() });
    await require('../utils/customer-estimate-lock').lockCustomerRowsForEstimate(trx, { id: 'e1', customer_id: 'c1' });
    expect(trx.raw).not.toHaveBeenCalled();
    expect(calls.filter((c) => c[0] === 'where').map((c) => c[2])).toEqual(['c1', 'c2']);
    spy.mockRestore();
  });

  test.each(SITES.filter((s) => s[0] !== 'admin unarchive'))('%s takes no other lock after the leaf lock', (name, rel, anchor) => {
    const src = read(rel);
    const at = src.indexOf(anchor);
    const after = src.slice(at + anchor.length, at + anchor.length + 400);
    expect(after).not.toMatch(LOCKS_AFTER);
  });

  test('the admin unarchive takes the customer row share, then the estimate row, before any advisory lock', () => {
    const src = read('../routes/admin-estimates');
    const unarchive = src.indexOf("router.post('/:id/unarchive'");
    const tx = src.indexOf('db.transaction(async (trx) => {', unarchive);
    expect(src.slice(tx, tx + 400)).toContain('lockCustomerRowsForEstimate(trx, estimate)');
    expect(src.slice(tx, tx + 600)).toContain("forUpdate().first()");
  });

  test('pure revision sites of an open estimate take no per-customer estimate lock', () => {
    const revisionSites = [
      ['../services/admin-estimate-persistence', 'async function reviseAdminEstimate('],
      ['../services/intelligence-bar/estimate-tools', 'async function reviseOwnedAgentDraft('],
      ['../routes/estimate-public', 'async function applyServiceMixChange('],
    ];
    for (const [rel, fnStart] of revisionSites) {
      const src = read(rel);
      const start = src.indexOf(fnStart);
      expect(start).toBeGreaterThan(-1);
      const next = src.indexOf('\nasync function ', start + 10);
      const body = src.slice(start, next > 0 ? next : undefined);
      expect(body).not.toContain('lockCustomerEstimates');
    }
  });

  test('the lead-webhook triage rewrite is not wrapped in a lock; only the draft insert is', () => {
    const src = read('../routes/lead-webhook');
    expect(src.split('lockCustomerEstimates(').length - 1).toBe(1);
  });

  test('the intake shell rewrite only edits a live draft: it never reopens a closed estimate', () => {
    const src = read('../services/lead-intake');
    const start = src.indexOf('if (existingDraft) {');
    const end = src.indexOf('const token = crypto.randomBytes', start);
    const branch = src.slice(start, end);
    expect(branch).toContain(".whereNull('archived_at').update(updates)");
    expect(branch).not.toMatch(/status:|archived_at:\s*null|lockCustomerEstimates/);
    // The shell it finds is a still-draft, unarchived row.
    expect(src.slice(src.indexOf('const existingDraft'), start)).toMatch(/status: 'draft'[\s\S]*whereNull\('archived_at'\)/);
  });

  test('the unarchive resolves the lock owner from the locked row and refuses when the owner moved (round 9)', () => {
    const src = read('../routes/admin-estimates');
    const start = src.indexOf("router.post('/:id/unarchive'");
    const body = src.slice(start, src.indexOf("router.post('/:id/follow-up'", start));
    expect(body).toContain('lockCustomerEstimatesForEstimate(trx, locked)');
    expect(body).not.toContain('lockCustomerEstimatesForEstimate(trx, estimate)');
    expect(body).toContain("code: 'estimate_owner_changed'");
  });

  test('the reopen-site lock aborts, locking nothing, when an OWNERLESS estimate owner lookup fails (round 11)', async () => {
    const RecurringCof = require('../services/recurring-card-on-file');
    const spy = jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: null, lookupFailed: true });
    const trx = { raw: jest.fn() };
    await expect(require('../utils/customer-estimate-lock').lockCustomerEstimatesForEstimate(trx, { id: 'e1', customer_id: null }))
      .rejects.toMatchObject({ code: 'ESTIMATE_OWNER_UNVERIFIED', statusCode: 503 });
    expect(trx.raw).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('one-tap init takes the customer row before the estimate lock, as start_program does (round 8)', () => {
    const src = read('../services/one-tap-purchase');
    const row = src.indexOf("await trx('customers').where({ id: customerId }).forKeyShare().first('id');");
    const leaf = src.indexOf('lockCustomerEstimates(trx, customerId)');
    const insert = src.indexOf("trx('estimates').insert(", leaf);
    expect(row).toBeGreaterThan(-1);
    expect(leaf).toBeGreaterThan(row);
    expect(insert).toBeGreaterThan(leaf);
    // start_program (which holds the row FOR UPDATE, then the estimate lock) is the other side of the pair.
    expect(read('../services/intelligence-bar/start-program')).toContain('forUpdate()');
  });

  test('the lock module exports only the lock functions', () => {
    expect(Object.keys(require('../utils/customer-estimate-lock')).sort()).toEqual(['lockCustomerEstimates', 'lockCustomerEstimatesForEstimate', 'lockCustomerRowsForEstimate']);
  });

  test('every reopen site that may hold a null customer_id locks the prospective owner too (round 5)', () => {
    const sites = [
      ['../routes/admin-estimates', "lockCustomerEstimatesForEstimate(trx, locked);", 'unarchive'],
      ['../routes/admin-estimates', 'lockCustomerEstimatesForEstimate(trx, { ...estimate, ...locked })', 'revival'],
      ['../services/estimate-extension', 'lockCustomerEstimatesForEstimate(trx, anchor)', 'extend'],
      ['../routes/public-quote', 'lockCustomerEstimatesForEstimate(trx, { ...existingEst, ...estFields })', 'refresh'],
    ];
    for (const [rel, anchor] of sites) expect(read(rel)).toContain(anchor);
  });

  test('an unlinked estimate insert locks the customer the accept would resolve, before the insert', () => {
    const src = read('../services/email/email-actions');
    const lock = src.indexOf('lockCustomerEstimates(trx, prospectiveOwnerId)');
    const insert = src.indexOf('customer_id: null', lock);
    expect(lock).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(lock);
    expect(src.slice(0, lock)).toMatch(/resolveProspectiveAcceptCustomer\(/);
  });
});

// Round 12: the customer ROW (FOR KEY SHARE) comes before the advisory lock at every site. The helper does it for all of
// its callers; the sites below are the ones that INSERT or revive an estimate and so meet the customer foreign key.
describe('customer row first, then the estimate advisory lock (round 12)', () => {
  const INSERT_SITES = [
    ['lead webhook estimate insert', '../routes/lead-webhook', "lockCustomerEstimates(trx, customer.id);\n          const [estimateRow] = await trx('estimates').insert({"],
    ['lead intake', '../services/lead-intake', 'lockCustomerEstimates(trx, customer.id)'],
    ['lead response tools', '../services/lead-response-tools', 'lockCustomerEstimates(trx, input.customer_id)'],
    ['public quote draft', '../routes/public-quote', 'lockCustomerEstimates(trx, customerId)'],
    ['one-tap purchase', '../services/one-tap-purchase', 'lockCustomerEstimates(trx, customerId)'],
    ['admin estimate persistence', '../services/admin-estimate-persistence', 'lockCustomerEstimatesForEstimate(trx, writeFields)'],
    ['email lead draft', '../services/email/email-actions', 'lockCustomerEstimates(trx, prospectiveOwnerId)'],
    ['estimate tools (recognized)', '../services/intelligence-bar/estimate-tools', 'lockCustomerEstimates(trx, recognizedCustomerId)'],
    ['estimate tools (account pricing)', '../services/intelligence-bar/estimate-tools', 'lockCustomerEstimates(trx, accountPricing.customerId || null)'],
    ['estimator draft builder', '../services/estimator-engine/draft-builder', 'lockCustomerEstimates(trx,'],
    ['booking predraft', '../services/estimator-engine/booking-predraft', 'lockCustomerEstimates(trx, customer.id)'],
    ['click estimate mint', '../services/service-report/click-estimate-mint', 'lockCustomerEstimates(trx, freshCustomer.id)'],
    ['cancellation restart', '../services/cancellation-resolution/restart', 'lockCustomerEstimates(trx, fresh.id)'],
  ];
  test.each(INSERT_SITES)('%s takes the lock through the shared helper (which shares the customer row first)', (name, rel, anchor) => {
    const src = read(rel);
    expect(src).toContain(anchor);
    expect(src).not.toMatch(/hashtextextended\(\?, 0\)[^]{0,80}customer-estimates:/);
  });
  test('the lead webhook locks the customer before the estimate insert, with nothing between that touches estimates', () => {
    const src = read('../routes/lead-webhook');
    const at = src.indexOf("lockCustomerEstimates(trx, customer.id);\n          const [estimateRow] = await trx('estimates').insert({");
    expect(at).toBeGreaterThan(-1);
  });
  test('the helper share-locks every customer row BEFORE the first advisory lock', () => {
    const src = read('../utils/customer-estimate-lock');
    const fn = src.slice(src.indexOf('async function lockCustomersThenEstimates'));
    expect(fn.indexOf('forKeyShare()')).toBeGreaterThan(-1);
    expect(fn.indexOf('forKeyShare()')).toBeLessThan(fn.indexOf('pg_advisory_xact_lock'));
  });
  test('the rails lock the customer row FOR UPDATE ahead of the estimate lock', () => {
    const src = read('../services/scheduling/approved-booking-rails');
    expect(src.indexOf('.forUpdate().first')).toBeLessThan(src.indexOf('lockCustomerEstimates(trx, ctx.customerId)'));
  });
});
