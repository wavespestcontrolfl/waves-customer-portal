/**
 * Latent-divergence guard for the lawn admin-overhead constant.
 *
 * The server resolves adminAnnual from options with a fallback to
 * LAWN_PRICING_V2.adminAnnualDefault; the client estimator hardcodes the same
 * default and has no way to receive a server/DB override. Today both are 51, so
 * the client preview matches the server-authoritative price. If someone changes
 * one constant without the other, the preview silently drifts from the billed
 * price — this test fails the moment they diverge.
 *
 * constants.js has no heavy deps, so this runs without a full pricing-engine load.
 */

const fs = require('fs');
const path = require('path');
const { LAWN_PRICING_V2 } = require('../services/pricing-engine/constants');

function clientAdminAnnualDefault() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../client/src/lib/estimateEngine.js'),
    'utf8',
  );
  // The client LAWN_PRICING_V2 block declares `adminAnnualDefault: <n>,`.
  const m = src.match(/adminAnnualDefault:\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) throw new Error('client adminAnnualDefault not found in estimateEngine.js');
  return Number(m[1]);
}

describe('lawn adminAnnual constant parity (client ↔ server)', () => {
  test('client and server share the same adminAnnualDefault', () => {
    expect(typeof LAWN_PRICING_V2.adminAnnualDefault).toBe('number');
    expect(clientAdminAnnualDefault()).toBe(LAWN_PRICING_V2.adminAnnualDefault);
  });
});
