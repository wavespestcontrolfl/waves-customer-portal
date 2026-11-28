'use strict';

const fs = require('fs');
const path = require('path');

const { STT_HINTS, TRANSCRIPTION_DOMAIN_HINT_LINE, sttHintsCsv } = require('../config/transcription-vocabulary');
const { fixSwappedSpeakerRoles } = require('../services/call-speaker-role-guard');
const {
  buildCallToTruckBrief,
  resolveCallToTruckBriefForBooking,
  MAX_BRIEF_CHARS,
} = require('../services/call-to-truck-brief');

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

  test('does NOT swap on customer questions, third-person voicemail references, composite transcripts, or quoted greetings', () => {
    const cases = [
      'Agent: Hello?\nCaller: Hi, is this Waves Pest Control?\nAgent: Yes it is, how can I help?',
      'Agent: Hello?\nCaller: Good morning, Waves Pest Control?\nAgent: Yes, speaking.',
      'Agent: Hello?\nCaller: Good morning, Waves Pest Control treated my house yesterday.\nAgent: Happy to check on that for you.',
      'Agent: Hello?\nCaller: Hi Waves, how can I help you?\nAgent: Just checking in on your visit.',
      'Agent: Hello?\nCaller: Someone calling from Waves Pest Control left me a voicemail.\nAgent: Let me look up your account.',
      'Agent: Thank you for calling Waves Pest Control, this is Sarah.\nCaller: Hi, I need lawn care.',
      'Agent: How can I help today?\nCaller: Earlier the voicemail said thank you for calling Waves Pest Control and hung up.',
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

describe('PR B1: Call-to-Truck Brief (100% of call bookings, report-safe & ANI-verified)', () => {
  test('builds brief from schema-valid V2 pests_observed (location_on_property), keeps household/medical details out of public customer_request, and strips money/objections/PII/codes', () => {
    const brief = buildCallToTruckBrief({
      extracted: {
        pain_points: 'too expensive; Ants around the back patio. Quoted $250 one-time. Gate code is 4545#. Call (941) 555-0199 or test@example.com.',
        call_summary: 'The landlord will pay 200 per visit for One-Time Pest.',
      },
      v2Extraction: {
        service_request: {
          pests_observed: [
            { pest_type: 'ghost_ants', location_on_property: 'kitchen' },
            { pest_type: 'unspecified', location_on_property: null },
          ],
        },
        sentiment_and_lead: {
          objections_raised: ['too expensive'],
        },
        property: {
          no_spray_areas: 'koi pond',
          chemical_sensitivity_note: 'Severe asthma sensitivity',
          household_children_or_elderly: 'Toddler in home',
        },
      },
      isAssessmentBooking: false,
      isReService: false,
    });

    expect(brief).toBe('Pests: ghost ants (kitchen) | Ants around the back patio.');
    // Household medical/sensitivity notes stay strictly in property_preferences (never published into forwardable customer_request)
    expect(brief).not.toMatch(/asthma|toddler|koi pond|too expensive|\$250|quoted|landlord|200 per visit|4545|941|555-0199|test@example\.com/i);
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
  });

  test('enforces GATE_CALL_ENRICH_CODES_REQUIRE_ANI: unverified callers emit ONLY structured pest types or catalog service name', async () => {
    const priorGate = process.env.GATE_CALL_ENRICH_CODES_REQUIRE_ANI;
    process.env.GATE_CALL_ENRICH_CODES_REQUIRE_ANI = 'true';
    try {
      const mockConn = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ phone: '+19415550100' }),
      }));
      const baseInput = {
        customerId: 'cust-1',
        extracted: { pain_points: 'Please avoid spraying the nursery.' },
        v2Extraction: {
          service_request: { pests_observed: [{ pest_type: 'ghost_ants', location_on_property: 'kitchen' }] },
        },
        catalogServiceName: 'One-Time Pest Control Service',
        isAssessmentBooking: false,
        isReService: false,
      };

      const unverified = await resolveCallToTruckBriefForBooking(mockConn, { ...baseInput, callerAni: '+19415559999' });
      expect(unverified).toBe('Pests: ghost ants');
      expect(unverified).not.toContain('nursery');
      expect(unverified).not.toContain('kitchen');

      const unverifiedNoPests = await resolveCallToTruckBriefForBooking(mockConn, {
        customerId: 'cust-1',
        callerAni: '+19415559999',
        extracted: { requested_service: 'Do not treat the back lawn' },
        v2Extraction: {},
        catalogServiceName: 'One-Time Pest Control Service',
        isAssessmentBooking: false,
        isReService: false,
      });
      expect(unverifiedNoPests).toBe('Requested: One-Time Pest Control Service');
      expect(unverifiedNoPests).not.toContain('back lawn');

      const verified = await resolveCallToTruckBriefForBooking(mockConn, { ...baseInput, callerAni: '(941) 555-0100' });
      expect(verified).toBe('Pests: ghost ants (kitchen) | Please avoid spraying the nursery.');
    } finally {
      if (priorGate === undefined) delete process.env.GATE_CALL_ENRICH_CODES_REQUIRE_ANI;
      else process.env.GATE_CALL_ENRICH_CODES_REQUIRE_ANI = priorGate;
    }
  });

  test('Assessment booking (final catalog row) keeps pests_observed without leaking unagreed service or summary', () => {
    const brief = buildCallToTruckBrief({
      extracted: {
        pain_points: null,
        specific_service_name: 'Termite Fumigation Service',
        call_summary: 'Caller wants full termite fumigation.',
      },
      v2Extraction: {
        service_request: {
          specific_service_name: 'Termite Fumigation Service',
          pests_observed: [{ pest_type: 'termites', location_on_property: 'garage' }],
        },
      },
      catalogServiceName: 'Waves Assessment',
      isAssessmentBooking: true,
      isReService: false,
    });

    expect(brief).toBe('Pests: termites (garage)');
    expect(brief).not.toContain('Fumigation');
  });

  test('caps at 400 chars and screens out billing chatter, PANs, and disallowed customer-report copy violations', () => {
    const billingOnly = buildCallToTruckBrief({
      extracted: {
        pain_points: 'The landlord will pay 200 per visit. Quoted $200.',
        call_summary: 'Caller asked about autopay and credit card on file.',
      },
      isAssessmentBooking: false,
      isReService: false,
    });
    expect(billingOnly).toBeNull();

    const unsafeCopy = buildCallToTruckBrief({
      extracted: {
        pain_points: 'Customer asked for pet safe spray. Ants on kitchen counter. Card 4111-1111-1111-1111.',
      },
      isAssessmentBooking: false,
      isReService: false,
    });
    expect(unsafeCopy).toBe('Ants on kitchen counter.');

    const longPain = `Heavy ant trails along patio. ${'Active foraging near perimeter beds. '.repeat(20)}`;
    const capped = buildCallToTruckBrief({ extracted: { pain_points: longPain } });
    expect(capped).toBeTruthy();
    expect(capped.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
  });
});
