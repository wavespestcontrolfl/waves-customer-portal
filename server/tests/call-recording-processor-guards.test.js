const CallRecordingProcessor = require('../services/call-recording-processor');

describe('call recording appointment guardrails', () => {
  const {
    canonicalWavesService,
    resolveSchedulableCallService,
    validatePhoneCallAppointmentCustomer,
  } = CallRecordingProcessor._test;

  test('rejects unrelated SEO or construction calls even if a service phrase was extracted', () => {
    const result = resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: 'advice on website SEO/organic traffic for his construction company',
      call_summary: 'Caller wanted SEO advice for a construction company.',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'unsupported_service',
    });
  });

  test('rejects SEO calls even when extracted text contains pest control words', () => {
    const result = resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'SEO for pest control website',
      call_summary: 'Caller wanted Google ranking help for his pest control website.',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'unsupported_service',
    });
  });

  test('allows real Waves appointments that mention website or ads as the source', () => {
    expect(resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: 'roach treatment',
      call_summary: 'Caller found Waves on the website and wants help with roaches.',
    })).toMatchObject({ ok: true, service: 'General Pest Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Lawn Fertilization Service',
      requested_service: 'lawn fertilization',
      call_summary: 'Caller saw an ad and asked to book lawn fertilization.',
    })).toMatchObject({ ok: true, service: 'Lawn Care' });

    expect(resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: 'roach treatment',
      call_summary: 'Caller saw an ad for pest control services and wants to book.',
    })).toMatchObject({ ok: true, service: 'General Pest Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: 'roach treatment',
      call_summary: 'Caller saw advertising for pest control services and wants to book.',
    })).toMatchObject({ ok: true, service: 'General Pest Control' });
  });

  test('canonicalizes Waves service categories from matched service text', () => {
    expect(canonicalWavesService('lawn fertilization treatment')).toBe('Lawn Care');
    expect(canonicalWavesService('rodent bait station service')).toBe('Rodent Control');
    expect(canonicalWavesService('mosquitos in the backyard')).toBe('Mosquito Control');
    expect(canonicalWavesService('roach treatment')).toBe('General Pest Control');
    expect(canonicalWavesService('cockroach issue')).toBe('General Pest Control');
    expect(canonicalWavesService('WDO inspection')).toBe('WDO Inspection');
    expect(canonicalWavesService('Termite Inspection')).toBe('Termite Inspection');
  });

  test('accepts common pest wording when matched service is missing', () => {
    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'roach treatment',
    })).toMatchObject({ ok: true, service: 'General Pest Control' });

    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'mosquitos in the yard',
    })).toMatchObject({ ok: true, service: 'Mosquito Control' });
  });

  test('requires complete contact and service address before phone-call booking', () => {
    const incomplete = validatePhoneCallAppointmentCustomer(
      {
        first_name: 'Jesse',
        phone: '+19417308491',
        city: 'Bradenton',
        state: 'FL',
      },
      {},
      '+19417308491'
    );

    expect(incomplete.ok).toBe(false);
    expect(incomplete.missing).toEqual(expect.arrayContaining([
      'last_name',
      'email',
      'street_address',
      'zip',
    ]));

    const complete = validatePhoneCallAppointmentCustomer(
      {
        first_name: 'Jesse',
        last_name: 'Smith',
        phone: '+19417308491',
        email: 'jesse@example.com',
        address_line1: '123 Main St',
        city: 'Bradenton',
        state: 'FL',
        zip: '34205',
      },
      {},
      null
    );

    expect(complete).toMatchObject({ ok: true, missing: [] });
  });
});
