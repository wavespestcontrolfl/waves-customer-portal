/**
 * A voice-agent sandbox call (call_log.source='voice_relay_sandbox', proven
 * at ws upgrade) is a DRY RUN: the transcript and latency record land on its
 * own call_log row, but no lead, re-service ticket or booking request is ever
 * written — a profile bake-off or a stranger dialling the test number cannot
 * create dispatch work (codex r1 P1 on #3852). Every KPI that counts inbound
 * calls drops the sandbox rows through one shared modifier.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));

const db = require('../models/db');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');
const { executeTool, SANDBOX_DRY_RUN_TOOLS, TOOLS, CONTEXT_TOOLS, BOOKING_TOOLS } = require('../services/voice-agent/relay-tools');
const { RelayConversation } = require('../services/voice-agent/relay-conversation');
const { whereNotSandboxCall, VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');

describe('executeTool on a sandbox session', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([...SANDBOX_DRY_RUN_TOOLS])('%s is answered dry — nothing runs, nothing is written', async (name) => {
    const out = await executeTool(name, { anything: 'x' }, { sandbox: true, callSid: 'CA-sb-1', from: '+19415551234' });
    expect(out).toMatch(/Sandbox test call/);
    expect(out).toMatch(new RegExp(name + ' was NOT run'));
    expect(out).toMatch(/nothing was written/);
    expect(db).not.toHaveBeenCalled();
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
  });

  test('the gate covers every tool that writes outside the call_log row', () => {
    expect([...SANDBOX_DRY_RUN_TOOLS].sort()).toEqual(['capture_lead', 'request_booking', 'request_reservice']);
    const registered = [...TOOLS, ...CONTEXT_TOOLS, ...BOOKING_TOOLS].map((t) => t.name);
    for (const name of SANDBOX_DRY_RUN_TOOLS) expect(registered).toContain(name);
  });

  test('a production session (no flag, or a non-boolean one) is untouched by the gate', async () => {
    // capture_lead with no callback number returns its own no-number answer — proof the gate did not fire.
    for (const ctx of [{ callSid: 'CA-1' }, { callSid: 'CA-1', sandbox: 'true' }]) {
      const out = await executeTool('capture_lead', {}, ctx);
      expect(out).not.toMatch(/Sandbox test call/);
    }
  });
});

describe('RelayConversation.sandbox', () => {
  test('defaults false and only a boolean true sets it; the tool ctx carries it', () => {
    const plain = new RelayConversation({ callSid: 'CA-1', from: '+19415551234', send: jest.fn() });
    expect(plain.sandbox).toBe(false);
    expect(plain._buildToolCtx().sandbox).toBe(false);
    const forged = new RelayConversation({ callSid: 'CA-1', from: '+19415551234', send: jest.fn(), sandbox: 'true' });
    expect(forged.sandbox).toBe(false);
    const sb = new RelayConversation({ callSid: 'CA-sb-1', from: '+19415551234', send: jest.fn(), sandbox: true });
    expect(sb.sandbox).toBe(true);
    expect(sb._buildToolCtx().sandbox).toBe(true);
  });

  test('the hangup capture floor stays down on a sandbox call', async () => {
    const sb = new RelayConversation({ callSid: 'CA-sb-2', from: '+19415551234', send: jest.fn(), sandbox: true });
    await sb._runCaptureFloor('hangup');
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });
});

describe('every call reader drops the sandbox source', () => {
  const fs = require('fs');
  const path = require('path');
  test.each([
    'routes/admin-dashboard.js',
    'routes/ai-assistant.js',
    'services/seo/conversion-feedback-miner.js',
    'services/call-research-miner.js',
    'services/sms-voice-corpus-miner.js',
    'services/content/customer-insights-miner.js',
    'services/context-aggregator.js',
    'services/call-self-audit.js',
    'services/voice-agent/relay-history.js',
    'services/seo/site-rollup.js',
    'services/intelligence-bar/comms-tools.js',
  ])('%s applies whereNotSandboxCall', (rel) => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(src).toMatch(/whereNotSandboxCall\(/);
  });
});

describe('whereNotSandboxCall', () => {
  test('binds the column as an identifier and the source as a value', () => {
    const qb = { whereRaw: jest.fn().mockReturnThis() };
    expect(whereNotSandboxCall(qb)).toBe(qb);
    expect(qb.whereRaw).toHaveBeenCalledWith("COALESCE(??, '') <> ?", ['source', VOICE_RELAY_SANDBOX_SOURCE]);
    whereNotSandboxCall(qb, 'c.source');
    expect(qb.whereRaw).toHaveBeenLastCalledWith("COALESCE(??, '') <> ?", ['c.source', VOICE_RELAY_SANDBOX_SOURCE]);
  });
});
