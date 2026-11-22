/**
 * Moving PR B1 (GATE_MOVING_ESTIMATE): every accept re-checks a new-home
 * estimate's move at commit, on the move row share-locked inside the accept's
 * own transaction. Two call sites carry it: the public accept (every branch,
 * the one-time accept included, which never reaches the converter) right after
 * it locks the estimate row, and the converter, which every other accept path
 * runs inside its transaction. The rule itself (lockMoveForConversion) is
 * proven against Postgres in moving-estimate-postgres.test.js; this pins the
 * placement, like the other ordering guards in this repo.
 */
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the public accept checks the move right after locking the estimate row, before any branch', () => {
  const src = read('routes/estimate-public.js');
  const lockAt = src.indexOf("const freshLinkRow = await trx('estimates').where({ id: estimate.id }).forUpdate().first(");
  const moveAt = src.indexOf("lockMoveForConversion(trx, freshLinkData)");
  const convertAt = src.indexOf('EstimateConverter.convertEstimate(estimate.id, {', lockAt);
  expect(lockAt).toBeGreaterThan(-1);
  expect(moveAt).toBeGreaterThan(lockAt);
  expect(convertAt).toBeGreaterThan(moveAt);
  // An adopted visit (no hold, so no commitReservation check) is compared with
  // the move-in date read under that same lock (codex #7532 r1).
  const adoptedAt = src.indexOf("err.code = 'BEFORE_MOVE_IN';", moveAt);
  expect(adoptedAt).toBeGreaterThan(moveAt);
  expect(convertAt).toBeGreaterThan(adoptedAt);
});

test('the converter checks the move before it schedules anything', () => {
  const src = read('services/estimate-converter.js');
  const checkAt = src.indexOf("lockMoveForConversion(database, estimateData)");
  expect(checkAt).toBeGreaterThan(-1);
  expect(src.indexOf('pickFirstServiceDate(customer, estimateId, { serviceKey: firstVisitServiceKey })')).toBeGreaterThan(checkAt);
});

test('the public accept refuses an adopted visit before a plan offer\'s first visit date on the LOCKED adoption row, before the adoption update (owner 2026-11-19)', () => {
  const src = read('routes/estimate-public.js');
  const lockAt = src.indexOf("const freshLinkRow = await trx('estimates').where({ id: estimate.id }).forUpdate().first(");
  // The stamp is read from the estimate data this accept holds under the estimate row lock ...
  const stampAt = src.indexOf('planOfferFrom = require(', lockAt);
  // ... and compared with the date of the visit row locked FOR UPDATE, ahead of the conditional adoption UPDATE.
  const lockedRowAt = src.indexOf('const lockedAdoptRow = await trx(', stampAt);
  const floorAt = src.indexOf("err.code = 'BEFORE_PLAN_VISIT_WINDOW';", lockedRowAt);
  const updateAt = src.indexOf(".where('scheduled_date', '>=', etDateString())", lockedRowAt);
  const convertAt = src.indexOf('EstimateConverter.convertEstimate(estimate.id, {', lockAt);
  expect(lockAt).toBeGreaterThan(-1);
  expect(stampAt).toBeGreaterThan(lockAt);
  expect(lockedRowAt).toBeGreaterThan(stampAt);
  expect(floorAt).toBeGreaterThan(lockedRowAt);
  expect(updateAt).toBeGreaterThan(floorAt);
  expect(convertAt).toBeGreaterThan(lockAt);
  expect(src.slice(lockedRowAt, floorAt)).toContain('lockedAdoptRow.scheduled_date) < planOfferFrom');
  // No read of the visit's date outside the lock remains for this rule.
  expect(src.indexOf("err.code = 'BEFORE_PLAN_VISIT_WINDOW';")).toBe(floorAt);
});
