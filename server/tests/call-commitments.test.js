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
  test('one quoted link promise for two current visits has two stable keys', () => {
    const common = { party: 'waves', kind: 'send_reschedule_link', description: 'Text both links',
      evidence: [{ quote: 'I will text you both reschedule links', speaker: 'agent' }] };
    const first = { ...common, subject: { visit_date: '2026-09-20', service: 'Pest Service', address: '123 Main St',
      date_claims: [{ binding: 'appointment', month: 9, day: 20, quote: 'September 20' }, { binding: 'delivery', weekday: 1, quote: 'Monday' }] } };
    const second = { ...common, subject: { visit_date: '2026-09-27', service: 'Pest Service', address: '123 Main St',
      date_claims: [{ binding: 'appointment', month: 9, day: 27, quote: 'September 27' }] } };
    expect(commitmentKey(first)).not.toBe(commitmentKey(second));
    expect(commitmentKey(first)).toMatch(/^waves:send_reschedule_link:q[0-9a-f]{12}:s[0-9a-f]{12}$/);
    expect(commitmentKey({ ...first, description: 'Email two links', subject: { ...first.subject, service: 'pest service', address: '123 MAIN ST',
      date_claims: [...first.subject.date_claims].reverse().concat(first.subject.date_claims[0], { binding: 'requested', month: 10, day: 1, quote: 'October 1' }) } })).toBe(commitmentKey(first));
  });
  test('a richer claim for the same full visit date does not mint a new key', () => {
    const base = { party: 'waves', kind: 'send_reschedule_link', description: 'Send link',
      evidence: [{ quote: 'I will send your reschedule link', speaker: 'agent' }] };
    const partial = { ...base, subject: { visit_date: '2030-09-20', service: 'Pest Service', address: '123 Main St',
      date_claims: [{ binding: 'appointment', month: 9, day: 20, quote: 'September 20' }] } };
    const full = { ...base, subject: { ...partial.subject, date_claims: [
      { binding: 'appointment', year: 2030, month: 9, day: 20, quote: 'September 20, 2030' },
    ] } };
    expect(commitmentKey(full)).toBe(commitmentKey(partial));
    expect(commitmentKey({ ...full, subject: { ...full.subject, visit_date: null } })).toBe(commitmentKey(partial));
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
    const migration = require('../models/migrations/20260909000092_reschedule_link_promises');
    expect(new Set(migration.COMMITMENT_KINDS)).toEqual(new Set(COMMITMENT_KINDS));
  });
  test('the prompt and schema request a complete date-claim list and delivery timing type', () => {
    const prompt = buildCommitmentsPrompt({ transcript: 'Agent: I will send the link tomorrow.', callStartedAt: '2026-09-01T14:00:00Z' });
    expect(prompt).toMatch(/date_claims is a COMPLETE list/);
    expect(prompt).toMatch(/deadline.*ONLY when the agent explicitly promises/);
    const props = MODEL_OUTPUT_SCHEMA.properties.commitments.items.properties;
    expect(props.due_type.enum).toEqual(['floor', 'deadline', null]);
    expect(props.subject.required || []).not.toContain('date_claims');
    expect(props.subject.additionalProperties).toBe(false);
    expect(props.subject.properties.identity_unresolved).toBeUndefined();
    expect(props.subject.properties.identity_unresolved_reason).toBeUndefined();
    expect(props.subject.properties.identity_claims).toBeUndefined();
    expect(props.subject.properties.date_claims.items.properties.binding.enum).toEqual(['appointment', 'requested', 'delivery', 'unresolved']);
  });
});

