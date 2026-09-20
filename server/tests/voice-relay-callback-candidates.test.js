const { recognizeCallbackCandidates } = require('../services/eval/voice-relay-callback-candidates');

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
});
