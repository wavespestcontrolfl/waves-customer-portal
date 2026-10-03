// A recap video bakes the greeting into its intro. One rendered before the
// blank-first-name rule greets a no-first-name customer by their SURNAME, so
// approve and send re-render it instead of delivering it (codex #5674 r1).

jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ s3: {}, jwt: { secret: 'test' } }));

const fs = require('fs');
const path = require('path');
const { approveRecap, recapNeedsGreetingRerender, RECAP_GREETING_VERSION } = require('../services/service-report/recap-pipeline');
const { sendRecap } = require('../services/service-report/recap-delivery');

const SVC = '11111111-1111-4111-8111-111111111111';

// Table-routed fake knex: records every update, answers first() per table.
function fakeKnex({ recap, firstName, isCallback = false }) {
  const updates = [];
  const knex = (table) => {
    const name = String(table).split(' ')[0];
    const chain = {
      where: () => chain,
      leftJoin: () => chain,
      orderBy: () => chain,
      select: () => chain,
      returning: async () => [{ ...recap, ...updates[updates.length - 1]?.patch }],
      update: (patch) => { updates.push({ table: name, patch }); return chain; },
      first: async () => {
        if (name === 'scheduled_services') return { is_callback: isCallback };
        if (name === 'service_recaps') return recap;
        if (name === 'service_records') return { first_name: firstName, id: 'rec-1', phone: null };
        return null;
      },
      then: (res) => res(1),
    };
    return chain;
  };
  return { knex, updates };
}

describe('recap greeting re-render', () => {
  test('an old render for a no-first-name customer needs a re-render; a stamped one or a named customer does not', async () => {
    const old = { id: 1, scheduled_service_id: SVC, status: 'ready', greeting_version: null };
    expect(await recapNeedsGreetingRerender(old, fakeKnex({ recap: old, firstName: '' }).knex)).toBe(true);
    expect(await recapNeedsGreetingRerender(old, fakeKnex({ recap: old, firstName: null }).knex)).toBe(true);
    expect(await recapNeedsGreetingRerender(old, fakeKnex({ recap: old, firstName: 'Sample' }).knex)).toBe(false);
    const stamped = { ...old, greeting_version: RECAP_GREETING_VERSION };
    expect(await recapNeedsGreetingRerender(stamped, fakeKnex({ recap: stamped, firstName: '' }).knex)).toBe(false);
  });

  test('approve re-queues a stale ready recap instead of approving it', async () => {
    const recap = { id: 1, scheduled_service_id: SVC, status: 'ready', greeting_version: null, sent_at: null };
    const { knex, updates } = fakeKnex({ recap, firstName: '' });
    const result = await approveRecap(SVC, { knex });
    expect(result).toEqual({ ok: false, error: 'rerendering_greeting' });
    expect(updates.some((u) => u.patch.status === 'pending' && u.patch.approved_at === null)).toBe(true);
    expect(updates.some((u) => u.patch.status === 'approved')).toBe(false);
  });

  test('approve proceeds for a named customer', async () => {
    const recap = { id: 1, scheduled_service_id: SVC, status: 'ready', greeting_version: null, sent_at: null };
    const { knex, updates } = fakeKnex({ recap, firstName: 'Sample' });
    const result = await approveRecap(SVC, { knex });
    expect(result.ok).toBe(true);
    expect(updates.some((u) => u.patch.status === 'approved')).toBe(true);
  });

  test('send re-queues an approved-but-unsent stale recap instead of texting it', async () => {
    const recap = { id: 1, scheduled_service_id: SVC, status: 'approved', greeting_version: null, sent_at: null };
    const { knex, updates } = fakeKnex({ recap, firstName: '' });
    const result = await sendRecap(SVC, { knex });
    expect(result).toEqual({ ok: false, reason: 'rerendering_greeting' });
    expect(updates.some((u) => u.patch.status === 'pending')).toBe(true);
  });

  test('every fresh render is stamped with the current greeting version; the migration adds the column', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-report/recap-pipeline.js'), 'utf8');
    expect(src).toContain('greeting_version: RECAP_GREETING_VERSION,');
    const mig = fs.readFileSync(path.join(__dirname, '../models/migrations/20261003030000_service_recaps_greeting_version.js'), 'utf8');
    expect(mig).toContain("t.integer('greeting_version').nullable();");
    expect(mig).toContain("t.dropColumn('greeting_version');");
  });
});
