'use strict';

const fs = require('fs');
const path = require('path');

const { STT_HINTS, TRANSCRIPTION_DOMAIN_HINT_LINE, sttHintsCsv } = require('../config/transcription-vocabulary');
const { fixSwappedSpeakerRoles } = require('../services/call-speaker-role-guard');
const { buildCallToTruckBrief, MAX_BRIEF_CHARS } = require('../services/call-to-truck-brief');

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
    // 1 import + 1 OpenAI prompt + 1 Gemini fallback prompt
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
      "Caller: Hi, this is Jordan calling from Waves Pest Control about your Thursday visit.",
      'Agent: Oh great, yes, 10 AM still works for me.',
    ].join('\n');

    const res = fixSwappedSpeakerRoles(outboundInverted);
    expect(res.swapped).toBe(true);
    expect(res.text).toContain('Agent: Hi, this is Jordan calling from Waves Pest Control');
    expect(res.text).toContain('Caller: Oh great, yes, 10 AM still works for me.');
    expect(contentTokenMultiset(res.text)).toEqual(contentTokenMultiset(outboundInverted));
  });

  test('leaves correctly labeled, composite/transfer, single-speaker, and quoted-greeting transcripts untouched', () => {
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

describe('PR B1: Call-to-Truck Brief (100% of call bookings, tech-safe)', () => {
  test('builds operational technician-safe brief for regular bookings with V2 safety notes, stripping money/billing/PII/access codes', () => {
    const brief = buildCallToTruckBrief({
      extracted: {
        pain_points: 'Ghost ants in kitchen and garage. Quoted $250 one-time. Gate code is 4545#. Call 941-555-0199 or test@example.com.',
        call_summary: 'Caller booked One-Time Pest for $250. Billing party is HOA.',
      },
      v2Extraction: {
        service_request: { pests_mentioned: ['ghost_ants'] },
        property: {
          household_children_or_elderly: 'Toddler in home',
          no_spray_areas: 'Organic vegetable garden in backyard',
          chemical_sensitivity_note: 'Sensitive to strong odors',
        },
        scheduling: {
          scheduling_notes_raw: 'Dogs will be crated inside. Invoice goes to owner at $250.',
        },
      },
      isForcedAssessment: false,
      isReService: false,
    });

    expect(brief).toBeTruthy();
    expect(brief).toContain('Ghost ants in kitchen and garage.');
    expect(brief).toContain('Household: Toddler in home');
    expect(brief).toContain('No-spray areas: Organic vegetable garden in backyard');
    expect(brief).toContain('Sensitivity: Sensitive to strong odors');
    expect(brief).toContain('Dogs will be crated inside.');
    expect(brief).not.toMatch(/\$250|quoted|invoice|billing|4545|941-555-0199|test@example\.com/i);
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
  });

  test('respects forced-Assessment summary suppression (never leaks unagreed treatment summary)', () => {
    const brief = buildCallToTruckBrief({
      extracted: {
        pain_points: null,
        call_summary: 'Caller wants full termite fumigation and attic cleanout.',
      },
      v2Extraction: {
        service_request: { pests_mentioned: ['termites'] },
        scheduling: { scheduling_notes_raw: 'Bring full termite treatment rig.' },
      },
      isForcedAssessment: true,
      isReService: false,
    });

    expect(brief).toBe('Pests: termites');
    expect(brief).not.toContain('fumigation');
    expect(brief).not.toContain('rig');
  });

  test('caps brief at 400 chars and strips PAN card numbers', () => {
    const longPain = `Ants around the foundation near the pool deck. ${'Heavy trails along patio pavers. '.repeat(20)} Card 4111-1111-1111-1111.`;
    const brief = buildCallToTruckBrief({
      extracted: { pain_points: longPain },
      isForcedAssessment: false,
      isReService: false,
    });

    expect(brief).toBeTruthy();
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(brief).not.toContain('4111');
  });

  test('returns null when only billing/price chatter is present', () => {
    const brief = buildCallToTruckBrief({
      extracted: {
        pain_points: 'Quoted $200. Send invoice to billing department.',
        call_summary: 'Caller asked about autopay and credit card on file.',
      },
      isForcedAssessment: false,
      isReService: false,
    });
    expect(brief).toBeNull();
  });
});
