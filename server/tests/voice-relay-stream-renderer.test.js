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

  // P2-e (codex r3): a bare clock-hour scheduling question has no digit,
  // weekday, month or AM/PM marker for DATE_TIME_RE to catch — needs its
  // own hour-word + scheduling-word veto.
  test.each([
    'Does eleven work?',
    'Would eleven work?',
    'Is eleven open?',
    'How about ten?',
    'Is noon good for you?',
    'Would midnight work for the crew?',
  ])('a bare clock-hour scheduling question needs holding: %s', (sentence) => {
    expect(needsHold(sentence)).toBe(true);
  });

  // P2-e: the new veto must not fire on an hour word alone — only paired
  // with a scheduling word. These safe fillers keep streaming.
  test.each([
    'One moment.',
    'Sure, one moment.',
    'Give me one second',
  ])('an hour word with no scheduling word nearby is unaffected: %s', (sentence) => {
    expect(needsHold(sentence)).toBe(false);
  });

  // Item 1: a relative-day scheduling phrase ("the next day", "the day
  // after next", "the following day") has no digit, weekday/month name, or
  // am/pm marker of its own for DATE_TIME_RE to catch on the existing
  // rules — it needs the day/days/week/weekend + relative-qualifier
  // addition. "Could we do next week?" / "the following Monday" already
  // held via the bare "week" word / weekday name, so this also pins that
  // they still do.
  test.each([
    'Would the next day work?',
    'Does the day after next work?',
    'How about the following day?',
    'Is the day after tomorrow open?',
    'Could we do next week?',
    'What about the following Monday?',
  ])('a relative-day scheduling phrase needs holding: %s', (sentence) => {
    expect(needsHold(sentence)).toBe(true);
  });

  // The relative-day addition must not hold the existing safe fillers (no
  // "day"/"week" word in them) or a plain non-scheduling question.
  test.each([
    'One moment.',
    'Give me one second',
    'One moment while I pull that up.',
    "I'll see what I can find.",
    'Can you spell your last name?',
  ])('the relative-day addition does not hold safe fillers or a plain question: %s', (sentence) => {
    expect(needsHold(sentence)).toBe(false);
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

  // P2-f (codex r3): a wait phrase's OWN "while I ..." read-only clause, and
  // the "see what I can find" idiom, were rejected by the grammar even
  // though they carry no commitment — extend the allowlist to cover them.
  // The combined decision (needsHold false AND isStreamSafe true) is what
  // actually decides streaming, so both are asserted for each case.
  test.each([
    'One moment while I pull that up.',
    'Sure, one moment while I look that up.',
    "I'll see what I can find.",
    'Let me see what I can find.',
    'One moment while I check that.',
    'Just a moment while I look that up.',
  ])('a read-only "while I ..." filler / "see what I can find" streams: %s', (sentence) => {
    expect(needsHold(sentence)).toBe(false);
    expect(isStreamSafe(sentence)).toBe(true);
  });

  // P2-f negatives: the SAME "while I ..." shape with a commitment/booking
  // verb in the read-only slot must still hold — the allowlist extension
  // must not open a hole for a write verb.
  test.each([
    'One moment while I book that.',
    "Let me send that over.",
    'One moment while I schedule you.',
    'One moment while I charge your card.',
    'One moment while I cancel that.',
  ])('a "while I ..." filler with a commitment verb does not stream: %s', (sentence) => {
    expect(isStreamSafe(sentence)).toBe(false);
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

  // P2 (Codex r2): the FIRST candidate present decides outright — an invalid
  // highest-precedence override must fall back to 'block', never fall
  // through to try a lower-precedence candidate that happens to be valid.
  test('an invalid sandbox override falls back to block and never falls through to a valid shared override', () => {
    process.env.VOICE_RELAY_RENDERER = 'stream'; // valid, but lower precedence for a sandbox session
    process.env.VOICE_RELAY_SANDBOX_RENDERER = 'strem'; // typo — invalid, HIGHEST precedence here
    const sandbox = new RelayConversation({ callSid: 'CA-r7', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(sandbox.renderer).toBe('block');
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

  test('a send that fails after earlier chunks went out closes the open utterance and speaks the failure copy', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    let n = 0;
    const send = jest.fn(() => { n += 1; if (n === 2) throw new Error('socket hiccup'); });
    const endSession = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-df1', from: '+19415551234', send, endSession });
    const promptPromise = convo.handlePrompt('hello');
    await flush();
    const round = captured[0];
    round.textCb('Sure. '); // chunk 1 — sent, last:false
    await flush();
    round.textCb('One moment please. '); // chunk 2 — its send throws
    await flush();
    round.resolve({ content: [{ type: 'text', text: 'Sure. One moment please.' }], stop_reason: 'end_turn' });
    await promptPromise;

    const calls = send.mock.calls;
    expect(calls[0]).toEqual(['Sure. ', false]); // interior chunks keep their whitespace
    expect(calls[2]).toEqual(['', true]); // the open token group is closed
    const copy = require('../services/voice-agent/relay-language').copy('modelError', null);
    expect(calls.slice(3).map(([t]) => t).join('')).toBe(copy); // then the failure copy
    const first = convo._transcript.find((e) => e.role === 'agent');
    expect(first.planned).toBe('Sure.'); // only what really went out
    expect(first.streamOpen).toBe(false);
    expect(endSession).not.toHaveBeenCalled();
    expect(convo.messages.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([[{ type: 'text', text: 'Sure.' }]]);
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

      expect(sendCalls).toBe(2); // the failing chunk, then the failure copy — sentence 2 never sent
      expect(send.mock.calls[1][0]).not.toMatch(/One moment/);
      expect(unhandled).toEqual([]); // no unhandled rejection surfaced anywhere
      // A failed send is NOT a supersession: the call is still this socket's,
      // so the round ends on its own failure path — never endSession('superseded').
      expect(endSession).not.toHaveBeenCalled();
      // Discriminator for the chain catch: without it the throw unwinds
      // _finalizeStreamedRound/_runLoop before the early close runs. With it,
      // the round closes via _closeStreamedRoundEarly: nothing reached
      // Twilio (the send threw), so neither the transcript nor the model's
      // history claims any agent text for this round.
      // Nothing from the FAILED round is claimed (the send threw); the one
      // agent line is the failure copy, a separate best-effort utterance.
      const agentLines = convo._transcript.filter((e) => e.role === 'agent');
      expect(agentLines.map((e) => e.text)).toEqual([require('../services/voice-agent/relay-language').copy('modelError', null)]);
      expect(convo.messages.filter((m) => m.role === 'assistant')).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  // P1 (Codex r2, send delivery): relay-server.js's real `send` returns
  // FALSE (not a throw) when the socket isn't OPEN or `ws.send` itself
  // threw internally — the exact scenario the throw-based tests above don't
  // cover. `_flushStreamChunk` must treat a strict `false` return the same
  // way it already treats a throwing `_send`.
  test('a send that returns false (not throws) after earlier chunks went out closes the open utterance and speaks the failure copy', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    let n = 0;
    // relay-server.js's real `send`: returns `false` on an undelivered frame,
    // logs and swallows — it never throws.
    const send = jest.fn(() => { n += 1; return n === 2 ? false : undefined; });
    const endSession = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-df2', from: '+19415551234', send, endSession });
    const promptPromise = convo.handlePrompt('hello');
    await flush();
    const round = captured[0];
    round.textCb('Sure. '); // chunk 1 — delivered (send returns undefined)
    await flush();
    round.textCb('One moment please. '); // chunk 2 — send returns false (not delivered)
    await flush();
    round.resolve({ content: [{ type: 'text', text: 'Sure. One moment please.' }], stop_reason: 'end_turn' });
    await promptPromise;

    const calls = send.mock.calls;
    expect(calls[0]).toEqual(['Sure. ', false]); // interior chunks keep their whitespace
    expect(calls[2]).toEqual(['', true]); // the open token group is closed
    const copy = require('../services/voice-agent/relay-language').copy('modelError', null);
    expect(calls.slice(3).map(([t]) => t).join('')).toBe(copy); // then the failure copy
    const first = convo._transcript.find((e) => e.role === 'agent');
    expect(first.planned).toBe('Sure.'); // only what really went out — the undelivered chunk never counted
    expect(first.streamOpen).toBe(false);
    expect(endSession).not.toHaveBeenCalled();
    expect(convo.messages.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([[{ type: 'text', text: 'Sure.' }]]);
  });

  // P1 (Codex r2, send delivery): the finalize-time tail flush
  // (`_finalizeStreamedRound`'s held-tail release) is a single direct call,
  // not routed through `_queueOrFlush`/`flushChain` — a delivery failure
  // there must still route through `_closeStreamedRoundEarly` rather than
  // throwing straight out of the round loop.
  test('an undelivered send on the finalize-time tail flush ends the round through the same chokepoint as a mid-stream failure', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    let n = 0;
    const send = jest.fn(() => { n += 1; return n === 2 ? false : undefined; }); // the tail flush is call #2
    const convo = new IsolatedConvo({ callSid: 'CA-tailfail', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('how much is a visit');
    await flush();
    const round = captured[0];
    round.textCb('One moment please. '); // allowlisted safe filler — flushes for real (call #1)
    await flush();
    round.textCb('That will be $149 for the visit.'); // HELD (amount) — becomes the tail, released at finalize
    round.resolve({ content: [{ type: 'text', text: 'One moment please. That will be $149 for the visit.' }], stop_reason: 'end_turn' });
    await promptPromise;

    // Normalize like relay-server.js's real `send`: `say()` calls `_send`
    // with a single arg, defaulting `last` to true.
    const calls = send.mock.calls.map(([t, last]) => [t, last === undefined ? true : last]);
    expect(calls[0]).toEqual(['One moment please. ', false]); // the safe prefix, actually delivered
    expect(calls[1]).toEqual(['That will be $149 for the visit.', true]); // attempted — this is the undelivered one (returns false)
    expect(calls[2]).toEqual(['', true]); // _closeStreamEntry's own close, run by the chokepoint
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toBe(true);
    expect(lastCall[0]).not.toBe(''); // the failure copy itself, not another empty close

    // History holds only the sent prefix — the tail was never delivered, so
    // it must never be claimed as something the caller heard.
    const assistantMsgs = convo.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].content).toEqual([{ type: 'text', text: 'One moment please.' }]);
  });

  // P1 (Codex r2, played evidence): growing `planned` (a later chunk
  // flushing) or trimming at close must never clobber `entry.text` with the
  // raw planned text when played evidence already exists — it must keep
  // reflecting what was actually HEARD, via `_syncPlayedEntry`.
  test('played evidence for an earlier chunk survives a later chunk growing planned, and the round closing', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-p2-play', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('tell me about your services');
    await flush();
    const round = captured[0];
    round.textCb('Sure, one moment please. '); // chunk 1 — flushes
    await flush();
    convo._appendPlayed('Sure, one moment please.'); // full tokens-played confirmation for chunk 1
    const entry = convo._transcript.find((e) => e.role === 'agent');
    expect(entry.playedSource).toBe('twilio_event');
    expect(entry.text).toBe('Sure, one moment please.');

    round.textCb('Great, let me double-check that. '); // chunk 2 — flushes and GROWS planned
    await flush();
    // Growing planned must not overwrite the played-derived text with the
    // (unheard-so-far) grown planned text. `planned` itself still carries
    // its natural trailing space at this point — it's only right-trimmed
    // when the entry actually closes, below.
    expect(entry.text).toBe('Sure, one moment please.');
    expect(entry.playedSource).toBe('twilio_event');
    expect(entry.planned).toBe('Sure, one moment please. Great, let me double-check that. ');

    round.resolve({ content: [{ type: 'text', text: 'Sure, one moment please. Great, let me double-check that.' }], stop_reason: 'end_turn' });
    await promptPromise; // finalize closes the entry (no pending tail) — must still not clobber

    expect(entry.text).toBe('Sure, one moment please.');
    expect(entry.playedSource).toBe('twilio_event');
    expect(entry.planned).toBe('Sure, one moment please. Great, let me double-check that.'); // right-trimmed at close
  });

  // P1 (Codex r2, mid-stream barge-in history): a barge-in landing BEFORE
  // finalMessage() resolves (caught in the model-stream catch block, not
  // `_finalizeStreamedRound`) previously left NO record at all of the sent
  // prefix in the model's own conversation history — the very next thing
  // pushed would be the next caller turn's `user` message, right after the
  // ROUND'S OWN caller `user` turn, an invalid role sequence. Routed through
  // `_closeStreamedRoundEarly(streamState, null, 'interrupted')`, exactly
  // like every other early exit.
  describe('mid-stream barge-in (before finalMessage resolves) — history via the chokepoint', () => {
    afterEach(() => { delete process.env.GATE_VOICE_RELAY_INTERRUPT_CONTEXT; });

    test('gate off: history gets exactly one assistant message holding the sent prefix, and the next round sees it', async () => {
      const { IsolatedConvo, captured } = isolatedConvoFactory();
      process.env.VOICE_RELAY_RENDERER = 'stream';
      const send = jest.fn();
      const convo = new IsolatedConvo({ callSid: 'CA-mid-int-1', from: '+19415551234', send });

      const promptPromise = convo.handlePrompt('tell me about your services');
      await flush();
      const round = captured[0];
      round.textCb('Sure, one moment please. '); // flushes
      await flush();
      convo.interrupt({ utteranceUntilInterrupt: 'Sure, one moment please.' }); // barge-in BEFORE finalMessage() resolves
      await promptPromise; // the model round rejects (AbortError) via the mock's abort listener

      const assistantMsgs = convo.messages.filter((m) => m.role === 'assistant');
      expect(assistantMsgs).toHaveLength(1); // previously: none at all
      expect(assistantMsgs[0].content).toEqual([{ type: 'text', text: 'Sure, one moment please.' }]);

      // Role alternation stays valid, and the NEXT model round actually
      // receives this assistant message as history.
      const secondPrompt = convo.handlePrompt('what about pricing');
      await flush();
      const msgs = convo.messages;
      expect(msgs[msgs.length - 2]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Sure, one moment please.' }] });
      expect(msgs[msgs.length - 1]).toMatchObject({ role: 'user' });
      const round2 = captured[1];
      expect(round2).toBeTruthy();
      expect(round2.params.messages[round2.params.messages.length - 2]).toMatchObject({ role: 'assistant' });
      round2.resolve({ content: [{ type: 'text', text: 'Sure, we cover pricing too.' }], stop_reason: 'end_turn' });
      await secondPrompt;
    });

    test('gate on: the pushed assistant message carries the played record, not the sent prefix', async () => {
      process.env.GATE_VOICE_RELAY_INTERRUPT_CONTEXT = 'true';
      const { IsolatedConvo, captured } = isolatedConvoFactory();
      process.env.VOICE_RELAY_RENDERER = 'stream';
      const send = jest.fn();
      const convo = new IsolatedConvo({ callSid: 'CA-mid-int-2', from: '+19415551234', send });

      const promptPromise = convo.handlePrompt('tell me about your services');
      await flush();
      const round = captured[0];
      round.textCb('Sure, one moment please. '); // flushes
      await flush();
      // A partial utterance — the caller only heard part of what was sent.
      convo.interrupt({ utteranceUntilInterrupt: 'Sure, one moment' });
      await promptPromise;

      const entry = convo._transcript.find((e) => e.role === 'agent');
      expect(entry.interrupted).toBe(true);
      expect(entry.text).toMatch(/\[interrupted\]/); // the played record, per _syncPlayedEntry

      const assistantMsgs = convo.messages.filter((m) => m.role === 'assistant');
      expect(assistantMsgs).toHaveLength(1);
      // Same rewrite `_noteInterruptForModel` already does for a
      // finalize-time barge-in — the model's history must never claim the
      // caller heard more than the played record says.
      expect(assistantMsgs[0].content).toEqual([{ type: 'text', text: entry.text }]);
      expect(assistantMsgs[0].content[0].text).not.toBe('Sure, one moment please.'); // not the sent prefix
    });
  });

  // P1 (Codex r2, write tools after an interrupt): a barge-in can land the
  // instant AFTER finalize has already pushed the sent prefix to history
  // (the streamed filler) but BEFORE the tool loop runs the round's write
  // tool(s) — interrupt() only aborts `this._controller`; nothing previously
  // stopped the tool loop itself from then running e.g. request_booking on
  // a turn the caller's barge-in already cut off. This exact race (a
  // barge-in landing in the single microtask gap right after finalize
  // resolves) has no natural window in this synchronous test harness — the
  // model-stream catch block and `_finalizeStreamedRound`'s own signal check
  // already close that earlier gap (P1-c) — so the barge-in is injected via
  // a thin wrapper around the real `_finalizeStreamedRound` that fires it
  // immediately after the ORIGINAL call resolves normally, reproducing
  // exactly the race a concurrent WS 'interrupt' frame would create in
  // production without changing anything about what finalize itself does.
  test('a barge-in landing right after finalize (sent prefix already in history) stops the tool loop before any tool runs', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-tool-abort', from: '+19415551234', send });
    // Spy directly on the instance method the tool loop calls — robust
    // regardless of suite ordering (unlike trying to capture the isolated
    // relay-tools module's own `executeTool` mock: `jest.isolateModules`
    // only sandboxes SYNCHRONOUS requires inside its callback, so a module
    // reached later via one of `_executeToolBounded`'s own lazy inline
    // `require('./relay-tools')` calls — as every other write-tool-round
    // test in this file already does — escapes that sandbox, and a LATER
    // `isolatedConvoFactory()` call's fresh mock factory is then never
    // re-invoked for it). This spy needs none of that plumbing: it asserts
    // exactly what finding 4 is about — `_executeToolBounded` itself is
    // never reached — regardless of what backs it.
    const executeToolBoundedSpy = jest.spyOn(convo, '_executeToolBounded');

    const original = convo._finalizeStreamedRound.bind(convo);
    convo._finalizeStreamedRound = async (...args) => {
      const result = await original(...args);
      convo.interrupt({ utteranceUntilInterrupt: 'Let me check on that for you.' });
      return result;
    };

    const promptPromise = convo.handlePrompt('book me for tuesday');
    await flush();
    const round = captured[0];
    round.textCb('Let me check on that for you. '); // safe filler — flushes
    await flush();
    round.resolve({
      content: [
        { type: 'text', text: 'Let me check on that for you.' },
        { type: 'tool_use', id: 't1', name: 'request_booking', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    await promptPromise;

    expect(executeToolBoundedSpy).not.toHaveBeenCalled(); // the tool executor is never reached
    const toolResultMsg = convo.messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
    );
    expect(toolResultMsg.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'Not run — the current turn was interrupted.' },
    ]);
    expect(captured[1]).toBeUndefined(); // no further model round
  });

  // P1-b (codex r3, class fix): the pre-tool abort check only ever observes
  // a barge-in landing BEFORE a tool call — a barge-in during the ONLY (or
  // last) tool's own await was never caught until the loop reached its next
  // tool_use block, which may not exist. Here the barge-in lands WHILE
  // `_executeToolBounded` is still pending, on a round with a single write
  // tool: its real result must still be recorded, and no second model round
  // may start ahead of the caller's queued next prompt.
  test('a barge-in while the single write tool itself is awaiting is observed the instant it settles — no second model round', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-tool-mid-abort', from: '+19415551234', send });
    let resolveTool;
    const executeToolBoundedSpy = jest.spyOn(convo, '_executeToolBounded')
      .mockImplementation(() => new Promise((resolve) => { resolveTool = resolve; }));

    const promptPromise = convo.handlePrompt('book me for tuesday');
    await flush();
    const round = captured[0];
    round.textCb('Let me check on that for you. '); // safe filler — flushes
    await flush();
    round.resolve({
      content: [
        { type: 'text', text: 'Let me check on that for you.' },
        { type: 'tool_use', id: 't1', name: 'request_booking', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    await flush(); // finalize settles; the tool loop is now awaiting the tool
    expect(executeToolBoundedSpy).toHaveBeenCalledTimes(1); // the tool DID start
    convo.interrupt({ utteranceUntilInterrupt: 'Let me check on that for you.' }); // barge-in while it awaits
    resolveTool('booking confirmed for Tuesday'); // the tool settles with a REAL result
    await promptPromise;

    const toolResultMsg = convo.messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
    );
    // The real result is recorded — not a synthetic "not run" — because the
    // tool had already settled by the time the abort was observed.
    expect(toolResultMsg.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'booking confirmed for Tuesday' },
    ]);
    expect(captured[1]).toBeUndefined(); // no second model round starts ahead of the caller's next prompt
  });

  // P1-a (codex r3, class fix): a strict `false` from the close-frame send
  // inside `_closeStreamEntry` must never be swallowed — every caller now
  // routes the throw through `_closeStreamedRoundEarly(..., 'failed')`.
  // Write-turn branch: the close frame (not the tail) fails.
  test('P1-a: a failed close-frame send on a write-tool turn ends the round through the failed chokepoint — the tool never runs', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    let n = 0;
    // call #1 = the safe-filler flush (delivered); call #2 = the close
    // frame `_closeStreamEntry` sends on this write-tool turn (undelivered).
    const send = jest.fn(() => { n += 1; return n === 2 ? false : undefined; });
    const convo = new IsolatedConvo({ callSid: 'CA-p1a-write', from: '+19415551234', send });
    const executeToolBoundedSpy = jest.spyOn(convo, '_executeToolBounded');

    const promptPromise = convo.handlePrompt('book me for tuesday');
    await flush();
    const round = captured[0];
    round.textCb('Let me check on that for you. '); // safe filler — flushes (call #1, delivered)
    await flush();
    round.resolve({
      content: [
        { type: 'text', text: 'Let me check on that for you.' },
        { type: 'tool_use', id: 't1', name: 'request_booking', input: {} },
      ],
      stop_reason: 'tool_use',
    });
    await promptPromise;

    // Before the fix: the unchecked close frame let finalize report success,
    // so the write tool ran despite delivery having failed. After: the tool
    // never runs and the round ends through the same 'failed' chokepoint
    // every other undelivered send uses.
    expect(executeToolBoundedSpy).not.toHaveBeenCalled();
    const assistant = convo.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content[0]).toEqual({ type: 'text', text: 'Let me check on that for you.' });
    const resultMsg = convo.messages[convo.messages.indexOf(assistant[0]) + 1];
    expect(resultMsg.content[0]).toEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 't1' }));
    expect(resultMsg.content[0].content).toMatch(/^Not run — speech to the caller failed/);
    expect(captured[1]).toBeUndefined(); // the tool loop never started a second model round
  });

  // P1-a: the normal (no pending write, no held tail) finalize branch — the
  // close frame is the only remaining send this round, and it fails.
  test('P1-a: a failed close-frame send on a normal (no-tail) finalize ends the round through the failed chokepoint', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    let n = 0;
    // call #1 = the whole reply, flushed in full (delivered); call #2 = the
    // close frame (undelivered) — there is no held tail to flush instead.
    const send = jest.fn(() => { n += 1; return n === 2 ? false : undefined; });
    const convo = new IsolatedConvo({ callSid: 'CA-p1a-notail', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('what areas do you cover');
    await flush();
    const round = captured[0];
    round.textCb('Sure, one moment please. '); // the entire reply — flushes in full
    await flush();
    round.resolve({ content: [{ type: 'text', text: 'Sure, one moment please.' }], stop_reason: 'end_turn' });
    await promptPromise;

    // The spoken text itself DID reach Twilio (only the trailing empty
    // close frame failed) — history holds exactly that sent text, same
    // shape `_closeStreamedRoundEarly` always uses, plus the separate
    // failure-copy utterance recovering the round.
    const assistant = convo.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toEqual([{ type: 'text', text: 'Sure, one moment please.' }]);
    const copy = require('../services/voice-agent/relay-language').copy('modelError', null);
    const agentLines = convo._transcript.filter((e) => e.role === 'agent');
    expect(agentLines.some((e) => e.text === copy)).toBe(true);
  });

  // P2-c (codex r3): reconciliation must compare against the RAW
  // concatenation of the model's text blocks, not the space-joined `text`
  // used for block-mode prosody — otherwise a valid multi-text-block reply
  // with no natural space between blocks reports a mismatch that never
  // happened, and history would wrongly fall back to a truncated shape.
  test('a multi-text-block reply with no natural space between blocks reconciles cleanly (no false mismatch)', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-p2c', from: '+19415551234', send });

    const promptPromise = convo.handlePrompt('tell me about your services');
    await flush();
    const round = captured[0];
    // Both sentences flush progressively — the raw streamed concatenation
    // has exactly one space between them (each sentence carries its own
    // trailing boundary whitespace).
    round.textCb('Sure, one moment. ');
    round.textCb('Great, all set. ');
    await flush();
    // The model's own response is split into TWO adjacent text blocks with
    // no separator between them at all — a real shape the SDK can produce.
    round.resolve({
      content: [
        { type: 'text', text: 'Sure, one moment. ' },
        { type: 'text', text: 'Great, all set.' },
      ],
      stop_reason: 'end_turn',
    });
    await promptPromise;

    // Full history — not the sent-only-text mismatch fallback shape a false
    // "text mismatch" would have produced.
    const assistant = convo.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toEqual([
      { type: 'text', text: 'Sure, one moment. ' },
      { type: 'text', text: 'Great, all set.' },
    ]);
  });
});

// P2-d (codex r3): `say()` is shared by both renderers — including the
// failure-copy recovery line the stream round loop speaks after a mid-stream
// model error / failed send (e.g. `relay-conversation.js`'s `modelError`
// copy). It must never record a transcript entry as spoken when its own
// send comes back strictly undelivered.
describe('say() — a failed send never claims an undelivered line was heard (P2-d)', () => {
  afterEach(() => { delete process.env.VOICE_RELAY_RENDERER; });

  test('a strict `false` from _send marks the entry notPlayed with an honest, distinct text', () => {
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn(() => false); // relay-server.js's real `send`: strict false = not delivered
    const convo = new RelayConversation({ callSid: 'CA-say-fail', from: '+19415551234', send });
    expect(convo.renderer).toBe('stream');

    const spoken = 'Sorry, something went wrong. Let me get someone on the line.';
    const entry = convo.say(spoken);

    expect(entry).toBeTruthy();
    expect(entry.notPlayed).toBe(true);
    // Never the caller-interruption copy — this was a delivery failure, not
    // a barge-in — and never the raw spoken text either (that would claim
    // the caller heard it).
    expect(entry.text).not.toBe(spoken);
    expect(entry.text).not.toBe('[not played — caller interrupted]');
    expect(entry.text).toMatch(/not played/);
    expect(convo._transcript.find((e) => e.role === 'agent')).toBe(entry);
  });

  test('block renderer: a strict `false` from _send leaves the transcript exactly as on main', () => {
    delete process.env.VOICE_RELAY_RENDERER;
    const send = jest.fn(() => false);
    const convo = new RelayConversation({ callSid: 'CA-say-fail-block', from: '+19415551234', send });
    expect(convo.renderer).toBe('block');

    const spoken = 'Thanks for calling Waves Pest Control.';
    const entry = convo.say(spoken);

    expect(send).toHaveBeenCalledWith(spoken);
    expect(entry.notPlayed).toBe(false);
    expect(entry.text).toBe(spoken);
  });

  test('_send returning undefined (every existing test stub, and the constructor default) leaves say() unchanged', () => {
    const send = jest.fn(); // returns undefined, not false
    const convo = new RelayConversation({ callSid: 'CA-say-ok', from: '+19415551234', send });

    const spoken = 'All good, thanks for calling.';
    const entry = convo.say(spoken);

    expect(entry.notPlayed).toBe(false);
    expect(entry.text).toBe(spoken);
  });
});
