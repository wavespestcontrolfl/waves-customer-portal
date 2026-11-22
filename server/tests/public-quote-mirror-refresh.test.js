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
 * blocks: the wizard writes its own estimate as for a new visitor. The old
 * draft is only read. withoutFormShellBlock decides WHEN the wizard may ask;
 * which drafts count as untouched is one SQL rule, proven on real Postgres in
 * wizard-form-shell-postgres.test.js.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The pure helpers stay real; the database read is a stand-in.
jest.mock('../services/estimate-automation-duplicates', () => ({
  ...jest.requireActual('../services/estimate-automation-duplicates'),
  onlyUntouchedWebFormShellsOpen: jest.fn(),
}));

const { _internals } = require('../routes/public-quote');
const { onlyUntouchedWebFormShellsOpen } = require('../services/estimate-automation-duplicates');

const { shouldRefreshWizardDraft, withoutFormShellBlock } = _internals;

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

describe('withoutFormShellBlock (GATE_WIZARD_SUPERSEDES_FORM_DRAFT)', () => {
  const GATE = 'GATE_WIZARD_SUPERSEDES_FORM_DRAFT';
  const trx = { name: 'trx' };
  const RUN = { phone: '+19415550142', address: '12 Sample St, Parrish, FL 34219', customerId: 'cust-1', email: 'sample.person@example.com' };
  const formShell = { blocked: true, reason: 'duplicate_phone', existingEstimateId: 'shell-1', existingStatus: 'draft', existingSource: 'lead_webhook' };
  const wizardDraft = { blocked: true, reason: 'duplicate_phone', existingEstimateId: 'wiz-1', existingStatus: 'draft', existingSource: 'quote_wizard' };
  const run = (block) => withoutFormShellBlock(trx, block, RUN);

  beforeEach(() => {
    onlyUntouchedWebFormShellsOpen.mockReset().mockResolvedValue(true);
    process.env[GATE] = 'true';
  });

  afterEach(() => {
    delete process.env[GATE];
  });

  test.each([
    ['unset', undefined],
    ['"1", not exactly "true"', '1'],
    ['"false"', 'false'],
  ])('gate %s: the web-form draft blocks as before, with no read', async (_label, value) => {
    if (value === undefined) delete process.env[GATE];
    else process.env[GATE] = value;

    expect(await run(formShell)).toBe(formShell);
    expect(onlyUntouchedWebFormShellsOpen).not.toHaveBeenCalled();
  });

  test('gate on: when untouched web-form drafts are all that is open, the run goes on as for a new visitor', async () => {
    expect(await run(formShell)).toBeNull();
    // The run's own customer, email and address go with it: a draft of another
    // contact or for another property keeps the block.
    expect(onlyUntouchedWebFormShellsOpen).toHaveBeenCalledWith(trx, RUN);
  });

  test('gate on: when anything else is open, or the draft is not untouched, the block stands', async () => {
    onlyUntouchedWebFormShellsOpen.mockResolvedValue(false);

    expect(await run(formShell)).toBe(formShell);
  });

  test('gate on: no block, the wizard\'s own draft, and a newest estimate that is not a web-form draft take no read', async () => {
    const office = { ...formShell, existingEstimateId: 'office-1', existingSource: 'manual' };
    const sentForm = { ...formShell, existingStatus: 'sent' };

    expect(await run(null)).toBeNull();
    expect(await run(wizardDraft)).toBe(wizardDraft);
    expect(await run(office)).toBe(office);
    expect(await run(sentForm)).toBe(sentForm);
    // These runs go on exactly as before.
    expect(onlyUntouchedWebFormShellsOpen).not.toHaveBeenCalled();
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

  test('the same-phone duplicate read goes through withoutFormShellBlock, with the run\'s customer, email and address', () => {
    // The duplicate branch (refresh, block or insert) must judge the block
    // that withoutFormShellBlock returns, never the first read.
    expect(routeSource).toMatch(
      /const duplicateBlock = await withoutFormShellBlock\(\s*trx,\s*await blockIfAutomatedEstimateDuplicate\(contactPhone, \{ database: trx \}\),\s*\{ phone: contactPhone, address: quoteFullAddress, customerId, email: contactEmail \},?\s*\);\s*if \(duplicateBlock\) \{/
    );
    // No second, unguarded duplicate read in the wizard's estimate mirror.
    expect(routeSource.match(/blockIfAutomatedEstimateDuplicate\(contactPhone/g)).toHaveLength(1);
  });
});
