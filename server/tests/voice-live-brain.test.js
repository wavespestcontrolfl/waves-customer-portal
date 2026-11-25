/**
 * GPT-Live trial brain (GATE_VOICE_GPT_LIVE_TOOLS): one sandbox RelayConversation
 * per call answers the bridge's delegations. The conversation is a fake: no
 * model call, no network, no database.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { LiveBrain, SOFT_DEADLINE_MS, ASK_DEADLINE_MS, TIMEOUT_REPLY, CLOSED_REPLY } = require('../services/voice-agent/live-brain');
const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');

const CALL_SID = 'CA-brain-1';

// db('call_log').where(..).first(..) -> row
function fakeDb(row) {
  const first = jest.fn().mockResolvedValue(row);
  const where = jest.fn(() => ({ first }));
  const db = jest.fn(() => ({ where }));
  return { db, where, first };
}

// A conversation whose handlePrompt sends the given tokens, then settles.
function fakeConvo(args, script = async (convo) => { convo.send('One moment. ', false); convo.send('Your next visit is Tuesday.', true); }) {
  const convo = {
    args,
    sandbox: args.sandbox === true,
    ended: false,
    prompts: [],
    _turnStats: [],
    send: args.send,
    interrupt: jest.fn(),
    handlePrompt: jest.fn((text) => { convo.prompts.push(text); return script(convo); }),
  };
  return convo;
}

const ROW = { source: VOICE_RELAY_SANDBOX_SOURCE, from_phone: '+19415550100', to_phone: '+19412412993' };

async function open({ script, deadlineMs, softMs, row = ROW } = {}) {
  const made = [];
  const d = fakeDb(row);
  const brain = await LiveBrain.open({
    callSid: CALL_SID,
    db: d.db,
    deadlineMs,
    softMs,
    make: (args) => { const c = fakeConvo(args, script); made.push(c); return c; },
  });
  return { brain, convo: made[0], made, d };
}

describe('LiveBrain.open', () => {
  test('builds the conversation sandbox-only, for this call, from the call row', async () => {
    const { convo, d } = await open();
    expect(d.db).toHaveBeenCalledWith('call_log');
    expect(d.where).toHaveBeenCalledWith({ twilio_call_sid: CALL_SID });
    expect(convo.args).toMatchObject({
      callSid: CALL_SID, from: '+19415550100', to: '+19412412993', sandbox: true, practiceLine: true,
      callTokenVerified: false, // a practice line proves and grants no identity
    });
    expect(convo.args).not.toHaveProperty('sessionKey'); // no claim to own: no caller context is resolved
    expect(typeof convo.args.send).toBe('function');
  });

  test.each([
    ['a customer-sourced row', { source: 'google_ads', from_phone: '+19415550100', to_phone: '+19415550101' }],
    ['a missing row', undefined],
  ])('refuses %s and builds nothing', async (_name, row) => {
    const made = jest.fn();
    await expect(LiveBrain.open({ callSid: CALL_SID, db: fakeDb(row).db, make: made })).rejects.toThrow('live_brain_not_sandbox');
    expect(made).not.toHaveBeenCalled();
  });

  test('refuses a conversation that is not in sandbox mode, whatever the caller passes', async () => {
    await expect(LiveBrain.open({
      callSid: CALL_SID,
      db: fakeDb(ROW).db,
      make: () => ({ sandbox: false, interrupt: jest.fn(), handlePrompt: jest.fn() }),
    })).rejects.toThrow('live_brain_not_sandbox');
  });

  test('refuses a blank CallSid before any read', async () => {
    const d = fakeDb({ source: VOICE_RELAY_SANDBOX_SOURCE });
    await expect(LiveBrain.open({ callSid: ' ', db: d.db, make: jest.fn() })).rejects.toThrow('live_brain_no_callsid');
    expect(d.db).not.toHaveBeenCalled();
  });

  test('the end/handoff callback answers "not sent", so no tool claims a transfer or a hangup', async () => {
    const { convo } = await open();
    expect(convo.args.endSession({ reason: 'agent_complete', captured: true })).toBe(false);
  });
});

describe('ask', () => {
  test('resolves with the turn\'s tokens joined, once the conversation\'s turn settles', async () => {
    const { brain, convo } = await open();
    await expect(brain.ask('When is my next visit?')).resolves.toBe('One moment. Your next visit is Tuesday.');
    expect(convo.prompts).toEqual(['When is my next visit?']);
  });

  test('two asks never mix their tokens', async () => {
    let n = 0;
    const { brain } = await open({ script: async (c) => { n += 1; c.send(`answer ${n}`, true); } });
    await expect(brain.ask('first')).resolves.toBe('answer 1');
    await expect(brain.ask('second')).resolves.toBe('answer 2');
  });

  test('a blank ask is not sent to the conversation', async () => {
    const { brain, convo } = await open();
    await expect(brain.ask('   ')).resolves.toBe(CLOSED_REPLY);
    expect(convo.handlePrompt).not.toHaveBeenCalled();
  });

  test('past the soft deadline it calls onSoft once, keeps waiting, and the late answer is the answer', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { brain, convo } = await open({
      softMs: 15,
      deadlineMs: 5000,
      script: async (c) => { c.send('Let me see. ', false); await gate; c.send('Tuesday at nine.', true); },
    });
    const onSoft = jest.fn();
    const pending = brain.ask('slow question', { onSoft });
    await new Promise((r) => setTimeout(r, 60));
    expect(onSoft).toHaveBeenCalledTimes(1);
    expect(brain.softTimeouts).toBe(1);
    release();
    await expect(pending).resolves.toBe('Let me see. Tuesday at nine.');
    expect(brain.hardTimeouts).toBe(0);
    expect(convo.interrupt).not.toHaveBeenCalled();
  });

  test('an ask that finishes before the soft deadline never calls onSoft', async () => {
    const { brain } = await open({ softMs: 30 });
    const onSoft = jest.fn();
    await brain.ask('quick', { onSoft });
    await new Promise((r) => setTimeout(r, 60));
    expect(onSoft).not.toHaveBeenCalled();
    expect(brain.softTimeouts).toBe(0);
  });

  test('a throwing onSoft never fails the ask', async () => {
    const { brain } = await open({ softMs: 5, script: async (c) => { await new Promise((r) => setTimeout(r, 30)); c.send('done', true); } });
    await expect(brain.ask('q', { onSoft: () => { throw new Error('x'); } })).resolves.toBe('done');
  });

  test('past the hard deadline it answers the office sentence, counts it, aborts the round and drops late tokens', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { brain, convo } = await open({
      softMs: 10,
      deadlineMs: 40,
      script: async (c) => { c.send('Let me see. ', false); await gate; c.send('late words', true); },
    });
    const onSoft = jest.fn();
    await expect(brain.ask('slow question', { onSoft })).resolves.toBe(TIMEOUT_REPLY);
    expect(TIMEOUT_REPLY).toBe("I can't pull that up right now. You can call or text the office for that.");
    expect(TIMEOUT_REPLY).not.toMatch(/confirm|call you|get back/i); // no promise the system does not file
    expect(onSoft).toHaveBeenCalledTimes(1);
    expect(brain.softTimeouts).toBe(1);
    expect(brain.hardTimeouts).toBe(1);
    expect(convo.interrupt).toHaveBeenCalledTimes(1);
    // The conversation is retired: ended (queued turns stop), never asked again.
    expect(convo.ended).toBe(true);
    release();
    await new Promise((r) => setImmediate(r));
    // the old turn's late tokens reach no later ask, and the later ask never reaches the conversation
    await expect(brain.ask('next question')).resolves.toBe(TIMEOUT_REPLY);
    expect(convo.handlePrompt).toHaveBeenCalledTimes(1);
    expect(brain.lastRan).toBe(false); // the retired brain ran nothing for this ask
  });

  test('usage counts the model rounds each ask started (counts only), timed-out asks included', async () => {
    const { brain, convo } = await open({
      script: async (c) => {
        c._turnStats = [...(c._turnStats || []), { rounds: 3, tools: [] }];
        c.send('ok', true);
      },
    });
    convo._turnStats = [{ rounds: 1, tools: [] }]; // an earlier turn: not part of this ask
    await brain.ask('first');
    expect(brain.lastUsage).toEqual({ rounds: 3 });
    expect(brain.usage()).toEqual({ rounds: 4 });
    convo.handlePrompt.mockImplementationOnce(async () => { convo._turnStats.push({ rounds: 2, tools: [] }); convo.send('again', true); });
    await brain.ask('second');
    expect(brain.lastUsage).toEqual({ rounds: 2 });
  });

  test('lastRan is true only for an ask that reached the conversation', async () => {
    const { brain } = await open();
    await brain.ask('hello');
    expect(brain.lastRan).toBe(true);
    await brain.end('twilio_stop');
    await brain.ask('after end');
    expect(brain.lastRan).toBe(false);
  });

  test('a second ask that starts before the first settles waits its turn: tokens never cross', async () => {
    const order = [];
    let releaseFirst;
    const { brain } = await open({
      script: async (c) => {
        const n = c.prompts.length;
        order.push(`start ${n}`);
        if (n === 1) await new Promise((resolve) => { releaseFirst = resolve; });
        c.send(`answer ${n}`, true);
        order.push(`end ${n}`);
      },
    });
    const first = brain.ask('one');
    const second = brain.ask('two'); // starts while the first is running
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start 1']); // the second has not reached the conversation
    releaseFirst();
    await expect(first).resolves.toBe('answer 1');
    await expect(second).resolves.toBe('answer 2');
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  test('the default deadlines are 6 s soft and 20 s hard', () => {
    expect(SOFT_DEADLINE_MS).toBe(6000);
    expect(ASK_DEADLINE_MS).toBe(20000);
  });

  test('a conversation that fails the turn rejects, and logs no reply text', async () => {
    const { brain } = await open({ script: async () => { throw new Error('boom with caller words'); } });
    await expect(brain.ask('hello')).rejects.toThrow('live_brain_turn_failed');
  });
});

describe('end', () => {
  test('stops the conversation without RelayConversation.end() (it would store the transcript) and is idempotent', async () => {
    const { brain, convo } = await open();
    convo.end = jest.fn();
    await brain.end('bridge_closed');
    await brain.end('bridge_closed');
    expect(convo.end).not.toHaveBeenCalled();
    expect(convo.ended).toBe(true);
    expect(convo.interrupt).toHaveBeenCalledTimes(1);
    await expect(brain.ask('after the end')).resolves.toBe(CLOSED_REPLY);
    expect(convo.handlePrompt).not.toHaveBeenCalled();
  });

  test('an ask in flight when the call ends resolves at once with the closed sentence', async () => {
    const { brain } = await open({ script: () => new Promise(() => {}), deadlineMs: 60000 });
    const pending = brain.ask('long one');
    await new Promise((r) => setImmediate(r));
    await brain.end('twilio_stop');
    await expect(pending).resolves.toBe(CLOSED_REPLY);
    expect(brain.hardTimeouts).toBe(0);
  });
});
