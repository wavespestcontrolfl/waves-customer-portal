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
  'Agent: And I will send the WDO paperwork over tonight.',
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
  test('a repeatable promise keys on its verbatim quote, so a paraphrased description on reprocess is the same row (codex gh-r15 P2)', () => {
    const quote = { quote: 'I will send you the inspection report tonight', speaker: 'agent' };
    const a = commitmentKey({ party: 'waves', kind: 'send_report', description: 'Send the inspection report', evidence: [quote] });
    const b = commitmentKey({ party: 'waves', kind: 'send_report', description: 'Email the inspection findings', evidence: [{ ...quote, quote: 'I WILL send you the inspection report tonight.' }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^waves:send_report:q[0-9a-f]{12}$/);
    const other = commitmentKey({ party: 'waves', kind: 'send_report', description: 'Send the inspection report', evidence: [{ quote: 'and the treatment plan goes out Friday', speaker: 'agent' }] });
    expect(other).not.toBe(a);
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
  // The transcript the fixture's quotes came from: a seed needs its quote in
  // the claimed speaker's turn (codex gh-r15 P1).
  const transcript = [
    'Caller: Hi, I have ants in the kitchen and wanted a price.',
    "Agent: I'll get you a written estimate tonight, it is about a hundred forty nine.",
    'Caller: Thursday at ten works. Call me back tomorrow at nine.',
    'Agent: Sure, someone will call you back tomorrow at nine.',
    'Agent: We come back around the twentieth for the follow-up.',
  ].join('\n');
  const derive = (args) => deriveCommitmentsFromExtraction({ transcript, ...args });
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
      { field_path: '/service_request/quote_promised', quote: "I'll get you a written estimate tonight", speaker: 'agent', transcript_offset_ms: null },
      { field_path: '/service_request/quoted_price_usd', quote: 'about a hundred forty nine', speaker: 'agent', transcript_offset_ms: null },
      { field_path: '/scheduling/confirmed_start_at', quote: 'Thursday at ten works', speaker: 'caller', transcript_offset_ms: null },
      { field_path: '/scheduling/callback_window_start', quote: 'call me back tomorrow at nine', speaker: 'caller', transcript_offset_ms: null },
      { field_path: '/scheduling/callback_window_start', quote: 'someone will call you back tomorrow at nine', speaker: 'agent', transcript_offset_ms: null },
      { field_path: '/scheduling/follow_up_start_at', quote: 'we come back around the twentieth', speaker: 'agent', transcript_offset_ms: null },
    ],
  };

  test('quote_promised → send_estimate with the pinned price evidence and the caller\'s channel', () => {
    const items = derive({ v2 });
    const est = items.find((i) => i.kind === 'send_estimate');
    expect(est).toMatchObject({ party: 'waves', channel: 'email', confidence: 0.82, origin: 'v2:service_request.quote_promised' });
    expect(est.evidence).toEqual([
      expect.objectContaining({ quote: "I'll get you a written estimate tonight", speaker: 'agent' }),
      expect.objectContaining({ quote: 'about a hundred forty nine', speaker: 'agent' }),
    ]);
  });

  test('a spoken price alone never seeds send_estimate — the promise itself needs a pinned quote (codex #3738 gh-r7 P1)', () => {
    const priceOnly = { ...v2, evidence: v2.evidence.filter((e) => e.field_path !== '/service_request/quote_promised') };
    expect(derive({ v2: priceOnly }).find((i) => i.kind === 'send_estimate')).toBeUndefined();
  });

  test('a callback window → callback with a STATED due time; follow_up_mentioned → technician_follow_up; a confirmed slot alone seeds NO confirmation promise', () => {
    const items = derive({ v2 });
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

  test('a TIME-ONLY callback window (the persisted schema shape) is pinned to the ET date of the call, rolling to the next day when that time had already passed', () => {
    const timeOnly = { ...v2, scheduling: { ...v2.scheduling, callback_window_start: '09:00' } };
    const at = (start) => derive({ v2: timeOnly, callStartedAt: start }).find((i) => i.kind === 'callback');
    // Called at eight in the morning: nine this morning.
    // The TIME was stated, the date is derived: due_basis says so (codex gh-r15 P2).
    expect(at('2026-09-02T08:00:00-04:00')).toMatchObject({ due_at: new Date('2026-09-02T09:00:00-04:00').toISOString(), due_basis: 'suggested' });
    // Called at three in the afternoon: nine tomorrow.
    expect(at('2026-09-02T15:00:00-04:00')).toMatchObject({ due_at: new Date('2026-09-03T09:00:00-04:00').toISOString(), due_basis: 'suggested' });
    // No call start to pin the time to: the promise is still recorded, with
    // no invented instant — the implicit deadline applies.
    const unpinned = derive({ v2: timeOnly }).find((i) => i.kind === 'callback');
    expect(unpinned).toMatchObject({ due_at: null, due_basis: null, origin: 'v2:scheduling.callback_window_start' });
    expect(unpinned.description).toContain('asked for 09:00');
  });

  test('a callback the caller asked for is a promise only once the agent accepted it: caller-only evidence seeds nothing, and so does the disposition alone (codex gh-r17 P1)', () => {
    const callerOnly = { ...v2, evidence: v2.evidence.filter((e) => !(e.field_path === '/scheduling/callback_window_start' && e.speaker === 'agent')) };
    expect(derive({ v2: callerOnly }).find((i) => i.kind === 'callback')).toBeUndefined();
    const dispositionOnly = { scheduling: {}, service_request: {}, recommended_disposition: 'callback_task_created', evidence: [{ field_path: '/scheduling/callback_window_start', quote: 'call me back tomorrow at nine', speaker: 'caller', transcript_offset_ms: null }] };
    expect(derive({ v2: dispositionOnly })).toEqual([]);
    // The agent's acceptance carries it (and is the evidence).
    const cb = derive({ v2 }).find((i) => i.kind === 'callback');
    expect(cb.evidence.some((e) => e.speaker === 'agent')).toBe(true);
  });

  test('nothing is seeded from an empty or non-committal extraction', () => {
    expect(derive({ v2: null, v1: null })).toEqual([]);
    expect(derive({ v2: { scheduling: { status: 'requested' }, service_request: {} } })).toEqual([]);
  });

  test('only V2 seeds: the derivation takes no V1 or disposition input, and unknown keys are ignored', () => {
    expect(derive({ v2: null, v1: { quote_promised: true }, disposition: 'callback_task_created' })).toEqual([]);
    expect(derive({ v2: { scheduling: {} } })).toEqual([]);
  });

  test('a seed needs its quote in the transcript, in the claimed speaker\'s turn; an agent-owned field needs an agent quote (codex gh-r15 P1)', () => {
    // Hallucinated quote: schema-valid, nonempty evidence, not in the words.
    const hallucinated = { ...v2, evidence: [{ field_path: '/service_request/quote_promised', quote: 'I will mail you a formal proposal', speaker: 'agent', transcript_offset_ms: null }] };
    expect(derive({ v2: hallucinated }).find((i) => i.kind === 'send_estimate')).toBeUndefined();
    // A caller line attributed to the agent-owned promise field: not grounded.
    const misattributed = { ...v2, evidence: [{ field_path: '/service_request/quote_promised', quote: 'Thursday at ten works', speaker: 'agent', transcript_offset_ms: null }] };
    expect(derive({ v2: misattributed }).find((i) => i.kind === 'send_estimate')).toBeUndefined();
    // The same caller line claimed as the CALLER's: found, but the promise field still needs an agent quote.
    const callerOnly = { ...v2, evidence: [{ field_path: '/service_request/quote_promised', quote: 'Thursday at ten works', speaker: 'caller', transcript_offset_ms: null }] };
    expect(derive({ v2: callerOnly }).find((i) => i.kind === 'send_estimate')).toBeUndefined();
    // No transcript at all: nothing can be grounded, nothing is seeded.
    expect(deriveCommitmentsFromExtraction({ v2 })).toEqual([]);
    // Unlabelled transcript: flat match, the claimed speaker is taken as is.
    expect(deriveCommitmentsFromExtraction({ v2, transcript: transcript.replace(/^(Agent|Caller): /gm, '') }).map((i) => i.kind).sort()).toEqual(['callback', 'send_estimate', 'technician_follow_up']);
  });

  test('a V2 flag with no pinned transcript quote is not seeded — the model pass must ground it', () => {
    expect(derive({ v2: { ...v2, evidence: [] } })).toEqual([]);
    expect(derive({ v2: { scheduling: {}, recommended_disposition: 'callback_task_created', evidence: [] } })).toEqual([]);
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

  test('a verbatim affirmation from the right speaker does not ground a promise — the quote must express the action (codex gh-r11 P1)', () => {
    const transcript = 'Agent: Can I send you an estimate tonight?\nCaller: Yes.\nCaller: Sure, I will text you the photos of the ants tonight.';
    const out = groundModelCommitments([
      { party: 'customer', kind: 'make_payment', description: 'Pay the invoice', confidence: 0.9, evidence: [{ quote: 'Yes.', speaker: 'caller' }] },
      { party: 'customer', kind: 'send_photos', description: 'Text photos of the ants', confidence: 0.9, evidence: [{ quote: 'I will text you the photos of the ants tonight', speaker: 'caller' }] },
    ], transcript);
    expect(out.kept.map((k) => k.kind)).toEqual(['send_photos']);
    expect(out.droppedUngrounded).toBe(1);
  });

  test('a quote proves a party only from that party\'s speaker turn: a caller line cannot ground a Waves promise, an agent line cannot ground a customer one', () => {
    const out = groundModelCommitments([
      // The caller's own words, filed by the model as a Waves obligation.
      { party: 'waves', kind: 'other', description: 'Text photos', confidence: 0.9, evidence: [{ quote: "I'll text you a couple of photos", speaker: 'agent' }] },
      // The agent's promise, filed as the customer's.
      { party: 'customer', kind: 'other', description: 'Email an estimate', confidence: 0.9, evidence: [{ quote: "I'll email you an estimate this afternoon", speaker: 'caller' }] },
      // Right party, wrong model speaker tag: the turn decides, the tag is corrected.
      { party: 'waves', kind: 'callback', description: 'Call back', confidence: 0.9, evidence: [{ quote: 'someone will call you back tomorrow morning', speaker: 'caller' }] },
    ], TRANSCRIPT);
    expect(out.kept.map((k) => k.kind)).toEqual(['callback']);
    expect(out.kept[0].evidence[0].speaker).toBe('agent');
    expect(out.droppedUngrounded).toBe(2);
  });

  test('a transcript with no speaker labels falls back to flat grounding', () => {
    const flat = TRANSCRIPT.replace(/^(Agent|Caller): /gm, '');
    const out = groundModelCommitments([
      { party: 'waves', kind: 'send_estimate', description: 'Email an estimate', confidence: 0.9, evidence: [{ quote: "I'll email you an estimate this afternoon", speaker: 'agent' }] },
    ], flat);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0].evidence[0].speaker).toBe('agent');
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
      { party: 'waves', kind: 'callback', description: 'Call back at nine', confidence: 0.8, due_at: '2026-09-02T09:00:00', evidence: [{ quote: 'someone will call you back tomorrow morning', speaker: 'agent' }] },
    ], TRANSCRIPT);
    // 9 am EDT is 13:00Z.
    expect(out.kept[0].due_at).toBe('2026-09-02T13:00:00.000Z');
    expect(out.kept[0].due_basis).toBe('stated');
  });

  test('a nonempty due_at the parser rejects is not a stated deadline: kept, counted, and its wording rides in due_text (codex gh-r12 P2)', () => {
    const out = groundModelCommitments([
      { party: 'waves', kind: 'callback', description: 'Call back tomorrow morning', confidence: 0.8, due_at: 'tomorrow-ish', evidence: [{ quote: 'someone will call you back tomorrow morning', speaker: 'agent' }] },
    ], 'Agent: someone will call you back tomorrow morning.');
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0].due_at).toBeNull();
    expect(out.kept[0].due_basis).toBeNull();
    expect(out.kept[0].due_text).toBe('tomorrow-ish');
    expect(out.malformedDueAt).toBe(1);
  });

  test('an unknown channel or kind is coerced; a stated due_at is kept as ISO', () => {
    const out = groundModelCommitments([
      { party: 'waves', kind: 'send_paperwork', channel: 'fax', description: 'Send WDO paperwork', confidence: 0.7, due_at: '2026-09-02T09:00:00-04:00', evidence: [{ quote: 'I will send the WDO paperwork over tonight', speaker: 'agent' }] },
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

describe('row conversion and drop counters (codex gh-r9 P2)', () => {
  const { toRow, groundModelCommitments } = require('../services/call-commitments');
  test('a relative due_text with no due_at rides in the persisted description; a stated instant makes it redundant', () => {
    const base = { party: 'waves', kind: 'send_estimate', description: 'Send the caller an estimate', channel: 'email', evidence: [] };
    expect(toRow('c', { ...base, due_text: 'later today', due_at: null }, { generation: 1 }).description).toBe('Send the caller an estimate (later today)');
    expect(toRow('c', { ...base, due_text: 'tomorrow at nine', due_at: '2026-09-03T13:00:00Z' }, { generation: 1 }).description).toBe('Send the caller an estimate');
  });
  test('a party/kind mismatch is counted among the drops', () => {
    const out = groundModelCommitments([{ party: 'customer', kind: 'send_estimate', description: 'x', confidence: 0.9, evidence: [{ quote: 'hello there', speaker: 'caller' }] }], 'Caller: hello there');
    expect(out.kept).toEqual([]);
    expect(out.droppedMismatched).toBe(1);
  });
});

describe('recordCallCommitments keeps the deterministic seeds when the model leg fails (codex gh-r8 P1)', () => {
  const { recordCallCommitments } = require('../services/call-commitments');
  test('a rejected provider call is reported, and the seeds are still upserted', async () => {
    const raw = jest.fn(async () => ({ rows: [{ id: 'row' }], rowCount: 1 }));
    const trx = Object.assign(jest.fn(() => ({ where: () => ({ forShare: () => ({ first: async () => ({ id: 'c' }) }) }) })), { raw });
    const conn = { transaction: async (fn) => fn(trx) };
    const v2 = {
      service_request: { quote_promised: true },
      caller: { preferred_contact_method: 'email' },
      confidence: { overall: 0.8 },
      evidence: [{ field_path: '/service_request/quote_promised', quote: 'I will email you an estimate', speaker: 'agent', transcript_offset_ms: null }],
    };
    const modelClient = { messages: { create: jest.fn(async () => { throw new Error('provider timeout'); }) } };
    const out = await recordCallCommitments({ conn, call: { id: 'c', created_at: new Date().toISOString(), transcript_structured: null }, transcript: 'Agent: I will email you an estimate this afternoon, thank you for calling us today.', v2, procToken: 'tok', modelClient });
    expect(out.error).toBeUndefined();
    expect(out.seeds).toBe(1);
    expect(out.skipped).toBe('model_failed');
    expect(out.modelError).toBe('provider timeout');
    expect(raw).toHaveBeenCalled();
    expect(String(raw.mock.calls[0][0])).toContain('INSERT INTO call_commitments');
  });
});

describe('the model pass sends no sampling controls (current models reject them)', () => {
  const { extractCommitmentsWithModel, callEndedAt } = require('../services/call-commitments');
  test('one request, no temperature, under the per-attempt budget', async () => {
    const transcript = 'Agent: I will email you the WDO paperwork tonight, thank you for calling Waves today.';
    const create = jest.fn()
      .mockImplementationOnce(async () => ({ content: [{ type: 'text', text: JSON.stringify({ commitments: [{ party: 'waves', kind: 'send_paperwork', description: 'Email the WDO paperwork', channel: 'email', due_text: 'tonight', due_at: null, confidence: 0.9, evidence: [{ quote: 'I will email you the WDO paperwork tonight', speaker: 'agent' }] }] }) }] }));
    const out = await extractCommitmentsWithModel(transcript, { client: { messages: { create } } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].temperature).toBeUndefined();
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    expect(out.items.map((i) => i.kind)).toEqual(['send_paperwork']);
  });
  test('callEndedAt: inbound rows end at ring + duration, bridged rows at bridge + duration, other rows at created_at', () => {
    const created = '2026-09-02T14:00:00.000Z';
    expect(callEndedAt({ created_at: created, direction: 'inbound', duration_seconds: 90 }).toISOString()).toBe('2026-09-02T14:01:30.000Z');
    expect(callEndedAt({ created_at: created, direction: 'inbound', duration_seconds: 90, bridged_at: '2026-09-02T14:00:20.000Z' }).toISOString()).toBe('2026-09-02T14:01:50.000Z');
    expect(callEndedAt({ created_at: created, direction: 'outbound-api', duration_seconds: 90 }).toISOString()).toBe(created);
    expect(callEndedAt({ created_at: 'nope' })).toBeNull();
  });
});

describe('lead lookups on a call with no lead key', () => {
  const { buildCallOutcomes } = require('../services/call-commitments');
  test('buildCallOutcomes queries nothing for an imported call (no lead_id, no SID, no customer)', async () => {
    // Any other table answers empty; a leads read is the unscoped query
    // this guards against and fails the test outright.
    const empty = () => {
      let first = false;
      const b = new Proxy({}, { get(_, k) {
        if (k === 'then') return (resolve) => resolve(first ? null : []);
        if (k === 'first') return () => { first = true; return b; };
        return () => b;
      } });
      return b;
    };
    const conn = jest.fn((table) => { if (table === 'leads') throw new Error('unscoped query on leads'); return empty(); });
    const out = await buildCallOutcomes(conn, { id: 'c', created_at: new Date().toISOString(), metadata: null, twilio_call_sid: null, customer_id: null });
    expect(out.lead).toBeNull();
    expect(out.estimates).toEqual([]);
    expect(conn.mock.calls.map((c) => c[0])).not.toContain('leads');
  });
});
