/**
 * GATE_PORTAL_EMAIL_RESUBSCRIBE on real PostgreSQL: which email_suppressions
 * rows the "Turn Waves emails back on?" link may release (the SQL, including
 * the Gmail-spelling match), the stamps the release writes, and the
 * email_resubscribe_requests table (24 h limit, hashed token, expiry, the click).
 *
 * Most cases run in a transaction that is always rolled back, on the real table.
 * The click cases (completeResubscribe) commit real rows, because SendGrid's
 * pre-clear reads on its own connection, and delete them at the end.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-resubscribe-confirm', () => ({ sendResubscribeConfirmation: jest.fn() }));

(SKIP ? describe.skip : describe)('email resubscribe on PostgreSQL', () => {
  let db;
  let service;
  let sender;
  let n = 0;

  beforeAll(() => {
    db = require('../models/db');
    service = require('../services/email-resubscribe');
    sender = require('../services/email-resubscribe-confirm');
  });
  beforeEach(() => { sender.sendResubscribeConfirmation.mockReset(); sender.sendResubscribeConfirmation.mockResolvedValue({ messageId: 'm1' }); });
  afterAll(async () => { await db.destroy(); });

  const uniq = () => `resub-${Date.now()}-${++n}`;

  async function inRolledBackTx(fn) {
    const rollback = new Error('rollback');
    try {
      await db.transaction(async (trx) => { await fn(trx); throw rollback; });
    } catch (e) { if (e !== rollback) throw e; }
  }
  const sup = async (trx, row) => {
    const [saved] = await trx('email_suppressions').insert({
      status: 'active', group_key: null, suppression_type: 'unsubscribe', source: 'sendgrid_event_webhook', ...row,
    }).returning('*');
    return saved;
  };

  test('a global unsubscribe and a service_operational unsubscribe release', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      const globalRow = await sup(trx, { email });
      const serviceRow = await sup(trx, { email, group_key: 'service_operational' });
      const rows = await service.releasableUnsubscribes(email.toUpperCase(), { dbh: trx });
      expect(rows.map((r) => r.id).sort()).toEqual([globalRow.id, serviceRow.id].sort());
    });
  });

  test('the two June 2026 SendGrid-import sources (customer unsubscribes made at SendGrid) release', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      const asm = await sup(trx, { email, group_key: 'service_operational', source: 'sendgrid_asm_backfill' });
      const dropped = await sup(trx, { email, group_key: 'service_operational', source: 'sendgrid_dropped_backfill_2026_06_01' });
      const rows = await service.releasableUnsubscribes(email, { dbh: trx });
      expect(rows.map((r) => r.id).sort()).toEqual([asm.id, dropped.id].sort());
    });
  });

  test('a staff-made row stays staff-made after the webhook overwrote its source (metadata.created_by survives, even null)', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      await sup(trx, { email, metadata: JSON.stringify({ created_by: 'tech-1', reason: 'asked by phone' }) });
      await sup(trx, { email, metadata: JSON.stringify({ created_by: null }) });
      expect(await service.releasableUnsubscribes(email, { dbh: trx })).toEqual([]);
    });
  });

  test('never releasable: newsletter, bounce, spam complaint, do-not-email, staff-made, already released', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      await sup(trx, { email, group_key: 'marketing_newsletter' });
      await sup(trx, { email, suppression_type: 'bounce' });
      await sup(trx, { email, suppression_type: 'spam_complaint' });
      await sup(trx, { email, suppression_type: 'do_not_email' });
      await sup(trx, { email, source: 'admin_manual' });
      await sup(trx, { email, status: 'released' });
      await sup(trx, { email: `other-${uniq()}@example.com` });
      expect(await service.releasableUnsubscribes(email, { dbh: trx })).toEqual([]);
    });
  });

  test('a Gmail-equivalent spelling of the address is covered', async () => {
    await inRolledBackTx(async (trx) => {
      const local = uniq().replace(/-/g, '');
      const row = await sup(trx, { email: `${local.slice(0, 5)}.${local.slice(5)}@gmail.com` });
      const rows = await service.releasableUnsubscribes(`${local}@gmail.com`, { dbh: trx });
      expect(rows.map((r) => r.id)).toEqual([row.id]);
    });
  });

  const versionsOf = async (trx, ids) => Object.fromEntries((await trx('email_suppressions').whereIn('id', ids)
    .select('id', trx.raw('xmin::text AS row_version'))).map((r) => [r.id, r.row_version]));

  // xmin only changes across transactions (an update inside the inserting
  // transaction keeps its xid), so this case commits real rows, as the route
  // does between the pre-read and the release, and deletes them at the end.
  test('a row updated in place after the pre-read (a newer opt-out merged by the webhook) is NOT released; an unchanged row still is', async () => {
    const email = `${uniq()}@example.com`;
    const ids = [];
    try {
      const untouched = await sup(db, { email });
      const bumped = await sup(db, { email, group_key: 'service_operational', metadata: JSON.stringify({ provider: 'sendgrid' }) });
      ids.push(untouched.id, bumped.id);
      // Pre-read (what clearSendgridBeforeRelease captures), SendGrid cleared.
      const pre = await service.releasableUnsubscribes(email);
      const versionById = Object.fromEntries(pre.map((r) => [r.id, r.row_version]));
      expect(Object.keys(versionById).sort()).toEqual([untouched.id, bumped.id].sort());
      // recordEmailSuppressionForEvent's in-place update for a new unsubscribe event.
      await db('email_suppressions').where({ id: bumped.id }).update({
        source: 'sendgrid_event_webhook',
        metadata: db.raw('COALESCE(metadata, \'{}\'::jsonb) || ?::jsonb', [JSON.stringify({ event_type: 'group_unsubscribe' })]),
        updated_at: new Date(),
      });
      const released = await db.transaction((trx) => service.releaseOwnUnsubscribes({
        email, customerId: 'c-1', onlyIds: [untouched.id, bumped.id], versionById,
      }, { dbh: trx }));
      expect(released.map((r) => r.id)).toEqual([untouched.id]);
      expect((await db('email_suppressions').where({ id: bumped.id }).first()).status).toBe('active');
      expect((await db('email_suppressions').where({ id: untouched.id }).first()).status).toBe('released');
    } finally {
      if (ids.length) await db('email_suppressions').whereIn('id', ids).del();
    }
  });

  test('release skips a row that is not in onlyIds, and releases nothing without onlyIds', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      const cleared = await sup(trx, { email });
      const late = await sup(trx, { email, group_key: 'service_operational' });
      expect((await service.releaseOwnUnsubscribes({ email, customerId: 'c-1' }, { dbh: trx }))).toEqual([]);
      const released = await service.releaseOwnUnsubscribes({
        email, customerId: 'c-1', onlyIds: [cleared.id], versionById: await versionsOf(trx, [cleared.id]),
      }, { dbh: trx });
      // An id with no captured version is not released either.
      expect(await service.releaseOwnUnsubscribes({ email, customerId: 'c-1', onlyIds: [cleared.id] }, { dbh: trx })).toEqual([]);
      expect(released.map((r) => r.id)).toEqual([cleared.id]);
      expect((await trx('email_suppressions').where({ id: late.id }).first()).status).toBe('active');
    });
  });

  test('release stamps the rows, keeps earlier metadata, and leaves other blocks active', async () => {
    await inRolledBackTx(async (trx) => {
      const email = `${uniq()}@example.com`;
      const unsub = await sup(trx, { email, metadata: JSON.stringify({ provider: 'sendgrid' }) });
      const bounce = await sup(trx, { email, suppression_type: 'bounce' });
      const note = { ok: true, status: 204, at: new Date().toISOString() };
      const released = await service.releaseOwnUnsubscribes({
        email, customerId: 'c-1', onlyIds: [unsub.id], versionById: await versionsOf(trx, [unsub.id]),
        sendgridClear: { [unsub.id]: note },
      }, { dbh: trx });
      expect(released.map((r) => r.id)).toEqual([unsub.id]);
      const after = await trx('email_suppressions').where({ id: unsub.id }).first();
      expect(after).toMatchObject({ status: 'released', consent_source: 'email_confirm_link' });
      expect(after.released_at).toBeInstanceOf(Date);
      expect(after.consent_timestamp).toBeInstanceOf(Date);
      expect(after.metadata).toMatchObject({
        provider: 'sendgrid', released_via: 'email_confirm_link', release_reason: 'Customer confirmed by email link',
        released_by: null, released_for_customer_id: 'c-1', request_id: null, sendgrid_clear: note,
      });
      expect(after.metadata).not.toHaveProperty('actor');
      expect((await trx('email_suppressions').where({ id: bounce.id }).first()).status).toBe('active');
      expect(await service.releasableUnsubscribes(email, { dbh: trx })).toEqual([]);
    });
  });

  describe('request side: one confirmation email per address per 24 h', () => {
    const ask = (trx, email, extra = {}) => service.requestResubscribeEmail({ customerId: null, email, firstName: 'Pat', ...extra }, { dbh: trx });
    const requestsFor = (trx, email) => trx('email_resubscribe_requests').whereRaw('lower(email) = ?', [email.toLowerCase()]).orderBy('requested_at');

    test('sends once: stores only the sha256 of the token, a 7-day expiry and sent_at; the second tap sends nothing', async () => {
      await inRolledBackTx(async (trx) => {
        const email = `${uniq()}@example.com`;
        await sup(trx, { email });
        const first = await ask(trx, email.toUpperCase());
        expect(first).toMatchObject({ state: 'sent', maskedEmail: `${email[0]}***@example.com` });
        expect(sender.sendResubscribeConfirmation).toHaveBeenCalledTimes(1);
        const call = sender.sendResubscribeConfirmation.mock.calls[0][0];
        expect(call).toMatchObject({ to: email, firstName: 'Pat' });
        expect(call.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const rows = await requestsFor(trx, email);
        expect(rows).toHaveLength(1);
        expect(rows[0].token_hash).toBe(service.hashToken(call.token));
        expect(JSON.stringify(rows[0])).not.toContain(call.token);
        expect(rows[0].sent_at).toBeInstanceOf(Date);
        expect(Math.round((rows[0].expires_at - rows[0].requested_at) / 86400000)).toBe(7);
        const second = await ask(trx, email);
        expect(second).toMatchObject({ state: 'sent', sentAt: first.sentAt });
        expect(sender.sendResubscribeConfirmation).toHaveBeenCalledTimes(1);
        expect(await requestsFor(trx, email)).toHaveLength(1);
        // After 24 h a new email may go out.
        await trx('email_resubscribe_requests').where({ id: rows[0].id }).update({ sent_at: new Date(Date.now() - 25 * 3600 * 1000) });
        expect((await ask(trx, email)).state).toBe('sent');
        expect(sender.sendResubscribeConfirmation).toHaveBeenCalledTimes(2);
      });
    });

    test('nothing releasable, or a bounce / spam complaint / do-not-email on the address: nothing is sent or stored', async () => {
      await inRolledBackTx(async (trx) => {
        const clean = `${uniq()}@example.com`;
        expect(await ask(trx, clean)).toEqual({ state: 'not_paused' });
        for (const suppression_type of ['bounce', 'spam_complaint', 'do_not_email']) {
          const email = `${uniq()}@example.com`;
          await sup(trx, { email });
          await sup(trx, { email, suppression_type, source: 'admin_manual', group_key: 'service_operational' });
          expect(await ask(trx, email)).toEqual({ state: 'not_paused' });
          expect(await service.resubscribeStatus(email, { dbh: trx })).toBeNull();
          expect(await requestsFor(trx, email)).toEqual([]);
        }
        expect(sender.sendResubscribeConfirmation).not.toHaveBeenCalled();
      });
    });

    test('a definite rejection (HTTP 4xx) undoes the claim: failed, sent_at null, only the code recorded, and a retry sends', async () => {
      await inRolledBackTx(async (trx) => {
        const email = `${uniq()}@example.com`;
        await sup(trx, { email });
        sender.sendResubscribeConfirmation.mockRejectedValueOnce(Object.assign(new Error(`SendGrid 400 for ${email}`), { status: 400 }));
        expect(await ask(trx, email)).toEqual({ state: 'failed' });
        const [row] = await requestsFor(trx, email);
        expect(row.sent_at).toBeNull();
        expect(row.outcome).toEqual({ send_failed: 'http_400' });
        expect(JSON.stringify(row.outcome)).not.toContain(email);
        expect((await ask(trx, email)).state).toBe('sent');
        expect(sender.sendResubscribeConfirmation).toHaveBeenCalledTimes(2);
      });
    });

    test('a sender that never reached SendGrid (not configured) also undoes the claim', async () => {
      await inRolledBackTx(async (trx) => {
        const email = `${uniq()}@example.com`;
        await sup(trx, { email });
        sender.sendResubscribeConfirmation.mockRejectedValueOnce(Object.assign(new Error('SendGrid not configured'), { code: 'SENDGRID_NOT_CONFIGURED' }));
        expect(await ask(trx, email)).toEqual({ state: 'failed' });
        expect((await requestsFor(trx, email))[0].sent_at).toBeNull();
      });
    });

    test.each([
      ['a timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'timeout'],
      ['a network reset', Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }), 'ECONNRESET'],
      ['a 5xx', Object.assign(new Error('SendGrid 503'), { status: 503 }), 'http_503'],
      ['an odd 4xx (408)', Object.assign(new Error('SendGrid 408'), { status: 408 }), 'http_408'],
    ])('%s is uncertain: the claim stays (cap holds, the link works), the answer is sent, and no second email goes out', async (_name, error, word) => {
      await inRolledBackTx(async (trx) => {
        const email = `${uniq()}@example.com`;
        await sup(trx, { email });
        sender.sendResubscribeConfirmation.mockRejectedValueOnce(error);
        const first = await ask(trx, email);
        expect(first).toMatchObject({ state: 'sent', maskedEmail: `${email[0]}***@example.com`, sentAt: expect.any(String) });
        const [row] = await requestsFor(trx, email);
        expect(row.sent_at).toBeInstanceOf(Date);
        expect(row.outcome).toEqual({ send_uncertain: word });
        expect(JSON.stringify(row.outcome)).not.toContain(email);
        // The delivered link is usable: the token the sender was given resolves to an open request.
        const { token } = sender.sendResubscribeConfirmation.mock.calls[0][0];
        expect((await service.findRequest(token, { dbh: trx })).status).toBe('open');
        // Another tap does not send again.
        expect(await ask(trx, email)).toMatchObject({ state: 'sent', sentAt: first.sentAt });
        expect(sender.sendResubscribeConfirmation).toHaveBeenCalledTimes(1);
      });
    });

    const cleanup = async (email) => {
      await db('email_resubscribe_requests').whereRaw('lower(email) = ?', [email]).del();
      await db('email_suppressions').whereRaw('lower(email) = ?', [email]).del();
    };

    test('the claim is committed before the send starts; the send runs in its own transaction holding the address lock; two racing taps send once', async () => {
      const email = `${uniq()}@example.com`;
      try {
        await sup(db, { email });
        const seen = [];
        sender.sendResubscribeConfirmation.mockImplementation(async (args) => {
          // From ANOTHER connection: the claim row is already committed and readable, and the
          // address lock is held by the send's transaction (a suppression writer would wait).
          const [row] = await db('email_resubscribe_requests').whereRaw('lower(email) = ?', [email]);
          const lockFree = await db.transaction(async (other) => (
            (await other.raw('SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS ok', [`customer-email:${email}`])).rows[0].ok));
          seen.push({ sentAt: !!row?.sent_at, outcome: row?.outcome, lockFree, hasBoundaryCheck: typeof args.providerBoundaryCheck === 'function' });
          await args.providerBoundaryCheck();
          await new Promise((resolve) => { setTimeout(resolve, 100); });
          return { messageId: 'm1' };
        });
        const [one, two] = await Promise.all([
          service.requestResubscribeEmail({ customerId: null, email, firstName: 'Pat' }, { dbh: db }),
          service.requestResubscribeEmail({ customerId: null, email, firstName: 'Pat' }, { dbh: db }),
        ]);
        expect(sender.sendResubscribeConfirmation).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([{ sentAt: true, outcome: { send_claimed: true }, lockFree: false, hasBoundaryCheck: true }]);
        expect([one.state, two.state]).toEqual(['sent', 'sent']);
        const rows = await db('email_resubscribe_requests').whereRaw('lower(email) = ?', [email]);
        expect(rows).toHaveLength(1);
        expect(rows[0].outcome).toEqual({ sent: true });
      } finally { await cleanup(email); }
    });

    // Lands a do_not_email (a staff suppression) at a chosen moment, from another connection.
    const staffBlock = (email) => sup(db, { email, suppression_type: 'do_not_email', source: 'admin_manual', metadata: JSON.stringify({ created_by: 'tech-1' }) });

    test('a do_not_email added after the claim commits but before the send: no send, claim undone, not_paused', async () => {
      const email = `${uniq()}@example.com`;
      try {
        await sup(db, { email });
        let commits = 0;
        const dbh = Object.assign((table) => db(table), {
          raw: db.raw.bind(db),
          transaction: async (fn) => { const out = await db.transaction(fn); commits += 1; if (commits === 1) await staffBlock(email); return out; },
        });
        expect(await service.requestResubscribeEmail({ customerId: null, email }, { dbh })).toEqual({ state: 'not_paused' });
        expect(sender.sendResubscribeConfirmation).not.toHaveBeenCalled();
        const [row] = await db('email_resubscribe_requests').whereRaw('lower(email) = ?', [email]);
        expect(row.sent_at).toBeNull();
        expect(row.outcome).toEqual({ send_refused: 'hard_block' });
      } finally { await cleanup(email); }
    });

    test('a do_not_email that lands inside providerBoundaryCheck, right before the fetch, refuses the send: no fetch, claim undone, not_paused', async () => {
      const email = `${uniq()}@example.com`;
      const fetchSpy = jest.fn();
      try {
        await sup(db, { email });
        sender.sendResubscribeConfirmation.mockImplementation(async ({ providerBoundaryCheck }) => {
          await providerBoundaryCheck(); // clean
          await staffBlock(email); // staff block commits on another connection
          await providerBoundaryCheck(); // must throw before the request
          fetchSpy();
        });
        expect(await service.requestResubscribeEmail({ customerId: null, email }, { dbh: db })).toEqual({ state: 'not_paused' });
        expect(fetchSpy).not.toHaveBeenCalled();
        const [row] = await db('email_resubscribe_requests').whereRaw('lower(email) = ?', [email]);
        expect(row.sent_at).toBeNull();
        expect(row.outcome).toEqual({ send_refused: 'hard_block' });
      } finally { await cleanup(email); }
    });

    test('a definite rejection on committed rows clears sent_at so the next tap can send', async () => {
      const email = `${uniq()}@example.com`;
      try {
        await sup(db, { email });
        sender.sendResubscribeConfirmation.mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 422 }));
        expect(await service.requestResubscribeEmail({ customerId: null, email }, { dbh: db })).toEqual({ state: 'failed' });
        expect(await service.requestResubscribeEmail({ customerId: null, email }, { dbh: db })).toMatchObject({ state: 'sent' });
        expect(sender.sendResubscribeConfirmation).toHaveBeenCalledTimes(2);
      } finally { await cleanup(email); }
    });

    test('resubscribeStatus: paused, then sent', async () => {
      await inRolledBackTx(async (trx) => {
        const email = `${uniq()}@example.com`;
        await sup(trx, { email });
        expect(await service.resubscribeStatus(email, { dbh: trx })).toEqual({ state: 'paused', maskedEmail: `${email[0]}***@example.com` });
        await ask(trx, email);
        expect(await service.resubscribeStatus(email, { dbh: trx })).toMatchObject({ state: 'sent', sentAt: expect.any(String) });
      });
    });

    test('after the link was used, a new unsubscribe inside 24 h is a wait (no email, no usable link); status is paused with nextAt; after 24 h a new email goes out', async () => {
      await inRolledBackTx(async (trx) => {
        const email = `${uniq()}@example.com`;
        await sup(trx, { email });
        expect((await ask(trx, email)).state).toBe('sent');
        const [row] = await requestsFor(trx, email);
        // The customer clicked (used) and then unsubscribed again.
        await trx('email_resubscribe_requests').where({ id: row.id }).update({ used_at: new Date() });
        const nextAt = new Date(row.sent_at.getTime() + 24 * 3600 * 1000).toISOString();
        expect(await ask(trx, email)).toEqual({ state: 'wait', maskedEmail: `${email[0]}***@example.com`, nextAt });
        expect(await service.resubscribeStatus(email, { dbh: trx })).toEqual({ state: 'paused', maskedEmail: `${email[0]}***@example.com`, nextAt });
        expect(sender.sendResubscribeConfirmation).toHaveBeenCalledTimes(1);
        expect(await requestsFor(trx, email)).toHaveLength(1);
        // An early-expired link inside the window is a wait too.
        await trx('email_resubscribe_requests').where({ id: row.id }).update({ used_at: null, expires_at: new Date(Date.now() - 1000) });
        expect((await ask(trx, email)).state).toBe('wait');
        // After 24 h the cap is over.
        await trx('email_resubscribe_requests').where({ id: row.id }).update({ sent_at: new Date(Date.now() - 25 * 3600 * 1000) });
        expect((await ask(trx, email)).state).toBe('sent');
        expect(sender.sendResubscribeConfirmation).toHaveBeenCalledTimes(2);
      });
    });

    test('findRequest: unknown / never sent / expired / used / open, by token', async () => {
      await inRolledBackTx(async (trx) => {
        const email = `${uniq()}@example.com`;
        const mk = async (patch) => {
          const token = require('crypto').randomBytes(32).toString('base64url');
          await trx('email_resubscribe_requests').insert({
            email, token_hash: service.hashToken(token), sent_at: new Date(), expires_at: new Date(Date.now() + 3600000), ...patch,
          });
          return token;
        };
        expect((await service.findRequest(await mk({}), { dbh: trx })).status).toBe('open');
        expect((await service.findRequest(await mk({ expires_at: new Date(Date.now() - 1000) }), { dbh: trx })).status).toBe('expired');
        expect((await service.findRequest(await mk({ used_at: new Date() }), { dbh: trx })).status).toBe('used');
        expect((await service.findRequest(await mk({ sent_at: null }), { dbh: trx })).status).toBe('unknown');
        expect((await service.findRequest('x'.repeat(43), { dbh: trx })).status).toBe('unknown');
        expect((await service.findRequest('short', { dbh: trx })).status).toBe('unknown');
        expect((await service.findRequest(undefined, { dbh: trx })).status).toBe('unknown');
      });
    });
  });

  describe('the click: completeResubscribe (committed rows, cleaned up at the end)', () => {
    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; delete process.env.SENDGRID_API_KEY; delete process.env.SENDGRID_ASM_GROUP_SERVICE; });

    async function withCommitted(fn) {
      const email = `${uniq()}@example.com`;
      try { await fn(email); } finally {
        await db('email_resubscribe_requests').whereRaw('lower(email) = ?', [email]).del();
        await db('email_suppressions').whereRaw('lower(email) = ?', [email]).del();
      }
    }
    const openRequest = async (email) => {
      const [request] = await db('email_resubscribe_requests').insert({
        email, token_hash: service.hashToken(uniq()), sent_at: new Date(), expires_at: new Date(Date.now() + 3600000),
      }).returning('*');
      return request;
    };

    test('clears SendGrid first, then releases the rows and marks the request used; a second click finds nothing left', async () => {
      process.env.SENDGRID_API_KEY = 'SG.test';
      process.env.SENDGRID_ASM_GROUP_SERVICE = '777';
      await withCommitted(async (email) => {
        const order = [];
        global.fetch = jest.fn(async (url) => { order.push(`fetch:${url.includes('/groups/') ? 'service' : 'global'}`); return { ok: true, status: 204 }; });
        const globalRow = await sup(db, { email });
        const serviceRow = await sup(db, { email, group_key: 'service_operational' });
        const bounce = await sup(db, { email, suppression_type: 'bounce' });
        const request = await openRequest(email);
        expect(await service.completeResubscribe(request)).toBe('done');
        expect(order.sort()).toEqual(['fetch:global', 'fetch:service']);
        for (const id of [globalRow.id, serviceRow.id]) {
          const after = await db('email_suppressions').where({ id }).first();
          expect(after).toMatchObject({ status: 'released', consent_source: 'email_confirm_link' });
          expect(after.metadata).toMatchObject({ released_via: 'email_confirm_link', request_id: request.id, sendgrid_clear: { ok: true, status: 204 } });
        }
        expect((await db('email_suppressions').where({ id: bounce.id }).first()).status).toBe('active');
        const used = await db('email_resubscribe_requests').where({ id: request.id }).first();
        expect(used.used_at).toBeInstanceOf(Date);
        expect(used.outcome.released_ids.sort()).toEqual([globalRow.id, serviceRow.id].sort());
        expect((await service.findRequest('y'.repeat(43))).status).toBe('unknown');
        // The same request again (a double click): nothing left to release.
        global.fetch.mockClear();
        expect(await service.completeResubscribe(request)).toBe('already');
        expect(global.fetch).not.toHaveBeenCalled();
      });
    });

    test('a SendGrid failure releases nothing it did not confirm, leaves the request open, and the next click works', async () => {
      process.env.SENDGRID_API_KEY = 'SG.test';
      process.env.SENDGRID_ASM_GROUP_SERVICE = '777';
      await withCommitted(async (email) => {
        const globalRow = await sup(db, { email });
        const serviceRow = await sup(db, { email, group_key: 'service_operational' });
        const request = await openRequest(email);
        global.fetch = jest.fn(async (url) => (url.includes('/groups/') ? { ok: false, status: 500 } : { ok: true, status: 204 }));
        expect(await service.completeResubscribe(request)).toBe('retry');
        expect((await db('email_suppressions').where({ id: globalRow.id }).first()).status).toBe('released');
        expect((await db('email_suppressions').where({ id: serviceRow.id }).first()).status).toBe('active');
        expect((await db('email_resubscribe_requests').where({ id: request.id }).first()).used_at).toBeNull();
        global.fetch = jest.fn(async () => ({ ok: true, status: 204 }));
        expect(await service.completeResubscribe(request)).toBe('done');
        expect((await db('email_suppressions').where({ id: serviceRow.id }).first()).status).toBe('released');
        expect((await db('email_resubscribe_requests').where({ id: request.id }).first()).used_at).toBeInstanceOf(Date);
      });
    });

    test('a row the webhook updated after the pre-clear stays active, and the request stays open', async () => {
      process.env.SENDGRID_API_KEY = 'SG.test';
      await withCommitted(async (email) => {
        const row = await sup(db, { email });
        const request = await openRequest(email);
        // The newer opt-out lands between SendGrid's answer and the release.
        global.fetch = jest.fn(async () => {
          await db('email_suppressions').where({ id: row.id }).update({ updated_at: new Date(), source: 'sendgrid_event_webhook' });
          return { ok: true, status: 204 };
        });
        expect(await service.completeResubscribe(request)).toBe('retry');
        expect((await db('email_suppressions').where({ id: row.id }).first()).status).toBe('active');
        expect((await db('email_resubscribe_requests').where({ id: request.id }).first()).used_at).toBeNull();
      });
    });

    test('a second completion after the first marked the request used makes no SendGrid call and releases nothing, even if a NEW block exists', async () => {
      process.env.SENDGRID_API_KEY = 'SG.test';
      await withCommitted(async (email) => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 204 }));
        await sup(db, { email });
        const request = await openRequest(email);
        expect(await service.completeResubscribe(request)).toBe('done');
        expect(global.fetch).toHaveBeenCalledTimes(1);
        // The customer unsubscribes again; the SAME (stale, still-open-looking) snapshot is replayed late.
        const fresh = await sup(db, { email });
        global.fetch.mockClear();
        expect(await service.completeResubscribe(request)).toBe('already');
        expect(global.fetch).not.toHaveBeenCalled();
        expect((await db('email_suppressions').where({ id: fresh.id }).first()).status).toBe('active');
      });
    });

    test('two concurrent completions of one request release once: the second waits on the request row, then sees it used', async () => {
      process.env.SENDGRID_API_KEY = 'SG.test';
      await withCommitted(async (email) => {
        global.fetch = jest.fn(() => new Promise((resolve) => { setTimeout(() => resolve({ ok: true, status: 204 }), 150); }));
        const row = await sup(db, { email });
        const request = await openRequest(email);
        const results = await Promise.all([service.completeResubscribe(request), service.completeResubscribe(request)]);
        expect(results.sort()).toEqual(['already', 'done']);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect((await db('email_suppressions').where({ id: row.id }).first()).status).toBe('released');
      });
    });

    test('an expired request is refused before any SendGrid call or release', async () => {
      process.env.SENDGRID_API_KEY = 'SG.test';
      await withCommitted(async (email) => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 204 }));
        const row = await sup(db, { email });
        const request = await openRequest(email);
        await db('email_resubscribe_requests').where({ id: request.id }).update({ expires_at: new Date(Date.now() - 1000) });
        expect(await service.completeResubscribe(request)).toBe('expired');
        expect(global.fetch).not.toHaveBeenCalled();
        expect((await db('email_suppressions').where({ id: row.id }).first()).status).toBe('active');
      });
    });
  });
});
