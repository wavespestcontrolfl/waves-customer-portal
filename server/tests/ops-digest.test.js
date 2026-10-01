// deliverOpsDigest contract: gate off → the sender's mailer call runs
// unchanged; gate on → a bell row (category ops_digest) and NO email; bell
// write failure → email still goes out; notify:false → email skipped only.

const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...args) => mockNotifyAdmin(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// The helper reads the env at call time, so the tests flip the variable
// after load — exactly what a Railway flip does without a restart.
function withGate(on, { activity = on } = {}) {
  process.env.GATE_OPS_DIGESTS_IN_APP = on ? 'true' : '';
  process.env.GATE_AGENT_ACTIVITY = activity ? 'true' : '';
}

const { deliverOpsDigest, htmlToText, CATEGORY } = require('../services/ops-digest');

beforeEach(() => {
  mockNotifyAdmin.mockReset();
  withGate(false);
});

describe('deliverOpsDigest', () => {
  it('passes a caller transaction through to the durable notification write', async () => {
    withGate(true);
    const trx = {};
    mockNotifyAdmin.mockResolvedValue({ id: 'n_transaction' });
    await deliverOpsDigest({ key: 'gbp-sync-health', subject: 'FIX: synthetic sync issue', text: 'Synthetic diagnostic', trx, sendEmail: jest.fn() });
    expect(mockNotifyAdmin.mock.calls[0][3].trx).toBe(trx);
  });
  it('gate on: dedupe options pass through to notifyAdmin only when given (2026-09-11 email shutoff)', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n9', deduped: true });
    await deliverOpsDigest({ key: 'llm-dispatch-exceptions', subject: 'FIX: LLM dispatch exceptions — 2026-09-11', html: '<p>x</p>', dedupeKey: 'ops-digest:llm-dispatch-exceptions', dedupeWindowMs: 604800000, refreshOnDedupe: true, sendEmail: jest.fn() });
    expect(mockNotifyAdmin.mock.calls[0][3]).toMatchObject({ bell: true, dedupeKey: 'ops-digest:llm-dispatch-exceptions', dedupeWindowMs: 604800000, refreshOnDedupe: true });
    mockNotifyAdmin.mockClear();
    mockNotifyAdmin.mockResolvedValue({ id: 'n10' });
    await deliverOpsDigest({ key: 'k', subject: 's', text: 't', sendEmail: jest.fn() });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts).not.toHaveProperty('dedupeKey');
    expect(opts).not.toHaveProperty('dedupeWindowMs');
    expect(opts).not.toHaveProperty('refreshOnDedupe');
    expect(opts.metadata).not.toHaveProperty('fallOff');
  });

  it('gate on: fallOff stamps metadata.fallOff so the feed pins the row until resolved', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n11' });
    await deliverOpsDigest({ key: 'lead-to-cash-invariants', subject: 'FIX: x', text: 't', fallOff: true, sendEmail: jest.fn() });
    expect(mockNotifyAdmin.mock.calls[0][3].metadata).toMatchObject({ opsKey: 'lead-to-cash-invariants', fallOff: true });
  });

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
    // No headline/summary supplied: the bell title falls back to the
    // subject with its ACT:/FIX:/etc. prefix stripped, and the body stays
    // null (never the whole email) — the full text rides in `detail`.
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      CATEGORY,
      '3 promised quotes never went out',
      null,
      expect.objectContaining({
        link: '/admin/pipeline', bell: true, detail: 'Hello there\nSecond',
        metadata: expect.objectContaining({ opsKey: 'promised-estimate', kind: 'ACT', audience: 'owner', feed: null }),
      }),
    );
    expect(out).toEqual({ ok: true, channel: 'in_app', id: 'n1' });
  });

  it('gate on: a sender-composed headline/summary override the fallback and land in title/body', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n1b' });
    await deliverOpsDigest({
      key: 'promised-estimate', subject: 'ACT: 3 promised quotes never went out', text: 'the whole report',
      headline: 'Estimates — 3 promised quotes not sent', summary: 'Oldest is 80 days.', sendEmail: jest.fn(),
    });
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      CATEGORY, 'Estimates — 3 promised quotes not sent', 'Oldest is 80 days.',
      expect.objectContaining({ detail: 'the whole report' }),
    );
  });

  it('gate on: falls back to the email when the bell row is not written', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue(null);
    const sendEmail = jest.fn().mockResolvedValue({ ok: true });
    const out = await deliverOpsDigest({ key: 'k', subject: 's', text: 't', sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, channel: 'email', fallback: true });
  });

  it('digest gate without the Activity gate fails closed to email', async () => {
    withGate(true, { activity: false });
    const sendEmail = jest.fn().mockResolvedValue({ ok: true });
    const out = await deliverOpsDigest({ key: 'k', subject: 's', text: 't', sendEmail });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
    expect(out.channel).toBe('email');
  });

  it('gate on: stores the whole body in `detail` — never truncated, never in `body` any more', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n3' });
    const text = 'request '.repeat(2000); // 16,000 chars
    await deliverOpsDigest({ key: 'unworked-comms', subject: 'FIX: unworked', text, sendEmail: jest.fn() });
    const [, , body, opts] = mockNotifyAdmin.mock.calls[0];
    expect(body).toBeNull();
    expect(opts.detail).toHaveLength(text.length);
  });

  it('gate on: caps the fallback title at 60 chars (word boundary) and keeps the full subject in metadata', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n2' });
    const subject = 'ACT: bounced email fix suggested — ' + 'x'.repeat(300);
    await deliverOpsDigest({ key: 'email-bounce-rescue', subject, text: 't', sendEmail: jest.fn() });
    const [, title, , opts] = mockNotifyAdmin.mock.calls[0];
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).not.toMatch(/^ACT:/);
    expect(opts.metadata.subject).toBe(subject);
  });

  it('requires a sendEmail thunk', async () => {
    await expect(deliverOpsDigest({ key: 'k', subject: 's' })).rejects.toThrow('sendEmail is required');
  });
});

