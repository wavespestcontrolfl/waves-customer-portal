/**
 * closeAdminAlertIds (admin-alert-episodes.js): the id-addressed twin of closeAdminAlertKeys, for a source whose dedupeKey
 * can be shared by two rows. Selection shape only; the SQL runs against Postgres in alert-episodes-db.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({
  _private: { doneColumns: jest.fn((args) => ({ done_by: args.by, resolution: args.resolution })) },
}));

const NotificationService = require('../services/notification-service');
const { closeAdminAlertIds, closeAdminAlertKeys } = require('../services/admin-alert-episodes');

function fakeConn() {
  const q = {
    where: jest.fn(() => q),
    whereIn: jest.fn(() => q),
    whereRaw: jest.fn(() => q),
    update: jest.fn(async () => 2),
  };
  const conn = jest.fn(() => q);
  conn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return { conn, q };
}
const NOW = new Date('2026-11-06T12:00:00Z');

describe('closeAdminAlertIds', () => {
  test('no ids: no query', async () => {
    const { conn } = fakeConn();
    expect(await closeAdminAlertIds(conn, [], 'r')).toBe(0);
    expect(await closeAdminAlertIds(conn, [null, ''], 'r')).toBe(0);
    expect(conn).not.toHaveBeenCalled();
  });

  test('selects admin rows by id only, skips already-cleared rows, and writes the key close\'s stamps', async () => {
    const { conn, q } = fakeConn();
    const ids = ['a', 'a', 'b'];
    expect(await closeAdminAlertIds(conn, ids, 'wdo_superseded', { now: NOW, resolution: 'Replaced.' })).toBe(2);
    expect(q.where).toHaveBeenCalledWith({ recipient_type: 'admin' });
    expect(q.whereIn).toHaveBeenCalledWith('id', ['a', 'b']);
    expect(q.whereRaw).toHaveBeenCalledWith("metadata->>'autoCleared' IS DISTINCT FROM 'true'");
    // Never selects by dedupeKey.
    expect(q.whereRaw.mock.calls.some(([sql]) => String(sql).includes('dedupeKey'))).toBe(false);
    const patch = q.update.mock.calls[0][0];
    expect(NotificationService._private.doneColumns).toHaveBeenCalledWith(expect.objectContaining({ by: 'episodes', resolution: 'Replaced.', at: NOW, keepExisting: true }));
    expect(patch.done_by).toBe('episodes');
    expect(JSON.parse(patch.metadata.bindings[0])).toEqual({ autoCleared: true, autoClearedReason: 'wdo_superseded', autoClearedAt: NOW.toISOString() });
  });

  test('writes the same patch as closeAdminAlertKeys for the same reason and resolution', async () => {
    const byId = fakeConn();
    const byKey = fakeConn();
    await closeAdminAlertIds(byId.conn, ['a'], 'why', { now: NOW, resolution: 'Done.' });
    await closeAdminAlertKeys(byKey.conn, ['k'], 'why', { now: NOW, resolution: 'Done.' });
    expect(byId.q.update.mock.calls[0][0]).toEqual(byKey.q.update.mock.calls[0][0]);
    expect(byKey.q.whereRaw.mock.calls.some(([sql]) => String(sql).includes('dedupeKey'))).toBe(true);
  });
});
