/**
 * The estimate.engage_gone_quiet follow-up email's "Rather have us come look
 * first?" link (services/estimate-email-consultation-offer.js), in two steps
 * placed by the engine around its own send checks (Codex #4918 r7–r14):
 *
 *   - probeGoneQuietConsultation(estimateId): the slow step (shared
 *     eligibility + slot probe), once a job has passed every engine check.
 *     A context for an eligible lead, else null. Never mints, and never
 *     judges a recipient from its pre-probe row.
 *   - mintGoneQuietConsultationUrl(context): after the engine's claim — the
 *     short URL, else ''.
 *   - goneQuietConsultationStillValid(context, recipientEmail): the
 *     probe-free re-judge and the lead's-own-inbox rule against the send's
 *     recipient, run by the engine together with its own final reads.
 *
 * Both fail closed and never throw: the caller sends the email either way.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockEstimateEmailConsultationOfferLive = jest.fn();
jest.mock('../config/feature-gates', () => ({
  estimateEmailConsultationOfferLive: (...args) => mockEstimateEmailConsultationOfferLive(...args),
}));

const mockEstimateConsultationLead = jest.fn();
const mockReconfirmConsultationLead = jest.fn();
jest.mock('../services/estimate-consultation-offer', () => ({
  estimateConsultationLead: (...args) => mockEstimateConsultationLead(...args),
  reconfirmConsultationLead: (...args) => mockReconfirmConsultationLead(...args),
  PROBE_BUDGET_MS: 3000,
}));

const mockConsultationUrlForLead = jest.fn();
jest.mock('../services/lead-consultation-link', () => ({
  consultationUrlForLead: (...args) => mockConsultationUrlForLead(...args),
}));

const mockShortWrap = jest.fn();
const mockRecipientIsLead = jest.fn();
jest.mock('../services/lead-consultation-email-block', () => ({
  shortWrap: (...args) => mockShortWrap(...args),
  recipientIsLead: (...args) => mockRecipientIsLead(...args),
}));

const mockIsEstimateAcceptActive = jest.fn();
jest.mock('../routes/estimate-public', () => ({
  isEstimateAcceptActive: (...args) => mockIsEstimateAcceptActive(...args),
}));

let mockEstimateRow;
const mockEstimateReads = [];
jest.mock('../models/db', () => jest.fn((table) => {
  const b = {};
  b.where = jest.fn((arg) => { mockEstimateReads.push({ table, where: arg }); return b; });
  b.first = jest.fn(async () => {
    if (mockEstimateRow instanceof Error) throw mockEstimateRow;
    return mockEstimateRow;
  });
  return b;
}));

const logger = require('../services/logger');
const {
  probeGoneQuietConsultation,
  mintGoneQuietConsultationUrl,
  goneQuietConsultationStillValid,
  PROBE_BUDGET_MS,
} = require('../services/estimate-email-consultation-offer');

const LEAD = { id: 'lead-1', email: 'taylor@example.com' };
const ESTIMATE_DATA = { lead_id: 'lead-1', lead_linkage: 'sid' };
const CONTEXT = { estimateId: 'est-1', leadId: 'lead-1', probedAddress: { line1: '123 Palm St' } };
const SHORT_URL = 'https://portal.wavespestcontrol.com/l/abc123';
const LONG_URL = 'https://portal.wavespestcontrol.com/inspection/long-token';

function estimateRow(overrides = {}) {
  return {
    id: 'est-1',
    address: '123 Palm St, Bradenton, FL 34205',
    customer_email: 'taylor@example.com',
    estimate_data: JSON.stringify(ESTIMATE_DATA),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEstimateReads.length = 0;
  mockEstimateRow = estimateRow();
  mockEstimateEmailConsultationOfferLive.mockReturnValue(true);
  mockIsEstimateAcceptActive.mockReturnValue(true);
  // The shared helper fills the caller's context on an eligible result.
  mockEstimateConsultationLead.mockImplementation(async ({ context }) => {
    Object.assign(context, CONTEXT);
    return LEAD;
  });
  mockReconfirmConsultationLead.mockResolvedValue(LEAD);
  mockRecipientIsLead.mockReturnValue(true);
  mockConsultationUrlForLead.mockReturnValue(LONG_URL);
  mockShortWrap.mockResolvedValue(SHORT_URL);
});

describe('probeGoneQuietConsultation — the slow step, once the engine\'s checks pass', () => {
  test('eligible lead → the context the helper recorded; nothing minted, no recipient judged', async () => {
    const context = await probeGoneQuietConsultation('est-1');

    expect(context).toEqual(CONTEXT);
    expect(mockEstimateReads).toEqual([{ table: 'estimates', where: { id: 'est-1' } }]);
    expect(mockEstimateConsultationLead).toHaveBeenCalledWith({
      estimate: mockEstimateRow,
      estimateData: ESTIMATE_DATA, // parsed from the row's JSON string
      acceptActive: true,
      context: expect.any(Object),
    });
    expect(mockIsEstimateAcceptActive).toHaveBeenCalledWith(mockEstimateRow);
    expect(mockRecipientIsLead).not.toHaveBeenCalled();
    expect(mockConsultationUrlForLead).not.toHaveBeenCalled();
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('the page\'s own accept-active verdict (status, expiry, off-surface holds) is what the shared helper gets', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(false);
    mockEstimateConsultationLead.mockResolvedValue(null); // the helper refuses an inactive estimate
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    expect(mockEstimateConsultationLead).toHaveBeenCalledWith(expect.objectContaining({ acceptActive: false }));
  });

  test('gate off → null: no estimate read, no eligibility, no probe', async () => {
    mockEstimateEmailConsultationOfferLive.mockReturnValue(false);
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    expect(mockEstimateReads).toHaveLength(0);
    expect(mockEstimateConsultationLead).not.toHaveBeenCalled();
  });

  test('no estimate id, the estimate row is gone, or it has no email to send to → null, no probe spent', async () => {
    expect(await probeGoneQuietConsultation(null)).toBeNull();
    mockEstimateRow = undefined;
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    mockEstimateRow = estimateRow({ customer_email: null });
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    expect(mockEstimateConsultationLead).not.toHaveBeenCalled();
  });

  test('ineligible (the shared helper returns no lead) → null, recipient never judged', async () => {
    mockEstimateConsultationLead.mockResolvedValue(null);
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    expect(mockRecipientIsLead).not.toHaveBeenCalled();
  });

  test('the recipient is never judged from the pre-probe row — the second step judges the actual send\'s recipient on fresh state', async () => {
    mockEstimateRow = estimateRow({ customer_email: 'someone-else@example.com' });
    mockRecipientIsLead.mockReturnValue(false);
    expect(await probeGoneQuietConsultation('est-1')).toEqual(CONTEXT);
    expect(mockRecipientIsLead).not.toHaveBeenCalled();
  });

  test('any throw (estimate read, shared helper) fails closed → null, logged by id and error name only — never the message (a geocoder message can carry an address)', async () => {
    mockEstimateRow = new Error('db exploded');
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    mockEstimateRow = estimateRow();
    mockEstimateConsultationLead.mockRejectedValue(new Error('geocode failed for 123 Palm St'));
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    for (const [line] of logger.warn.mock.calls) {
      expect(line).toContain('est-1');
      expect(line).not.toMatch(/exploded|Palm/);
    }
  });

  test('the gate is read fresh on every call — a mid-run flip changes the very next result', async () => {
    expect(await probeGoneQuietConsultation('est-1')).toEqual(CONTEXT);
    mockEstimateEmailConsultationOfferLive.mockReturnValue(false);
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    expect(mockEstimateConsultationLead).toHaveBeenCalledTimes(1);
  });
});

describe('mintGoneQuietConsultationUrl — after the engine\'s claim', () => {
  test('an email-channel, short-wrapped URL with the 14-day TTL; no eligibility read of its own', async () => {
    const url = await mintGoneQuietConsultationUrl(CONTEXT);

    expect(url).toBe(SHORT_URL);
    // Channel 'email', never 'sms' — an email send is not phone-delivery evidence.
    expect(mockConsultationUrlForLead).toHaveBeenCalledWith('lead-1', 'email');
    expect(mockShortWrap).toHaveBeenCalledWith(LONG_URL, 'lead-1', expect.any(Date));
    const days = (mockShortWrap.mock.calls[0][2].getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    expect(mockReconfirmConsultationLead).not.toHaveBeenCalled();
  });

  test('no context, gate off, or no signed URL → "", nothing minted', async () => {
    expect(await mintGoneQuietConsultationUrl(null)).toBe('');
    expect(await mintGoneQuietConsultationUrl({})).toBe('');
    mockEstimateEmailConsultationOfferLive.mockReturnValue(false);
    expect(await mintGoneQuietConsultationUrl(CONTEXT)).toBe('');
    mockEstimateEmailConsultationOfferLive.mockReturnValue(true);
    mockConsultationUrlForLead.mockReturnValue(null);
    expect(await mintGoneQuietConsultationUrl(CONTEXT)).toBe('');
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('createShortCode throwing or returning nothing → "" — the long bearer URL never rides the email; logged without the message', async () => {
    mockShortWrap.mockRejectedValue(new Error('insert failed for 123 Palm St'));
    expect(await mintGoneQuietConsultationUrl(CONTEXT)).toBe('');
    expect(logger.warn.mock.calls[0][0]).not.toMatch(/Palm/);
    mockShortWrap.mockResolvedValue(null);
    expect(await mintGoneQuietConsultationUrl(CONTEXT)).toBe('');
  });

  test('only the short URL is ever returned — never the long bearer URL', async () => {
    mockConsultationUrlForLead.mockReturnValue('https://portal.wavespestcontrol.com/inspection/long-token-with-secret-bearer');
    const url = await mintGoneQuietConsultationUrl(CONTEXT);
    expect(url).toBe(SHORT_URL);
    expect(url).not.toContain('/inspection/');
  });
});

describe('goneQuietConsultationStillValid — run by the engine together with its final reads', () => {
  test('still eligible and still the lead\'s own inbox → true', async () => {
    expect(await goneQuietConsultationStillValid(CONTEXT, 'taylor@example.com')).toBe(true);
    expect(mockReconfirmConsultationLead).toHaveBeenCalledWith(CONTEXT);
    expect(mockRecipientIsLead).toHaveBeenCalledWith('taylor@example.com', LEAD);
  });

  test('eligibility lost since the probe (hold, linkage change, lead edit) → false', async () => {
    mockReconfirmConsultationLead.mockResolvedValue(null);
    expect(await goneQuietConsultationStillValid(CONTEXT, 'taylor@example.com')).toBe(false);
  });

  test('the send\'s recipient is not the lead\'s own inbox, or is missing → false (judged, never assumed)', async () => {
    mockRecipientIsLead.mockReturnValue(false);
    expect(await goneQuietConsultationStillValid(CONTEXT, 'new-owner@example.com')).toBe(false);
    expect(await goneQuietConsultationStillValid(CONTEXT, undefined)).toBe(false);
    expect(mockRecipientIsLead).toHaveBeenCalledWith(undefined, LEAD);
  });

  test('no context or gate off → false, nothing re-read', async () => {
    expect(await goneQuietConsultationStillValid(null, 'taylor@example.com')).toBe(false);
    mockEstimateEmailConsultationOfferLive.mockReturnValue(false);
    expect(await goneQuietConsultationStillValid(CONTEXT, 'taylor@example.com')).toBe(false);
    expect(mockReconfirmConsultationLead).not.toHaveBeenCalled();
  });

  test('the re-judge throwing fails closed → false, logged without the message', async () => {
    mockReconfirmConsultationLead.mockRejectedValue(new Error('lookup failed for 123 Palm St'));
    expect(await goneQuietConsultationStillValid(CONTEXT, 'taylor@example.com')).toBe(false);
    expect(logger.warn.mock.calls[0][0]).not.toMatch(/Palm/);
  });
});

test('the per-probe ceiling is passed through for the engine\'s batch budget', () => {
  expect(PROBE_BUDGET_MS).toBe(3000);
});
