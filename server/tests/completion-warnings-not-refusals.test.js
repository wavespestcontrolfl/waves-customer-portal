// Owner 2026-11-26 ("EVERYTHING SHOULD ONLY BE WARNED, NEVER BLOCKED FROM USING, FOR NOW"): the lawn closeout no longer refuses
// for oxadiazon on a home lawn or a bermuda removal step past its limit; each is an application-limit finding with an advisory
// line for the tech and one office alert. (The pair and area data-entry checks stay refusals.) Stock below zero on any visit is
// in pest-stock-advisory.test.js; the cap re-check in the transaction is in lawn-bermuda-removal.db.test.js.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'alert-1' })),
}));

const fs = require('fs');
const path = require('path');
const compose = require('../services/admin-alert-compose');
const prohibited = require('../services/lawn-prohibited-products');
const { notifyOfficeOfLimitFindings } = require('../services/complete-scheduled-service');

const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
const svc = { id: 'visit-1', customer_id: 'customer-1', service_type: 'Lawn Care' };
const record = { id: 'record-1' };
afterEach(() => jest.clearAllMocks());

describe('oxadiazon on a home lawn: recorded, flagged, alerted', () => {
  const finding = prohibited.lawnProhibitedProductFinding({ ...prohibited.lawnProhibitedProductBlock({ name: 'Ronstar G' }), productId: 'r1' });

  test('one office alert says the label prohibits residential use, and the alert rules accept it', async () => {
    await notifyOfficeOfLimitFindings({ svc, record, findings: [finding] });
    expect(compose.raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = compose.raiseAdminAlert.mock.calls[0];
    expect(category).toBe('service');
    expect(spec).toMatchObject({ action: 'review Ronstar G label use', why: 'Ronstar G was recorded on a home lawn, and its label prohibits residential use.', severity: 'needs-you' });
    expect(opts.detail).toContain('The label prohibits residential use');
    expect(opts.dedupeKey).toBe('application-limit-finding:record-1:application_limit_exceeded:r1:label_prohibits_residential');
    expect(() => compose.composeAdminAlert(spec)).not.toThrow();
  });

  test('the closeout no longer returns the 400 or the payload for it', () => {
    expect(source).not.toContain('lawnProhibitedProductsBlockPayload');
    expect(prohibited.lawnProhibitedProductsBlockPayload).toBeUndefined();
  });
});

describe('a bermuda removal step past its limit: recorded, flagged, alerted', () => {
  const message = 'Recognition: only 21 days since last app (min 42).';
  test('the preflight turns the cap message into a finding; only "limits not loaded" still refuses', () => {
    expect(source).toContain('if (bermudaLimitMessage) lawnWarningFindings.push(bermudaStepFinding(bermudaLimitMessage));');
    expect(source).toContain('bermudaLimitMessage === require(\'./lawn-bermuda-removal\').NOT_CONFIGURED_MESSAGE');
    expect(source).toContain('if (bermudaAreaMessage) {'); // the area data-entry check no longer hides behind the limit message
    expect(source).toContain('enforceStepLimitsInTransaction(trx, products, { serviceId: svc.id, capsAreWarnings: true })');
  });

  test('one office alert names the limit, and the alert rules accept it', async () => {
    const eligible = require('../services/complete-scheduled-service');
    expect(eligible).toBeDefined();
    const finding = { code: 'application_limit_exceeded', limitType: 'bermuda_step_limit', productName: 'Bermuda removal', reason: message };
    await notifyOfficeOfLimitFindings({ svc, record, findings: [finding] });
    const [, spec, opts] = compose.raiseAdminAlert.mock.calls[0];
    expect(spec).toMatchObject({ action: 'review Bermuda removal over its limit', why: 'Bermuda removal was recorded past its yearly or 42-day limit.' });
    expect(opts.detail).toContain(message);
    expect(() => compose.composeAdminAlert(spec)).not.toThrow();
  });
});

describe('a flagged over-ceiling line refutes the provisional WaveGuard shortfall (owner 2026-11-26)', () => {
  test('the reconcile treats not_deducted_implausible as a locked outcome that supersedes the preflight shortfall block', () => {
    expect(source).toContain("['deducted', 'deducted_insufficient_stock', 'not_deducted_counted', 'not_deducted_implausible'].includes(");
  });
});
