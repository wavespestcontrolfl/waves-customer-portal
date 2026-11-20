jest.mock('../models/db', () => {
  const db = jest.fn();
  db.fn = { now: jest.fn(() => 'NOW()') };
  // The merge-journal reads (the only awaited raw queries): no merges.
  db.raw = jest.fn(async () => ({ rows: [] }));
  return db;
});

jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

// Controllable consent snapshot for the conversion-lane suppression tests.
// The consent module's own matching rules are pinned in
// ad-audience-consent.test.js — here we only exercise the conversion seam.
const mockLoadSuppression = jest.fn();
jest.mock('../services/ads/ad-audience-consent', () => ({
  loadMarketingSuppression: (...args) => mockLoadSuppression(...args),
  normPhone: (p) => {
    const digits = String(p || '').replace(/\D/g, '');
    if (!digits) return null;
    return digits.length > 10 ? digits.slice(-10) : digits;
  },
}));

const crypto = require('crypto');
const dbMock = require('../models/db');
const DataManager = require('../services/ads/data-manager');

const {
  buildEvent,
  buildIngestRequest,
  cleanNumericId,
  configurationFor,
  dedupeCandidatesByTransaction,
  destinationFor,
  JUNK_LEAD_STATUSES,
  collectCandidates,
  hashedUserData,
  mapCompletedJobCandidate,
  mapLeadCandidate,
  normalizeEmail,
  normalizePhone,
  redactedEventSummary,
  sha256Hex,
  applyMarketingConsent,
  skipReason,
  summarizeCandidates,
  uploadLogStatusForIngest,
  uploadStatusFromRequestStatus,
  uploadValidateOnly,
} = DataManager._private;

