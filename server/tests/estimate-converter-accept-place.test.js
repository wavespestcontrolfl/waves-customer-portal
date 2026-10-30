/**
 * GATE_ROUTE_CHECK_ACCEPT_SAVES (owner 2026-10-29, Route Check Everywhere
 * follow-up item 1), the converter's same-trip standalone parent.
 *
 * Source-pattern guard (house style, as recurring-duplicate-series-guard.test.js):
 * the converter's standalone block needs a full Postgres accept to drive end to
 * end (the DATABASE_URL suites accepted-recurring-schedule-postgres and
 * combined-visit-conversion-postgres run it in CI with the gate off). Pinned
 * here: the placement sits inside runSeedingStep's transaction (`trx`, always
 * a transaction: the seeding step's own, or the accept's), right after the
 * parent insert, only for a same-trip parent (the one that copied the reserved
 * start's technician and window), and before the seeding that follows.
 * The behavior of the call itself (gate off = nothing, gate on = one placement
 * with source estimate_accept, a throw never fails the accept) is pinned in
 * staff-save-route-check.test.js.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../services/estimate-converter.js'), 'utf8');
const block = src.slice(src.indexOf('const outcome = await runSeedingStep(async (trx) => {\n              const { matches, guardError }'));

describe('estimate-converter: same-trip standalone parent is numbered in the accept transaction', () => {
  test('the placement runs on trx right after the parent insert, for a same-trip parent only, source estimate_accept', () => {
    const insertAt = block.indexOf("const inserted = await trx('scheduled_services').insert(standaloneRow).returning('*');");
    const placeAt = block.indexOf("if (sameTrip) await require('./scheduling/staff-save-route-check').placeAcceptedVisit(trx, { visit: parentRow });");
    const seedAt = block.indexOf('seedResult = await seedRecurringFollowUpsForParent(trx, parentRow');
    expect(insertAt).toBeGreaterThan(-1);
    expect(placeAt).toBeGreaterThan(insertAt);
    expect(seedAt).toBeGreaterThan(placeAt);
    // After the inserted row is read back, before the tech card and the seeding.
    expect(block.indexOf('const parentRow = ')).toBeGreaterThan(insertAt);
    expect(block.indexOf('const parentRow = ')).toBeLessThan(placeAt);
  });

  test('runSeedingStep always hands its step a transaction (placeMovedVisit no-ops outside one)', () => {
    const start = src.indexOf('const runSeedingStep = (fn) =>');
    const step = src.slice(start, src.indexOf('const registerSeededRowsInline', start));
    expect(step).toContain('database.transaction(async (trx) => {');
    // No own transaction means the accept's `database`, which is itself one.
    expect(src).toContain('const seedsInOwnTransaction = !database.isTransaction;');
    expect(step).toContain(': fn(database)');
  });

  test('the converter never calls placeMovedVisit itself: one shared placement function, one gate', () => {
    expect(src).not.toMatch(/placeMovedVisit\(/);
    expect(src.match(/placeAcceptedVisit\(/g)).toHaveLength(1);
  });
});
