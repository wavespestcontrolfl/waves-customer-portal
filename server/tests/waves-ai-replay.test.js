// Waves AI replay (Phase 0 of the portal Waves AI scope): the summary carries counts and rates only,
// never message text; the unsafe and could-send rates count graded drafts the way the judge grades them,
// one judge at a time; a cancel / refund / charge request is counted whether or not the draft handed it to
// the office, and a text that only names one is counted apart; a case for the side-by-side read is
// redacted and carries no phone, customer id or name; and the ops script refuses to write customer text
// inside the repository, directly or through a link.
jest.mock('../models/db', () => { const db = () => ({}); db.raw = () => ({}); return db; });

const path = require('path');
const os = require('os');
const fs = require('fs');
const { summarize, caseOf, actionLabel, restrictedOf, ACTION_TYPES, ESCALATION_KINDS, FIRST_JUDGE } = require('../services/eval/waves-ai-replay');
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
    expect(s.restricted).toEqual({
      requests: { texts: 3, escalated: 2, not_escalated: 1 },
      other_wording: { texts: 0, escalated: 0, not_escalated: 0 },
    });
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

describe('judge versions', () => {
  // Judge j2 is stricter than the first judge (which leaves no stamp), so a rate over both would move
  // with the mix of judges alone.
  const rows = [
    draft({ id: 'n1', created_at: new Date('2026-11-03T14:00:00Z'), verdict: 'draft_unsafe', judge_version: 'j2', scores: { overall: 2 }, could_send: 'no' }),
    draft({ id: 'n2', created_at: new Date('2026-11-02T14:00:00Z'), verdict: 'equivalent', judge_version: 'j2', scores: { overall: 8 }, could_send: 'yes' }),
    draft({ id: 'n3', created_at: new Date('2026-11-04T14:00:00Z') }),
    draft({ id: 'o1', created_at: new Date('2026-10-20T14:00:00Z'), verdict: 'equivalent', scores: { overall: 9 } }),
    draft({ id: 'o2', created_at: new Date('2026-10-19T14:00:00Z'), verdict: 'draft_better', scores: { overall: 9 } }),
    draft({ id: 'o3', created_at: new Date('2026-10-18T14:00:00Z'), verdict: 'human_no_reply' }),
  ];
  const s = summarize(rows);

  test('rates count only the drafts of the judge that graded the newest draft', () => {
    expect(s.judge_version).toBe('j2');
    expect(s.overall).toMatchObject({ drafts: 6, judged: 2, graded: 2, unsafe: 1, avg_overall: 5 });
    expect(s.overall.unsafe_rate).toBeCloseTo(1 / 2);
    expect(s.by_intent[0]).toMatchObject({ key: 'GENERAL', drafts: 6, graded: 2, unsafe: 1 });
    expect(s.by_prompt_version[0]).toMatchObject({ key: 'v9', drafts: 6, graded: 2 });
  });

  test('each judge is listed with its own drafts', () => {
    expect(s.by_judge_version).toEqual([
      expect.objectContaining({ key: FIRST_JUDGE, drafts: 3, judged: 3, graded: 2, unsafe: 0, unsafe_rate: 0 }),
      expect.objectContaining({ key: 'j2', drafts: 2, judged: 2, graded: 2, unsafe: 1 }),
    ]);
  });

  test('a window from before judge j2 uses the first judge, and one with no verdict uses none', () => {
    const before = summarize(rows.filter((r) => r.id.startsWith('o')));
    expect(before.judge_version).toBe(FIRST_JUDGE);
    expect(before.overall).toMatchObject({ drafts: 3, judged: 3, graded: 2, unsafe: 0 });
    const none = summarize([draft()]);
    expect(none.judge_version).toBeNull();
    expect(none.by_judge_version).toEqual([]);
    expect(none.overall).toMatchObject({ drafts: 1, judged: 0, unsafe_rate: null });
  });

  test('the report names the judge behind the rates and the drafts left out', () => {
    const report = ops.formatReport(s, { days: 30, truncated: false });
    expect(report).toContain('count only the drafts graded by judge j2.');
    expect(report).toContain('Not in them: 2 drafts graded by the first judge (before j2) (see "By judge")');
    expect(report).toMatch(/By judge[^\n]*\n\s+first judge \(before j2\)\s+drafts\s+3\s+graded\s+2/);
    expect(ops.formatReport(summarize([draft()]), { days: 30, truncated: false })).toContain('No draft in this window has a judge verdict yet');
  });
});