describe('Google Data Manager upload helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID;
    delete process.env.GOOGLE_ADS_CUSTOMER_ID;
    delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    delete process.env.GOOGLE_ADS_DM_COMPLETED_JOB_CONVERSION_ACTION_ID;
    delete process.env.GOOGLE_ADS_DM_QUALIFIED_LEAD_CONVERSION_ACTION_ID;
    delete process.env.GOOGLE_DATA_MANAGER_ALLOW_UPLOADS;
    delete process.env.GOOGLE_DATA_MANAGER_VALIDATE_ONLY;
    delete process.env.GOOGLE_ADS_DM_QUALIFIED_LEAD_VALUE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('normalizes and hashes user data for Data Manager identifiers', () => {
    const email = ' Ada.Lovelace @ Example.COM ';
    const phone = '(941) 555-0100';
    const expectedEmail = crypto.createHash('sha256').update('ada.lovelace@example.com').digest('hex');
    const expectedPhone = crypto.createHash('sha256').update('+19415550100').digest('hex');

    expect(normalizeEmail(email)).toBe('ada.lovelace@example.com');
    expect(normalizePhone(phone)).toBe('+19415550100');
    expect(sha256Hex('+19415550100')).toBe(expectedPhone);
    expect(hashedUserData({ email, phone })).toEqual({
      userIdentifiers: [
        { emailAddress: expectedEmail },
        { phoneNumber: expectedPhone },
      ],
    });
  });

  test('builds an offline completed-job event without raw PII in the redacted summary', () => {
    const candidate = {
      conversionType: 'completed_job_revenue',
      sourceTable: 'estimate_actuals',
      sourceId: 'actual-1',
      leadId: 'lead-1',
      customerId: 'customer-1',
      serviceRecordId: 'service-1',
      eventName: 'Waves - Completed Job Revenue',
      eventTimestamp: '2026-06-12T16:00:00Z',
      transactionId: 'waves_completed_job:service-1',
      conversionValue: 249.99,
      currency: 'USD',
      gclid: 'GCLID-123',
      wbraid: 'WBRAID-123',
      email: 'customer@example.com',
      phone: '9415550100',
    };

    const event = buildEvent(candidate);
    const summary = redactedEventSummary(candidate, event);

    expect(event).toEqual(expect.objectContaining({
      eventName: 'Waves - Completed Job Revenue',
      eventTimestamp: '2026-06-12T16:00:00Z',
      eventSource: 'WEB',
      transactionId: 'waves_completed_job:service-1',
      conversionValue: 249.99,
      currency: 'USD',
      conversionCount: 1,
      adIdentifiers: { gclid: 'GCLID-123', wbraid: 'WBRAID-123' },
    }));
    expect(event.userData.userIdentifiers).toHaveLength(2);
    expect(JSON.stringify(summary)).not.toContain('customer@example.com');
    expect(JSON.stringify(summary)).not.toContain('9415550100');
    expect(summary.matchKeys).toEqual(expect.objectContaining({
      gclid: true,
      wbraid: true,
      email: true,
      phone: true,
      userIdentifiers: 2,
    }));
  });

  test('parses Google Ads account and conversion action IDs from common inputs', () => {
    expect(cleanNumericId('123-456-7890')).toBe('1234567890');
    expect(cleanNumericId('customers/1234567890/conversionActions/987654321')).toBe('987654321');
  });

  test('builds Google Ads destinations from Data Manager env config', () => {
    process.env.GOOGLE_ADS_CUSTOMER_ID = '123-456-7890';
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = '999-888-7777';
    process.env.GOOGLE_ADS_DM_COMPLETED_JOB_CONVERSION_ACTION_ID = 'customers/1234567890/conversionActions/555666777';

    expect(destinationFor('completed_job_revenue')).toEqual({
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' },
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: '9998887777' },
      productDestinationId: '555666777',
    });
    expect(configurationFor('completed_job_revenue')).toEqual(expect.objectContaining({
      customerIdConfigured: true,
      conversionActionIdConfigured: true,
      destinationConfigured: true,
    }));
  });

  test('keeps live uploads disabled unless explicitly allowed and validateOnly=false', () => {
    expect(uploadValidateOnly(false)).toBe(true);
    process.env.GOOGLE_DATA_MANAGER_VALIDATE_ONLY = 'false';
    expect(uploadValidateOnly(false)).toBe(true);
    process.env.GOOGLE_DATA_MANAGER_ALLOW_UPLOADS = 'true';
    expect(uploadValidateOnly(false)).toBe(false);
    expect(uploadValidateOnly(true)).toBe(true);
  });

  test('keeps live upload logs pending until async request status succeeds', () => {
    expect(uploadLogStatusForIngest(true)).toBe('validated');
    expect(uploadLogStatusForIngest(false)).toBe('pending');
    expect(uploadStatusFromRequestStatus({
      requestStatusPerDestination: [{ requestStatus: 'PROCESSING' }],
    })).toBe('pending');
    expect(uploadStatusFromRequestStatus({
      requestStatusPerDestination: [{ requestStatus: 'SUCCESS' }],
    })).toBe('sent');
    expect(uploadStatusFromRequestStatus({
      requestStatusPerDestination: [{ requestStatus: 'PARTIAL_SUCCESS' }],
    })).toBe('partial_success');
    expect(uploadStatusFromRequestStatus({
      requestStatusPerDestination: [{ requestStatus: 'FAILED' }],
    })).toBe('failed');
  });

  test('maps qualified leads with optional lead value and click IDs', () => {
    process.env.GOOGLE_ADS_DM_QUALIFIED_LEAD_VALUE = '75.50';
    const candidate = mapLeadCandidate({
      id: 'lead-1',
      estimate_id: 'estimate-1',
      customer_id: 'customer-1',
      first_contact_at: '2026-06-12T14:30:00-04:00',
      converted_at: '2026-06-13T15:00:00-04:00',
      status: 'qualified',
      email: 'lead@example.com',
      phone: '9415550100',
      gclid: 'GCLID',
      customer_email: 'current@example.com',
      customer_phone: '9415550199',
      source_name: 'Google Ads',
      source_type: 'google_ads',
      channel: 'paid',
    });

    // The linked customer's CURRENT identifiers ride along for person-level
    // consent checks (same contract as mapCompletedJobCandidate).
    expect(candidate.consentIdentifiers).toEqual([
      { email: 'lead@example.com', phone: '9415550100' },
      { email: 'current@example.com', phone: '9415550199' },
    ]);

    expect(candidate).toEqual(expect.objectContaining({
      conversionType: 'qualified_lead',
      sourceTable: 'leads',
      sourceId: 'lead-1',
      transactionId: 'waves_qualified_lead:lead-1',
      eventTimestamp: '2026-06-13T19:00:00.000Z',
      conversionValue: 75.5,
      gclid: 'GCLID',
    }));
    expect(skipReason(candidate)).toBeNull();
  });

  test('maps completed jobs from estimate actuals and quote-wizard lead ids', () => {
    const candidate = mapCompletedJobCandidate({
      id: 'actual-1',
      estimate_id: 'estimate-1',
      estimate_data: JSON.stringify({ lead_id: 'lead-from-json' }),
      customer_id: 'customer-1',
      service_record_id: 'service-1',
      scheduled_service_id: 'scheduled-1',
      service_date: '2026-06-12',
      invoice_id: 'invoice-1',
      invoice_total: '199.95',
      invoice_status: 'paid',
      customer_email: 'customer@example.com',
      customer_phone: '9415550100',
      gbraid: 'GBRAID',
    });

    expect(candidate).toEqual(expect.objectContaining({
      leadId: 'lead-from-json',
      transactionId: 'waves_completed_job:service-1',
      eventTimestamp: '2026-06-12T16:00:00Z',
      conversionValue: 199.95,
      gbraid: 'GBRAID',
      email: 'customer@example.com',
    }));
    expect(skipReason(candidate)).toBeNull();
  });

  test('summarizes skips for missing match keys, missing revenue, and already-sent rows', () => {
    const candidates = [
      {
        conversionType: 'qualified_lead',
        transactionId: 'lead:no-match',
        eventTimestamp: '2026-06-12T16:00:00Z',
      },
      {
        conversionType: 'completed_job_revenue',
        transactionId: 'job:no-value',
        eventTimestamp: '2026-06-12T16:00:00Z',
        email: 'customer@example.com',
      },
      {
        conversionType: 'qualified_lead',
        transactionId: 'lead:sent',
        eventTimestamp: '2026-06-12T16:00:00Z',
        gclid: 'GCLID',
      },
      {
        conversionType: 'qualified_lead',
        transactionId: 'lead:pending',
        eventTimestamp: '2026-06-12T16:00:00Z',
        gclid: 'GCLID',
      },
      {
        conversionType: 'qualified_lead',
        transactionId: 'lead:ready',
        eventTimestamp: '2026-06-12T16:00:00Z',
        gclid: 'GCLID',
      },
    ];
    const existing = new Map([
      ['lead:sent', { status: 'sent' }],
      ['lead:pending', { status: 'pending' }],
    ]);

    const summary = summarizeCandidates(candidates, existing);

    expect(summary.counts).toEqual(expect.objectContaining({
      total: 5,
      eligible: 1,
      alreadySent: 1,
      pending: 1,
      missingMatchKeys: 1,
      missingConversionValue: 1,
      skipped: 4,
    }));
  });

  test('dedupes duplicate transaction IDs and keeps the strongest match keys', () => {
    const candidates = [
      {
        conversionType: 'completed_job_revenue',
        transactionId: 'waves_completed_job:service-1',
        eventTimestamp: '2026-06-12T16:00:00Z',
        conversionValue: 100,
        email: 'customer@example.com',
      },
      {
        conversionType: 'completed_job_revenue',
        transactionId: 'waves_completed_job:service-1',
        eventTimestamp: '2026-06-12T16:00:00Z',
        conversionValue: 100,
        gclid: 'GCLID',
        leadId: 'lead-with-click',
      },
      {
        conversionType: 'completed_job_revenue',
        transactionId: 'waves_completed_job:service-2',
        eventTimestamp: '2026-06-12T16:00:00Z',
        conversionValue: 150,
        email: 'other@example.com',
      },
    ];

    expect(dedupeCandidatesByTransaction(candidates)).toEqual([
      expect.objectContaining({
        transactionId: 'waves_completed_job:service-1',
        gclid: 'GCLID',
        leadId: 'lead-with-click',
      }),
      expect.objectContaining({
        transactionId: 'waves_completed_job:service-2',
      }),
    ]);
  });

  test('builds a validate-only ingest request with one destination and HEX encoding', () => {
    process.env.GOOGLE_ADS_CUSTOMER_ID = '1234567890';
    process.env.GOOGLE_ADS_DM_QUALIFIED_LEAD_CONVERSION_ACTION_ID = '111222333';
    const request = buildIngestRequest({
      conversionType: 'qualified_lead',
      validateOnly: true,
      candidates: [{
        conversionType: 'qualified_lead',
        eventName: 'Waves - Qualified Lead',
        eventTimestamp: '2026-06-12T16:00:00Z',
        transactionId: 'waves_qualified_lead:lead-1',
        gclid: 'GCLID',
        currency: 'USD',
      }],
    });

    expect(request).toEqual(expect.objectContaining({
      validateOnly: true,
      encoding: 'HEX',
      destinations: [{
        operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' },
        productDestinationId: '111222333',
      }],
    }));
    expect(request.events).toHaveLength(1);
  });
});

