/**
 * MOVE PROOFREADER (owner 2026-10-09, "proofreader yes"): one model reads the
 * customer record before an automatic move and answers allow / hold / unknown.
 *
 * NOT called by the nightly run yet. Step 1 is the replay over past moves
 * (server/scripts/auto-dispatch-proofreader-replay.js); the nightly shadow
 * call and its gate come in a later PR.
 *
 * The code is the judge of the model's answer:
 *   - a hold counts only when its quote is found word for word in the entry
 *     it names; a hold without that is "unknown";
 *   - an allow on an incomplete record (record.unread) is "unknown";
 *   - a failed call, a refusal or a malformed answer is "unknown";
 *   - a record past the size limit is "unknown" and no model is asked.
 * "unknown" never reads as allow. One call, one leg, no automatic fallback:
 * a miss leaves the visit in place and the next run tries again.
 */
const {
  PROMPT_VERSION, VERDICTS, VERDICT_SCHEMA, SYSTEM_PROMPT, buildText, moveFacts,
} = require('./prompt');
const { buildCustomerRecord } = require('./record');

const TIMEOUT_MS = 120000;
const MAX_TOKENS = 4096;

// Compare a quote with its entry the way a person would: case, runs of
// white space and typographic quote marks do not matter.
const fold = (text) => String(text || '')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim().toLowerCase();

const unknown = (why, extra = {}) => ({
  verdict: 'unknown', why, entry_id: null, quote: null, reason: null, ...extra,
});

// An allow that also names an entry or a quote contradicts itself: it is a
// bad answer, never permission (Codex #6258 r5).
function validAnswer(json) {
  if (!json || typeof json !== 'object' || !VERDICTS.includes(json.verdict)) return false;
  if (!['entry_id', 'quote', 'reason'].every((key) => typeof json[key] === 'string')) return false;
  return json.verdict !== 'allow' || (!json.entry_id.trim() && !json.quote.trim());
}

// The entry and the quote of an answer, when the quote really is in the entry.
function evidenceOf(json, record) {
  const found = record.entries.find((row) => row.id === json.entry_id.trim());
  const quote = fold(json.quote);
  if (!found || !quote || !fold(found.text).includes(quote)) return null;
  return { entry_id: found.id, quote: json.quote.trim() };
}

/**
 * The final verdict for a model answer. Pure.
 * @returns {{ verdict, why, entry_id, quote, reason, model_verdict }}
 */
function judge(json, record) {
  if (!validAnswer(json)) return unknown('bad_answer');
  const said = { model_verdict: json.verdict, reason: json.reason.trim() };
  const evidence = json.verdict === 'allow' ? null : evidenceOf(json, record);
  if (json.verdict === 'hold') {
    return evidence
      ? { verdict: 'hold', why: 'quoted_statement', ...evidence, ...said }
      : unknown('hold_without_quote', said);
  }
  if (json.verdict === 'unknown') return unknown('model_unsure', { ...(evidence || {}), ...said });
  if (record.unread.length) return unknown('record_incomplete', said);
  return {
    verdict: 'allow', why: 'nothing_breaks', entry_id: null, quote: null, ...said,
  };
}

/**
 * Ask the model about one move. `route` and `llm` are injectable for the
 * replay's model arms and for tests.
 * @returns the judge() result plus { model, prompt_version, usage }
 */
async function proofreadMove({ move, record }, { route, llm = require('../../llm/call') } = {}) {
  const leg = route || require('../../../config/models').ROUTES.autoDispatchProofreader;
  const stamp = { model: leg.model, prompt_version: PROMPT_VERSION };
  if (record.tooLong) return { ...unknown('record_too_long'), ...stamp };
  let result;
  try {
    result = await llm.dispatch(leg, {
      system: SYSTEM_PROMPT,
      text: buildText({ move, record }),
      jsonMode: true,
      jsonSchema: VERDICT_SCHEMA,
      maxTokens: MAX_TOKENS,
      timeoutMs: TIMEOUT_MS,
      laneId: 'auto_dispatch_proofreader', // a literal: llm-call-ledger-coverage.test.js reads it here
      promptVersion: PROMPT_VERSION,
    });
  } catch {
    result = { ok: false, reason: 'error' };
  }
  const usage = result && result.usage ? { usage: result.usage } : {};
  if (!result || !result.ok) return { ...unknown('model_failed', { reason: (result && result.reason) || 'error' }), ...stamp, ...usage };
  return { ...judge(result.json, record), ...stamp, ...usage };
}

module.exports = {
  PROMPT_VERSION, proofreadMove, judge, buildCustomerRecord, moveFacts,
};