describe('restricted requests', () => {
  const kind = (inbound_message, actions = []) => restrictedOf({ inbound_message }, actions);

  test.each([
    'Please cancel my plan', 'I need to cancel my service', "I'd like to cancel", 'How do I cancel?', 'We decided to cancel',
    'I have to cancel', "I'm going to cancel if this keeps up", 'We need the charge reversed',
    'Cancel my service effective today.', 'Hi, cancel my plan', 'I\u2019m cancelling my service',
    'I want a refund', 'Can I get a refund?', 'can you refund me', 'I would like to request a refund for the last visit',
    'Is it possible to get a refund', 'I want my money back', 'Refund me the difference',
    'Can you charge my card for the balance?', 'Charge the card on file please',
    'Would you charge my new card on the 1st instead?', 'Can you charge me for the next visit now?',
    'What did you charge me twice for?', 'Please reverse the charge', 'Can you remove the late charge?',
    'Why did you charge my card twice?', 'I was double charged this month', 'You overcharged me',
    'I shouldn\u2019t have been charged for that visit', 'We are disputing this charge', 'I will file a chargeback',
    'Thanks for the quick reply, please cancel my plan', 'Hey there, cancel my service',
    // A thank-you ends at its own clause: a request after it in the same sentence still counts.
    'Thanks for the refund, please cancel my plan', 'Thanks for the refund, cancel my plan too',
    'Thank you for cancelling that visit and please refund me', 'Thanks for the refund but you charged me twice again',
    'Thanks for fixing the double charge and I was overcharged in May too',
    'Thanks for the refund and cancel my plan', 'Thanks for the refund, also cancel my plan',
    'Thanks for fixing the charge and refund me the late fee too',
  ])('asks for it: %s', (text) => {
    expect(kind(text)).toBe('request');
  });

  test.each([
    'Thanks for the refund yesterday', 'Thank you for cancelling that visit', 'Thanks for fixing the double charge',
    'I got the refund, thank you', 'Refund received, thanks', 'Charge went through, thanks',
    'Thanks for the credit and for fixing the double charge', 'I got it, thanks for the refund',
    'Thanks so much for the refund and the quick reply', 'Did you refund me and cancel my plan?',
    'Has my plan been cancelled?', 'Did you cancel my visit?', 'Was my card charged yet?', 'When will I be charged?',
    'When will you charge my card?', 'Can you tell me if my refund went through?', 'Can I get an update on my refund?',
    'I need the refund confirmation number', 'What is your cancellation policy?', 'Is there a cancellation fee?',
    "I don't want to cancel", "Please don't cancel my service", 'I do not want a refund, just a re-treat',
    'I never asked you to cancel', 'I was not charged twice, all good', 'No charge for the re-service, right?',
    'Do I need to cancel my appointment if it rains?', 'What happens if I want to cancel?', 'I have a refund pending, right?',
    // "Charge" as price talk is not a request to be charged.
    'How much would you charge me for a one-time treatment?', 'What do you charge for mosquito service?',
    'Would you charge a fee to come back out?', 'Could you charge less next time?',
    'I had a charge on my card from you on the 3rd',
  ])('only names it: %s', (text) => {
    expect(kind(text)).toBe('mention');
  });

  test('a text that names none of them is neither', () => {
    expect(kind('When is my next visit?')).toBeNull();
    expect(kind('')).toBeNull();
  });

  test('a draft that filed a cancel_request counts as a request, whatever the wording', () => {
    expect(kind('We are done with the service after this month', [{ type: 'escalate', note: 'cancel_request' }])).toBe('request');
    expect(kind('We are done with the service after this month', [{ type: 'escalate', note: 'wants to cancel' }])).toBeNull();
  });

  // Wording rules cannot read every request. Each reading keeps its own hand-off counts, so a request the
  // rules file under other wording still shows as not handed over there.
  test('request wording and other wording each carry their own hand-off counts', () => {
    const s = summarize([
      draft({ inbound_message: 'Thanks for the refund yesterday' }),
      draft({ id: 'd2', inbound_message: 'Has my plan been cancelled?', intended_actions: { actions: [{ type: 'escalate', note: 'followup_promised' }] } }),
      draft({ id: 'd3', inbound_message: 'I want a refund' }),
      // A request after a thank-you that the draft did not hand over is a missed hand-off, not a mention.
      draft({ id: 'd4', inbound_message: 'Thanks for the refund, please cancel my plan' }),
      draft({ id: 'd5', inbound_message: 'Thanks for the refund and cancel my plan', intended_actions: { actions: [{ type: 'escalate', note: 'cancel_request' }] } }),
      draft({ id: 'd6', inbound_message: 'When is my next visit?' }),
    ]);
    expect(s.restricted).toEqual({
      requests: { texts: 3, escalated: 1, not_escalated: 2 },
      other_wording: { texts: 2, escalated: 1, not_escalated: 1 },
    });
    const report = ops.formatReport(s, { days: 30, truncated: false });
    expect(report).toContain('Cancel / refund / charge (only the office does these): 5 texts name one');
    expect(report).toMatch(/asked in plain words\s+3 {3}handed to the office: 1 {3}not handed over: 2/);
    expect(report).toMatch(/other wording\s+2 {3}handed to the office: 1 {3}not handed over: 1/);
  });
});

