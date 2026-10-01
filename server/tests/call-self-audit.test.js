// Nightly self-audit — auditor-down is a breach, the auditor is blind, and
// every lead-losing terminal disposition counts as drift.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), typedDecisionsLive: jest.fn(() => false) }));
jest.mock('../services/llm/deep', () => ({ createDeepMessage: jest.fn() }));
jest.mock('../services/typed-decisions/jev', () => ({ askPackage: jest.fn() }));
jest.mock('../services/typed-decisions/shadow-recorder', () => ({ recordDecisions: jest.fn() }));
jest.mock('../services/typed-decisions/outcome-evidence', () => ({ callEvidence: jest.fn() }));

const db = require('../models/db');
const { createDeepMessage } = require('../services/llm/deep');
const { typedDecisionsLive } = require('../config/feature-gates');
const { askPackage } = require('../services/typed-decisions/jev');
const { recordDecisions } = require('../services/typed-decisions/shadow-recorder');
const { callEvidence } = require('../services/typed-decisions/outcome-evidence');
const { runSelfAudit, stratifySample, OUTBOUND_DIRECTION_SQL, callDirectionBlock } = require('../services/call-self-audit');

const SAMPLE = (over = {}) => ({
  id: 'call-1', twilio_call_sid: 'CA_sa1', created_at: new Date(), processing_status: 'processed',
  transcription: 'Agent: Waves. Caller: I need pest control at my house. '.repeat(8),
  ai_extraction: JSON.stringify({ is_lead: true }), disposition: null, ...over,
});

function mockDb({ calls, onInsert = () => {}, whereCalls = [] }) {
  db.raw = (sql) => sql;
  db.mockImplementation((table) => {
    const raws = [];
    const isOutbound = (c) => String(c.direction || '').startsWith('outbound');
    const b = {
      where(...args) { whereCalls.push(args); return b; }, whereIn() { return b; }, whereRaw(sql) { raws.push(sql); return b; }, modify(fn) { fn(b); return b; },
      orderBy() { return b; }, limit() { return b; },
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
  const EVIDENCE = { appointment_agreed: { source: 'scheduled_services', window: '24h', value: null, observed_at: 'now' } };

  beforeEach(() => {
    typedDecisionsLive.mockReturnValue(false);
    askPackage.mockReset();
    recordDecisions.mockReset();
    callEvidence.mockReset();
    askPackage.mockResolvedValue(JEV_OK);
    recordDecisions.mockResolvedValue({ recorded: 6 });
    callEvidence.mockResolvedValue(EVIDENCE);
  });
  afterAll(() => typedDecisionsLive.mockReturnValue(false));

  test('gate off: Jev is never asked and nothing is recorded', async () => {
    mockDb({ calls: [SAMPLE()] });
    const res = await runSelfAudit({ createMessage: async () => VERDICT });
    expect(askPackage).not.toHaveBeenCalled();
    expect(recordDecisions).not.toHaveBeenCalled();
    expect(res.jev).toEqual({ asked: 0, recorded: 0, failed: 0 });
  });

  test('gate on: asks call_judge.v2 with the transcript and direction, records both baselines and the evidence', async () => {
    typedDecisionsLive.mockReturnValue(true);
    const prodCall = SAMPLE({ id: 'call-9', direction: 'inbound', duration_seconds: 88, ai_extraction: JSON.stringify({ is_lead: true, appointment_confirmed: false, quote_promised: false }) });
    mockDb({ calls: [prodCall] });
    const res = await runSelfAudit({ createMessage: async () => VERDICT });

    expect(askPackage).toHaveBeenCalledTimes(1);
    const [packageId, state] = askPackage.mock.calls[0];
    expect(packageId).toBe('call_judge.v2');
    expect(Object.keys(state).sort()).toEqual(['call_direction', 'duration_seconds', 'transcript']);
    expect(state.duration_seconds).toBe(88);
    expect(state.call_direction).toMatch(/^INBOUND/);
    expect(state.transcript).toBe(prodCall.transcription.slice(0, 5000));

    expect(recordDecisions).toHaveBeenCalledTimes(1);
    const args = recordDecisions.mock.calls[0][0];
    expect(args).toMatchObject({ capability: 'call_judge', subjectType: 'call_log', subjectId: 'call-9', result: JEV_OK, outcomeEvidence: EVIDENCE });
    expect(args.pkg.id).toBe('call_judge.v2');
    // production and deep judge side by side for the five shared fields
    expect(args.baselines.appointment_agreed).toEqual({ production: false, deep_judge: true });
    expect(args.baselines.is_lead).toEqual({ production: true, deep_judge: true });
    expect(args.baselines.is_spam).toEqual({ production: false, deep_judge: false });
    // complaint has no production field: deep judge only
    expect(args.baselines.complaint).toEqual({ deep_judge: true });
    expect(res.jev).toEqual({ asked: 1, recorded: 1, failed: 0 });
  });

  test('a failed deep audit still asks Jev, recorded against production only', async () => {
    typedDecisionsLive.mockReturnValue(true);
    mockDb({ calls: [SAMPLE({ ai_extraction: JSON.stringify({ is_lead: true }) })] });
    const res = await runSelfAudit({ createMessage: async () => { throw new Error('deep judge down'); } });
    expect(askPackage).toHaveBeenCalledTimes(1);
    const args = recordDecisions.mock.calls[0][0];
    expect(args.baselines.is_lead).toEqual({ production: true, deep_judge: undefined });
    expect(args.baselines.complaint).toEqual({ deep_judge: undefined });
    expect(res.jev).toEqual({ asked: 1, recorded: 1, failed: 0 });
  });

  test('an outbound call gets the outbound direction line and a missing duration is null', async () => {
    typedDecisionsLive.mockReturnValue(true);
    mockDb({ calls: [SAMPLE({ direction: 'outbound-dial', duration_seconds: undefined })] });
    await runSelfAudit({ createMessage: async () => VERDICT });
    const state = askPackage.mock.calls[0][1];
    expect(state.call_direction).toMatch(/^OUTBOUND/);
    expect(state.duration_seconds).toBeNull();
  });

  test.each([
    ['Jev answers ok:false', () => askPackage.mockResolvedValue({ ok: false, reason: 'error' }), { asked: 1, recorded: 0, failed: 1 }],
    ['Jev throws', () => askPackage.mockRejectedValue(new Error('provider down')), { asked: 1, recorded: 0, failed: 1 }],
    ['the recorder throws', () => recordDecisions.mockRejectedValue(new Error('db down')), { asked: 1, recorded: 0, failed: 1 }],
    ['the evidence read throws (still recorded, no evidence)', () => callEvidence.mockRejectedValue(new Error('evidence down')), { asked: 1, recorded: 1, failed: 0 }],
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
    expect(res.jev).toEqual(jev);
  });
});
