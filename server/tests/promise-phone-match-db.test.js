/**
 * The quiet-call filter on a live Postgres (CI's DATABASE_URL step), as SQL. Owner 2026-11-04: "WHY ARENT THESE UPDATED
 * ... FOR ALL COMUNNICATION LINES".
 *   - an open Waves promise on a vendor_logged, spam_discarded or applicant call is left out of what the pagers list,
 *     and stays in the Owed tab's list.
 * Fixtures fictitious.
 */
// The new-lead re-alert pass (new-lead-reminder.js) is not this suite's subject. It has no gate, so the sweep run here in
// office hours would judge, stamp and push every open lead bell in the connected database. Its own suite
// (new-lead-reminder-postgres.test.js) runs it inside rolled-back transactions with the push mocked.
jest.mock('../services/new-lead-reminder', () => ({ runNewLeadReminder: jest.fn(async () => ({ skipped: true, reason: 'not_this_suite' })) }));
process.env.GATE_CALL_COMMITMENTS = 'true';
const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
const DAY = 24 * 60 * 60 * 1000;

maybeDescribe('phone-matched alert and promise rules (live Postgres)', () => {
  let db;
  let cc;
  const made = { call_log: [] };
  const BIZ = '+15555559000';
  let seq = 0;
  const sid = (prefix) => `${prefix}${String(Date.now()).slice(-8)}${String((seq += 1)).padStart(6, '0')}`;

  beforeAll(() => {
    db = require('../models/db');
    cc = require('../services/call-commitments');
  });
  afterAll(async () => {
    for (const table of ['call_log']) {
      if (made[table].length) await db(table).whereIn('id', made[table]).del(); // call_log cascades the commitments
    }
    await db.destroy();
  }, 120000);

  const insert = async (table, row) => {
    const [r] = await db(table).insert(row).returning('*');
    made[table].push(r.id);
    return r;
  };
  const phoneOf = () => `+1555${String(Date.now()).slice(-4)}${String((seq += 1) % 1000).padStart(3, '0')}`;

  describe('promises on vendor, spam and applicant calls', () => {
    const promiseOn = async (callExtra) => {
      const phone = phoneOf();
      const call = await insert('call_log', { twilio_call_sid: sid('CAV'), direction: 'inbound', from_phone: phone, to_phone: BIZ, status: 'completed',
        duration_seconds: 55, customer_id: null, created_at: new Date(Date.now() - DAY), ...callExtra });
      const [commitment] = await db('call_commitments').insert({ call_log_id: call.id, commitment_key: 'waves:callback', party: 'waves', kind: 'callback', source: 'ai',
        last_seen_generation: 1, status: 'open', description: `Call back ${call.id}`, evidence: JSON.stringify([{ quote: 'I will call you back', speaker: 'agent' }]) }).returning('id');
      return commitment.id;
    };

    test('the pagers\' list leaves them out; the Owed tab\'s list keeps every one', async () => {
      const vendor = await promiseOn({ disposition: 'vendor_logged' });
      const spam = await promiseOn({ disposition: 'spam_discarded' });
      const applicant = await promiseOn({ disposition: 'lead_response_flow_triggered', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: 'job_applicant' }) });
      const prospect = await promiseOn({ disposition: 'lead_response_flow_triggered', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: 'new_lead' }) });
      const mine = new Set([vendor, spam, applicant, prospect]);
      const page = () => cc.listOpenCommitments(db, { party: 'waves', limit: 200 });
      const ids = (rows) => rows.map((r) => r.id).filter((id) => mine.has(id));

      expect(ids(cc.pagerRows(await page()))).toEqual([prospect]);
      // The Owed tab reads the page itself, and keeps every one.
      expect(ids(await page()).length).toBe(4);
    });
  });
});