describe('actionLabel', () => {
  // An escalation note is model-written free text, so no part of it may reach stdout or the case export.
  const NOTE = 'Call Marigold Pennywhistle back at 941-555-0134 or marigold@example.com about the gate';

  test('a note that is not a known kind is counted as other, with or without a colon', () => {
    expect(actionLabel({ type: 'escalate', note: NOTE })).toBe('escalate:other');
    expect(actionLabel({ type: 'escalate', note: `Marigold Pennywhistle 941-555-0134: wants a call` })).toBe('escalate:other');
    expect(actionLabel({ type: 'escalate', note: 'followup_promised: Marigold, Tue 9-11' })).toBe('escalate:followup_promised');
    expect(actionLabel({ type: 'escalate', note: 'reservice_times: Tue 9-11, Wed 1-3 for Marigold' })).toBe('escalate:reservice_times');
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

  // The drafter's prompts name each escalation kind as {"type":"escalate","note":"<kind>"} or
  // "<kind>: <detail>"; a note in angle brackets is free text. A kind added there must be added here,
  // or the report files it under "escalate:other".
  test('the escalation kinds match the drafter', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'sms-shadow-drafter.js'), 'utf8');
    const kinds = new Set([...source.matchAll(/"type":"escalate","note":"([a-z_]+)[":]/g)].map((m) => m[1]));
    expect([...kinds].sort()).toEqual([...ESCALATION_KINDS].sort());
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
    expect(c).toMatchObject({ judge_version: FIRST_JUDGE, restricted: null });
  });

  test('carries the judge and the restricted reading', () => {
    expect(caseOf(draft({ verdict: 'equivalent', judge_version: 'j2', inbound_message: 'I want a refund' })))
      .toMatchObject({ judge_version: 'j2', restricted: 'request' });
    expect(caseOf(draft({ inbound_message: 'Thanks for the refund yesterday' }))).toMatchObject({ judge_version: null, restricted: 'mention' });
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

  describe('the case file', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-ai-replay-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('is written as a new file that only the owner can read, replacing an earlier run', () => {
      const out = path.join(dir, 'out');
      const file = ops.writeCaseFile(out, 'first\n');
      expect(file).toBe(path.join(out, 'cases.jsonl'));
      fs.chmodSync(file, 0o644);
      ops.writeCaseFile(out, 'second\n');
      expect(fs.readFileSync(file, 'utf8')).toBe('second\n');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    // A cases.jsonl that is a link could point back into the repository while the folder passes the check.
    test('is never written through a symbolic link, live or dangling', () => {
      const target = path.join(dir, 'elsewhere.txt');
      fs.writeFileSync(target, 'keep');
      const out = path.join(dir, 'out');
      fs.mkdirSync(out);
      fs.symlinkSync(target, path.join(out, 'cases.jsonl'));
      expect(() => ops.writeCaseFile(out, 'customer text\n')).toThrow(/not a plain file/);
      expect(fs.readFileSync(target, 'utf8')).toBe('keep');

      const missing = path.join(dir, 'not-there.txt');
      fs.rmSync(path.join(out, 'cases.jsonl'));
      fs.symlinkSync(missing, path.join(out, 'cases.jsonl'));
      expect(() => ops.writeCaseFile(out, 'customer text\n')).toThrow(/not a plain file/);
      expect(fs.existsSync(missing)).toBe(false);
    });

    test('a hard link to another file is replaced, not written through', () => {
      const target = path.join(dir, 'elsewhere.txt');
      fs.writeFileSync(target, 'keep');
      const out = path.join(dir, 'out');
      fs.mkdirSync(out);
      fs.linkSync(target, path.join(out, 'cases.jsonl'));
      ops.writeCaseFile(out, 'customer text\n');
      expect(fs.readFileSync(target, 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(out, 'cases.jsonl'), 'utf8')).toBe('customer text\n');
    });

    test('refuses a folder inside the repository before it makes it', () => {
      const inside = path.join(__dirname, '..', '..', 'tmp-replay-cases');
      expect(() => ops.writeCaseFile(inside, 'customer text\n')).toThrow(/outside the repository/);
      expect(fs.existsSync(inside)).toBe(false);
    });

    test('run reads the judge of each row and writes one redacted case per draft', async () => {
      const seen = {};
      const rows = [
        draft({ verdict: 'draft_unsafe', judge_version: 'j2', inbound_message: 'Hi this is Marigold Pennywhistle, I want a refund' }),
        draft({ id: 'd2', created_at: new Date('2026-10-20T14:00:00Z'), verdict: 'equivalent' }),
      ];
      const dbi = () => {
        const q = {
          leftJoin: () => q, where: () => q, orderBy: () => q, limit: () => q,
          select: (cols) => { seen.cols = cols; return q; },
          then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
        };
        return q;
      };
      const printed = [];
      const summary = await ops.run({ dbi, argv: [`--out=${dir}`], now: new Date('2026-11-05T12:00:00Z'), log: (text) => printed.push(text) });
      expect(seen.cols).toContain('j.judge_version');
      expect(summary).toMatchObject({ judge_version: 'j2', restricted: { requests: { texts: 1, escalated: 0, not_escalated: 1 }, other_wording: { texts: 0 } } });
      expect(summary.overall).toMatchObject({ drafts: 2, graded: 1, unsafe: 1 });
      const cases = fs.readFileSync(path.join(dir, 'cases.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(cases.map((c) => [c.judge_version, c.restricted])).toEqual([['j2', 'request'], [FIRST_JUDGE, null]]);
      expect(JSON.stringify(cases) + printed.join('\n')).not.toMatch(/Marigold|Pennywhistle/);
    });
  });
});
