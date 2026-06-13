jest.mock('../models/db', () => {
  const db = jest.fn();
  db.fn = { now: jest.fn(() => 'NOW()') };
  return db;
});

jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const crypto = require('crypto');
const DataManager = require('../services/ads/data-manager');

const {
  buildEvent,
  buildIngestRequest,
  cleanNumericId,
  configurationFor,
  dedupeCandidatesByTransaction,
  destinationFor,
  hashedUserData,
  mapCompletedJobCandidate,
  mapLeadCandidate,
  normalizeEmail,
  normalizePhone,
  redactedEventSummary,
  sha256Hex,
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
      source_name: 'Google Ads',
      source_type: 'google_ads',
      channel: 'paid',
    });

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
