// Codex r16 on #4884: a parseable but off-contract primary (OpenAI) answer was
// returned even after its ledger row was failed, so the caller rejected it at
// the same gate and the Claude fallback never got its turn.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return { ...actual, dispatch: jest.fn(), rejectCall: jest.fn() };
});

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));

const { dispatch, rejectCall } = require('../services/llm/call');
const { _test: { callClaude } } = require('../services/knowledge-bridge');

const GOOD = { summary: 'Lawn is recovering.', recommendations: [{ priority: 1, action: 'Water deeply twice a week.', reason: 'Dry spots', timeframe: 'Next 2 weeks' }], nextVisitFocus: 'Dry spots', customerTip: 'Water early.' };

describe('knowledge-bridge callClaude', () => {
  beforeEach(() => { dispatch.mockReset(); rejectCall.mockClear(); mockCreate.mockReset(); });

  test('a usable primary answer is returned without calling the fallback', async () => {
    dispatch.mockResolvedValue({ ok: true, json: GOOD });
    expect(JSON.parse(await callClaude('sys', 'user'))).toEqual(GOOD);
    expect(rejectCall).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('an off-contract primary answer fails its row and the Claude fallback answers', async () => {
    dispatch.mockResolvedValue({ ok: true, json: { recommendations: [{}] } });
    mockCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(GOOD) }] });
    expect(JSON.parse(await callClaude('sys', 'user'))).toEqual(GOOD);
    expect(rejectCall).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