// admin-alerts-ring scope (2026-09-28, spec item 3): the ring-only-on-change
// gates (ringGate / ringOnRefresh) are OWNER-AUDIENCE ONLY. An engineering
// or fyi sender never gets either — notifyAdmin's own default (any content
// change re-bells) applies to its refresh, and no lookback/lock runs for a
// fresh insert — byte-identical to before this scope.
describe('deliverOpsDigest — ring gates are owner-audience only', () => {
  it('a FIX (engineering) dedupeKey+refreshOnDedupe sender gets NO ringOnRefresh — notifyAdmin\'s default (always re-bell on change) applies', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-fix', deduped: false });
    await deliverOpsDigest({
      key: 'llm-dispatch-exceptions', subject: 'FIX: LLM dispatch exceptions', html: '<p>x</p>',
      dedupeKey: 'ops-digest:llm-dispatch-exceptions', refreshOnDedupe: true, sendEmail: jest.fn(),
    });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.refreshOnDedupe).toBe(true);
    expect(opts).not.toHaveProperty('ringOnRefresh');
  });

  it('a FYI sender with no dedupeKey gets no ringGate at all', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-fyi', deduped: false });
    await deliverOpsDigest({ key: 'k', subject: 'FYI: routine report', text: 't', count: 3, sendEmail: jest.fn() });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts).not.toHaveProperty('ringGate');
  });

  it('an ACT (owner) dedupeKey+refreshOnDedupe sender DOES get ringOnRefresh', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-act', deduped: false });
    await deliverOpsDigest({
      key: 'promised-estimate', subject: 'ACT: 3 promised quotes never went out', text: 't',
      dedupeKey: 'ops-digest:promised-estimate', refreshOnDedupe: true, count: 3, sendEmail: jest.fn(),
    });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(typeof opts.ringOnRefresh).toBe('function');
  });

  it('an ACT (owner) sender with no dedupeKey DOES get a ringGate', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-act2', deduped: false });
    await deliverOpsDigest({ key: 'k', subject: 'ACT: something needs a decision', text: 't', count: 3, sendEmail: jest.fn() });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(typeof opts.ringGate).toBe('function');
  });

  it('audience flips per emission, not a cached value — the SAME dedupeKey gets ringOnRefresh only when THIS call is owner-audience', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-flip', deduped: false });
    await deliverOpsDigest({
      key: 'gbp-sync-health', subject: 'FIX: Google review sync — 1 location degraded', text: 't',
      dedupeKey: 'ops-digest:gbp-sync-health', refreshOnDedupe: true, sendEmail: jest.fn(),
    });
    expect(mockNotifyAdmin.mock.calls[0][3]).not.toHaveProperty('ringOnRefresh');
    mockNotifyAdmin.mockClear();
    await deliverOpsDigest({
      key: 'gbp-sync-health', subject: 'ACT: Google review sync — 1 location degraded', text: 't',
      dedupeKey: 'ops-digest:gbp-sync-health', refreshOnDedupe: true, sendEmail: jest.fn(),
    });
    expect(typeof mockNotifyAdmin.mock.calls[0][3].ringOnRefresh).toBe('function');
  });
});

