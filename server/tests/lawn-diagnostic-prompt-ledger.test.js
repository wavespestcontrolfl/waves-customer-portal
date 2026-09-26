// runDiagnosis / runNarrative (lawn-diagnostic-prompt.js) are direct Anthropic
// SDK calls (client.messages.create), unlike the dispatchWithFallback-based
// sites elsewhere. Codex reviewer finding on #4884: neither ran through
// ledgerCall (the coverage test's KNOWN_UNWRAPPED exemption for this file
// wrongly attributed the 2 unwrapped calls it counted to "Gemini and OpenAI
// legs", which are raw fetches that never match that scanner — the 2 counted
// calls were these two Anthropic legs). This file locks in: both now run
// inside ledgerCall with the lane the switchboard already names for their
// model (lawn_diag_vision / lawn_diag_writer), and an unusable reply flips
// the row via ledgerCallRejected the same way runChallenge's does.
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

const mockLedgerCall = jest.fn((provider, model, fn) => fn());
const mockLedgerCallRejected = jest.fn();
jest.mock('../services/llm-dispatch-metrics', () => ({ ledgerCall: mockLedgerCall, ledgerCallRejected: mockLedgerCallRejected }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { runDiagnosis, runNarrative, runChallenge } = require('../services/lawn-diagnostic-prompt');
const ledgerCall = mockLedgerCall;
const ledgerCallRejected = mockLedgerCallRejected;

function textMessage(json, extra = {}) {
  return { content: [{ type: 'text', text: JSON.stringify(json) }], stop_reason: 'end_turn', model: 'claude-opus-4-8', ...extra };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runDiagnosis (PASS A, legacy single-call) — ledgerCall + reply-usability rejection', () => {
  const photos = [{ data: 'ZmFrZQ==', mimeType: 'image/jpeg' }];

  test('runs the Anthropic call inside ledgerCall under the lawn_diag_vision lane', async () => {
    mockMessagesCreate.mockResolvedValue(textMessage({ findings: [{ name: 'Browning along the edge', confidence: 'low' }] }));
    const out = await runDiagnosis({ photos });
    expect(out.ok).toBe(true);
    expect(ledgerCall).toHaveBeenCalledTimes(1);
    expect(ledgerCall.mock.calls[0][0]).toBe('anthropic');
    expect(ledgerCall.mock.calls[0][3]).toEqual({ laneId: 'lawn_diag_vision' });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test('a reply with no parseable JSON fails the row as invalid_json', async () => {
    mockMessagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn' });
    const out = await runDiagnosis({ photos });
    expect(out).toEqual({ ok: false, reason: 'empty_response' });
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_json');
  });

  test('a refusal never double-flips the row (already a failed row via ledgerCall itself)', async () => {
    mockMessagesCreate.mockResolvedValue({ content: [], stop_reason: 'refusal' });
    const out = await runDiagnosis({ photos });
    expect(out).toEqual({ ok: false, reason: 'empty_response' });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test('every finding malformed (name missing) fails the row as schema_invalid and returns no_findings', async () => {
    mockMessagesCreate.mockResolvedValue(textMessage({ findings: [{}] }));
    const out = await runDiagnosis({ photos });
    expect(out).toEqual({ ok: false, reason: 'no_findings' });
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });
});

describe('runNarrative (PASS B, live via lawn-diagnostic-analyze.js writer fallback) — ledgerCall + reply-usability rejection', () => {
  test('runs the Anthropic call inside ledgerCall under the lawn_diag_writer lane', async () => {
    mockMessagesCreate.mockResolvedValue(textMessage({ customer_summary: 'A calm, specific summary.' }));
    const out = await runNarrative({}, {});
    expect(out).toEqual({ ok: true, customer_summary: 'A calm, specific summary.' });
    expect(ledgerCall).toHaveBeenCalledTimes(1);
    expect(ledgerCall.mock.calls[0][0]).toBe('anthropic');
    expect(ledgerCall.mock.calls[0][3]).toEqual({ laneId: 'lawn_diag_writer' });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  test('unparseable JSON fails the row as invalid_json', async () => {
    mockMessagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn' });
    const out = await runNarrative({}, {});
    expect(out).toEqual({ ok: false, reason: 'empty_summary' });
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_json');
  });

  test('valid JSON with a blank/missing customer_summary fails the row as invalid_output', async () => {
    mockMessagesCreate.mockResolvedValue(textMessage({ customer_summary: '   ' }));
    const out = await runNarrative({}, {});
    expect(out).toEqual({ ok: false, reason: 'empty_summary' });
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_output');
  });

  test('a refusal never double-flips the row', async () => {
    mockMessagesCreate.mockResolvedValue({ content: [], stop_reason: 'refusal' });
    const out = await runNarrative({}, {});
    expect(out).toEqual({ ok: false, reason: 'empty_summary' });
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});

describe('runChallenge (Stage 2, live) — drops malformed findings but still fails the row', () => {
  const perception = { observations: [{ area: 'front lawn', color: 'brown', pattern: 'irregular', distribution: 'one section' }] };

  test('a mix of on-contract and malformed findings keeps the good ones AND fails the row', async () => {
    mockMessagesCreate.mockResolvedValue(textMessage({
      findings: [
        { name: 'Browning along the edge', confidence: 'low', severity: 'mild', urgency: 'monitor' },
        { name: { unexpected: 'object' }, confidence: 'certain' },
      ],
    }));
    const out = await runChallenge(perception, {});
    expect(out.ok).toBe(true);
    expect(out.findings).toEqual([{ name: 'Browning along the edge', confidence: 'low', severity: 'mild', urgency: 'monitor' }]);
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
  });

  test('a fully on-contract answer never flips the row', async () => {
    mockMessagesCreate.mockResolvedValue(textMessage({
      findings: [{ name: 'Browning along the edge', confidence: 'low' }],
    }));
    const out = await runChallenge(perception, {});
    expect(out.ok).toBe(true);
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});