describe('conversion-lane marketing-consent suppression', () => {
  const snapshot = ({ phones = [], emails = [], invalid = [] } = {}) => ({
    invalidPhones: new Set(invalid),
    isSuppressed: (m) => {
      const digits = String((m && m.phone) || '').replace(/\D/g, '');
      const ph = digits.length > 10 ? digits.slice(-10) : digits;
      const em = String((m && m.email) || '').trim().toLowerCase();
      return Boolean((ph && phones.includes(ph)) || (em && emails.includes(em)));
    },
  });

  beforeEach(() => {
    mockLoadSuppression.mockReset();
    mockLoadSuppression.mockResolvedValue(snapshot());
  });

  test('strips email AND phone from an opted-out contact and flags it', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ emails: ['optout@example.com'] }));
    const [cleaned] = await applyMarketingConsent('completed_job_revenue', [{
      transactionId: 't-1', email: 'optout@example.com', phone: '+19415550100', gclid: 'g-1',
    }]);
    expect(cleaned).toMatchObject({ transactionId: 't-1', email: null, phone: null, consentSuppressed: true });
  });

  test('a suppressed contact WITH a click id still measures — click-id-only event, no hashed PII', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ emails: ['optout@example.com'] }));
    const [cleaned] = await applyMarketingConsent('completed_job_revenue', [{
      conversionType: 'completed_job_revenue', transactionId: 't-1', eventTimestamp: '2026-07-01T12:00:00Z',
      conversionValue: 100, email: 'optout@example.com', phone: '+19415550100', gclid: 'g-1',
    }]);
    expect(skipReason(cleaned)).toBeNull();
    const event = buildEvent(cleaned);
    expect(event.adIdentifiers).toEqual({ gclid: 'g-1' });
    expect(event.userData).toBeUndefined();
  });

  test('a suppressed contact WITHOUT a click id is skipped as consent_suppressed, not missing_match_keys', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ phones: ['9415550100'] }));
    const [cleaned] = await applyMarketingConsent('qualified_lead', [{
      conversionType: 'qualified_lead', transactionId: 't-2', eventTimestamp: '2026-07-01T12:00:00Z',
      email: null, phone: '(941) 555-0100',
    }]);
    expect(skipReason(cleaned)).toBe('consent_suppressed');
    const { counts } = summarizeCandidates([cleaned]);
    expect(counts.consentSuppressed).toBe(1);
    expect(counts.missingMatchKeys).toBe(0);
    expect(counts.skipped).toBe(1);
  });

  test('a never-had-keys row still reports missing_match_keys (no consent involved)', () => {
    expect(skipReason({
      conversionType: 'qualified_lead', transactionId: 't-3', eventTimestamp: '2026-07-01T12:00:00Z',
    })).toBe('missing_match_keys');
  });

  test('wrong_number strips ONLY the (stranger\'s) phone; person is not opted out', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ invalid: ['9415550100'] }));
    const [cleaned] = await applyMarketingConsent('completed_job_revenue', [{
      transactionId: 't-4', email: 'fine@example.com', phone: '+19415550100',
    }]);
    expect(cleaned).toMatchObject({ email: 'fine@example.com', phone: null });
    expect(cleaned.consentSuppressed).toBeUndefined();
  });

  test("a completed job's estimate-lead customer contact (suppressionIdentifiers) counts for the opt-out only", async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ emails: ['old-address@example.com'] }));
    const [optedOut] = await applyMarketingConsent('completed_job_revenue', [{
      transactionId: 'waves_completed_job:j1', email: 'pat@example.com', phone: '+19415550100',
      consentIdentifiers: [{ email: 'pat@example.com', phone: '+19415550100' }],
      suppressionIdentifiers: [{ email: 'old-address@example.com', phone: null }],
    }]);
    expect(optedOut).toMatchObject({ email: null, phone: null, consentSuppressed: true });
    expect(optedOut).not.toHaveProperty('suppressionIdentifiers');

    // A wrong number is never swapped for that customer's phone.
    mockLoadSuppression.mockResolvedValue(snapshot({ invalid: ['9415550111'] }));
    const [wrongNumber] = await applyMarketingConsent('completed_job_revenue', [{
      transactionId: 'waves_completed_job:j2', email: 'sam@example.com', phone: '+19415550111',
      consentIdentifiers: [{ email: 'sam@example.com', phone: '+19415550111' }, { email: null, phone: null }],
      suppressionIdentifiers: [{ email: null, phone: '+19415550122' }],
    }]);
    expect(wrongNumber).toMatchObject({ email: 'sam@example.com', phone: null });
    expect(wrongNumber).not.toHaveProperty('suppressionIdentifiers');
  });

  test('duplicate completed-job rows: consent strips BEFORE dedupe so a click-ID sibling wins', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ emails: ['optout@example.com'] }));
    // Pre-consent, the opted-out row outscores the click-ID row (email+phone+
    // value+leadId = 12 vs gclid+value = 11); post-consent it must LOSE, or the
    // transaction is skipped while a measurable duplicate gets discarded.
    const optedOutRow = {
      conversionType: 'completed_job_revenue', transactionId: 'waves_completed_job:S1',
      eventTimestamp: '2026-07-01T12:00:00Z', conversionValue: 100, leadId: 'lead-1',
      email: 'optout@example.com', phone: '+19415550100',
    };
    const clickIdRow = {
      conversionType: 'completed_job_revenue', transactionId: 'waves_completed_job:S1',
      eventTimestamp: '2026-07-01T12:00:00Z', conversionValue: 100,
      email: null, phone: null, gclid: 'g-1',
    };
    const cleaned = await applyMarketingConsent('completed_job_revenue', [optedOutRow, clickIdRow]);
    const [winner] = dedupeCandidatesByTransaction(cleaned);
    expect(winner.gclid).toBe('g-1');
    expect(skipReason(winner)).toBeNull();
    const event = buildEvent(winner);
    expect(event.adIdentifiers).toEqual({ gclid: 'g-1' });
    expect(event.userData).toBeUndefined();
  });

  test('opt-out on a LINKED identifier suppresses the person even when a stale lead email won the pick', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ emails: ['current@example.com'] }));
    // mapCompletedJobCandidate collapses to leadEmail || customerEmail — the
    // stale lead email wins the pick, but the customer's CURRENT email is the
    // one that opted out. The person is opted out; nothing of theirs uploads.
    const [cleaned] = await applyMarketingConsent('completed_job_revenue', [{
      transactionId: 'waves_completed_job:S9',
      email: 'stale-lead@example.com', phone: '+19415550100',
      consentIdentifiers: [
        { email: 'stale-lead@example.com', phone: '+19415550100' },
        { email: 'current@example.com', phone: null },
      ],
    }]);
    expect(cleaned).toMatchObject({ email: null, phone: null, consentSuppressed: true });
  });

  test('no linked identifier opted out → candidate untouched', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ emails: ['someoneelse@example.com'] }));
    const [cleaned] = await applyMarketingConsent('completed_job_revenue', [{
      transactionId: 'waves_completed_job:S10',
      email: 'lead@example.com', phone: '+19415550100',
      consentIdentifiers: [
        { email: 'lead@example.com', phone: '+19415550100' },
        { email: 'customer@example.com', phone: null },
      ],
    }]);
    expect(cleaned).toMatchObject({ email: 'lead@example.com', phone: '+19415550100' });
    expect(cleaned.consentSuppressed).toBeUndefined();
  });

  test('a Meta click key survives the dedupe onto a consent-stripped winner (click-key union)', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ emails: ['optout@example.com'] }));
    const base = {
      conversionType: 'completed_job_revenue', transactionId: 'waves_completed_job:S2',
      eventTimestamp: '2026-07-01T12:00:00Z', conversionValue: 100,
    };
    // Whichever duplicate wins the score, the winner must carry the sibling's
    // Meta click key so CAPI keeps its click-ID-only measurement path — for
    // both the fbc and the weaker fbp variants.
    for (const metaKeys of [{ fbc: 'fb.1.1.click-1' }, { fbp: 'fb.1.1.99' }]) {
      const cleaned = await applyMarketingConsent('completed_job_revenue', [
        { ...base, leadId: 'lead-1', email: 'optout@example.com', phone: '+19415550100' },
        { ...base, email: null, phone: null, ...metaKeys },
      ]);
      const [winner] = dedupeCandidatesByTransaction(cleaned);
      expect(winner.fbc || winner.fbp).toBeTruthy();
      expect(winner.email).toBeNull(); // stripped PII never resurfaces
      expect(winner.phone).toBeNull();
    }
  });

  test('dedupe unions click keys BOTH ways without letting Meta keys outrank gclid for Google', () => {
    const base = {
      conversionType: 'completed_job_revenue', transactionId: 'waves_completed_job:S3',
      eventTimestamp: '2026-07-01T12:00:00Z', conversionValue: 100,
    };
    // Google-keyed row must WIN (gclid dominance — the Google lane keeps its
    // strongest attribution) while inheriting the Meta sibling's keys, so the
    // same deduped candidate serves both lanes.
    const [winner] = dedupeCandidatesByTransaction([
      { ...base, email: null, phone: null, fbc: 'fb.1.1.click-1', fbp: 'fb.1.1.99' },
      { ...base, email: null, phone: null, gclid: 'g-1' },
    ]);
    expect(winner.gclid).toBe('g-1');
    expect(winner.fbc).toBe('fb.1.1.click-1');
    expect(winner.fbp).toBe('fb.1.1.99');
    expect(skipReason(winner)).toBeNull();
  });

  test('wrong_number on the collapsed phone promotes a clean linked phone instead of dropping it', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ invalid: ['9415550100'] }));
    const [cleaned] = await applyMarketingConsent('completed_job_revenue', [{
      transactionId: 'waves_completed_job:S4',
      email: null, phone: '+19415550100', // stale lead phone — a stranger's
      consentIdentifiers: [
        { email: null, phone: '+19415550100' },
        { email: null, phone: '+19415550199' }, // customer's clean phone
      ],
    }]);
    expect(cleaned.phone).toBe('+19415550199');
    expect(cleaned.consentSuppressed).toBeUndefined();
  });

  test('wrong_number with no clean alternative still strips to null', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ invalid: ['9415550100', '9415550199'] }));
    const [cleaned] = await applyMarketingConsent('completed_job_revenue', [{
      transactionId: 'waves_completed_job:S5',
      email: null, phone: '+19415550100',
      consentIdentifiers: [
        { email: null, phone: '+19415550100' },
        { email: null, phone: '+19415550199' }, // also a wrong number
      ],
    }]);
    expect(cleaned.phone).toBeNull();
  });

  test('opt-out propagates to transaction SIBLINGS carrying different unsuppressed PII', async () => {
    mockLoadSuppression.mockResolvedValue(snapshot({ emails: ['optout@example.com'] }));
    // Two join rows, one transaction, same person: sibling A matches the
    // opt-out; sibling B carries different stale contact data absent from the
    // suppression lists. B must strip too — otherwise B wins the dedupe on
    // its intact PII score and uploads the person's PII anyway.
    const base = {
      conversionType: 'completed_job_revenue', transactionId: 'waves_completed_job:S6',
      eventTimestamp: '2026-07-01T12:00:00Z', conversionValue: 100,
    };
    const cleaned = await applyMarketingConsent('completed_job_revenue', [
      { ...base, email: 'optout@example.com', phone: null },
      { ...base, email: 'old-address@example.com', phone: '+19415550177', gclid: 'g-1' },
    ]);
    for (const c of cleaned) {
      expect(c.email).toBeNull();
      expect(c.phone).toBeNull();
      expect(c.consentSuppressed).toBe(true);
    }
    const [winner] = dedupeCandidatesByTransaction(cleaned);
    expect(winner.gclid).toBe('g-1'); // click-only measurement survives
    const event = buildEvent(winner);
    expect(event.userData).toBeUndefined();
  });

  test('fails CLOSED — a suppression-load error propagates and aborts the run', async () => {
    mockLoadSuppression.mockRejectedValue(new Error('db unavailable'));
    await expect(applyMarketingConsent('completed_job_revenue', [{ transactionId: 't-5', email: 'a@b.com' }]))
      .rejects.toThrow('db unavailable');
  });

  test('empty candidate list never loads the suppression set', async () => {
    await expect(applyMarketingConsent('completed_job_revenue', [])).resolves.toEqual([]);
    expect(mockLoadSuppression).not.toHaveBeenCalled();
  });
});


