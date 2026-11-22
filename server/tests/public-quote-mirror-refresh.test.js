/**
 * Public quote wizard — estimate-mirror duplicate handling.
 *
 * Found live 2026-06-12: the owner ran the wizard twice with the same phone
 * (first run diverted to a commercial manual quote, second run priced
 * $36/mo). The second run created a new lead, so the lead_id-keyed mirror
 * lookup missed, and blockIfAutomatedEstimateDuplicate hard-blocked the
 * insert on the phone match — the pipeline kept the stale commercial draft
 * and silently dropped the priced quote.
 *
 * Rule under test: a same-phone re-run may refresh ONLY the wizard's own
 * open draft; estimates from any other source, or already promoted past
 * draft, keep the hard block.
 *
 * Owner 2026-11-21, "build" (GATE_WIZARD_SUPERSEDES_FORM_DRAFT): one more
 * case. An old web-form draft with no price that nobody touched no longer
 * blocks: the wizard goes on and archives it once its own draft is written.
 * planFormShellClear decides WHEN the wizard may try that; which rows count
 * as untouched is one SQL rule, proven on real Postgres in
 * wizard-form-shell-retire-postgres.test.js.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The pure helpers stay real; the two database steps are stand-ins.
jest.mock('../services/estimate-automation-duplicates', () => ({
  ...jest.requireActual('../services/estimate-automation-duplicates'),
  lockUntouchedWebFormShellsInTx: jest.fn(),
  archiveWebFormShellsInTx: jest.fn(),
}));

const { _internals } = require('../routes/public-quote');
const {
  lockUntouchedWebFormShellsInTx,
  archiveWebFormShellsInTx,
} = require('../services/estimate-automation-duplicates');

const { shouldRefreshWizardDraft, planFormShellClear } = _internals;

describe('shouldRefreshWizardDraft', () => {
  const block = (overrides = {}) => ({
    blocked: true,
    reason: 'duplicate_phone',
    existingEstimateId: 'e-1',
    existingStatus: 'draft',
    existingSource: 'quote_wizard',
    ...overrides,
  });

  test('wizard draft duplicate → refresh', () => {
    expect(shouldRefreshWizardDraft(block())).toBe(true);
  });

  test('admin-created estimate keeps the hard block', () => {
    expect(shouldRefreshWizardDraft(block({ existingSource: 'admin' }))).toBe(false);
    expect(shouldRefreshWizardDraft(block({ existingSource: 'tech' }))).toBe(false);
    expect(shouldRefreshWizardDraft(block({ existingSource: null }))).toBe(false);
  });

  test('wizard draft promoted past draft keeps the hard block', () => {
    expect(shouldRefreshWizardDraft(block({ existingStatus: 'sent' }))).toBe(false);
    expect(shouldRefreshWizardDraft(block({ existingStatus: 'viewed' }))).toBe(false);
    expect(shouldRefreshWizardDraft(block({ existingStatus: 'scheduled' }))).toBe(false);
  });

  test('no duplicate → no refresh decision', () => {
    expect(shouldRefreshWizardDraft(null)).toBe(false);
    expect(shouldRefreshWizardDraft(undefined)).toBe(false);
  });
});

describe('planFormShellClear (GATE_WIZARD_SUPERSEDES_FORM_DRAFT)', () => {
  const GATE = 'GATE_WIZARD_SUPERSEDES_FORM_DRAFT';
  const trx = { name: 'trx' };
  const formShell = { blocked: true, reason: 'duplicate_phone', existingEstimateId: 'shell-1', existingStatus: 'draft', existingSource: 'lead_webhook' };
  const wizardDraft = { blocked: true, reason: 'duplicate_phone', existingEstimateId: 'wiz-1', existingStatus: 'draft', existingSource: 'quote_wizard' };
  let calls;
  let lockContactPair;
  const HOME = '12 Sample St, Parrish, FL 34219';
  const run = (block) => planFormShellClear(trx, block, { phone: '+19415550142', address: HOME, leadId: 'lead-9', lockContactPair });

  beforeEach(() => {
    calls = [];
    lockContactPair = jest.fn(async () => { calls.push('contact lock'); });
    lockUntouchedWebFormShellsInTx.mockReset().mockImplementation(async () => {
      calls.push('shell locks');
      return { shellIds: ['shell-1'], newestRemaining: null, blockedById: null };
    });
    archiveWebFormShellsInTx.mockReset().mockImplementation(async () => { calls.push('archive'); return ['shell-1']; });
    process.env[GATE] = 'true';
  });

  afterEach(() => {
    delete process.env[GATE];
  });

  test.each([
    ['unset', undefined],
    ['"1", not exactly "true"', '1'],
    ['"false"', 'false'],
  ])('gate %s: the web-form draft blocks as before and nothing is ever archived', async (_label, value) => {
    if (value === undefined) delete process.env[GATE];
    else process.env[GATE] = value;

    const plan = await run(formShell);

    expect(plan.duplicateBlock).toBe(formShell);
    expect(await plan.archiveShells('draft-1')).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('gate on: the run goes on as for a new visitor, and the shells are archived only after its own draft was written', async () => {
    const plan = await run(formShell);

    expect(plan.duplicateBlock).toBeNull();
    // The contact-pair lock comes before any estimate row lock, and nothing is archived yet.
    expect(calls).toEqual(['contact lock', 'shell locks']);
    expect(lockContactPair).toHaveBeenCalledWith(trx);
    // The run's own address goes with it: a draft for another property is not its shell.
    expect(lockUntouchedWebFormShellsInTx).toHaveBeenCalledWith(trx, { phone: '+19415550142', address: HOME, stillBlocks: expect.any(Function) });

    expect(await plan.archiveShells('draft-1')).toEqual(['shell-1']);
    expect(archiveWebFormShellsInTx).toHaveBeenCalledWith(trx, { phone: '+19415550142', shellIds: ['shell-1'], leadId: 'lead-9' });
  });

  test('gate on: a run whose own draft write was refused archives nothing', async () => {
    const plan = await run(formShell);

    expect(await plan.archiveShells(null)).toEqual([]);
    expect(await plan.archiveShells(undefined)).toEqual([]);
    expect(archiveWebFormShellsInTx).not.toHaveBeenCalled();
  });

  test('gate on: when the wizard\'s own draft is what remains, that draft is the block the run refreshes', async () => {
    lockUntouchedWebFormShellsInTx.mockImplementation(async () => ({
      shellIds: ['shell-1'], newestRemaining: { id: 'wiz-1', source: 'quote_wizard', status: 'draft' }, blockedById: null,
    }));

    const plan = await run(formShell);

    expect(plan.duplicateBlock).toMatchObject({ existingEstimateId: 'wiz-1', existingSource: 'quote_wizard', existingStatus: 'draft' });
    expect(shouldRefreshWizardDraft(plan.duplicateBlock)).toBe(true);
  });

  test('gate on: when no shell may go (another estimate still blocks, or a clarify writer is busy), the first block stands', async () => {
    lockUntouchedWebFormShellsInTx.mockImplementation(async () => ({ shellIds: [], newestRemaining: null, blockedById: 'office-1' }));

    const plan = await run(formShell);

    expect(plan.duplicateBlock).toBe(formShell);
    expect(await plan.archiveShells('draft-1')).toEqual([]);
    expect(archiveWebFormShellsInTx).not.toHaveBeenCalled();
  });

  test('gate on: no block, the wizard\'s own draft, and a newest estimate that is not a web-form draft take no lock', async () => {
    const office = { ...formShell, existingEstimateId: 'office-1', existingSource: 'manual' };
    const sentForm = { ...formShell, existingStatus: 'sent' };

    expect((await run(null)).duplicateBlock).toBeNull();
    expect((await run(wizardDraft)).duplicateBlock).toBe(wizardDraft);
    expect((await run(office)).duplicateBlock).toBe(office);
    expect((await run(sentForm)).duplicateBlock).toBe(sentForm);
    // No lock taken, no row read: these runs are blocked exactly as before.
    expect(calls).toEqual([]);
  });

  test('only the wizard\'s own open drafts may remain: every other open estimate still blocks', async () => {
    await run(formShell);
    const { stillBlocks } = lockUntouchedWebFormShellsInTx.mock.calls[0][1];

    expect(stillBlocks({ id: 'w', source: 'quote_wizard', status: 'draft' })).toBe(false);
    expect(stillBlocks({ id: 'w', source: 'quote_wizard', status: 'sent' })).toBe(true);
    expect(stillBlocks({ id: 'm', source: 'manual', status: 'draft' })).toBe(true);
    expect(stillBlocks({ id: 'e', source: 'estimator_engine', status: 'viewed' })).toBe(true);
    expect(stillBlocks({ id: 'l', source: 'lead_webhook', status: 'draft' })).toBe(true);
  });
});

describe('mirror refresh wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const routeSource = fs.readFileSync(
    path.join(__dirname, '../routes/public-quote.js'),
    'utf8'
  );

  test('refresh UPDATE re-checks source and status in the WHERE clause', () => {
    // Guards the race where an admin promotes the draft between the
    // duplicate lookup and the refresh — the conditional update becomes a
    // no-op instead of clobbering a working estimate.
    expect(routeSource).toMatch(
      /existingEstimateId,\s*source:\s*'quote_wizard',\s*status:\s*'draft'/
    );
  });

  test('the same-phone duplicate read goes through planFormShellClear, with the run\'s address and contact-pair lock', () => {
    // The duplicate branch (refresh, block or insert) must judge the block
    // the plan returns, never the first read.
    expect(routeSource).toMatch(
      /const shellPlan = await planFormShellClear\(\s*trx,\s*await blockIfAutomatedEstimateDuplicate\(contactPhone, \{ database: trx \}\),\s*\{ phone: contactPhone, address: quoteFullAddress, leadId: lead\.id, lockContactPair: draftVerdictLock \},?\s*\);\s*const \{ duplicateBlock \} = shellPlan;\s*if \(duplicateBlock\) \{/
    );
    // No second, unguarded duplicate read in the wizard's estimate mirror.
    expect(routeSource.match(/blockIfAutomatedEstimateDuplicate\(contactPhone/g)).toHaveLength(1);
  });

  test('the shells are archived last, inside the same transaction, with the id of the draft the run wrote', () => {
    // After the insert branch closes and before the phone-lock callback ends:
    // a refused refresh leaves draftEstimateId null, and then nothing is archived.
    expect(routeSource).toMatch(
      /draftEstimateId = inserted\?\.id \|\| inserted \|\| null;\s*\}\s*(?:\/\/[^\n]*\s*)*await shellPlan\.archiveShells\(draftEstimateId\);\s*\}\);/
    );
    expect(routeSource.match(/shellPlan\.archiveShells\(/g)).toHaveLength(1);
  });

  test('the shell rule and the clarify writers use one lock name', () => {
    // lockUntouchedWebFormShellsInTx tries the lock that withClarifyLock takes;
    // two copies of the string must not drift apart.
    const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    expect(read('services/estimate-clarify-asks.js')).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\), hashtext\(\?\)\)',\s*\['estimate_clarify', String\(digits\)\]/);
    expect(read('services/estimate-automation-duplicates.js')).toMatch(/const CLARIFY_LOCK_NAMESPACE = 'estimate_clarify';/);
  });
});
