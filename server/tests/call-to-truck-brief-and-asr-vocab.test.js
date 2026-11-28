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

  test('swaps inverted outbound transcript when Caller introduces themselves as calling from Waves', () => {
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
  });

  test('does NOT swap when caller asks "Is this Waves Pest Control?" or "Good morning, Waves Pest Control?" or quotes a greeting', () => {
    const customerCheck = [
      'Agent: Hello?',
      'Caller: Hi, is this Waves Pest Control?',
      'Agent: Yes it is, how can I help?',
    ].join('\n');
    expect(fixSwappedSpeakerRoles(customerCheck)).toEqual({ text: customerCheck, swapped: false, reason: null });

    const morningQuestion = [
      'Agent: Hello?',
      'Caller: Good morning, Waves Pest Control?',
      'Agent: Yes, speaking.',
    ].join('\n');
    expect(fixSwappedSpeakerRoles(morningQuestion)).toEqual({ text: morningQuestion, swapped: false, reason: null });

    const customerMention = [
      'Agent: Hello?',
      'Caller: Good morning, Waves Pest Control treated my house yesterday.',
      'Agent: Happy to check on that for you.',
    ].join('\n');
    expect(fixSwappedSpeakerRoles(customerMention)).toEqual({ text: customerMention, swapped: false, reason: null });

    const customerGreetingWaves = [
      'Agent: Hello?',
      'Caller: Hi Waves, how can I help you?',
      'Agent: Just checking in on your visit.',
    ].join('\n');
    expect(fixSwappedSpeakerRoles(customerGreetingWaves)).toEqual({ text: customerGreetingWaves, swapped: false, reason: null });

    const normal = [
      'Agent: Thank you for calling Waves Pest Control, this is Sarah.',
      'Caller: Hi, I need lawn care.',
    ].join('\n');
    expect(fixSwappedSpeakerRoles(normal)).toEqual({ text: normal, swapped: false, reason: null });

    const composite = [
      '[AI segment]',
      'Caller: Thank you for calling Waves Pest Control.',
      'Agent: Hi I need help.',
    ].join('\n');
    expect(fixSwappedSpeakerRoles(composite)).toEqual({ text: composite, swapped: false, reason: 'composite_transcript' });

    const quoted = [
      'Agent: How can I help today?',
      'Caller: Earlier the voicemail said thank you for calling Waves Pest Control and hung up.',
    ].join('\n');
    expect(fixSwappedSpeakerRoles(quoted)).toEqual({ text: quoted, swapped: false, reason: null });
  });
});

describe('PR B1: Call-to-Truck Brief (100% of call bookings, ANI-verified safety, tech-safe & report-safe)', () => {
  test('builds brief from schema-valid V2 pests_observed (location_on_property) and safety notes, stripping money, sales objections, phones, emails, and access codes', () => {
    const brief = buildCallToTruckBrief({
      extracted: {
        pain_points: 'too expensive; Ants around the koi pond. Quoted $250 one-time. Gate code is 4545#. Call (941) 555-0199 or test@example.com.',
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
          chemical_sensitivity_note: 'Sensitive to strong odors',
          household_children_or_elderly: 'Toddler in home',
        },
      },
      isAssessmentBooking: false,
      isReService: false,
    });

    expect(brief).toBeTruthy();
    expect(brief).toContain('No-spray areas: koi pond');
    expect(brief).toContain('Sensitivity: Sensitive to strong odors');
    expect(brief).toContain('Household: Toddler in home');
    expect(brief).toContain('Pests: ghost ants (kitchen)');
    expect(brief).toContain('Ants around the koi pond.');
    expect(brief).not.toMatch(/too expensive|\$250|quoted|landlord|200 per visit|4545|941|555-0199|test@example\.com/i);
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
  });

  test('reserves fair-share space for ALL three safety notes even when each is 200 chars', () => {
    const noSpray200 = `Organic vegetable beds along south fence ${'near citrus trees '.repeat(10)}`.slice(0, 200);
    const sens200 = `Severe asthma sensitivity inside master bedroom ${'avoid interior aerosols '.repeat(10)}`.slice(0, 200);
    const house200 = `Newborn infant and elderly parent at home ${'stay outside while drying '.repeat(10)}`.slice(0, 200);

    const brief = buildCallToTruckBrief({
      extracted: { pain_points: 'Ants on patio.' },
      v2Extraction: {
        property: {
          no_spray_areas: noSpray200,
          chemical_sensitivity_note: sens200,
          household_children_or_elderly: house200,
        },
      },
      isAssessmentBooking: false,
      isReService: false,
    });

    expect(brief).toBeTruthy();
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(brief).toContain('No-spray areas:');
    expect(brief).toContain('Sensitivity:');
    expect(brief).toContain('Household:');
  });

  test('enforces GATE_CALL_ENRICH_CODES_REQUIRE_ANI before copying safety notes onto the job card', async () => {
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
          property: { no_spray_areas: 'backyard vegetable garden', chemical_sensitivity_note: 'odor sensitivity' },
        },
        isAssessmentBooking: false,
        isReService: false,
      };

      // Unverified caller ANI (spoken callback number mismatch) -> safety notes AND free-text pain_points/locations withheld; only structured pest type survives
      const unverified = await resolveCallToTruckBriefForBooking(mockConn, { ...baseInput, callerAni: '+19415559999' });
      expect(unverified).toBe('Pests: ghost ants');
      expect(unverified).not.toContain('No-spray');
      expect(unverified).not.toContain('Sensitivity');
      expect(unverified).not.toContain('nursery');
      expect(unverified).not.toContain('kitchen');

      // Unverified caller ANI with no pests -> uses ONLY server catalog row name (never extraction free text like requested_service)
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

      // Verified primary-phone ANI -> safety notes and full pest location included
      const verified = await resolveCallToTruckBriefForBooking(mockConn, { ...baseInput, callerAni: '(941) 555-0100' });
      expect(verified).toContain('No-spray areas: backyard vegetable garden');
      expect(verified).toContain('Sensitivity: odor sensitivity');
      expect(verified).toContain('Pests: ghost ants (kitchen)');
      expect(verified).toContain('Please avoid spraying the nursery.');
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
      isAssessmentBooking: true,
      isReService: false,
    });

    expect(brief).toBe('Pests: termites (garage)');
    expect(brief).not.toContain('Fumigation');
  });

  test('screens out unrestricted billing chatter, PANs, and disallowed customer-report copy violations', () => {
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
    expect(unsafeCopy).not.toContain('4111');
  });
});
