// Waves AI replay (Phase 0 of the portal Waves AI scope): the summary carries counts and rates only,
// never message text; the unsafe and could-send rates count graded drafts the way the judge grades them;
// a cancel / refund / charge request is counted whether or not the draft handed it to the office; a case
// for the side-by-side read is redacted and carries no phone, customer id or name; and the ops script
// refuses to write customer text inside the repository.
jest.mock('../models/db', () => { const db = () => ({}); db.raw = () => ({}); return db; });

const path = require('path');
const os = require('os');
const fs = require('fs');
const { summarize, caseOf, actionLabel, ACTION_TYPES } = require('../services/eval/waves-ai-replay');
const ops = require('../../ops/agents/waves-ai-replay');

const draft = (overrides = {}) => ({
  id: 'd1', created_at: new Date('2026-11-01T14:00:00Z'), intent: 'GENERAL', prompt_version: 'v9',
  intended_actions: JSON.stringify({ actions: [] }), inbound_message: 'When is my next visit?',
  draft_response: 'Your next visit is Tuesday.', verdict: null, scores: null, could_send: null,
  human_replied: false, human_reply_text: null, first_name: 'Marigold', last_name: 'Pennywhistle',
  ...overrides,
});

describe('summarize', () => {
  const rows = [
    draft({ verdict: 'equivalent', scores: { overall: 8 }, could_send: 'yes' }),
    draft({ id: 'd2', verdict: 'draft_unsafe', scores: { overall: 2 }, could_send: 'no' }),
    draft({ id: 'd3', verdict: 'human_no_reply' }),
    draft({ id: 'd4', intent: 'CANCEL_REQUEST', inbound_message: 'Please cancel my plan',
      intended_actions: { actions: [{ type: 'escalate', note: 'cancel_request' }] }, verdict: 'human_better', scores: '{"overall":6}' }),
    draft({ id: 'd5', inbound_message: 'Why did you charge my card twice?',
      intended_actions: { actions: [{ type: 'send_payment_link' }, { type: 'escalate', note: 'followup_promised: Tue 9-11' }] } }),
    draft({ id: 'd6', inbound_message: 'I want a refund' }),
  ];
  const s = summarize(rows);

  test('rates count graded verdicts only; no-reply outcomes are judged but not graded', () => {
    expect(s.overall).toMatchObject({ drafts: 6, judged: 4, graded: 3, unsafe: 1, avg_overall: 5.3, small_sample: true });
    expect(s.overall.unsafe_rate).toBeCloseTo(1 / 3);
    expect(s.overall.as_good_or_better_rate).toBeCloseTo(1 / 3);
    expect(s.overall.could_send_rate).toBeCloseTo(1 / 2);
  });

  test('escalation notes are counted by kind, never with their detail', () => {
    const labels = s.actions.map((a) => a.action);
    expect(labels).toEqual(expect.arrayContaining(['escalate:cancel_request', 'escalate:followup_promised', 'send_payment_link']));
    expect(labels.join(' ')).not.toMatch(/Tue/);
  });

  test('cancel, refund and charge requests are counted, with and without a hand-off', () => {
    expect(s.restricted).toEqual({ requests: 3, escalated: 2, not_escalated: 1 });
  });

  test('the summary carries no message text', () => {
    const text = JSON.stringify(s);
    for (const r of rows) {
      expect(text).not.toContain(r.inbound_message);
      expect(text).not.toContain(r.draft_response);
    }
    expect(text).not.toContain('Marigold');
  });

  test('groups by intent and drafter version', () => {
    expect(s.by_intent.find((g) => g.key === 'CANCEL_REQUEST').drafts).toBe(1);
    expect(s.by_prompt_version).toEqual([expect.objectContaining({ key: 'v9', drafts: 6 })]);
  });
});

describe('actionLabel', () => {
  // An escalation note is model-written free text, so no part of it may reach stdout or the case export.
  const NOTE = 'Call Marigold Pennywhistle back at 941-555-0134 or marigold@example.com about the gate';

  test('a note that is not a known kind is counted as other, with or without a colon', () => {
    expect(actionLabel({ type: 'escalate', note: NOTE })).toBe('escalate:other');
    expect(actionLabel({ type: 'escalate', note: `Marigold Pennywhistle 941-555-0134: wants a call` })).toBe('escalate:other');
    expect(actionLabel({ type: 'escalate', note: 'followup_promised: Marigold, Tue 9-11' })).toBe('escalate:followup_promised');
    expect(actionLabel({ type: 'escalate', note: null })).toBe('escalate');
  });

  test('an action type the drafter does not store is counted as other', () => {
    expect(actionLabel({ type: 'text Marigold at 941-555-0134', note: null })).toBe('other');
    expect(actionLabel({ type: 'send_payment_link', note: NOTE })).toBe('send_payment_link');
  });

  test('a free-text note reaches neither the summary nor the case export', () => {
    const row = draft({ intended_actions: { actions: [{ type: 'escalate', note: NOTE }, { type: 'text Marigold at 941-555-0134' }] } });
    const summary = summarize([row]);
    expect(summary.actions.map((a) => a.action).sort()).toEqual(['escalate:other', 'other']);
    const text = JSON.stringify(summary) + JSON.stringify(caseOf(row));
    expect(text).not.toMatch(/Marigold|Pennywhistle|555-0134|example\.com/);
  });

  test('the type list matches the drafter', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'sms-shadow-drafter.js'), 'utf8');
    const list = source.match(/const INTENDED_ACTION_TYPES = \[([^\]]+)\]/)[1];
    expect(list.match(/'([a-z_]+)'/g).map((q) => q.slice(1, -1))).toEqual(ACTION_TYPES);
  });
});

describe('caseOf', () => {
  test('redacts the customer name and carries no phone or customer id', () => {
    const c = caseOf(draft({
      inbound_message: 'Hi this is Marigold Pennywhistle, call me at 941-555-0134',
      human_replied: true, human_reply_text: 'Thanks Marigold, we will see you Tuesday.', verdict: 'equivalent',
    }));
    const text = JSON.stringify(c);
    expect(text).not.toMatch(/Marigold|Pennywhistle|555-0134/);
    expect(c).not.toHaveProperty('customer_id');
    expect(c.person_reply).toEqual(expect.any(String));
    expect(c.created_at).toBe('2026-11-01T14:00:00.000Z');
  });

  test('no person reply when the person did not reply', () => {
    expect(caseOf(draft({ human_reply_text: 'stale' })).person_reply).toBeNull();
  });
});

describe('ops/agents/waves-ai-replay', () => {
  test('refuses an --out folder inside the repository', () => {
    const inside = path.join(__dirname, '..', '..', 'tmp-replay');
    expect(() => ops.parseArgs([`--out=${inside}`])).toThrow(/outside the repository/);
  });

  test('accepts an --out folder outside the repository and validates the window', () => {
    const outside = path.join(os.tmpdir(), 'waves-ai-replay-test');
    expect(ops.parseArgs([`--out=${outside}`, '--days=7'])).toMatchObject({ days: 7, out: outside, json: false });
    expect(() => ops.parseArgs(['--days=0'])).toThrow(/--days/);
    expect(() => ops.parseArgs(['--limit=abc'])).toThrow(/--limit/);
  });

  test('the printed report has no message text', () => {
    const report = ops.formatReport(summarize([draft({ verdict: 'equivalent', scores: { overall: 7 } })]), { days: 30, truncated: false });
    expect(report).toContain('all texts');
    expect(report).not.toContain('When is my next visit?');
  });
});
