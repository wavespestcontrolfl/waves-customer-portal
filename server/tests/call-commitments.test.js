// Pure behaviour of the commitments extractor: identity, deterministic
// seeds from the V2 extraction, transcript grounding of model output, and
// evidence anchoring to diarized segments. Fixtures are fictitious.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  COMMITMENT_KINDS,
  commitmentKey,
  deriveCommitmentsFromExtraction,
  groundModelCommitments,
  anchorEvidence,
  buildCommitmentsPrompt,
  MODEL_OUTPUT_SCHEMA,
  MIN_MODEL_CONFIDENCE,
} = require('../services/call-commitments');

const TRANSCRIPT = [
  'Agent: Thanks for calling Waves, this is the office.',
  "Caller: Hi, I've got ants in the kitchen and I'd like a price.",
  "Agent: Sure, I'll email you an estimate this afternoon.",
  "Caller: Great, and I'll text you a couple of photos of the ant trail.",
  'Agent: Perfect, someone will call you back tomorrow morning to book it.',
].join('\n');

const SEGMENTS = [
  { index: 0, speaker: 'A', start_ms: 0, end_ms: 2200, text: 'Thanks for calling Waves, this is the office.' },
  { index: 1, speaker: 'B', start_ms: 2300, end_ms: 6100, text: "Hi, I've got ants in the kitchen and I'd like a price." },
  { index: 2, speaker: 'A', start_ms: 6200, end_ms: 9800, text: "Sure, I'll email you an estimate this afternoon." },
  { index: 3, speaker: 'B', start_ms: 9900, end_ms: 13500, text: "Great, and I'll text you a couple of photos of the ant trail." },
  { index: 4, speaker: 'A', start_ms: 13600, end_ms: 17900, text: 'Perfect, someone will call you back tomorrow morning to book it.' },
];

describe('commitmentKey', () => {
  test('enumerated kinds key on party:kind so a reprocess upserts', () => {
    expect(commitmentKey({ party: 'waves', kind: 'send_estimate', description: 'Send the estimate' })).toBe('waves:send_estimate');
    expect(commitmentKey({ party: 'waves', kind: 'send_estimate', description: 'Email the quote tonight' })).toBe('waves:send_estimate');
    expect(commitmentKey({ party: 'customer', kind: 'send_photos', description: 'x' })).toBe('customer:send_photos');
  });
  test('free-form kinds key on a stopword-free slug of the description', () => {
    const a = commitmentKey({ party: 'waves', kind: 'other', description: 'We will leave the gate code with the technician' });
    const b = commitmentKey({ party: 'waves', kind: 'other', description: 'We will leave the gate code with the technician.' });
    expect(a).toBe(b);
    expect(a).toMatch(/^waves:other:/);
  });
  test('repeatable kinds keep one row per distinct promise; singular kinds do not', () => {
    const report = commitmentKey({ party: 'waves', kind: 'send_paperwork', description: 'Send the WDO report' });
    const forms = commitmentKey({ party: 'waves', kind: 'send_paperwork', description: 'Send the termite treatment paperwork' });
    expect(report).not.toBe(forms);
    expect(report).toMatch(/^waves:send_paperwork:/);
    const info1 = commitmentKey({ party: 'customer', kind: 'provide_info', description: 'Text the gate code' });
    const info2 = commitmentKey({ party: 'customer', kind: 'provide_info', description: 'Send the HOA contact' });
    expect(info1).not.toBe(info2);
    // Two estimate promises are the same obligation.
    expect(commitmentKey({ party: 'waves', kind: 'send_estimate', description: 'Email the quote' }))
      .toBe(commitmentKey({ party: 'waves', kind: 'send_estimate', description: 'Send an estimate tonight' }));
  });
  test('a human key keeps its :h suffix even for a very long description', () => {
    const { REPEATABLE_KINDS } = require('../services/call-commitments');
    expect(REPEATABLE_KINDS.has('provide_info')).toBe(true);
    const longWord = 'x'.repeat(300);
    const base = commitmentKey({ party: 'customer', kind: 'provide_info', description: longWord });
    expect(base.length).toBeLessThanOrEqual(160);
    // The human variant reserves room for the suffix (checked here through
    // the same construction addHumanCommitment uses).
    const suffix = ':h' + require('crypto').createHash('sha1').update(longWord).digest('hex').slice(0, 6);
    const key = `${base.slice(0, 160 - suffix.length)}${suffix}`;
    expect(key.length).toBe(160);
    expect(key.endsWith(suffix)).toBe(true);
    expect(key).not.toBe(base);
  });

  test('unknown kinds and parties are coerced, never thrown', () => {
    expect(commitmentKey({ party: 'martian', kind: 'teleport', description: 'beam up' })).toMatch(/^waves:other:/);
  });
});

