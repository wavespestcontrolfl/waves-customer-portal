const CallRecordingProcessor = require('../services/call-recording-processor');

describe('call recording appointment guardrails', () => {
  const {
    canonicalWavesService,
    extractedNameMatchesCustomer,
    maskPhone,
    resolveCallContactPhone,
    resolveDefaultCallBookingTechnician,
    resolveSchedulableCallService,
    shouldCreateCallLeadForCustomer,
    validatePhoneCallAppointmentCustomer,
  } = CallRecordingProcessor._test;

  test('uses the external contact leg as the customer phone for outbound calls', () => {
    expect(resolveCallContactPhone({
      direction: 'outbound',
      from_phone: '+19412975749',
      to_phone: '+19145234413',
    })).toBe('+19145234413');

    expect(resolveCallContactPhone({
      direction: 'inbound',
      from_phone: '+19145234413',
      to_phone: '+19412975749',
    })).toBe('+19145234413');

    expect(resolveCallContactPhone({
      direction: 'outbound',
      from_phone: '+19412975749',
      to_phone: '+19145234413',
    }, '+19145550000')).toBe('+19145550000');

    expect(resolveCallContactPhone({
      direction: 'outbound',
      from_phone: '+19412975749',
      to_phone: '+19145234413',
    }, '+19412975749')).toBe('+19145234413');

    expect(resolveCallContactPhone({
      direction: 'outbound',
      from_phone: '+19412975749',
      to_phone: '+19145234413',
    }, '9412975749')).toBe('+19145234413');

    expect(resolveCallContactPhone({
      direction: 'inbound',
      from_phone: '+19145234413',
      to_phone: '+19412975749',
    }, '+19412975749')).toBe('+19145234413');
  });

  test('masks phone values for call processor diagnostics', () => {
    expect(maskPhone('+19415551212')).toBe('***1212');
    expect(maskPhone('(941) 555-1212')).toBe('***1212');
    expect(maskPhone('')).toBe('unknown');
  });

  test('detects transcript name mismatch against a linked customer', () => {
    expect(extractedNameMatchesCustomer(
      { first_name: 'Andrea' },
      { first_name: 'George', last_name: 'Stone' }
    )).toBe(false);

    expect(extractedNameMatchesCustomer(
      { first_name: 'Andrea' },
      { first_name: 'Andrea', last_name: 'Stone' }
    )).toBe(true);
  });

  test('does not create call leads for existing customer lifecycle stages', () => {
    expect(shouldCreateCallLeadForCustomer(
      { id: 'cust-active', pipeline_stage: 'active_customer' },
      { createdCustomerFromCall: false }
    )).toBe(false);

    expect(shouldCreateCallLeadForCustomer(
      { id: 'cust-won', pipeline_stage: 'won' },
      { createdCustomerFromCall: false }
    )).toBe(false);

    expect(shouldCreateCallLeadForCustomer(
      { id: 'lead-customer', pipeline_stage: 'new_lead' },
      { createdCustomerFromCall: false }
    )).toBe(true);

    expect(shouldCreateCallLeadForCustomer(
      { id: 'new-from-call', pipeline_stage: 'new_lead' },
      { createdCustomerFromCall: true }
    )).toBe(true);
  });

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

    expect(resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: 'advice for my construction company',
      call_summary: 'Caller wanted advice for a construction company.',
    })).toMatchObject({
      ok: false,
      reason: 'unsupported_service',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'advice for my construction company about pre-slab termite treatment',
      call_summary: 'Caller wanted advice for a construction company about pre-slab termite treatment.',
    })).toMatchObject({
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
    expect(canonicalWavesService('no active termites, need a termite inspection')).toBe('Termite Inspection');
    expect(canonicalWavesService('termite inspection for real estate closing, no active termites')).toBe('Termite Inspection');
    expect(canonicalWavesService('no roaches just termites')).toBe('Termite Inspection');
    expect(canonicalWavesService('termites not roaches')).toBe('Termite Inspection');
    expect(canonicalWavesService('not termites, roaches')).toBe('General Pest Control');
    expect(canonicalWavesService('soil poison for new construction')).toBe('Pre-Slab Termidor');
    expect(canonicalWavesService('pre-slab termite treatment before concrete pour')).toBe('Pre-Slab Termidor');
    expect(canonicalWavesService('pre-slab treatment not until Tuesday')).toBe('Pre-Slab Termidor');
    expect(canonicalWavesService('soil treatment before the slab not until next week')).toBe('Pre-Slab Termidor');
    expect(canonicalWavesService('no termite issue; need soil treatment before pouring concrete')).toBe('Pre-Slab Termidor');
    expect(canonicalWavesService('not a termite issue; need soil treatment before pouring concrete')).toBe('Pre-Slab Termidor');
    expect(canonicalWavesService('new construction has not had soil treatment yet and needs pre-slab before the pour')).toBe('Pre-Slab Termidor');
    expect(canonicalWavesService('termites in garage need treatment')).toBe('Termite Inspection');
    expect(canonicalWavesService('needs termite treatment for the garage')).toBe('Termite Inspection');
    expect(canonicalWavesService('Customer needs roach treatment before concrete work starts.')).toBe('General Pest Control');
    expect(canonicalWavesService('Liquid Termite Perimeter')).toBe('Liquid Termite Perimeter');
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

  test('uses pre-slab termite service before generic termite inspection', () => {
    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'soil poison for construction, new construction',
      call_summary: 'Caller booked soil treatment for a new construction garage before the slab pour.',
      pain_points: 'Needs termite pretreatment before concrete.',
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'pre-slab termite treatment for a construction company',
      call_summary: 'Builder needs termite soil treatment before pouring the slab.',
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: 'Pre-Slab Termidor',
      requested_service: 'how to schedule pre-slab termite treatment for my construction company',
      call_summary: 'Builder needs termite soil treatment before pouring the slab.',
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'not a termite issue, need soil treatment before pouring concrete',
      call_summary: 'Caller needs soil treatment before the concrete pour.',
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'pre-slab treatment not until Tuesday',
      call_summary: 'Caller needs pre-slab treatment not until Tuesday.',
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'pre-slab termite treatment not until Tuesday',
      call_summary: 'Caller needs pre-slab termite treatment not until Tuesday.',
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'no termites, need a termite inspection',
      call_summary: 'Caller needs a termite inspection but has not seen active termites.',
    })).toMatchObject({ ok: true, service: 'Termite Inspection' });
  });

  test('does not treat bare new-construction property context as pre-slab termite work', () => {
    expect(resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: 'general pest control for a new construction home',
      call_summary: 'Caller booked pest control for a newly built home.',
    })).toMatchObject({ ok: true, service: 'General Pest Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: 'roach treatment',
      call_summary: 'Customer needs roach treatment before concrete work starts.',
    })).toMatchObject({ ok: true, service: 'General Pest Control' });
  });

  test('keeps extracted service ahead of incidental transcript service words', () => {
    expect(resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: 'roach treatment',
      call_summary: 'Customer clarified this is not termites; needs roach treatment.',
    })).toMatchObject({ ok: true, service: 'General Pest Control' });

    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'not pre-slab termite work; needs roach treatment',
      call_summary: 'Customer clarified this is not termites; needs roach treatment.',
    })).toMatchObject({ ok: true, service: 'General Pest Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: 'roach treatment',
      call_summary: 'Customer booked roach treatment.',
    }, {
      transcription: 'Caller clarified this is not pre-slab termite work; they need roach treatment.',
    })).toMatchObject({ ok: true, service: 'General Pest Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: 'roach treatment',
      call_summary: 'Customer booked roach treatment.',
    }, {
      transcription: 'Caller works for Acme Construction Company and needs roach treatment at the office.',
    })).toMatchObject({ ok: true, service: 'General Pest Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'no bed bugs, mice only',
      call_summary: 'Customer has mice and no bed bugs.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'not WDO, need rodent service',
      call_summary: 'Customer clarified this is not a WDO inspection and needs rodent service.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });
  });

  test('rejects admin follow-up calls even if AI guessed a termite appointment service', () => {
    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: null,
      call_summary: 'Customer followed up about the compliance report, sticker, and invoice for a completed service.',
      pain_points: 'Needs the paperwork and payment link for inspection records.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer wants to make a payment for the rodent service Monday at 10 AM.',
      pain_points: 'Needs to pay for completed rodent service.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'rodent control',
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer wants to make a payment for the rodent service Monday at 10 AM.',
      pain_points: 'Needs to pay for completed rodent service.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'General Pest Control',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer wants to make a payment for the pest service Monday at 10 AM.',
      pain_points: 'Needs to pay for completed pest service.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: null,
      call_summary: 'Customer followed up about the WDO inspection report, compliance sticker, and invoice for a completed service.',
      pain_points: 'Needs paperwork and payment link.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: 'WDO Inspection',
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer followed up about WDO report and invoice paperwork by Monday at 10 AM.',
      pain_points: 'Needs paperwork.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer followed up about WDO report and invoice for the inspection scheduled for Monday at 10 AM.',
      pain_points: 'Needs paperwork.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer asked us to send the WDO report from yesterday.',
      pain_points: null,
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer wants the termite report from yesterday.',
      pain_points: null,
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer confirmed Monday at 10 AM and asked for the WDO report from yesterday.',
      pain_points: null,
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: null,
      call_summary: 'Customer followed up about invoice and WDO report for completed inspection.',
      pain_points: 'Needs the WDO report and payment link.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer followed up about WDO report and invoice; payment is set for Monday at 10 AM.',
      pain_points: 'Needs paperwork.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer asked to send someone the WDO report and invoice by Monday at 10 AM.',
      pain_points: 'Needs paperwork.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer followed up about WDO report and invoice for the appointment scheduled for Monday at 10 AM.',
      pain_points: 'Needs paperwork and invoice.',
    })).toMatchObject({
      ok: false,
      reason: 'administrative_followup',
    });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer followed up about the invoice for a completed service and appointment is confirmed for rodent control Monday at 10 AM.',
      pain_points: 'Needs next appointment.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });
  });

  test('allows confirmed appointments that mention invoice or payment logistics', () => {
    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'rodent control',
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Caller booked rodent control. Appointment is confirmed for Monday at 10 AM and they can pay the invoice after service.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'rodent control',
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Caller needs rodent control Monday at 10 AM and asked whether payment is due after service.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Caller needs rodent control Monday at 10 AM and asked whether payment is due after service.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer confirmed Monday at 10 for rodent control and asked about payment.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer confirmed Monday at 10 AM and asked about payment.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer confirmed Monday at 10 AM and asked for an invoice.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'rodent control',
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer confirmed Monday at 10 for rodent control and needs the service report after the visit.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Caller needs rodent control Tuesday at 10 AM and asked whether payment is due after service.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'rodent control',
      appointment_confirmed: true,
      preferred_date_time: '2026-05-19T10:00',
      call_summary: 'Caller needs rodent control Tuesday at 10 AM and wants an invoice after service.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'rodent control',
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer set rodent control for Monday at 10 AM and wants an invoice after service.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'rodent control',
      appointment_confirmed: true,
      preferred_date_time: '2026-05-19T10:00',
      call_summary: 'Caller needs rodent control Tuesday at 10 AM and wants a payment link after service.',
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'WDO Inspection',
      requested_service: 'WDO Inspection',
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer booked a WDO inspection appointment for Monday at 10 AM and wants the inspection report and invoice after service.',
    })).toMatchObject({ ok: true, service: 'WDO Inspection' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'Termite Inspection',
      appointment_confirmed: true,
      preferred_date_time: '2026-05-18T10:00',
      call_summary: 'Customer scheduled a termite inspection for Monday at 10 AM and wants the invoice after service.',
    })).toMatchObject({ ok: true, service: 'Termite Inspection' });
  });

  test('uses estimate and service history for ambiguous same-as-before booking language', () => {
    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'the treatment from the estimate',
      call_summary: 'Caller asked to schedule the service from the quote we sent last week.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', notes: 'New construction soil treatment.' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'the treatment from the estimate',
      call_summary: 'Caller asked to schedule the service from the quote we sent last week.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', notes: 'New construction soil treatment.' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'same as last service',
      call_summary: 'Caller wants to schedule the same as last service.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', notes: 'New construction soil treatment.', created_at: '2026-01-01' },
        ],
        serviceRecords: [
          { service_type: 'Rodent Control', technician_notes: 'Last visit rodent bait stations.', service_date: '2026-05-01' },
        ],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'termite treatment from the estimate',
      call_summary: 'Caller asked to schedule the termite treatment from the quote we sent last week.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', notes: 'New construction soil treatment.', created_at: '2026-05-01' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'termite treatment from the estimate',
      call_summary: 'Caller asked to schedule the termite treatment from the quote we sent last week.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Termite Inspection', status: 'draft', created_at: '2026-05-15' },
          { service_interest: 'Pre-Slab Termidor', notes: 'New construction soil treatment.', status: 'sent', created_at: '2026-05-01' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'the treatment from the last estimate, not until Tuesday',
      call_summary: 'Caller wants to schedule the service from the quote, not until Tuesday.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', notes: 'New construction soil treatment.', created_at: '2026-05-01' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'the treatment from the estimate, not until Tuesday',
      call_summary: 'Caller wants the termite treatment from the quote, not until Tuesday.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', notes: 'New construction soil treatment.', created_at: '2026-05-01' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'rodent control',
      call_summary: 'Caller did not want to move forward with the last quote and now wants to schedule rodent control Tuesday.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', created_at: '2026-05-01' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Rodent Control',
      requested_service: 'rodent control',
      call_summary: 'Caller wants to schedule rodent control Tuesday. They mentioned the last quote was for pre-slab termite treatment.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', created_at: '2026-05-01' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'termite inspection',
      call_summary: 'Caller did not want to move forward with the last quote and now wants to schedule a termite inspection Tuesday.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', created_at: '2026-05-01' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Termite Inspection' });

    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'same as last service',
      call_summary: 'Caller wants to schedule the same as last service.',
    }, {
      customerServiceContext: {
        estimates: [],
        serviceRecords: [
          { service_type: 'Lawn Care', technician_notes: 'Incomplete office handoff.', service_date: '2026-05-10', status: 'incomplete' },
          { service_type: 'Rodent Control', technician_notes: 'Last completed rodent service.', service_date: '2026-05-01', status: 'completed' },
        ],
        scheduledServices: [
          { service_type: 'Lawn Care', scheduled_date: '2026-06-01', status: 'confirmed' },
        ],
      },
    })).toMatchObject({ ok: true, service: 'Rodent Control' });

    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'same as last service',
      call_summary: 'Caller wants to schedule the same as last service.',
    }, {
      customerServiceContext: {
        estimates: [],
        serviceRecords: [
          { service_type: 'General Pest Control', technician_notes: 'No rodent activity seen.', service_date: '2026-05-01', status: 'completed' },
        ],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'General Pest Control' });

    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'same service from the last estimate',
      call_summary: 'Caller wants to schedule the same service from the last estimate.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', notes: 'New construction soil treatment.', created_at: '2026-05-01' },
        ],
        serviceRecords: [
          { service_type: 'Rodent Control', service_date: '2026-05-10', status: 'completed' },
        ],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Pre-Slab Termidor' });

    expect(resolveSchedulableCallService({
      matched_service: 'Termite Inspection',
      requested_service: 'termite inspection',
      call_summary: 'Caller wants to schedule a termite inspection Tuesday. They mentioned the last quote was for pre-slab termite treatment.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', notes: 'New construction soil treatment.', created_at: '2026-05-01' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({ ok: true, service: 'Termite Inspection' });

    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: 'same as last service',
      call_summary: 'Caller wants to schedule the same as last service.',
    }, {
      customerServiceContext: {
        estimates: [],
        serviceRecords: [],
        scheduledServices: [
          { service_type: 'Rodent Control', scheduled_date: '2026-05-01', status: 'completed' },
        ],
      },
    })).toMatchObject({ ok: true, service: 'Rodent Control' });
  });

  test('uses a generic Waves Appointment for broad confirmed scheduling without service-history inference', () => {
    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-19T10:00',
      call_summary: 'Caller asked to put them down Tuesday at 10.',
    }, {
      customerServiceContext: {
        estimates: [
          { service_interest: 'Pre-Slab Termidor', notes: 'New construction soil treatment.' },
        ],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({
      ok: true,
      service: 'Waves Appointment',
    });
  });

  test('rejects unsupported transcript cues before generic Waves Appointment fallback', () => {
    expect(resolveSchedulableCallService({
      matched_service: null,
      requested_service: null,
      appointment_confirmed: true,
      preferred_date_time: '2026-05-19T10:00',
      call_summary: 'Caller asked to put them down Tuesday at 10.',
    }, {
      transcription: 'Caller: I want to schedule an SEO consultation for my construction company. Agent: I can put you down Tuesday at 10.',
      customerServiceContext: {
        estimates: [],
        serviceRecords: [],
        scheduledServices: [],
      },
    })).toMatchObject({
      ok: false,
      reason: 'unsupported_service',
      service: null,
    });
  });

  test('validates configured default technician id and returns the assigned name', async () => {
    const previousConfiguredId = process.env.CALL_BOOKING_DEFAULT_TECHNICIAN_ID;
    const fakeTechnicianConn = (rows, queries) => (table) => {
      expect(table).toBe('technicians');
      const state = { mode: null };
      return {
        where(arg) {
          if (typeof arg === 'function') {
            arg.call(this);
            return this;
          }
          queries.push(['where', arg]);
          if (arg && Object.prototype.hasOwnProperty.call(arg, 'id')) state.mode = 'id';
          return this;
        },
        whereRaw(sql, params) {
          queries.push(['whereRaw', params]);
          state.mode = 'name';
          return this;
        },
        orWhereNull(column) {
          queries.push(['orWhereNull', column]);
          return this;
        },
        first() {
          return Promise.resolve(state.mode === 'id' ? rows.id : rows.name);
        },
      };
    };

    try {
      const invalidQueries = [];
      process.env.CALL_BOOKING_DEFAULT_TECHNICIAN_ID = 'not-a-uuid';
      await expect(resolveDefaultCallBookingTechnician(fakeTechnicianConn({
        id: { id: 'should-not-query', name: 'Wrong Tech' },
        name: { id: 'adam-id', name: 'Adam B.' },
      }, invalidQueries))).resolves.toEqual({ id: 'adam-id', name: 'Adam B.' });
      expect(invalidQueries).not.toContainEqual(['where', { id: 'not-a-uuid' }]);

      const configuredId = '11111111-1111-1111-1111-111111111111';
      const validQueries = [];
      process.env.CALL_BOOKING_DEFAULT_TECHNICIAN_ID = configuredId;
      await expect(resolveDefaultCallBookingTechnician(fakeTechnicianConn({
        id: { id: configuredId, name: 'Carlos' },
        name: { id: 'adam-id', name: 'Adam B.' },
      }, validQueries))).resolves.toEqual({ id: configuredId, name: 'Carlos' });
      expect(validQueries).toContainEqual(['where', { id: configuredId }]);
    } finally {
      if (previousConfiguredId === undefined) delete process.env.CALL_BOOKING_DEFAULT_TECHNICIAN_ID;
      else process.env.CALL_BOOKING_DEFAULT_TECHNICIAN_ID = previousConfiguredId;
    }
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

describe('call lead classification (what is / isn\'t a lead)', () => {
  const {
    classifyCallerAccount,
    summarizeKnownCaller,
    isNonLeadCallContent,
    leadContactCompleteness,
    hasWorkableLeadSignal,
    normalizeCallExtraction,
  } = CallRecordingProcessor._test;

  test('classifies a phone-matched caller by pipeline stage', () => {
    expect(classifyCallerAccount('new_lead')).toBe('open_lead');
    expect(classifyCallerAccount('estimate_sent')).toBe('open_lead');
    expect(classifyCallerAccount('won')).toBe('established_customer');
    expect(classifyCallerAccount('active_customer')).toBe('established_customer');
    expect(classifyCallerAccount('')).toBe('unknown');
    expect(classifyCallerAccount(null)).toBe('unknown');
  });

  test('summarizes a known caller for the extraction prompt', () => {
    expect(summarizeKnownCaller({ first_name: 'Uma', last_name: 'Satyendra', pipeline_stage: 'won' }))
      .toEqual({ name: 'Uma Satyendra', accountType: 'established_customer' });
    expect(summarizeKnownCaller({ first_name: 'Jake', pipeline_stage: 'new_lead' }))
      .toEqual({ name: 'Jake', accountType: 'open_lead' });
    expect(summarizeKnownCaller(null)).toBeNull();
  });

  // The four owner-reported false leads, plus the genuine-but-early prospect.
  test('vetoes existing-customer / non-sales calls, keeps genuine new inquiries', () => {
    // Martin Max + Uma — "are you coming today?" / arrival check-in.
    expect(isNonLeadCallContent({ call_type: 'existing_customer_scheduling', is_lead: false })).toBe(true);
    // Missed 8 AM appointment — a complaint, not a new lead.
    expect(isNonLeadCallContent({ call_type: 'complaint', is_lead: false })).toBe(true);
    // Invoice/billing question.
    expect(isNonLeadCallContent({ call_type: 'billing' })).toBe(true);
    // Wrong number / misdial.
    expect(isNonLeadCallContent({ call_type: 'wrong_number' })).toBe(true);
    // Model's explicit no-lead verdict alone is enough.
    expect(isNonLeadCallContent({ is_lead: false })).toBe(true);
    // call_type wins even if the model contradicts itself with is_lead=true.
    expect(isNonLeadCallContent({ is_lead: true, call_type: 'existing_customer_service' })).toBe(true);

    // Genuine new prospect (the rodent shopper) — still a lead, just cold.
    expect(isNonLeadCallContent({ call_type: 'new_inquiry', is_lead: true })).toBe(false);
    // Missing/legacy signals fall back to the pipeline-stage gate (no veto).
    expect(isNonLeadCallContent({})).toBe(false);
    expect(isNonLeadCallContent({ is_lead: null })).toBe(false);
  });

  test('qualification requires full name + service address + email', () => {
    expect(leadContactCompleteness({
      first_name: 'Jesse', last_name: 'Smith', service_address: '123 Main St', email: 'jesse@example.com',
    })).toEqual({ complete: true, missing: [] });

    // Rodent shopper gave no email → not qualified, missing surfaced.
    expect(leadContactCompleteness({
      first_name: 'Martin', last_name: 'Lee', service_address: '7 Oak St', email: '',
    })).toEqual({ complete: false, missing: ['email'] });

    expect(leadContactCompleteness({ first_name: 'Sam' }))
      .toEqual({ complete: false, missing: ['last_name', 'service_address', 'email'] });
  });

  test('creates a customer-less lead for a nameless new prospect (no first name spoken)', () => {
    // The dropped-call scenario: caller asked for a termite estimate, gave an
    // address + email + service intent, but never stated a name — so the
    // customer upsert (gated on first_name) was skipped. Before this fix that
    // was a silent no_op / no_customer_match; now it's a workable lead.
    // (Fictional PII: example.com + a 555-0100 reserved number.)
    expect(hasWorkableLeadSignal({
      extracted: {
        matched_service: 'Liquid Termite Perimeter',
        requested_service: 'termite prevention services',
        email: 'prospect@example.com',
        address_line1: '100 Example Loop',
      },
      phone: '+19415550100',
    })).toBe(true);

    // Address-only (no email) still reaches/locates them → workable.
    expect(hasWorkableLeadSignal({
      extracted: { requested_service: 'mosquito control', address_line1: '100 Example Loop' },
      phone: '+19415550100',
    })).toBe(true);

    // Email-only (no address) also workable.
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'Pest Control', email: 'prospect@example.com' },
      phone: '+19415550100',
    })).toBe(true);
  });

  test('does NOT create a nameless lead without phone, service intent, or a reachback', () => {
    const base = {
      matched_service: 'Pest Control',
      email: 'prospect@example.com',
      address_line1: '100 Example Loop',
    };
    // No callback number → can't work it.
    expect(hasWorkableLeadSignal({ extracted: base, phone: null })).toBe(false);
    // No service intent → not a sales inquiry we can act on.
    expect(hasWorkableLeadSignal({
      extracted: { email: 'prospect@example.com', address_line1: '100 Example Loop' },
      phone: '+19415550100',
    })).toBe(false);
    // Service intent but no email AND no address → nothing to reach/locate.
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'Pest Control' },
      phone: '+19415550100',
    })).toBe(false);
    // Whitespace-only fields don't count.
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: '   ', email: '  ' },
      phone: '+19415550100',
    })).toBe(false);
  });

  test('normalizeCallExtraction carries is_lead + call_type through', () => {
    const out = normalizeCallExtraction({
      first_name: 'Martin', lead_quality: 'cold', is_lead: true, call_type: 'New Inquiry',
    }, { callerPhone: '+19415551212' });
    expect(out.is_lead).toBe(true);
    expect(out.call_type).toBe('new_inquiry');
    expect(out.lead_quality).toBe('cold');

    // String booleans and unknown call types are coerced/dropped.
    expect(normalizeCallExtraction({ is_lead: 'false' }).is_lead).toBe(false);
    expect(normalizeCallExtraction({ call_type: 'banana' }).call_type).toBeNull();
    expect(normalizeCallExtraction({}).is_lead).toBeNull();
    expect(normalizeCallExtraction({}).call_type).toBeNull();
  });
});

