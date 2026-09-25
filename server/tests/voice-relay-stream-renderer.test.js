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
const { splitSentences, needsHold } = require('../services/voice-agent/relay-stream-renderer');

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

  test('plain acknowledgement / filler text does not need holding', () => {
    expect(needsHold('Sure, one moment while I look that up.')).toBe(false);
    expect(needsHold('Great question!')).toBe(false);
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

  test('an amount sentence is held until finalMessage, then checked and released (no pending write)', async () => {
    const { IsolatedConvo, captured } = isolatedConvoFactory();
    process.env.VOICE_RELAY_RENDERER = 'stream';
    const send = jest.fn();
    const convo = new IsolatedConvo({ callSid: 'CA-s2', from: '+19415551234', send });
    const finalText = 'Sure thing. That runs $149 for the visit.';

    const promptPromise = convo.handlePrompt('how much is a visit');
    await flush();
    const round = captured[0];
    round.textCb('Sure thing. '); // safe — flushes immediately
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
    round.textCb('We handle pest control. '); // flushes
    round.textCb('We also do lawn care. '); // flushes

    convo.interrupt({ utteranceUntilInterrupt: 'We handle pest control. We also do lawn care.' });
    // A chunk that arrives AFTER the abort must never reach Twilio.
    round.textCb('This must never be spoken.');
    await promptPromise; // the round rejects (AbortError) and _runLoop returns

    const spoken = send.mock.calls.map(([t]) => t).join('');
    expect(spoken).not.toMatch(/never be spoken/);
    expect(spoken).toMatch(/We handle pest control\./);

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
    round.textCb('We cover Manatee and Sarasota. ');
    round.reject(new Error('stream disconnected')); // NOT an abort — a genuine mid-stream failure
    await promptPromise;

    // `say()` (the failure-copy path) calls `_send(text)` with no second
    // arg at all — relay-server.js's real `send` wrapper defaults `last` to
    // true in that case, so an undefined second arg here means the same.
    const calls = send.mock.calls.map(([t, last]) => [t, last === undefined ? true : last]);
    // The streamed prefix, sent exactly once, followed by a closing empty
    // last:true frame, followed by the (separate) failure line — nothing
    // about the first utterance is ever resent.
    expect(calls.filter(([t]) => t.includes('Manatee'))).toHaveLength(1);
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

    const firstPrompt = convo.handlePrompt('first question');
    await flush();
    const round1 = captured[0];
    round1.textCb('Partial answer to the first question. ');
    convo.interrupt({ utteranceUntilInterrupt: 'Partial answer to the first question.' });
    await firstPrompt;
    const firstEntry = convo._transcript.find((e) => e.role === 'agent');

    const secondPrompt = convo.handlePrompt('second question');
    await flush();
    const round2 = captured[1];
    expect(round2).toBeTruthy();
    round2.textCb('Answer to the second question. ');
    round2.resolve({ content: [{ type: 'text', text: 'Answer to the second question.' }], stop_reason: 'end_turn' });
    await secondPrompt;

    // The first (interrupted) entry is untouched by the second round.
    expect(firstEntry.interrupted).toBe(true);
    expect(firstEntry.planned).toBe('Partial answer to the first question. ');

    const agentEntries = convo._transcript.filter((e) => e.role === 'agent');
    expect(agentEntries).toHaveLength(2);
    expect(agentEntries[1]).not.toBe(firstEntry);
    // The second round's own entry never inherits or merges the first
    // round's (interrupted, unrelated) text — no resurfacing across rounds.
    expect(agentEntries[1].planned).toBe('Answer to the second question.');
    expect(agentEntries[1].planned).not.toMatch(/first question/);
  });
});
