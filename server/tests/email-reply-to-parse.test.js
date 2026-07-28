/**
 * Reply-To capture (codex round 18 on #3021): relayed mail (contact forms,
 * ticketing) carries the actionable recipient in Reply-To while From is a
 * provider no-reply mailbox. The header is attacker-typed — only a single
 * plain mailbox survives parsing; anything else stays null and replies fall
 * back to From.
 */

jest.mock('googleapis', () => ({ google: {} }));

const { parseMessage } = require('../services/email/gmail-client');

const msgWith = (replyTo) => ({
  id: 'g1',
  threadId: 't1',
  internalDate: '1753704000000',
  labelIds: ['INBOX'],
  payload: {
    headers: [
      { name: 'From', value: 'Forms Relay <no-reply@relay.example>' },
      { name: 'Subject', value: 'New inquiry' },
      ...(replyTo ? [{ name: 'Reply-To', value: replyTo }] : []),
    ],
  },
});

describe('parseMessage Reply-To validation', () => {
  test('captures a bare mailbox', () => {
    expect(parseMessage(msgWith('customer@customer.example')).reply_to).toBe('customer@customer.example');
  });

  test('captures the mailbox out of a display-name form', () => {
    expect(parseMessage(msgWith('Jane Customer <jane@customer.example>')).reply_to).toBe('jane@customer.example');
  });

  test('rejects multi-recipient lists (header smuggling)', () => {
    expect(parseMessage(msgWith('a@x.example, b@y.example')).reply_to).toBeNull();
  });

  test('rejects non-mailbox junk and stays null when absent', () => {
    expect(parseMessage(msgWith('not an address')).reply_to).toBeNull();
    expect(parseMessage(msgWith(null)).reply_to).toBeNull();
  });
});
