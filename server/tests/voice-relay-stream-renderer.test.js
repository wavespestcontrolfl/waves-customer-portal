/**
 * PR C — VOICE_RELAY_RENDERER=stream (relay-stream-renderer.js +
 * relay-conversation.js's streaming round loop). Three layers:
 *  1. The pure chunking/hold module (no RelayConversation needed).
 *  2. The renderer selector (env resolution, pinned per session).
 *  3. The full streaming round loop, driven through `handlePrompt` against a
 *     controllable `anthropic.messages.stream()` double — mirrors the
 *     existing `voice-relay-conversation.test.js` isolated-module pattern.
 *
 * Every full-round test asserts the DEFAULT (block, no env set) path is
 * never touched by these fixtures — separately, `voice-relay-conversation
 * .test.js`'s full unmodified suite is the byte-identical-default guarantee.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));

const { RelayConversation } = require('../services/voice-agent/relay-conversation');
const { splitSentences, needsHold, isStreamSafe } = require('../services/voice-agent/relay-stream-renderer');

// Let the microtask-only awaits inside handlePrompt → _runLoop (contextReady
// is null, resumeReady is null, officeHoursReady is null, _maybeHandoffForFailure
// resolves on isRecoveryGateOn()===false) settle before the mocked
// `anthropic.messages.stream()` call is made.
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A controllable `@anthropic-ai/sdk` double. `captured[n]` is the nth
 * `messages.stream()` call (one per model round): `.textCb(delta)` replays a
 * streamed text delta synchronously (mirroring the SDK's `on('text', ...)`),
 * `.resolve(finalMessage)` settles `finalMessage()` normally, and aborting
 * the round's own signal (via RelayConversation's `interrupt()`) rejects it
 * exactly like the real SDK does on `AbortController.abort()`.
 */