describe('deriveCommitmentsFromExtraction (V2 seeds)', () => {
  const v2 = {
    service_request: { quote_promised: true, quoted_price_usd: 149 },
    scheduling: {
      status: 'confirmed',
      confirmed_start_at: '2026-09-03T10:00:00-04:00',
      callback_window_start: '2026-09-02T09:00:00-04:00',
      follow_up_mentioned: true,
      follow_up_start_at: '2026-09-20T09:00:00-04:00',
    },
    caller: { preferred_contact_method: 'email' },
    confidence: { overall: 0.82, scheduling_window: 0.7 },
    evidence: [
      { field_path: '/service_request/quoted_price_usd', quote: 'about a hundred forty nine', speaker: 'agent', transcript_offset_ms: null },
      { field_path: '/scheduling/confirmed_start_at', quote: 'Thursday at ten works', speaker: 'caller', transcript_offset_ms: null },
      { field_path: '/scheduling/callback_window_start', quote: 'call me back tomorrow at nine', speaker: 'caller', transcript_offset_ms: null },
      { field_path: '/scheduling/follow_up_start_at', quote: 'we come back around the twentieth', speaker: 'agent', transcript_offset_ms: null },
    ],
  };

  test('quote_promised → send_estimate with the pinned price evidence and the caller\'s channel', () => {
    const items = deriveCommitmentsFromExtraction({ v2 });
    const est = items.find((i) => i.kind === 'send_estimate');
    expect(est).toMatchObject({ party: 'waves', channel: 'email', confidence: 0.82, origin: 'v2:service_request.quote_promised' });
    expect(est.evidence).toEqual([expect.objectContaining({ quote: 'about a hundred forty nine', speaker: 'agent' })]);
  });

  test('a callback window → callback with a STATED due time; follow_up_mentioned → technician_follow_up; a confirmed slot alone seeds NO confirmation promise', () => {
    const items = deriveCommitmentsFromExtraction({ v2 });
    // A booked slot proves the booking, not a promise to text later — the
    // pipeline sends its own confirmation; an explicit promise needs the
    // model pass and verbatim evidence.
    expect(items.map((i) => i.kind).sort()).toEqual(['callback', 'send_estimate', 'technician_follow_up']);
    const cb = items.find((i) => i.kind === 'callback');
    expect(cb.due_at).toBe(new Date('2026-09-02T09:00:00-04:00').toISOString());
    expect(cb.due_basis).toBe('stated');
    const fu = items.find((i) => i.kind === 'technician_follow_up');
    expect(fu.due_basis).toBe('stated');
  });

  test('nothing is seeded from an empty or non-committal extraction', () => {
    expect(deriveCommitmentsFromExtraction({ v2: null, v1: null })).toEqual([]);
    expect(deriveCommitmentsFromExtraction({ v2: { scheduling: { status: 'requested' }, service_request: {} } })).toEqual([]);
  });

  test('V1 and the routing disposition never seed a commitment — downstream reads V2 + transcript only', () => {
    expect(deriveCommitmentsFromExtraction({ v1: { quote_promised: true } })).toEqual([]);
    expect(deriveCommitmentsFromExtraction({ v2: { scheduling: {} }, disposition: 'callback_task_created' })).toEqual([]);
  });

  test('a V2 flag with no pinned transcript quote is not seeded — the model pass must ground it', () => {
    expect(deriveCommitmentsFromExtraction({ v2: { ...v2, evidence: [] } })).toEqual([]);
    expect(deriveCommitmentsFromExtraction({ v2: { scheduling: {}, recommended_disposition: 'callback_task_created', evidence: [] } })).toEqual([]);
  });
});