describe('DNI-forwarding caller-ID guard', () => {
  const { resolveCallContactPhone } = CallRecordingProcessor._test;
  const TWILIO_NUMBERS = require('../config/twilio-numbers');
  const BRADENTON = '+19413187612'; // a Waves tracking/location number
  const MAIN = '+19412975749';      // Waves main line
  const EXTERNAL = '+19415551234';  // a real customer

  test('isOwnedNumber matches our lines on last-10, rejects external', () => {
    expect(TWILIO_NUMBERS.isOwnedNumber(BRADENTON)).toBe(true);
    expect(TWILIO_NUMBERS.isOwnedNumber('9413187612')).toBe(true);       // 10-digit
    expect(TWILIO_NUMBERS.isOwnedNumber('(941) 318-7612')).toBe(true);   // formatted
    expect(TWILIO_NUMBERS.isOwnedNumber(MAIN)).toBe(true);
    expect(TWILIO_NUMBERS.isOwnedNumber(EXTERNAL)).toBe(false);
    expect(TWILIO_NUMBERS.isOwnedNumber('')).toBe(false);
    expect(TWILIO_NUMBERS.isOwnedNumber(null)).toBe(false);
  });

  test('inbound: keeps a real external caller', () => {
    expect(resolveCallContactPhone({ direction: 'inbound', from_phone: EXTERNAL, to_phone: BRADENTON }))
      .toBe(EXTERNAL);
  });

  test('inbound: forwarding-masked (caller is our tracking number) resolves to null, not a phantom', () => {
    expect(resolveCallContactPhone({ direction: 'inbound', from_phone: BRADENTON, to_phone: BRADENTON })).toBeNull();
    expect(resolveCallContactPhone({ direction: 'inbound', from_phone: BRADENTON, to_phone: MAIN })).toBeNull();
  });

  test('inbound: a real extracted callback number wins over a masked from_phone', () => {
    expect(resolveCallContactPhone({ direction: 'inbound', from_phone: BRADENTON, to_phone: BRADENTON }, '+19415559999'))
      .toBe('+19415559999');
  });

  test('inbound: an extracted Waves number is ignored, real from_phone is used', () => {
    expect(resolveCallContactPhone({ direction: 'inbound', from_phone: EXTERNAL, to_phone: BRADENTON }, '+19413265011'))
      .toBe(EXTERNAL);
  });

  test('outbound: returns the external customer, never our own line', () => {
    expect(resolveCallContactPhone({ direction: 'outbound', from_phone: MAIN, to_phone: EXTERNAL }))
      .toBe(EXTERNAL);
  });
});

