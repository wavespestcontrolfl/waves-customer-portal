// Nightly self-audit — auditor-down is a breach, the auditor is blind, and
// every lead-losing terminal disposition counts as drift.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), typedDecisionsLive: jest.fn(() => false), typedDecisionsClefLive: jest.fn(() => false) }));
jest.mock('../services/llm/deep', () => ({ createDeepMessage: jest.fn() }));
jest.mock('../services/typed-decisions/jev', () => ({ askPackage: jest.fn() }));
jest.mock('../services/typed-decisions/shadow-recorder', () => ({ recordDecisions: jest.fn(), siblingDisagrees: jest.requireActual('../services/typed-decisions/shadow-recorder').siblingDisagrees }));

const db = require('../models/db');
const { createDeepMessage } = require('../services/llm/deep');
const { typedDecisionsLive, typedDecisionsClefLive } = require('../config/feature-gates');
const { askPackage } = require('../services/typed-decisions/jev');
const { recordDecisions } = require('../services/typed-decisions/shadow-recorder');
const { callSubjectHash } = require('../services/typed-decisions/subject-hash');
const { runSelfAudit, stratifySample, OUTBOUND_DIRECTION_SQL, callDirectionBlock, gateCheckBaselines, shadowVoicemails } = require('../services/call-self-audit');

// Each sampled call is asked call_judge.v2 and call_gate_checks.v1; these
// read one package's asks, records and tally.
const asksFor = (id) => askPackage.mock.calls.filter((c) => c[0] === id);
const recordsFor = (id) => recordDecisions.mock.calls.filter(([a]) => a.pkg.id === id);
const judgeAsks = () => asksFor('call_judge.v2');
const judgeRecords = () => recordsFor('call_judge.v2');
const judgeTally = ({ gateChecks, ...rest }) => rest;

const SAMPLE = (over = {}) => ({
  id: 'call-1', twilio_call_sid: 'CA_sa1', created_at: new Date(), processing_status: 'processed',
  transcription: 'Agent: Waves. Caller: I need pest control at my house. '.repeat(8),
  ai_extraction: JSON.stringify({ is_lead: true }), disposition: null, ...over,
});

function mockDb({ calls, onInsert = () => {}, whereCalls = [], promiseCallIds = [], whereInCalls = [] }) {
  db.raw = (sql) => sql;
  db.mockImplementation((table) => {
    const raws = [];
    const isOutbound = (c) => String(c.direction || '').startsWith('outbound');
    const b = {
      where(...args) { whereCalls.push(args); return b; }, whereIn(...args) { whereInCalls.push([table, ...args]); return b; }, whereRaw(sql) { raws.push(sql); return b; }, modify(fn) { fn(b); return b; },
      orderBy() { return b; }, limit() { return b; },
      // call_commitments: the sampled calls carrying a live Waves promise.
      distinct: async () => (table === 'call_commitments as cc' ? promiseCallIds.map((id) => ({ call_log_id: id })) : []),
      // Each direction query returns only its own direction's rows.
      select: async () => {
        if (table !== 'call_log') return [];
        const wantsOutbound = raws.includes(OUTBOUND_DIRECTION_SQL);
        return calls.filter((c) => isOutbound(c) === wantsOutbound);
      },
      insert: (row) => { onInsert(table, row); return { onConflict: () => ({ merge: async () => {}, catch: () => {} }) }; },
    };
    // knex insert().onConflict().merge().catch() chain used in service
    const origInsert = b.insert;
    b.insert = (row) => { const r = origInsert(row); r.merge = async () => {}; return r; };
    return b;
  });
}

beforeEach(() => jest.clearAllMocks());

test('auditor-down (0 audited with calls sampled) is a BREACH, never healthy silence', async () => {
  const alerts = [];
  mockDb({ calls: [SAMPLE(), SAMPLE({ id: 'call-2' })], onInsert: (t, row) => { if (t === 'notifications') alerts.push(row); } });
  const res = await runSelfAudit({ createMessage: async () => { throw new Error('provider down'); } });
  expect(res.audited).toBe(0);
  expect(res.breaches.some((x) => /auditor down/.test(x))).toBe(true);
});

test('the auditor sees ONLY the transcript — production status never leaks into the prompt', async () => {
  let seenPrompt = '';
  mockDb({ calls: [SAMPLE({ processing_status: 'spam' })] });
  await runSelfAudit({ createMessage: async (params) => {
    seenPrompt = params.messages.map((m) => m.content).join(' ');
    return { content: [{ type: 'text', text: '{"is_lead":true,"is_spam":false,"is_voicemail":false,"appointment_agreed":false,"quote_promised":false,"complaint":false,"excerpt":"needs pest control"}' }] };
  } });
  expect(seenPrompt).not.toMatch(/spam|status/i);
  expect(seenPrompt).toContain('Transcript:');
});

