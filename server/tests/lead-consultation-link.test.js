/**
 * buildLeadConsultationLink / consultationUrlForLead
 * (services/lead-consultation-link.js) — composer-contract shape
 * ({ url, line, reason }), gate-off dark-ship behavior, and the no-phone /
 * missing-lead / no-secret reasons (lead-inspection-link-scope.md §4).
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.wavespestcontrol.com' }));
jest.mock('../services/short-url', () => ({
  createShortCode: jest.fn(async () => ({ code: 'abc123', shortUrl: 'https://waves.link/l/abc123' })),
}));

let mockBuilders = {};
const mockDb = jest.fn((table) => mockBuilders[table]);
jest.mock('../models/db', () => mockDb);

function chainBuilder({ firstRow = null } = {}) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.first = jest.fn(async () => firstRow);
  return b;
}

const { createShortCode } = require('../services/short-url');
const {
  buildLeadConsultationLink,
  consultationUrlForLead,
  consultationSmsLineFor,
} = require('../services/lead-consultation-link');

const LEAD_ID = '3f2f7b9c-1111-4222-8333-abcdefabcdef';
const originalGate = process.env.GATE_LEAD_INSPECTION_LINK;
const originalSecret = process.env.LEAD_PREFILL_SECRET;
const originalJwt = process.env.JWT_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.mockClear();
  process.env.GATE_LEAD_INSPECTION_LINK = 'true';
  process.env.LEAD_PREFILL_SECRET = 'test-prefill-secret';
});

afterEach(() => {
  if (originalGate === undefined) delete process.env.GATE_LEAD_INSPECTION_LINK;
  else process.env.GATE_LEAD_INSPECTION_LINK = originalGate;
  if (originalSecret === undefined) delete process.env.LEAD_PREFILL_SECRET;
  else process.env.LEAD_PREFILL_SECRET = originalSecret;
  if (originalJwt === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwt;
});

describe('buildLeadConsultationLink — gate off', () => {
  test('returns url:null with a reason and never touches the DB', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'false';
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toMatch(/switched off/i);
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('any spelling other than exactly "true" is off (strict compare, per house style)', async () => {
    process.env.GATE_LEAD_INSPECTION_LINK = 'TRUE';
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
  });
});

describe('buildLeadConsultationLink — gate on', () => {
  test('mints a short-wrapped consultation link with the composer line shape', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100' } }) };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBe('https://waves.link/l/abc123');
    // The bearer-token long URL never rides the line itself.
    expect(result.line).not.toContain('/inspection/');
    expect(result.line).toBe(`Pick a time for us to stop by for a free consultation: ${result.url}\n\n`);
    expect(result.line.endsWith('\n\n')).toBe(true);
    expect(createShortCode).toHaveBeenCalledWith(
      expect.stringContaining(`/inspection/${LEAD_ID}.`),
      expect.objectContaining({ kind: 'consultation', leadId: LEAD_ID, expiresAt: expect.any(Date) })
    );
  });

  test('fails closed when the short code cannot be minted (never passes the token URL through)', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100' } }) };
    createShortCode.mockRejectedValueOnce(new Error('short_codes insert failed'));
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.line).toBe('');
    expect(result.reason).toBeTruthy();
  });

  test('accepts a lead object and re-resolves it from the DB (never trusts the passed-in row)', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100' } }) };
    const result = await buildLeadConsultationLink({ id: LEAD_ID, phone: 'stale-should-be-ignored' });
    expect(result.url).toBeTruthy();
    expect(mockDb).toHaveBeenCalledWith('leads');
  });

  test('missing lead (deleted or nonexistent) returns a reason, no link', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: null }) };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/not found/i);
  });

  test('lead with no phone returns a reason, no link', async () => {
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: null } }) };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/no phone/i);
  });

  test('no signing secret configured fails closed with a reason', async () => {
    delete process.env.LEAD_PREFILL_SECRET;
    delete process.env.JWT_SECRET;
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100' } }) };
    const result = await buildLeadConsultationLink(LEAD_ID);
    expect(result.url).toBeNull();
    expect(result.reason).toMatch(/secret/i);
  });

  test('no lead id at all returns a reason without hitting the DB', async () => {
    const result = await buildLeadConsultationLink(null);
    expect(result.url).toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });

  // Round 11 — Codex pre-push P1, 2026-09-24: an explicit { channel: 'sms' }
  // option rides into the minted token (createShortCode receives the LONG
  // url, so its own 4-segment token is directly observable here).
  // Codex #4737 r1 P1 follow-through: 'sms' is signed as the PHONE-BOUND
  // claim, the exact form the booking route's verifier accepts.
  test('{ channel: "sms" } mints the phone-bound claim for the fresh row\'s phone', async () => {
    const { verifyLeadConsultationToken, smsChannelFor } = require('../utils/lead-consultation-token');
    mockBuilders = { leads: chainBuilder({ firstRow: { id: LEAD_ID, phone: '+19415550100' } }) };
    await buildLeadConsultationLink(LEAD_ID, { channel: 'sms' });
    const longUrl = createShortCode.mock.calls[0][0];
    const verified = verifyLeadConsultationToken(longUrl.split('/inspection/')[1]);
    expect(verified).toEqual({ leadId: LEAD_ID, channel: smsChannelFor('9415550100') });
  });
});

describe('consultationUrlForLead', () => {
  test('returns the long URL directly (no short-url wrap)', () => {
    const url = consultationUrlForLead(LEAD_ID);
    expect(url).toMatch(new RegExp(`^https://portal\\.wavespestcontrol\\.com/inspection/${LEAD_ID}\\.\\d+\\.[A-Za-z0-9_-]+$`));
  });

  test('fails closed (null) with no signing secret', () => {
    delete process.env.LEAD_PREFILL_SECRET;
    delete process.env.JWT_SECRET;
    expect(consultationUrlForLead(LEAD_ID)).toBeNull();
  });

  // Round 11 — Codex pre-push P1, 2026-09-24: the optional channel claim
  // (the PR4 SMS send's evidence that THIS link reached the lead's own
  // phone) threads through to the minted token.
  test('an explicit channel mints a token carrying it', () => {
    const url = consultationUrlForLead(LEAD_ID, 'sms');
    expect(url).toMatch(new RegExp(`^https://portal\\.wavespestcontrol\\.com/inspection/${LEAD_ID}\\.\\d+\\.sms\\.[A-Za-z0-9_-]+$`));
  });

  test('no channel passed → the plain 3-segment token, unchanged from every other caller', () => {
    const url = consultationUrlForLead(LEAD_ID);
    expect(url.split('/inspection/')[1].split('.')).toHaveLength(3);
  });
});

describe('consultationSmsLineFor', () => {
  test('empty url yields empty line', () => {
    expect(consultationSmsLineFor(null)).toBe('');
    expect(consultationSmsLineFor('')).toBe('');
  });
});
