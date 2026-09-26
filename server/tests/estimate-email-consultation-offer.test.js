/**
 * buildGoneQuietConsultationUrl (services/estimate-email-consultation-offer.js)
 * — the estimate.engage_gone_quiet follow-up email's own "Rather have us
 * come look first?" link. Contract: '' for every ineligible/error case (the
 * caller always sends the email regardless), a short-wrapped, channel
 * 'email' consultation URL for an eligible lead whose OWN email is the
 * actual recipient.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockEstimateEmailConsultationOfferLive = jest.fn();
jest.mock('../config/feature-gates', () => ({
  estimateEmailConsultationOfferLive: (...args) => mockEstimateEmailConsultationOfferLive(...args),
}));

const mockEstimateConsultationLead = jest.fn();
jest.mock('../services/estimate-consultation-offer', () => ({
  estimateConsultationLead: (...args) => mockEstimateConsultationLead(...args),
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

const { buildGoneQuietConsultationUrl } = require('../services/estimate-email-consultation-offer');

const LEAD = { id: 'lead-1', email: 'taylor@example.com' };
const ESTIMATE = { id: 'est-1', address: '123 Palm St' };
const ESTIMATE_DATA = { lead_id: 'lead-1', lead_linkage: 'sid' };

function baseArgs(overrides = {}) {
  return {
    estimate: ESTIMATE,
    estimateData: ESTIMATE_DATA,
    acceptActive: true,
    recipientEmail: 'taylor@example.com',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEstimateEmailConsultationOfferLive.mockReturnValue(true);
  mockEstimateConsultationLead.mockResolvedValue(LEAD);
  mockRecipientIsLead.mockReturnValue(true);
  mockConsultationUrlForLead.mockReturnValue('https://portal.wavespestcontrol.com/inspection/long-token');
  mockShortWrap.mockResolvedValue('https://portal.wavespestcontrol.com/l/abc123');
});

describe('buildGoneQuietConsultationUrl — hidden cases', () => {
  test('gate off → "", never calls the shared eligibility', async () => {
    mockEstimateEmailConsultationOfferLive.mockReturnValue(false);
    expect(await buildGoneQuietConsultationUrl(baseArgs())).toBe('');
    expect(mockEstimateConsultationLead).not.toHaveBeenCalled();
  });

  test('ineligible lead (estimateConsultationLead null) → ""', async () => {
    mockEstimateConsultationLead.mockResolvedValue(null);
    expect(await buildGoneQuietConsultationUrl(baseArgs())).toBe('');
    expect(mockRecipientIsLead).not.toHaveBeenCalled();
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('recipient does not match the lead\'s own email → "", no short code minted', async () => {
    mockRecipientIsLead.mockReturnValue(false);
    expect(await buildGoneQuietConsultationUrl(baseArgs({ recipientEmail: 'someone-else@example.com' }))).toBe('');
    expect(mockConsultationUrlForLead).not.toHaveBeenCalled();
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('consultationUrlForLead returns no URL (no signing secret configured) → ""', async () => {
    mockConsultationUrlForLead.mockReturnValue(null);
    expect(await buildGoneQuietConsultationUrl(baseArgs())).toBe('');
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('estimateConsultationLead throwing → "", email must still send', async () => {
    mockEstimateConsultationLead.mockRejectedValue(new Error('db exploded'));
    expect(await buildGoneQuietConsultationUrl(baseArgs())).toBe('');
  });

  test('shortWrap (createShortCode) throwing → ""', async () => {
    mockShortWrap.mockRejectedValue(new Error('short-wrap failed'));
    expect(await buildGoneQuietConsultationUrl(baseArgs())).toBe('');
  });

  test('shortWrap resolving falsy → ""', async () => {
    mockShortWrap.mockResolvedValue(null);
    expect(await buildGoneQuietConsultationUrl(baseArgs())).toBe('');
  });

  test('recipientEmail missing entirely → "" — recipientIsLead still gets called with it, never skipped/assumed true', async () => {
    mockRecipientIsLead.mockReturnValue(false); // real recipientIsLead(undefined, lead) is false — mirrored here
    expect(await buildGoneQuietConsultationUrl(baseArgs({ recipientEmail: undefined }))).toBe('');
    expect(mockRecipientIsLead).toHaveBeenCalledWith(undefined, LEAD);
    expect(mockConsultationUrlForLead).not.toHaveBeenCalled();
    expect(mockShortWrap).not.toHaveBeenCalled();
  });

  test('the gate is read fresh on every call — a mid-run flip (no re-require) changes the very next result', async () => {
    mockEstimateEmailConsultationOfferLive.mockReturnValue(true);
    expect(await buildGoneQuietConsultationUrl(baseArgs())).toBe('https://portal.wavespestcontrol.com/l/abc123');
    mockEstimateEmailConsultationOfferLive.mockReturnValue(false);
    expect(await buildGoneQuietConsultationUrl(baseArgs())).toBe('');
    expect(mockEstimateConsultationLead).toHaveBeenCalledTimes(1); // not called on the second, gate-off call
  });
});

describe('buildGoneQuietConsultationUrl — happy path', () => {
  test('eligible lead + matching recipient → a short-wrapped, email-channel URL', async () => {
    const result = await buildGoneQuietConsultationUrl(baseArgs());
    expect(result).toBe('https://portal.wavespestcontrol.com/l/abc123');
    expect(mockEstimateConsultationLead).toHaveBeenCalledWith({
      estimate: ESTIMATE, estimateData: ESTIMATE_DATA, acceptActive: true,
    });
    expect(mockRecipientIsLead).toHaveBeenCalledWith('taylor@example.com', LEAD);
    // Channel 'email', never 'sms' — an email send is not phone-delivery evidence.
    expect(mockConsultationUrlForLead).toHaveBeenCalledWith('lead-1', 'email');
    expect(mockShortWrap).toHaveBeenCalledWith(
      'https://portal.wavespestcontrol.com/inspection/long-token', 'lead-1', expect.any(Date),
    );
    // TTL matches the 14-day consultation token — never longer.
    const expiresAt = mockShortWrap.mock.calls[0][2];
    const days = (expiresAt.getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
  });

  test('the long bearer URL never appears in the returned value — only the short-wrapped one', async () => {
    const longUrl = 'https://portal.wavespestcontrol.com/inspection/long-token-with-secret-bearer';
    mockConsultationUrlForLead.mockReturnValue(longUrl);
    const result = await buildGoneQuietConsultationUrl(baseArgs());
    expect(result).toBe('https://portal.wavespestcontrol.com/l/abc123');
    expect(result).not.toBe(longUrl);
    expect(result).not.toContain('long-token-with-secret-bearer');
    expect(result).not.toContain('/inspection/');
  });
});
