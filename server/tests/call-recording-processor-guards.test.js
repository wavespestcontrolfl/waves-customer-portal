const CallRecordingProcessor = require('../services/call-recording-processor');

describe('call recording appointment guardrails', () => {
  const {
    canonicalWavesService,
    extractedNameMatchesCustomer,
    maskPhone,
    resolveCallContactPhone,
    isLiveLeadConversation,
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

  test('contacted requires a processed live conversation, never a voicemail or attempt', () => {
    const evidence = { call: { status: 'completed' }, extracted: { is_voicemail: false },
      leadId: 'lead-1', finalStatus: 'processed', transcription: 'Customer and staff discuss a quote.' };
    expect(isLiveLeadConversation(evidence)).toBe(true);
    for (const patch of [
      { call: { status: 'no-answer' } }, { call: { status: 'completed', call_outcome: 'voicemail' } },
      { extracted: { is_voicemail: true } }, { extracted: {} },
      { extracted: { is_voicemail: false, is_spam: true } }, { leadId: null },
      { extracted: { is_voicemail: false, is_spam: false,
        call_summary: require('../utils/extraction-compat').EXTRACTION_INVALID_JSON_SUMMARY } },
      { finalStatus: 'extraction_failed' }, { nonLeadCall: true },
      { voicemailLeadPath: true }, { transcription: '' },
    ]) expect(isLiveLeadConversation({ ...evidence, ...patch })).toBe(false);
  });

  test('uses the actual prospect destination for form callback bridges', () => {
    const call = {
      direction: 'outbound', source: 'lead-webhook-auto-bridge',
      from_phone: '+19412975749', to_phone: '+19415993489',
      metadata: { type: 'lead_auto_bridge', leadPhone: '+19145550123' },
    };
    expect(resolveCallContactPhone(call)).toBe('+19145550123');
    expect(resolveCallContactPhone({ ...call, metadata: JSON.stringify(call.metadata) }))
      .toBe('+19145550123');
    // A spoken callback is not allowed to replace this known dialed identity.
    expect(resolveCallContactPhone(call, '+19145550999')).toBe('+19145550123');
    for (const metadata of ['{', null, { type: 'lead_auto_bridge', leadPhone: '+19412975749' }]) {
      expect(resolveCallContactPhone({ ...call, metadata })).toBeNull();
    }
    expect(resolveCallContactPhone({ ...call, source: 'admin-click', to_phone: '+19145550456' }))
      .toBe('+19145550456');
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
          if (arg && typeof arg === 'object' && (Object.prototype.hasOwnProperty.call(arg, 'id') || Object.prototype.hasOwnProperty.call(arg, 'technicians.id'))) state.mode = 'id';
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
        select() {
          return Promise.resolve([]);
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
      expect(invalidQueries).not.toContainEqual(['where', { 'technicians.id': 'not-a-uuid' }]);

      const configuredId = '11111111-1111-1111-1111-111111111111';
      const validQueries = [];
      process.env.CALL_BOOKING_DEFAULT_TECHNICIAN_ID = configuredId;
      await expect(resolveDefaultCallBookingTechnician(fakeTechnicianConn({
        id: { id: configuredId, name: 'Carlos' },
        name: { id: 'adam-id', name: 'Adam B.' },
      }, validQueries))).resolves.toEqual({ id: configuredId, name: 'Carlos' });
      expect(validQueries).toContainEqual(['where', { 'technicians.id': configuredId }]);
      // Assignability filters (technician-eligibility.js) ride on every resolver query.
      expect(validQueries).toContainEqual(['where', 'technicians.employment_status']);
      expect(validQueries).toContainEqual(['where', 'technicians.field_dispatchable']);
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

    expect(complete).toMatchObject({ ok: true, missing: [], advisory: [] });
  });

  test('missing or garbled email is ADVISORY — the booking proceeds (owner ruling 2026-07-31)', () => {
    const base = {
      first_name: 'Jesse',
      last_name: 'Smith',
      phone: '+19417308491',
      address_line1: '123 Main St',
      city: 'Bradenton',
      state: 'FL',
      zip: '34205',
    };

    // No email anywhere → books, advisory card requested.
    const noEmail = validatePhoneCallAppointmentCustomer(base, {}, null);
    expect(noEmail.ok).toBe(true);
    expect(noEmail.missing).toEqual([]);
    expect(noEmail.advisory).toEqual(['email']);

    // Garbled capture counts the same as no capture.
    const garbled = validatePhoneCallAppointmentCustomer({ ...base, email: 'not-an-email' }, {}, null);
    expect(garbled.ok).toBe(true);
    expect(garbled.advisory).toEqual(['email']);

    // A service-contact slot email still satisfies the advisory (realtor-books-for-buyer flow).
    const slot = validatePhoneCallAppointmentCustomer({ ...base, service_contact_email: 'buyer@example.com' }, {}, null);
    expect(slot.ok).toBe(true);
    expect(slot.advisory).toEqual([]);

    // Email absence never masks a REAL missing field.
    const alsoMissingZip = validatePhoneCallAppointmentCustomer({ ...base, zip: '' }, {}, null);
    expect(alsoMissingZip.ok).toBe(false);
    expect(alsoMissingZip.missing).toEqual(['zip']);
    expect(alsoMissingZip.advisory).toEqual(['email']);
  });
});

describe('call lead classification (what is / isn\'t a lead)', () => {
  const {
    classifyCallerAccount,
    summarizeKnownCaller,
    failOpenKnownCustomer,
    trustValidatedNewLeadAddress,
    buildFailOpenRoutingContext,
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
      .toEqual({ name: 'Uma Satyendra', accountType: 'established_customer', isExistingCustomer: true, hasAddress: false, pipelineStage: 'won', addressTrusted: true, addressOnly: false, addressLine1: null, addressLine2: null, addressCity: null, addressState: null, addressZip: null });
    expect(summarizeKnownCaller({ first_name: 'Uma', last_name: 'Satyendra', pipeline_stage: 'won', address_line1: '123 Main St', address_line2: 'Apt 4', city: 'Venice', state: 'FL', zip: '34285' }))
      .toEqual({ name: 'Uma Satyendra', accountType: 'established_customer', isExistingCustomer: true, hasAddress: true, pipelineStage: 'won', addressTrusted: true, addressOnly: false, addressLine1: '123 Main St', addressLine2: 'Apt 4', addressCity: 'Venice', addressState: 'FL', addressZip: '34285' });
    expect(summarizeKnownCaller({ first_name: 'Jake', pipeline_stage: 'new_lead' }))
      .toEqual({ name: 'Jake', accountType: 'open_lead', isExistingCustomer: false, hasAddress: false, pipelineStage: 'new_lead', addressTrusted: false, addressOnly: false, addressLine1: null, addressLine2: null, addressCity: null, addressState: null, addressZip: null });
    // Terminal/lapsed stages classify as established for the PROMPT but never
    // earn fail-open trust (codex r10 P2): stale on-file data must not clear
    // address/confidence blockers.
    expect(summarizeKnownCaller({ first_name: 'Old', pipeline_stage: 'churned', address_line1: '9 Stale St' }))
      .toEqual({ name: 'Old', accountType: 'established_customer', isExistingCustomer: false, hasAddress: true, pipelineStage: 'churned', addressTrusted: false, addressOnly: false, addressLine1: '9 Stale St', addressLine2: null, addressCity: null, addressState: null, addressZip: null });
    expect(summarizeKnownCaller({ first_name: 'Ann', pipeline_stage: 'active_customer' }).isExistingCustomer).toBe(true);
    expect(summarizeKnownCaller({ first_name: 'Amy', pipeline_stage: 'at_risk' }).isExistingCustomer).toBe(true);
    expect(summarizeKnownCaller(null)).toBeNull();
  });

  test('a new lead earns address-only trust when its on-file address validates server-side; the verdict is replayable by the audit context (owner ruling 2026-09-24, codex #4685 r1/r2)', async () => {
    const lead = (extra = {}) => summarizeKnownCaller({ id: 'lead-1', first_name: 'Form', pipeline_stage: 'new_lead', address_line1: '1234 Sample Palm Dr', address_line2: 'Unit 2', city: 'Venice', state: 'FL', zip: '34292', latitude: '27.1', longitude: '-82.4', ...extra });
    expect(lead()).toMatchObject({ accountType: 'open_lead', isExistingCustomer: false, addressTrusted: false, addressOnly: false });
    // Stored lat/lng are not proof (they can be client-supplied): the sync
    // summary never trusts a lead; the async pass validates the on-file lines.
    const accept = jest.fn(async () => ({ status: 'validated_accept', inServiceArea: true }));
    const trusted = await trustValidatedNewLeadAddress(lead(), { validate: accept });
    expect(accept).toHaveBeenCalledWith({ addressLines: ['1234 Sample Palm Dr', 'Unit 2', 'Venice, FL 34292'], administrativeArea: 'FL' });
    expect(trusted).toMatchObject({ addressTrusted: true, addressOnly: true, addressState: 'FL', onFileAddressVerdict: { status: 'validated_accept', inServiceArea: true, address: { line1: '1234 sample palm dr', line2: 'unit 2', city: 'venice', state: 'fl', zip: '34292' } } });
    expect(failOpenKnownCustomer(trusted)).toEqual({ addressOnly: true, hasAddress: true, addressLine1: '1234 Sample Palm Dr', addressLine2: 'Unit 2', addressCity: 'Venice', addressZip: '34292' });
    // Judged once per pass: a second call does not re-validate.
    await trustValidatedNewLeadAddress(trusted, { validate: accept });
    expect(accept).toHaveBeenCalledTimes(1);
    // Any other verdict, out of area, or a validator error: no trust, verdict recorded.
    for (const verdict of [{ status: 'missing_component', inServiceArea: true }, { status: 'validated_accept', inServiceArea: false }, { status: 'validated_accept', inServiceArea: null }, { status: 'out_of_service_area', inServiceArea: false }, null]) {
      const out = await trustValidatedNewLeadAddress(lead(), { validate: async () => verdict });
      expect(out.addressTrusted).toBe(false);
      expect(failOpenKnownCustomer(out)).toBeNull();
    }
    const errored = await trustValidatedNewLeadAddress(lead(), { validate: async () => { throw new Error('quota'); } });
    expect(errored).toMatchObject({ addressTrusted: false, onFileAddressVerdict: { status: 'validator_error' } });
    // The stored state is validated AS STORED: a non-Florida state fails closed without a network call (r2 P1).
    const ga = jest.fn();
    const outOfState = await trustValidatedNewLeadAddress(lead({ state: 'GA' }), { validate: ga });
    expect(ga).not.toHaveBeenCalled();
    expect(outOfState).toMatchObject({ addressTrusted: false, onFileAddressVerdict: { status: 'stored_state_outside_service_area', inServiceArea: false } });
    // "Florida" spelled out is Florida (r3 P2); an unrecognisable state fails closed.
    const spelled = jest.fn(async () => ({ status: 'validated_accept', inServiceArea: true }));
    const spelledOut = await trustValidatedNewLeadAddress(lead({ state: 'Florida' }), { validate: spelled });
    expect(spelledOut).toMatchObject({ addressTrusted: true, addressState: 'FL' });   // the proof snapshot carries the validated state (r4 P2)
    expect((await trustValidatedNewLeadAddress(lead({ state: null }), { validate: spelled })).addressState).toBe('FL');
    expect(spelled).toHaveBeenCalledWith({ addressLines: ['1234 Sample Palm Dr', 'Unit 2', 'Venice, FL 34292'], administrativeArea: 'FL' });
    const junk = jest.fn();
    expect((await trustValidatedNewLeadAddress(lead({ state: 'ZZ' }), { validate: junk })).onFileAddressVerdict.status).toBe('stored_state_outside_service_area');
    expect(junk).not.toHaveBeenCalled();
    // A confirmed booking with fail-open booking OFF keeps its flags for review whatever the verdict: no lookup (r3 P2).
    const confirmedOff = jest.fn();
    const confirmed = { scheduling: { status: 'confirmed', confirmed_start_at: '2026-10-01T13:00:00-04:00' }, property: { service_address: {} } };
    expect((await trustValidatedNewLeadAddress(lead(), { validate: confirmedOff, extraction: confirmed, failOpen: false })).addressTrusted).toBe(false);
    expect(confirmedOff).not.toHaveBeenCalled();
    const confirmedOn = jest.fn(async () => ({ status: 'validated_accept', inServiceArea: true }));
    expect((await trustValidatedNewLeadAddress(lead(), { validate: confirmedOn, extraction: confirmed, failOpen: true })).addressTrusted).toBe(true);
    // A call that states its own address takes the normal validation path: no on-file lookup (r2 P2).
    const untouchedByNewAddress = jest.fn();
    const stated = await trustValidatedNewLeadAddress(lead(), { validate: untouchedByNewAddress, extraction: { property: { service_address: { street_line_1: '99 Other Rd', city: 'Sarasota', postal_code: '34231' } } } });
    expect(untouchedByNewAddress).not.toHaveBeenCalled();
    expect(stated.addressTrusted).toBe(false);
    // A restated on-file address is not a new one: the lookup runs.
    const restated = jest.fn(async () => ({ status: 'validated_accept', inServiceArea: true }));
    expect((await trustValidatedNewLeadAddress(lead(), { validate: restated, extraction: { property: { service_address: { city: 'Venice' } } } })).addressTrusted).toBe(true);
    expect(restated).toHaveBeenCalledTimes(1);
    // No street or no ZIP on file: the validator is never asked.
    const noZip = jest.fn();
    expect((await trustValidatedNewLeadAddress(summarizeKnownCaller({ pipeline_stage: 'new_lead', address_line1: '1234 Sample Palm Dr' }), { validate: noZip })).addressTrusted).toBe(false);
    expect(noZip).not.toHaveBeenCalled();
    // Only the new_lead stage is validated; established customers are trusted without a call, terminal stages never.
    const untouched = jest.fn();
    expect((await trustValidatedNewLeadAddress(summarizeKnownCaller({ pipeline_stage: 'estimate_sent', address_line1: '1 A St', zip: '34292' }), { validate: untouched })).addressTrusted).toBe(false);
    expect((await trustValidatedNewLeadAddress(summarizeKnownCaller({ pipeline_stage: 'lost', address_line1: '1 A St', zip: '34292' }), { validate: untouched })).addressTrusted).toBe(false);
    const won = await trustValidatedNewLeadAddress(summarizeKnownCaller({ pipeline_stage: 'won', address_line1: '1 A St', zip: '34292' }), { validate: untouched });
    expect(won).toMatchObject({ addressTrusted: true, addressOnly: false });
    expect(failOpenKnownCustomer(won).addressOnly).toBe(false);
    expect(untouched).not.toHaveBeenCalled();
    expect(await trustValidatedNewLeadAddress(null)).toBeNull();
    expect(failOpenKnownCustomer(null)).toBeNull();
    // The offline audits mirror production from the persisted verdict, never a fresh lookup (r2 P1).
    const customer = { id: 'lead-1', first_name: 'Form', pipeline_stage: 'new_lead', address_line1: '1234 Sample Palm Dr', city: 'Venice', state: 'FL', zip: '34292' };
    const judged = { line1: '1234 sample palm dr', line2: '', city: 'venice', state: 'fl', zip: '34292' };
    const verdict = { status: 'validated_accept', inServiceArea: true, address: judged };
    const live = buildFailOpenRoutingContext({ call: { direction: 'inbound', ai_validation: { on_file_address_validation: verdict } }, customer, contactPhone: '+19415550100', failOpenEnabled: true });
    expect(live.options.knownCustomer).toMatchObject({ addressOnly: true, addressLine1: '1234 Sample Palm Dr' });
    const stringified = buildFailOpenRoutingContext({ call: { direction: 'inbound', ai_validation: JSON.stringify({ on_file_address_validation: verdict }) }, customer, contactPhone: '+19415550100', failOpenEnabled: true });
    expect(stringified.options.knownCustomer?.addressOnly).toBe(true);
    // A verdict vouches only for the address it judged: a lead whose saved address changed since is not trusted (r4 P2); a verdict with no address never is.
    expect(buildFailOpenRoutingContext({ call: { direction: 'inbound', ai_validation: { on_file_address_validation: verdict } }, customer: { ...customer, address_line1: '99 Moved Ln' }, failOpenEnabled: true }).options.knownCustomer).toBeNull();
    expect(buildFailOpenRoutingContext({ call: { direction: 'inbound', ai_validation: { on_file_address_validation: verdict } }, customer: { ...customer, state: 'GA' }, failOpenEnabled: true }).options.knownCustomer).toBeNull();   // state is part of the binding (r5 P2)
    expect(buildFailOpenRoutingContext({ call: { direction: 'inbound', ai_validation: { on_file_address_validation: verdict } }, customer: { ...customer, state: 'Florida' }, failOpenEnabled: true }).options.knownCustomer?.addressOnly).toBe(true);
    expect(buildFailOpenRoutingContext({ call: { direction: 'inbound', ai_validation: { on_file_address_validation: { status: 'validated_accept', inServiceArea: true } } }, customer, failOpenEnabled: true }).options.knownCustomer).toBeNull();
    for (const av of [null, {}, { on_file_address_validation: null }, { on_file_address_validation: { status: 'missing_component', inServiceArea: true, address: judged } }]) {
      expect(buildFailOpenRoutingContext({ call: { direction: 'inbound', ai_validation: av }, customer, contactPhone: '+19415550100', failOpenEnabled: true }).options.knownCustomer).toBeNull();
    }
    expect(buildFailOpenRoutingContext({ call: { direction: 'inbound' }, customer, failOpenEnabled: true, onFileAddressVerdict: verdict }).options.knownCustomer?.addressOnly).toBe(true);
    expect(buildFailOpenRoutingContext({ call: { direction: 'inbound' }, customer: { ...customer, pipeline_stage: 'won' }, failOpenEnabled: true }).options.knownCustomer).toMatchObject({ addressOnly: false });
  });

  // Owner directive 2026-09-26: every call-agent rule works the same for
  // inbound and outbound calls. Fail-open used to hard-exclude outbound
  // (`failOpen: !!failOpenEnabled && !isOutboundCall(call)`) — these pin the
  // reversal end to end: the routing context, composed with the SAME
  // canAutoRoute the live pass calls, actually allows a confirmed outbound
  // booking held only on recoverable flags, and the contact number it uses
  // is the dialed customer number, never our own line.
  test('fail-open now applies the same to an OUTBOUND call: recoverable flags no longer block a confirmed booking', () => {
    const { canAutoRoute } = require('../services/call-triage-flags');
    const OUR_LINE = '+19415550100';
    const CUSTOMER_NUMBER = '+19414651056';
    const outboundCall = { direction: 'outbound', from_phone: OUR_LINE, to_phone: CUSTOMER_NUMBER };

    // Item D: the contact phone buildFailOpenRoutingContext hands to
    // canAutoRoute as callerAni is the dialed number on an outbound call
    // (resolveCallContactPhone), never our own line — the same composition
    // the live pass and the offline audits use.
    const contactPhone = CallRecordingProcessor._test.resolveCallContactPhone(outboundCall);
    expect(contactPhone).toBe(CUSTOMER_NUMBER);

    const ctx = buildFailOpenRoutingContext({ call: outboundCall, customer: null, contactPhone, failOpenEnabled: true });
    expect(ctx.options.failOpen).toBe(true); // pre-fix this was false for any outbound call
    expect(ctx.options.callerAni).toBe(CUSTOMER_NUMBER);
    expect(ctx.options.callerAni).not.toBe(OUR_LINE);

    // Item A: composed with canAutoRoute, an outbound CONFIRMED booking held
    // only on recoverable flags (ANI present but caller_phone_missing) now
    // books — identical to the inbound contract in
    // call-fail-open-booking.test.js. name_email_mismatch is advisory outright
    // since #4901, so it never needed fail-open in either direction.
    const extraction = {
      triage_flags: ['caller_phone_missing', 'name_email_mismatch'],
      confidence: { overall: 0.9 },
      scheduling: { status: 'confirmed', confirmed_start_at: '2026-10-01T09:00:00-04:00' },
      consent: {},
    };
    const av = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };
    const blockedPreFix = canAutoRoute(extraction, { contactPhone, addressValidation: av, callerAni: contactPhone, failOpen: false });
    expect(blockedPreFix.allowed).toBe(false);
    const allowedPostFix = canAutoRoute(extraction, { ...ctx.options, contactPhone, addressValidation: av });
    expect(allowedPostFix.allowed).toBe(true);
    expect(allowedPostFix.failedOpenFlags).toEqual(expect.arrayContaining(['caller_phone_missing']));

    // Item C (unchanged, both before and after this lane): an UNCONFIRMED
    // call is never fail-opened into a booking, outbound or inbound — the
    // scheduling.status gate in canAutoRoute never depended on direction.
    const unconfirmed = { ...extraction, scheduling: { status: 'tentative' } };
    expect(canAutoRoute(unconfirmed, { ...ctx.options, contactPhone, addressValidation: av }).allowed).toBe(false);
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
    // No callback number: a VALID spoken email is the one workable reachback
    // (blocked/anonymous caller ID — the office emails instead of calling)...
    expect(hasWorkableLeadSignal({ extracted: base, phone: null })).toBe(true);
    // ...but an address alone is locatable, not contactable → still dropped.
    expect(hasWorkableLeadSignal({
      extracted: { matched_service: 'Pest Control', address_line1: '100 Example Loop' },
      phone: null,
    })).toBe(false);
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

  // Every env key staffForwardLast10() reads — a local .env can set the named
  // staff numbers (e.g. ADAM_PHONE) to a value colliding with the fixtures.
  const ENV_KEYS = [
    'WAVES_FALLBACK_FORWARD_NUMBERS', 'WAVES_CSR_NUMBER_MAP', 'VIRGINIA_PHONE',
    'OWNER_PHONE', 'ADAM_PHONE', 'OFFICE_MANAGER_PHONE', 'WAVES_OFFICE_MANAGER_PHONE',
  ];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    ENV_KEYS.forEach((k) => { delete process.env[k]; });
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

describe('findExistingCallAppointment (primary-appointment idempotency)', () => {
  const { findExistingCallAppointment } = CallRecordingProcessor._test;

  // Chain-recording fake: each trx('scheduled_services') call gets its own
  // log of chained clauses and resolves .first() to the next canned row.
  function fakeScheduledServicesConn(rowsByCall, calls) {
    let callIndex = -1;
    return () => {
      callIndex += 1;
      const rowForCall = rowsByCall[callIndex] ?? null;
      const log = [];
      calls.push(log);
      const chain = {};
      for (const method of ['where', 'whereNull', 'whereNotIn', 'whereRaw', 'orderBy']) {
        chain[method] = (...args) => {
          log.push([method, ...args]);
          return chain;
        };
      }
      chain.first = () => Promise.resolve(rowForCall);
      return chain;
    };
  }

  test('all lookups exclude linked follow-up child rows (parent_service_id IS NULL)', async () => {
    const calls = [];
    const result = await findExistingCallAppointment({
      customerId: 'cust-1',
      call: { id: 'call-1', twilio_call_sid: 'CA123', created_at: '2026-07-01T12:00:00Z' },
      scheduledDate: '2026-07-02',
      windowStart: '08:00',
      serviceType: 'Cockroach Control Service',
      trx: fakeScheduledServicesConn([null, null, null], calls),
    });
    expect(result ?? null).toBeNull();
    // Linked (source_call_log_id) lookup + marker lookup + date/window
    // fallback all ran, and each one filters out child rows — a pending
    // visit-2 carries the same Call SID marker, booking_source, AND
    // source_call_log_id, and must never be adopted as the primary.
    expect(calls).toHaveLength(3);
    for (const log of calls) {
      expect(log).toContainEqual(['whereNull', 'parent_service_id']);
    }
  });

  test('an ATTACHED booking is found via source_call_log_id on reprocess', async () => {
    // Attached rows (a human's booking this call was linked to) carry no
    // Call SID marker in notes and no phone_call booking_source — without
    // the linked lookup a reprocess would re-book the visit.
    const linked = { id: 'svc-9', parent_service_id: null };
    const calls = [];
    await expect(findExistingCallAppointment({
      customerId: 'cust-1',
      call: { id: 'call-7', twilio_call_sid: 'CA123' },
      trx: fakeScheduledServicesConn([linked], calls),
    })).resolves.toBe(linked);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContainEqual(['where', { customer_id: 'cust-1', source_call_log_id: 'call-7' }]);
    expect(calls[0]).toContainEqual(['whereNotIn', 'status', ['cancelled', 'rescheduled']]);
  });

  test('marker lookup still returns a matched primary appointment', async () => {
    const primary = { id: 'svc-1', parent_service_id: null };
    const calls = [];
    await expect(findExistingCallAppointment({
      customerId: 'cust-1',
      call: { twilio_call_sid: 'CA123' },
      trx: fakeScheduledServicesConn([primary], calls),
    })).resolves.toBe(primary);
    expect(calls).toHaveLength(1);
  });
});

describe('findAttachableCallAppointment (attach to a human booking instead of inserting)', () => {
  const { findAttachableCallAppointment } = CallRecordingProcessor._test;

  // Chain-recording fake that resolves the AWAITED query to an array (this
  // helper takes the full candidate list, no .first()).
  function fakeAttachConn(rows, log) {
    return () => {
      const chain = {};
      for (const method of ['where', 'whereNull', 'whereIn', 'whereNotIn', 'whereBetween', 'whereRaw', 'orderBy']) {
        chain[method] = (...args) => {
          log.push([method, ...args]);
          return chain;
        };
      }
      chain.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return chain;
    };
  }

  const manualRow = { id: 'svc-m1', status: 'confirmed', service_type: 'Pest Control', booking_source: null };

  test('exactly one live same-service row within the window → attach candidate', async () => {
    const log = [];
    const result = await findAttachableCallAppointment({
      customerId: 'cust-1',
      scheduledDate: '2026-07-20',
      serviceType: 'Pest Control',
      trx: fakeAttachConn([manualRow], log),
    });
    expect(result.row).toBe(manualRow);
    expect(result.ambiguous).toHaveLength(0);
    // The query only considers LIVE parent rows not already owned by a call:
    expect(log).toContainEqual(['whereIn', 'status', ['pending', 'confirmed']]);
    expect(log).toContainEqual(['whereNull', 'parent_service_id']);
    expect(log).toContainEqual(['whereNull', 'source_call_log_id']);
    // ±1 day around the extracted date:
    expect(log).toContainEqual(['whereBetween', 'scheduled_date', ['2026-07-19', '2026-07-21']]);
    // Same service line, normalized the same way as the primary-idempotency
    // fallback lookup:
    expect(log).toContainEqual(['whereRaw', 'LOWER(TRIM(service_type)) = LOWER(TRIM(?))', ['Pest Control']]);
  });

  test('phone_call-sourced rows are excluded (other calls keep their own dedup story)', async () => {
    const log = [];
    await findAttachableCallAppointment({
      customerId: 'cust-1',
      scheduledDate: '2026-07-20',
      serviceType: 'Pest Control',
      trx: fakeAttachConn([], log),
    });
    // The booking_source filter is a grouped where — replay it against a
    // recorder to assert NULL-or-not-phone_call semantics.
    const grouped = log.find(([method, arg]) => method === 'where' && typeof arg === 'function');
    expect(grouped).toBeDefined();
    const groupLog = [];
    const recorder = {
      whereNull: (...args) => { groupLog.push(['whereNull', ...args]); return recorder; },
      orWhereNot: (...args) => { groupLog.push(['orWhereNot', ...args]); return recorder; },
    };
    grouped[1](recorder);
    expect(groupLog).toEqual([
      ['whereNull', 'booking_source'],
      ['orWhereNot', 'booking_source', 'phone_call'],
    ]);
  });

  test('multiple plausible rows → ambiguous (human review), never a silent pick', async () => {
    const other = { ...manualRow, id: 'svc-m2' };
    const result = await findAttachableCallAppointment({
      customerId: 'cust-1',
      scheduledDate: '2026-07-20',
      serviceType: 'Pest Control',
      trx: fakeAttachConn([manualRow, other], []),
    });
    expect(result.row).toBeNull();
    expect(result.ambiguous).toEqual([manualRow, other]);
  });

  test('no candidates → empty result, and missing inputs never query', async () => {
    const emptyLog = [];
    await expect(findAttachableCallAppointment({
      customerId: 'cust-1',
      scheduledDate: '2026-07-20',
      serviceType: 'Pest Control',
      trx: fakeAttachConn([], emptyLog),
    })).resolves.toEqual({ row: null, ambiguous: [] });
    expect(emptyLog.length).toBeGreaterThan(0);

    for (const args of [
      { scheduledDate: '2026-07-20', serviceType: 'Pest Control' },      // no customer
      { customerId: 'cust-1', serviceType: 'Pest Control' },             // no date
      { customerId: 'cust-1', scheduledDate: '2026-07-20' },             // no service
      { customerId: 'cust-1', scheduledDate: 'not-a-date', serviceType: 'Pest Control' },
    ]) {
      const log = [];
      await expect(findAttachableCallAppointment({ ...args, trx: fakeAttachConn([manualRow], log) }))
        .resolves.toEqual({ row: null, ambiguous: [] });
      expect(log).toHaveLength(0);
    }
  });
});

describe('attachCandidateMatchesProperty (attach evidence gate)', () => {
  const { attachCandidateMatchesProperty } = CallRecordingProcessor._test;

  test('matching property ids agree; differing ids refuse', () => {
    expect(attachCandidateMatchesProperty({ property_id: 'prop-1' }, { propertyId: 'prop-1' })).toBe(true);
    expect(attachCandidateMatchesProperty({ property_id: 'prop-1' }, { propertyId: 'prop-2' })).toBe(false);
  });

  test('matching service address line 1 agrees (case/whitespace-insensitive)', () => {
    expect(attachCandidateMatchesProperty(
      { service_address_line1: '123  Main St' },
      { address: { line1: '123 main st' } },
    )).toBe(true);
    expect(attachCandidateMatchesProperty(
      { service_address_line1: '123 Main St' },
      { address: { line1: '456 Oak Ave' } },
    )).toBe(false);
  });

  test('same street, different unit refuses — Apt A is not evidence for Apt B', () => {
    expect(attachCandidateMatchesProperty(
      { service_address_line1: '123 Main St', service_address_line2: 'Apt A' },
      { address: { line1: '123 Main St', line2: 'Apt B' } },
    )).toBe(false);
    // One-sided unit can't confirm the match either.
    expect(attachCandidateMatchesProperty(
      { service_address_line1: '123 Main St' },
      { address: { line1: '123 Main St', line2: 'Apt B' } },
    )).toBe(false);
    // Matching units agree.
    expect(attachCandidateMatchesProperty(
      { service_address_line1: '123 Main St', service_address_line2: 'apt b' },
      { address: { line1: '123 Main St', line2: 'Apt B' } },
    )).toBe(true);
  });

  test('same street line in a different city/ZIP refuses (multi-property, no unit)', () => {
    expect(attachCandidateMatchesProperty(
      { service_address_line1: '123 Main St', service_address_city: 'Bradenton' },
      { address: { line1: '123 Main St', city: 'Venice' } },
    )).toBe(false);
    expect(attachCandidateMatchesProperty(
      { service_address_line1: '123 Main St', service_address_zip: '34205' },
      { address: { line1: '123 Main St', zip: '34293-1234' } },
    )).toBe(false);
    // ZIP+4 vs 5-digit of the SAME zip agrees; matching city agrees.
    expect(attachCandidateMatchesProperty(
      { service_address_line1: '123 Main St', service_address_city: 'Venice', service_address_zip: '34293' },
      { address: { line1: '123 Main St', city: 'venice', zip: '34293-1234' } },
    )).toBe(true);
    // City/ZIP missing on one side is unrecorded data, not a conflict.
    expect(attachCandidateMatchesProperty(
      { service_address_line1: '123 Main St' },
      { address: { line1: '123 Main St', city: 'Venice' } },
    )).toBe(true);
  });

  test('no evidence on either side = both resolve to the primary property', () => {
    expect(attachCandidateMatchesProperty({}, { propertyId: null, address: null })).toBe(true);
  });

  test('slot evidence: attach only on same date + agreeing (or absent) window', () => {
    const { attachCandidateSlotAgrees } = CallRecordingProcessor._test;
    const req = { scheduledDate: '2026-07-20', windowStart: '09:00' };
    expect(attachCandidateSlotAgrees({ scheduled_date: '2026-07-20', window_start: '09:00:00' }, req)).toBe(true);
    // Different time on the same date may be a SECOND visit — human decides.
    expect(attachCandidateSlotAgrees({ scheduled_date: '2026-07-20', window_start: '14:00:00' }, req)).toBe(false);
    // Neighbor-day matches never auto-attach.
    expect(attachCandidateSlotAgrees({ scheduled_date: '2026-07-21', window_start: '09:00:00' }, req)).toBe(false);
    // No usable time on either side → the same-date match stands.
    expect(attachCandidateSlotAgrees({ scheduled_date: '2026-07-20', window_start: null }, req)).toBe(true);
    expect(attachCandidateSlotAgrees({ scheduled_date: '2026-07-20', window_start: '09:00:00' }, { scheduledDate: '2026-07-20', windowStart: null })).toBe(true);
  });

  test('one-sided evidence cannot confirm the match — never attach on it', () => {
    // Call resolved the rental; candidate is a bare primary-property booking.
    expect(attachCandidateMatchesProperty({}, { propertyId: 'prop-9', address: { line1: '9 Rental Rd' } })).toBe(false);
    // Candidate carries an explicit property; the call resolved nothing.
    expect(attachCandidateMatchesProperty({ property_id: 'prop-9' }, { propertyId: null, address: null })).toBe(false);
  });
});

describe('startPrecedesCall — an accepted window that had already begun is never booked at its stale start (codex #4919 r1/r2 P1)', () => {
  const { startPrecedesCall } = CallRecordingProcessor._test;
  // 2026-09-26 18:30 EDT = 22:30Z. A plain /voice row: created_at IS the
  // call's start, and with no duration_seconds set the call is treated as
  // ending the instant it started (a short call).
  const CALL_AT = '2026-09-26T22:30:00Z';
  const callRow = (overrides = {}) => ({ created_at: CALL_AT, duration_seconds: 0, metadata: null, ...overrides });

  test('a same-day start earlier than the call time precedes the call', () => {
    expect(startPrecedesCall({ scheduledDate: '2026-09-26', windowStart: '18:00', call: callRow() })).toBe(true);
  });

  test('a same-day start at or after the call time does not', () => {
    expect(startPrecedesCall({ scheduledDate: '2026-09-26', windowStart: '19:00', call: callRow() })).toBe(false);
  });

  test('a later day never precedes the call', () => {
    expect(startPrecedesCall({ scheduledDate: '2026-09-27', windowStart: '08:00', call: callRow() })).toBe(false);
  });

  test('missing inputs fail open to the existing date guard', () => {
    expect(startPrecedesCall({ scheduledDate: '2026-09-26', windowStart: null, call: callRow() })).toBe(false);
    expect(startPrecedesCall({ scheduledDate: '2026-09-26', windowStart: '18:00', call: null })).toBe(false);
  });

  test('a long call crossing the window start compares against completion, not created_at (codex #4919 r2 P1)', () => {
    // Call STARTS at 17:55 ET (created_at) and runs 10 minutes, ending at
    // 18:05 ET — after the caller accepted "6 to 9 tonight" (window start
    // 18:00). created_at alone (17:55) would wrongly say the window had NOT
    // yet begun; the call's actual completion (18:05) says it had.
    const startedAt = '2026-09-26T21:55:00Z'; // 17:55 ET
    const longCall = callRow({ created_at: startedAt, duration_seconds: 600 });
    expect(startPrecedesCall({ scheduledDate: '2026-09-26', windowStart: '18:00', call: longCall })).toBe(true);
    // A window starting after the call actually ended (18:10) is still bookable.
    expect(startPrecedesCall({ scheduledDate: '2026-09-26', windowStart: '18:10', call: longCall })).toBe(false);
  });

  test('a post-call fallback row (created_at already IS the completion) is not double-corrected for duration (codex #4919 r2 P1)', () => {
    // status_callback / recording-status recovery rows insert AFTER the
    // call ends, so created_at (18:30 ET) is already the completion time.
    // Naively backing out duration_seconds (1 hour) without adding it back
    // would land on 17:30 and wrongly clear a 18:00 window as still-future.
    const postCallRow = callRow({
      created_at: '2026-09-26T22:30:00Z', // 18:30 ET, already the call's end
      duration_seconds: 3600,
      metadata: { source: 'status_callback' },
    });
    expect(startPrecedesCall({ scheduledDate: '2026-09-26', windowStart: '18:00', call: postCallRow })).toBe(true);
  });

  test('a call that itself crosses ET midnight still catches a stale start on the earlier date (codex #4919 r5 P1)', () => {
    // Call STARTS 11:55 PM ET on the 26th and runs 10 minutes, ending
    // 12:05 AM ET on the 27th. A same-calendar-day-only comparison would
    // see scheduledDate (26th) != the completion's ET date (27th) and wave
    // through an 11 PM start that is unambiguously already past by the time
    // the call ends — this compares full ET timestamps instead, so the
    // crossed midnight never exempts it.
    const crossesMidnight = callRow({ created_at: '2026-09-27T03:55:00Z', duration_seconds: 600 }); // 23:55 ET 9/26
    expect(startPrecedesCall({ scheduledDate: '2026-09-26', windowStart: '23:00', call: crossesMidnight })).toBe(true);
    // A window on the NEXT date (the 27th) is still genuinely in the future
    // relative to the call's completion and must not be flagged.
    expect(startPrecedesCall({ scheduledDate: '2026-09-27', windowStart: '08:00', call: crossesMidnight })).toBe(false);
    // A window right at/after the actual completion (12:05 AM) on the 27th
    // is also still bookable.
    expect(startPrecedesCall({ scheduledDate: '2026-09-27', windowStart: '00:05', call: crossesMidnight })).toBe(false);
  });
});

// codex #4919 r1 P1: in shadow/legacy mode, the start_before_call review
// card must be REFRESHED (take the call lock, merge into an existing open
// OR claimed 'auto_booking_skipped_after_approval' card) instead of a plain
// .ignore() that drops the reason/window/service onto an already-open card
// for a different skip reason. A live DB round-trip for this branch is
// heavy (full processRecording pipeline); the codebase's established
// pattern for these hard-to-integration-test branches (see
// call-onfile-house-number-conflict.test.js) is a source assertion plus a
// knex-compiled SQL/bindings check, used here too.
describe('start_before_call shadow-mode review card is refreshed, not dropped, on a standing card (codex #4919 r1 P1)', () => {
  const processorSrc = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');

  test('the shadow/legacy branch takes the call lock and MERGES instead of .ignore()-ing', () => {
    // The insert is inside a transaction under lockTriageCall, guarded by
    // the same superseded-worker check as every other refresh in this file.
    expect(processorSrc).toContain('start-before-call triage insert failed');
    const branch = processorSrc.slice(
      processorSrc.indexOf('same lock + merge the enforce-mode fallback'),
      processorSrc.indexOf('start-before-call triage insert failed') + 40,
    );
    expect(branch).toContain('await lockTriageCall(ttrx, call.id)');
    expect(branch).toContain("ttrx('call_log').where({ id: call.id, processing_token: procToken }).first('id')");
    expect(branch).toContain(
      "COALESCE(triage_items.payload, '{}'::jsonb) || EXCLUDED.payload",
    );
    expect(branch).not.toContain('.ignore()');
  });

  test('the refresh SQL compiles and binds the refreshed payload/summary (knex, no live DB)', () => {
    const knex = require('knex')({ client: 'pg' });
    const compiled = knex('triage_items')
      .insert({ call_log_id: 'call-1', reason_code: 'auto_booking_skipped_after_approval', payload: JSON.stringify({ skipped_reason: 'start_before_call' }) })
      .onConflict(knex.raw("(call_log_id, reason_code) WHERE status IN ('open', 'in_progress')"))
      .merge({
        payload: knex.raw("COALESCE(triage_items.payload, '{}'::jsonb) || EXCLUDED.payload"),
        summary: knex.raw('EXCLUDED.summary'),
        updated_at: new Date('2026-09-26T00:00:00Z'),
      })
      .toSQL();
    expect(compiled.sql).toContain('on conflict');
    expect(compiled.sql).toContain('do update set');
    expect(compiled.sql).not.toContain('do nothing');
    knex.destroy();
  });

  // codex #4919 round-4 P1: the merge above re-binds this SHARED reason-code
  // card ('auto_booking_skipped_after_approval') to the call's current
  // customer and clears the two house-number-dispute-specific fields, the
  // same way the enforce-mode fallback a few hundred lines below already
  // does — otherwise a merge reusing a card opened for house-number-dispute
  // reasons (on a different customer/visit) would carry that old dispute's
  // retained_service_id / retained_scheduled_date alongside this one.
  test('the shadow-mode extraPayload rebinds dispute_customer_id and clears retained_service_id/retained_scheduled_date, mirroring the enforce-mode fallback', () => {
    const shadowGateAt = processorSrc.indexOf("skipped_reason: 'start_before_call'");
    expect(shadowGateAt).toBeGreaterThan(-1);
    const shadowMergeAt = processorSrc.indexOf("COALESCE(triage_items.payload, '{}'::jsonb) || EXCLUDED.payload", shadowGateAt);
    expect(shadowMergeAt).toBeGreaterThan(shadowGateAt);
    const shadowPayload = processorSrc.slice(shadowGateAt, shadowMergeAt);
    expect(shadowPayload).toContain('dispute_customer_id: customerId ? String(customerId) : null');
    expect(shadowPayload).toContain('retained_service_id: null');
    expect(shadowPayload).toContain('retained_scheduled_date: null');

    // The enforce-mode fallback this mirrors (guarded on v2ApprovedExtraction).
    const enforceGateAt = processorSrc.indexOf('CALL_EXTRACTION_V2_DRIVES_ROUTING && v2ApprovedExtraction && extracted.appointment_confirmed');
    expect(enforceGateAt).toBeGreaterThan(shadowMergeAt);
    const enforceMergeAt = processorSrc.indexOf("COALESCE(triage_items.payload, '{}'::jsonb) || EXCLUDED.payload", enforceGateAt);
    expect(enforceMergeAt).toBeGreaterThan(enforceGateAt);
    const enforcePayload = processorSrc.slice(enforceGateAt, enforceMergeAt);
    expect(enforcePayload).toContain('dispute_customer_id: customerId ? String(customerId) : null');
    expect(enforcePayload).toContain('retained_service_id: null');
    expect(enforcePayload).toContain('retained_scheduled_date: null');
  });
});

describe('clarify-draft target phone (owner directive 2026-09-26: both directions)', () => {
  const { clarifyAskTargetPhone } = CallRecordingProcessor._test;

  test('inbound: the caller ANI', () => {
    expect(clarifyAskTargetPhone({ direction: 'inbound', from_phone: '+19145234413', to_phone: '+19412975749' }))
      .toBe('+19145234413');
  });

  test('outbound: the dialed customer number, never our own line', () => {
    expect(clarifyAskTargetPhone({ direction: 'outbound', from_phone: '+19412975749', to_phone: '+19145234413' }))
      .toBe('+19145234413');
  });

  test('outbound lead-webhook bridge: the lead leg from bridge metadata, not the staff cell in to_phone', () => {
    expect(clarifyAskTargetPhone({
      direction: 'outbound',
      source: 'lead-webhook-auto-bridge',
      from_phone: '+19412975749',
      to_phone: '+19415550123',
      metadata: { type: 'lead_auto_bridge', leadPhone: '+19145234413' },
    })).toBe('+19145234413');
  });
});

// codex #4919 pre-push P1: the "before the call date" guard reads the call's
// ET date from its START, so a recovery row inserted after ET midnight for a
// call made the evening before does not reject that evening's agreed slot.
describe('call-date guard anchors on the call start, not created_at (codex #4919)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
  test('callDateET derives from callStartedAt(call)', () => {
    expect(src).toContain('const callDateET = etDateString(callStartedAt(call) || call.created_at || new Date());');
    expect(src).not.toContain('const callDateET = etDateString(call.created_at || new Date());');
  });
  test('a recovery row inserted after ET midnight still dates the call to the prior evening', () => {
    const { callStartedAt } = require('../utils/call-timeline');
    const { etDateString } = require('../utils/datetime-et');
    const row = {
      created_at: '2026-09-27T04:10:00Z', // 00:10 ET 9/27 — recovery insert
      duration_seconds: 300,
      metadata: { source: 'recording_recovery', provider_started_at: '2026-09-26T21:00:00Z', provider_ended_at: '2026-09-26T21:05:00Z' },
    };
    expect(etDateString(callStartedAt(row))).toBe('2026-09-26');
  });
});