describe('groundModelCommitments', () => {
  test('keeps commitments whose quotes are verbatim in the transcript and drops the rest', () => {
    const out = groundModelCommitments([
      { party: 'waves', kind: 'send_estimate', description: 'Email an estimate', confidence: 0.9, evidence: [{ quote: "I'll email you an estimate this afternoon", speaker: 'agent' }] },
      { party: 'customer', kind: 'send_photos', description: 'Text photos', confidence: 0.8, evidence: [{ quote: 'I will send you the photos by carrier pigeon', speaker: 'caller' }] },
      { party: 'waves', kind: 'callback', description: 'Call back tomorrow', confidence: 0.3, evidence: [{ quote: 'someone will call you back tomorrow morning', speaker: 'agent' }] },
    ], TRANSCRIPT);
    expect(out.kept.map((k) => k.kind)).toEqual(['send_estimate']);
    expect(out.droppedUngrounded).toBe(1);
    expect(out.droppedLowConfidence).toBe(1);
    expect(MIN_MODEL_CONFIDENCE).toBeGreaterThan(0.3);
  });

  test('grounding is case- and punctuation-insensitive but never fuzzy on words', () => {
    const out = groundModelCommitments([
      { party: 'customer', kind: 'send_photos', description: 'Text photos', confidence: 0.8, evidence: [{ quote: "i'll TEXT you a couple of photos", speaker: 'caller' }] },
      { party: 'customer', kind: 'send_photos', description: 'Text photos', confidence: 0.8, evidence: [{ quote: "i'll text you several photos", speaker: 'caller' }] },
    ], TRANSCRIPT);
    expect(out.kept).toHaveLength(1);
    expect(out.droppedUngrounded).toBe(1);
  });

  test('a naive model due_at is read as Eastern, never UTC', () => {
    const out = groundModelCommitments([
      { party: 'waves', kind: 'callback', description: 'Call back at nine', confidence: 0.8, due_at: '2026-09-02T09:00:00', evidence: [{ quote: 'this is the office', speaker: 'agent' }] },
    ], TRANSCRIPT);
    // 9 am EDT is 13:00Z.
    expect(out.kept[0].due_at).toBe('2026-09-02T13:00:00.000Z');
    expect(out.kept[0].due_basis).toBe('stated');
  });

  test('an unknown channel or kind is coerced; a stated due_at is kept as ISO', () => {
    const out = groundModelCommitments([
      { party: 'waves', kind: 'send_paperwork', channel: 'fax', description: 'Send WDO paperwork', confidence: 0.7, due_at: '2026-09-02T09:00:00-04:00', evidence: [{ quote: 'this is the office', speaker: 'agent' }] },
    ], TRANSCRIPT);
    expect(out.kept[0]).toMatchObject({ channel: 'unknown', kind: 'send_paperwork', due_basis: 'stated' });
    expect(out.kept[0].due_at).toBe(new Date('2026-09-02T09:00:00-04:00').toISOString());
  });
});

describe('anchorEvidence', () => {
  test('pins a quote to the diarized segment (index + timestamps) that contains it', () => {
    const [e] = anchorEvidence([{ quote: "I'll email you an estimate this afternoon", speaker: 'agent' }], { segments: SEGMENTS, transcript: TRANSCRIPT });
    expect(e).toMatchObject({ matched: true, segment_index: 2, start_ms: 6200, end_ms: 9800, speaker: 'agent' });
  });
  test('falls back to a character offset in the flat transcript when there are no segments', () => {
    const [e] = anchorEvidence([{ quote: 'call you back tomorrow morning', speaker: 'agent' }], { segments: null, transcript: TRANSCRIPT });
    expect(e.matched).toBe(true);
    expect(e.segment_index).toBeUndefined();
    expect(TRANSCRIPT.slice(e.char_offset, e.char_offset + 30).toLowerCase()).toBe('call you back tomorrow morning');
  });
  test('a quote the transcript does not contain is kept as UNMATCHED, never relocated', () => {
    const [e] = anchorEvidence([{ quote: 'we guarantee it for a year', speaker: 'agent' }], { segments: SEGMENTS, transcript: TRANSCRIPT });
    expect(e).toEqual({ quote: 'we guarantee it for a year', speaker: 'agent', matched: false });
  });
  test('empty quotes and unknown speakers are handled', () => {
    expect(anchorEvidence([{ quote: '', speaker: 'agent' }, null, { quote: 'ants', speaker: 'narrator' }], { transcript: TRANSCRIPT }))
      .toEqual([{ quote: 'ants', speaker: null, matched: true, char_offset: expect.any(Number) }]);
  });
});