test('a lead stamped vendor_logged counts as a disposition mismatch', async () => {
  mockDb({ calls: [SAMPLE({ disposition: 'vendor_logged', ai_extraction: JSON.stringify({ is_lead: true }) })] });
  const res = await runSelfAudit({ createMessage: async () => ({ content: [{ type: 'text', text: '{"is_lead":true,"is_spam":false,"is_voicemail":false,"appointment_agreed":false,"quote_promised":false,"complaint":false,"excerpt":"wants service"}' }] }) });
  expect(res.dispositionRate).toBeGreaterThan(0);
});

test('the internal factory (no injected createMessage) requests effort:\'medium\' on the DEEP call (2026-09-26: a bounded field-diff audit, not deep reasoning)', async () => {
  createDeepMessage.mockResolvedValue({ content: [{ type: 'text', text: '{"is_lead":true,"is_spam":false,"is_voicemail":false,"appointment_agreed":false,"quote_promised":false,"complaint":false,"excerpt":"ok"}' }] });
  mockDb({ calls: [SAMPLE()] });
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    await runSelfAudit({});
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  }
  expect(createDeepMessage).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ laneId: 'call_self_audit', effort: 'medium' }),
  );
});

// Owner directive 2026-09-26: every call-agent rule is audited the same way
// regardless of who dialed — and a burst of one direction must not crowd the
// other out of the sample (codex #4912 r1 P2).
const OK_VERDICT = { content: [{ type: 'text', text: '{"is_lead":true,"is_spam":false,"is_voicemail":false,"appointment_agreed":false,"quote_promised":false,"complaint":false,"excerpt":"ok"}' }] };

test('outbound calls are sampled even when newer inbound calls alone would fill the sample', async () => {
  const inbound = Array.from({ length: 40 }, (_, i) => SAMPLE({ id: `in-${i}`, direction: 'inbound' }));
  const outboundText = 'Agent: Hi, this is Waves returning your call. Caller: Yes, about the ants. '.repeat(6);
  const outbound = [
    SAMPLE({ id: 'out-1', direction: 'outbound-dial', transcription: outboundText }),
    SAMPLE({ id: 'out-2', direction: 'outbound', transcription: outboundText }),
  ];
  mockDb({ calls: [...inbound, ...outbound] });
  const seen = [];
  await runSelfAudit({ createMessage: async (params) => { seen.push(params.messages[0].content); return OK_VERDICT; } });
  expect(seen.length).toBe(25);
  expect(seen.filter((t) => t.includes('returning your call')).length).toBe(2);
});

// codex #4912 r2 P2: outbound diarized transcripts can have SWAPPED
// "Agent:"/"Caller:" speaker labels (the Copeman call). Adding outbound to
// the self-audit sample without warning the judge produces false
// disagreements. The judge is told the direction and, on outbound, told the
// labels may be wrong and to identify parties by content.
describe('callDirectionBlock', () => {
  test('outbound warns that speaker labels may be swapped and says who dialed', () => {
    const block = callDirectionBlock('outbound-dial');
    expect(block).toMatch(/OUTBOUND/);
    expect(block).toMatch(/SWAPPED/);
    expect(block).toMatch(/staff placed this call/i);
  });

  test('inbound carries no swap warning', () => {
    const block = callDirectionBlock('inbound');
    expect(block).toMatch(/INBOUND/);
    expect(block).not.toMatch(/SWAPPED/);
  });

  test('a missing/unknown direction is treated as inbound (no swap warning)', () => {
    expect(callDirectionBlock(null)).toMatch(/INBOUND/);
    expect(callDirectionBlock('')).toMatch(/INBOUND/);
  });
});

test('an outbound call in the sample gets the swap warning in its prompt; inbound does not', async () => {
  const outboundText = 'Agent: Hi, this is Waves returning your call. Caller: Yes, about the ants. '.repeat(6);
  const seen = [];
  mockDb({ calls: [
    SAMPLE({ id: 'out-1', direction: 'outbound-dial', transcription: outboundText }),
    SAMPLE({ id: 'in-1', direction: 'inbound' }),
  ] });
  await runSelfAudit({ createMessage: async (params) => { seen.push(params.messages[0].content); return OK_VERDICT; } });
  const outboundPrompt = seen.find((t) => t.includes('returning your call'));
  const inboundPrompt = seen.find((t) => !t.includes('returning your call'));
  expect(outboundPrompt).toMatch(/OUTBOUND/);
  expect(outboundPrompt).toMatch(/SWAPPED/);
  expect(inboundPrompt).toMatch(/INBOUND/);
  expect(inboundPrompt).not.toMatch(/SWAPPED/);
});

