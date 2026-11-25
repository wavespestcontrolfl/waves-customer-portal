/**
 * The practice line's (GPT-Live trial brain) spend bound holds BY CONSTRUCTION, not by counting: its model
 * clients are built with SDK retries off, it never switches provider mid-call, and it loops at most 3 model
 * rounds an ask. So a call's provider requests are at most 15 asks x 3 rounds = 45. The SDK and the tools are
 * stubs here: no provider is called.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));

const logger = require('../services/logger');

// The stubs read the CURRENT build lazily: jest may reuse an earlier registration's factory, so nothing here closes
// over one build's recorder.
let current = null;

// Builds an isolated relay-conversation whose provider SDKs are stubs that record every construction and request.
function build({ stream }) {
  const rec = { anthropicInstances: [], openaiInstances: [], anthropicRequests: [], openaiRequests: [] };
  current = { rec, stream };
  let Convo;
  jest.isolateModules(() => {
    jest.doMock('../services/logger', () => logger);
    jest.doMock('@anthropic-ai/sdk', () => function AnthropicMock(opts) {
      const instance = {
        opts,
        messages: {
          stream: (params, options) => {
            current.rec.anthropicRequests.push({ opts, options });
            return current.stream('anthropic', params, options);
          },
        },
      };
      current.rec.anthropicInstances.push(instance);
      return instance;
    });
    jest.doMock('../services/voice-agent/relay-openai-client', () => ({
      OpenAIRelayClient: class {
        constructor(opts) {
          this.opts = opts;
          this.messages = {
            stream: (params, options) => {
              current.rec.openaiRequests.push({ client: this, options });
              return current.stream('openai', params, options);
            },
          };
          current.rec.openaiInstances.push(this);
        }
      },
    }));
    jest.doMock('../services/voice-agent/relay-tools', () => ({
      TOOLS: [], CONTEXT_TOOLS: [], BOOKING_TOOLS: [], PRACTICE_LINE_TOOLS: [],
      activeTools: () => [], executeTool: jest.fn(async () => 'tool result'),
    }));
    Convo = require('../services/voice-agent/relay-conversation').RelayConversation;
  });
  return { Convo, rec };
}

const toolUseStream = () => ({
  finalMessage: async () => ({ content: [{ type: 'tool_use', id: 't1', name: 'get_pricing', input: {} }], stop_reason: 'tool_use' }),
});
const failingStream = (message, extra = {}) => () => ({
  finalMessage: async () => { throw Object.assign(new Error(message), extra); },
});

const practiceArgs = (extra = {}) => ({
  callSid: 'CA-spend-1', from: '+19415551234', send: jest.fn(), endSession: jest.fn(), sandbox: true, practiceLine: true, ...extra,
});
const turnStat = () => ({ turn: 1, promptAt: 0, firstTokenAt: null, firstSendAt: null, modelMs: 0, toolMs: 0, toolCount: 0, rounds: 0, timedOut: false, agentEntries: [], callerSeq: 0 });

describe('SDK retries are off on a practice line (a separate client, never the shared one)', () => {
  test('the practice Anthropic client is built with maxRetries 0, the shared one is untouched, and every request says so too', async () => {
    const { Convo, rec } = build({ stream: toolUseStream });
    const convo = new Convo(practiceArgs());
    await convo._runLoop('what does pest control cost').catch(() => {});
    const shared = rec.anthropicInstances.find((i) => i.opts.maxRetries === undefined);
    const practice = rec.anthropicInstances.find((i) => i.opts.maxRetries === 0);
    expect(shared).toBeDefined(); // the process-wide client keeps the SDK's retries
    expect(practice).toBeDefined();
    expect(practice).not.toBe(shared);
    expect(rec.anthropicRequests.length).toBeGreaterThan(0);
    for (const request of rec.anthropicRequests) {
      expect(request.opts.maxRetries).toBe(0); // the practice instance served every request
      expect(request.options.maxRetries).toBe(0); // and each request opts out too
    }
  });

  test('an ordinary session still uses the shared client and its retries', async () => {
    const { Convo, rec } = build({ stream: toolUseStream });
    const convo = new Convo({ callSid: 'CA-ord', from: '+19415551234', send: jest.fn() });
    await convo._runLoop('hello').catch(() => {});
    for (const request of rec.anthropicRequests) {
      expect(request.opts.maxRetries).toBeUndefined();
      expect(request.options).not.toHaveProperty('maxRetries');
    }
  });

  test('the practice OpenAI adapter is its own instance, not the shared one', async () => {
    const { Convo, rec } = build({ stream: toolUseStream });
    const convo = new Convo(practiceArgs());
    convo._provider = 'openai';
    await convo._runLoop('hi').catch(() => {});
    expect(rec.openaiRequests.length).toBeGreaterThan(0);
    const shared = rec.openaiInstances[0]; // built at module load
    for (const request of rec.openaiRequests) expect(request.client).not.toBe(shared);
  });
});

describe('no mid-call provider switch on a practice line', () => {
  test('the switch is never eligible, and a failed OpenAI round is one request, then the failure copy', async () => {
    const { Convo, rec } = build({ stream: failingStream('overloaded', { status: 529 }) });
    const convo = new Convo(practiceArgs());
    convo._provider = 'openai';
    expect(convo._canSwitchToClaudeFallback()).toBe(false);
    const stat = turnStat();
    convo._currentTurn = stat;
    await convo._runLoop('hello there').catch(() => {});
    expect(rec.openaiRequests).toHaveLength(1); // no retry, no second attempt
    expect(rec.anthropicRequests).toHaveLength(0); // never moved to Claude
    expect(convo._modelSwitch).toBe(null);
  });

  test('an ordinary OpenAI session is still eligible for its one switch (unchanged)', () => {
    const { Convo } = build({ stream: toolUseStream });
    const convo = new Convo({ callSid: 'CA-ord-2', from: '+19415551234', send: jest.fn(), sandbox: true });
    convo._provider = 'openai';
    expect(convo._canSwitchToClaudeFallback()).toBe(true);
  });
});

describe('at most 3 model rounds an ask on a practice line', () => {
  test('a model that keeps calling tools is stopped at 3 requests, where an ordinary session runs 6', async () => {
    const practice = build({ stream: toolUseStream });
    const convo = new practice.Convo(practiceArgs());
    await convo._runLoop('keep going').catch(() => {});
    expect(practice.rec.anthropicRequests).toHaveLength(3);

    const ordinary = build({ stream: toolUseStream });
    const other = new ordinary.Convo({ callSid: 'CA-ord-3', from: '+19415551234', send: jest.fn() });
    await other._runLoop('keep going').catch(() => {});
    expect(ordinary.rec.anthropicRequests).toHaveLength(6);
  });

  test('the bound is 15 asks x 3 rounds = 45 provider requests a call, with nothing else able to add one', async () => {
    const { BRAIN_ASK_CAP } = require('../services/voice-agent/live-bridge');
    expect(BRAIN_ASK_CAP * 3).toBe(45);
  });
});

describe('provider failures are logged as a bounded code', () => {
  test('a failed model stream whose error echoes the caller\'s words logs only a code', async () => {
    const secret = 'invalid tool input: {"first_name":"Pat","phone":"+19415550123","address_line1":"12 Palm Ave"}';
    const { Convo } = build({ stream: failingStream(secret, { status: 400, name: 'BadRequestError' }) });
    for (const practiceLine of [true, false]) {
      jest.clearAllMocks();
      const convo = new Convo({ ...practiceArgs(), practiceLine, sandbox: true });
      convo._currentTurn = turnStat();
      await convo._runLoop('my number is 9415550123').catch(() => {});
      const logged = JSON.stringify(['info', 'warn', 'error'].map((level) => logger[level].mock.calls));
      expect(logged).toMatch(/model round failed/);
      expect(logged).toMatch(/code=BadRequestError:400/);
      expect(logged).not.toMatch(/9415550123|Palm Ave|first_name|invalid tool input/);
    }
  });
});
