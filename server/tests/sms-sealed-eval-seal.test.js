/**
 * sealEvalItems — query-contract + stratification coverage via a capturing
 * fake knex (same pattern as sms-graduation-cohort-query.test.js). The
 * freezer's promise: only NON-backfill drafts with a real frozen facts_block
 * and a real human reply are ever sealed, the pool tops up to the target
 * without ever editing existing rows, and one chatty intent can't crowd the
 * exam.
 */
const { sealEvalItems } = require('../services/sms-sealed-eval');

function makeFakeDb({ activeCount = 0, candidates = [] } = {}) {
  const calls = [];
  const inserts = [];
  const dbi = (table) => {
    const tableKey = typeof table === 'object' ? Object.values(table)[0] : table;
    const builder = { _table: tableKey, _isCount: false, _insertRows: null };
    const record = (name) => (...args) => {
      if ((name === 'where' || name === 'whereNull') && typeof args[0] === 'function') {
        args[0].call(builder);
      } else {
        calls.push([name, args, tableKey]);
      }
      if (name === 'count') builder._isCount = true;
      if (name === 'insert') {
        builder._insertRows = args[0];
        inserts.push(args[0]);
      }
      return builder;
    };
    for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw',
      'join', 'leftJoin', 'select', 'count', 'groupBy', 'orderBy', 'limit', 'insert', 'onConflict', 'ignore', 'first']) {
      builder[m] = record(m);
    }
    builder.then = (resolve, reject) => {
      let rows;
      if (builder._insertRows) rows = [];
      else if (builder._isCount) rows = [{ count: String(activeCount) }];
      else rows = candidates;
      return Promise.resolve(rows).then(resolve, reject);
    };
    return builder;
  };
  dbi.raw = (sql) => sql;
  dbi.calls = calls;
  dbi.inserts = inserts;
  return dbi;
}

const cand = (id, intent, createdAt) => ({
  source_draft_id: id,
  customer_id: `cust-${id}`,
  intent,
  inbound_message: 'when are you coming?',
  facts_block: 'CUSTOMER: frozen facts',
  context_summary: 'summary',
  scheduling_intent: false,
  created_at: createdAt,
  human_reply_text: 'Tomorrow between 1-3pm!',
  human_reply_sms_id: `sms-${id}`,
  inbound_at: createdAt,
});

describe('sealEvalItems — selection contract', () => {
  test('pool already at target → no candidate query side effects, sealed: 0', async () => {
    const dbi = makeFakeDb({ activeCount: 100 });
    const out = await sealEvalItems({ target: 100, dbi });
    expect(out.sealed).toBe(0);
    expect(out.activeCount).toBe(100);
    expect(dbi.inserts).toHaveLength(0);
  });

  test('candidate query excludes backfill cohorts, requires frozen facts + real human reply, and applies the age cutoff as a real Date', async () => {
    const dbi = makeFakeDb({ activeCount: 0, candidates: [] });
    await sealEvalItems({ target: 10, dbi });

    const raws = dbi.calls.filter(([m]) => m === 'whereRaw').map(([, args]) => args[0]);
    expect(raws.some((sql) => /prompt_version NOT LIKE '%backfill'/.test(sql))).toBe(true);
    expect(raws.some((sql) => /facts_block/.test(sql))).toBe(true);
    expect(raws.some((sql) => /human_reply_text/.test(sql))).toBe(true);

    // ET/timestamptz discipline: the age boundary must be a real Date object,
    // never a hand-built naive string (waves-db rule).
    const ageWhere = dbi.calls.find(([m, args]) => m === 'where' && args[0] === 'md.created_at');
    expect(ageWhere).toBeTruthy();
    expect(ageWhere[1][2]).toBeInstanceOf(Date);

    // The anti-join keeps re-runs idempotent.
    const antiJoin = dbi.calls.find(([m, args]) => m === 'whereNull' && args[0] === 'si.id');
    expect(antiJoin).toBeTruthy();
  });

  test('stratifies round-robin across intents so a chatty intent cannot crowd the exam', async () => {
    const candidates = [
      // 4 general (newest first, as the query orders), 2 billing
      cand('g1', 'general', '2026-07-10'),
      cand('g2', 'general', '2026-07-09'),
      cand('g3', 'general', '2026-07-08'),
      cand('g4', 'general', '2026-07-07'),
      cand('b1', 'billing_question_needs_review', '2026-07-10'),
      cand('b2', 'billing_question_needs_review', '2026-07-09'),
    ];
    const dbi = makeFakeDb({ activeCount: 0, candidates });
    const out = await sealEvalItems({ target: 4, dbi });
    expect(out.sealed).toBe(4);
    const ids = dbi.inserts[0].map((r) => r.source_draft_id);
    // Round-robin: g1, b1, g2, b2 — never g1..g4.
    expect(ids.sort()).toEqual(['b1', 'b2', 'g1', 'g2']);
  });

  test('sealed rows carry the frozen snapshot verbatim and the exemplar-exclusion key', async () => {
    const dbi = makeFakeDb({ activeCount: 0, candidates: [cand('x1', 'general', '2026-07-01')] });
    await sealEvalItems({ target: 5, dbi });
    const row = dbi.inserts[0][0];
    expect(row).toMatchObject({
      source_draft_id: 'x1',
      intent: 'general',
      facts_block: 'CUSTOMER: frozen facts',
      human_reply_text: 'Tomorrow between 1-3pm!',
      human_reply_sms_id: 'sms-x1',
      schema_version: 'sms-sealed-eval.v1',
    });
    // Inserts go through onConflict(source_draft_id).ignore() — never update.
    expect(dbi.calls.some(([m, args]) => m === 'onConflict' && args[0] === 'source_draft_id')).toBe(true);
    expect(dbi.calls.some(([m]) => m === 'ignore')).toBe(true);
  });

  test('null intent buckets as GENERAL on the sealed row', async () => {
    const c = cand('n1', null, '2026-07-01');
    const dbi = makeFakeDb({ activeCount: 0, candidates: [c] });
    await sealEvalItems({ target: 5, dbi });
    expect(dbi.inserts[0][0].intent).toBe('GENERAL');
  });
});
