// The durable zero-comms opt-out (estimate_data.noEngagementAutomation,
// stamped by publish-without-delivery mints like report click-to-estimate)
// must be honored by the LEGACY follow-up sender too, not just the
// engagement engine (#3391 out-of-band audit P1): the four followup_* flags
// are resettable — an expiry extension clears followup_expiring_sent and the
// cron would then message a customer that lane promises ZERO comms.
// safetyGate is the shared choke point every stage loop and the deferred
// replay consult, so one skip there covers them all.

jest.mock('../models/db', () => {
  const mockDb = jest.fn(() => {
    const q = {};
    ['where', 'join', 'andWhere', 'orWhere', 'whereIn', 'whereNull', 'whereNotNull', 'orderBy', 'limit', 'first', 'select'].forEach((m) => {
      q[m] = jest.fn(() => q);
    });
    q.then = (resolve, reject) => Promise.resolve(null).then(resolve, reject);
    return q;
  });
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));
jest.mock('../services/estimate-lead-linkage', () => ({ leadIdForEstimate: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-service-lines', () => ({ inferEstimateServiceInterest: jest.fn(), inferEstimateServiceLines: jest.fn(() => []) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/estimate-deposits', () => ({}));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
}));

const { customerConvertedSince } = require('../services/estimate-conversion-guard');
const { safetyGate } = require('../services/estimate-follow-up')._private;

describe('safetyGate honors the durable engagement opt-out', () => {
  const base = { id: 'est-1', status: 'sent', customer_email: 'invented@example.com' };

  test('an opted-out estimate skips before ANY conversion/reply probe runs', async () => {
    const gate = await safetyGate({
      ...base,
      estimate_data: JSON.stringify({ noEngagementAutomation: true }),
    });
    expect(gate).toEqual({ skip: true, reason: 'engagement-opted-out' });
    expect(customerConvertedSince).not.toHaveBeenCalled();
  });

  test('object-form estimate_data (jsonb hydration) opts out identically', async () => {
    const gate = await safetyGate({ ...base, estimate_data: { noEngagementAutomation: true } });
    expect(gate).toEqual({ skip: true, reason: 'engagement-opted-out' });
  });

  test('a normal estimate still passes the gate', async () => {
    const gate = await safetyGate({ ...base, estimate_data: '{}' });
    expect(gate).toEqual({ skip: false });
  });
});

describe('opt-out key lockstep (contract)', () => {
  // The follow-up sender and the engagement engine deliberately duplicate
  // the predicate (a require cycle would hand one a partial export) — this
  // pins BOTH to the same estimate_data key so they cannot drift apart.
  const fs = require('fs');
  const path = require('path');
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

  test('every enforcement module and the mint reference the same marker key', () => {
    expect(read('../services/estimate-follow-up.js')).toMatch(/noEngagementAutomation === true/);
    expect(read('../services/estimate-engagement-engine.js')).toMatch(/noEngagementAutomation === true/);
    // The auto-renew sender extends AND emails — both forbidden for
    // opted-out estimates (uncapped audit r4 P1).
    expect(read('../services/estimate-auto-renew.js')).toMatch(/noEngagementAutomation === true/);
    // extendEstimate forces silent for opted-out rows — the extension is
    // allowed but its SMS/email announcement is not, and the PUBLIC
    // extension-request flow calls it non-silently (in-hook audit on
    // #3391 round 9). Central here so every caller inherits the guard.
    expect(read('../services/estimate-extension.js')).toMatch(/noEngagementAutomation === true/);
    expect(read('../services/service-report/click-estimate-mint.js')).toMatch(/noEngagementAutomation: true/);
  });
});
