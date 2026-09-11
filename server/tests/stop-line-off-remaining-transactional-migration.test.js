/**
 * Guards migration 20260911000010 (owner directive 2026-09-11): the second
 * STOP-line pass. Pins the swap table's invariants, the keep-list the pass
 * must NOT touch, and the up/down behaviour of the shared sweep — exact
 * bodies get the reviewed rewrite, drifted (admin-edited) bodies get the
 * mechanical strip only, and every update is a compare-and-swap.
 */

const migration = require('../models/migrations/20260911000010_stop_line_off_remaining_transactional');

const { _SWAPS: SWAPS, _KEYS: KEYS, _KEEP_STOP_KEYS: KEEP_STOP_KEYS, _dropStop: dropStop } = migration;

const tokens = (body) => [...String(body).matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]).sort();

function buildKnex({ templateRows = [], variantRows = [], hasVariants = true } = {}) {
  const state = { updates: [] };
  const rowsFor = (table) => (table === 'sms_templates' ? templateRows : variantRows);
  const knex = jest.fn((table) => {
    const q = {
      _where: null,
      whereIn(column, values) {
        this._filter = (row) => values.includes(row[column]);
        return this;
      },
      where(criteria) {
        this._where = criteria;
        this._filter = (row) => Object.entries(criteria).every(([k, v]) => row[k] === v);
        return this;
      },
      async select(...columns) {
        const cols = columns.flat();
        return rowsFor(table)
          .filter(this._filter || (() => true))
          .map((row) => Object.fromEntries(cols.map((c) => [c, row[c]])));
      },
      async update(data) {
        // Compare-and-swap: only rows still matching the full where clause.
        const matched = rowsFor(table).filter(this._filter || (() => true));
        for (const row of matched) Object.assign(row, data);
        state.updates.push({ table, where: this._where, data, matched: matched.length });
        return matched.length;
      },
    };
    return q;
  });
  knex.schema = {
    hasTable: jest.fn(async (table) => (table === 'sms_template_variants' ? hasVariants : true)),
  };
  return { knex, state };
}

describe('stop-line-off-remaining-transactional swap table', () => {
  test('covers exactly the 11 templates the 2026-09-11 ruling names', () => {
    expect(KEYS).toEqual([
      'appointment_recurring_placement_confirmed',
      'autopay_setup_link',
      'review_request',
      'review_request_followup',
      'renewal_reminder',
      'auto_new_appointment',
      'auto_new_recurring',
      'auto_prep_guide_link',
      'auto_sprinkler_timer',
      'upsell_add_service',
      'upsell_tier_upgrade',
    ]);
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });

  test('the lead/first-touch keep-list and the swap list do not overlap', () => {
    for (const key of KEEP_STOP_KEYS) {
      expect({ key, swapped: KEYS.includes(key) }).toEqual({ key, swapped: false });
    }
    // dropped_call_address_request and referral_nudge were explicitly weighed
    // and kept (2026-09-11) — a future pass must not quietly absorb them.
    expect(KEEP_STOP_KEYS).toContain('dropped_call_address_request');
    expect(KEEP_STOP_KEYS).toContain('referral_nudge');
  });

  test('every entry changes something and no rewritten body still carries STOP', () => {
    for (const [key, expect_, set] of SWAPS) {
      expect({ key, changed: set !== expect_ }).toEqual({ key, changed: true });
      expect({ key, stop: /Reply STOP/i.test(set) }).toEqual({ key, stop: false });
      expect({ key, hadStop: /Reply STOP/i.test(expect_) }).toEqual({ key, hadStop: true });
    }
  });

  test('rewrites are exactly the mechanical strip — no copy edits ride along', () => {
    for (const [key, expect_, set] of SWAPS) {
      expect({ key, body: dropStop(expect_) }).toEqual({ key, body: set });
    }
  });

  test('the audited body for the recurring-placement text is exactly what 20260906000040 seeds', () => {
    // A fresh environment runs the seed first and this sweep second, so a
    // copy change over there must be reflected here or the fresh-install body
    // silently diverges from prod's (the mechanical strip would still catch
    // the STOP line, but the reviewed rewrite would stop applying).
    const seed = require('../models/migrations/20260906000040_recurring_dispatch_sms');
    const [, audited, set] = SWAPS.find(([k]) => k === 'appointment_recurring_placement_confirmed');
    expect(seed.TEMPLATE.body).toBe(audited);
    expect(dropStop(seed.TEMPLATE.body)).toBe(set);
  });

  test('rewrites preserve the exact variable set of the audited body', () => {
    for (const [key, expect_, set] of SWAPS) {
      expect({ key, vars: tokens(set) }).toEqual({ key, vars: tokens(expect_) });
    }
  });

  test('disclosures that are not the opt-out line survive', () => {
    const byKey = Object.fromEntries(SWAPS.map(([k, , set]) => [k, set]));
    expect(byKey.autopay_setup_link).toContain('We never take card numbers by phone.');
    expect(byKey.autopay_setup_link).toContain('Nothing is charged today.');
    expect(byKey.renewal_reminder).toContain('Reply RENEW');
  });

  test('rewritten bodies stay GSM-7-safe ASCII', () => {
    for (const [key, , set] of SWAPS) {
      expect({ key, ok: /^[\x20-\x7E\n]*$/.test(set) }).toEqual({ key, ok: true });
    }
  });

  test('no blank-line runs, trailing spaces, or trailing whitespace', () => {
    for (const [key, , set] of SWAPS) {
      expect({ key, runs: /\n{3,}/.test(set) }).toEqual({ key, runs: false });
      expect({ key, trail: /[ \t]+\n/.test(set) }).toEqual({ key, trail: false });
      expect({ key, end: /\s$/.test(set) }).toEqual({ key, end: false });
    }
  });

  test('mechanical strip handles both positions and leaves clean bodies alone', () => {
    expect(dropStop('Body text.\n\nReply STOP to opt out.')).toBe('Body text.');
    expect(dropStop('We never take card numbers by phone. Reply STOP to opt out.'))
      .toBe('We never take card numbers by phone.');
    expect(dropStop('No STOP here.')).toBe('No STOP here.');
  });
});

