'use strict';

const fs = require('fs');
const path = require('path');

const { STT_HINTS, TRANSCRIPTION_DOMAIN_HINT_LINE, sttHintsCsv } = require('../config/transcription-vocabulary');
const { fixSwappedSpeakerRoles } = require('../services/call-speaker-role-guard');
const {
  buildCallToTruckBrief,
  resolveCallToTruckBriefForBooking,
  backfillCallToTruckBriefOnReusedRow,
  MAX_BRIEF_CHARS,
} = require('../services/call-to-truck-brief');
const { bookedReasonBlock } = require('../services/service-report/report-writer-rules');

describe('PR B1: Waves ASR domain vocabulary hints', () => {
  test('STT_HINTS keeps original 16 terms first, stays under ConversationRelay 2000-char & XML limits, and includes SWFL/Waves domain vocabulary', () => {
    const csv = sttHintsCsv();
    expect(csv.length).toBeLessThanOrEqual(2000);
    expect(csv).not.toMatch(/[<>"&]/);
    expect(STT_HINTS.slice(0, 5)).toEqual(['Waves Pest Control', 'WaveGuard', 'Sentricon', 'Termidor', 'WDO']);
    expect(STT_HINTS).toEqual(expect.arrayContaining([
      'Lakewood Ranch', 'Myakka', 'Osprey', 'Nokomis', 'Rotonda West', 'Punta Gorda',
      'Bora-Care', 'FDACS', 'St. Augustine', 'Zoysia', 'chinch bugs', 'palmetto bugs',
    ]));
    for (const term of STT_HINTS) {
      expect(term.length).toBeGreaterThan(0);
      expect(term.length).toBeLessThanOrEqual(40);
    }
    expect(TRANSCRIPTION_DOMAIN_HINT_LINE).toContain('Waves Pest Control');
    expect(TRANSCRIPTION_DOMAIN_HINT_LINE).toContain('Bora-Care');
    expect(TRANSCRIPTION_DOMAIN_HINT_LINE).toContain('FDACS');
  });

  test('call-recording-processor injects TRANSCRIPTION_DOMAIN_HINT_LINE into both OpenAI and Gemini prompts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    const occurrences = src.split('TRANSCRIPTION_DOMAIN_HINT_LINE').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
  });
});

describe('PR B1: Deterministic speaker-role swap guard', () => {
  function contentTokenMultiset(transcript) {
    const counts = {};
    for (const line of String(transcript || '').split('\n')) {
      const content = line.replace(/^\s*[^:\n]{1,30}:\s*/, '');
      for (const tok of content.toLowerCase().split(/[^a-z0-9']+/)) {
        if (tok) counts[tok] = (counts[tok] || 0) + 1;
      }
    }
    return counts;
  }

  test('swaps inverted Agent/Caller prefixes when Caller opens with unambiguous Waves staff greeting and preserves exact spoken words', () => {
    const inverted = [
      'Caller: Thank you for calling Waves Pest Control, this is Sarah, how can I help you today?',
      'Agent: Hi Sarah, I have ghost ants all over my kitchen counter.',
      'Caller: We can definitely help with that. What is your address?',
      'Agent: 123 Maplewood Rd in Bradenton.',
    ].join('\n');

    const res = fixSwappedSpeakerRoles(inverted);
    expect(res.swapped).toBe(true);
    expect(res.reason).toBe('caller_identified_as_waves_staff');
    expect(res.text).toMatch(/^Agent: Thank you for calling Waves Pest Control/);
    expect(res.text).toContain('\nCaller: Hi Sarah, I have ghost ants');
    expect(contentTokenMultiset(res.text)).toEqual(contentTokenMultiset(inverted));
  });

  test('swaps inverted outbound and standard Waves greetings', () => {
    const outboundInverted = [
      'Agent: Hello?',
      'Caller: Hi, this is Jordan calling from Waves Pest Control about your Thursday visit.',
      'Agent: Oh great, yes, 10 AM still works for me.',
    ].join('\n');

    const res = fixSwappedSpeakerRoles(outboundInverted);
    expect(res.swapped).toBe(true);
    expect(res.text).toContain('Agent: Hi, this is Jordan calling from Waves Pest Control');
    expect(res.text).toContain('Caller: Oh great, yes, 10 AM still works for me.');
    expect(contentTokenMultiset(res.text)).toEqual(contentTokenMultiset(outboundInverted));

    const standardWavesGreeting = [
      'Caller: Waves Pest Control, this is Sarah.',
      'Agent: Hi, I have ants in my pantry.',
    ].join('\n');
    const stdRes = fixSwappedSpeakerRoles(standardWavesGreeting);
    expect(stdRes.swapped).toBe(true);
    expect(stdRes.text).toMatch(/^Agent: Waves Pest Control, this is Sarah\./);

    const outboundWithCustomerQuestion = [
      'Agent: Hello?',
      'Caller: Hi, this is Jordan calling from Waves Pest Control, am I speaking with John?',
      'Agent: Yes, this is John.',
    ].join('\n');
    const qRes = fixSwappedSpeakerRoles(outboundWithCustomerQuestion);
    expect(qRes.swapped).toBe(true);
    expect(qRes.text).toContain('Agent: Hi, this is Jordan calling from Waves Pest Control, am I speaking with John?');
  });

  test('does NOT swap on customer complaints, questions, third-person voicemail references, composite transcripts, or quoted greetings', () => {
    const cases = [
      "Agent: How can I help?\nCaller: I'm frustrated with Waves Pest Control about yesterday's visit.\nAgent: I'm sorry to hear that, let me pull up your account.",
      "Agent: How can I help?\nCaller: I'm upset with Waves Pest Control and want to cancel.\nAgent: Let me help right away.",
      "Agent: How can I help?\nCaller: I'm happy with Waves Pest Control, just need to add mosquito.\nAgent: Happy to help.",
      'Agent: Hello?\nCaller: Hi, is this Waves Pest Control?\nAgent: Yes it is, how can I help?',
      'Agent: Hello?\nCaller: Good morning, Waves Pest Control?\nAgent: Yes, speaking.',
      'Agent: Hello?\nCaller: Good morning, Waves Pest Control treated my house yesterday.\nAgent: Happy to check on that for you.',
      'Agent: Hello?\nCaller: Hi Waves, how can I help you?\nAgent: Just checking in on your visit.',
      'Agent: Hello?\nCaller: Someone calling from Waves Pest Control left me a voicemail.\nAgent: Let me look up your account.',
      'Agent: Thank you for calling Waves Pest Control, this is Sarah.\nCaller: Hi, I need lawn care.',
      'Agent: How can I help today?\nCaller: Earlier the voicemail said thank you for calling Waves Pest Control and hung up.',
      'Agent: How can I help today?\nCaller: Your voicemail starts with thank you for calling Waves Pest Control.',
    ];
    for (const transcript of cases) {
      expect(fixSwappedSpeakerRoles(transcript)).toEqual({ text: transcript, swapped: false, reason: null });
    }

    const composite = [
      '[AI segment]',
      'Caller: Thank you for calling Waves Pest Control.',
      'Agent: Hi I need help.',
    ].join('\n');
    expect(fixSwappedSpeakerRoles(composite)).toEqual({ text: composite, swapped: false, reason: 'composite_transcript' });
  });
});

describe('PR B1: Call-to-Truck Brief (structured-only, report-safe & ANI-verified)', () => {
  test('emits ONLY structured pests and allowlisted property zones — never free-text pain_points, medical details, money, PII, or access codes', () => {
    const brief = buildCallToTruckBrief({
      extracted: {
        pain_points: 'Ants in the bedroom where our child uses oxygen. Quoted $250. Gate code is 4545#. Call (941) 555-0199 or test@example.com.',
        call_summary: 'The landlord will pay 200 per visit for One-Time Pest.',
      },
      v2Extraction: {
        service_request: {
          pests_observed: [
            { pest_type: 'ghost_ants', location_on_property: 'kitchen' },
            { pest_type: 'ants', location_on_property: 'bedroom where our child uses oxygen' },
            { pest_type: 'unspecified', location_on_property: null },
          ],
        },
        property: {
          no_spray_areas: 'koi pond',
          chemical_sensitivity_note: 'Severe asthma sensitivity',
          household_children_or_elderly: 'Toddler in home',
        },
      },
      catalogServiceName: 'One-Time Pest Control Service',
      isAssessmentBooking: false,
      isReService: false,
    });

    expect(brief).toBe('Pests: ghost ants (kitchen), ants');
    expect(brief).not.toMatch(/oxygen|child|asthma|toddler|koi pond|\$250|quoted|landlord|4545|941|555-0199|test@example\.com/i);
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
  });

  test('enforces GATE_CALL_ENRICH_CODES_REQUIRE_ANI synchronously using pre-loaded customerPrimaryPhone (zero DB query inside booking trx)', () => {
    const priorGate = process.env.GATE_CALL_ENRICH_CODES_REQUIRE_ANI;
    process.env.GATE_CALL_ENRICH_CODES_REQUIRE_ANI = 'true';
    try {
      const baseInput = {
        customerPrimaryPhone: '+19415550100',
        v2Extraction: {
          service_request: { pests_observed: [{ pest_type: 'ghost_ants', location_on_property: 'kitchen' }] },
        },
        catalogServiceName: 'One-Time Pest Control Service',
        isAssessmentBooking: false,
        isReService: false,
      };

      const unverified = resolveCallToTruckBriefForBooking({ ...baseInput, callerAni: '+19415559999' });
      expect(unverified).toBe('Pests: ghost ants');
      expect(unverified).not.toContain('kitchen');

      const unverifiedNoPests = resolveCallToTruckBriefForBooking({
        customerPrimaryPhone: '+19415550100',
        callerAni: '+19415559999',
        v2Extraction: {},
        catalogServiceName: 'One-Time Pest Control Service',
        isAssessmentBooking: false,
        isReService: false,
      });
      expect(unverifiedNoPests).toBe('Requested: One-Time Pest Control Service');

      const verified = resolveCallToTruckBriefForBooking({ ...baseInput, callerAni: '(941) 555-0100' });
      expect(verified).toBe('Pests: ghost ants (kitchen)');
    } finally {
      if (priorGate === undefined) delete process.env.GATE_CALL_ENRICH_CODES_REQUIRE_ANI;
      else process.env.GATE_CALL_ENRICH_CODES_REQUIRE_ANI = priorGate;
    }
  });

  test('Assessment booking keeps structured pests without leaking catalog fallback; re-service omits generic Requested fallback', () => {
    const assessment = buildCallToTruckBrief({
      v2Extraction: {
        service_request: {
          pests_observed: [{ pest_type: 'termites', location_on_property: 'garage' }],
        },
      },
      catalogServiceName: 'Waves Assessment',
      isAssessmentBooking: true,
      isReService: false,
    });
    expect(assessment).toBe('Pests: termites (garage)');

    const assessmentNoPests = buildCallToTruckBrief({
      v2Extraction: {},
      catalogServiceName: 'Waves Assessment',
      isAssessmentBooking: true,
      isReService: false,
    });
    expect(assessmentNoPests).toBeNull();

    const reserviceNoPests = buildCallToTruckBrief({
      v2Extraction: {},
      catalogServiceName: 'Covered Re-Service',
      isAssessmentBooking: false,
      isReService: true,
    });
    expect(reserviceNoPests).toBeNull();
  });

  test('caps cleanly on a word boundary within 400 chars and screens banned report copy in both brief builder and bookedReasonBlock', () => {
    const manyPests = Array.from({ length: 40 }, (_, i) => ({
      pest_type: `beetle type ${i + 1}`,
      location_on_property: 'back patio',
    }));
    const capped = buildCallToTruckBrief({ v2Extraction: { service_request: { pests_observed: manyPests } } });
    expect(capped).toBeTruthy();
    expect(capped.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(capped).not.toMatch(/[,|;:\s]$/);

    const bannedInBookedReason = bookedReasonBlock(
      {
        customer_request: 'Customer requested pet safe guaranteed pest free spray for ants.',
        customer_request_pests: ['ghost_ants'],
        customer_request_source: 'call',
      },
      (s) => s,
    );
    expect(bannedInBookedReason).toContain('Pests picked: ghost ants');
    expect(bannedInBookedReason).not.toContain('pet safe');
    expect(bannedInBookedReason).not.toContain('Reason:');

    const cleanBookedReason = bookedReasonBlock(
      {
        customer_request: 'Pests: ghost ants (kitchen)',
        customer_request_source: 'call',
      },
      (s) => s,
    );
    expect(cleanBookedReason).toContain('Reason: Pests: ghost ants (kitchen)');
  });

  test('backfillCallToTruckBriefOnReusedRow fills empty call-owned voice-agent rows (including shadow-mode re-service), preserves existing requests, and skips manual bookings', async () => {
    const updates = [];
    const mockTrx = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      update: jest.fn((payload) => {
        updates.push(payload);
        return Promise.resolve(1);
      }),
    }));
    mockTrx.schema = { hasColumn: jest.fn().mockResolvedValue(true) };

    const voiceAgentRow = {
      id: 'svc-1',
      source_call_log_id: 'call-1',
      service_type: 'Covered Re-Service',
      customer_request: null,
    };
    const filled = await backfillCallToTruckBriefOnReusedRow(mockTrx, voiceAgentRow, {
      skip: false,
      callId: 'call-1',
      briefInput: {
        callerAni: '+19415550100',
        customerPrimaryPhone: '+19415550100',
        v2Extraction: { service_request: { pests_observed: [{ pest_type: 'ghost_ants', location_on_property: 'kitchen' }] } },
        isReService: true,
      },
    });
    expect(filled.customer_request).toBe('Pests: ghost ants (kitchen)');
    expect(filled.customer_request_source).toBe('call');
    expect(updates).toHaveLength(1);

    // Preserves existing customer_request
    const preserved = await backfillCallToTruckBriefOnReusedRow(mockTrx, { ...voiceAgentRow, customer_request: 'Existing reason' }, {
      skip: false,
      callId: 'call-1',
      briefInput: { v2Extraction: { service_request: { pests_observed: [{ pest_type: 'ants' }] } } },
    });
    expect(preserved.customer_request).toBe('Existing reason');
    expect(updates).toHaveLength(1);

    // Skips attached manual bookings (skip: true) and rows owned by another call
    const skippedManual = await backfillCallToTruckBriefOnReusedRow(mockTrx, voiceAgentRow, {
      skip: true,
      callId: 'call-1',
      briefInput: { v2Extraction: { service_request: { pests_observed: [{ pest_type: 'ants' }] } } },
    });
    expect(skippedManual.customer_request).toBeNull();
    const otherCallRow = await backfillCallToTruckBriefOnReusedRow(mockTrx, { ...voiceAgentRow, source_call_log_id: 'call-other' }, {
      skip: false,
      callId: 'call-1',
      briefInput: { v2Extraction: { service_request: { pests_observed: [{ pest_type: 'ants' }] } } },
    });
    expect(otherCallRow.customer_request).toBeNull();
    expect(updates).toHaveLength(1);
  });
});