test('stratifySample reserves half per direction and gives unused share to the other', () => {
  const rows = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
  const both = stratifySample({ inbound: rows('in', 40), outbound: rows('out', 40), size: 25 });
  expect(both.filter((r) => r.id.startsWith('out')).length).toBe(12);
  expect(both.length).toBe(25);
  const fewOutbound = stratifySample({ inbound: rows('in', 40), outbound: rows('out', 2), size: 25 });
  expect(fewOutbound.filter((r) => r.id.startsWith('out')).length).toBe(2);
  expect(fewOutbound.length).toBe(25);
  const fewInbound = stratifySample({ inbound: rows('in', 3), outbound: rows('out', 40), size: 25 });
  expect(fewInbound.filter((r) => r.id.startsWith('in')).length).toBe(3);
  expect(fewInbound.length).toBe(25);
});


// Typed-decisions shadow (GATE_TYPED_DECISIONS, dark): the same call is put to
// TypeSafe Jev and recorded beside production's and the deep judge's reading.
// It never changes the audit's own findings, counters or alerts.
describe('Jev shadow', () => {
  const VERDICT = { content: [{ type: 'text', text: '{"is_lead":true,"is_spam":false,"is_voicemail":false,"appointment_agreed":true,"quote_promised":false,"complaint":true,"excerpt":"ok"}' }] };
  const JEV_OK = { ok: true, answers: { is_lead: { p: 0.9, yes: true, confident: true } }, packageHash: 'h', servedModel: 'jev-1.13.0' };

  beforeEach(() => {
    typedDecisionsLive.mockReturnValue(false);
    askPackage.mockReset();
    recordDecisions.mockReset();
    askPackage.mockResolvedValue(JEV_OK);
    recordDecisions.mockResolvedValue({ recorded: 6 });
  });
  afterAll(() => typedDecisionsLive.mockReturnValue(false));

  test('gate off: Jev is never asked and nothing is recorded', async () => {
    mockDb({ calls: [SAMPLE()] });
    const res = await runSelfAudit({ createMessage: async () => VERDICT });
    expect(askPackage).not.toHaveBeenCalled();
    expect(recordDecisions).not.toHaveBeenCalled();
    expect(judgeTally(res.jev)).toEqual({ asked: 0, recorded: 0, failed: 0 });
  });

  test('gate on: asks call_judge.v2 with the transcript and direction, records both baselines and the transcript digest', async () => {
    typedDecisionsLive.mockReturnValue(true);
    const prodCall = SAMPLE({ id: 'call-9', direction: 'inbound', duration_seconds: 88, ai_extraction: JSON.stringify({ is_lead: true, appointment_confirmed: false, quote_promised: false }) });
    mockDb({ calls: [prodCall] });
    const res = await runSelfAudit({ createMessage: async () => VERDICT });

    expect(judgeAsks()).toHaveLength(1);
    const [packageId, state] = judgeAsks()[0];
    expect(packageId).toBe('call_judge.v2');
    expect(Object.keys(state).sort()).toEqual(['call_direction', 'duration_seconds', 'transcript']);
    expect(state.duration_seconds).toBe(88);
    expect(state.call_direction).toMatch(/^INBOUND/);
    expect(state.transcript).toBe(prodCall.transcription.slice(0, 5000));

    expect(judgeRecords()).toHaveLength(1);
    const args = judgeRecords()[0][0];
    expect(args).toMatchObject({ capability: 'call_judge', subjectType: 'call_log', subjectId: 'call-9', result: JEV_OK, subjectHash: callSubjectHash(prodCall.transcription) });
    expect(args).not.toHaveProperty('outcomeEvidence');
    expect(args.pkg.id).toBe('call_judge.v2');
    // production and deep judge side by side for the five shared fields
    expect(args.baselines.appointment_agreed).toEqual({ production: false, deep_judge: true });
    expect(args.baselines.is_lead).toEqual({ production: true, deep_judge: true });
    expect(args.baselines.is_spam).toEqual({ production: false, deep_judge: false });
    // complaint has no production field: deep judge only
    expect(args.baselines.complaint).toEqual({ deep_judge: true });
    expect(judgeTally(res.jev)).toEqual({ asked: 1, recorded: 1, failed: 0 });
  });

  test('a failed deep audit still asks Jev, recorded against production only', async () => {
    typedDecisionsLive.mockReturnValue(true);
    mockDb({ calls: [SAMPLE({ ai_extraction: JSON.stringify({ is_lead: true }) })] });
    const res = await runSelfAudit({ createMessage: async () => { throw new Error('deep judge down'); } });
    expect(judgeAsks()).toHaveLength(1);
    const args = judgeRecords()[0][0];
    expect(args.baselines.is_lead).toEqual({ production: true, deep_judge: undefined });
    expect(args.baselines.complaint).toEqual({ deep_judge: undefined });
    expect(judgeTally(res.jev)).toEqual({ asked: 1, recorded: 1, failed: 0 });
  });

  test('an outbound call gets the outbound direction line and a missing duration is null', async () => {
    typedDecisionsLive.mockReturnValue(true);
    mockDb({ calls: [SAMPLE({ direction: 'outbound-dial', duration_seconds: undefined })] });
    await runSelfAudit({ createMessage: async () => VERDICT });
    const state = judgeAsks()[0][1];
    expect(state.call_direction).toMatch(/^OUTBOUND/);
    expect(state.duration_seconds).toBeNull();
  });

  test.each([
    ['Jev answers ok:false', () => askPackage.mockResolvedValue({ ok: false, reason: 'error' }), { asked: 1, recorded: 0, failed: 1 }],
    ['Jev throws', () => askPackage.mockRejectedValue(new Error('provider down')), { asked: 1, recorded: 0, failed: 1 }],
    ['the recorder throws', () => recordDecisions.mockRejectedValue(new Error('db down')), { asked: 1, recorded: 0, failed: 1 }],
  ])('%s: the audit itself is unaffected', async (_name, arrange, jev) => {
    typedDecisionsLive.mockReturnValue(true);
    arrange();
    const findings = [];
    mockDb({
      calls: [SAMPLE({ disposition: 'vendor_logged', ai_extraction: JSON.stringify({ is_lead: true }) })],
      onInsert: (t, row) => { if (t === 'call_audit_findings') findings.push(row); },
    });
    const res = await runSelfAudit({ createMessage: async () => VERDICT });
    expect(res.audited).toBe(1);
    expect(res.dispositionRate).toBeGreaterThan(0);
    expect(findings.map((f) => f.field).sort()).toEqual(['appointment_agreed']);
    expect(judgeTally(res.jev)).toEqual(jev);
  });
});

