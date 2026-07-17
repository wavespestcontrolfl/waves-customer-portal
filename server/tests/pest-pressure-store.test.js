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
 * removed, including the null restored case, and cached report PDFs are
 * invalidated in the same service_records write.
 */

const { applyOverride, removeOverride } = require('../services/pest-pressure/store');

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
  //   3. service_records.where().update() — mirror pressure_index + clear cached PDF
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
    expect(updates.service_records).toEqual({ pressure_index: 3.1, pdf_storage_key: null });
  });

  test('null restored score (insufficient-data case): pressure_index is cleared to null', async () => {
    // The regressed case. Before the fix, an override on a row whose
    // engine output later became null (insufficient data) was removed but
    // pressure_index kept the old overridden value. Now it gets cleared
    // alongside displayed_score so customer-facing surfaces don't keep
    // showing the stale score.
    const { knex, updates } = buildKnex({ existing: overriddenScoreRow({ calculated_score: null }) });
    await removeOverride(knex, { serviceRecordId: 'svc-1' });
    expect(updates.service_records).toEqual({ pressure_index: null, pdf_storage_key: null });
  });

  test('undefined restored score: pressure_index is cleared to null (defensive)', async () => {
    const { knex, updates } = buildKnex({ existing: overriddenScoreRow({ calculated_score: undefined }) });
    await removeOverride(knex, { serviceRecordId: 'svc-1' });
    expect(updates.service_records).toEqual({ pressure_index: null, pdf_storage_key: null });
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

describe('applyOverride — pressure_index mirror + PDF cache invalidation', () => {
  test('manual override mirrors rounded score and clears cached PDF in one write', async () => {
    const { knex, updates } = buildKnex({ existing: overriddenScoreRow({ calculated_score: 3.1 }) });
    await applyOverride(knex, {
      serviceRecordId: 'svc-1',
      displayedScore: 4.24,
      reason: 'admin correction',
      overriddenBy: 'tech-1',
    });

    expect(updates.service_records).toEqual({ pressure_index: 4.2, pdf_storage_key: null });
  });
});

describe('orchestrate.js — pressure_index mirror source-text regression guard (codex P1 round-2)', () => {
  // Codex flagged: when recalc runs with clearOverride=false (default),
  // calculateAndPersistForServiceRecord wrote service_records.pressure_index
  // from result.displayedScore (raw engine output) even when the score
  // row was still overridden. pest_pressure_scores.displayed_score
  // correctly stayed on the override (persistScore preserves it), but
  // pressure_index got reset to the engine's fresh value — so customer
  // surfaces reading pressure_index no longer reflected the preserved
  // override. The fix mirrors from the PERSISTED row's displayed_score
  // instead.
  //
  // The orchestrate function's mock surface is enormous (loadActiveConfig,
  // gatherInputs with knex sub-chains, 5 component extractors,
  // loadPreviousScore). A source-text guard is the better cost/benefit
  // here: it prevents a silent revert to the wrong field without dragging
  // every collaborator into the test.

  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'pest-pressure', 'orchestrate.js'),
    'utf8',
  );

  test('pressure_index update reads from persisted row, not raw engine result', () => {
    // persistScore's return value is captured.
    expect(src).toMatch(/const\s+persisted\s*=\s*await\s+persistScore\b/);
    // The pressure_index UPDATE uses the persisted field.
    expect(src).toMatch(/pressure_index:\s*persisted\.displayed_score\b/);
    // Recalculated scores also invalidate cached report PDFs.
    expect(src).toMatch(/pdf_storage_key:\s*null\b/);
    // And does NOT read from the raw engine result.
    expect(src).not.toMatch(/pressure_index:\s*result\.displayedScore\b/);
  });

  test('null-guard reads the persisted field', () => {
    expect(src).toMatch(/persisted\s*&&\s*persisted\.displayed_score\s*!=\s*null/);
  });
});

describe('loadHistoryForCustomer — same-day sibling trim (audit 2026-07-16 P3)', () => {
  const { loadHistoryForCustomer } = require('../services/pest-pressure/store');

  // Store ships DESC by service_date; 202 is a LATER visit on the same day
  // as this report's own row (201).
  const rows = [
    { service_record_id: 202, service_date: '2026-07-10', displayed_score: 4.1 },
    { service_record_id: 201, service_date: '2026-07-10', displayed_score: 3.2 },
    { service_record_id: 105, service_date: '2026-06-01', displayed_score: 2.8 },
  ];

  function historyKnex() {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.orderBy = jest.fn(() => chain);
    chain.limit = jest.fn(() => chain);
    chain.select = jest.fn(async () => [...rows]);
    return jest.fn(() => chain);
  }

  test('token-scoped history trims a later same-day sibling at the report own row', async () => {
    const out = await loadHistoryForCustomer(historyKnex(), 9, {
      limit: 8, beforeOrOnServiceDate: '2026-07-10', currentServiceRecordId: 201,
    });
    expect(out.map((r) => r.service_record_id)).toEqual([201, 105]);
  });

  test('legacy report with no stored row keeps the plain date bound', async () => {
    const out = await loadHistoryForCustomer(historyKnex(), 9, {
      limit: 8, beforeOrOnServiceDate: '2026-07-10', currentServiceRecordId: 999,
    });
    expect(out.map((r) => r.service_record_id)).toEqual([202, 201, 105]);
  });

  test('admin callers without currentServiceRecordId are unchanged', async () => {
    const out = await loadHistoryForCustomer(historyKnex(), 9, { limit: 8 });
    expect(out).toHaveLength(3);
  });
});
