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
 * blocks: the wizard archives it and goes on. clearFormShellBlock decides
 * WHEN the wizard may try that; which rows count as untouched is one SQL
 * rule, proven on real Postgres in wizard-form-shell-retire-postgres.test.js.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The pure helpers stay real; the two database calls are stand-ins.
jest.mock('../services/estimate-automation-duplicates', () => ({
  ...jest.requireActual('../services/estimate-automation-duplicates'),
  blockIfAutomatedEstimateDuplicate: jest.fn(),
  retireUntouchedWebFormShellsInTx: jest.fn(),
}));

const { _internals } = require('../routes/public-quote');
const {
  blockIfAutomatedEstimateDuplicate,
  retireUntouchedWebFormShellsInTx,
} = require('../services/estimate-automation-duplicates');

const { shouldRefreshWizardDraft, clearFormShellBlock } = _internals;

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

describe('clearFormShellBlock (GATE_WIZARD_SUPERSEDES_FORM_DRAFT)', () => {
  const GATE = 'GATE_WIZARD_SUPERSEDES_FORM_DRAFT';
  const trx = { name: 'trx' };
  const formShell = { blocked: true, reason: 'duplicate_phone', existingEstimateId: 'shell-1', existingStatus: 'draft', existingSource: 'lead_webhook' };
  const wizardDraft = { blocked: true, reason: 'duplicate_phone', existingEstimateId: 'wiz-1', existingStatus: 'draft', existingSource: 'quote_wizard' };
  let calls;
  let lockContactPair;
  const run = (block) => clearFormShellBlock(trx, block, { phone: '+19415550142', leadId: 'lead-9', lockContactPair });

  beforeEach(() => {
    calls = [];
    lockContactPair = jest.fn(async () => { calls.push('lock'); });
    blockIfAutomatedEstimateDuplicate.mockReset().mockImplementation(async () => { calls.push('re-read'); return null; });
    retireUntouchedWebFormShellsInTx.mockReset().mockImplementation(async () => { calls.push('retire'); return { retiredIds: ['shell-1'], blockedById: null }; });
    process.env[GATE] = 'true';
  });

  afterEach(() => {
    delete process.env[GATE];
  });

  test.each([
    ['unset', undefined],
    ['"1", not exactly "true"', '1'],
    ['"false"', 'false'],
  ])('gate %s: the web-form draft blocks as before and nothing is archived', async (_label, value) => {
    if (value === undefined) delete process.env[GATE];
    else process.env[GATE] = value;

    expect(await run(formShell)).toBe(formShell);
    expect(calls).toEqual([]);
  });

  test('gate on: the shells are archived under the contact lock, and the run goes on as for a new visitor', async () => {
    expect(await run(formShell)).toBeNull();

    // The contact-pair lock comes before any estimate row lock.
    expect(calls).toEqual(['lock', 'retire', 're-read']);
    expect(lockContactPair).toHaveBeenCalledWith(trx);
    expect(retireUntouchedWebFormShellsInTx).toHaveBeenCalledWith(trx, {
      phone: '+19415550142', leadId: 'lead-9', stillBlocks: expect.any(Function),
    });
    expect(blockIfAutomatedEstimateDuplicate).toHaveBeenCalledWith('+19415550142', { database: trx });
  });

  test('gate on: when the wizard\'s own draft is what remains, that draft is the block the run refreshes', async () => {
    blockIfAutomatedEstimateDuplicate.mockImplementation(async () => wizardDraft);

    const after = await run(formShell);

    expect(after).toBe(wizardDraft);
    expect(shouldRefreshWizardDraft(after)).toBe(true);
  });

  test('gate on: when nothing was archived (another estimate still blocks), the first block stands', async () => {
    retireUntouchedWebFormShellsInTx.mockImplementation(async () => ({ retiredIds: [], blockedById: 'office-1' }));

    expect(await run(formShell)).toBe(formShell);
    expect(blockIfAutomatedEstimateDuplicate).not.toHaveBeenCalled();
  });

  test('gate on: no block, the wizard\'s own draft, and a newest estimate that is not a web-form draft never reach the archive step', async () => {
    const office = { ...formShell, existingEstimateId: 'office-1', existingSource: 'manual' };
    const sentForm = { ...formShell, existingStatus: 'sent' };

    expect(await run(null)).toBeNull();
    expect(await run(wizardDraft)).toBe(wizardDraft);
    expect(await run(office)).toBe(office);
    expect(await run(sentForm)).toBe(sentForm);
    // No lock taken, no row read: these runs are blocked exactly as before.
    expect(calls).toEqual([]);
  });

  test('only the wizard\'s own open draft may remain: every other open estimate still blocks', async () => {
    await run(formShell);
    const { stillBlocks } = retireUntouchedWebFormShellsInTx.mock.calls[0][1];

    expect(stillBlocks(null)).toBe(false);
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

  test('the same-phone duplicate read goes through clearFormShellBlock, with the run\'s contact-pair lock', () => {
    // The duplicate branch (refresh, block or insert) must judge the block
    // that applies AFTER the shells were cleared, never the first read.
    expect(routeSource).toMatch(
      /const duplicateBlock = await clearFormShellBlock\(\s*trx,\s*await blockIfAutomatedEstimateDuplicate\(contactPhone, \{ database: trx \}\),\s*\{ phone: contactPhone, leadId: lead\.id, lockContactPair: draftVerdictLock \},?\s*\);\s*if \(duplicateBlock\) \{/
    );
    // No second, unguarded duplicate read in the wizard's estimate mirror.
    expect(routeSource.match(/blockIfAutomatedEstimateDuplicate\(contactPhone/g)).toHaveLength(1);
  });
});