// Item identity (admin-alerts-ring-v2 follow-up): deliverOpsDigest's
// optional itemKeys — stored normalized (deduped/sorted/capped) and wired
// into whichever ring mechanism this call uses.
describe('deliverOpsDigest — itemKeys', () => {
  it('stores itemKeys deduped and sorted in metadata', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-keys', deduped: false });
    await deliverOpsDigest({
      key: 'k', subject: 'ACT: something needs a decision', text: 't', count: 3,
      itemKeys: ['call-2', 'call-1', 'call-2', ''], sendEmail: jest.fn(),
    });
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.metadata.itemKeys).toEqual(['call-1', 'call-2']);
  });

  it('omitted or empty itemKeys stores no itemKeys key at all', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-nokeys', deduped: false });
    await deliverOpsDigest({ key: 'k', subject: 'ACT: something needs a decision', text: 't', count: 3, sendEmail: jest.fn() });
    expect(mockNotifyAdmin.mock.calls[0][3].metadata).not.toHaveProperty('itemKeys');
  });

  it('a reported set past the cap stores itemKeys: null too (counts decide; no stale list)', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-huge', deduped: false });
    const huge = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await deliverOpsDigest({ key: 'k', subject: 'ACT: something needs a decision', text: 't', count: 501, itemKeys: huge, sendEmail: jest.fn() });
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.itemKeys).toBeNull();
  });

  it('an explicit null itemKeys (page past its row cap) stores itemKeys: null, clearing a stale list on refresh', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-overflow', deduped: false });
    await deliverOpsDigest({ key: 'k', subject: 'ACT: something needs a decision', text: 't', count: 30, itemKeys: null, sendEmail: jest.fn() });
    expect(mockNotifyAdmin.mock.calls[0][3].metadata.itemKeys).toBeNull();
  });

  it('an ACT sender with no dedupeKey: itemKeys reach the ringGate — a different item rings even at a flat count', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-gate', deduped: false });
    await deliverOpsDigest({
      key: 'k', subject: 'ACT: something needs a decision', text: 't', count: 5,
      itemKeys: ['call-9'], sendEmail: jest.fn(),
    });
    const { ringGate } = mockNotifyAdmin.mock.calls[0][3];
    const conn = jest.fn(() => ({
      where: () => conn(), whereRaw: () => conn(), orderBy: () => conn(),
      first: async () => ({ metadata: { count: 5, itemKeys: ['call-1'] } }),
    }));
    conn.raw = () => ({});
    await expect(ringGate(conn)).resolves.toBe(true);
  });

  it('an ACT dedupeKey+refreshOnDedupe sender: itemKeys reach ringOnRefresh', async () => {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n-refresh', deduped: false });
    await deliverOpsDigest({
      key: 'promised-estimate', subject: 'ACT: 3 promised quotes never went out', text: 't',
      dedupeKey: 'ops-digest:promised-estimate', refreshOnDedupe: true, count: 3,
      itemKeys: ['call-9'], sendEmail: jest.fn(),
    });
    const { ringOnRefresh } = mockNotifyAdmin.mock.calls[0][3];
    expect(ringOnRefresh({}, { count: 3, itemKeys: ['call-1'] })).toBe(true);
    expect(ringOnRefresh({}, { count: 3, itemKeys: ['call-9'] })).toBe(false);
  });
});