describe('stop-line-off-remaining-transactional up()', () => {
  test('rewrites audited bodies and mechanically strips drifted ones', async () => {
    const drifted = 'Hello {first_name}! Adam here, custom admin wording. Reply STOP to opt out.';
    const templateRows = [
      { id: 't1', template_key: 'review_request', body: SWAPS.find(([k]) => k === 'review_request')[1] },
      { id: 't2', template_key: 'upsell_add_service', body: drifted },
      // Not in the swap list — must be untouched even though it carries STOP.
      { id: 't3', template_key: 'missed_call', body: 'Hello {first_name}! Waves here.\n\nReply STOP to opt out.' },
    ];
    const { knex, state } = buildKnex({ templateRows });

    await migration.up(knex);

    expect(templateRows[0].body).toBe(SWAPS.find(([k]) => k === 'review_request')[2]);
    expect(templateRows[1].body).toBe('Hello {first_name}! Adam here, custom admin wording.');
    expect(templateRows[2].body).toMatch(/Reply STOP to opt out\./);
    for (const u of state.updates) {
      // Every update is a compare-and-swap on the body that was read.
      expect(Object.keys(u.where).sort()).toEqual(['body', 'id']);
    }
  });

  test('sweeps variant bodies too (a variant renders instead of the base)', async () => {
    const [, auditedReview, strippedReview] = SWAPS.find(([k]) => k === 'review_request');
    const variantRows = [{ id: 'v1', template_key: 'review_request', body: auditedReview }];
    const { knex, state } = buildKnex({ variantRows });

    await migration.up(knex);

    expect(variantRows[0].body).toBe(strippedReview);
    expect(state.updates.some((u) => u.table === 'sms_template_variants')).toBe(true);
  });

  test('already-clean rows are not written at all', async () => {
    const templateRows = SWAPS.map(([key, , set], i) => ({ id: `c${i}`, template_key: key, body: set }));
    const { knex, state } = buildKnex({ templateRows });

    await migration.up(knex);

    expect(state.updates).toHaveLength(0);
  });

  test('skips the variants table when it does not exist, and no-ops without sms_templates', async () => {
    const { knex, state } = buildKnex({
      templateRows: [{ id: 't1', template_key: 'review_request', body: SWAPS[2][1] }],
      hasVariants: false,
    });
    await migration.up(knex);
    expect(state.updates.every((u) => u.table === 'sms_templates')).toBe(true);

    const bare = jest.fn();
    bare.schema = { hasTable: jest.fn(async () => false) };
    await migration.up(bare);
    expect(bare).not.toHaveBeenCalled();
  });
});

describe('stop-line-off-remaining-transactional down()', () => {
  test('restores audited bodies and leaves mechanically stripped rows alone', async () => {
    const [, auditedReview, strippedReview] = SWAPS.find(([k]) => k === 'review_request');
    const templateRows = [
      { id: 't1', template_key: 'review_request', body: strippedReview },
      { id: 't2', template_key: 'upsell_add_service', body: 'Admin wording with no snapshot.' },
    ];
    const { knex } = buildKnex({ templateRows });

    await migration.down(knex);

    expect(templateRows[0].body).toBe(auditedReview);
    expect(templateRows[1].body).toBe('Admin wording with no snapshot.');
  });

  test('round-trips up() then down() back to the audited bodies', async () => {
    const templateRows = SWAPS.map(([key, expect_], i) => ({ id: `r${i}`, template_key: key, body: expect_ }));
    const { knex } = buildKnex({ templateRows });

    await migration.up(knex);
    expect(templateRows.every((r) => !/Reply STOP/i.test(r.body))).toBe(true);
    await migration.down(knex);

    for (const [i, [, expect_]] of SWAPS.entries()) {
      expect(templateRows[i].body).toBe(expect_);
    }
  });
});
