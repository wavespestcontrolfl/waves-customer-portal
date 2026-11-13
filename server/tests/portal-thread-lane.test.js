// The Messages thread's own turn of the portal assistant (ai-assistant/thread-lane.js, GATE_PORTAL_MESSAGES_NIGHT_AI):
// which messages need no answer and no model call, which tool results let the model's words reach the customer,
// and which tools the prompt names. Pure: no database and no mocks.
const threadLane = require('../services/ai-assistant/thread-lane');

describe('needsNoReply: a message that is only thanks, an acknowledgment or a reaction', () => {
  it.each([
    'Thanks!',
    'Thank you so much',
    'We appreciate you!!',
    'ok',
    'Ok great, thanks',
    'No problem',
    'You\'re welcome',
    '👍',
    '❤️❤️',
    '!!!',
  ])('needs no reply: %s', (body) => {
    expect(threadLane.needsNoReply(body)).toBe(true);
  });

  it.each([
    ['an empty message', ''],
    ['a message of only spaces', '   \n '],
    ['a thank-you that is a question', 'Thanks?'],
    ['thanks with a new report', 'Thanks, but the ants are back'],
    ['a question about the next visit', 'When is my next visit'],
    ['an acknowledgment that asks for something', 'ok can you come tomorrow'],
    ['thanks in another language (Latin letters)', 'gracias'],
    ['thanks in another alphabet', 'Спасибо'],
    ['four phrases, one over the three-phrase limit', 'ok great thanks perfect'],
    // Words of the listed phrases put together another way are not an acknowledgment (pre-push audit).
    ['a problem report made of listed words', 'I have a problem'],
    ['a request made of listed words', 'Will you help'],
    ['a complaint made of listed words', 'No good'],
    ['a bare yes, which may answer a question of ours', 'Yes'],
    ['a bare no, which may answer a question of ours', 'No'],
  ])('goes to the model: %s', (_label, body) => {
    expect(threadLane.needsNoReply(body)).toBe(false);
  });

  it('allows up to three phrases, with punctuation or emoji between them', () => {
    expect(threadLane.needsNoReply('Ok great, thanks')).toBe(true);
    expect(threadLane.needsNoReply('Perfect. Thank you so much! Have a great night 🙂')).toBe(true);
  });

  it('treats a missing body as no message', () => {
    expect(threadLane.needsNoReply(undefined)).toBe(false);
    expect(threadLane.needsNoReply(null)).toBe(false);
  });
});

describe('grounds: a tool result the model\'s words may rest on', () => {
  it('is true for an upcoming visit and for a visit the customer can move', () => {
    expect(threadLane.grounds('get_upcoming_services', { services: [{}] })).toBe(true);
    expect(threadLane.grounds('offer_reschedule_link', { available: true })).toBe(true);
  });

  it('is false for no visit, no movable visit, an error and any other tool', () => {
    expect(threadLane.grounds('get_upcoming_services', { services: [] })).toBe(false);
    expect(threadLane.grounds('offer_reschedule_link', { available: false })).toBe(false);
    expect(threadLane.grounds('get_upcoming_services', { error: 'Tool execution failed' })).toBe(false);
    expect(threadLane.grounds('offer_reschedule_link', { error: 'Tool execution failed' })).toBe(false);
    expect(threadLane.grounds('get_pest_advice', { services: [{}], available: true })).toBe(false);
    expect(threadLane.grounds('escalate', { escalated: true })).toBe(false);
    expect(threadLane.grounds('stay_silent', { silent: true })).toBe(false);
  });
});

describe('the thread prompt', () => {
  it('names each of the four tools of the turn', () => {
    for (const name of ['get_upcoming_services', 'offer_reschedule_link', 'stay_silent', 'escalate']) {
      expect(threadLane.THREAD_PROMPT).toContain(name);
    }
  });

  it('names no other tool of the portal chat', () => {
    for (const name of ['open_portal_section', 'get_pest_advice', 'offer_reservice', 'show_recent_payments', 'get_recent_visits', 'request_quote', 'request_move', 'request_email_change']) {
      expect(threadLane.THREAD_PROMPT).not.toContain(name);
    }
  });
});
