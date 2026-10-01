const { buildExtractionPrompt, extractionPromptVersion, PROMPT_VERSION, PROMPT_HASH } = require('../services/prompts/call-extraction-v1');
const { SCHEMA_VERSION } = require('../schemas/validate-extraction');

describe('v2 extraction prompt', () => {
  const transcript = 'Agent: Waves Pest Control, how can I help?\nCaller: I have roaches in my kitchen.';
  const callerPhone = '+19415551234';
  const callDateET = '2026-05-28';

  test('builds prompt with all variables interpolated', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('Waves Pest Control');
    expect(prompt).toContain('+19415551234');
    expect(prompt).toContain('2026-05-28');
    expect(prompt).toContain('I have roaches in my kitchen');
  });

  test('includes scheduling status rules', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('scheduling.status');
    expect(prompt).toContain('"confirmed"');
    expect(prompt).toContain('"requested"');
    expect(prompt).toContain('"offered"');
    expect(prompt).toContain('"ambiguous"');
  });

  test('includes evidence pinning instructions', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('EVIDENCE PINNING');
    expect(prompt).toContain('service_address');
    expect(prompt).toContain('sms_consent_given');
    expect(prompt).toContain('on_site_authorization');
  });

  test('includes pests_observed_status instructions', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('pests_observed_status');
    expect(prompt).toContain('not_observed_preventative');
    expect(prompt).toContain('not_discussed');
  });

  test('includes appointment confirmation guardrails', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('Vague references');
    expect(prompt).toContain('pre-slab');
    expect(prompt).toContain('invoice');
  });

  test('includes name extraction rules', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('Do NOT invent a name');
    expect(prompt).toContain('name_confidence');
  });

  test('includes TCPA consent rules', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('sms_consent_given');
    expect(prompt).toContain('Implied consent');
    expect(prompt).toContain('do_not_contact_request');
  });

  test('includes the multi-party arranger rules (v3 — WDO/realtor gap)', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    // Arranger calls must be treated as multi-party by default, relayed
    // contact details must never land on the caller, and arranger callers
    // get real relationship values instead of "other".
    expect(prompt).toContain('ARRANGER CALLS ARE MULTI-PARTY BY DEFAULT');
    expect(prompt).toContain('RELAYED CONTACT DETAILS');
    expect(prompt).toContain('ATTRIBUTION');
    expect(prompt).toContain('CALLER RELATIONSHIP');
    expect(prompt).toContain('"real_estate_agent"');
    expect(prompt).toContain('"lender"');
    expect(prompt).toContain('The ACCESS person is a party');
  });

  test('handles null caller phone', () => {
    const prompt = buildExtractionPrompt(transcript, null, callDateET);
    expect(prompt).toContain('unknown');
  });

  test('an accepted arrival window is a confirmed start; loose phrasing and call-ahead courtesy do not undo it (owner ruling 2026-09-26)', () => {
    const prompt = buildExtractionPrompt('', '', '');
    expect(prompt).toContain('ARRIVAL WINDOW');
    expect(prompt).toContain("\"tomorrow\"");
    expect(prompt).toContain('courtesy heads-up');
  });

  // codex #4919 round-8 P1 pinned that an arrival window with no period never
  // confirms ("the model must never invent AM/PM"). Owner decision
  // 2026-09-29 replaced the "never" with the business-hours reading the
  // owner approved for reschedules on 2026-09-28 (prompt v18): a committed
  // and accepted exact start hour with no AM/PM reads 7-11 morning, 12 and
  // 1-6 afternoon. What stays closed is asserted here.
  test('a committed and accepted start hour with NO AM/PM reads as business hours; everything else stays closed (owner decision 2026-09-29)', () => {
    const prompt = buildExtractionPrompt('', '', '');
    expect(prompt).toContain('BUSINESS-HOURS READING');
    expect(prompt).toContain('"can we plan on 2 o\'clock?" answered "Sure."');
    expect(prompt).toContain('"Tuesday, 2 to 4"; "between 2 and 4"');
    expect(prompt).toContain('7 to 11 is the morning, 12 and 1 to 6 the afternoon');
    // Fail-closed shapes, and a stated period that conflicts with the reading.
    for (const closed of ['"around two", "two-ish"', '"by two", "before two"', '"two or three"', '"two thirty"', 'an hour that is not one of 1 to 12']) {
      expect(prompt).toContain(closed);
    }
    expect(prompt).toContain('conflicts with the business-hours reading');
    expect(prompt).toContain('confirmed_start_at null');
    // The old blanket refusal is gone, and an uncommitted offer still is not confirmed.
    expect(prompt).not.toContain('so it does NOT qualify (you would otherwise have to invent AM or PM)');
    expect(prompt).toContain('stays NOT confirmed');
    expect(prompt).not.toMatch(/"Tuesday, 2 to 4"\)\s*DOES qualify/);
    // Stated periods and the already-unambiguous examples are unchanged.
    expect(prompt).toContain('"Tuesday, 2 to 4 PM"');
    expect(prompt).toContain('"between 6 and 9 tonight"');
    expect(prompt).toContain('"between 10 and noon tomorrow"');
    // agreed_slot_words.period stays null for an unstated hour.
    expect(prompt).toContain('BUSINESS-HOURS READING rule above, for a new booking or a reschedule, with period null');
  });

  test('prompt version and hash are stable', () => {
    expect(PROMPT_VERSION).toBe('v19');
    expect(PROMPT_HASH).toMatch(/^v19-[a-f0-9]{12}$/);
  });

  test('includes the family_member relationship instructions (schema 1.18.0)', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('"family_member"');
    expect(prompt).toContain('my grandfather\'s house');
    expect(prompt).toContain('spouse/partner arranging service at the SAME household');
  });

  test('includes the reschedule agreement and moved-appointment rules (schema 1.16.0)', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('caller_accepted_slot: for a booking or reschedule that ENDS with an agreed slot');
    expect(prompt).toContain('Judge the WHOLE call');
    expect(prompt).toContain('moved_appointment_date: for status "reschedule_requested" ONLY');
    expect(prompt).toContain('never infer it from the new slot');
    expect(prompt).toContain('scheduling.caller_accepted_slot (when true');
    expect(prompt).toContain('ONE speaker\'s words from ONE turn');
    expect(prompt).toContain('quote only the words that state the agreed day and time');
  });

  test('includes the agreed-slot and moved-appointment verbatim-words rules (schema 1.17.0)', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('agreed_slot_words: set ONLY when confirmed_start_at is set');
    expect(prompt).toContain('only the hour, no minutes, no AM/PM');
    expect(prompt).toContain('never take a part of the day that describes the OLD appointment');
    expect(prompt).toContain('null for noon/midnight');
    expect(prompt).toContain('moved_appointment_words: for reschedule_requested only');
    expect(prompt).toContain('null whenever moved_appointment_date is null');
    expect(prompt).toContain('When scheduling.agreed_slot_words is set, the /scheduling/confirmed_start_at quote must contain each of its non-null values');
  });

  test('includes the reschedule language-judgement rules (schema 1.20.0, owner direction 2026-09-30)', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('- definite_commitment: for a slot the call agreed');
    expect(prompt).toContain('PREFER false when genuinely unsure');
    // Real-call replay: firm bookings with a courtesy/contingency line stay definite.
    expect(prompt).toContain('FALSE only when a hedge or condition applies to WHETHER or WHEN the appointment happens');
    expect(prompt).toContain('A courtesy or contingency line about a LATER follow-up does NOT make it false');
    expect(prompt).toContain("if anything comes up I'll let you know");
    expect(prompt).toContain("we'll text you a confirmation");
    expect(prompt).toContain('the clause that states the slot, not the courtesy line after it');
    expect(prompt).toContain('"upon ..."');
    expect(prompt).toContain('- relative_date_used: for a slot the call agreed');
    expect(prompt).toContain('RESOLVE it against the call date');
    expect(prompt).toContain('- moved_appointment_relative_date_used:');
    // The contract states the verifier's closed set of weekday-less forms.
    expect(prompt).toContain('the verifier computes such dates only for these forms');
    expect(prompt).toContain('sends every other weekday-less relative date');
    expect(prompt).toContain('- scheduling.relative_date_used (when true');
  });

  test('includes the sms_declined consent rule (schema 1.19.0, codex P1 on #5292)', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('sms_declined: true only if the caller explicitly declines text messages');
    expect(prompt).toContain('even if calls are fine');
    expect(prompt).toContain('false otherwise, including when texting never came up');
    // sms_consent_given's own wording is unchanged by this addition.
    expect(prompt).toContain('sms_consent_given: true only if the caller explicitly agrees to receive text messages. Implied consent (giving a phone number) does NOT count.');
  });

  test('includes the service_request.price capture rules (call-agent audit 2026-09-23)', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('Capture ANY price stated on the call by EITHER party');
    expect(prompt).toContain('record who said it in stated_by');
    expect(prompt).toContain('amount_max_usd');
    expect(prompt).toContain('per_application');
    expect(prompt).toContain('prepay_term');
    expect(prompt).toContain('tier_mentioned');
  });

  // #4707 follow-up 1: caller_response replaces the boolean-only accepted
  // signal (which conflated "declined" with "never responded"); accepted is
  // now derived from it.
  test('includes the price.caller_response rule and derives accepted from it', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('caller_response');
    expect(prompt).toContain('no_response');
    expect(prompt).toContain('not_at_issue');
    expect(prompt).toContain('DERIVED from caller_response');
  });

  // #4707 follow-up 2: one price per call regression — a call that states
  // both a one-time and a monthly price keeps every one of them in prices[],
  // with price staying the single primary entry.
  test('includes the prices[] multi-price rule and keeps price as the primary', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('- prices:');
    expect(prompt).toContain('list EVERY distinct price here');
    expect(prompt).toContain('The PRIMARY price stated on the call — a copy of prices[0] below');
  });

  // codex #4722 r2 P1: one ordering contract, not two that can disagree —
  // the prompt used to say price falls back to "the first stated" price
  // while ALSO telling the model to order prices[] by "most consequential",
  // so the normalizer's prices[0] fallback could pick a different entry
  // than what "first stated" meant. Now prices[] itself is ordered primary
  // (accepted, else first stated) first, and price is defined as a copy of
  // prices[0] — the normalizer's rule then agrees with the prompt by
  // construction.
  test('prices[] orders the primary entry first, and price is defined as a copy of prices[0] (single ordering contract)', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('the PRIMARY entry FIRST — the accepted one if any (caller_response "accepted"), else the first price stated on the call — followed by the remaining distinct prices in the order they were stated');
    expect(prompt).not.toContain('most consequential first');
  });

  // v10: caller_id_disclaimed + phone_note (call-agent live miss 2026-09-25,
  // call 6fee5f34) — the model must flag when the caller says the incoming
  // ANI isn't theirs, and prefer any spoken callback over the ANI.
  test('includes the caller_id_disclaimed / phone_note rules', () => {
    const prompt = buildExtractionPrompt(transcript, callerPhone, callDateET);
    expect(prompt).toContain('caller_id_disclaimed');
    expect(prompt).toContain('phone_note');
    expect(prompt).toContain('prefer a spoken callback number over the incoming Twilio ANI');
  });

  test('extractionPromptVersion appends an order-sensitive catalog hash', () => {
    // No catalog → bare PROMPT_HASH, so pre-catalog rows keep their version.
    expect(extractionPromptVersion()).toBe(PROMPT_HASH);
    expect(extractionPromptVersion([])).toBe(PROMPT_HASH);
    expect(extractionPromptVersion([null, undefined, ''])).toBe(PROMPT_HASH);

    const a = extractionPromptVersion(['Cockroach Control Service', 'Rodent Control']);
    expect(a).toMatch(new RegExp(`^${PROMPT_HASH}-cat\\.[a-f0-9]{8}$`));
    // Deterministic for the same rendered catalog…
    expect(extractionPromptVersion(['Cockroach Control Service', 'Rodent Control'])).toBe(a);
    // …but a reorder renders a different prompt and must version separately,
    expect(extractionPromptVersion(['Rodent Control', 'Cockroach Control Service'])).not.toBe(a);
    // …as must an edited catalog.
    expect(extractionPromptVersion(['Cockroach Control Service'])).not.toBe(a);
  });
});

