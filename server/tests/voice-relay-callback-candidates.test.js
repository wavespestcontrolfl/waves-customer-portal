const { recognizeCallbackCandidates } = require('../services/eval/voice-relay-callback-candidates');
const {
  THIRD_PARTY_COMMITMENTS, THIRD_PARTY_NON_COMMITMENTS, GENERALIZED_GRAMMAR_COMMITMENTS,
} = require('./fixtures/voice-relay-eval-callback-corpus');

const TARGETS = ['ruth', '(?:my |your |her )?(?:mother|mom)', 'm(?:s|rs)\\.? alvarez'];

// These are grammar contracts, without a consent, privacy or refusal verdict.
// Each span must point into the original input, even with preceding UTF-16 text.
describe('callback commitment candidates', () => {
  test.each([
    ['We will call her.', 'direct', 'We', 'her'],
    ['🙂 Sure. We will call her.', 'direct', 'We', 'her'],
    ["Someone's going to call her.", 'direct', 'Someone', 'her'],
    ['The office’s going to contact Ruth.', 'direct', 'The office', 'Ruth'],
    ["The office's scheduled to call her.", 'direct', 'The office', 'her'],
    ['Someone’s scheduled to contact Ruth.', 'direct', 'Someone', 'Ruth'],
    ['We will have called your mother.', 'direct', 'We', 'your mother'],
    ['Our tech will be emailing Ruth.', 'direct', 'Our tech', 'Ruth'],
    ["I'll ask the office to call her.", 'direct', 'I', 'her'],
    ["I'll make sure the office calls her.", 'direct', 'I', 'her'],
    ['We will let the office call her.', 'direct', 'We', 'her'],
    ['We will check, and then we will review, then will call her.', 'coordinated', 'we', 'her'],
    ['We will tell dispatch to call her.', 'direct', 'We', 'her'],
    ['We will return her call.', 'direct', 'We', 'her'],
    ['We will leave her a voice message.', 'direct', 'We', 'her'],
    ['We will send a voicemail to Ruth.', 'direct', 'We', 'Ruth'],
    ["We will call Ruth's mobile phone.", 'direct', 'We', 'Ruth'],
    ['She will hear from us.', 'recipient-first', 'us', 'She'],
    ['Your mother will receive a call from the office.', 'recipient-first', 'the office', 'Your mother'],
    ['We will check, and the office will review, then will call her.', 'coordinated', 'the office', 'her'],
    ['We will check, and we will review, then will call her.', 'coordinated', 'we', 'her'],
    ['We will check, or will call her.', 'coordinated', 'We', 'her'],
    ['We will check, or call her.', 'bare-coordinated', 'We', 'her'],
    ['We will check, or the office will review, then will call her.', 'coordinated', 'the office', 'her'],
    ['We will check, and we’re going to review, then will call her.', 'coordinated', 'we', 'her'],
    ["We will check, and someone's scheduled to review, then will call her.", 'coordinated', 'someone', 'her'],
    ['We will check, and I’m going to review, then will call her.', 'coordinated', 'I', 'her'],
    ['We will check, and of course we’re going to review, then will call her.', 'coordinated', 'we', 'her'],
    ['We will call her next month.', 'direct', 'We', 'her'],
    ['We will call her next weekend.', 'direct', 'We', 'her'],
    ['We will call her next year.', 'direct', 'We', 'her'],
    ['We will call her sometime tomorrow.', 'direct', 'We', 'her'],
    ['We will call her later this week.', 'direct', 'We', 'her'],
    ['We will call her back next month.', 'direct', 'We', 'her'],
    ['We will wait, or call her.', 'bare-coordinated', 'We', 'her'],
    ['We will check, and will call her.', 'coordinated', 'We', 'her'],
    ['We will check, and call her.', 'bare-coordinated', 'We', 'her'],
    ['Sure. We will check; the office will review, then will call her.', 'coordinated', 'the office', 'her'],
    // Finding 1: a semicolon coordination keeps its governing actor even
    // with nothing restated after it.
    ['We will check; then will call her.', 'coordinated', 'We', 'her'],
    // Finding 2: a temporal/conditional prefix before the coordinated
    // subject is excluded from the capture without allow-listing it.
    ["We will check, and tomorrow we'll review, then will call her.", 'coordinated', 'we', 'her'],
    ['We will check, and if necessary we will review, then will call her.', 'coordinated', 'we', 'her'],
    // Finding 6: prepositional timing continuations.
    ['We will call her around noon.', 'direct', 'We', 'her'],
    ['We will call her within an hour.', 'direct', 'We', 'her'],
    ['We will call her back within an hour.', 'direct', 'We', 'her'],
    // Finding 9: speak with / talk to as ordinary contact verbs.
    ['We will speak with her tomorrow.', 'direct', 'We', 'her'],
    ['The office will talk to Ruth.', 'direct', 'The office', 'Ruth'],
    // Finding 10: noun-form scheduled/booked callbacks, both directions.
    ['The technician is scheduled for a phone call with her.', 'direct', 'The technician', 'her'],
    ['She is booked for a call with the office.', 'recipient-first', 'the office', 'She'],
    // Finding 11: customer service as a Waves promiser.
    ['Customer service is scheduled to call her.', 'direct', 'Customer service', 'her'],
    // Finding 12: a timing phrase between "scheduled" and the infinitive.
    ['The technician is scheduled tomorrow to call her.', 'direct', 'The technician', 'her'],
    ['We are scheduled at 3 PM to call her.', 'direct', 'We', 'her'],
    // Finding 13: the "that" complementizer in a make-sure delegation.
    ["I'll make sure that the office calls her.", 'direct', 'I', 'her'],
    // r4 finding 1: singular "she" agrees with the finite "reviews", not
    // with the base-form "call" that follows the coordinator, so the
    // callback still inherits the main clause's "We will".
    ['We will wait while she reviews and then call her.', 'bare-coordinated', 'We', 'her'],
    // r4 finding 2: a determiner-led timing phrase is not an object
    // complement.
    ['We will call her this afternoon.', 'direct', 'We', 'her'],
    ['We will call her some time tomorrow.', 'direct', 'We', 'her'],
    ['We will call her this Monday.', 'direct', 'We', 'her'],
    // r4 finding 3: the scheduled-call noun branch reuses the full contact
    // noun vocabulary, not just "(phone )?call".
    ['The technician is scheduled for a callback with her.', 'direct', 'The technician', 'her'],
    ['The technician is booked for a telephone call with her.', 'direct', 'The technician', 'her'],
    // r4 finding 4 control: a genuine Waves promiser at the very start of
    // the sentence still resolves, unlike "Ali" below.
    ['I will review and call her.', 'direct', 'I', 'her'],
  ])('%s has source, actor and actual recipient spans', (text, kind, actor, recipient) => {
    const candidates = recognizeCallbackCandidates(text, TARGETS);
    const candidate = candidates.find((item) => item.kind === kind);
    expect(candidate).toBeDefined();
    expect(candidate.actor.text).toBe(actor);
    expect(candidate.actor.waves).toBe(true);
    expect(candidate.recipient.text).toBe(recipient);
    for (const span of [candidate.source, candidate.actor, candidate.recipient]) {
      expect(text.slice(span.start, span.end)).toBe(span.text);
    }
    expect(candidate.recipient.start).toBeGreaterThanOrEqual(candidate.source.start);
    expect(candidate.recipient.end).toBeLessThanOrEqual(candidate.source.end);
  });

  test.each([
    ['you’re going to', 'you'],
    ["you're going to", 'you'],
    ['he’s scheduled to', 'he'],
    ["he's scheduled to", 'he'],
    ['you’re scheduled to', 'you'],
    ["you're scheduled to", 'you'],
  ])('a contracted auxiliary resolves the actual non-Waves actor: %s', (subject, actor) => {
    const text = `We will check, and ${subject} review, then will call her.`;
    const [candidate] = recognizeCallbackCandidates(text, TARGETS);
    expect(candidate.kind).toBe('coordinated');
    expect(candidate.actor.text).toBe(actor);
    expect(candidate.actor.waves).toBe(false);
    expect(text.slice(candidate.actor.start, candidate.actor.end)).toBe(actor);
    expect(text.slice(candidate.recipient.start, candidate.recipient.end)).toBe('her');
  });

  test.each(['and', 'or'])('a %s modal-only coordinated candidate retains its non-Waves governing actor', (link) => {
    const text = `The caller will check, ${link} will call her.`;
    const [candidate] = recognizeCallbackCandidates(text, TARGETS);
    expect(candidate.kind).toBe('coordinated');
    expect(candidate.actor).toEqual({ text: 'The caller', start: 0, end: 10, waves: false });
    expect(text.slice(candidate.source.start, candidate.source.end)).toBe(`${link} will call her`);
  });

  test.each([
    'We will call her if she agrees.',
    'We will not call her.',
    'Maybe we will call her.',
    'Whether she agrees or not, we will call her.',
    'We will call her, but only if she agrees.',
    'We will call her if she agrees, or even if she does not.',
  ])('recognition leaves consent, polarity and scope policy to its consumer: %s', (text) => {
    expect(recognizeCallbackCandidates(text, TARGETS)).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipient: expect.objectContaining({ text: 'her' }) }),
    ]));
  });

  test('every bare coordinated contact retains its own recipient span', () => {
    const text = 'We will call her if she agrees, and email him if he consents, then text them anyway.';
    const candidates = recognizeCallbackCandidates(text, TARGETS);
    expect(candidates.map((item) => item.recipient.text)).toEqual(['her', 'him', 'them']);
    for (const candidate of candidates) {
      expect(text.slice(candidate.recipient.start, candidate.recipient.end)).toBe(candidate.recipient.text);
      expect(candidate.actor.text).toBe('We');
    }
  });

  // r4 finding 6: a coordinated commitment with no intervening punctuation
  // matches both the primary direct expression and the independent
  // inherited-action scan for the same span, actor and recipient; the
  // recognizer must return exactly one candidate, keeping the direct kind.
  test('a coordinated commitment matched by both scan paths is not duplicated', () => {
    const text = 'We will check and call her.';
    const candidates = recognizeCallbackCandidates(text, TARGETS);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('direct');
    expect(candidates[0].actor.text).toBe('We');
    expect(candidates[0].recipient.text).toBe('her');
  });

  test.each([
    'We will call you back.',
    'You can ask the office to call her.',
    'We will ask you to call her.',
    'We will check and ask you to call her.',
    'We will call her landlord.',
    "She will hear from the technician's supplier.",
    'She will hear from usual contacts.',
    'We will refuse to call her.',
    'We will avoid calling her.',
    'We will wait while you review or call her.',
    'We will call her a taxi.',
    'We will call her the owner.',
    'We will consider whether to call her.',
    'We will avoid having to call her.',
    // Finding 3: a bounded multiword predicate between "you" and the
    // coordinator still lets the caller govern the coordinated action.
    'We will wait while you carefully review or call her.',
    'We will wait while you review it or call her.',
    // Finding 4: demonstrative/possessive object complements are naming
    // uses, not callback commitments, for every determiner the phrase-end
    // grammar accepts.
    'We will call her this nickname.',
    'We will call her that name.',
    'We will call him some fool.',
    // Finding 5: deliberation and refusal infinitives, whatever verb
    // governs them.
    'We will debate whether to call her.',
    'We will plan whether to call her.',
    'We will try not to call her.',
    // Finding 8: an -ly word right after "her" can be a possessive noun,
    // not a trailing adverb.
    'We will call her family.',
    'We will call her ally.',
    // r4 finding 1: "you"/"they" still govern a following base-form verb
    // (real actor shift), unlike singular "she"/"he"/"it" above.
    'We will wait while you review and call her.',
    'We will wait while they review and call her.',
    // r4 finding 2: an ordinary (non-timing) noun after the determiner is
    // still an object-complement/naming use, not a callback commitment.
    'We will call her this nickname.',
    'We will call her that name.',
    'We will call him some fool.',
    // r4 finding 4: "Ali" is not a Waves promiser merely because it ends in
    // "i" — the inherited scan needs a real word-start boundary.
    'Ali will review and call her.',
    // r4 finding 5: a finite embedded question ("if/whether" + subject +
    // finite verb) is deliberation or observation, not a commitment,
    // whatever verb introduces it.
    'We will see if they call her.',
    'We will check whether they call her.',
  ])('does not create an account-holder commitment candidate: %s', (text) => {
    expect(recognizeCallbackCandidates(text, TARGETS)).toEqual([]);
  });

  test.each([
    ['We will call José.', ['josé'], 'José'],
    ['We will call Zoë.', ['zoë'], 'Zoë'],
  ])('a recipient alias ending in a non-ASCII letter matches before end of input: %s', (text, aliasTargets, recipient) => {
    const [candidate] = recognizeCallbackCandidates(text, aliasTargets);
    expect(candidate).toBeDefined();
    expect(candidate.kind).toBe('direct');
    expect(candidate.recipient.text).toBe(recipient);
    expect(text.slice(candidate.recipient.start, candidate.recipient.end)).toBe(recipient);
  });

  // Finding 7: the same Unicode-safe boundary matters at the START of a
  // match too, for a recipient-first alias beginning with a non-ASCII letter.
  test('a recipient-first alias beginning with a non-ASCII letter matches at the start of input', () => {
    const text = 'Élodie will receive a call from the office.';
    const [candidate] = recognizeCallbackCandidates(text, ['élodie']);
    expect(candidate).toBeDefined();
    expect(candidate.kind).toBe('recipient-first');
    expect(candidate.actor.text).toBe('the office');
    expect(candidate.recipient.text).toBe('Élodie');
    expect(text.slice(candidate.recipient.start, candidate.recipient.end)).toBe('Élodie');
  });

  // Parity with the main evaluator: every sentence server/tests/voice-relay-
  // eval.test.js already treats as a Waves commitment to contact the
  // account holder must surface at least one Waves-actor candidate here,
  // and every sentence it treats as no such commitment must surface none.
  // See server/tests/fixtures/voice-relay-eval-callback-corpus.js for the
  // exact source lines this corpus is drawn from, and its module comment
  // for the two deferred exclusions (present-progressive forms, Spanish).
  describe('parity with the main evaluator\'s callback-commitment corpus', () => {
    test.each(THIRD_PARTY_COMMITMENTS)('is recognized as a Waves callback candidate: %s', (text) => {
      const candidates = recognizeCallbackCandidates(text, TARGETS);
      expect(candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ actor: expect.objectContaining({ waves: true }) }),
      ]));
    });

    test.each(GENERALIZED_GRAMMAR_COMMITMENTS)('is recognized as a Waves callback candidate: %s', (text) => {
      const candidates = recognizeCallbackCandidates(text, TARGETS);
      expect(candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ actor: expect.objectContaining({ waves: true }) }),
      ]));
    });

    test.each(THIRD_PARTY_NON_COMMITMENTS)('is not recognized as a Waves callback candidate: %s', (text) => {
      const candidates = recognizeCallbackCandidates(text, TARGETS);
      expect(candidates.some((c) => c.actor.waves)).toBe(false);
    });
  });
});
