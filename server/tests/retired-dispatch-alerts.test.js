'use strict';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { emitRetiredAlertResolutions, RETIRED_TYPES } = require('../services/retired-dispatch-alerts');
const { EVENT_RESOLVED } = require('../services/dispatch-alerts');

function fakeKnex(rows, calls) {
  return (table) => {
    const q = {
      whereIn: (col, vals) => { calls.push(['whereIn', table, col, vals]); return q; },
      whereNotNull: (col) => { calls.push(['whereNotNull', col]); return q; },
      where: (col, op, val) => { calls.push(['where', col, op, val]); return q; },
      limit: () => q,
      select: async () => rows,
    };
    return q;
  };
}

describe('retired dispatch alert resolutions on staff socket connect', () => {
  test('emits dispatch:alert_resolved to the connecting socket for each retired card resolved in the window', async () => {
    const socket = { emit: jest.fn() };
    const calls = [];
    const now = new Date('2026-10-22T12:00:00Z');
    const rows = [{ id: 'a1', resolved_at: '2026-10-22T05:00:00Z' }, { id: 'a2', resolved_at: '2026-10-22T05:00:00Z' }];
    const n = await emitRetiredAlertResolutions(socket, { knex: fakeKnex(rows, calls), now });
    expect(n).toBe(2);
    expect(socket.emit).toHaveBeenCalledWith(EVENT_RESOLVED, { id: 'a1', resolved_at: rows[0].resolved_at, resolved_by: null });
    expect(socket.emit).toHaveBeenCalledWith(EVENT_RESOLVED, { id: 'a2', resolved_at: rows[1].resolved_at, resolved_by: null });
    expect(calls).toContainEqual(['whereIn', 'dispatch_alerts', 'type', RETIRED_TYPES]);
    expect(calls).toContainEqual(['whereNotNull', 'resolved_at']);
    expect(calls).toContainEqual(['where', 'resolved_at', '>=', new Date('2026-10-08T12:00:00Z')]);
    expect(RETIRED_TYPES).toEqual(['completed_with_open_comms']);
  });

  test('a failed read never throws into the connection handler', async () => {
    const socket = { emit: jest.fn() };
    const knex = () => { throw new Error('db down'); };
    await expect(emitRetiredAlertResolutions(socket, { knex })).resolves.toBe(0);
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
