// Owner 2026-09-28: a stamped $0 per-application visit is deliberately free.
// The "completed with no billable amount on file — invoice manually" warning
// must not fire for it (it would send ops to bill a free visit); a NULL price
// still warns.
const fs = require('fs');
const path = require('path');

test('the per-application missing-price warning skips a stamped $0', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const warn = src.indexOf('completed with no billable amount on file (no visit price, no per_application_fee');
  expect(warn).toBeGreaterThan(-1);
  const guard = src.slice(src.lastIndexOf('if (!packetEffects && (perApplicationBilling', warn), warn);
  expect(guard).toContain('!isStampedZeroEstimate(svc.estimated_price)');
});