describe('DNI-forwarding: staff forward / CSR numbers are internal, never keyed', () => {
  const { resolveCallContactPhone } = CallRecordingProcessor._test;
  const TWILIO_NUMBERS = require('../config/twilio-numbers');
  const BRADENTON = '+19413187612'; // a Waves tracking/location number
  const EXTERNAL = '+19415551234';  // a real customer
  const STAFF_FWD = '+19415550000'; // a staff cell the inbound <Dial> forwards to
  const CSR_CELL = '+19415557777';  // a CSR cell from WAVES_CSR_NUMBER_MAP

  const ENV_KEYS = ['WAVES_FALLBACK_FORWARD_NUMBERS', 'WAVES_CSR_NUMBER_MAP', 'VIRGINIA_PHONE'];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.WAVES_FALLBACK_FORWARD_NUMBERS = STAFF_FWD;
    process.env.WAVES_CSR_NUMBER_MAP = `${CSR_CELL}:Virginia`;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('isStaffForwardNumber matches configured staff/CSR numbers, rejects external', () => {
    expect(TWILIO_NUMBERS.isStaffForwardNumber(STAFF_FWD)).toBe(true);
    expect(TWILIO_NUMBERS.isStaffForwardNumber('9415550000')).toBe(true);   // last-10 match
    expect(TWILIO_NUMBERS.isStaffForwardNumber(CSR_CELL)).toBe(true);        // from CSR map
    expect(TWILIO_NUMBERS.isStaffForwardNumber(EXTERNAL)).toBe(false);
    expect(TWILIO_NUMBERS.isStaffForwardNumber(BRADENTON)).toBe(false);      // a line, not a staff cell
    expect(TWILIO_NUMBERS.isStaffForwardNumber(null)).toBe(false);
  });

  test('isInternalNumber is true for both our lines AND staff cells', () => {
    expect(TWILIO_NUMBERS.isInternalNumber(BRADENTON)).toBe(true);
    expect(TWILIO_NUMBERS.isInternalNumber(STAFF_FWD)).toBe(true);
    expect(TWILIO_NUMBERS.isInternalNumber(CSR_CELL)).toBe(true);
    expect(TWILIO_NUMBERS.isInternalNumber(EXTERNAL)).toBe(false);
  });

  test('named staff env (VIRGINIA_PHONE) is treated as internal when no explicit forward list', () => {
    delete process.env.WAVES_FALLBACK_FORWARD_NUMBERS;
    process.env.VIRGINIA_PHONE = STAFF_FWD;
    expect(TWILIO_NUMBERS.isStaffForwardNumber(STAFF_FWD)).toBe(true);
  });

  test('inbound forwarding leg (tracking From, staff cell To) resolves to null, not the CSR', () => {
    expect(resolveCallContactPhone({ direction: 'inbound', from_phone: BRADENTON, to_phone: STAFF_FWD }))
      .toBeNull();
    expect(resolveCallContactPhone({ direction: 'inbound', from_phone: BRADENTON, to_phone: CSR_CELL }))
      .toBeNull();
  });

  test('inbound forwarding leg to a staff cell still keeps a real extracted callback', () => {
    expect(resolveCallContactPhone({ direction: 'inbound', from_phone: BRADENTON, to_phone: STAFF_FWD }, EXTERNAL))
      .toBe(EXTERNAL);
  });

  test('a genuine call TO a staff cell from a real customer is unaffected (external From wins)', () => {
    expect(resolveCallContactPhone({ direction: 'inbound', from_phone: EXTERNAL, to_phone: STAFF_FWD }))
      .toBe(EXTERNAL);
  });
});

