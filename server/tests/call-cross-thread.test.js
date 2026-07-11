// Cross-call threading (2026-07-11): callers finish one arrangement across
// several calls (a realtor whose first call cut off mid-dictation of the
// seller's phone number; three calls in one morning completing one WDO
// booking; "my coworker called Monday"). The extractor now receives the
// prior call's summary + captured facts as continuation context.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildExtractionPrompt, buildPriorCallBlock, PROMPT_HASH } = require('../services/prompts/call-extraction-v1');
const { summarizePriorCall } = require('../services/call-recording-processor')._test;

const PRIOR = {
  hoursAgo: 18,
  summary: 'Realtor Kathy called to order a WDO inspection for a home she just sold; began dictating the seller/access contact when the call cut off.',
  captured: {
    name: 'Kathy Callahan',
    phone: '+19419008088',
    email: 'kcallahan@example.com',
    address: '4471 McIntosh Lake Avenue, Sarasota, 34233',
    requested_service: 'WDO Inspection',
    secondary_contact: 'Leslie Ferraro (home_buyer), lferraro@example.com',
    appointment: null,
  },
};

describe('buildPriorCallBlock', () => {
  test('renders the prior summary, captured facts, and the continuation rules', () => {
    const block = buildPriorCallBlock(PRIOR);
    expect(block).toContain('PRIOR CALL FROM THIS NUMBER (18h ago)');
    expect(block).toContain('Kathy Callahan');
    expect(block).toContain('Leslie Ferraro (home_buyer)');
    expect(block).toContain('CONTINUATION');
    expect(block).toContain('ONLY when the caller confirms or references it');
    expect(block).toContain('COMPLETED value');
  });

  test('null/absent prior renders nothing', () => {
    expect(buildPriorCallBlock(null)).toBe('');
    expect(buildPriorCallBlock(undefined)).toBe('');
  });
});

describe('buildExtractionPrompt threading', () => {
  test('prompt carries the prior-call block when provided', () => {
    const prompt = buildExtractionPrompt('Agent: hi', '+19419008088', '2026-07-11', { priorCall: PRIOR });
    expect(prompt).toContain('PRIOR CALL FROM THIS NUMBER');
    expect(prompt).toContain('4471 McIntosh Lake Avenue');
  });

  test('bare render (the version-hash input) is unchanged — no block, stable v3 hash', () => {
    const bare = buildExtractionPrompt('', '', '');
    expect(bare).not.toContain('PRIOR CALL FROM THIS NUMBER');
    expect(PROMPT_HASH).toMatch(/^v3-[a-f0-9]{12}$/);
  });
});

describe('summarizePriorCall', () => {
  function connMock(row) {
    const q = {};
    ['where', 'whereRaw', 'whereNotNull', 'whereNotIn', 'whereNot', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => row);
    const fn = jest.fn(() => q);
    fn.raw = jest.fn((s) => s);
    fn._q = q;
    return fn;
  }

  const V1_ROW = {
    id: 'prior-1',
    created_at: new Date(Date.now() - 20 * 3600 * 1000).toISOString(),
    call_summary: 'Realtor ordering a WDO inspection; cut off mid-dictation.',
    ai_extraction: JSON.stringify({
      first_name: 'Kathy', last_name: 'Callahan', phone: '+19419008088',
      email: 'kcallahan@example.com', address_line1: '4471 McIntosh Lake Avenue',
      city: 'Sarasota', zip: '34233', requested_service: 'WDO inspection',
      secondary_contact: { first_name: 'Leslie', last_name: 'Ferraro', role: 'home_buyer', email: 'lferraro@example.com' },
      appointment_confirmed: false, is_spam: false,
    }),
  };

  test('maps the prior extraction into a compact, PII-light context object', async () => {
    const conn = connMock(V1_ROW);
    const prior = await summarizePriorCall('+19419008088', 'current-call', conn);
    expect(prior.hoursAgo).toBeGreaterThanOrEqual(19);
    expect(prior.captured.name).toBe('Kathy Callahan');
    expect(prior.captured.address).toBe('4471 McIntosh Lake Avenue, Sarasota, 34233');
    expect(prior.captured.secondary_contact).toContain('Leslie Ferraro (home_buyer)');
    expect(prior.summary).toContain('cut off mid-dictation');
    // excludes the current call from the search
    expect(conn._q.whereNot).toHaveBeenCalledWith('id', 'current-call');
  });

  test('no prior call / short number / spam prior → null', async () => {
    expect(await summarizePriorCall('+19419008088', null, connMock(null))).toBeNull();
    expect(await summarizePriorCall('123', null, connMock(V1_ROW))).toBeNull();
    const spamRow = { ...V1_ROW, ai_extraction: JSON.stringify({ is_spam: true }) };
    expect(await summarizePriorCall('+19419008088', null, connMock(spamRow))).toBeNull();
  });

  test('a DB error fails open to null', async () => {
    const conn = connMock(null);
    conn._q.first = jest.fn(async () => { throw new Error('boom'); });
    expect(await summarizePriorCall('+19419008088', null, conn)).toBeNull();
  });
});
