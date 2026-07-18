/**
 * Corrected-suggestion pairing — flow contract (Codex P2 ×2 on #2612).
 *
 * A corrected suggestion's ground truth is the send that RESOLVED its Agent
 * Review decision (sms_log.metadata agent_decision_id linkage stamped by
 * both send paths), never the reply-window heuristic. This harness drives
 * judgeShadowDrafts end-to-end over a routing fake-knex and asserts:
 *   1. the corrected draft is scored against its decision-linked send even
 *      when that send lands OUTSIDE REPLY_WINDOW_HOURS (staff can act as
 *      late as the 48h suggest expiry) while an unrelated same-customer
 *      outbound sits INSIDE the window (parallel thread) — the heuristic
 *      would have picked the wrong text or recorded human_no_reply;
 *   2. shadow drafts in the same batch still pair heuristically;
 *   3. a corrected draft whose linked send vanished between the candidate
 *      read and the pairing read (delivery-failure callback) is SKIPPED for
 *      the next run, never miscounted as human_no_reply.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => (function AnthropicMock() { return {}; }));
jest.mock('../services/llm/deep', () => ({
  createDeepMessage: jest.fn(async () => ({
    model: 'claude-test-judge',
    content: [{ type: 'text', text: '{"voice":8,"safety":9,"actions":8,"overall":8,"verdict":"equivalent","notes":"test"}' }],
  })),
}));

jest.mock('../models/db', () => {
  const state = {
    fixtures: { drafts: [], outbounds: [], inbounds: [], correctedSends: [] },
    judgments: [],
  };
  const METADATA_LINK = "metadata->>'agent_decision_id'";
  const dbi = (table) => {
    const ops = [];
    const b = {};
    for (const m of ['leftJoin', 'where', 'orWhere', 'whereExists', 'whereNull', 'whereIn', 'whereNotIn', 'whereRaw', 'select', 'orderBy', 'limit', 'onConflict', 'ignore']) {
      b[m] = (...args) => { ops.push([m, args]); return b; };
    }
    b.insert = (row) => { ops.push(['insert', [row]]); return b; };
    b.then = (resolve, reject) => {
      let out;
      if (table === 'message_drafts') {
        out = state.fixtures.drafts;
      } else if (table === 'shadow_draft_judgments') {
        const ins = ops.find((o) => o[0] === 'insert');
        if (ins) state.judgments.push(ins[1][0]);
        out = 1;
      } else if (table === 'sms_log') {
        const isInbound = ops.some((o) => o[0] === 'where' && o[1][0] === 'direction' && o[1][1] === 'inbound');
        const byDecisionLink = ops.some((o) => o[0] === 'whereIn' && o[1][0] === METADATA_LINK);
        out = isInbound ? state.fixtures.inbounds : byDecisionLink ? state.fixtures.correctedSends : state.fixtures.outbounds;
      } else {
        out = [];
      }
      return Promise.resolve(out).then(resolve, reject);
    };
    return b;
  };
  dbi.raw = (sql) => sql;
  dbi.__state = state;
  return dbi;
});

const db = require('../models/db');
const logger = require('../services/logger');
const { createDeepMessage } = require('../services/llm/deep');
const { judgeShadowDrafts, _test: { REPLY_WINDOW_HOURS } } = require('../services/sms-shadow-judge');

const HOUR = 3600 * 1000;
const base = new Date('2026-07-08T12:00:00Z').getTime();
const at = (offsetHours) => new Date(base + offsetHours * HOUR).toISOString();

const correctedDraft = {
  id: 'draft-corrected',
  customer_id: 'c1',
  inbound_message: 'Can you come earlier?',
  draft_response: 'Hi! We can look at earlier windows.',
  intent: 'GENERAL',
  context_summary: 'Dale Cooper — Quarterly Pest',
  facts_block: null,
  created_at: at(0),
  sms_log_id: 'in-1',
  draft_status: 'suggested',
  decision_id: 'dec-1',
  inbound_at: at(0),
};
const shadowDraft = {
  id: 'draft-shadow',
  customer_id: 'c2',
  inbound_message: 'What time Friday?',
  draft_response: 'Morning! 8-10am Friday.',
  intent: 'GENERAL',
  context_summary: null,
  facts_block: null,
  created_at: at(0),
  sms_log_id: 'in-2',
  draft_status: 'shadow',
  decision_id: null,
  inbound_at: at(0),
};

beforeEach(() => {
  jest.clearAllMocks();
  db.__state.judgments.length = 0;
  db.__state.fixtures.drafts = [correctedDraft, shadowDraft];
  db.__state.fixtures.inbounds = [];
  db.__state.fixtures.outbounds = [
    // Inside the window, same customer, but a parallel-thread reply — the
    // heuristic would have grabbed this as c1's ground truth.
    { id: 'unrelated-parallel-thread', customer_id: 'c1', message_body: 'Re your OTHER question: yes.', created_at: at(1) },
    { id: 'c2-human-reply', customer_id: 'c2', message_body: 'We will be there 8-10 Friday.', created_at: at(1) },
  ];
  db.__state.fixtures.correctedSends = [
    // The decision-resolving edit, landing OUTSIDE the reply window.
    { id: 'linked-corrected-send', customer_id: 'c1', message_body: 'We can do 10am — see you then!', created_at: at(REPLY_WINDOW_HOURS + 6), decision_id: 'dec-1' },
  ];
});

test('corrected draft pairs to its decision-linked send — late edit scored, parallel-thread outbound ignored', async () => {
  const result = await judgeShadowDrafts({ batchLimit: 10 });
  expect(result.judged).toBe(2);

  const byDraft = Object.fromEntries(db.__state.judgments.map((j) => [j.draft_id, j]));

  const corrected = byDraft['draft-corrected'];
  expect(corrected.human_reply_sms_id).toBe('linked-corrected-send');
  expect(corrected.human_reply_text).toBe('We can do 10am — see you then!');
  expect(corrected.human_replied).toBe(true);
  expect(corrected.verdict).toBe('equivalent'); // LLM-scored — NOT human_no_reply

  // the judge prompt graded the draft against the linked edit, not the
  // parallel-thread reply the window heuristic would have picked
  const prompts = createDeepMessage.mock.calls.map(([, req]) => req.messages[0].content);
  const correctedPrompt = prompts.find((p) => p.includes('Can you come earlier?'));
  expect(correctedPrompt).toContain('We can do 10am — see you then!');
  expect(correctedPrompt).not.toContain('Re your OTHER question');

  // the shadow lane is untouched: heuristic pairing still applies
  expect(byDraft['draft-shadow'].human_reply_sms_id).toBe('c2-human-reply');
});

test('corrected draft whose linked send vanished mid-run is skipped, never human_no_reply', async () => {
  db.__state.fixtures.correctedSends = [];

  const result = await judgeShadowDrafts({ batchLimit: 10 });
  expect(result.judged).toBe(1);
  expect(db.__state.judgments.map((j) => j.draft_id)).toEqual(['draft-shadow']);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lost its linked send'));
});