describe('deliverOpsDigest — kind/audience/feed derivation', () => {
  async function metadataFor(subject, extra = {}) {
    withGate(true);
    mockNotifyAdmin.mockResolvedValue({ id: 'n' });
    await deliverOpsDigest({ key: 'k', subject, text: 't', sendEmail: jest.fn(), ...extra });
    return mockNotifyAdmin.mock.calls[0][3].metadata;
  }

  it('ACT -> owner audience, never Activity-only', async () => {
    const meta = await metadataFor('ACT: something needs a decision');
    expect(meta).toMatchObject({ kind: 'ACT', audience: 'owner', feed: null });
  });

  it('[Review] -> REVIEW kind, owner audience', async () => {
    const meta = await metadataFor('[Review] a draft is ready');
    expect(meta).toMatchObject({ kind: 'REVIEW', audience: 'owner', feed: null });
  });

  it('FIX -> engineering audience, Activity-only (feed stamped)', async () => {
    const meta = await metadataFor('FIX: something is broken');
    expect(meta).toMatchObject({ kind: 'FIX', audience: 'engineering', feed: 'activity' });
  });

  it('FIRST/FYI/OK/no-prefix all read as FYI kind, fyi audience, Activity-only', async () => {
    for (const subject of ['FIRST: a baseline', 'FYI: routine report', 'OK: content impact', 'no prefix at all']) {
      const meta = await metadataFor(subject);
      expect(meta).toMatchObject({ kind: 'FYI', audience: 'fyi', feed: 'activity' });
    }
  });

  it('a sender can override the derived audience', async () => {
    const meta = await metadataFor('FIX: broken but the owner should still see it', { audience: 'owner' });
    expect(meta).toMatchObject({ kind: 'FIX', audience: 'owner', feed: null });
  });

  it('a sender cannot shadow feed via its own metadata — it is written last, unconditionally', async () => {
    const meta = await metadataFor('ACT: owner thing', { metadata: { feed: 'activity' } });
    expect(meta.feed).toBeNull();
  });

  it('the full subject always rides in metadata, whatever the headline is', async () => {
    const meta = await metadataFor('ACT: full subject text', { headline: 'Short headline' });
    expect(meta.subject).toBe('ACT: full subject text');
  });
});

describe('deliverOpsDigest — a stale feed value from a prior run is corrected on refresh', () => {
  // gbp-sync-health flips FIX <-> ACT under the SAME dedupeKey depending on
  // whether a Places API failure accompanies the finding. A standing row
  // that was engineering (feed: 'activity') must become bell-visible again
  // the moment a later run resolves to owner audience — notifyAdmin's
  // refresh merge only overwrites what THIS call's metadata explicitly
  // sets, so `feed` must never be omitted just because it's the "owner"
  // (null) case.
  it('refreshing from FIX (engineering/Activity-only) to ACT (owner) clears the stale feed flag', async () => {
    withGate(true);
    const existing = {
      id: 'n-standing', title: 'old', body: 'old', link: null,
      metadata: { dedupeKey: 'ops-digest:gbp-sync-health', kind: 'FIX', audience: 'engineering', feed: 'activity' },
    };
    mockNotifyAdmin.mockImplementation(async (category, title, body, opts) => ({
      id: existing.id,
      deduped: true,
      refreshed: true,
      // Simulate the real merge notifyAdmin performs: existingMeta spread
      // first, THEN this call's own metadata — feed must appear in the
      // latter to ever overwrite the former.
      metadata: { ...existing.metadata, ...opts.metadata },
    }));
    const result = await deliverOpsDigest({
      key: 'gbp-sync-health', subject: 'ACT: Google review sync — 1 location degraded or stale',
      text: 't', dedupeKey: 'ops-digest:gbp-sync-health', refreshOnDedupe: true, sendEmail: jest.fn(),
    });
    expect(result.ok).toBe(true);
    const opts = mockNotifyAdmin.mock.calls[0][3];
    expect(opts.metadata.feed).toBeNull(); // explicitly cleared, not merely absent
  });
});

describe('htmlToText', () => {
  it('flattens block tags to newlines and decodes entities', () => {
    expect(htmlToText('<h1>A &amp; B</h1><ul><li>one</li><li>two</li></ul><br>done')).toBe('A & B\none\ntwo\n\ndone');
  });
});

describe('digestRowFields — caller headline obeys the 60-char bell title budget', () => {
  const { digestRowFields: rowFields } = require('../services/ops-digest');
  test('a caller headline over 60 chars is cut at a word boundary like the fallback', () => {
    const long = 'Schedule — ' + 'overlapping visit pairs need a look '.repeat(3);
    const { title } = rowFields({ subject: '[Waves] x', text: 'x', headline: long });
    expect(title.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(title.replace(/…$/, ''))).toBe(true);
  });
  test('a short caller headline is kept as written', () => {
    expect(rowFields({ subject: '[Waves] x', text: 'x', headline: 'Email — bounce needs a fix' }).title)
      .toBe('Email — bounce needs a fix');
  });
});