describe('extra match keys on conversions (name / ZIP / external id)', () => {
  const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
  const person = { first_name: 'Mrs. Jo-Ann', last_name: "O'Neil Jr.", city: 'Palmetto', state: 'FL', zip: '34221-1234' };

  test('Google address identifier: hashed lowercase names (no honorific/suffix/punctuation), unhashed US region + 5-digit ZIP', () => {
    const ud = hashedUserData({ email: 'a@x.com', firstName: 'Mrs. Jo-Ann', lastName: "O'Neil Jr.", zip: '34221-1234' });
    expect(ud.userIdentifiers).toEqual([
      { emailAddress: hash('a@x.com') },
      { address: { givenName: hash('joann'), familyName: hash('oneil'), regionCode: 'US', postalCode: '34221' } },
    ]);
  });
  test('Google address needs BOTH names and a ZIP — otherwise no address identifier at all', () => {
    for (const partial of [{ firstName: 'Jo', zip: '34221' }, { lastName: 'Lee', zip: '34221' }, { firstName: 'Jo', lastName: 'Lee' }, { firstName: 'Jo', lastName: 'Lee', zip: 'K1A 0B1' }]) {
      expect(hashedUserData({ email: 'a@x.com', ...partial }).userIdentifiers).toHaveLength(1);
    }
  });
  test('a full name in first_name with no last name is split at the last space', () => {
    const c = mapLeadCandidate({ id: 'l1', first_name: 'Jo Lee', last_name: null, zip: '34221', status: 'qualified' });
    const ud = hashedUserData(c);
    expect(ud.userIdentifiers[0].address).toMatchObject({ givenName: hash('jo'), familyName: hash('lee') });
  });
  test('the address alone is not a match key: no email/phone/click id is still missing_match_keys', () => {
    const c = mapLeadCandidate({ id: 'l1', first_name: 'Jo', last_name: 'Lee', zip: '34221', eventTimestamp: 1, created_at: '2026-07-01T00:00:00Z' });
    expect(skipReason(c)).toBe('missing_match_keys');
  });
  test('lead candidate: own name/ZIP first, same-person linked customer fills state; external id is lead-scoped', () => {
    const c = mapLeadCandidate({
      id: 'lead-1', customer_id: 'cust-1', created_at: '2026-07-01T00:00:00Z', status: 'qualified',
      email: 'jo@example.com', customer_email: 'JO@example.com',
      first_name: 'Jo', last_name: 'Lee', zip: '34221',
      customer_first_name: 'Joanne', customer_last_name: 'Lee', customer_city: 'Palmetto', customer_state: 'FL', customer_zip: '34221',
    });
    expect(c).toMatchObject({ firstName: 'Jo', lastName: 'Lee', city: 'Palmetto', state: 'FL', zip: '34221', externalId: 'lead:lead-1' });
  });
  test('lead from a different caller linked to an account customer: no borrowed customer name/address', () => {
    const c = mapLeadCandidate({
      id: 'lead-2', customer_id: 'cust-1', created_at: '2026-07-01T00:00:00Z', status: 'qualified',
      email: 'spouse@example.com', phone: '9415550101', customer_email: 'owner@example.com', customer_phone: '9415550199',
      first_name: null, last_name: null, zip: null,
      customer_first_name: 'Sam', customer_last_name: 'Rivera', customer_city: 'Bradenton', customer_state: 'FL', customer_zip: '34211',
    });
    expect(c).toMatchObject({ firstName: null, lastName: null, city: null, state: null, zip: null, email: 'spouse@example.com' });
  });
  test('unlinked lead gets a lead-scoped external id', () => {
    expect(mapLeadCandidate({ id: 'lead-7', created_at: '2026-07-01T00:00:00Z' }).externalId).toBe('lead:lead-7');
  });
  test('completed job: the same-person customer record is canonical, the lead is the fallback; ids agree with the Lead event', () => {
    const c = mapCompletedJobCandidate({
      id: 'ea1', customer_id: 'cust-1', lead_id: 'lead-1', service_date: '2026-07-01', invoice_total: 100,
      lead_phone: '(941) 555-0100', customer_phone: '941-555-0100',
      customer_first_name: 'Joanne', customer_last_name: 'Lee', customer_zip: '34221',
      lead_first_name: 'Jo', lead_last_name: 'Lee', lead_zip: '34202',
    });
    expect(c).toMatchObject({ firstName: 'Joanne', zip: '34221', externalId: 'lead:lead-1' });
    expect(mapCompletedJobCandidate({ id: 'ea2', lead_id: 'lead-1', service_date: '2026-07-01' }).externalId).toBe('lead:lead-1');
    expect(mapCompletedJobCandidate({ id: 'ea3', customer_id: 'cust-9', service_date: '2026-07-01' }).externalId).toBe('cust-9');
    // a deleted/missing lead (join null) mirrored only in estimate_data never keys external_id
    expect(mapCompletedJobCandidate({ id: 'ea6', customer_id: 'cust-9', lead_id: null, estimate_data: { lead_id: 'gone-1' }, service_date: '2026-07-01' }).externalId).toBe('cust-9');
  });
  test('completed job booked by a different caller: name/address follow the uploaded lead contact, not the account holder', () => {
    const c = mapCompletedJobCandidate({
      id: 'ea4', customer_id: 'cust-1', lead_id: 'lead-2', service_date: '2026-07-01', invoice_total: 100,
      lead_email: 'tenant@example.com', lead_phone: '9415550101', customer_email: 'owner@example.com', customer_phone: '9415550199',
      customer_first_name: 'Sam', customer_last_name: 'Rivera', customer_zip: '34211',
      lead_first_name: 'Pat', lead_last_name: 'Lee', lead_zip: '34202',
    });
    expect(c).toMatchObject({ email: 'tenant@example.com', firstName: 'Pat', lastName: 'Lee', zip: '34202' });
  });
  test('consent: an opted-out contact loses name, address and external id along with email/phone', async () => {
    mockLoadSuppression.mockResolvedValue({
      invalidPhones: new Set(),
      isSuppressed: (m) => m.email === 'optout@example.com',
    });
    const [cleaned] = await applyMarketingConsent('qualified_lead', [{
      conversionType: 'qualified_lead', transactionId: 't-1', eventTimestamp: '2026-07-01T12:00:00Z',
      email: 'optout@example.com', phone: '9415550100', gclid: 'g-1',
      firstName: 'Jo', lastName: 'Lee', city: 'Palmetto', state: 'FL', zip: '34221', externalId: 'cust-1',
    }]);
    expect(cleaned).toMatchObject({
      email: null, phone: null, firstName: null, lastName: null, city: null, state: null, zip: null, externalId: null, consentSuppressed: true,
    });
    // ...so the click-id-only event carries no user data whatsoever
    expect(buildEvent(cleaned).userData).toBeUndefined();
  });
  test('consent: an opt-out on a TRANSACTION SIBLING strips this candidate\'s extras too', async () => {
    mockLoadSuppression.mockResolvedValue({ invalidPhones: new Set(), isSuppressed: (m) => m.email === 'optout@example.com' });
    const cleaned = await applyMarketingConsent('completed_job_revenue', [
      { transactionId: 't-9', email: 'optout@example.com', firstName: 'Jo', lastName: 'Lee', zip: '34221' },
      { transactionId: 't-9', email: 'other@example.com', firstName: 'Jo', lastName: 'Lee', zip: '34221', externalId: 'cust-1' },
    ]);
    for (const c of cleaned) expect(c).toMatchObject({ firstName: null, zip: null, externalId: null });
  });
  test('consent: a wrong-number caller phone swapped for the account holder\'s re-picks name/address, and raw sources never leave', async () => {
    mockLoadSuppression.mockResolvedValue({ invalidPhones: new Set(['9415550101']), isSuppressed: () => false });
    const job = mapCompletedJobCandidate({
      id: 'ea5', customer_id: 'cust-1', lead_id: 'lead-3', service_date: '2026-07-01', invoice_total: 100,
      lead_phone: '9415550101', customer_phone: '9415550199',
      customer_first_name: 'Sam', customer_last_name: 'Rivera', customer_zip: '34211',
      lead_first_name: 'Pat', lead_last_name: 'Lee', lead_zip: '34202',
    });
    expect(job).toMatchObject({ phone: '9415550101', firstName: 'Pat' });
    const [cleaned] = await applyMarketingConsent('completed_job_revenue', [job]);
    expect(cleaned).toMatchObject({ phone: '9415550199', firstName: 'Sam', lastName: 'Rivera', zip: '34211' });
    expect(cleaned).not.toHaveProperty('identitySources');
  });
  test("consent: a wrong number shared by the lead and its customer never lends the customer's name and ZIP", async () => {
    mockLoadSuppression.mockResolvedValue({ invalidPhones: new Set(['9415550101']), isSuppressed: () => false });
    const lead = mapLeadCandidate({
      id: 'lead-4', created_at: '2026-07-01T00:00:00Z', email: 'new@example.com', phone: '9415550101',
      customer_id: 'cust-2', customer_email: 'old@example.com', customer_phone: '(941) 555-0101',
      customer_first_name: 'Sam', customer_last_name: 'Rivera', customer_zip: '34211',
    });
    // Before consent, the shared number joins the two records.
    expect(lead).toMatchObject({ firstName: 'Sam', zip: '34211' });
    const [cleaned] = await applyMarketingConsent('qualified_lead', [lead]);
    expect(cleaned).toMatchObject({ email: 'new@example.com', phone: null, firstName: null, lastName: null, zip: null });
  });
  test('a clean contact keeps its extras through consent cleaning', async () => {
    mockLoadSuppression.mockResolvedValue({ invalidPhones: new Set(), isSuppressed: () => false });
    const [c] = await applyMarketingConsent('qualified_lead', [{ transactionId: 't-1', email: 'a@x.com', firstName: 'Jo', zip: '34221', externalId: 'cust-1' }]);
    expect(c).toMatchObject({ firstName: 'Jo', zip: '34221', externalId: 'cust-1' });
  });
  test('redacted match-key summary reports the address flag without raw values', () => {
    const c = { email: 'a@x.com', firstName: 'Jo', lastName: 'Lee', zip: '34221', ...person };
    const ev = buildEvent({ conversionType: 'qualified_lead', eventTimestamp: '2026-07-01T00:00:00Z', transactionId: 't', ...c, firstName: 'Jo', lastName: 'Lee' });
    const summary = redactedEventSummary(c, ev);
    expect(summary.matchKeys).toMatchObject({ email: true, address: true, userIdentifiers: 2 });
    expect(JSON.stringify(summary)).not.toContain('34221');
  });
});

