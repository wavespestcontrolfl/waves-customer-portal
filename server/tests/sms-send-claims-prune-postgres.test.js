/**
 * The shared sms_send_claims prune (server/services/sms-send-claims.js)
 * deletes ordinary claims after a day but keeps the Monday BI briefing's
 * weekly claim for 8 days. Before this, tech-line and estimate-public
 * each deleted every row older than a day, so a Monday briefing claim
 * could vanish on Tuesday and a re-run could text the owner twice in one
 * week (pre-push audit, #4870).
 */
const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('pruneSmsSendClaims on PostgreSQL', () => {
  let knex;
  let pruneSmsSendClaims;
  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    ({ pruneSmsSendClaims } = require('../services/sms-send-claims'));
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('daily claims go after a day; weekly briefing claims stay until 8 days', async () => {
    const tag = `prune-test-${Date.now()}`;
    const rows = {
      dailyOld: { claim_key: `tech-line-text:${tag}:old`, age: '2 days' },
      dailyFresh: { claim_key: `outbound_voicemail:${tag}`, age: '1 hour' },
      weeklyThisWeek: { claim_key: `bi_briefing_sms:${tag}-a`, age: '6 days' },
      weeklyExpired: { claim_key: `bi_briefing_sms:${tag}-b`, age: '9 days' },
      // Underscores are LIKE wildcards; the prefix match must be exact.
      lookalikeOld: { claim_key: `biXbriefingXsms:${tag}`, age: '2 days' },
    };
    // Everything runs in one transaction that is always rolled back.
    const ROLLBACK = new Error('rollback');
    await expect(knex.transaction(async (trx) => {
      for (const { claim_key: claimKey, age } of Object.values(rows)) {
        await trx.raw('INSERT INTO sms_send_claims (claim_key, created_at) VALUES (?, NOW() - (?)::interval)', [claimKey, age]);
      }
      await pruneSmsSendClaims(trx);
      const left = await trx('sms_send_claims').where('claim_key', 'like', `%${tag}%`).pluck('claim_key');
      expect(left.sort()).toEqual([rows.dailyFresh.claim_key, rows.weeklyThisWeek.claim_key].sort());
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });
});
