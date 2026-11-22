/**
 * The newsletter Gmail check's two reads on real PostgreSQL.
 * - The counts (newsletter-sender gmailOpenCounts): which copies of one issue count as delivered
 *   by a given time and as opened by a person by then, for Gmail mailboxes and for all other
 *   mailboxes. The ledger rows are written by the SendGrid webhook's own event mapping
 *   (computeNewsletterEventUpdates), and the opens are rows of its event log
 *   (sendgrid_webhook_events), where the machine-open flag and the time of the open live.
 * - The issues a run judges (newsletter-gmail-check issuesToJudge): the ones that went out 48 to
 *   72 hours before, by the later of the send's own time and its newest mailed copy.
 * A fake query builder cannot show what the correlated subqueries, the FILTER clauses, a NULL flag
 * and a NULL time read as. Self-skips unless DATABASE_URL is set (CI's DB-gated suites run it).
 * The fixtures are synthetic (no subscriber, made-up local parts) and are removed in afterAll.
 */
jest.setTimeout(30000);

const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 2 },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

(SKIP ? describe.skip : describe)('the newsletter Gmail check counts on PostgreSQL', () => {
  let db;
  let gmailOpenCounts;
  let issuesToJudge;
  let computeNewsletterEventUpdates;
  const sendIds = [];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const eventPrefix = `gmail-check-${stamp}-`;

  beforeAll(() => {
    db = require('../models/db');
    ({ gmailOpenCounts } = require('../services/newsletter-sender'));
    ({ issuesToJudge } = require('../services/newsletter-gmail-check'));
    ({ computeNewsletterEventUpdates } = require('../routes/webhooks-sendgrid'));
  });
  afterAll(async () => {
    await db('sendgrid_webhook_events').where('event_id', 'like', `${eventPrefix}%`).del();
    if (sendIds.length) {
      await db('newsletter_send_deliveries').whereIn('send_id', sendIds).del();
      await db('newsletter_sends').whereIn('id', sendIds).del();
    }
    await db.destroy();
  });

  const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000);
  // Copies and opens count up to this time. Unless a case says otherwise, the events below reached
  // the webhook 20 hours ago and the opens happened 10 hours ago.
  const AS_OF = hoursAgo(2);

  // Applies SendGrid events to one ledger row through the webhook's own mapping, in order. `at` =
  // when the webhook got them: the time the mapping stamps on the row.
  async function receive(id, events, at = hoursAgo(20)) {
    for (const ev of events) {
      const row = await db('newsletter_send_deliveries').where({ id }).first();
      const update = computeNewsletterEventUpdates(ev, row, at);
      if (update) await db('newsletter_send_deliveries').where({ id }).update(update.delivery);
    }
  }

  let eventNo = 0;
  // One row of the webhook's event log, as processWebhookEvent writes an open. `logged` = a row from
  // before the log kept SendGrid's own event time: it has only the time it was written.
  async function logOpen({ messageId, email, machineOpen, at = hoursAgo(10), logged = null }) {
    eventNo += 1;
    await db('sendgrid_webhook_events').insert({
      event_id: `${eventPrefix}${eventNo}`, event_type: 'open', message_id: messageId, email,
      occurred_at: logged ? null : at, ...(logged ? { created_at: logged } : {}), machine_open: machineOpen, status: 'processed',
    });
  }

  test('counts the copies delivered by a given time and the opens by a person by then, for Gmail and for all other mailboxes', async () => {
    const [send] = await db('newsletter_sends').insert({
      subject: 'Synthetic Gmail check', html_body: '<p>Body</p>', text_body: 'Body', status: 'sent', sent_at: new Date(), auto_share_social: false,
    }).returning(['id']);
    sendIds.push(send.id);
    const messageId = `msg-${stamp}`;
    const copies = {
      gmailPerson: `person-${stamp}@gmail.com`,
      // Apple Mail fetched it by itself: the ledger gets opened_at, and no person read it.
      gmailMachine: `machine-${stamp}@Googlemail.com`,
      // An open logged before the machine flag and the event time were kept.
      gmailOldFlag: `oldflag-${stamp}@gmail.com`,
      // A person opened it, but after the time the count stops at.
      gmailLateOpen: `lateopen-${stamp}@gmail.com`,
      // Gmail took it after the time the count stops at: its reader had no time to open it.
      gmailLateDelivery: `latedelivery-${stamp}@gmail.com`,
      // This reader's only open is on another issue's message.
      gmailOtherIssue: `otherissue-${stamp}@gmail.com`,
      // Accepted by SendGrid with no later event: not a delivered copy yet.
      gmailAccepted: `accepted-${stamp}@gmail.com`,
      gmailBounced: `bounced-${stamp}@gmail.com`,
      otherPerson: `person-${stamp}@yahoo.com`,
      // A link was followed and no open came: a scanner does that.
      otherClickOnly: `clickonly-${stamp}@example.test`,
      // The reader's own spam report, with no delivered event: only a delivered copy gets one.
      otherSpamReport: `spamreport-${stamp}@aol.com`,
    };
    const rows = await db('newsletter_send_deliveries').insert(Object.values(copies).map((email) => ({
      send_id: send.id, subscriber_id: null, email, status: 'sent', sent_at: new Date(), provider_message_id: messageId,
    }))).returning(['id', 'email']);
    const id = Object.fromEntries(Object.entries(copies).map(([kind, email]) => [kind, rows.find((row) => row.email === email).id]));

    await receive(id.gmailPerson, [{ event: 'delivered' }, { event: 'open' }]);
    await logOpen({ messageId, email: copies.gmailPerson, machineOpen: false });
    await receive(id.gmailMachine, [{ event: 'delivered' }, { event: 'open', sg_machine_open: true }]);
    await logOpen({ messageId, email: copies.gmailMachine, machineOpen: true });
    await receive(id.gmailOldFlag, [{ event: 'delivered' }, { event: 'open' }]);
    await logOpen({ messageId, email: copies.gmailOldFlag, machineOpen: null, logged: hoursAgo(10) });
    await receive(id.gmailLateOpen, [{ event: 'delivered' }]);
    await receive(id.gmailLateOpen, [{ event: 'open' }], hoursAgo(1));
    await logOpen({ messageId, email: copies.gmailLateOpen, machineOpen: false, at: hoursAgo(1) });
    await receive(id.gmailLateDelivery, [{ event: 'delivered' }], hoursAgo(1));
    await receive(id.gmailOtherIssue, [{ event: 'delivered' }]);
    await logOpen({ messageId: `other-${messageId}`, email: copies.gmailOtherIssue, machineOpen: false });
    await receive(id.gmailBounced, [{ event: 'bounce', type: 'bounce', reason: '550 5.1.1 mailbox does not exist' }]);
    await receive(id.otherPerson, [{ event: 'delivered' }, { event: 'open' }]);
    // SendGrid reports the address in another case than the ledger holds.
    await logOpen({ messageId, email: copies.otherPerson.toUpperCase(), machineOpen: false });
    await receive(id.otherClickOnly, [{ event: 'delivered' }, { event: 'click' }]);
    await receive(id.otherSpamReport, [{ event: 'spamreport' }]);

    // The ledger alone cannot tell the machine open from a person's: both rows carry opened_at.
    const ledgerOpens = await db('newsletter_send_deliveries').whereIn('id', [id.gmailPerson, id.gmailMachine]).whereNotNull('opened_at');
    expect(ledgerOpens).toHaveLength(2);

    expect(await gmailOpenCounts(db, send.id, AS_OF)).toEqual({
      // Delivered: person, machine, old flag, other issue, late open. Not the late delivery, not the
      // accepted-only copy, not the bounce. Opened: person, old flag.
      gmail: { delivered: 5, opened: 2 },
      // Delivered: person, click only, own spam report. Opened: person.
      other: { delivered: 3, opened: 1 },
    });
    // A read with a later time counts the late delivery and the late open too: the time is what
    // fixes the counts, so every run of the check passes the same one.
    expect((await gmailOpenCounts(db, send.id, new Date())).gmail).toEqual({ delivered: 6, opened: 3 });
  });

  test('a run judges the issues that went out 48 to 72 hours before, by the later of the send time and the newest mailed copy', async () => {
    const now = new Date();
    // One fixed `now` for the rows and the read, so an exact time can be compared.
    const ago = (hours) => new Date(now.getTime() - hours * 60 * 60 * 1000);
    // [name, status, the send's own sent_at, the times its copies were mailed]
    const cases = [
      ['sent in the window', 'sent', ago(49), []],
      ['sent too new', 'sent', ago(47), []],
      ['sent too old', 'sent', ago(73), []],
      ['still sending', 'sending', ago(50), []],
      ['stopped part way, with a time', 'failed', ago(60), []],
      // The tick threw before the final write: no sent_at on the send.
      ['died, newest copy in the window', 'failed', null, [ago(56), ago(55)]],
      ['died, newest copy too new', 'failed', null, [ago(55), ago(30)]],
      ['died, no copy mailed', 'failed', null, []],
      // A resume keeps the first sent_at: the newest readers need the same 48 hours.
      ['resumed, newest copy in the window', 'sent', ago(120), [ago(119), ago(50)]],
      ['resumed, newest copy too new', 'sent', ago(60), [ago(59), ago(10)]],
    ];
    const idOf = {};
    for (const [name, status, sentAt, mailed] of cases) {
      const [send] = await db('newsletter_sends').insert({
        subject: `Synthetic Gmail check: ${name}`, html_body: '<p>Body</p>', text_body: 'Body', status, sent_at: sentAt, auto_share_social: false,
      }).returning(['id']);
      sendIds.push(send.id);
      idOf[name] = send.id;
      if (mailed.length) {
        await db('newsletter_send_deliveries').insert(mailed.map((at, i) => ({
          send_id: send.id, subscriber_id: null, email: `window-${i}-${stamp}@example.test`, status: 'sent', sent_at: at,
        })));
      }
    }

    // CI shares one database: read this test's own sends out of the run's list.
    const mine = (await issuesToJudge(now)).filter((row) => Object.values(idOf).includes(row.id));

    expect(mine.map((row) => row.id)).toEqual([
      idOf['stopped part way, with a time'], idOf['died, newest copy in the window'],
      idOf['resumed, newest copy in the window'], idOf['sent in the window'],
    ]);
    expect(new Date(mine[1].went_out_at).getTime()).toBe(ago(55).getTime());
    expect(new Date(mine[2].went_out_at).getTime()).toBe(ago(50).getTime());
    // The columns the alert reads.
    expect(Object.keys(mine[3]).sort()).toEqual(['id', 'newsletter_type', 'subject', 'went_out_at']);
    expect(mine[3].subject).toBe('Synthetic Gmail check: sent in the window');
  });

  test('an issue with no copies reads as zeros', async () => {
    const [send] = await db('newsletter_sends').insert({
      subject: 'Synthetic Gmail check, empty', html_body: '<p>Body</p>', text_body: 'Body', status: 'sent', sent_at: new Date(), auto_share_social: false,
    }).returning(['id']);
    sendIds.push(send.id);

    expect(await gmailOpenCounts(db, send.id, new Date())).toEqual({
      gmail: { delivered: 0, opened: 0 }, other: { delivered: 0, opened: 0 },
    });
  });
});
