/**
 * Judge candidate eligibility — query contract (owner 2026-07-11: judge
 * CORRECTED suggestions too; training throughput without autonomy).
 *
 * The pure suite can't see the knex filters, so a capturing fake asserts the
 * candidate query (a) keeps the classic status='shadow' lane, (b) adds the
 * suggested+corrected OR-branch, (c) joins the draft's Agent Review decision
 * scoped to the suggest workflow — and NOTHING admits an accepted (verbatim)
 * suggestion, whose judging would be self-pairing.
 */
jest.mock('../models/db', () => {
  const calls = [];
  const builder = {};
  const record = (name) => (...args) => {
    if ((name === 'where' || name === 'orWhere') && typeof args[0] === 'function') {
      calls.push([name, 'group:enter']);
      args[0].call(builder);
      calls.push([name, 'group:exit']);
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
  for (const m of ['leftJoin', 'where', 'orWhere', 'whereNull', 'whereIn', 'whereNotIn', 'select', 'orderBy', 'limit']) {
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
const { SUGGEST_WORKFLOW } = require('../services/sms-suggest-mode');

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
});
