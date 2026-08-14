/**
 * Voice-relay Phase E item 1 — SESSION TRANSCRIPT PERSISTENCE (audit trail).
 *
 * Matrix:
 *   - transcript + summary land on the SAME call_log row human calls use, in
 *     the call pipeline's own column contract
 *   - written on a NORMAL close AND on a hangup / turn-cap / error close
 *   - the summary is the model's OWN capture_lead summary (no second LLM
 *     round trip); a hangup with no capture falls back deterministically
 *   - the PR #2177 voicemail-clobber guard is NOT regressed: the transcript
 *     rides the same fenced UPDATE, and a 0-row result logs loudly
 *   - a persistence failure never breaks the call
 *   - synthetic fixtures only (555 numbers, example.com)
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { syncVoiceMessageForCall } = require('../services/conversations');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');
const { RelayConversation } = require('../services/voice-agent/relay-conversation');
const relayTranscript = require('../services/voice-agent/relay-transcript');

const FROM = '+19415550142';

// The end() reconcile builder: captures the fenced guard calls and the final
// update payload so both the guard and the transcript can be asserted.
function primeCallLog({ rows = 1, updateImpl } = {}) {
  const guardQ = { whereNull: jest.fn().mockReturnThis(), orWhereNot: jest.fn().mockReturnThis() };
  const update = updateImpl || jest.fn().mockResolvedValue(rows);
  const builder = {
    update,
    where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }),
  };
  db.mockReturnValue(builder);
  return { builder, guardQ, update };
}

function conversationWithTurns(callSid = 'CA-transcript-1') {
  const convo = new RelayConversation({ callSid, from: FROM, to: '+19415550100', send: jest.fn() });
  convo._recordTurn('caller', 'Hi, I have ants in the kitchen');
  convo._recordTurn('agent', 'I can help with that. What is the address?');
  convo._recordTurn('tool', 'get_availability');
  convo._recordTurn('caller', '12 Shore Drive, Bradenton');
  return convo;
}

beforeEach(() => {
  jest.clearAllMocks();
  syncVoiceMessageForCall.mockResolvedValue(undefined);
  createLeadFromExtraction.mockResolvedValue({ leadId: 'l-1', customerId: null, created: true });
});

describe('transcript composition (pure)', () => {
  test('renders the pipeline\'s labeled dialogue, tool calls marked as not-spoken', () => {
    const text = relayTranscript.buildTranscriptText([
      { role: 'caller', text: 'my lawn looks bad' },
      { role: 'agent', text: 'Sorry to hear that.' },
      { role: 'tool', text: 'get_pricing' },
      { role: 'agent', text: 'Lawn care runs $79 per application.' },
    ]);
    expect(text).toBe([
      'Caller: my lawn looks bad',
      'Agent: Sorry to hear that.',
      '[tool] get_pricing',
      'Agent: Lawn care runs $79 per application.',
    ].join('\n'));
  });

  test('empty/garbage turns are dropped, never rendered as blank lines', () => {
    expect(relayTranscript.buildTranscriptText([
      { role: 'caller', text: '   ' }, { role: 'agent', text: null }, { role: 'nope', text: 'x' },
    ])).toBe('');
    expect(relayTranscript.buildTranscriptText(null)).toBe('');
  });

  test('the summary prefers the model\'s OWN capture_lead summary — no second round trip', () => {
    const summary = relayTranscript.buildCallSummary({
      modelSummary: 'Caller has ants in the kitchen and wants a quarterly plan.',
      turns: [{ role: 'caller', text: 'ants' }],
      leadCaptured: true,
    });
    expect(summary).toBe('Caller has ants in the kitchen and wants a quarterly plan.');
  });

  test('no model summary (hangup) → deterministic fallback from the caller\'s own turns', () => {
    const summary = relayTranscript.buildCallSummary({
      modelSummary: null,
      turns: [{ role: 'caller', text: 'do you do termites' }, { role: 'agent', text: 'we do' }],
      reason: 'ws_close',
      leadCaptured: false,
    });
    expect(summary).toMatch(/no lead captured/i);
    expect(summary).toMatch(/do you do termites/);
    expect(summary).toMatch(/ws_close/);
    expect(summary).not.toMatch(/we do/); // agent turns are not the summary
  });

  test('nothing said at all → no transcript columns (the reconcile still stamps outcome)', () => {
    expect(relayTranscript.buildTranscriptUpdate({ turns: [], modelSummary: null })).toBeNull();
  });

  test('composition never throws — a bad turn list degrades to null, not an exception', () => {
    const boom = { get length() { throw new Error('exploding turns'); } };
    expect(() => relayTranscript.buildTranscriptUpdate({ turns: boom })).not.toThrow();
  });

  // ⭐ A SPOKEN CARD NUMBER NEVER LANDS IN A DURABLE COLUMN. Sandy is told
  // never to take a card, but the caller holds the phone — "let me just give
  // you the number" happens and STT transcribes it. These turns land in the
  // SAME call_log.transcription the recording pipeline scrubs before writing.
  test('a PAN volunteered by the caller is scrubbed before storage', () => {
    const text = relayTranscript.buildTranscriptText([
      { role: 'caller', text: 'my card is 4111 1111 1111 1111, take it now' },
      { role: 'agent', text: 'I cannot take a card on this call.' },
    ]);
    expect(text).not.toContain('4111111111111111');
    expect(text).not.toContain('4111 1111 1111 1111');
    expect(text).toMatch(/take it now/);          // the rest of the turn survives
    expect(text).toMatch(/I cannot take a card/); // …and so does the agent's line

    // The summary path is the same column family and takes the same scrub.
    const summary = relayTranscript.buildCallSummary({
      modelSummary: 'Caller read out 4111 1111 1111 1111 before I stopped them.',
      turns: [],
      leadCaptured: true,
    });
    expect(summary).not.toContain('4111 1111 1111 1111');
  });

  // ⭐ THE SCRUB SEES THE SEQUENCE, NOT ONE TURN AT A TIME. STT delivers one
  // utterance per prompt frame, so a caller reading a card SLOWLY — half the
  // digits, a pause, the other half — lands as two turns, each side under the
  // 13-digit floor a per-turn scrub needs. Scrubbed independently, both halves
  // survived and the PAN was reconstructable from the stored transcript.
  test('a PAN split across TWO caller turns is scrubbed (cross-turn bridging)', () => {
    const turns = [
      { role: 'caller', text: 'my card number is 4111 1111' },
      { role: 'caller', text: '1111 1111' },
      { role: 'agent', text: 'I cannot take a card on this call.' },
    ];
    const text = relayTranscript.buildTranscriptText(turns);
    expect(text.replace(/\D/g, '')).not.toContain('4111111111111111');
    expect(text).toMatch(/I cannot take a card/); // the agent's line survives

    // The composed summary joins caller turns back together — the exact way a
    // split PAN would reassemble — so it takes the same cross-turn scrub.
    const summary = relayTranscript.buildCallSummary({ modelSummary: '', turns, leadCaptured: false });
    expect(summary.replace(/\D/g, '')).not.toContain('4111111111111111');
  });

  // The agent talking BETWEEN the halves must not protect them: the caller-only
  // subsequence is scrubbed as its own sequence first, so Sandy's interjection
  // does not break the digit bridge. (Words spoken INSIDE the number — "and
  // then 1111…" — are beyond any digit-run scrub, the recording pipeline's
  // own documented bound.)
  test('a PAN split across turns WITH an agent turn between still cannot reassemble', () => {
    const text = relayTranscript.buildTranscriptText([
      { role: 'caller', text: 'it starts 4111 1111' },
      { role: 'agent', text: 'I really cannot take that.' },
      { role: 'caller', text: '1111 1111, did you get it?' },
    ]);
    expect(text.replace(/\D/g, '')).not.toContain('4111111111111111');
    expect(text).toMatch(/I really cannot take that/); // the agent line survives
  });

  test('transcript is bounded (a runaway loop can never write an unbounded column)', () => {
    const turns = Array.from({ length: 5000 }, () => ({ role: 'caller', text: 'x'.repeat(500) }));
    const text = relayTranscript.buildTranscriptText(turns);
    expect(text.length).toBeLessThanOrEqual(relayTranscript.MAX_TRANSCRIPT_CHARS);
  });
});

describe('end() persists the transcript on the SAME call_log row', () => {
  test('normal close → pipeline column contract, model summary, and NO processing_status', async () => {
    const { update, guardQ, builder } = primeCallLog();
    const convo = conversationWithTurns();
    convo.leadCaptured = true;
    convo._modelSummary = 'Ants in the kitchen; wants someone out this week.';

    await convo.end('agent_complete');

    expect(db).toHaveBeenCalledWith('call_log');
    expect(builder.where).toHaveBeenCalledWith('twilio_call_sid', 'CA-transcript-1');
    const row = update.mock.calls[0][0];
    // The reconcile columns are untouched by the transcript fold-in.
    expect(row).toMatchObject({
      status: 'completed', answered_by: 'ai_agent', call_outcome: 'ai_handled',
      transcription_status: 'completed',
      transcription_provider: 'conversation_relay',
      call_summary: 'Ants in the kitchen; wants someone out this week.',
    });
    // ⚠️ THE VOICEMAIL-EATER. Stamping 'processed' here made the row
    // unclaimable by call-recording-processor, so a voicemail left on the SAME
    // CallSid after a relay failure was never transcribed and never became a
    // lead. The relay must leave the status alone.
    expect(row).not.toHaveProperty('processing_status');
    expect(row.transcription).toContain('Caller: Hi, I have ants in the kitchen');
    expect(row.transcription).toContain('Agent: I can help with that.');
    expect(row.transcription).toContain('[tool] get_availability');
    const meta = JSON.parse(row.transcription_metadata);
    expect(meta).toMatchObject({
      source: 'voice_relay_session', caller_turns: 2, agent_turns: 1, tool_calls: 1,
      lead_captured: true, reservice_filed: false,
    });
    // ai_extraction is deliberately NOT synthesized.
    expect(row.ai_extraction).toBeUndefined();
    // The unified message row is resynced as before.
    expect(syncVoiceMessageForCall).toHaveBeenCalledWith('CA-transcript-1');
    // The guard is still in place around the whole update.
    expect(guardQ.whereNull).toHaveBeenCalledWith('call_outcome');
    expect(guardQ.orWhereNot).toHaveBeenCalledWith('call_outcome', 'voicemail');
  });

  // ⭐ THE VOICEMAIL-EATING ORDERING, end to end.
  //   WS drops → end() runs while call_outcome is still NULL (so the
  //   voicemail-clobber fence PASSES and the row is written) → Twilio POSTs
  //   /relay-complete with an ErrorCode → the caller is sent to voicemail on the
  //   SAME CallSid → they leave a real message.
  // If end() stamped processing_status='processed', call-recording-processor
  // refuses that row at BOTH gates and the voicemail is never transcribed, never
  // becomes a lead, and is invisible to processAllPending — while the row reads
  // as a successfully AI-handled call.
  test('relay-failure ordering: end() leaves the row CLAIMABLE for the voicemail that follows', async () => {
    const { update } = primeCallLog({ rows: 1 }); // fence passes: call_outcome still NULL
    const convo = conversationWithTurns('CA-drop-then-voicemail');
    await convo.end('ws_close'); // WS dropped mid-call

    const row = update.mock.calls[0][0];
    expect(row.transcription).toBeTruthy(); // the audit trail is still written
    // Statuses call-recording-processor REFUSES to claim (processRecording's
    // early return + the atomic claim's IS DISTINCT FROM predicates).
    const UNCLAIMABLE = ['processed', 'processing'];
    expect(row).not.toHaveProperty('processing_status');
    expect(UNCLAIMABLE).not.toContain(row.processing_status);
  });

  // #2177 voicemail-clobber guard: unchanged, and still fences the transcript.
  test('#2177 guard still holds — the transcript rides the SAME fenced UPDATE', async () => {
    const { update, guardQ } = primeCallLog({ rows: 0 }); // 0 rows: /relay-complete won the race
    const convo = conversationWithTurns('CA-already-voicemail');
    await convo.end('ws_close');
    expect(guardQ.whereNull).toHaveBeenCalledWith('call_outcome');
    expect(guardQ.orWhereNot).toHaveBeenCalledWith('call_outcome', 'voicemail');
    expect(update).toHaveBeenCalledTimes(1); // one statement, not two
  });

  // ⭐ THE FLOOR RUNS BEFORE THE STAMP. The transcript records `lead_captured`
  // and composes its summary from it, so stamping first left the audit trail
  // saying "no lead captured on the call" about a call whose floor lead landed
  // a moment later — the record permanently contradicting the lead it produced.
  test('HANGUP with no capture_lead → the floor lead runs FIRST and the transcript records it', async () => {
    const { update } = primeCallLog();
    const convo = conversationWithTurns('CA-hangup-1');
    // leadCaptured stays false — the caller hung up mid-call.
    await convo.end('ws_close');

    const row = update.mock.calls[0][0];
    expect(row.transcription).toContain('Caller: 12 Shore Drive, Bradenton');
    expect(row.call_summary).not.toMatch(/no lead captured/i); // the floor DID capture one
    expect(JSON.parse(row.transcription_metadata)).toMatchObject({ end_reason: 'ws_close', lead_captured: true });
    expect(createLeadFromExtraction).toHaveBeenCalledTimes(1);
    expect(createLeadFromExtraction.mock.invocationCallOrder[0])
      .toBeLessThan(update.mock.invocationCallOrder[0]);
  });

  test('a FAILED floor write leaves the transcript honestly saying no lead was captured', async () => {
    const { update } = primeCallLog();
    createLeadFromExtraction.mockRejectedValueOnce(new Error('leads table down'));
    const convo = conversationWithTurns('CA-hangup-2');
    await convo.end('ws_close');

    const row = update.mock.calls[0][0];
    expect(row.call_summary).toMatch(/no lead captured/i);
    expect(JSON.parse(row.transcription_metadata)).toMatchObject({ lead_captured: false });
    // …and the failure never took the transcript down with it.
    expect(row.transcription).toContain('Caller: 12 Shore Drive, Bradenton');
  });

  test('a re-service call is recorded as such, not as a lead-less call', async () => {
    const { update } = primeCallLog();
    const convo = conversationWithTurns('CA-reservice');
    convo._reserviceFiled = true;
    convo.leadCaptured = true; // request_reservice suppresses the capture floor
    await convo.end('agent_complete');
    expect(JSON.parse(update.mock.calls[0][0].transcription_metadata)).toMatchObject({ reservice_filed: true });
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

  test('ERROR/teardown close (idle timeout) still writes the record', async () => {
    const { update } = primeCallLog();
    const convo = conversationWithTurns('CA-idle-1');
    convo.leadCaptured = true;
    await convo.end('ws_idle_timeout');
    expect(JSON.parse(update.mock.calls[0][0].transcription_metadata)).toMatchObject({ end_reason: 'ws_idle_timeout' });
  });

  test('VOICEMAIL-CLOBBER GUARD NOT REGRESSED: 0 rows → nothing else written, logged LOUDLY', async () => {
    const { update, guardQ } = primeCallLog({ rows: 0 });
    const convo = conversationWithTurns('CA-voicemail-race');
    convo.leadCaptured = true;

    await convo.end('ws_close');

    // Still ONE fenced statement — the transcript never escapes the guard via a
    // second unfenced write.
    expect(update).toHaveBeenCalledTimes(1);
    expect(db).toHaveBeenCalledTimes(1);
    expect(guardQ.whereNull).toHaveBeenCalledWith('call_outcome');
    expect(guardQ.orWhereNot).toHaveBeenCalledWith('call_outcome', 'voicemail');
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/transcript NOT persisted/i));
  });

  test('persistence FAILURE does not break the call (fail-open, logged)', async () => {
    primeCallLog({ updateImpl: jest.fn().mockRejectedValue(new Error('pool exhausted')) });
    const convo = conversationWithTurns('CA-db-down');
    convo.leadCaptured = true;
    await expect(convo.end('ws_close')).resolves.toBeUndefined();
    expect(convo.ended).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/outcome reconcile failed/i));
  });

  test('no callSid (TwiML-Bin sandbox) → no call_log touch at all', async () => {
    primeCallLog();
    const convo = new RelayConversation({ callSid: null, from: FROM, send: jest.fn() });
    convo.leadCaptured = true;
    await convo.end('ws_close');
    expect(db).not.toHaveBeenCalledWith('call_log');
  });

  test('transcript rows are the RECORD — never masked; only logs are', async () => {
    const { update } = primeCallLog();
    const convo = new RelayConversation({ callSid: 'CA-pii', from: FROM, send: jest.fn() });
    convo._recordTurn('caller', 'this is Pat at 12 Shore Drive, pat@example.com');
    convo.leadCaptured = true;
    await convo.end('ws_close');
    expect(update.mock.calls[0][0].transcription).toContain('pat@example.com');
    const logged = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].flat().join(' ');
    expect(logged).not.toContain('pat@example.com');
    expect(logged).not.toContain('12 Shore Drive');
  });
});

describe('what the session records', () => {
  test('say() records every spoken line', () => {
    const send = jest.fn();
    const convo = new RelayConversation({ callSid: 'CA-say', from: FROM, send });
    convo.say('Thanks for calling Waves.');
    convo.say('   '); // empty → neither spoken nor recorded
    expect(send).toHaveBeenCalledTimes(1);
    expect(convo._transcript).toEqual([{ role: 'agent', text: 'Thanks for calling Waves.' }]);
  });

  test('caller turns are recorded in the serialized chain, so ordering matches the call', async () => {
    const convo = new RelayConversation({ callSid: 'CA-order', from: FROM, send: jest.fn() });
    convo._runLoop = jest.fn(async () => { convo.say('one moment'); });
    convo.handlePrompt('first thing');
    await convo._chain;
    convo.handlePrompt('second thing');
    await convo._chain;
    expect(convo._transcript.map((t) => `${t.role}:${t.text}`)).toEqual([
      'caller:first thing', 'agent:one moment', 'caller:second thing', 'agent:one moment',
    ]);
  });
});
