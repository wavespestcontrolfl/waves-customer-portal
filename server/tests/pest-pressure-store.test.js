/**
 * Regression guards for codex P1 finding on PR #975:
 *
 *   `removeOverride` previously had a guard that skipped updating
 *   `service_records.pressure_index` when the restored calculated_score
 *   was null. Removing an override from an "insufficient data" score
 *   would clear pest_pressure_scores.displayed_score but leave the old
 *   overridden value in pressure_index — so customer/report surfaces
 *   reading pressure_index would continue showing the stale score.
 *
 * These tests pin: pressure_index is ALWAYS mirrored when an override is
 * removed, including the null restored case.
 */

const { removeOverride } = require('../services/pest-pressure/store');

function buildKnex({ existing, recordsUpdate, scoresUpdate } = {}) {
  // Track the last update payload for each table so tests can assert what
  // was written without needing to drive a real DB.
  const updates = { service_records: null, pest_pressure_scores: null };

  function scoresChain(reloadValue) {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.first = jest.fn(async () => reloadValue);
    chain.select = jest.fn(() => chain);
    chain.update = jest.fn(async (payload) => { updates.pest_pressure_scores = payload; return 1; });
    chain.orderBy = jest.fn(() => chain);
    chain.limit = jest.fn(() => chain);
    return chain;
  }

  function recordsChain() {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.update = jest.fn(async (payload) => { updates.service_records = payload; return 1; });
    return chain;
  }

  // Sequence the calls. `removeOverride` does:
  //   1. loadScoreForServiceRecord (uses pest_pressure_scores .where().first())
  //   2. pest_pressure_scores.where().update() — set is_overridden=false etc.
  //   3. service_records.where().update() — mirror pressure_index
  //   4. loadScoreForServiceRecord again (return value)
  const reloadedAfter = { ...existing, is_overridden: false, displayed_score: existing.calculated_score };
  const scoresCalls = [scoresChain(existing), scoresChain(existing), scoresChain(reloadedAfter)];
  const recordsCalls = [recordsChain()];
  const knex = jest.fn((table) => {
    if (table === 'pest_pressure_scores') {
      if (!scoresCalls.length) throw new Error('exhausted pest_pressure_scores chain queue');
      return scoresCalls.shift();
    }
    if (table === 'service_records') {
      if (!recordsCalls.length) throw new Error('exhausted service_records chain queue');
      return recordsCalls.shift();
    }
    throw new Error(`unexpected table: ${table}`);
  });
  knex.fn = { now: jest.fn(() => 'NOW()') };

  return { knex, updates };
}

function overriddenScoreRow(overrides = {}) {
  return {
    id: 'score-1',
    service_record_id: 'svc-1',
    customer_id: 'cust-1',
    is_overridden: true,
    calculated_score: 2.4,
    displayed_score: 1.5,
    original_calculated_score: 2.4,
    override_reason: 'manual reason',
    overridden_by: 'tech-1',
    overridden_at: new Date('2026-05-10T00:00:00Z'),
    ...overrides,
  };
}

describe('removeOverride — pressure_index mirror (codex P1 regression guard)', () => {
  test('non-null restored score: pressure_index gets the restored value', async () => {
    const { knex, updates } = buildKnex({ existing: overriddenScoreRow({ calculated_score: 3.1 }) });
    await removeOverride(knex, { serviceRecordId: 'svc-1' });
    expect(updates.service_records).toEqual({ pressure_index: 3.1 });
  });

  test('null restored score (insufficient-data case): pressure_index is cleared to null', async () => {
    // The regressed case. Before the fix, an override on a row whose
    // engine output later became null (insufficient data) was removed but
    // pressure_index kept the old overridden value. Now it gets cleared
    // alongside displayed_score so customer-facing surfaces don't keep
    // showing the stale score.
    const { knex, updates } = buildKnex({ existing: overriddenScoreRow({ calculated_score: null }) });
    await removeOverride(knex, { serviceRecordId: 'svc-1' });
    expect(updates.service_records).toEqual({ pressure_index: null });
  });

  test('undefined restored score: pressure_index is cleared to null (defensive)', async () => {
    const { knex, updates } = buildKnex({ existing: overriddenScoreRow({ calculated_score: undefined }) });
    await removeOverride(knex, { serviceRecordId: 'svc-1' });
    expect(updates.service_records).toEqual({ pressure_index: null });
  });

  test('no-op cases still skip the pressure_index update', async () => {
    // When the row doesn't exist or isn't overridden, the function bails
    // before the update — sanity check we haven't broken that path.
    const nonOverridden = overriddenScoreRow({ is_overridden: false });
    const { knex, updates } = buildKnex({ existing: nonOverridden });
    await removeOverride(knex, { serviceRecordId: 'svc-1' });
    expect(updates.service_records).toBeNull();
    expect(updates.pest_pressure_scores).toBeNull();
  });
});