describe('test records and junk leads (owner 2026-11-19)', () => {
  // A fictional owner cell: the rule reads ADAM_PHONE, never a number in code.
  const OWNER_CELL = '+19415550177';
  const savedOwnerPhone = process.env.ADAM_PHONE;
  beforeEach(() => { process.env.ADAM_PHONE = OWNER_CELL; });
  afterAll(() => {
    if (savedOwnerPhone === undefined) delete process.env.ADAM_PHONE; else process.env.ADAM_PHONE = savedOwnerPhone;
  });
  const baseLead = {
    id: 'l1', created_at: '2026-11-18T12:00:00Z', email: 'pat@example.com', phone: '9415550100',
    first_name: 'Pat', last_name: 'Sample', status: 'qualified',
  };

  test('qualified leads: a lead later marked junk or non-engaged is dropped in SQL, before the limit', async () => {
    mockLoadSuppression.mockResolvedValue({ invalidPhones: new Set(), isSuppressed: () => false });
    const chain = {};
    const raws = [];
    for (const m of ['leftJoin', 'whereNull', 'where', 'orWhereRaw', 'orderByRaw', 'limit']) {
      chain[m] = jest.fn((...args) => {
        if (typeof args[0] === 'function') args[0].call(chain, chain);
        return chain;
      });
    }
    chain.whereRaw = jest.fn((sql, bindings) => { raws.push({ sql, bindings }); return chain; });
    chain.select = jest.fn(() => chain);
    chain.then = (resolve) => resolve([]);
    dbMock.mockImplementation(() => chain);
    await collectCandidates('qualified_lead', { since: '2026-11-01', endDate: '2026-11-18' });
    // The shared non-engaged set (cancelled, spam, duplicate, handled) plus disqualified.
    expect(JUNK_LEAD_STATUSES).toEqual(['cancelled', 'spam', 'duplicate', 'handled', 'disqualified']);
    const junk = raws.find((r) => r.sql.includes('NOT IN'));
    expect(junk.sql).toBe("LOWER(TRIM(COALESCE(l.status, ''))) NOT IN (?, ?, ?, ?, ?)");
    expect(junk.bindings).toEqual(JUNK_LEAD_STATUSES);
    // ...before the limit: the filter is part of the same query the limit caps.
    expect(chain.whereRaw.mock.invocationCallOrder[raws.indexOf(junk)]).toBeLessThan(chain.limit.mock.invocationCallOrder[0]);
    // A won repeat of an already-won deal is dropped by the shared second-win rule, also before the limit.
    const secondWin = raws.find((r) => r.sql === require('../services/lead-statuses').secondWinSql('l'));
    expect(secondWin).toBeDefined();
    expect(chain.whereRaw.mock.invocationCallOrder[raws.indexOf(secondWin)]).toBeLessThan(chain.limit.mock.invocationCallOrder[0]);
  });

  test('an internal test record is skipped as internal_test (owner cell, test name, linked test customer)', () => {
    // The listed test name, read from the list so no real name is written here.
    const { INTERNAL_TEST_CUSTOMERS } = require('../services/internal-test-customers');
    const [listedFirst, ...listedRest] = INTERNAL_TEST_CUSTOMERS[0].split(' ');
    expect(skipReason(mapLeadCandidate({ ...baseLead, phone: OWNER_CELL }))).toBe('internal_test');
    expect(skipReason(mapLeadCandidate({ ...baseLead, first_name: listedFirst, last_name: listedRest.join(' ') }))).toBe('internal_test');
    expect(skipReason(mapLeadCandidate({
      ...baseLead, customer_id: 'c1', customer_first_name: 'Shakedown', customer_last_name: 'Test (internal)',
    }))).toBe('internal_test');
  });

  test('completed-job revenue skips test records but not a merged lead (real paid work stays)', () => {
    const job = { id: 'ea1', service_date: '2026-11-17', invoice_total: 100, lead_email: 'pat@example.com', lead_phone: '9415550100' };
    expect(skipReason(mapCompletedJobCandidate({ ...job, customer_phone: '(941) 555-0177' }))).toBe('internal_test');
    expect(skipReason(mapCompletedJobCandidate(job))).toBeNull();
    // The lead joins by estimate and can belong to another customer: a listed
    // test customer's lead makes the job a test record; any other one does not.
    const { INTERNAL_TEST_CUSTOMER_IDS } = require('../services/internal-test-customers');
    expect(skipReason(mapCompletedJobCandidate({ ...job, customer_id: 'c1', lead_customer_id: INTERNAL_TEST_CUSTOMER_IDS[0] }))).toBe('internal_test');
    expect(skipReason(mapCompletedJobCandidate({ ...job, customer_id: 'c1', lead_customer_id: 'c2' }))).toBeNull();
    // ...and so does a lead customer that is a test record by its own contact.
    expect(skipReason(mapCompletedJobCandidate({
      ...job, customer_id: 'c1', lead_customer_id: 'c2', lead_customer_first_name: 'Shakedown', lead_customer_last_name: 'Test',
    }))).toBe('internal_test');
    expect(skipReason(mapCompletedJobCandidate({ ...job, customer_id: 'c1', lead_customer_id: 'c2', lead_customer_phone: '(941) 555-0177' }))).toBe('internal_test');
  });

  test("the completed-job query selects the joined lead's own customer id, which the test-record check reads", async () => {
    mockLoadSuppression.mockResolvedValue({ invalidPhones: new Set(), isSuppressed: () => false });
    const selected = [];
    const chain = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve) => resolve([]);
        if (prop === 'select') return (...cols) => { selected.push(...cols); return chain; };
        return () => chain;
      },
    });
    dbMock.mockImplementation(() => chain);
    const savedRaw = dbMock.raw;
    dbMock.raw = (sql) => sql;
    try {
      await collectCandidates('completed_job_revenue', { since: '2026-11-01', endDate: '2026-11-18' });
    } finally {
      dbMock.raw = savedRaw;
    }
    expect(selected).toEqual(expect.arrayContaining([
      'l.customer_id as lead_customer_id',
      'lc.email as lead_customer_email', 'lc.phone as lead_customer_phone',
      'lc.first_name as lead_customer_first_name', 'lc.last_name as lead_customer_last_name',
    ]));
  });

  test('summarizeCandidates counts internal_test and skips it', () => {
    const { counts, rows } = summarizeCandidates([
      mapLeadCandidate({ ...baseLead, id: 'l2', phone: '9415550177' }),
      mapLeadCandidate({ ...baseLead, id: 'l3' }),
    ]);
    expect(counts).toMatchObject({ internalTest: 1, eligible: 1, skipped: 1 });
    expect(rows.map((r) => r.skipReason)).toEqual(['internal_test', null]);
  });

  test('dedupe: an exclusion on any sibling of a transaction excludes it', () => {
    const [kept] = dedupeCandidatesByTransaction([
      { transactionId: 't', email: 'a@x.com', phone: '9415550100', eventTimestamp: 'x' },
      { transactionId: 't', internalTest: true },
    ]);
    expect(kept.internalTest).toBe(true);
  });
});