describe('v2 extraction function (extractCallDataV2)', () => {
  const CallRecordingProcessor = require('../services/call-recording-processor');
  const { extractCallDataV2 } = CallRecordingProcessor._test;

  test('extractCallDataV2 is exported for testing', () => {
    expect(typeof extractCallDataV2).toBe('function');
  });

  test('returns not_run when no provider key exists for either route leg', async () => {
    const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    KEYS.forEach((k) => delete process.env[k]);
    try {
      const result = await extractCallDataV2('test transcript', '+19415551234', {});
      expect(result.status).toBe('not_run');
      expect(result.extraction).toBeNull();
    } finally {
      KEYS.forEach((k) => {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      });
    }
  });

  test('extraction route crosses providers and pins the bake-off winner', () => {
    const { CALL_EXTRACTION_ROUTE } = CallRecordingProcessor._test;
    expect(CALL_EXTRACTION_ROUTE.primary).toEqual({ provider: 'openai', model: 'gpt-5.6-sol' });
    expect(CALL_EXTRACTION_ROUTE.fallback.provider).toBe('anthropic');
    // dispatchWithFallback rejects same-provider policies — the route must
    // never collapse to one provider.
    expect(CALL_EXTRACTION_ROUTE.fallback.provider).not.toBe(CALL_EXTRACTION_ROUTE.primary.provider);
  });

  test('a typo\'d provider fails OPEN to the openai default, never bricks the route', () => {
    jest.resetModules();
    const saved = process.env.CALL_EXTRACTION_PROVIDER;
    process.env.CALL_EXTRACTION_PROVIDER = 'gemnii';
    try {
      const fresh = require('../services/call-recording-processor');
      const route = fresh._test.CALL_EXTRACTION_ROUTE;
      expect(route.primary.provider).toBe('openai');
      expect(route.fallback.provider).toBe('anthropic');
    } finally {
      if (saved === undefined) delete process.env.CALL_EXTRACTION_PROVIDER;
      else process.env.CALL_EXTRACTION_PROVIDER = saved;
      jest.resetModules();
    }
  });

  test('gemini kill switch ignores a lingering OpenAI model override', () => {
    jest.resetModules();
    const saved = { p: process.env.CALL_EXTRACTION_PROVIDER, m: process.env.CALL_EXTRACTION_MODEL };
    process.env.CALL_EXTRACTION_PROVIDER = 'gemini';
    process.env.CALL_EXTRACTION_MODEL = 'gpt-5.6-sol'; // stale override from the Sol era
    try {
      const fresh = require('../services/call-recording-processor');
      const route = fresh._test.CALL_EXTRACTION_ROUTE;
      // One-variable rollback: the gemini leg must run a GEMINI model.
      expect(route.primary.provider).toBe('gemini');
      expect(route.primary.model).toMatch(/^gemini-/);
      expect(route.fallback.provider).toBe('anthropic');
    } finally {
      if (saved.p === undefined) delete process.env.CALL_EXTRACTION_PROVIDER; else process.env.CALL_EXTRACTION_PROVIDER = saved.p;
      if (saved.m === undefined) delete process.env.CALL_EXTRACTION_MODEL; else process.env.CALL_EXTRACTION_MODEL = saved.m;
      jest.resetModules();
    }
  });

  test('report-writer env overrides must not move the extraction default', () => {
    jest.resetModules();
    const prev = process.env.MODEL_OPENAI_REPORT_WRITER;
    process.env.MODEL_OPENAI_REPORT_WRITER = 'gpt-hypothetical-writer';
    try {
      const fresh = require('../services/call-recording-processor');
      expect(fresh._test.CALL_EXTRACTION_ROUTE.primary.model).toBe('gpt-5.6-sol');
    } finally {
      if (prev === undefined) delete process.env.MODEL_OPENAI_REPORT_WRITER;
      else process.env.MODEL_OPENAI_REPORT_WRITER = prev;
      jest.resetModules();
    }
  });
});

describe('schema version alignment', () => {
  test('schema version matches between validator and prompt', () => {
    expect(SCHEMA_VERSION).toBe('1.20.0');
  });

  test('persisted schema_version enum accepts the current SCHEMA_VERSION (P1: a missing enum entry fail-closes every extraction)', () => {
    const persistedSchema = require('../schemas/call-extraction.persisted.schema.json');
    expect(persistedSchema.properties.meta.properties.schema_version.enum).toContain(SCHEMA_VERSION);
  });

  test('prompt hash is deterministic', () => {
    const hash1 = PROMPT_HASH;
    const hash2 = PROMPT_HASH;
    expect(hash1).toBe(hash2);
  });
});

describe('migration columns', () => {
  const migration = require('../models/migrations/20260528000001_v2_extraction_columns');

  test('exports up and down functions', () => {
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});
