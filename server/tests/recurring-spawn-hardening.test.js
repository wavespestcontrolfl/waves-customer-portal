/**
 * PUT /admin/schedule/:id/update-details spawn hardening (fix:
 * status-blind "make recurring" spawn).
 *
 * The spawn branch used to anchor children to the edited row's
 * scheduled_date whatever its status/age, seed its dedupe set with the base
 * date only (double-submit → duplicate children), accept a CHILD row as a
 * spawn anchor (two parents in one family), and inherit price+
 * create_invoice_on_complete with none of the member stripping the POST
 * route applies.
 *
 * The guards live mid-transaction in a 4k-line route, so these are
 * source-pattern guards (house style — see booking-slot-commit-validation);
 * the pure financial pieces are unit-tested via router._test.
 */
const fs = require('fs');
const path = require('path');

const adminScheduleRouter = require('../routes/admin-schedule');
const { applyStoredVisitFinancials } = adminScheduleRouter._test;

const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

// The spawn branch: everything between the spawn-block opener and the
// follow-up-shift block that follows it.
const spawnStart = src.indexOf('// Spawn recurring children if requested');
const spawnEnd = src.indexOf('shiftCallFollowUpsForParentMove({', spawnStart);
const spawnBlock = src.slice(spawnStart, spawnEnd);

describe('update-details spawn branch guards (source)', () => {
  test('block located', () => {
    expect(spawnStart).toBeGreaterThan(-1);
    expect(spawnEnd).toBeGreaterThan(spawnStart);
  });

  test('refuses to spawn from a CHILD row (recurring_parent_id set)', () => {
    expect(spawnBlock).toContain('if (parent.recurring_parent_id) {');
    expect(spawnBlock).toContain('spawning a new series from a child visit');
  });

  test('refuses non-pending/confirmed or past-dated anchors (ET date compare)', () => {
    expect(spawnBlock).toContain("!['pending', 'confirmed'].includes(parent.status)");
    expect(spawnBlock).toContain('spawnAnchorDate < etDateString()');
    expect(spawnBlock).toContain('upcoming pending or confirmed visit');
  });

  test('seeds the dedupe set from the DB (whole series, cancelled rows excluded)', () => {
    expect(spawnBlock).toContain("whereNotIn('status', ['cancelled', 'rescheduled'])");
    expect(spawnBlock).toContain('seenChildDates.add(d)');
  });

  test('tops the series UP instead of appending: target counts existing upcoming children', () => {
    expect(spawnBlock).toContain('existingUpcomingChildren');
    expect(spawnBlock).toContain('const spawnTarget = Math.max(0, (spawnCount - 1) - existingUpcomingChildren);');
    expect(spawnBlock).toContain('while (inserted < spawnTarget && attempt < maxAttempts) {');
  });

  test('applies member-covered stripping (price → add-on-only stamp, create-invoice off)', () => {
    expect(spawnBlock).toContain('memberSeriesCovered');
    expect(spawnBlock).toContain("resolveBillingLane(memberCustomer).mode === 'monthly_membership'");
    expect(spawnBlock).toContain('childData.create_invoice_on_complete = memberSeriesCovered ? false : inv;');
    expect(spawnBlock).toContain('else delete childData.estimated_price;');
    // Prepay-annual + payer-billed rows keep their stamps.
    expect(spawnBlock).toContain('!parent.payer_id && !parent.annual_prepay_term_id');
  });
});

describe('applyStoredVisitFinancials — cioc floor + NULL price semantics', () => {
  const cols = { estimated_price: {}, discount_dollars: {}, is_callback: {}, create_invoice_on_complete: {} };

  test('copies create_invoice_on_complete from the template when unset', () => {
    const target = {};
    applyStoredVisitFinancials(target, cols, { create_invoice_on_complete: true }, [], []);
    expect(target.create_invoice_on_complete).toBe(true);
  });

  test('never overrides an explicitly-set target value', () => {
    const target = { create_invoice_on_complete: false };
    applyStoredVisitFinancials(target, cols, { create_invoice_on_complete: true }, [], []);
    expect(target.create_invoice_on_complete).toBe(false);
  });

  test('leaves the flag untouched when the template carries no value', () => {
    const target = {};
    applyStoredVisitFinancials(target, cols, { create_invoice_on_complete: null }, [], []);
    expect(target.create_invoice_on_complete).toBeUndefined();
  });

  test('NULL-price semantics untouched: no price on the template → no estimated_price stamp', () => {
    const target = {};
    applyStoredVisitFinancials(target, cols, { create_invoice_on_complete: true }, [], []);
    expect(target.estimated_price).toBeUndefined();
  });
});
