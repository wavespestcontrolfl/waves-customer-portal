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
 */

const { _internals } = require('../routes/public-quote');

const { shouldRefreshWizardDraft } = _internals;

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
});
