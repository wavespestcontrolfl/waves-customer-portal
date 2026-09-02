// deliverOpsDigest contract: gate off → the sender's mailer call runs
// unchanged; gate on → a bell row (category ops_digest) and NO email; bell
// write failure → email still goes out; notify:false → email skipped only.

const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const gates = require('../config/feature-gates');

function withGate(on) {
  gates.gates.opsDigestsInApp = on;
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

  it('gate on + notify:false: skips the email and writes nothing (sender already bells)', async () => {
    withGate(true);
    const sendEmail = jest.fn();
    const out = await deliverOpsDigest({ key: 'gbp-sync-health', subject: 's', text: 't', notify: false, sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, channel: 'in_app', id: null });
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
