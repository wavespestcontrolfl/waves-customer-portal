/**
 * Compliance-judge contract: strict-JSON verdict parsing, kill switch, and
 * fail-open dispatch handling. The LLM itself is mocked — semantic quality
 * rides the fastStructured cross-provider policy.
 */

jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({})));

const { dispatchWithFallback } = require('../services/llm/call');
const { judgeSocialCopy, parseVerdict } = require('../services/social-compliance-judge');

describe('parseVerdict', () => {
  it('parses strict verdicts and clamps violations', () => {
    expect(parseVerdict('{"compliant": true}')).toEqual({ compliant: true, violations: [] });
    expect(parseVerdict('noise {"compliant": false, "violations": ["pet-safe claim"]} trailing'))
      .toEqual({ compliant: false, violations: ['pet-safe claim'] });
  });
  it('rejects non-verdicts', () => {
    expect(parseVerdict('sure, looks fine!')).toBeNull();
    expect(parseVerdict('{"complaint": true}')).toBeNull();
  });
});

describe('judgeSocialCopy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SOCIAL_COMPLIANCE_JUDGE;
  });

  it('returns the parsed verdict on a successful dispatch', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"compliant": false, "violations": ["fixed drying time"]}' });
    const v = await judgeSocialCopy('dries in 30 minutes');
    expect(v).toEqual({ ok: true, compliant: false, violations: ['fixed drying time'] });
  });

  it('fails OPEN when the dispatcher cannot deliver', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'both providers down' });
    const v = await judgeSocialCopy('some copy');
    expect(v.ok).toBe(false);
  });

  it('fails OPEN on thrown errors', async () => {
    dispatchWithFallback.mockRejectedValue(new Error('boom'));
    const v = await judgeSocialCopy('some copy');
    expect(v.ok).toBe(false);
  });

  it('kill switch disables the LLM pass entirely', async () => {
    process.env.SOCIAL_COMPLIANCE_JUDGE = 'false';
    const v = await judgeSocialCopy('some copy');
    expect(v.ok).toBe(false);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  it('empty copy is trivially compliant without a dispatch', async () => {
    const v = await judgeSocialCopy('   ');
    expect(v).toEqual({ ok: true, compliant: true, violations: [] });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});