describe('structured reschedule-link dates and delivery timing', () => {
  const transcript = [
    'Caller: My September 20 appointment needs to move to Friday.',
    'Agent: I will text the reschedule link tomorrow at nine, before I call on Friday.',
  ].join('\n');
  const base = {
    party: 'waves', kind: 'send_reschedule_link', description: 'Text the reschedule link', confidence: 0.9,
    evidence: [{ quote: 'I will text the reschedule link tomorrow at nine', speaker: 'agent' }],
    due_at: '2026-09-14T09:00:00-04:00', due_text: 'tomorrow at nine', due_type: 'floor',
  };
  test('persists proven appointment and ET-relative delivery components', () => {
    const spoken = 'Caller: My September 20 appointment.\nAgent: I will text the reschedule link tomorrow at 9am.';
    const claims = [
      { binding: 'appointment', quote: 'September 20', month: 9, day: 20 },
      { binding: 'delivery', quote: 'tomorrow', year: 2026, month: 9, day: 14 },
    ];
    const out = groundModelCommitments([{ ...base, evidence: [{ quote: 'I will text the reschedule link tomorrow at 9am', speaker: 'agent' }], subject: { date_claims: claims } }], spoken, new Date('2026-09-14T02:00:00Z'));
    expect(out.kept[0].subject.date_claims).toEqual(claims);
    expect(groundModelCommitments([{ ...base, evidence: [{ quote: 'I will text the reschedule link tomorrow at 9am', speaker: 'agent' }], subject: { date_claims: [] } }], spoken).kept[0].subject.date_claims).toBeNull();
    const generic = 'Agent: I will text you a reschedule link for that appointment.';
    const simple = { ...base, evidence: [{ quote: generic.slice(7), speaker: 'agent' }], subject: { date_claims: [] } };
    expect(groundModelCommitments([{ ...simple, due_at: null, due_type: null }], generic).kept[0].subject.date_claims).toEqual([]);
    expect(groundModelCommitments([simple], generic).kept[0].subject.date_claims).toBeNull();
    const appointmentOnly = `Caller: My September 20 appointment.\n${generic}`;
    const appointmentClaims = [{ binding: 'appointment', quote: 'September 20', month: 9, day: 20 }];
    expect(groundModelCommitments([{ ...simple, due_at: null, due_type: null,
      subject: { date_claims: appointmentClaims } }], appointmentOnly).kept[0].subject.date_claims).toEqual(appointmentClaims);
    expect(groundModelCommitments([{ ...simple, subject: { date_claims: appointmentClaims } }], appointmentOnly).kept[0].subject.date_claims).toBeNull();
  });
  test.each([
    { due_at: '2026-09-14T09:00:00-04:00', due_type: 'deadline' },
    { due_at: '2026-09-13T09:00:00-04:00', due_type: 'floor' },
    { due_at: null, due_type: null },
  ])('extraction parks a delivery date with unproved timing: %j', timing => {
    const quote = 'I will text the reschedule link tomorrow morning';
    const item = { ...base, ...timing, evidence: [{ quote, speaker: 'agent' }], subject: { date_claims: [
      { binding: 'delivery', quote: 'tomorrow morning', year: 2026, month: 9, day: 14 },
    ] } };
    expect(groundModelCommitments([item], `Agent: ${quote}.`, new Date('2026-09-14T02:00:00Z')).kept[0].subject.date_claims).toBeNull();
  });
  test('a bare delivery day cannot ground a model-invented late clock', () => {
    const quote = 'I will text the reschedule link tomorrow';
    const item = { ...base, due_at: '2026-09-14T23:59:00-04:00', due_text: 'tomorrow',
      evidence: [{ quote, speaker: 'agent' }], subject: { date_claims: [
        { binding: 'delivery', quote: 'tomorrow', year: 2026, month: 9, day: 14 },
      ] } };
    const out = groundModelCommitments([item], `Agent: ${quote}.`, new Date('2026-09-14T02:00:00Z'));
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0].subject.date_claims).toBeNull();
  });
  test('a newly extracted by-date needs an explicit deadline type', () => {
    const quote = 'I will text the reschedule link by tomorrow at 9am';
    const claims = [{ binding: 'delivery', quote: 'tomorrow', year: 2026, month: 9, day: 14 }];
    const make = (dueType) => ({ ...base, due_type: dueType, evidence: [{ quote, speaker: 'agent' }],
      subject: { date_claims: claims } });
    const spoken = `Agent: ${quote}.`;
    const reference = new Date('2026-09-14T02:00:00Z');
    for (const dueType of [undefined, null, 'floor']) {
      expect(groundModelCommitments([make(dueType)], spoken, reference).kept[0].subject.date_claims).toBeNull();
    }
    expect(groundModelCommitments([make('deadline')], spoken, reference).kept[0].subject.date_claims).toEqual(claims);
  });
  test('an unresolved callback date invalidates the complete list while preserving the promise', () => {
    const item = { ...base, subject: { date_claims: [
      { binding: 'appointment', quote: 'My September 20 appointment needs to move to Friday', month: 9, day: 20 },
      { binding: 'requested', quote: 'move to Friday', weekday: 5 },
      { binding: 'delivery', quote: 'I will text the reschedule link tomorrow at nine', year: 2026, month: 9, day: 14 },
      { binding: 'unresolved', quote: 'before I call on Friday', weekday: 5 },
    ] } };
    const out = groundModelCommitments([item], transcript);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0].subject.date_claims).toBeNull();
    expect(out.kept[0]).toMatchObject({ due_type: 'floor', due_basis: 'stated', due_at: '2026-09-14T13:00:00.000Z' });
    const row = require('../services/call-commitments').toRow('call', out.kept[0], { generation: 4 });
    expect(row.due_type).toBe('floor');
    expect(JSON.parse(row.subject).date_claims).toBeNull();
  });
  test('an explicit empty list cannot hide dates spoken in the transcript', () => {
    const empty = groundModelCommitments([{ ...base, subject: { date_claims: [] } }], transcript).kept[0];
    const missing = groundModelCommitments([{ ...base, subject: { visit_date: '2026-09-20' } }], transcript).kept[0];
    const ungrounded = groundModelCommitments([{ ...base, subject: { date_claims: [
      { binding: 'appointment', quote: 'my October 21 appointment', month: 10, day: 21 },
    ] } }], transcript).kept[0];
    expect(empty.subject.date_claims).toBeNull();
    expect(missing.subject.date_claims).toBeNull();
    expect(ungrounded.subject.date_claims).toBeNull();
  });
  test('unproved model visit fields cannot become identity when date coverage fails', () => {
    const spoken = 'Caller: I am out next Tuesday.\nAgent: I will text you a reschedule link for that appointment.';
    const quote = 'I will text you a reschedule link for that appointment';
    const model = { ...base, evidence: [{ quote, speaker: 'agent' }], subject: {
      visit_date: '2026-09-15', service: 'Pest Service', date_claims: [{ binding: 'appointment', weekday: 2, quote: 'Tuesday' }],
    } };
    const first = groundModelCommitments([model], spoken, new Date('2026-09-14T14:00:00Z')).kept[0];
    const second = groundModelCommitments([{ ...model, subject: { ...model.subject, visit_date: '2026-09-16', service: 'Lawn Service' } }], spoken,
      new Date('2026-09-14T14:00:00Z')).kept[0];
    expect(first.subject).toMatchObject({ date_claims: null, identity_unresolved: true,
      identity_unresolved_reason: 'incomplete_extraction', identity_claims: [] });
    expect(commitmentKey(first)).toBe(commitmentKey(second));
  });
  test('invalid calendar components or fabricated weekdays invalidate the whole list', () => {
    const quote = 'My September 20 appointment needs to move to Friday';
    for (const claim of [
      { binding: 'appointment', quote, month: 13, day: 20 },
      { binding: 'appointment', quote, year: 2026, month: 2, day: 30 },
      { binding: 'appointment', quote, year: 2026, month: 9, day: 20, weekday: 1 },
    ]) {
      const item = groundModelCommitments([{ ...base, subject: { date_claims: [claim] } }], transcript).kept[0];
      expect(item.subject.date_claims).toBeNull();
    }
  });
  test('only a valid explicit deadline survives; missing or invalid due_at has no timing type', () => {
    const deadline = groundModelCommitments([{ ...base, due_type: 'deadline', due_text: 'by tomorrow at nine', subject: { date_claims: [] } }], transcript).kept[0];
    expect(deadline.due_type).toBe('deadline');
    expect(groundModelCommitments([{ ...base, due_type: 'deadline', due_at: 'tomorrow-ish' }], transcript).kept[0].due_type).toBeNull();
    expect(groundModelCommitments([{ ...base, due_type: 'deadline', due_at: null }], transcript).kept[0].due_type).toBeNull();
    expect(groundModelCommitments([{ ...base, due_type: undefined }], transcript).kept[0].due_type).toBeNull();
  });
});