describe('Clef shadow leg (second provider)', () => {
  const OK_DEEP = async () => ({ content: [{ type: 'text', text: '{"is_lead":true,"is_spam":false,"is_voicemail":false,"appointment_agreed":false,"quote_promised":false,"complaint":false,"excerpt":"ok"}' }] });
  const JEV = { ok: true, provider: 'typesafe', answers: { is_lead: { p: 0.9, yes: true, confident: true }, is_spam: { p: 0.1, yes: false, confident: true } }, packageHash: 'h', servedModel: 'jev-1.13.0' };
  const CLEF = { ok: true, provider: 'cloudflare', answers: { is_lead: { p: 0.2, yes: false, confident: true }, is_spam: { p: 0.1, yes: false, confident: true } }, packageHash: 'h', servedModel: 'clef-flash' };
  beforeEach(() => {
    typedDecisionsLive.mockReturnValue(true);
    typedDecisionsClefLive.mockReturnValue(true);
    askPackage.mockReset();
    recordDecisions.mockReset();
    recordDecisions.mockResolvedValue({ recorded: 6 });
  });
  afterAll(() => { typedDecisionsLive.mockReturnValue(false); typedDecisionsClefLive.mockReturnValue(false); });

  test('both providers are asked the same package and state; each row carries the other\'s answers as siblings', async () => {
    askPackage.mockImplementation(async (_pkg, _state, opts) => (opts?.provider === 'cloudflare' ? CLEF : JEV));
    mockDb({ calls: [SAMPLE()] });
    const res = await runSelfAudit({ createMessage: OK_DEEP });
    expect(judgeAsks()).toHaveLength(2);
    expect(judgeAsks()[0][0]).toBe('call_judge.v2');
    expect(judgeAsks()[0][1]).toEqual(judgeAsks()[1][1]); // identical state
    expect(judgeAsks()[1][2]).toEqual({ provider: 'cloudflare' });
    expect(judgeRecords()).toHaveLength(2);
    const byProvider = Object.fromEntries(judgeRecords().map(([a]) => [a.provider, a]));
    expect(byProvider.typesafe.siblingAnswers).toEqual({ is_lead: [CLEF.answers.is_lead], is_spam: [CLEF.answers.is_spam] });
    expect(byProvider.cloudflare.siblingAnswers).toEqual({ is_lead: [JEV.answers.is_lead], is_spam: [JEV.answers.is_spam] });
    expect(byProvider.cloudflare.baselines).toEqual(byProvider.typesafe.baselines);
    expect(byProvider.cloudflare.subjectHash).toBe(byProvider.typesafe.subjectHash);
    expect(judgeTally(res.jev)).toEqual({ asked: 1, recorded: 1, failed: 0, clef: { asked: 1, recorded: 1, failed: 0 } });
  });

  test('the Clef leg failing leaves the Jev row recorded without siblings and is tallied on its own', async () => {
    askPackage.mockImplementation(async (_pkg, _state, opts) => (opts?.provider === 'cloudflare' ? { ok: false, reason: 'cloudflare_timeout' } : JEV));
    mockDb({ calls: [SAMPLE()] });
    const res = await runSelfAudit({ createMessage: OK_DEEP });
    expect(judgeRecords()).toHaveLength(1);
    expect(judgeRecords()[0][0]).toMatchObject({ provider: 'typesafe', siblingAnswers: {} });
    expect(judgeTally(res.jev)).toEqual({ asked: 1, recorded: 1, failed: 0, clef: { asked: 1, recorded: 0, failed: 1 } });
  });

  test('Clef gate off: a single Jev leg, no provider option, no clef tally (unchanged shape)', async () => {
    typedDecisionsClefLive.mockReturnValue(false);
    askPackage.mockResolvedValue(JEV);
    mockDb({ calls: [SAMPLE()] });
    const res = await runSelfAudit({ createMessage: OK_DEEP });
    expect(judgeAsks()).toHaveLength(1);
    expect(judgeAsks()[0][2]).toBeUndefined();
    expect(judgeRecords()[0][0]).toMatchObject({ provider: 'typesafe', siblingAnswers: {} });
    expect(judgeTally(res.jev)).toEqual({ asked: 1, recorded: 1, failed: 0 });
  });
});


