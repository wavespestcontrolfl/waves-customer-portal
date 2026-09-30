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
    const builder = { _table: tableKey, _isCount: false, _insertRows: null, _update: false };
    const record = (name) => (...args) => {
      if ((name === 'where' || name === 'whereNull') && typeof args[0] === 'function') {
        args[0].call(builder);
      } else {
        calls.push([name, args, tableKey]);
      }
      if (name === 'count') builder._isCount = true;
      if (name === 'update') builder._update = true;
      if (name === 'insert') {
        builder._insertRows = args[0];
        inserts.push(args[0]);
      }
      return builder;
    };
    for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw',
      'join', 'leftJoin', 'select', 'count', 'groupBy', 'orderBy', 'limit', 'insert', 'onConflict', 'ignore', 'first', 'update']) {
      builder[m] = record(m);
    }
    builder.then = (resolve, reject) => {
      let rows;
      if (builder._update) rows = 0; // nothing retired to restore, nothing to retire
      else if (builder._insertRows) rows = [];
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

// COMPANY FACTS is matched by the EXACT rendered section before the first
// BILLING: line (Codex #5392 r3 P2), not a header LIKE, so its clause binds
// the delimiter + exact suffixes; SLA and FREE RE-SERVICE stay LIKE markers.
const {
  BILLING_DELIMITER: D_, exactStructureRegexSource,
} = require('../services/sms-company-facts');
// SLA line (substring), COMPANY FACTS + LABEL FACTS (exact-structure regex
// twins of hasExactCompanyFacts / hasExactLabelFacts), FREE RE-SERVICE line.
const CONTRACT_BINDINGS = [
  '%FOLLOW-UP SLA RIGHT NOW:%',
  D_, D_, exactStructureRegexSource('optional'),
  D_, D_, exactStructureRegexSource('required'),
  '%FREE RE-SERVICE:%',
];

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


// Pre-push audit P1 on Codex r3 (PR #5119): once the exam grades under a v12
// prompt, a pool already full of pre-v12 items must still replenish — the
// target counts only compatible items, only compatible drafts are sealed,
// and the oldest displaced pre-v12 items are retired (active=false), never
// deleted. v11 has a contract too since #5194 r7 (rollbacks).
describe('sealEvalItems — v12 compatibility-aware replenishment', () => {
  const MARKER = 'FOLLOW-UP SLA RIGHT NOW:';
  const drafter = require('../services/sms-shadow-drafter');
  let versionSpy;
  afterEach(() => { if (versionSpy) versionSpy.mockRestore(); versionSpy = null; });

  // A fake that answers the two counts differently and records updates.
  // `restorable`: rows a restore UPDATE ({ active: true }) reports; a retire always reports 3.
  function makeV12FakeDb({ activeCount, compatibleCount, candidates, restorable = 0 }) {
    const calls = [];
    const inserts = [];
    const updates = [];
    const dbi = (table) => {
      const tableKey = typeof table === 'object' ? Object.values(table)[0] : table;
      const b = { _table: tableKey, _isCount: false, _compat: false, _insertRows: null, _update: null, _raws: [] };
      const record = (name) => (...args) => {
        calls.push([name, args, tableKey]);
        if (name === 'count') b._isCount = true;
        // the compatibility predicate (count + candidates) starts with the LIKE clause; retirement wraps it in NOT (...)
        if (name === 'whereRaw' && /^(?:md\.facts_block|COALESCE\(facts_block, ''\)) (?:NOT )?LIKE \?/.test(String(args[0])) && String(args[1]?.[0] || '').includes(MARKER)) b._compat = true;
        if (name === 'whereRaw') b._raws.push([args[0], args[1]]);
        if (name === 'modify') args[0](b);
        if (name === 'insert') { b._insertRows = args[0]; inserts.push(args[0]); }
        if (name === 'update') { b._update = args[0]; updates.push({ patch: args[0], raws: b._raws }); }
        return b;
      };
      for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'modify',
        'join', 'leftJoin', 'select', 'count', 'groupBy', 'orderBy', 'limit', 'insert', 'onConflict', 'ignore', 'first', 'update']) {
        b[m] = record(m);
      }
      b.then = (resolve, reject) => {
        let rows;
        if (b._update) rows = b._update.active === true ? restorable : 3; // restore vs retire row counts
        else if (b._insertRows) rows = [];
        else if (b._isCount) rows = [{ count: String(b._compat ? compatibleCount : activeCount) }];
        else rows = candidates;
        return Promise.resolve(rows).then(resolve, reject);
      };
      return b;
    };
    dbi.raw = (sql) => sql;
    return Object.assign(dbi, { calls, inserts, updates });
  }
  const v12cand = (id, createdAt) => ({ ...cand(id, 'SCHEDULING', createdAt), facts_block: `CUSTOMER: x\n${MARKER} within the hour\n` });

  test('v12: a pool FULL of pre-v12 items still seals compatible candidates and retires the displaced oldest pre-v12 items', async () => {
    versionSpy = jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue('house_voice_v12_real_answers+b');
    const dbi = makeV12FakeDb({ activeCount: 100, compatibleCount: 0, candidates: [v12cand('a', '2026-08-01'), v12cand('b', '2026-08-02'), v12cand('c', '2026-08-03')] });
    const out = await sealEvalItems({ target: 100, dbi });
    expect(out.sealed).toBe(3);
    expect(out.retired).toBe(3);
    expect(out.reactivated).toBe(0); // no retired plain items to restore in this fake (restorable defaults to 0)
    expect(out.activeCount).toBe(100);
    // candidates were restricted to v12-compatible drafts
    expect(dbi.calls.some(([name, args]) => name === 'whereRaw' && /md\.facts_block LIKE/.test(String(args[0])))).toBe(true);
    // the reactivation attempt ran first (Codex r5 #5194 P2), found nothing, then the retirement
    // targeted pre-v12 rows (NOT LIKE marker), oldest first, capped at the overflow
    const restoreUpdates = dbi.updates.filter((u) => u.patch.active === true);
    const retireUpdates = dbi.updates.filter((u) => u.patch.active === false);
    expect(restoreUpdates).toHaveLength(1);
    expect(retireUpdates).toHaveLength(1);
    expect(dbi.calls.some(([name, args]) => name === 'whereRaw' && /NOT LIKE/.test(String(args[0])))).toBe(true);
    expect(dbi.calls.some(([name, args]) => name === 'limit' && args[0] === 3)).toBe(true);
    expect(dbi.calls.some(([name, args]) => name === 'orderBy' && args[0] === 'sealed_at' && args[1] === 'asc')).toBe(true);
  });

  test('v12: an OVERSIZED pool with enough compatible items seals nothing but still prunes the pre-v12 overflow (Codex r4)', async () => {
    versionSpy = jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue('house_voice_v12_real_answers');
    const dbi = makeV12FakeDb({ activeCount: 200, compatibleCount: 100, candidates: [] });
    const out = await sealEvalItems({ target: 100, dbi });
    expect(out.sealed).toBe(0);
    expect(out.retired).toBe(3); // the fake reports 3 rows updated
    expect(dbi.inserts).toHaveLength(0);
    expect(dbi.updates).toHaveLength(1);
    expect(dbi.updates[0].patch).toEqual({ active: false });
    expect(dbi.calls.some(([name, args]) => name === 'limit' && args[0] === 100)).toBe(true);
  });

  test('v12: a pool with enough compatible items seals nothing', async () => {
    versionSpy = jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue('house_voice_v12_real_answers');
    const dbi = makeV12FakeDb({ activeCount: 100, compatibleCount: 100, candidates: [v12cand('a', '2026-08-01')] });
    const out = await sealEvalItems({ target: 100, dbi });
    expect(out.sealed).toBe(0);
    expect(dbi.inserts).toHaveLength(0);
    expect(dbi.updates).toHaveLength(0);
  });

  test('+c (complaints on): the compatibility count, the candidate filter and the retirement all require BOTH fact lines', async () => {
    versionSpy = jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue('house_voice_v12_real_answers_cfl+c');
    const dbi = makeV12FakeDb({ activeCount: 100, compatibleCount: 0, candidates: [v12cand('a', '2026-08-01')] });
    await sealEvalItems({ target: 100, dbi });
    const likeRaws = dbi.calls.filter(([name, args]) => name === 'whereRaw' && /LIKE \?/.test(String(args[0])));
    expect(likeRaws.length).toBeGreaterThanOrEqual(3); // count, candidates, retirement
    for (const [, args] of likeRaws) {
      expect(args[1]).toEqual(CONTRACT_BINDINGS);
      expect(String(args[0])).not.toMatch(/NOT LIKE/); // _cf+c: every fact the version carries is required, none forbidden
    }
    expect(likeRaws.some(([, args]) => /^NOT \(/.test(String(args[0])))).toBe(true);
  });

  // Codex #5194 r7 P1: v11 has a contract too — a rollback must not keep
  // grading items frozen with the v12 lines.
  test('v11 (a rollback): the count, the candidate filter and the retirement all EXCLUDE the v12 SLA and category lines', async () => {
    versionSpy = jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue('house_voice_v11');
    const dbi = makeV12FakeDb({ activeCount: 100, compatibleCount: 98, candidates: [cand('a', 'GENERAL', '2026-08-01'), cand('b', 'GENERAL', '2026-08-02'), cand('c', 'GENERAL', '2026-08-03')] });
    const out = await sealEvalItems({ target: 100, dbi });
    expect(out.sealed).toBe(2); // the shortfall is 100 - 98 compatible, not 100 - 100 active
    const contract = dbi.calls.filter(([name, args]) => name === 'whereRaw' && /NOT LIKE \?/.test(String(args[0])) && !/^NOT \(/.test(String(args[0])));
    expect(contract.length).toBeGreaterThanOrEqual(2); // the count + the candidate filter
    for (const [, args] of contract) {
      expect(String(args[0])).not.toMatch(/(?<!NOT )LIKE \?/); // nothing required, both lines forbidden
      expect(args[1]).toEqual(CONTRACT_BINDINGS);
    }
    expect(dbi.calls.some(([name, args]) => name === 'whereRaw' && /^md\.facts_block NOT LIKE/.test(String(args[0])))).toBe(true);
    // the v12 items beyond the target are retired (the fake reports 3)
    expect(dbi.updates.filter((u) => u.patch.active === false)).toHaveLength(1);
  });

  // Codex #5194 r5: after a category-gate rollback the retired items the
  // current contract matches come back; the anti-join never re-seals them.
  describe('reactivation of previously-retired items', () => {
    test('the finding\'s scenario: a plain-v12 pool full of complaint items reactivates retired plain items instead of sourcing new drafts', async () => {
      versionSpy = jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue('house_voice_v12_real_answers');
      // Every active item is a +c complaint item (compatibleCount: 0 under
      // plain v12), and enough retired plain-v12 items exist to cover the
      // whole shortfall (restorable: 100 === target - compatibleCount).
      const dbi = makeV12FakeDb({ activeCount: 100, compatibleCount: 0, candidates: [], restorable: 100 });
      const out = await sealEvalItems({ target: 100, dbi });

      const restoreUpdates = dbi.updates.filter((u) => u.patch.active === true);
      const retireUpdates = dbi.updates.filter((u) => u.patch.active === false);
      expect(restoreUpdates).toHaveLength(1);
      expect(retireUpdates).toHaveLength(1); // the incompatible complaint overflow still gets retired

      // filtered by the EXACT current contract: SLA line required, FREE RE-SERVICE forbidden
      const likeRaws = dbi.calls.filter(([name, args]) => name === 'whereRaw' && /LIKE \?/.test(String(args[0])) && !/^NOT \(/.test(String(args[0])));
      expect(likeRaws.length).toBeGreaterThanOrEqual(2); // the compat count + the restore filter
      for (const [, args] of likeRaws) {
        expect(args[1]).toEqual(CONTRACT_BINDINGS);
      }
      // restore targets INACTIVE rows, newest sealed_at first, limited to the whole shortfall (100)
      expect(dbi.calls.some(([name, args]) => name === 'where' && args[0] === 'active' && args[1] === false)).toBe(true);
      expect(dbi.calls.some(([name, args]) => name === 'orderBy' && args[0] === 'sealed_at' && args[1] === 'desc')).toBe(true);
      expect(dbi.calls.some(([name, args]) => name === 'limit' && args[0] === 100)).toBe(true);

      // no new drafts sourced — the restore alone reached target
      expect(dbi.inserts).toHaveLength(0);

      expect(out.reactivated).toBe(100);
      expect(out.retired).toBe(3); // fake's hardcoded retire row count
      expect(out.activeCount).toBe(197); // 100 active + 100 reactivated - 3 retired
    });

    test('a partial restore leaves the rest to be sourced from new drafts (the candidate cap is the leftover, not the whole shortfall)', async () => {
      versionSpy = jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue('house_voice_v12_real_answers');
      const candidates = Array.from({ length: 25 }, (_, i) => v12cand(`n${i}`, `2026-08-${String(i + 1).padStart(2, '0')}`));
      // shortfall = target(100) - compatibleCount(70) = 30; only 10 restore
      const dbi = makeV12FakeDb({ activeCount: 90, compatibleCount: 70, candidates, restorable: 10 });
      const out = await sealEvalItems({ target: 100, dbi });

      expect(out.reactivated).toBe(10);
      // the restore attempt was capped at the FULL shortfall (30), not the post-restore remainder
      expect(dbi.calls.some(([name, args]) => name === 'limit' && args[0] === 30)).toBe(true);
      const restoreUpdates = dbi.updates.filter((u) => u.patch.active === true);
      expect(restoreUpdates).toHaveLength(1);

      // only the 20 leftover (30 - 10 restored) are sourced from new candidates, not all 25 available
      expect(out.sealed).toBe(20);
      expect(dbi.inserts[0]).toHaveLength(20);
    });

    test('a v11 rollback restores the pre-v12 items the v12 pool displaced', async () => {
      versionSpy = jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue('house_voice_v11');
      const dbi = makeV12FakeDb({ activeCount: 100, compatibleCount: 0, candidates: [], restorable: 100 });
      const out = await sealEvalItems({ target: 100, dbi });
      expect(out.reactivated).toBe(100);
      expect(dbi.inserts).toHaveLength(0);
      expect(dbi.updates.filter((u) => u.patch.active === true)).toHaveLength(1);
      // the restore selects RETIRED rows under the v11 contract: both v12 lines forbidden
      expect(dbi.calls.some(([name, args]) => name === 'where' && args[0] === 'active' && args[1] === false)).toBe(true);
      expect(dbi.calls.some(([name, args]) => name === 'whereRaw' && /^COALESCE\(facts_block, ''\) NOT LIKE \?/.test(String(args[0]))
        && JSON.stringify(args[1]) === JSON.stringify(CONTRACT_BINDINGS))).toBe(true);
      expect(dbi.updates.filter((u) => u.patch.active === false)).toHaveLength(1); // the v12 items are retired
    });
  });
});


// #5194 r1 P1: the contract is exact — under plain v12 (complaints off) the
// freezer counts, selects and keeps only rows WITHOUT the FREE RE-SERVICE line.
test('v12 without +c or _cf: the compatibility SQL requires the SLA line AND forbids the COMPANY FACTS and FREE RE-SERVICE lines', async () => {
  const drafter = require('../services/sms-shadow-drafter');
  const spy = jest.spyOn(drafter, 'currentPromptVersion').mockReturnValue('house_voice_v12_real_answers');
  try {
    const calls = [];
    const dbi = (table) => {
      const b = {};
      for (const m of ['where', 'whereIn', 'whereRaw', 'join', 'leftJoin', 'select', 'count', 'orderBy', 'limit', 'insert', 'onConflict', 'ignore', 'update']) {
        b[m] = (...args) => { calls.push([m, args]); return b; };
      }
      b.then = (resolve) => Promise.resolve(calls.some(([m]) => m === 'count') && !calls.some(([m]) => m === 'insert') ? [{ count: '100' }] : []).then(resolve);
      return b;
    };
    dbi.raw = (sql) => sql;
    await sealEvalItems({ target: 100, dbi });
    const compat = calls.find(([m, args]) => m === 'whereRaw' && /LIKE \?/.test(String(args[0])));
    // the pre-_cf identity also forbids COMPANY FACTS (Codex #5392 r1)
    expect(compat[1][0]).toMatch(/^COALESCE\(facts_block, ''\) LIKE \? AND NOT \(position\(\?::text in .*split_part\(.*\) AND NOT \(position\(\?::text in .*split_part\(.*\) AND COALESCE\(facts_block, ''\) NOT LIKE \?$/);
    expect(compat[1][1]).toEqual(CONTRACT_BINDINGS);
  } finally {
    spy.mockRestore();
  }
});