function makeAnthropicMock() {
  const captured = [];
  function AnthropicMock() {
    return {
      messages: {
        stream(params, opts) {
          const round = { params, opts, textCb: null, streamCb: null };
          let settled = false;
          round.promise = new Promise((resolve, reject) => {
            round.resolve = (v) => { if (!settled) { settled = true; resolve(v); } };
            round.reject = (e) => { if (!settled) { settled = true; reject(e); } };
            opts.signal.addEventListener('abort', () => round.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          });
          captured.push(round);
          return {
            on(event, cb) {
              if (event === 'text') round.textCb = cb;
              if (event === 'streamEvent') round.streamCb = cb;
              return this;
            },
            finalMessage: () => round.promise,
          };
        },
      },
    };
  }
  return { AnthropicMock, captured };
}

function isolatedConvoFactory() {
  let IsolatedConvo;
  let captured;
  jest.isolateModules(() => {
    const mock = makeAnthropicMock();
    captured = mock.captured;
    jest.doMock('@anthropic-ai/sdk', () => mock.AnthropicMock);
    jest.doMock('../services/voice-agent/relay-tools', () => ({
      TOOLS: [], CONTEXT_TOOLS: [], activeTools: () => [], executeTool: jest.fn(async () => 'ok'),
    }));
    IsolatedConvo = require('../services/voice-agent/relay-conversation').RelayConversation;
  });
  return { IsolatedConvo, captured };
}

describe('relay-stream-renderer — pure chunking + hold policy', () => {
  test('splits on complete sentence boundaries and reconstructs losslessly', () => {
    const buf = 'Sure, let me check that.  One moment please! Anything else';
    const { sentences, rest } = splitSentences(buf);
    expect(sentences.join('') + rest).toBe(buf);
    expect(sentences).toEqual(['Sure, let me check that.  ', 'One moment please! ']);
    expect(rest).toBe('Anything else');
  });

  test('an incomplete trailing fragment is held for the next delta, not guessed', () => {
    const { sentences, rest } = splitSentences('Let me check that for you');
    expect(sentences).toEqual([]);
    expect(rest).toBe('Let me check that for you');
  });

  test.each([
    'Listo, ya quedó agendada su cita.',
    'Ya está reservado.',
    'Perfecto, le confirmo el servicio.',
    'Le enviamos un mensaje en un momento.',
    '¿Algo más en que le pueda ayudar?',
  ])('a Spanish sentence is held (English-only hold regexes): %s', (sentence) => {
    expect(needsHold(sentence)).toBe(true);
  });

  test.each([
    'We can get you in next week.',
    'How about the 15th?',
    'How about the fifteenth?',
    'We have a slot on the twenty-first at noon.',
    'I have this afternoon open.',
    'Tomorrow morning is free.',
    'We could do it at noon.',
    "Two o'clock is open.",
    'I can have someone there at nine.',
    'Nine thirty is available.',
    'Unit 4B is on file.',
  ])('a date/time or digit sentence is held: %s', (sentence) => {
    expect(needsHold(sentence)).toBe(true);
  });

  // P1-b: a future/modal write commitment claims the same outcome a
  // completed one does ("I'll book that" ~ "booked"), so it must hold too —
  // before this fix WRITE_COMMITMENT_RE did not exist and these all
  // streamed immediately.
  test.each([
    "I'll book that for you.",
    'I will schedule that now.',
    "I'm going to reschedule that.",
    'I am going to refund that.',
    "We'll submit that today.",
    'We will send that over.',
    'Let me text you the details.',
    'I can email that to you.',
    "I'm charging your card now.",
    'I am transferring the file.',
    'Going to file that for you.',
    'Let me set up your appointment.',
    'Let me put you down for that.',
    'Booking that now.',
    'Scheduling that for you.',
    'Sending that over right away.',
  ])('a future/modal write commitment needs holding: %s', (sentence) => {
    expect(needsHold(sentence)).toBe(true);
  });

  // Read-only verbs are never in the write-commitment list, so a modal
  // prefix in front of one must still stream (P1-b requirement).
  test.each([
    'Let me check on that for you.',
    'One moment while I pull that up.',
    "I'm looking into that now.",
    "I'll see what I can find.",
    'Let me take a look at your account.',
  ])('a read-only modal sentence still streams: %s', (sentence) => {
    expect(needsHold(sentence)).toBe(false);
  });

  // P2-e: a '.' right after a common abbreviation or a single-letter
  // initial is not a sentence boundary — holding longer is always safe.
  test('an abbreviation period is not treated as a sentence boundary', () => {
    expect(splitSentences('We service St. Petersburg. Anything else?')).toEqual({
      sentences: ['We service St. Petersburg. '],
      rest: 'Anything else?',
    });
    expect(splitSentences('Please ask Dr. Smith. Thanks.')).toEqual({
      sentences: ['Please ask Dr. Smith. '],
      rest: 'Thanks.',
    });
    expect(splitSentences('We open at nine a.m. every day. See you then.')).toEqual({
      sentences: ['We open at nine a.m. every day. '],
      rest: 'See you then.',
    });
    expect(splitSentences('Contact the U.S. Postal Service. They can help.')).toEqual({
      sentences: ['Contact the U.S. Postal Service. '],
      rest: 'They can help.',
    });
  });

  test('a single-letter initial is not treated as a sentence boundary', () => {
    expect(splitSentences('J. Smith called. He wants a callback.')).toEqual({
      sentences: ['J. Smith called. '],
      rest: 'He wants a callback.',
    });
  });

  test("the 'one moment' / 'the first thing' fillers still stream (bare spelled numbers and ordinals do not hold)", () => {
    expect(needsHold('One moment while I pull that up. ')).toBe(false);
    expect(needsHold('The first thing I will check is your account. ')).toBe(false);
  });

  test('plain English filler is not caught by the Spanish hint', () => {
    expect(needsHold('Sure, let me check that for you. ')).toBe(false);
    expect(needsHold('One moment please. ')).toBe(false);
  });

  test('an amount sentence (digits or spelled out) needs holding', () => {
    expect(needsHold('That will be $149 for the visit.')).toBe(true);
    expect(needsHold('It runs one hundred and forty nine dollars per treatment.')).toBe(true);
  });

  test('a date/time sentence needs holding', () => {
    expect(needsHold('We can get you in on Tuesday.')).toBe(true);
    expect(needsHold('The tech will arrive at 9:00 am.')).toBe(true);
  });

  test('a negation needs holding', () => {
    expect(needsHold("No, we don't service that area.")).toBe(true);
  });

  test('a commitment verb needs holding', () => {
    expect(needsHold('Your appointment is booked.')).toBe(true);
    expect(needsHold('I have scheduled that for you.')).toBe(true);
  });

  // A success CLAIM makes the same promise a commitment verb does, without
  // using one of those verbs — "you're all set" asserts what "booked" does.
  test.each([
    ['Great, you are all set.', /all set/i],
    ["Perfect, you're set.", /you.re set/i],
    ["You're all taken care of.", /taken care of/i],
    ["I've got you down for Tuesday.", /got you down/i],
    ["I've got you booked for that.", /got you booked/i],
    ['Let me put you down for that.', /put you down/i],
    ["You're on the calendar.", /on the calendar/i],
    ["You're on the schedule now.", /on the schedule/i],
    ['That is locked in.', /locked in/i],
    ['I have set up your appointment.', /set up/i],
    ['Your technician is on the way.', /on the way/i],
    ["I've sent that over to the team.", /I.ve sent/i],
    ["I've added the note to your file.", /I.ve added/i],
    ['Someone will call you back shortly.', /someone will call/i],
    ['That has been reserved for you.', /reserved/i],
    ['Your ticket has been created.', /created/i],
    ['That request has been processed.', /processed/i],
    ['All done on my end.', /done/i],
  ])('commitment-or-success claim needs holding: %s', (sentence) => {
    expect(needsHold(sentence)).toBe(true);
  });

  test('plain acknowledgement / filler text does not need holding', () => {
    expect(needsHold('Sure, one moment while I look that up.')).toBe(false);
    expect(needsHold('Great question!')).toBe(false);
    expect(needsHold('Let me check on that for you.')).toBe(false);
  });
});

// ── isStreamSafe — the allowlist grammar (structural fix #1) ───────────────
// A phrase BLOCKLIST for commitments does not converge: Codex found "I'll
// book that" slipping COMMITMENT_OR_SUCCESS_RE; the very next audit pass
// found "I'll take care of that", "let me put that through", "I'll get that
// over to the team", "consider it handled" — none of which any hold-verb
// list will ever fully enumerate. `isStreamSafe` inverts the policy: a
// sentence streams progressively ONLY when it is a recognized safe shape
// (an ack + one read-only clause, or a question) — an ordinary statement,
// even an innocuous one, now holds by default.
describe('isStreamSafe — allowlist grammar (structural fix, replaces the blocklist)', () => {
  test.each([
    "I'll take care of that.",
    'let me put that through.',
    "I'll get that over to the team.",
    'consider it handled.',
  ])('the four audit-discovered commitment phrasings hold (not allowlisted, no blocklist entry would ever cover them all): %s', (sentence) => {
    expect(isStreamSafe(sentence)).toBe(false);
    expect(needsHold(sentence)).toBe(false); // NOT caught by the veto either — this IS the point of the allowlist
  });

  test('a read-only clause followed by a second (write-commitment) clause does not match — exactly ONE clause is allowed', () => {
    expect(isStreamSafe("Let me check on that and I'll take care of it.")).toBe(false);
  });

  test.each([
    'We treat for ants and roaches.',
    'Our technician will be there on the route.',
    'That service includes the perimeter.',
  ])('an ordinary declarative statement holds by default, even an innocuous one: %s', (sentence) => {
    expect(isStreamSafe(sentence)).toBe(false);
  });

  test.each([
    'Sure, let me check on that for you.',
    'Okay, one moment please.',
    'Got it! Let me pull up your account.',
    'Great.',
  ])('a recognized safe filler streams: %s', (sentence) => {
    expect(isStreamSafe(sentence)).toBe(true);
  });

  test.each([
    "I've handled that, anything else?",
    'All done, anything else?',
    "It's taken care of — anything else?",
    "I'll get that over to the team and is there anything else?",
    'Consider it handled?',
  ])('a claim with a question tacked on does not stream: %s', (sentence) => {
    expect(isStreamSafe(sentence)).toBe(false);
  });

  test('a plain question streams', () => {
    expect(isStreamSafe("What's the address there?")).toBe(true);
    expect(isStreamSafe('Great, what is the address there?')).toBe(true);
    expect(isStreamSafe('Is there anything else I can help with?')).toBe(true);
  });

  test('a question carrying a date/amount still holds — needsHold vetoes isStreamSafe', () => {
    expect(isStreamSafe('What time on Tuesday works?')).toBe(true); // allowlisted as a question...
    expect(needsHold('What time on Tuesday works?')).toBe(true); // ...but the veto still wins
  });
});

describe('renderer selector — resolved once, pinned per session', () => {
  afterEach(() => {
    delete process.env.VOICE_RELAY_RENDERER;
    delete process.env.VOICE_RELAY_SANDBOX_RENDERER;
  });

  test('default (no env) is block — byte-identical to today', () => {
    const convo = new RelayConversation({ callSid: 'CA-r1', from: '+19415551234', send: jest.fn() });
    expect(convo.renderer).toBe('block');
  });

  test('VOICE_RELAY_RENDERER=stream applies to production inbound', () => {
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const convo = new RelayConversation({ callSid: 'CA-r2', from: '+19415551234', send: jest.fn() });
    expect(convo.renderer).toBe('stream');
  });

  test('VOICE_RELAY_SANDBOX_RENDERER applies ONLY to sandbox sessions', () => {
    process.env.VOICE_RELAY_SANDBOX_RENDERER = 'stream';
    const prod = new RelayConversation({ callSid: 'CA-r3', from: '+19415551234', send: jest.fn(), sandbox: false });
    expect(prod.renderer).toBe('block');
    const sandbox = new RelayConversation({ callSid: 'CA-r4', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(sandbox.renderer).toBe('stream');
  });

  test('sandbox override outranks the shared override for a sandbox session', () => {
    process.env.VOICE_RELAY_RENDERER = 'stream';
    process.env.VOICE_RELAY_SANDBOX_RENDERER = 'block';
    const sandbox = new RelayConversation({ callSid: 'CA-r5', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(sandbox.renderer).toBe('block');
  });

  test('an unrecognized value falls back to block, never a silent substitution', () => {
    process.env.VOICE_RELAY_RENDERER = 'clause-by-clause';
    const convo = new RelayConversation({ callSid: 'CA-r6', from: '+19415551234', send: jest.fn() });
    expect(convo.renderer).toBe('block');
  });
});

describe('stream renderer — full round loop', () => {
  afterEach(() => {
    delete process.env.VOICE_RELAY_RENDERER;
  });

  test('sentences flush progressively, in order, with whitespace preserved exactly', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s1', from: '+19415551234', send });
    const finalText = 'Sure, let me check that. One moment please.';

    const promptPromise = convo.handlePrompt('what do you offer');
    await flush();
    const round = captured[0];
    expect(round).toBeTruthy();

    round.textCb('Sure, ');
    round.textCb('let me check that. '); // completes sentence 1 → flushes now
    round.textCb('One moment please.'); // no boundary yet → held for the tail
    round.resolve({ content: [{ type: 'text', text: finalText }], stop_reason: 'end_turn' });
    await promptPromise;

    const calls = send.mock.calls; // [token, last]
    expect(calls.length).toBeGreaterThanOrEqual(2); // at least one progressive + one closing send
    expect(calls.map(([t]) => t).join('')).toBe(finalText); // lossless, in order
    expect(calls.slice(0, -1).every(([, last]) => last === false)).toBe(true);
    expect(calls[calls.length - 1][1]).toBe(true); // exactly one last:true, at the end

    const agentEntries = convo._transcript.filter((e) => e.role === 'agent');
    expect(agentEntries).toHaveLength(1); // ONE growing utterance per turn, not one per chunk
    expect(agentEntries[0].planned).toBe(finalText);
    expect(agentEntries[0].text).toBe(finalText);
  });

  test('a Spanish session never flushes progressively; a write round speaks nothing before the tool', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-es1', from: '+19415551234', language: 'es-US', send });
    const promptPromise = convo.handlePrompt('quiero agendar para el martes');
    await flush();
    const round1 = captured[0];
    round1.textCb('Perfecto. ');
    round1.textCb('Un momento, por favor. ');
    await flush();
    expect(send).not.toHaveBeenCalled(); // nothing on the air before finalMessage
    round1.resolve({
      content: [
        { type: 'text', text: 'Perfecto. Un momento, por favor.' },
        { type: 'tool_use', id: 't1', name: 'request_booking', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    await flush();
    expect(send).not.toHaveBeenCalled(); // write-tool round: held text dropped, never spoken
    const hist = convo.messages.find((m) => m.role === 'assistant');
    expect(hist.content.some((b) => b.type === 'text')).toBe(false);

    // Round 2 (after the tool result) streams too — still held, then spoken whole.
    const round2 = captured[1];
    round2.textCb('Listo, ya quedó agendada su cita. ');
    await flush();
    expect(send).not.toHaveBeenCalled();
    round2.resolve({ content: [{ type: 'text', text: 'Listo, ya quedó agendada su cita.' }], stop_reason: 'end_turn' });
    await promptPromise;
    expect(send.mock.calls).toEqual([['Listo, ya quedó agendada su cita.', true]]);
  });

  test('an amount sentence is held until finalMessage, then checked and released (no pending write)', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s2', from: '+19415551234', send });
    // "Sure thing." is NOT allowlisted-safe (no recognized ack/clause) — use
    // a genuinely safe filler so the prefix actually flushes progressively.
    const finalText = 'One moment please. That runs $149 for the visit.';

    const promptPromise = convo.handlePrompt('how much is a visit');
    await flush();
    const round = captured[0];
    round.textCb('One moment please. '); // allowlisted safe — flushes immediately
    await flush();
    expect(send.mock.calls.length).toBeGreaterThan(0); // the safe prefix is already on the air
    round.textCb('That runs $149 for the visit.'); // HELD — must not flush yet
    // Not sent yet: the amount never reached Twilio before finalMessage.
    expect(send.mock.calls.some(([t]) => /\$149/.test(t))).toBe(false);
    round.resolve({ content: [{ type: 'text', text: finalText }], stop_reason: 'end_turn' });
    await promptPromise;

    expect(send.mock.calls.map(([t]) => t).join('')).toBe(finalText);
    expect(send.mock.calls.some(([t]) => /\$149/.test(t))).toBe(true); // released at the close
  });

  test('a write tool_use round: unsent/held text never speaks or enters history; already-sent filler does both', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s3', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('book me for tuesday');
    await flush();
    const round1 = captured[0];
    // "booked" is itself a commitment verb (deliberately conservative — see
    // relay-stream-renderer.js), so the safe filler here avoids that word.
    round1.textCb('Let me check on that for you. '); // safe filler — flushes
    round1.textCb('Your total will be $149 due at booking.'); // HELD (amount) — never flushed
    round1.resolve({
      content: [
        { type: 'text', text: 'Let me check on that for you. Your total will be $149 due at booking.' },
        { type: 'tool_use', id: 't1', name: 'request_booking', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    await flush();

    // Round 2: the model states the outcome after seeing the tool result.
    const round2 = captured[1];
    expect(round2).toBeTruthy();
    round2.resolve({ content: [{ type: 'text', text: 'All set — Tuesday works.' }], stop_reason: 'end_turn' });
    await promptPromise;

    const spoken = send.mock.calls.map(([t]) => t).join('');
    expect(spoken).toContain('Let me check on that for you.');
    expect(spoken).not.toMatch(/\$149/); // the held amount was NEVER spoken

    const firstAssistantMsg = convo.messages.find((m) => m.role === 'assistant');
    expect(firstAssistantMsg.content).toEqual([
      { type: 'text', text: 'Let me check on that for you.' }, // only what was ACTUALLY sent
      { type: 'tool_use', id: 't1', name: 'request_booking', input: {} },
    ]);
  });

  test('barge-in mid-stream drops unsent text and ignores late chunks from the aborted generation', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s4', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('tell me about your services');
    await flush();
    const round = captured[0];
    // Allowlisted safe fillers (isStreamSafe) — a plain declarative
    // statement like "We handle pest control." no longer streams at all.
    round.textCb('Sure, one moment. '); // flushes
    round.textCb('Great, let me double-check that. '); // flushes
    // Every progressive flush is gated on an async late-supersession
    // recheck (_queueOrFlush) — let it settle before the caller can have
    // "heard" anything to barge in over.
    await flush();

    convo.interrupt({ utteranceUntilInterrupt: 'Sure, one moment. Great, let me double-check that.' });
    // A chunk that arrives AFTER the abort must never reach Twilio.
    round.textCb('This must never be spoken.');
    await promptPromise; // the round rejects (AbortError) and _runLoop returns

    const spoken = send.mock.calls.map(([t]) => t).join('');
    expect(spoken).not.toMatch(/never be spoken/);
    expect(spoken).toMatch(/Sure, one moment\./);

    const agentEntry = convo._transcript.find((e) => e.role === 'agent');
    expect(agentEntry.interrupted).toBe(true);
    expect(agentEntry.done).toBe(true);
  });

  test('mid-stream failure/timeout closes with last:true once, never replays sent text, then speaks a separate failure line', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s5', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('what areas do you cover');
    await flush();
    const round = captured[0];
    // Allowlisted safe filler — a plain declarative statement like "We
    // cover Manatee and Sarasota." no longer streams at all.
    round.textCb('Sure, one moment please. ');
    await flush(); // let the progressive-flush chain settle so this actually sends
    round.reject(new Error('stream disconnected')); // NOT an abort — a genuine mid-stream failure
    await promptPromise;

    // `say()` (the failure-copy path) calls `_send(text)` with no second
    // arg at all — relay-server.js's real `send` wrapper defaults `last` to
    // true in that case, so an undefined second arg here means the same.
    const calls = send.mock.calls.map(([t, last]) => [t, last === undefined ? true : last]);
    // The streamed prefix, sent exactly once, followed by a closing empty
    // last:true frame, followed by the (separate) failure line — nothing
    // about the first utterance is ever resent.
    expect(calls.filter(([t]) => t.includes('one moment'))).toHaveLength(1);
    const closingFrames = calls.filter(([t, last]) => t === '' && last === true);
    expect(closingFrames).toHaveLength(1);
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toBe(true);
    expect(lastCall[0]).not.toBe(''); // the failure copy itself, not another empty close
  });

  test('a new round after an aborted one starts with fresh state — nothing from the old round resurfaces', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s6', from: '+19415551234', send });

    // Allowlisted safe fillers, distinguishable per round — a plain
    // declarative "Answer to the first/second question." no longer streams.
    const firstPrompt = convo.handlePrompt('first question');
    await flush();
    const round1 = captured[0];
    round1.textCb('Sure, one moment please. ');
    await flush(); // let the progressive-flush chain settle first
    convo.interrupt({ utteranceUntilInterrupt: 'Sure, one moment please.' });
    await firstPrompt;
    const firstEntry = convo._transcript.find((e) => e.role === 'agent');

    const secondPrompt = convo.handlePrompt('second question');
    await flush();
    const round2 = captured[1];
    expect(round2).toBeTruthy();
    round2.textCb('Okay, let me pull up your account. ');
    round2.resolve({ content: [{ type: 'text', text: 'Okay, let me pull up your account.' }], stop_reason: 'end_turn' });
    await secondPrompt;

    // The first (interrupted) entry is untouched by the second round.
    expect(firstEntry.interrupted).toBe(true);
    expect(firstEntry.planned).toBe('Sure, one moment please. ');

    const agentEntries = convo._transcript.filter((e) => e.role === 'agent');
    expect(agentEntries).toHaveLength(2);
    expect(agentEntries[1]).not.toBe(firstEntry);
    // The second round's own entry never inherits or merges the first
    // round's (interrupted, unrelated) text — no resurfacing across rounds.
    expect(agentEntries[1].planned).toBe('Okay, let me pull up your account.');
    expect(agentEntries[1].planned).not.toMatch(/one moment/);
  });

  test('any tool_use content block starting mid-stream stops further progressive flushes (belt-and-braces)', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s7', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('what times are open');
    await flush();
    const round = captured[0];
    round.textCb('Let me check that for you. ');
    await flush(); // flushes via the gate
    const sentAfterFiller = send.mock.calls.length;
    expect(sentAfterFiller).toBeGreaterThan(0);

    // A (read) tool call starts mid-stream — belt-and-braces: stop flushing
    // anything further this round, even though this isn't a write tool.
    round.streamCb({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'get_availability' } });
    round.textCb('Trailing text after the tool call. '); // must NOT flush now
    await flush();
    expect(send.mock.calls.length).toBe(sentAfterFiller); // no new sends

    round.resolve({
      content: [
        { type: 'text', text: 'Let me check that for you. Trailing text after the tool call.' },
        { type: 'tool_use', id: 't1', name: 'get_availability', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    await flush();
    const round2 = captured[1];
    expect(round2).toBeTruthy();
    round2.resolve({ content: [{ type: 'text', text: 'Tuesday at nine works.' }], stop_reason: 'end_turn' });
    await promptPromise;

    const spoken = send.mock.calls.map(([t]) => t).join('');
    expect(spoken).toContain('Let me check that for you.');
    // get_availability is a READ tool (not in WRITE_TOOLS), so the trailing
    // text is delayed by the belt-and-braces stop, not suppressed — it
    // still reaches the caller once finalMessage() clears it.
    expect(spoken).toContain('Trailing text after the tool call.');
  });

  test('supersession found TRUE at the progressive-flush gate: zero sends, and the existing superseded end-session path runs', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const endSession = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s8', from: '+19415551234', send, endSession });
    convo._sessionSuperseded = jest.fn().mockResolvedValue(true);

    const promptPromise = convo.handlePrompt('are you around');
    await flush();
    const round = captured[0];
    round.textCb('Sure, let me check on that. ');
    round.resolve({ content: [{ type: 'text', text: 'Sure, let me check on that.' }], stop_reason: 'end_turn' });
    await promptPromise;

    expect(send).not.toHaveBeenCalled(); // nothing was ever spoken
    expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'superseded' }));
    expect(convo._sessionSuperseded).toHaveBeenCalledTimes(1);
  });

  test('supersession found FALSE: progressive flush proceeds normally, in order', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s9', from: '+19415551234', send });
    convo._sessionSuperseded = jest.fn().mockResolvedValue(false);

    const promptPromise = convo.handlePrompt('what areas do you serve');
    await flush();
    const round = captured[0];
    const finalText = 'Sure, let me check on that. We serve the whole county.';
    round.textCb('Sure, ');
    round.textCb('let me check on that. ');
    round.textCb('We serve the whole county.');
    round.resolve({ content: [{ type: 'text', text: finalText }], stop_reason: 'end_turn' });
    await promptPromise;

    expect(send.mock.calls.map(([t]) => t).join('')).toBe(finalText);
    expect(convo._sessionSuperseded).toHaveBeenCalled();
  });

  // P1-d: EVERY progressive flush revalidates session ownership — not just
  // the round's first — serialized in order through a per-round chain.
  test('every progressive flush revalidates session ownership, once per sentence, not once per round', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s10', from: '+19415551234', send });
    convo._sessionSuperseded = jest.fn().mockResolvedValue(false);

    // A write-tool round: _finalizeStreamedRound's hasPendingWrite branch
    // never calls _sessionSuperseded itself, so every call this round
    // produces is the per-sentence chain's — isolating the count cleanly
    // from the (separate, pre-existing) held-tail recheck.
    const promptPromise = convo.handlePrompt('book me for tuesday');
    await flush();
    const round1 = captured[0];
    round1.textCb('Sure. '); // sentence 1 — its own check
    round1.textCb('One moment. '); // sentence 2 — its own check, chained after 1's
    round1.textCb('Let me check on that. '); // sentence 3 — its own check, chained after 2's
    round1.resolve({
      content: [
        { type: 'text', text: 'Sure. One moment. Let me check on that.' },
        { type: 'tool_use', id: 't1', name: 'request_booking', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    await flush();
    const round2 = captured[1];
    expect(round2).toBeTruthy();
    // Empty content on purpose: round 2 has nothing left to say, so its own
    // (separate, pre-existing) held-tail recheck never triggers — isolating
    // this assertion to ONLY the progressive-flush chain's call count.
    round2.resolve({ content: [], stop_reason: 'end_turn' });
    await promptPromise;

    // Order preserved despite one check per sentence.
    expect(send.mock.calls.map(([t]) => t).join('')).toBe('Sure. One moment. Let me check on that. ');
    expect(convo._sessionSuperseded).toHaveBeenCalledTimes(3); // one per sentence, not one for the whole round
  });

  // P1-d regression: a takeover landing AFTER the round's first sentence
  // must still be caught before a LATER one sends — this is exactly what a
  // once-per-round gate (checked only before the first flush) would miss.
  test('a takeover mid-round is caught before a later sentence sends, not just the first', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const endSession = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s11', from: '+19415551234', send, endSession });
    let calls = 0;
    // Not superseded for sentence 1's check; superseded from sentence 2's on.
    convo._sessionSuperseded = jest.fn(async () => { calls += 1; return calls >= 2; });

    const promptPromise = convo.handlePrompt('what areas do you serve');
    await flush();
    const round = captured[0];
    // Both sentences must be allowlisted-safe on their own — otherwise
    // sentence 2 would hold via `isStreamSafe` alone (never reaching its
    // own supersession check at all) and this would stop exercising P1-d's
    // per-sentence revalidation.
    round.textCb('Sure. '); // sentence 1 — check finds NOT superseded → sends
    round.textCb('Let me check on that for you. '); // sentence 2 — check finds superseded → withheld
    round.resolve({ content: [{ type: 'text', text: 'Sure. Let me check on that for you.' }], stop_reason: 'end_turn' });
    await promptPromise;

    expect(send.mock.calls.map(([t]) => t).join('')).toBe('Sure. '); // sentence 1 only
    expect(send.mock.calls.some(([t]) => t.includes('check on that'))).toBe(false); // sentence 2 never spoken
    expect(endSession).toHaveBeenCalledWith(expect.objectContaining({ reason: 'superseded' }));
    expect(convo._sessionSuperseded).toHaveBeenCalledTimes(2);
  });

  // P1-a: a played event that catches up to the CURRENT (still-growing)
  // planned text must not retire the entry — it may grow further.
  test('a played event that catches up mid-stream does not retire the still-open entry', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-p1a-1', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('tell me about your services');
    await flush();
    const round = captured[0];
    // Allowlisted safe filler — a plain declarative "We handle pest
    // control." no longer streams at all.
    round.textCb('Sure, one moment please. '); // sentence 1 flushes
    await flush();
    expect(send.mock.calls.length).toBeGreaterThan(0);

    // Twilio reports full playback of what's been sent SO FAR — but the
    // entry is still open (more chunks may still come this round).
    convo._appendPlayed('Sure, one moment please.');
    const entry = convo._transcript.find((e) => e.role === 'agent');
    expect(entry.streamOpen).toBe(true);
    expect(entry.done).toBe(false); // NOT retired — still open
    expect(convo._playing).toContain(entry); // still tracked for the next played event / a barge-in

    round.resolve({ content: [{ type: 'text', text: 'Sure, one moment please.' }], stop_reason: 'end_turn' });
    await promptPromise;
  });

  // P1-a regression: without the fix, the entry above is evicted from
  // `_playing` the instant played catches up mid-stream — a LATER barge-in
  // then finds nothing to truncate (interrupt()'s `_playing` is empty) and
  // `entry.interrupted` never gets set.
  test('a barge-in after an early played-catch-up still finds and truncates the same growing entry', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-p1a-2', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('tell me about your services');
    await flush();
    const round = captured[0];
    // Allowlisted safe fillers — plain declarative statements no longer
    // stream at all.
    round.textCb('Sure, one moment please. '); // sentence 1 flushes
    await flush();
    convo._appendPlayed('Sure, one moment please.'); // early catch-up — must NOT retire (still open)

    round.textCb('Great, let me double-check that. '); // entry keeps growing
    await flush();

    convo.interrupt({ utteranceUntilInterrupt: 'Sure, one moment please. Great, let me double-check that' });
    const entry = convo._transcript.find((e) => e.role === 'agent');
    expect(entry.interrupted).toBe(true); // found and truncated, not lost
    expect(entry.done).toBe(true);
    expect(entry.text).toMatch(/\[interrupted\]/);

    round.textCb('This must never be spoken.');
    await promptPromise;
    expect(send.mock.calls.some(([t]) => String(t).includes('never be spoken'))).toBe(false);
  });

  // P1-c: a barge-in landing WHILE the held tail's own late-supersession
  // recheck is in flight must close the round with ONLY the sent prefix in
  // history — never the model's full generated text (which here includes
  // the held $149 amount the caller never heard).
  test('a barge-in during the tail-release supersession check closes history with only the sent prefix', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const endSession = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-p1c', from: '+19415551234', send, endSession });
    // P1-d means EVERY progressive send also calls _sessionSuperseded — the
    // FIRST call here is that check for the safe filler itself (must
    // resolve normally so it actually flushes); only the SECOND call, the
    // held tail's own release check, is where the barge-in lands mid-await.
    let calls = 0;
    convo._sessionSuperseded = jest.fn(() => new Promise((resolve) => {
      calls += 1;
      if (calls === 1) { resolve(false); return; }
      setImmediate(() => {
        convo.interrupt({ utteranceUntilInterrupt: 'One moment please.' });
        resolve(false);
      });
    }));

    const promptPromise = convo.handlePrompt('how much is a visit');
    await flush();
    const round = captured[0];
    round.textCb('One moment please. '); // allowlisted safe filler — flushes
    await flush();
    round.textCb('That will be $149 for the visit.'); // HELD (amount) — becomes the tail
    round.resolve({ content: [{ type: 'text', text: 'One moment please. That will be $149 for the visit.' }], stop_reason: 'end_turn' });
    await promptPromise;

    const spoken = send.mock.calls.map(([t]) => t).join('');
    expect(spoken).not.toMatch(/\$149/); // the held tail never spoke

    const assistantMsgs = convo.messages.filter((m) => m.role === 'assistant');
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
    // History holds ONLY what was actually sent — never the model's full
    // generated text (which included the $149 amount the caller never heard).
    expect(lastAssistant.content).toEqual([{ type: 'text', text: 'One moment please.' }]);
    // A plain barge-in never ends the session — the call stays open.
    expect(endSession).not.toHaveBeenCalled();
  });

  // P2-f: a genuine mid-stream failure (not a barge-in) must preserve
  // whatever was already sent in the model's OWN history, so the next round
  // doesn't repeat it or lose track of what the caller already heard.
  test('a mid-stream failure preserves the sent prefix in the model conversation history', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-p2f', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('what areas do you cover');
    await flush();
    const round = captured[0];
    // Allowlisted safe filler — a plain declarative "We cover Manatee and
    // Sarasota." no longer streams at all.
    round.textCb('Sure, one moment please. ');
    await flush();
    round.reject(new Error('stream disconnected')); // NOT an abort — a genuine failure
    await promptPromise;

    const assistantMsgs = convo.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].content).toEqual([{ type: 'text', text: 'Sure, one moment please.' }]);

    // The next turn is still valid role alternation (assistant → user) and
    // the model round itself runs fine on top of it — driven to completion
    // so no round is left hanging (a real 20s STREAM_TIMEOUT_MS timer would
    // otherwise leak past this test).
    const secondPrompt = convo.handlePrompt('what about Charlotte county');
    await flush();
    expect(convo.messages[convo.messages.length - 1]).toMatchObject({ role: 'user' });
    const round2 = captured[1];
    expect(round2).toBeTruthy();
    round2.resolve({ content: [{ type: 'text', text: 'Yes, we cover Charlotte too.' }], stop_reason: 'end_turn' });
    await secondPrompt;
  });

  // Structural fix #2: a throw inside a flushChain step (most plausibly
  // _send) must never leave state.flushChain REJECTED — `.then(onFulfilled)`
  // with no `onRejected` on a rejected promise just passes the rejection
  // through, so every LATER queued sentence's own step would be skipped
  // outright, this fire-and-forget call site would surface an unhandled
  // rejection, and _finalizeStreamedRound's bare `await streamState.
  // flushChain` would abort the whole turn instead of finalizing cleanly.
  test('a barge-in during the flush-chain await on a write-tool round: no stray last:true, interrupt record kept, tool not run', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-wb1', from: '+19415551234', send });
    let releaseCheck;
    let checks = 0;
    convo._sessionSuperseded = jest.fn(() => {
      checks += 1;
      if (checks === 1) return Promise.resolve(false);
      return new Promise((resolve) => { releaseCheck = () => resolve(false); });
    });

    const promptPromise = convo.handlePrompt('book me in');
    await flush();
    const round = captured[0];
    round.textCb('Sure. '); // sentence 1 — check #1 resolves, flushes
    await flush();
    round.textCb('Let me check on that for you. '); // sentence 2 — check #2 stays pending
    await flush();
    round.resolve({
      content: [
        { type: 'text', text: 'Sure. Let me check on that for you.' },
        { type: 'tool_use', id: 'tw1', name: 'request_booking', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    await flush(); // finalize is now awaiting the flush chain
    convo.interrupt({ utteranceUntilInterrupt: 'Sure.' }); // barge-in lands mid-await
    const entry = convo._transcript.find((e) => e.role === 'agent');
    const recorded = { text: entry.text, planned: entry.planned, interrupted: entry.interrupted };
    const sendsAtInterrupt = send.mock.calls.length;
    releaseCheck();
    await promptPromise;

    expect(send.mock.calls.length).toBe(sendsAtInterrupt); // no stray last:true after the cut
    expect(send.mock.calls.some(([, last]) => last === true)).toBe(false);
    expect({ text: entry.text, planned: entry.planned, interrupted: entry.interrupted }).toEqual(recorded);
    expect(entry.interrupted).toBe(true);
    // History: only the sent prefix, tool_use paired with a not-run result; no round 2.
    const assistant = convo.messages.filter((m) => m.role === 'assistant');
    expect(assistant[0].content[0]).toEqual({ type: 'text', text: 'Sure.' });
    const resultMsg = convo.messages[convo.messages.indexOf(assistant[0]) + 1];
    expect(resultMsg.content[0]).toEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'tw1' }));
    expect(resultMsg.content[0].content).toMatch(/^Not run/);
    expect(captured[1]).toBeUndefined();
  });

  test('a send that throws mid-chain does not reject flushChain and is not reported as a supersession', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    let sendCalls = 0;
    const send = jest.fn(() => {
      sendCalls += 1;
      if (sendCalls === 1) throw new Error('send failed mid-chain');
    });
    const endSession = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-p2', from: '+19415551234', send, endSession });

    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const promptPromise = convo.handlePrompt('sure and one moment');
      await flush();
      const round = captured[0];
      round.textCb('Sure. '); // sentence 1 — its _send throws
      round.textCb('One moment. '); // sentence 2 — must be withheld, never attempted
      round.resolve({ content: [{ type: 'text', text: 'Sure. One moment.' }], stop_reason: 'end_turn' });
      // Must not hang or reject — finalize completes normally despite the
      // mid-chain throw.
      await expect(promptPromise).resolves.toBeUndefined();
      await flush(); // let any stray microtask (a would-be unhandled rejection) settle

      expect(sendCalls).toBe(1); // only the failing call — sentence 2 never sent
      expect(unhandled).toEqual([]); // no unhandled rejection surfaced anywhere
      // A failed send is NOT a supersession: the call is still this socket's,
      // so the round ends on its own failure path — never endSession('superseded').
      expect(endSession).not.toHaveBeenCalled();
      // Discriminator for the chain catch: without it the throw unwinds
      // _finalizeStreamedRound/_runLoop before the early close runs. With it,
      // the round closes via _closeStreamedRoundEarly: nothing reached
      // Twilio (the send threw), so neither the transcript nor the model's
      // history claims any agent text for this round.
      expect(convo._transcript.filter((e) => e.role === 'agent')).toEqual([]);
      expect(convo.messages.filter((m) => m.role === 'assistant')).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