describe('dark-gate checks (call_gate_checks.v1: each gate\'s own decision beside the models)', () => {
  const { isEnabled } = require('../config/feature-gates');
  const V2 = (over = {}) => JSON.stringify({ triage_flags: ['ambiguous_pest_or_service'], scheduling: { status: 'reschedule_requested', agent_committed_booking: true, caller_accepted_slot: true, confirmed_start_at: '2026-10-09T14:00:00Z' }, ...over });
  const JEV = { ok: true, answers: { service_unclear: { p: 0.8, yes: true, confident: false } }, packageHash: 'h', servedModel: 'jev-1.13.0' };

  beforeEach(() => {
    typedDecisionsLive.mockReturnValue(true);
    typedDecisionsClefLive.mockReturnValue(false);
    isEnabled.mockImplementation(() => true);
    askPackage.mockReset();
    recordDecisions.mockReset();
    askPackage.mockResolvedValue(JEV);
    recordDecisions.mockResolvedValue({ recorded: 3 });
  });
  afterAll(() => { typedDecisionsLive.mockReturnValue(false); isEnabled.mockImplementation(() => true); });

  test('gateCheckBaselines reads the exact signals the gates act on', () => {
    const call = { id: 'c1', v2_extraction_status: 'valid', ai_extraction_enriched: V2() };
    expect(gateCheckBaselines(call, new Set(['c1']))).toEqual({
      service_unclear: { production: true }, reschedule_committed: { production: true }, promise_open: { production: true },
    });
    // a proposal the agent did not commit to, no unclear flag, no promise: all false
    const plain = { id: 'c2', v2_extraction_status: 'valid', ai_extraction_enriched: V2({ triage_flags: [], scheduling: { status: 'reschedule_requested', agent_committed_booking: false, confirmed_start_at: null } }) };
    expect(gateCheckBaselines(plain, new Set(['c1']))).toEqual({
      service_unclear: { production: false }, reschedule_committed: { production: false }, promise_open: { production: false },
    });
  });

  test('a reschedule the caller did not accept is not committed, as the apply path rejects it', () => {
    const call = { id: 'c3', v2_extraction_status: 'valid', ai_extraction_enriched: V2({ scheduling: { status: 'reschedule_requested', agent_committed_booking: true, caller_accepted_slot: null, confirmed_start_at: '2026-10-09T14:00:00Z' } }) };
    expect(gateCheckBaselines(call, null).reschedule_committed).toEqual({ production: false });
  });

  test('the promise read counts only the kinds the chaser acts on', async () => {
    const whereInCalls = [];
    mockDb({ calls: [SAMPLE()], whereInCalls });
    await runSelfAudit({ createMessage: async () => ({ content: [{ type: 'text', text: '{}' }] }) });
    const kinds = whereInCalls.find(([table, col]) => table === 'call_commitments as cc' && col === 'cc.kind');
    expect(kinds[2]).toEqual(['callback', 'send_estimate', 'schedule_visit']);
  });

  test('a call longer than the span the models and reviewer see is counted, never asked the gate checks', async () => {
    const long = SAMPLE({ transcription: 'Agent: Waves. Caller: I need pest control at my house. '.repeat(120) });
    expect(long.transcription.length).toBeGreaterThan(5000);
    mockDb({ calls: [long] });
    const res = await runSelfAudit({ createMessage: async () => ({ content: [{ type: 'text', text: '{}' }] }) });
    expect(asksFor('call_gate_checks.v1')).toHaveLength(0);
    expect(asksFor('call_judge.v2')).toHaveLength(1); // call_judge unchanged
    expect(res.jev.gateChecks).toEqual({ asked: 0, recorded: 0, failed: 0, skippedLong: 1 });
  });

  test('no reading means no baseline, never a false one: invalid v2 extraction, commitments off', () => {
    expect(gateCheckBaselines({ id: 'c1', v2_extraction_status: 'failed', ai_extraction_enriched: V2() }, null)).toEqual({});
    expect(gateCheckBaselines({ id: 'c1', v2_extraction_status: 'valid', ai_extraction_enriched: null }, null)).toEqual({});
  });

  test('each sampled call is also asked call_gate_checks.v1 with the same state and recorded under its own capability', async () => {
    const call = SAMPLE({ id: 'call-7', direction: 'inbound', duration_seconds: 61, v2_extraction_status: 'valid', ai_extraction_enriched: V2() });
    mockDb({ calls: [call], promiseCallIds: ['call-7'] });
    const res = await runSelfAudit({ createMessage: async () => ({ content: [{ type: 'text', text: '{}' }] }) });

    const [judge] = asksFor('call_judge.v2');
    const [gates] = asksFor('call_gate_checks.v1');
    expect(gates[1]).toEqual(judge[1]); // identical call state
    const [args] = recordsFor('call_gate_checks.v1')[0];
    expect(args).toMatchObject({ capability: 'call_gate_checks', provider: 'typesafe', subjectType: 'call_log', subjectId: 'call-7', result: JEV });
    expect(args.baselines).toEqual({ service_unclear: { production: true }, reschedule_committed: { production: true }, promise_open: { production: true } });
    // tallied apart: call_judge's counts keep their meaning
    expect(res.jev.gateChecks).toEqual({ asked: 1, recorded: 1, failed: 0, skippedLong: 0 });
    expect(judgeTally(res.jev)).toEqual({ asked: 1, recorded: 1, failed: 0 });
  });

  test('commitments off: promise_open has no baseline; the other two still do', async () => {
    isEnabled.mockImplementation((name) => name !== 'callCommitments');
    mockDb({ calls: [SAMPLE({ v2_extraction_status: 'valid', ai_extraction_enriched: V2() })], promiseCallIds: ['call-1'] });
    await runSelfAudit({ createMessage: async () => ({ content: [{ type: 'text', text: '{}' }] }) });
    const [args] = recordsFor('call_gate_checks.v1')[0];
    expect(Object.keys(args.baselines).sort()).toEqual(['reschedule_committed', 'service_unclear']);
  });

  test('Clef on: both providers answer the gate checks, each row with the other\'s answers, tallied per leg', async () => {
    typedDecisionsClefLive.mockReturnValue(true);
    const CLEF = { ok: true, answers: { service_unclear: { p: 0.1, yes: false, confident: true } }, packageHash: 'h', servedModel: 'clef-flash' };
    askPackage.mockImplementation(async (_pkg, _state, opts) => (opts?.provider === 'cloudflare' ? CLEF : JEV));
    mockDb({ calls: [SAMPLE({ v2_extraction_status: 'valid', ai_extraction_enriched: V2() })] });
    const res = await runSelfAudit({ createMessage: async () => ({ content: [{ type: 'text', text: '{}' }] }) });
    const byProvider = Object.fromEntries(recordsFor('call_gate_checks.v1').map(([a]) => [a.provider, a]));
    expect(byProvider.typesafe.siblingAnswers).toEqual({ service_unclear: [CLEF.answers.service_unclear] });
    expect(byProvider.cloudflare.siblingAnswers).toEqual({ service_unclear: [JEV.answers.service_unclear] });
    expect(res.jev.gateChecks).toEqual({ asked: 1, recorded: 1, failed: 0, skippedLong: 0, clef: { asked: 1, recorded: 1, failed: 0 } });
  });

  test('the gate-check ask failing never touches call_judge or the audit', async () => {
    askPackage.mockImplementation(async (pkg) => { if (pkg === 'call_gate_checks.v1') throw new Error('boom'); return JEV; });
    mockDb({ calls: [SAMPLE()] });
    const res = await runSelfAudit({ createMessage: async () => ({ content: [{ type: 'text', text: '{}' }] }) });
    expect(judgeTally(res.jev)).toEqual({ asked: 1, recorded: 1, failed: 0 });
    expect(res.jev.gateChecks).toEqual({ asked: 1, recorded: 0, failed: 1, skippedLong: 0 });
    expect(res.audited).toBe(1);
  });
});

