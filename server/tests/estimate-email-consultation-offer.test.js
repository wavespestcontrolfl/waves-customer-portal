/**
 * The estimate.engage_gone_quiet follow-up email's "Rather have us come look
 * first?" link (services/estimate-email-consultation-offer.js), in two steps
 * split around the engine's own send checks (Codex #4918 r7–r12):
 *
 *   - probeGoneQuietConsultation(estimateId): the slow step (shared
 *     eligibility + slot probe), BEFORE the engine re-reads the estimate.
 *     A context for an eligible lead whose own email is the estimate's
 *     recipient, else null. Never mints.
 *   - finalizeGoneQuietConsultationUrl(context, recipientEmail): the last
 *     await before the send — mint, then the probe-free re-judge and the
 *     lead's-own-inbox rule against the send's recipient. The short URL,
 *     else ''.
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
  finalizeGoneQuietConsultationUrl,
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

describe('probeGoneQuietConsultation — the slow step, before the engine re-reads the estimate', () => {
  test('eligible lead whose own inbox is the estimate recipient → the context the helper recorded; nothing minted', async () => {
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
    expect(mockRecipientIsLead).toHaveBeenCalledWith('taylor@example.com', LEAD);
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

  test('the estimate\'s recipient is not the lead\'s own inbox → null (a recipient that can never qualify costs no mint later)', async () => {
    mockEstimateRow = estimateRow({ customer_email: 'someone-else@example.com' });
    mockRecipientIsLead.mockReturnValue(false);
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    expect(mockRecipientIsLead).toHaveBeenCalledWith('someone-else@example.com', LEAD);
  });

  test('any throw (estimate read, shared helper) fails closed → null, logged', async () => {
    mockEstimateRow = new Error('db exploded');
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    mockEstimateRow = estimateRow();
    mockEstimateConsultationLead.mockRejectedValue(new Error('probe exploded'));
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  test('the gate is read fresh on every call — a mid-run flip changes the very next result', async () => {
    expect(await probeGoneQuietConsultation('est-1')).toEqual(CONTEXT);
    mockEstimateEmailConsultationOfferLive.mockReturnValue(false);
    expect(await probeGoneQuietConsultation('est-1')).toBeNull();
    expect(mockEstimateConsultationLead).toHaveBeenCalledTimes(1);
  });
});

describe('finalizeGoneQuietConsultationUrl — the last step before the send', () => {
  test('happy path: an email-channel, short-wrapped URL with the 14-day TTL; re-judged against the send\'s recipient', async () => {
    const url = await finalizeGoneQuietConsultationUrl(CONTEXT, 'taylor@example.com');

    expect(url).toBe(SHORT_URL);
    // Channel 'email', never 'sms' — an email send is not phone-delivery evidence.
    expect(mockConsultationUrlForLead).toHaveBeenCalledWith('lead-1', 'email');
    expect(mockShortWrap).toHaveBeenCalledWith(LONG_URL, 'lead-1', expect.any(Date));
    const days = (mockShortWrap.mock.calls[0][2].getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    expect(mockReconfirmConsultationLead).toHaveBeenCalledWith(CONTEXT);
    expect(mockRecipientIsLead).toHaveBeenCalledWith('taylor@example.com', LEAD);
  });

  test('minted FIRST, re-judged LAST — nothing of this step awaits after the re-judge (Codex #4918 r9)', async () => {
    const order = [];
    mockShortWrap.mockImplementation(async () => { order.push('mint'); return SHORT_URL; });
    mockReconfirmConsultationLead.mockImplementation(async () => { order.push('reconfirm'); return LEAD; });
    await finalizeGoneQuietConsultationUrl(CONTEXT, 'taylor@example.com');
    expect(order).toEqual(['mint', 'reconfirm']);
  });

  test('eligibility lost since the probe (hold, linkage change, lead edit) → "" — the minted code is never returned', async () => {
    mockReconfirmConsultationLead.mockResolvedValue(null);
    expect(await finalizeGoneQuietConsultationUrl(CONTEXT, 'taylor@example.com')).toBe('');
  });

  test('the send\'s recipient is no longer the lead\'s own inbox → ""', async () => {
    mockRecipientIsLead.mockReturnValue(false);
    expect(await finalizeGoneQuietConsultationUrl(CONTEXT, 'new-owner@example.com')).toBe('');
    expect(mockRecipientIsLead).toHaveBeenCalledWith('new-owner@example.com', LEAD);
  });

  test('a missing recipient is judged, never assumed → ""', async () => {
    mockRecipientIsLead.mockReturnValue(false); // the real recipientIsLead(undefined, lead) is false
    expect(await finalizeGoneQuietConsultationUrl(CONTEXT, undefined)).toBe('');
    expect(mockRecipientIsLead).toHaveBeenCalledWith(undefined, LEAD);
  });

  test('no context (the probe found no offer) → "", nothing minted', async () => {
    expect(await finalizeGoneQuietConsultationUrl(null, 'taylor@example.com')).toBe('');
    expect(await finalizeGoneQuietConsultationUrl({}, 'taylor@example.com')).toBe('');
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('gate turned off since the probe → "", nothing minted', async () => {
    mockEstimateEmailConsultationOfferLive.mockReturnValue(false);
    expect(await finalizeGoneQuietConsultationUrl(CONTEXT, 'taylor@example.com')).toBe('');
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('no signed URL (no secret configured) → "", nothing minted', async () => {
    mockConsultationUrlForLead.mockReturnValue(null);
    expect(await finalizeGoneQuietConsultationUrl(CONTEXT, 'taylor@example.com')).toBe('');
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('createShortCode throwing or returning nothing → "" — the long bearer URL never rides the email', async () => {
    mockShortWrap.mockRejectedValue(new Error('short-wrap failed'));
    expect(await finalizeGoneQuietConsultationUrl(CONTEXT, 'taylor@example.com')).toBe('');
    mockShortWrap.mockResolvedValue(null);
    expect(await finalizeGoneQuietConsultationUrl(CONTEXT, 'taylor@example.com')).toBe('');
    expect(mockReconfirmConsultationLead).not.toHaveBeenCalled();
  });

  test('the re-judge throwing fails closed → ""', async () => {
    mockReconfirmConsultationLead.mockRejectedValue(new Error('db down'));
    expect(await finalizeGoneQuietConsultationUrl(CONTEXT, 'taylor@example.com')).toBe('');
  });

  test('only the short URL is ever returned — never the long bearer URL', async () => {
    const longUrl = 'https://portal.wavespestcontrol.com/inspection/long-token-with-secret-bearer';
    mockConsultationUrlForLead.mockReturnValue(longUrl);
    const url = await finalizeGoneQuietConsultationUrl(CONTEXT, 'taylor@example.com');
    expect(url).toBe(SHORT_URL);
    expect(url).not.toContain('long-token-with-secret-bearer');
    expect(url).not.toContain('/inspection/');
  });
});