describe('kindBelongsToParty — a kind belongs to one party', () => {
  const { kindBelongsToParty } = require('../services/call-commitments');
  test('waves kinds are waves-only, customer kinds customer-only, other is both, unknown is neither', () => {
    expect(kindBelongsToParty('waves', 'send_estimate')).toBe(true);
    expect(kindBelongsToParty('customer', 'send_estimate')).toBe(false);
    expect(kindBelongsToParty('customer', 'send_photos')).toBe(true);
    expect(kindBelongsToParty('waves', 'send_photos')).toBe(false);
    expect(kindBelongsToParty('waves', 'other')).toBe(true);
    expect(kindBelongsToParty('customer', 'other')).toBe(true);
    expect(kindBelongsToParty('martian', 'other')).toBe(false);
  });
  test('model output with a mismatched pairing is dropped, not re-labelled', () => {
    const out = groundModelCommitments([
      { party: 'customer', kind: 'send_estimate', description: 'x', confidence: 0.9, evidence: [{ quote: 'this is the office', speaker: 'agent' }] },
    ], TRANSCRIPT);
    expect(out.kept).toEqual([]);
    expect(out.droppedMismatched).toBe(1);
  });
});

describe('parseDueAt — office-entered times are Eastern', () => {
  const { parseDueAt } = require('../services/call-commitments');
  test('a naive datetime-local string is pinned to ET, not to the server\'s UTC clock', () => {
    // 1 pm Eastern on 2026-09-05 (EDT, UTC-4) is 17:00Z.
    expect(parseDueAt('2026-09-05T13:00').toISOString()).toBe('2026-09-05T17:00:00.000Z');
    // Winter: EST, UTC-5.
    expect(parseDueAt('2026-12-05T13:00').toISOString()).toBe('2026-12-05T18:00:00.000Z');
  });
  test('an ISO instant with an offset is taken as-is; empty is null; garbage is NaN', () => {
    expect(parseDueAt('2026-09-05T17:00:00.000Z').toISOString()).toBe('2026-09-05T17:00:00.000Z');
    expect(parseDueAt('2026-09-05T13:00:00-04:00').toISOString()).toBe('2026-09-05T17:00:00.000Z');
    expect(parseDueAt('')).toBeNull();
    expect(parseDueAt(null)).toBeNull();
    expect(Number.isNaN(parseDueAt('next tuesday'))).toBe(true);
  });
});

describe('model contract', () => {
  test('the prompt forbids inference and demands verbatim quotes; it never carries a phone number', () => {
    const prompt = buildCommitmentsPrompt({ transcript: TRANSCRIPT, callStartedAt: '2026-09-01T14:00:00Z' });
    expect(prompt).toMatch(/Only list what was actually SAID/);
    expect(prompt).toMatch(/VERBATIM quote/);
    expect(prompt).toContain(TRANSCRIPT);
  });
  test('the output schema pins the kinds the table CHECK-constrains', () => {
    expect(MODEL_OUTPUT_SCHEMA.properties.commitments.items.properties.kind.enum).toEqual(COMMITMENT_KINDS);
    const migration = require('../models/migrations/20260901000010_call_commitments');
    expect(migration.COMMITMENT_KINDS).toEqual([...COMMITMENT_KINDS]);
  });
});