describe('reschedule-link upsert identity across quote-only rows', () => {
  const { upsertCommitments } = require('../services/call-commitments');
  const quote = 'I will text both reschedule links';
  const item = (visitDate) => ({ party: 'waves', kind: 'send_reschedule_link', description: 'Text a reschedule link',
    evidence: [{ quote, speaker: 'agent' }], subject: { visit_date: visitDate, date_claims: [
      { binding: 'appointment', year: 2026, month: 9, day: Number(visitDate.slice(-2)), quote: `the ${visitDate} visit` },
    ] } });
  const write = async (oldSubject, items = [item('2026-09-20'), item('2026-09-27')]) => {
    const oldRows = oldSubject === undefined ? [] : (Array.isArray(oldSubject) ? oldSubject : [
      { commitment_key: commitmentKey({ ...item('2026-09-20'), subject: null }), subject: oldSubject },
    ]);
    const raw = jest.fn(async (sql) => ({ rows: String(sql).includes('INSERT INTO call_commitments') ? [{ id: 'row' }] : [] }));
    const trx = Object.assign(jest.fn((table) => {
      if (table !== 'call_commitments') throw new Error(`unexpected table ${table}`);
      return { where: () => ({ whereRaw: () => ({ orderBy: () => ({ forUpdate: () => ({ select: async () => oldRows }) }) }) }) };
    }), { raw });
    const activation = jest.spyOn(require('../services/reschedule-link-promises'), 'recordLiveActivation').mockResolvedValue();
    try {
      const result = await upsertCommitments({ transaction: async (fn) => fn(trx) }, 'call', items);
      const insertCalls = raw.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO call_commitments'));
      return { result, inserts: insertCalls.map(([, values]) => values), insertSql: insertCalls[0]?.[0] };
    } finally { activation.mockRestore(); }
  };
  test('two visits with one promise quote insert separately and a matching legacy row keeps its key', async () => {
    const fresh = await write(undefined);
    expect(fresh.result.written).toBe(2);
    expect(new Set(fresh.inserts.map((values) => values[1])).size).toBe(2);
    const legacy = await write({ visit_date: '2026-09-20' });
    expect(legacy.result.written).toBe(2);
    expect(legacy.inserts[0][1]).toBe(commitmentKey({ ...item('2026-09-20'), subject: null }));
    expect(legacy.inserts[1][1]).toBe(commitmentKey(item('2026-09-27')));
    expect(JSON.parse(legacy.inserts[1].at(-1)).date_claims).toHaveLength(1);
  });
  test('an unidentifiable legacy row leaves all new obligations visible but parked', async () => {
    const ambiguous = await write(null);
    expect(ambiguous.result.written).toBe(2);
    expect(new Set(ambiguous.inserts.map((values) => values[1])).size).toBe(2);
    for (const values of ambiguous.inserts) expect(JSON.parse(values.at(-1)).date_claims).toBeNull();
    const distinct = await write({ visit_date: '2026-10-04' });
    for (const values of distinct.inserts) expect(JSON.parse(values.at(-1)).date_claims).toHaveLength(1);
  });
  test('a dismissed row keeps its conflict identity when reprocessed with a richer equivalent date claim', async () => {
    const partial = item('2026-09-20');
    partial.subject.date_claims = [{ binding: 'appointment', month: 9, day: 20, quote: 'September 20' }];
    const richer = item('2026-09-20');
    const first = await write(undefined, [partial]);
    const reprocessed = await write(undefined, [richer]);
    expect(reprocessed.inserts[0][1]).toBe(first.inserts[0][1]);
    // The same-key ON CONFLICT path cannot clear a human dismissal or
    // replace its reviewed subject; those fields are guarded in SQL.
    expect(reprocessed.insertSql).toMatch(/subject = CASE WHEN call_commitments\.human_state IS NULL/);
    expect(reprocessed.insertSql).not.toMatch(/status = EXCLUDED\.status/);
  });
  test('adding spoken service and address reuses a dismissed subject-suffixed key', async () => {
    const prior = item('2026-09-20');
    const richer = { ...prior, subject: { ...prior.subject, service: 'Pest Service', address: '123 Main St' } };
    expect(commitmentKey(richer)).not.toBe(commitmentKey(prior));
    const oldRows = [{ commitment_key: commitmentKey(prior), subject: prior.subject, status: 'dismissed', human_state: 'dismissed' }];
    const reprocessed = await write(oldRows, [richer]);
    expect(reprocessed.inserts[0][1]).toBe(oldRows[0].commitment_key);
    expect(reprocessed.insertSql).toMatch(/subject = CASE WHEN call_commitments\.human_state IS NULL/);
    expect(reprocessed.insertSql).not.toMatch(/status = EXCLUDED\.status/);
  });
  test('different partial appointment days do not borrow a dismissed same-service key', async () => {
    const prior = { ...item('2026-09-20'), subject: { service: 'Pest Service',
      date_claims: [{ binding: 'appointment', month: 9, day: 20, quote: 'September 20' }] } };
    const next = { ...prior, subject: { service: 'Pest Service',
      date_claims: [{ binding: 'appointment', month: 9, day: 27, quote: 'September 27' }] } };
    const oldRows = [{ commitment_key: commitmentKey(prior), subject: prior.subject, status: 'dismissed', human_state: 'dismissed' }];
    const result = await write(oldRows, [next]);
    expect(result.inserts[0][1]).toBe(commitmentKey(next));
    expect(result.inserts[0][1]).not.toBe(oldRows[0].commitment_key);
    expect(JSON.parse(result.inserts[0].at(-1)).date_claims).toEqual(next.subject.date_claims);
  });
  test('missing an old partial appointment component parks instead of aliasing', async () => {
    const prior = { ...item('2026-09-20'), subject: { service: 'Pest Service',
      date_claims: [{ binding: 'appointment', month: 9, day: 20, quote: 'September 20' }] } };
    const lessSpecific = { ...prior, subject: { service: 'Pest Service',
      date_claims: [{ binding: 'appointment', month: 9, quote: 'September' }] } };
    const oldRows = [{ commitment_key: commitmentKey(prior), subject: prior.subject, status: 'dismissed', human_state: 'dismissed' }];
    const result = await write(oldRows, [lessSpecific]);
    expect(result.inserts[0][1]).not.toBe(oldRows[0].commitment_key);
    expect(JSON.parse(result.inserts[0].at(-1))).toMatchObject({ date_claims: null, identity_unresolved: true });
  });
  test('an exact existing subject key wins even when another prior row overlaps it', async () => {
    const sparse = item('2026-09-20');
    const richer = { ...sparse, subject: { ...sparse.subject, service: 'Pest Service' } };
    const oldRows = [
      { commitment_key: commitmentKey(sparse), subject: sparse.subject },
      { commitment_key: commitmentKey(richer), subject: richer.subject, status: 'dismissed', human_state: 'dismissed' },
    ];
    const result = await write(oldRows, [richer]);
    expect(result.inserts[0][1]).toBe(commitmentKey(richer));
    expect(JSON.parse(result.inserts[0].at(-1)).date_claims).toHaveLength(1);
  });
  test('one sparse old subject matching two new same-date visits parks both', async () => {
    const prior = item('2026-09-20');
    const pest = { ...prior, subject: { ...prior.subject, service: 'Pest Service' } };
    const lawn = { ...prior, subject: { ...prior.subject, service: 'Lawn Service' } };
    const oldRows = [{ commitment_key: commitmentKey(prior), subject: prior.subject }];
    const result = await write(oldRows, [pest, lawn]);
    expect(result.result.written).toBe(2);
    expect(new Set(result.inserts.map((values) => values[1])).size).toBe(2);
    for (const values of result.inserts) expect(JSON.parse(values.at(-1))).toMatchObject({ date_claims: null, identity_unresolved: true,
      identity_unresolved_reason: 'reconciliation_ambiguity' });
    const secondPassRows = oldRows.concat(result.inserts.map((values) => ({ commitment_key: values[1], subject: JSON.parse(values.at(-1)) })));
    const second = await write(secondPassRows, [pest, lawn]);
    for (const values of second.inserts) expect(JSON.parse(values.at(-1))).toMatchObject({ date_claims: null, identity_unresolved: true,
      identity_unresolved_reason: 'reconciliation_ambiguity' });
  });
  test('an internally parked alias remains parked when a later extraction adds optional detail', async () => {
    const prior = item('2026-09-20');
    const enriched = { ...prior, subject: { ...prior.subject, service: 'Pest Service' } };
    const oldRows = [{ commitment_key: commitmentKey(prior), subject: { ...prior.subject, date_claims: null, identity_unresolved: true } }];
    const second = await write(oldRows, [enriched]);
    expect(second.inserts[0][1]).toBe(oldRows[0].commitment_key);
    expect(JSON.parse(second.inserts[0].at(-1))).toMatchObject({ date_claims: null, identity_unresolved: true,
      identity_unresolved_reason: 'reconciliation_ambiguity' });
  });
  test('a generic missing claim list is not an identity marker and can be completed on reprocess', async () => {
    const prior = item('2026-09-20');
    const oldRows = [{ commitment_key: commitmentKey(prior), subject: { ...prior.subject, date_claims: null } }];
    const second = await write(oldRows, [prior]);
    expect(JSON.parse(second.inserts[0].at(-1)).date_claims).toHaveLength(1);
    expect(JSON.parse(second.inserts[0].at(-1)).identity_unresolved).toBeUndefined();
  });
  test('a normalized date-free extraction with missing claims recovers when a later pass proves the explicit empty list', async () => {
    const transcript = 'Agent: I will text you a reschedule link for that appointment.';
    const promise = { party: 'waves', kind: 'send_reschedule_link', description: 'Text the reschedule link', confidence: 0.9,
      evidence: [{ quote: 'I will text you a reschedule link for that appointment', speaker: 'agent' }], due_at: null, due_type: null };
    const missing = groundModelCommitments([{ ...promise, subject: null }], transcript).kept[0];
    const corrected = groundModelCommitments([{ ...promise, subject: { date_claims: [] } }], transcript).kept[0];
    expect(missing.subject).toMatchObject({ date_claims: null, identity_unresolved: true,
      identity_unresolved_reason: 'incomplete_extraction' });
    expect(corrected.subject).toMatchObject({ date_claims: [] });
    const first = await write(undefined, [missing]);
    const stored = [{ commitment_key: first.inserts[0][1], subject: JSON.parse(first.inserts[0].at(-1)) }];
    const second = await write(stored, [corrected]);
    const recovered = JSON.parse(second.inserts[0].at(-1));
    expect(second.inserts[0][1]).toBe(stored[0].commitment_key);
    expect(recovered.date_claims).toEqual([]);
    expect(recovered.identity_unresolved).toBeUndefined();
    expect(recovered.identity_unresolved_reason).toBeUndefined();
  });
  test('two independently proved partial visits keep distinct parked identities across generations', async () => {
    const transcript = [
      'Caller: My Tuesday appointment.',
      'Caller: My Wednesday appointment.',
      'Agent: I will text you a reschedule link for that appointment.',
    ].join('\n');
    const promise = { party: 'waves', kind: 'send_reschedule_link', description: 'Text a reschedule link', confidence: 0.9,
      evidence: [{ quote: 'I will text you a reschedule link for that appointment', speaker: 'agent' }], due_at: null, due_type: null };
    const modelItems = [2, 3].map((weekday) => ({ ...promise, subject: { date_claims: [
      { binding: 'appointment', weekday, quote: weekday === 2 ? 'Tuesday' : 'Wednesday' },
    ] } }));
    const grounded = groundModelCommitments(modelItems, transcript, new Date('2026-09-14T14:00:00Z')).kept;
    expect(grounded).toHaveLength(2);
    expect(new Set(grounded.map(commitmentKey)).size).toBe(2);
    for (const entry of grounded) {
      expect(entry.subject).toMatchObject({ date_claims: null, identity_unresolved: true,
        identity_unresolved_reason: 'incomplete_extraction' });
      expect(entry.subject.identity_claims).toHaveLength(1);
    }
    const first = await write(undefined, grounded);
    expect(first.result.written).toBe(2);
    const stored = first.inserts.map((values) => ({ commitment_key: values[1], subject: JSON.parse(values.at(-1)) }));
    const second = await write(stored, grounded);
    expect(second.result.written).toBe(2);
    expect(second.inserts.map((values) => values[1])).toEqual(first.inserts.map((values) => values[1]));
    for (const values of second.inserts) expect(JSON.parse(values.at(-1))).toMatchObject({ date_claims: null, identity_unresolved: true });
    const dismissed = [{ ...stored[0], status: 'dismissed', human_state: 'dismissed' }];
    const terminal = await write(dismissed, grounded);
    expect(terminal.inserts[0][1]).toBe(dismissed[0].commitment_key);
    expect(terminal.inserts[1][1]).not.toBe(dismissed[0].commitment_key);
    expect(terminal.insertSql).toMatch(/subject = CASE WHEN call_commitments\.human_state IS NULL/);
    expect(terminal.insertSql).not.toMatch(/status = EXCLUDED\.status/);
  });
  test('a proved partial identity stays parked when a later full-date extraction aliases its key', async () => {
    const promise = { party: 'waves', kind: 'send_reschedule_link', description: 'Text the link',
      evidence: [{ quote: 'I will text your reschedule link', speaker: 'agent' }] };
    const priorSubject = { date_claims: null, identity_unresolved: true,
      identity_claims: [{ binding: 'appointment', weekday: 2, quote: 'Tuesday' }] };
    const newer = { ...promise, subject: { visit_date: '2026-09-15',
      date_claims: [{ binding: 'appointment', year: 2026, month: 9, day: 15, weekday: 2, quote: 'Tuesday September 15' }] } };
    const oldRows = [{ commitment_key: commitmentKey({ ...promise, subject: priorSubject }), subject: priorSubject }];
    const result = await write(oldRows, [newer]);
    expect(result.inserts[0][1]).toBe(oldRows[0].commitment_key);
    expect(JSON.parse(result.inserts[0].at(-1))).toMatchObject({ date_claims: null, identity_unresolved: true,
      identity_claims: priorSubject.identity_claims });
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
    // upsertCommitments now takes the shared per-call advisory lock (its own
    // trx.raw call) before the ownership-fence read, ahead of the INSERT —
    // see call-commitments.js's own doc comment and reschedule-link-promises.js's
    // module comment for why (codex #4293 P1, lock-order inversion fix).
    // The INSERT is no longer necessarily the first raw call; find it
    // instead of assuming its position.
    expect(raw.mock.calls.some((call) => String(call[0]).includes('INSERT INTO call_commitments'))).toBe(true);
    const [sql, bindings] = raw.mock.calls.find((call) => String(call[0]).includes('INSERT INTO call_commitments'));
    expect(sql).toContain('due_type');
    expect(sql.match(/\?/g)).toHaveLength(bindings.length);
  });
});