describe('voicemail triage evidence (voicemail.v1: every inbound voicemail beside what production decided)', () => {
  const JEV = { ok: true, answers: { callback_requested: { p: 0.9, yes: true, confident: true } }, packageHash: 'h', servedModel: 'jev-1.13.0' };
  const VM = (over = {}) => ({ id: 'vm-1', twilio_call_sid: 'CA_vm1', direction: 'inbound', processing_status: 'voicemail', disposition: null, voicemail_callback_alerted_at: null, transcription: 'Hi, this is about my termites, please call me back.', ai_extraction: JSON.stringify({ is_voicemail: true }), duration_seconds: 21, ...over });

  function vmDb({ rows = [], leadSids = [], triageIds = [], answered = [], stored = null } = {}) {
    const seen = { updates: [] };
    // decision_reviews rows: [subject_id, provider] pairs, or full rows via `stored`.
    const reviewRows = stored || answered.map(([subject_id, provider]) => ({ subject_id, provider, question_id: 'callback_requested', jev_answer: { p: 0.9, yes: true } }));
    seen.reviewRows = reviewRows;
    db.raw = (sql) => sql;
    db.mockImplementation((table) => {
      const push = (a) => { (seen[table] = seen[table] || []).push(a); };
      const b = {
        modify(fn) { fn(b); return b; }, whereRaw(...a) { push(a); return b; }, whereIn(...a) { push(a); return b; },
        where(...a) { push(a); return b; }, whereNot() { return b; }, orderBy() { return b; },
        whereNotExists(fn) { const sub = { select() { return sub; }, from(t) { push(['notExists', t]); return sub; }, where(...a) { push(['notExists', ...a]); return sub; }, whereRaw(...a) { push(['notExists', ...a]); return sub; } }; fn.call(sub); return b; },
        select: async () => {
          if (table === 'call_log') return rows;
          if (table === 'leads') return leadSids.map((sid) => ({ twilio_call_sid: sid }));
          if (table === 'decision_reviews') return reviewRows;
          return [];
        },
        whereNull(...a) { push(['null', ...a]); return b; },
        update: async (patch) => { seen.updates.push([table, patch, (seen[table] || []).slice(-3)]); return 1; },
        distinct: async () => (table === 'triage_items' ? triageIds.map((id) => ({ call_log_id: id })) : []),
      };
      return b;
    });
    return seen;
  }
  const bySubject = () => Object.fromEntries(recordsFor('voicemail.v1').map(([a]) => [a.subjectId, a]));

  beforeEach(() => {
    typedDecisionsLive.mockReturnValue(true);
    typedDecisionsClefLive.mockReturnValue(false);
    askPackage.mockReset(); recordDecisions.mockReset();
    askPackage.mockResolvedValue(JEV); recordDecisions.mockResolvedValue({ recorded: 3 });
  });
  afterAll(() => typedDecisionsLive.mockReturnValue(false));

  test('gate off: nothing read, asked or recorded', async () => {
    typedDecisionsLive.mockReturnValue(false);
    vmDb({ rows: [VM()] });
    expect(await shadowVoicemails()).toEqual({ asked: 0, recorded: 0, failed: 0, skippedLong: 0 });
    expect(askPackage).not.toHaveBeenCalled();
  });

  test('reached a person = the callback alert claim (delivery-independent), a lead, or a triage item; none of them = not', async () => {
    vmDb({
      rows: [
        VM({ id: 'vm-alert', twilio_call_sid: 'CA_1', voicemail_callback_alerted_at: new Date() }),
        VM({ id: 'vm-lead', twilio_call_sid: 'CA_2', processing_status: 'processed' }),
        VM({ id: 'vm-failed-lead', twilio_call_sid: 'CA_3', processing_status: 'lead_creation_failed' }),
        VM({ id: 'vm-silent', twilio_call_sid: 'CA_4' }),
      ],
      leadSids: ['CA_2'], triageIds: ['vm-failed-lead'],
    });
    const tally = await shadowVoicemails();
    const s = bySubject();
    expect(s['vm-alert'].baselines.callback_requested).toEqual({ production: true });
    expect(s['vm-lead'].baselines.callback_requested).toEqual({ production: true });
    expect(s['vm-failed-lead'].baselines.callback_requested).toEqual({ production: true });
    expect(s['vm-silent'].baselines.callback_requested).toEqual({ production: false });
    expect(s['vm-silent']).toMatchObject({ capability: 'voicemail', subjectType: 'call_log', provider: 'typesafe' });
    expect(s['vm-silent'].baselines).not.toHaveProperty('needs_attention_today'); // no production decision: no baseline
    expect(tally).toEqual({ asked: 4, recorded: 4, failed: 0, skippedLong: 0 });
  });

  test('spam baseline: spam status, the extraction\'s is_spam, or the vendor disposition; a processed call is a voicemail only when the extraction says so', async () => {
    vmDb({ rows: [
      VM({ id: 'vm-s', processing_status: 'spam' }),
      VM({ id: 'vm-x', processing_status: 'processed', ai_extraction: JSON.stringify({ is_voicemail: true, is_spam: true }) }),
      VM({ id: 'vm-vendor', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: 'vendor_or_partner' }) }),
      VM({ id: 'vm-applicant', disposition: 'vendor_logged', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: 'job_applicant' }) }),
      VM({ id: 'vm-real' }),
      VM({ id: 'call-live', processing_status: 'processed', ai_extraction: JSON.stringify({ is_voicemail: false }) }),
    ] });
    await shadowVoicemails();
    const s = bySubject();
    expect(Object.keys(s).sort()).toEqual(['vm-applicant', 'vm-real', 'vm-s', 'vm-vendor', 'vm-x']);
    for (const id of ['vm-s', 'vm-x', 'vm-vendor']) expect(s[id].baselines.is_vendor_or_spam).toEqual({ production: true });
    // a job applicant shares the vendor_logged disposition but is no vendor pitch
    for (const id of ['vm-real', 'vm-applicant']) expect(s[id].baselines.is_vendor_or_spam).toEqual({ production: false });
  });

  test('each enabled provider is asked until its own answer is recorded: a voicemail one provider answered re-asks only the other', async () => {
    typedDecisionsClefLive.mockReturnValue(true);
    try {
      askPackage.mockImplementation(async () => JEV);
      vmDb({ rows: [VM({ id: 'vm-half' }), VM({ id: 'vm-done' }), VM({ id: 'vm-new' })], answered: [['vm-half', 'typesafe'], ['vm-done', 'typesafe'], ['vm-done', 'cloudflare']] });
      const tally = await shadowVoicemails();
      const asked = asksFor('voicemail.v1').map((c) => (c[2] && c[2].provider) || 'typesafe');
      expect(asked.sort()).toEqual(['cloudflare', 'cloudflare', 'typesafe']); // vm-half: Clef only; vm-new: both; vm-done: none
      expect(Object.keys(bySubject()).sort()).toEqual(['vm-half', 'vm-new']);
      expect(tally).toMatchObject({ asked: 1, recorded: 1, clef: { asked: 2, recorded: 2 } });
    } finally { typedDecisionsClefLive.mockReturnValue(false); }
  });

  test('a retried provider is handed the stored answers, and a disagreement only visible now queues the earlier row too', async () => {
    typedDecisionsClefLive.mockReturnValue(true);
    try {
      const JEV_YES = { p: 0.9, yes: true, confident: true };
      const CLEF_NO = { p: 0.1, yes: false, confident: true };
      const stored = [{ subject_id: 'vm-1', provider: 'typesafe', question_id: 'callback_requested', jev_answer: JEV_YES }];
      const seen = vmDb({ rows: [VM({ id: 'vm-1' })], stored });
      askPackage.mockImplementation(async () => ({ ok: true, answers: { callback_requested: CLEF_NO }, packageHash: 'h', servedModel: 'clef-flash' }));
      // the Clef row lands beside the stored Jev row
      recordDecisions.mockImplementation(async (args) => { stored.push({ subject_id: args.subjectId, provider: args.provider, question_id: 'callback_requested', jev_answer: CLEF_NO }); return { recorded: 1 }; });
      await shadowVoicemails();
      expect(asksFor('voicemail.v1').map((c) => c[2] && c[2].provider)).toEqual(['cloudflare']);
      expect(recordsFor('voicemail.v1')[0][0]).toMatchObject({ provider: 'cloudflare', siblingAnswers: { callback_requested: [JEV_YES] } });
      // both rows of the split question go to the disagreement cohort (only rows without one, only unreviewed)
      const [table, patch] = seen.updates[0];
      expect([table, patch]).toEqual(['decision_reviews', { sampled_for: 'disagreement' }]);
      expect(seen.decision_reviews).toContainEqual(['null', 'sampled_for']);
      expect(seen.decision_reviews).toContainEqual(['question_id', ['callback_requested']]);
    } finally { typedDecisionsClefLive.mockReturnValue(false); }
  });

  test('a 7-day lookback over terminal voicemails, inbound only, skipping any already answered; a long voicemail is counted, never asked', async () => {
    const seen = vmDb({ rows: [VM({ id: 'vm-long', transcription: 'Hi please call me back about the termites. '.repeat(200) })] });
    const tally = await shadowVoicemails({ now: new Date('2026-10-03T08:00:00Z') });
    expect(tally).toEqual({ asked: 0, recorded: 0, failed: 0, skippedLong: 1 });
    expect(askPackage).not.toHaveBeenCalled();
    const calls = seen.call_log || [];
    expect(calls.map((a) => String(a[0]))).toContain("COALESCE(direction, '') NOT LIKE 'outbound%'");
    expect(calls.find((a) => a[0] === 'created_at')[2]).toEqual(new Date('2026-09-26T08:00:00Z'));
    expect(calls.find((a) => a[0] === 'processing_status')[1]).toEqual(['voicemail', 'processed', 'spam', 'lead_creation_failed']);
    // answered per provider, from decision_reviews rows for these voicemails
    expect(seen.decision_reviews).toContainEqual([{ capability: 'voicemail', subject_type: 'call_log' }]);
  });

  test('a read failure is logged, never thrown', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(shadowVoicemails()).resolves.toEqual({ asked: 0, recorded: 0, failed: 0, skippedLong: 0 });
  });
});
