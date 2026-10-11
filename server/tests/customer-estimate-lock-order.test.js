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
const LOCK = 'lockCustomerEstimatesForEstimate(trx';
const LOCKS_AFTER = /pg_advisory_xact_lock|lockCustomerComms\(|lockInspectionCreditCustomer\(/;

// [name, file, how the estimate row is locked before the leaf lock]
const SITES = [
  ['public-quote refresh', '../routes/public-quote', 'lockCustomerEstimatesForEstimate(trx, { ...existingEst, ...estFields })', /\.forUpdate\(\)/],
  ['admin unarchive', '../routes/admin-estimates', "const locked = await trx('estimates').where({ id: req.params.id }).forUpdate().first();", null],
  ['admin proposal revival', '../routes/admin-estimates', 'if (revivingBid) await require', /const locked = await trx\('estimates'\)\.where\(\{ id: estimate\.id \}\)\.forUpdate\(\)/],
  ['extendEstimate', '../services/estimate-extension', 'lockCustomerEstimatesForEstimate(trx, anchor)', /\.forUpdate\(\)/],
];

describe('customer estimate lock order (row lock first, then the leaf lock)', () => {
  test.each(SITES)('%s locks the estimate row before the per-customer lock', (name, rel, anchor, rowLock) => {
    const src = read(rel);
    const at = src.indexOf(anchor);
    expect(at).toBeGreaterThan(-1);
    if (name === 'admin unarchive') {
      const unarchive = src.indexOf("router.post('/:id/unarchive'");
      const row = src.indexOf("const locked = await trx('estimates').where({ id: req.params.id }).forUpdate().first();", unarchive);
      const leaf = src.indexOf(LOCK, unarchive);
      expect(row).toBeGreaterThan(unarchive);
      expect(leaf).toBeGreaterThan(row);
      return;
    }
    const before = src.slice(Math.max(0, at - 12000), at);
    expect(before).toMatch(rowLock);
  });

  test.each(SITES.filter((s) => s[0] !== 'admin unarchive'))('%s takes no other lock after the leaf lock', (name, rel, anchor) => {
    const src = read(rel);
    const at = src.indexOf(anchor);
    const after = src.slice(at + anchor.length, at + anchor.length + 400);
    expect(after).not.toMatch(LOCKS_AFTER);
  });

  test('the admin unarchive no longer takes the advisory lock before the row', () => {
    const src = read('../routes/admin-estimates');
    const unarchive = src.indexOf("router.post('/:id/unarchive'");
    const tx = src.indexOf('db.transaction(async (trx) => {', unarchive);
    expect(src.slice(tx, tx + 200)).toContain("forUpdate().first()");
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

  test('the reopen-site lock aborts, locking nothing, when the prospective owner lookup fails (round 11)', async () => {
    const RecurringCof = require('../services/recurring-card-on-file');
    const spy = jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: null, lookupFailed: true });
    const trx = { raw: jest.fn() };
    await expect(require('../utils/customer-estimate-lock').lockCustomerEstimatesForEstimate(trx, { id: 'e1', customer_id: 'cust-1' }))
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

  test('the lock module exports only the two lock functions', () => {
    expect(Object.keys(require('../utils/customer-estimate-lock')).sort()).toEqual(['lockCustomerEstimates', 'lockCustomerEstimatesForEstimate']);
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