describe('referrerNameFromExtracted (word-of-mouth referral detection)', () => {
  const { referrerNameFromExtracted } = CallRecordingProcessor._test;

  test('returns the referrer name on an explicit referral', () => {
    expect(referrerNameFromExtracted({ referred_by: 'Jane Miller' })).toBe('Jane Miller');
    expect(referrerNameFromExtracted({ referred_by: '  unnamed ' })).toBe('unnamed');
  });

  test('fails closed on empty / placeholder / non-string values', () => {
    for (const v of [null, undefined, '', 'null', 'None', 'n/a', 'NO', '   ',
      'unknown', 'Not mentioned', 'not specified', 'undefined', 'nobody',
      false, true, 0, 42, {}, []]) {
      expect(referrerNameFromExtracted({ referred_by: v })).toBe('');
    }
    expect(referrerNameFromExtracted({})).toBe('');
  });
});

describe('fetchWithTimeout (provider deadline)', () => {
  const { fetchWithTimeout } = CallRecordingProcessor._test;
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('returns a response-like object whose body reads the drained bytes', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ hello: 'world' })),
    });
    const res = await fetchWithTimeout('https://x', {}, { label: 'test' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hello: 'world' });
    expect(await res.text()).toBe('{"hello":"world"}');
  });

  // The core P1 fix: fetch() resolves at headers, so a body that never settles
  // must still be aborted by the per-call timeout — not left hanging after the
  // timer was cleared at header time.
  test('times out when the body stalls after headers arrive', async () => {
    global.fetch = async (_url, { signal }) => ({
      ok: true,
      status: 200,
      headers: new Map(),
      // Body never resolves until the abort signal fires.
      arrayBuffer: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    });
    await expect(
      fetchWithTimeout('https://x', {}, { label: 'stalling body', timeoutMs: 40 }),
    ).rejects.toThrow(/stalling body request timed out \(40ms\)/);
  });

  test('aborts immediately when the shared run deadline is already exceeded', async () => {
    const spent = new AbortController();
    spent.abort();
    global.fetch = async (_url, { signal }) => {
      if (signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from('') };
    };
    await expect(
      fetchWithTimeout('https://x', {}, { label: 'over budget', deadlineSignal: spent.signal }),
    ).rejects.toThrow(/over budget request timed out \(run deadline\)/);
  });
});
