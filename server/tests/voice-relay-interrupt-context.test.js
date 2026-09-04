/**
 * Sandy PR 1B — interruption-aware conversation context
 * (GATE_VOICE_RELAY_INTERRUPT_CONTEXT).
 *
 * Gate on: a barge-in rewrites the cut reply in the model's history to the
 * PLAYED record ("<heard> [interrupted]") and the next caller message is
 * prefixed with what the caller heard. Gate off: the model's messages are
 * byte-identical to today (abort only). The transcript is untouched either way.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));

const PLANNED = 'I can get someone out Tuesday at nine in the morning, does that work for you?';
const HEARD = 'I can get someone out Tuesday';
const UNHEARD = 'does that work for you';

/** A RelayConversation whose model round returns the given content blocks in order. */
function convoWithReplies(replies, { callSid = 'CA-1b' } = {}) {
  let Convo;
  jest.isolateModules(() => {
    let call = 0;
    jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock() {
      return {
        messages: {
          stream: () => ({
            finalMessage: async () => {
              const reply = replies[Math.min(call, replies.length - 1)];
              call += 1;
              return reply;
            },
          }),
        },
      };
    });
    jest.doMock('../services/voice-agent/relay-tools', () => ({
      TOOLS: [], CONTEXT_TOOLS: [], activeTools: () => [], executeTool: jest.fn(async () => 'ok'),
    }));
    Convo = require('../services/voice-agent/relay-conversation').RelayConversation;
  });
  const send = jest.fn();
  const convo = new Convo({ callSid, from: '+19415551234', send });
  return { convo, send };
}

const textReply = (text) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
const userTexts = (convo) => convo.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text).join('\n')));
const lastAssistant = (convo) => [...convo.messages].reverse().find((m) => m.role === 'assistant');

async function speakTurn(convo, callerText) {
  await convo.handlePrompt(callerText);
}

describe('GATE_VOICE_RELAY_INTERRUPT_CONTEXT on', () => {
  beforeEach(() => { process.env.GATE_VOICE_RELAY_INTERRUPT_CONTEXT = 'true'; });
  afterEach(() => { delete process.env.GATE_VOICE_RELAY_INTERRUPT_CONTEXT; });

  test('the cut reply is rewritten to what was heard and the next caller message says so — once', async () => {
    const { convo } = convoWithReplies([textReply(PLANNED), textReply('Wednesday at nine then.'), textReply('Anything else?')]);
    await speakTurn(convo, 'do you have anything this week');
    expect(lastAssistant(convo).content[0].text).toBe(PLANNED);

    convo.interrupt({ utteranceUntilInterrupt: HEARD, durationUntilInterruptMs: 1840 });
    const rewritten = lastAssistant(convo);
    expect(rewritten.content).toEqual([{ type: 'text', text: `${HEARD} [interrupted]` }]);
    expect(rewritten.content[0].text).not.toContain(UNHEARD); // played, never planned

    await speakTurn(convo, 'actually Wednesday');
    const users = userTexts(convo);
    expect(users[users.length - 1]).toBe(`[Caller interrupted you after: "${HEARD}"] actually Wednesday`);
    // The transcript keeps the caller's raw words; the note is for the model only.
    expect(convo._transcript.filter((t) => t.role === 'caller').map((t) => t.text)).toEqual(['do you have anything this week', 'actually Wednesday']);
    expect(convo._transcript.filter((t) => t.role === 'agent')[0].text).toBe(`${HEARD} [interrupted]`);

    await speakTurn(convo, 'no that is all');
    const after = userTexts(convo);
    expect(after[after.length - 1]).toBe('no that is all'); // consumed — not carried forward
  });

  test('the rewrite uses the tokens-played record when Twilio reported one', async () => {
    const { convo } = convoWithReplies([textReply(PLANNED)]);
    await speakTurn(convo, 'hi');
    convo.handleRelayEvent({ type: 'info', name: 'tokensPlayed', value: 'I can get someone out Tuesday at nine' });
    convo.interrupt({ utteranceUntilInterrupt: HEARD, durationUntilInterruptMs: 2000 });
    expect(lastAssistant(convo).content[0].text).toBe('I can get someone out Tuesday at nine [interrupted]');
    expect(convo._consumeInterruptNote()).toBe('[Caller interrupted you after: "I can get someone out Tuesday at nine"] ');
  });

  test('a barge-in with no utterance says the heard text is unknown', async () => {
    const { convo } = convoWithReplies([textReply(PLANNED), textReply('Sure.')]);
    await speakTurn(convo, 'hi');
    convo.interrupt({ durationUntilInterruptMs: 40 });
    expect(lastAssistant(convo).content).toEqual([{ type: 'text', text: '[interrupted — played text unknown]' }]);
    await speakTurn(convo, 'wait');
    const users = userTexts(convo);
    expect(users[users.length - 1]).toBe('[Caller interrupted you before your reply finished; what they heard is unknown] wait');
  });

  test('tool-use blocks on the cut message survive; a queued later utterance reads as not played', async () => {
    const { convo } = convoWithReplies([
      { content: [{ type: 'text', text: 'Let me check that for you.' }, { type: 'tool_use', id: 't1', name: 'get_availability', input: {} }], stop_reason: 'tool_use' },
      textReply(PLANNED),
    ]);
    await speakTurn(convo, 'when can you come');
    const filler = convo.messages.find((m) => m.role === 'assistant');
    expect(filler.content.map((b) => b.type)).toEqual(['text', 'tool_use']);
    // Both utterances are queued at Twilio; the caller cuts the FIRST one.
    convo.interrupt({ utteranceUntilInterrupt: 'Let me check', durationUntilInterruptMs: 600 });
    expect(filler.content).toEqual([{ type: 'text', text: 'Let me check [interrupted]' }, { type: 'tool_use', id: 't1', name: 'get_availability', input: {} }]);
    expect(lastAssistant(convo).content).toEqual([{ type: 'text', text: '[not played — caller interrupted]' }]);
    // The paired tool_result is untouched.
    expect(convo.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0].type === 'tool_result')).toBeTruthy();
  });

  test('a bare interrupt() (end()\'s own abort) rewrites nothing', async () => {
    const { convo } = convoWithReplies([textReply(PLANNED)]);
    await speakTurn(convo, 'hi');
    convo.interrupt();
    expect(lastAssistant(convo).content[0].text).toBe(PLANNED);
    expect(convo._pendingInterruptNote).toBeNull();
  });
});

describe('GATE_VOICE_RELAY_INTERRUPT_CONTEXT off (default)', () => {
  beforeEach(() => { delete process.env.GATE_VOICE_RELAY_INTERRUPT_CONTEXT; });

  test('a barge-in leaves the model messages byte-identical and the next caller message bare', async () => {
    const { convo } = convoWithReplies([textReply(PLANNED), textReply('Wednesday at nine then.')]);
    await speakTurn(convo, 'do you have anything this week');
    const before = JSON.stringify(convo.messages);
    convo.interrupt({ utteranceUntilInterrupt: HEARD, durationUntilInterruptMs: 1840 });
    expect(JSON.stringify(convo.messages)).toBe(before);
    // The transcript record is PR 1A's and stays honest regardless of this gate.
    expect(convo._transcript.filter((t) => t.role === 'agent')[0].text).toBe(`${HEARD} [interrupted]`);
    await speakTurn(convo, 'actually Wednesday');
    const users = userTexts(convo);
    expect(users[users.length - 1]).toBe('actually Wednesday');
  });
});
