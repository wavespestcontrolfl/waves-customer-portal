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
    ['We will tell dispatch to call her.', 'direct', 'We', 'her'],
    ['We will return her call.', 'direct', 'We', 'her'],
    ['We will leave her a voice message.', 'direct', 'We', 'her'],
    ['We will send a voicemail to Ruth.', 'direct', 'We', 'Ruth'],
    ["We will call Ruth's mobile phone.", 'direct', 'We', 'Ruth'],
    ['She will hear from us.', 'recipient-first', 'us', 'She'],
    ['Your mother will receive a call from the office.', 'recipient-first', 'the office', 'Your mother'],
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

  test('a modal-only coordinated candidate retains its non-Waves governing actor', () => {
    const text = 'The caller will check, and will call her.';
    const [candidate] = recognizeCallbackCandidates(text, TARGETS);
    expect(candidate.kind).toBe('coordinated');
    expect(candidate.actor).toEqual({ text: 'The caller', start: 0, end: 10, waves: false });
    expect(text.slice(candidate.source.start, candidate.source.end)).toBe('and will call her');
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
  ])('does not create an account-holder commitment candidate: %s', (text) => {
    expect(recognizeCallbackCandidates(text, TARGETS)).toEqual([]);
  });
});