describe('recordCallCommitments fixes the promised-link activation boundary atomically with the commitment write (codex #4293 P2 r4)', () => {
  const { recordCallCommitments } = require('../services/call-commitments');
  const { gates } = require('../config/feature-gates');

  // upsertCommitments now calls recordLiveActivation FIRST INSIDE its own
  // write transaction (not ahead of it), so the boundary write and the
  // commitment row share one trx — the mock has to answer both call_log
  // (the ownership fence) and system_settings (persistedActivationBoundary's
  // read, insert-if-absent, re-read) on the SAME object conn.transaction
  // hands back, exactly like a real knex transaction would.
  function fakeConn(systemSettings) {
    // rows[0].now backs persistedActivationBoundary's `await conn.raw('SELECT
    // now() ...')` — the transaction-clock read this boundary now persists
    // instead of a JS `new Date()` (codex #4293 P1).
    const raw = jest.fn(async () => ({ rows: [{ id: 'row', now: new Date() }], rowCount: 1 }));
    function trx(table) {
      if (table === 'call_log') return { where: () => ({ forShare: () => ({ first: async () => ({ id: 'c' }) }) }) };
      if (table !== 'system_settings') throw new Error(`unexpected table: ${table}`);
      let key;
      const b = {
        where: (eq) => { key = eq.key; return b; },
        first: async () => (systemSettings[key] !== undefined ? { value: systemSettings[key] } : null),
        insert: (data) => ({ onConflict: () => ({ ignore: async () => {
          if (!(data.key in systemSettings)) systemSettings[data.key] = data.value;
          return 1;
        } }) }),
      };
      return b;
    }
    trx.raw = raw;
    const conn = Object.assign(jest.fn(trx), { transaction: async (fn) => fn(trx) });
    return conn;
  }

  // Simulates a transient system_settings failure: the boundary read/write
  // throws once, then behaves normally — used to prove the commitment row
  // never commits un-boundaried (codex #4293 P2 r4).
  function fakeConnWithTransientFailure(systemSettings) {
    const raw = jest.fn(async () => ({ rows: [{ id: 'row', now: new Date() }], rowCount: 1 }));
    let calls = 0;
    function trx(table) {
      if (table === 'call_log') return { where: () => ({ forShare: () => ({ first: async () => ({ id: 'c' }) }) }) };
      if (table !== 'system_settings') throw new Error(`unexpected table: ${table}`);
      calls += 1;
      if (calls === 1) throw new Error('connection terminated unexpectedly');
      let key;
      const b = {
        where: (eq) => { key = eq.key; return b; },
        first: async () => (systemSettings[key] !== undefined ? { value: systemSettings[key] } : null),
        insert: (data) => ({ onConflict: () => ({ ignore: async () => {
          if (!(data.key in systemSettings)) systemSettings[data.key] = data.value;
          return 1;
        } }) }),
      };
      return b;
    }
    trx.raw = raw;
    const conn = Object.assign(jest.fn(trx), { transaction: async (fn) => fn(trx) });
    return conn;
  }

  const v2 = {
    service_request: { quote_promised: true },
    caller: { preferred_contact_method: 'email' },
    confidence: { overall: 0.8 },
    evidence: [{ field_path: '/service_request/quote_promised', quote: 'I will email you an estimate', speaker: 'agent', transcript_offset_ms: null }],
  };
  const modelClient = { messages: { create: jest.fn(async () => { throw new Error('provider timeout'); }) } };
  const run = (conn) => recordCallCommitments({ conn, call: { id: 'c', created_at: new Date().toISOString(), transcript_structured: null },
    transcript: 'Agent: I will email you an estimate this afternoon, thank you for calling us today.', v2, procToken: 'tok', modelClient });

  test('gate live, nothing persisted: the boundary is on record by the time this write returns, not deferred to a later sweep', async () => {
    const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorEnv = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
    const priorCommitments = gates.callCommitments;
    try {
      gates.callCommitments = true;
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
      delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
      const systemSettings = {};
      const out = await run(fakeConn(systemSettings));
      expect(out.error).toBeUndefined();
      expect(systemSettings.reschedule_link_promise_activated_at).toBeDefined();
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
      if (priorEnv === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT; else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = priorEnv;
      gates.callCommitments = priorCommitments;
    }
  });

  test('gate off (or shadow): the write proceeds exactly as before and system_settings is never touched', async () => {
    const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorCommitments = gates.callCommitments;
    try {
      delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE;
      gates.callCommitments = true;
      const systemSettings = {};
      const out = await run(fakeConn(systemSettings));
      expect(out.error).toBeUndefined();
      expect(out.seeds).toBe(1);
      expect(systemSettings.reschedule_link_promise_activated_at).toBeUndefined();
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
      gates.callCommitments = priorCommitments;
    }
  });

  test('gate live, a transient system_settings failure: the commitment row does not commit un-boundaried', async () => {
    // Reproduces the P2 finding directly: with the boundary write and the
    // commitment upsert sharing one transaction, a transient failure on the
    // FIRST must roll the SECOND back too — never leave the commitment
    // committed while the boundary is still unset (which a later healthy
    // sweep would then fix at a LATER instant and cancel this legitimate
    // live promise as pre_activation, silently).
    const priorGate = process.env.GATE_RESCHEDULE_LINK_ON_PROMISE, priorEnv = process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
    const priorCommitments = gates.callCommitments;
    try {
      gates.callCommitments = true;
      process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = 'true';
      delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT;
      const systemSettings = {};
      const out = await run(fakeConnWithTransientFailure(systemSettings));
      // The failure surfaces — it is not swallowed — and nothing was written.
      expect(out.error).toBeDefined();
      expect(out.written).toBe(0);
      expect(systemSettings.reschedule_link_promise_activated_at).toBeUndefined();

      // A retry (the transient condition has now cleared) writes both the
      // boundary and the commitment together.
      const retried = await run(fakeConn(systemSettings));
      expect(retried.error).toBeUndefined();
      expect(systemSettings.reschedule_link_promise_activated_at).toBeDefined();
    } finally {
      if (priorGate === undefined) delete process.env.GATE_RESCHEDULE_LINK_ON_PROMISE; else process.env.GATE_RESCHEDULE_LINK_ON_PROMISE = priorGate;
      if (priorEnv === undefined) delete process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT; else process.env.RESCHEDULE_LINK_PROMISE_ACTIVATED_AT = priorEnv;
      gates.callCommitments = priorCommitments;
    }
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
    expect(out.items[0].due_type).toBeNull();
  });
  test('callEndedAt: inbound rows end at ring + duration, bridged rows at bridge + duration, other rows at created_at', () => {
    const created = '2026-09-02T14:00:00.000Z';
    expect(callEndedAt({ created_at: created, direction: 'inbound', duration_seconds: 90 }).toISOString()).toBe('2026-09-02T14:01:30.000Z');
    expect(callEndedAt({ created_at: created, direction: 'inbound', duration_seconds: 90, bridged_at: '2026-09-02T14:00:20.000Z' }).toISOString()).toBe('2026-09-02T14:01:50.000Z');
    expect(callEndedAt({ created_at: created, direction: 'outbound-api', duration_seconds: 90 }).toISOString()).toBe(created);
    expect(callEndedAt({ created_at: 'nope' })).toBeNull();
  });
});

describe('model vocabulary slips are normalized before schema validation (audit 2026-09-23)', () => {
  const { extractCommitmentsWithModel, normalizeChannel, normalizeKind, normalizeModelOutput, buildCommitmentsPrompt } = require('../services/call-commitments');
  const transcript = 'Agent: I will call you back tomorrow morning with the price, thank you for calling Waves today.';
  const reply = (commitments) => ({ content: [{ type: 'text', text: JSON.stringify({ commitments }) }] });
  const item = (extra) => ({ party: 'waves', kind: 'callback', description: 'Call back with the price', channel: 'call', due_text: 'tomorrow morning', due_at: null, confidence: 0.9, evidence: [{ quote: 'I will call you back tomorrow morning with the price', speaker: 'agent' }], ...extra });

  test('channel "phone" (the production failure) is coerced to "call" and the promise survives', async () => {
    const create = jest.fn(async () => reply([item({ channel: 'phone' })]));
    const out = await extractCommitmentsWithModel(transcript, { client: { messages: { create } } });
    expect(out.skipped).toBeUndefined();
    expect(out.items.map((i) => [i.kind, i.channel])).toEqual([['callback', 'call']]);
  });
  test('an unlisted channel word fails soft to "unknown"; an unlisted kind fails soft to "other"', async () => {
    const create = jest.fn(async () => reply([item({ channel: 'carrier pigeon', kind: 'ring_back' })]));
    const out = await extractCommitmentsWithModel(transcript, { client: { messages: { create } } });
    expect(out.skipped).toBeUndefined();
    expect(out.items.map((i) => [i.kind, i.channel])).toEqual([['other', 'unknown']]);
  });
  test('a structural problem (no evidence) is still a schema failure, reported with the offending path', async () => {
    const create = jest.fn(async () => reply([item({ evidence: [] })]));
    const out = await extractCommitmentsWithModel(transcript, { client: { messages: { create } } });
    expect(out.skipped).toBe('schema_failed');
    expect(out.items).toEqual([]);
    expect(out.errors.some((e) => e.instancePath === '/commitments/0/evidence')).toBe(true);
  });
  test('normalizers: case, spacing and aliases; null stays null', () => {
    expect(normalizeChannel('Phone')).toBe('call');
    expect(normalizeChannel('text message')).toBe('sms');
    expect(normalizeChannel('In-Person')).toBe('in_person');
    expect(normalizeChannel('EMAIL')).toBe('email');
    expect(normalizeChannel(null)).toBeNull();
    expect(normalizeChannel('')).toBeNull();
    expect(normalizeChannel('fax')).toBe('unknown');
    expect(normalizeKind('Send Estimate')).toBe('send_estimate');
    expect(normalizeKind('nope')).toBe('other');
    expect(normalizeModelOutput({ commitments: 'not-an-array' })).toEqual({ commitments: 'not-an-array' });
    expect(normalizeModelOutput(null)).toBeNull();
  });
  test('non-string channel or kind is left for the validator (codex r1 P2): the item still fails the schema', async () => {
    expect(normalizeChannel(false)).toBe(false);
    expect(normalizeChannel(1)).toBe(1);
    expect(normalizeKind({ a: 1 })).toEqual({ a: 1 });
    const create = jest.fn(async () => reply([item({ channel: false })]));
    const out = await extractCommitmentsWithModel(transcript, { client: { messages: { create } } });
    expect(out.skipped).toBe('schema_failed');
    expect(out.errors.some((e) => e.instancePath === '/commitments/0/channel')).toBe(true);
  });
  test('"call back" resolves by party (codex r1 P2): waves -> callback, customer -> call_back', async () => {
    expect(normalizeKind('call back', 'waves')).toBe('callback');
    expect(normalizeKind('Call-Back', 'customer')).toBe('call_back');
    expect(normalizeKind('callback', 'customer')).toBe('call_back');
    expect(normalizeKind('call_back', null)).toBe('call_back');
    const create = jest.fn(async () => reply([item({ kind: 'call back' })]));
    const out = await extractCommitmentsWithModel(transcript, { client: { messages: { create } } });
    expect(out.skipped).toBeUndefined();
    expect(out.droppedMismatched).toBe(0);
    expect(out.items.map((i) => i.kind)).toEqual(['callback']);
  });
  test('surplus evidence is trimmed to the schema cap instead of failing the response; more than 12 commitments are capped too', async () => {
    const four = Array.from({ length: 4 }, () => ({ quote: 'I will call you back tomorrow morning with the price', speaker: 'agent' }));
    const create = jest.fn(async () => reply([item({ evidence: four })]));
    const out = await extractCommitmentsWithModel(transcript, { client: { messages: { create } } });
    expect(out.skipped).toBeUndefined();
    expect(out.items).toHaveLength(1);
    expect(out.items[0].evidence.length).toBeLessThanOrEqual(3);
    const many = { commitments: Array.from({ length: 13 }, () => item()) };
    expect(normalizeModelOutput(many).commitments).toHaveLength(12);
    expect(buildCommitmentsPrompt({ transcript, callStartedAt: '2026-09-01T14:00:00Z' })).toMatch(/at most three quotes per commitment/);
  });
  test('the prompt names the channel vocabulary', () => {
    const prompt = buildCommitmentsPrompt({ transcript, callStartedAt: '2026-09-01T14:00:00Z' });
    expect(prompt).toMatch(/"channel" is exactly one of "sms", "email", "call", "in_person", "unknown"/);
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
