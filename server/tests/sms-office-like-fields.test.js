const { likeFieldsForClient } = require('../services/sms-office-like');

// GATE_SMS_LIKE: only a quiet reaction (stored as 'sms_reaction', no alert) is
// folded into a line on our text. A loud one stays a normal bubble.
const LOVED = 'Loved “See you Tuesday”';
const base = { on: true, direction: 'inbound', body: LOVED, metadata: {} };

describe('likeFieldsForClient customerReaction', () => {
  test('a quiet reaction row carries the reaction', () => {
    expect(likeFieldsForClient({ ...base, messageType: 'sms_reaction' })).toMatchObject({
      officeLike: null, likeable: false,
      customerReaction: { emoji: '❤️', removed: false, target: 'See you Tuesday' },
    });
  });

  test('a loud reaction row (ordinary inbound text) carries none, so it stays a bubble', () => {
    expect(likeFieldsForClient({ ...base, messageType: 'inbound' }).customerReaction).toBeNull();
    expect(likeFieldsForClient({ ...base, messageType: 'manual' }).customerReaction).toBeNull();
  });

  test('a row with no message type counts as not quiet', () => {
    expect(likeFieldsForClient(base).customerReaction).toBeNull();
    expect(likeFieldsForClient({ ...base, messageType: null }).customerReaction).toBeNull();
  });

  test('officeLike and likeable are unchanged, and the gate, channel and direction rules hold', () => {
    const loud = likeFieldsForClient({ ...base, body: 'Thanks!', messageType: undefined });
    expect(loud).toEqual({ officeLike: null, customerReaction: null, likeable: true });
    expect(likeFieldsForClient({ ...base, on: false, messageType: 'sms_reaction' })).toEqual({});
    expect(likeFieldsForClient({ ...base, channel: 'voice', messageType: 'sms_reaction' })).toEqual({});
    expect(likeFieldsForClient({ ...base, direction: 'outbound', messageType: 'sms_reaction' }))
      .toEqual({ officeLike: null, customerReaction: null, likeable: false });
  });
});
