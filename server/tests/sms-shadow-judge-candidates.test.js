/**
 * Judge candidate eligibility — query contract (owner 2026-07-11: judge
 * CORRECTED suggestions too; training throughput without autonomy).
 *
 * The pure suite can't see the knex filters, so a capturing fake asserts the
 * candidate query (a) keeps the classic status='shadow' lane, (b) adds the
 * suggested+corrected OR-branch, (c) joins the draft's Agent Review decision
 * scoped to the suggest workflow, (d) requires the corrected branch's
 * decision-linked send to exist, have left the system, and carry text — the
 * judge pairs corrected drafts to THAT send, never the reply window — and
 * NOTHING admits an accepted (verbatim) suggestion, whose judging would be
 * self-pairing.
 */
jest.mock('../models/db', () => {
  const calls = [];
  const builder = {};
  const record = (name) => (...args) => {
    if ((name === 'where' || name === 'orWhere') && typeof args[0] === 'function') {
      calls.push([name, 'group:enter']);
      args[0].call(builder);
      calls.push([name, 'group:exit']);
    } else if (name === 'whereExists' && typeof args[0] === 'function') {
      const existsCtx = {};
      for (const m of ['select', 'from', 'where', 'whereIn', 'whereRaw']) {
        existsCtx[m] = (...a) => { calls.push([`exists.${m}`, a]); return existsCtx; };
      }
      calls.push(['whereExists', 'group:enter']);
      args[0].call(existsCtx);
      calls.push(['whereExists', 'group:exit']);
    } else if (name === 'leftJoin' && typeof args[1] === 'function') {
      const joinCtx = {
        on: (...a) => { calls.push(['join.on', a]); return joinCtx; },
        andOnVal: (...a) => { calls.push(['join.andOnVal', a]); return joinCtx; },
      };
      calls.push(['leftJoin', [args[0]]]);
      args[1].call(joinCtx);
    } else {
      calls.push([name, args]);
    }
    return builder;
  };
  for (const m of ['leftJoin', 'where', 'orWhere', 'whereExists', 'whereNull', 'whereIn', 'whereNotIn', 'select', 'orderBy', 'limit']) {
    builder[m] = record(m);
  }
  builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject); // zero drafts → early return
  const dbi = () => builder;
  dbi.raw = (sql) => sql;
  dbi.__calls = calls;
  return dbi;
});

const db = require('../models/db');
const { judgeShadowDrafts } = require('../services/sms-shadow-judge');
const { SUGGEST_WORKFLOW, HUMAN_REPLY_TYPES, SENT_STATUSES } = require('../services/sms-suggest-mode');

test('candidate query admits shadow drafts AND corrected suggestions, never accepted ones', async () => {
  const result = await judgeShadowDrafts({ batchLimit: 5 });
  expect(result.judged).toBe(0); // fake returns no drafts — we only inspect the query

  const calls = db.__calls;
  const flat = JSON.stringify(calls);

  // decision join scoped to the suggest workflow + entity type
  expect(flat).toContain('"join.andOnVal",["ad.entity_type","message_draft"]');
  expect(flat).toContain(`"join.andOnVal",["ad.workflow","${SUGGEST_WORKFLOW}"]`);

  // the classic shadow lane and the corrected-suggestion branch both present
  expect(flat).toContain('"where",["message_drafts.status","shadow"]');
  expect(flat).toContain('"where",["message_drafts.status","suggested"]');
  expect(flat).toContain('"where",["ad.status","corrected"]');
  // nothing anywhere admits accepted suggestions
  expect(flat).not.toContain('"accepted"');

  // corrected branch requires its decision-linked send: the exact row that
  // resolved the Agent Review decision, actually left the system, non-empty
  // body — the judge pairs against THAT send, never the window heuristic,
  // so a late (24–48h) or parallel-thread outbound can't corrupt the signal
  // (Codex P2 ×2 on #2612)
  expect(flat).toContain('"whereExists","group:enter"');
  expect(flat).toContain(
    '"exists.whereRaw",["corrected_send.metadata->>\'agent_decision_id\' = ad.id::text"]'
  );
  expect(flat).toContain('"exists.where",["corrected_send.direction","outbound"]');
  expect(flat).toContain(
    `"exists.whereIn",["corrected_send.message_type",${JSON.stringify(HUMAN_REPLY_TYPES)}]`
  );
  expect(flat).toContain(
    `"exists.whereIn",["corrected_send.status",${JSON.stringify(SENT_STATUSES)}]`
  );
  expect(flat).toContain(
    '"exists.whereRaw",["TRIM(COALESCE(corrected_send.message_body, \'\')) <> \'\'"]'
  );

  // the loop needs the lane + decision id to route pairing
  expect(flat).toContain('"message_drafts.status as draft_status"');
  expect(flat).toContain('"ad.id as decision_id"');
});
