const publicQuoteRouter = require('../routes/public-quote');
const leadWebhookRouter = require('../routes/lead-webhook');
const publicPropertyLookupRouter = require('../routes/public-property-lookup');

describe('quote workflow service interest labels', () => {
  const {
    buildPublicQuoteServiceInterest,
    buildCompactPublicQuoteServiceInterest,
    buildCompactCustomerServiceInterest,
  } = publicQuoteRouter._internals;

  const {
    scrubLeadAlertProviderError,
    markLeadAlertCallLogFailed,
    buildLeadWebhookIntake,
    normalizeLeadServiceInterest,
    serviceInterestUpdateFromTriage,
    shouldApplyTriageServiceInterest,
    shouldRunLeadAcquisition,
  } = leadWebhookRouter._test;

  const {
    normalizeServiceInterest: normalizeLookupServiceInterest,
  } = publicPropertyLookupRouter._test;

  test('public quote recurring pest labels include selected cadence', () => {
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'quarterly' } }))
      .toBe('Quarterly Pest Control');
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'bimonthly' } }))
      .toBe('Bi-Monthly Pest Control');
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'bi-monthly' } }))
      .toBe('Bi-Monthly Pest Control');
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'monthly' } }))
      .toBe('Monthly Pest Control');
  });

  test('public quote pest labels default unsupported cadence the same way pricing does', () => {
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'semiannual' } }))
      .toBe('Quarterly Pest Control');
    expect(buildPublicQuoteServiceInterest({ pest: { frequency: 'unknown' } }))
      .toBe('Quarterly Pest Control');
  });

  test('public quote recurring lawn labels are explicit without overflowing customer field', () => {
    expect(buildPublicQuoteServiceInterest({
      pest: { frequency: 'quarterly' },
      lawn: { track: 'st_augustine', tier: 'enhanced' },
    })).toBe('Quarterly Pest Control + Recurring Lawn Care');

    const compact = buildCompactPublicQuoteServiceInterest({
      pest: { frequency: 'quarterly' },
      lawn: { track: 'st_augustine', tier: 'enhanced' },
    });

    expect(compact).toBe('Quarterly Pest + Lawn Care');
    expect(compact.length).toBeLessThanOrEqual(32);
  });

  test('upsell customer service interest stays compact instead of truncating mid-label', () => {
    const compact = buildCompactCustomerServiceInterest([
      'Quarterly Pest Control',
      'Lawn Care',
    ]);

    expect(compact).toBe('Quarterly Pest + Lawn Care');
    expect(compact.length).toBeLessThanOrEqual(32);
  });

  test('compact customer service interest drops overflow add-ons cleanly', () => {
    const compact = buildCompactCustomerServiceInterest([
      'Quarterly Pest Control',
      'Lawn Care',
      'Mosquito & No-See-Um Control',
    ]);

    expect(compact).toBe('Quarterly Pest + Lawn Care');
    expect(compact).not.toMatch(/Ca$/);
    expect(compact.length).toBeLessThanOrEqual(32);
  });

  test('lead webhook formats quote workflow frequency before storing service interest', () => {
    expect(normalizeLeadServiceInterest({ interest: 'pest', frequency: 'one-time' }))
      .toBe('One-Time Pest Control');
    expect(normalizeLeadServiceInterest({ interest: 'pest', frequency: 'ongoing' }))
      .toBe('Recurring Pest Control');
    expect(normalizeLeadServiceInterest({ interest: 'pest', frequency: 'not-sure' }))
      .toBe('Pest Control Consultation');
    expect(normalizeLeadServiceInterest({ interest: 'lawn', frequency: 'one-time' }))
      .toBe('One-Time Lawn Care');
    expect(normalizeLeadServiceInterest({ interest: 'both', frequency: 'ongoing' }))
      .toBe('Recurring Pest Control + Recurring Lawn Care');
  });

  test('lead webhook formats specific service selections before storing service interest', () => {
    expect(normalizeLeadServiceInterest({ specific_service: 'mosquito_control', frequency: 'ongoing' }))
      .toBe('Recurring Mosquito Control');
    expect(normalizeLeadServiceInterest({ specific_service: 'termite_treatment', frequency: 'one-time' }))
      .toBe('One-Time Termite Treatment');
    expect(normalizeLeadServiceInterest({ specific_service: 'lawn_fertilization', frequency: 'ongoing' }))
      .toBe('Recurring Lawn Fertilization');
    expect(normalizeLeadServiceInterest({ specific_service: 'not_sure_pest', frequency: 'ongoing' }))
      .toBe('Pest Control Consultation');
  });

  test('lead webhook normalizes quote wizard payloads with nested attribution', () => {
    const intake = buildLeadWebhookIntake({
      firstName: 'jane',
      lastName: 'smith',
      email: ' Jane@Example.com ',
      phone: '(941) 555-0199',
      address: '123 Main St, Venice, FL 34285',
      address_line1: '123 Main St',
      city: 'Venice',
      state: 'FL',
      zip: '34285',
      interest: 'both',
      frequency: 'ongoing',
      attribution: {
        domain: 'venicelawncare.com',
        utm: { source: 'google', medium: 'organic' },
      },
    });

    expect(intake.email).toBe('jane@example.com');
    expect(intake.rawPhone).toBe('(941) 555-0199');
    expect(intake.firstName).toBe('Jane');
    expect(intake.lastName).toBe('Smith');
    expect(intake.fullAddress).toBe('123 Main St, Venice, FL 34285');
    expect(intake.serviceInterest).toBe('Recurring Pest Control + Recurring Lawn Care');
    expect(intake.landingUrl).toBe('https://www.venicelawncare.com/');
    expect(intake.leadSource).toEqual(expect.objectContaining({
      source: 'domain_website',
      detail: expect.stringContaining('venicelawncare.com'),
      area: 'Venice',
    }));
  });

  test('lead webhook resolves top-level spoke domain when nested attribution is absent', () => {
    const intake = buildLeadWebhookIntake({
      name: 'Sam Spoke',
      email: 'sam@example.com',
      phone: '9415550198',
      address: '456 Center Rd, Sarasota, FL 34240',
      domain: 'sarasotafllawncare.com',
      service_interest: 'Lawn Care',
    });

    expect(intake.landingUrl).toBe('https://www.sarasotafllawncare.com/');
    expect(intake.leadSource).toEqual(expect.objectContaining({
      source: 'domain_website',
      detail: expect.stringContaining('sarasotafllawncare.com'),
      area: 'Sarasota',
    }));
  });

  test('lead webhook resolves existing GBP UTM profile attribution and click IDs', () => {
    const longWbraid = `W${'B'.repeat(260)}`;
    const longGbraid = `G${'B'.repeat(260)}`;
    const intake = buildLeadWebhookIntake({
      firstName: 'Gina',
      lastName: 'Maps',
      email: 'gina@example.com',
      phone: '9415550197',
      address: '1450 Pine Warbler Pl, Sarasota, FL 34240',
      city: 'Sarasota',
      attribution: {
        utm: {
          source: 'gbp',
          medium: 'organic',
          campaign: 'website-link',
          content: 'sarasota-profile',
        },
        wbraid: longWbraid,
        gbraid: longGbraid,
      },
    });

    expect(intake.wbraid).toBe(longWbraid.slice(0, 255));
    expect(intake.gbraid).toBe(longGbraid.slice(0, 255));
    expect(intake.leadSource).toEqual(expect.objectContaining({
      source: 'google_business',
      detail: 'GBP Sarasota',
      channel: 'organic',
      area: 'sarasota',
    }));
  });

  test('lead webhook keeps unknown GBP UTMs unprofiled', () => {
    const intake = buildLeadWebhookIntake({
      firstName: 'Uma',
      lastName: 'Unknown',
      email: 'uma@example.com',
      phone: '9415550196',
      attribution: {
        utm: {
          source: 'gbp',
          medium: 'organic',
          campaign: 'website-link',
          content: 'legacy-profile',
        },
      },
    });

    expect(intake.leadSource).toEqual(expect.objectContaining({
      source: 'google_business',
      detail: 'GBP unattributed',
      channel: 'organic',
      area: null,
    }));
  });

  test('lead webhook normalizes legacy labeled form fields', () => {
    const intake = buildLeadWebhookIntake({
      'Whats Your Best Email': 'legacy@example.com',
      'Got A Number We Can Call Or Text': '941.555.0177',
      'And Whats Your Address': '789 Legacy Ave, Bradenton, FL 34205',
      'What Can We Help You With': 'Pest Control (One-Time)',
      'Page Url': 'https://bradentonflpestcontrol.com/contact',
      name: 'Legacy Lead',
    });

    expect(intake.email).toBe('legacy@example.com');
    expect(intake.rawPhone).toBe('941.555.0177');
    expect(intake.fullAddress).toBe('789 Legacy Ave, Bradenton, FL 34205');
    expect(intake.serviceInterest).toBe('One-Time Pest Control');
    expect(intake.leadSource).toEqual(expect.objectContaining({
      source: 'domain_website',
      area: 'Bradenton',
    }));
  });

  test('public property lookup formats service intent from quote wizard frequency', () => {
    expect(normalizeLookupServiceInterest({ interest: 'pest', frequency: 'one-time' }))
      .toBe('One-Time Pest Control');
    expect(normalizeLookupServiceInterest({ interest: 'both', frequency: 'ongoing' }))
      .toBe('Recurring Pest Control + Recurring Lawn Care');
    expect(normalizeLookupServiceInterest({ interest: 'lawn', frequency: 'not-sure' }))
      .toBe('Lawn Care Consultation');
    expect(normalizeLookupServiceInterest({ specific_service: 'mosquito_control', frequency: 'ongoing' }))
      .toBe('Recurring Mosquito Control');
  });

  test('lead webhook normalizes legacy parenthetical one-time labels', () => {
    expect(normalizeLeadServiceInterest({ service_interest: 'Pest Control (One-Time)' }))
      .toBe('One-Time Pest Control');
    expect(normalizeLeadServiceInterest({ service_interest: 'Lawn Care (Consult)' }))
      .toBe('Lawn Care Consultation');
  });

  test('AI triage does not overwrite workflow-specific service interest labels', () => {
    expect(shouldApplyTriageServiceInterest('One-Time Pest Control', 'General Pest Control')).toBe(false);
    expect(shouldApplyTriageServiceInterest('Recurring Lawn Care', 'General Lawn Care')).toBe(false);
    expect(shouldApplyTriageServiceInterest('Pest Control Consultation', 'General Pest Control')).toBe(false);
    expect(shouldApplyTriageServiceInterest('Pest Control', 'General Pest Control')).toBe(true);
    expect(shouldApplyTriageServiceInterest('', 'General Pest Control')).toBe(true);
  });

  test('AI triage update value can be reused for matching draft estimates', () => {
    expect(serviceInterestUpdateFromTriage('Pest Control', 'Recurring Pest Control'))
      .toBe('Recurring Pest Control');
    expect(serviceInterestUpdateFromTriage('Pest Control', 'Recurring Pest Control + Recurring Lawn Care'))
      .toBe('Recurring Pest Control + Recurring Lawn Care');
    expect(serviceInterestUpdateFromTriage('Recurring Pest Control', 'General Pest Control'))
      .toBeNull();
    expect(serviceInterestUpdateFromTriage('Pest Control', ''))
      .toBeNull();
  });

  test('existing customer form submissions do not enter lead acquisition', () => {
    expect(shouldRunLeadAcquisition({ isNewCustomer: true, isDuplicateSubmission: false }))
      .toBe(true);
    expect(shouldRunLeadAcquisition({ isNewCustomer: false, isDuplicateSubmission: false }))
      .toBe(false);
    expect(shouldRunLeadAcquisition({ isNewCustomer: true, isDuplicateSubmission: true }))
      .toBe(false);
  });

  test('lead alert provider diagnostics scrub phone numbers', () => {
    expect(scrubLeadAlertProviderError('bad url customerNumber=%2B19415550199'))
      .toBe('bad url customerNumber=[phone]');
    expect(scrubLeadAlertProviderError('failed for +19415550199 and 19415550199'))
      .toBe('failed for [phone] and [phone]');
  });

  test('lead auto-bridge call log failures are marked failed with scrubbed error text', async () => {
    const updates = [];
    const database = jest.fn((table) => ({
      where(clause) {
        return {
          update(patch) {
            updates.push({ table, clause, patch });
            return Promise.resolve(1);
          },
        };
      },
    }));

    await markLeadAlertCallLogFailed('call-log-1', 'bad request for [phone]', database);

    expect(updates).toEqual([{
      table: 'call_log',
      clause: { id: 'call-log-1' },
      patch: expect.objectContaining({
        status: 'failed',
        notes: 'Twilio create failed: bad request for [phone]',
        updated_at: expect.any(Date),
      }),
    }]);
  });
});
