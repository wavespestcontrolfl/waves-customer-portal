// deliverOpsDigest contract: gate off → the sender's mailer call runs
// unchanged; gate on → a bell row (category ops_digest) and NO email; bell
// write failure → email still goes out; notify:false → email skipped only.

const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// The helper reads the env at call time, so the tests flip the variable
// after load — exactly what a Railway flip does without a restart.
function withGate(on) {
  process.env.GATE_OPS_DIGESTS_IN_APP = on ? 'true' : '';
}

const { deliverOpsDigest, htmlToText, CATEGORY } = require('../services/ops-digest');

beforeEach(() => {
  mockNotifyAdmin.mockReset();
  withGate(false);
});

describe('deliverOpsDigest', () => {
  it('gate off: runs the sender email call and touches no bell', async () => {
    const sendEmail = jest.fn().mockResolvedValue({ ok: true });
    const out = await deliverOpsDigest({ key: 'unworked-comms', subject: 'FIX: x', text: 'body', sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, channel: 'email', result: { ok: true } });
  });

  it('gate off: a sendOne-style void result still reads as ok, an {ok:false} does not', async () => {
    const out1 = await deliverOpsDigest({ key: 'k', subject: 's', text: 't', sendEmail: async () => undefined });
    expect(out1.ok).toBe(true);
    const out2 = await deliverOpsDigest({ key: 'k', subject: 's', text: 't', sendEmail: async () => ({ ok: false, error: 'smtp' }) });
    expect(out2.ok).toBe(false);
    expect(out2.error).toBe('smtp');
  });

  it('gate on: writes an ops_digest bell with link + key metadata and skips the email', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n1' });
    const sendEmail = jest.fn();
    const out = await deliverOpsDigest({
      key: 'promised-estimate', subject: 'ACT: 3 promised quotes never went out', html: '<p>Hello <b>there</b></p><p>Second</p>', link: '/admin/pipeline', sendEmail,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      CATEGORY,
      'ACT: 3 promised quotes never went out',
      'Hello there\nSecond',
      expect.objectContaining({ link: '/admin/pipeline', bell: true, metadata: expect.objectContaining({ opsKey: 'promised-estimate' }) }),
    );
    expect(out).toEqual({ ok: true, channel: 'in_app', id: 'n1' });
  });

  it('gate on: falls back to the email when the bell row is not written', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue(null);
    const sendEmail = jest.fn().mockResolvedValue({ ok: true });
    const out = await deliverOpsDigest({ key: 'k', subject: 's', text: 't', sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, channel: 'email', fallback: true });
  });

  it('gate on: caps the stored title at the 200-char column and keeps the full subject in metadata', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n2' });
    const subject = 'ACT: bounced email fix suggested — ' + 'x'.repeat(300);
    await deliverOpsDigest({ key: 'email-bounce-rescue', subject, text: 't', sendEmail: jest.fn() });
    const [, title, , opts] = mockNotifyAdmin.mock.calls[0];
    expect(title).toHaveLength(200);
    expect(opts.metadata.subject).toBe(subject);
  });

  it('requires a sendEmail thunk', async () => {
    await expect(deliverOpsDigest({ key: 'k', subject: 's' })).rejects.toThrow('sendEmail is required');
  });
});

describe('htmlToText', () => {
  it('flattens block tags to newlines and decodes entities', () => {
    expect(htmlToText('<h1>A &amp; B</h1><ul><li>one</li><li>two</li></ul><br>done')).toBe('A & B\none\ntwo\n\ndone');
  });
});
