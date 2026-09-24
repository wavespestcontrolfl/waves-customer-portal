/**
 * routes/admin-tech-out.js — GATE_TECH_OUT_REDISTRIBUTE admin surface.
 *
 * services/tech-out.js is fully mocked; these tests pin the route layer's
 * own behavior: the gate check on every handler, the 201 shape, and the
 * error-code -> HTTP-status mapping. Handlers are invoked directly (bypassing
 * the router.use(adminAuthenticate, requireAdmin) layer), same pattern as
 * tests/admin-protocols-job-card-route.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/tech-out', () => ({
  techOutEnabled: jest.fn(),
  getTechOut: jest.fn(),
  markTechOut: jest.fn(),
  clearTechOut: jest.fn(),
}));
jest.mock('../services/tech-out-auto-move', () => ({
  autoMoveEnabled: jest.fn(),
  autoAssignTechDay: jest.fn(),
}));

const techOut = require('../services/tech-out');
const techOutAutoMove = require('../services/tech-out-auto-move');
const router = require('../routes/admin-tech-out');

const TECH_ID = '11111111-2222-4333-8444-555555555555';

function layerFor(method, path) {
  return router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
}

async function run(method, path, { params = {}, query = {}, body = {} } = {}) {
  const layer = layerFor(method, path);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const req = { params: { technicianId: TECH_ID, ...params }, query, body, technicianId: 'actor-1' };
  let nextErr;
  await handler(req, res, (err) => { nextErr = err; });
  if (nextErr) throw nextErr;
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  techOutAutoMove.autoMoveEnabled.mockReturnValue(false);
});

describe('admin-tech-out routes', () => {
  test('gate off answers 404 { enabled: false } on every route, with no service call', async () => {
    techOut.techOutEnabled.mockReturnValue(false);

    expect((await run('get', '/:technicianId')).statusCode).toBe(404);
    expect((await run('post', '/:technicianId', { body: { reason: 'sick' } })).statusCode).toBe(404);
    expect((await run('delete', '/:technicianId')).statusCode).toBe(404);

    expect((await run('get', '/:technicianId')).body).toEqual({ enabled: false });
    expect(techOut.getTechOut).not.toHaveBeenCalled();
    expect(techOut.markTechOut).not.toHaveBeenCalled();
    expect(techOut.clearTechOut).not.toHaveBeenCalled();
  });

  test('GET returns the current absence, defaulting date to today ET, plus auto_move_enabled', async () => {
    techOut.techOutEnabled.mockReturnValue(true);
    techOut.getTechOut.mockResolvedValue({ id: 'abs-1' });

    const res = await run('get', '/:technicianId');

    expect(res.body).toEqual({ enabled: true, absence: { id: 'abs-1' }, auto_move_enabled: false });
    expect(techOut.getTechOut).toHaveBeenCalledWith(expect.objectContaining({ technicianId: TECH_ID, date: expect.any(String) }));
  });

  test('GET reports auto_move_enabled: true when the auto-move gate is on', async () => {
    techOut.techOutEnabled.mockReturnValue(true);
    techOut.getTechOut.mockResolvedValue(null);
    techOutAutoMove.autoMoveEnabled.mockReturnValue(true);

    const res = await run('get', '/:technicianId');

    expect(res.body).toEqual({ enabled: true, absence: null, auto_move_enabled: true });
  });

  test('GET rejects an impossible calendar date with 400, no service call', async () => {
    techOut.techOutEnabled.mockReturnValue(true);

    const res = await run('get', '/:technicianId', { query: { date: '2027-02-31' } });

    expect(res.statusCode).toBe(400);
    expect(techOut.getTechOut).not.toHaveBeenCalled();
  });

  test('DELETE rejects an impossible calendar date with 400, no service call', async () => {
    techOut.techOutEnabled.mockReturnValue(true);

    const res = await run('delete', '/:technicianId', { query: { date: '2027-02-31' } });

    expect(res.statusCode).toBe(400);
    expect(techOut.clearTechOut).not.toHaveBeenCalled();
  });

  test('POST 201s with the absence + redistribution summary, actorId from req.technicianId', async () => {
    techOut.techOutEnabled.mockReturnValue(true);
    const absence = { id: 'abs-1', technician_id: TECH_ID, reason: 'sick' };
    const summary = { total: 2, moved: [], parked: [], failed: [] };
    techOut.markTechOut.mockResolvedValue({ absence, summary });

    const res = await run('post', '/:technicianId', { body: { reason: 'sick', note: 'flu' } });

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ absence, summary });
    expect(techOut.markTechOut).toHaveBeenCalledWith(expect.objectContaining({
      technicianId: TECH_ID, reason: 'sick', note: 'flu', actorId: 'actor-1',
    }));
  });

  test('POST maps a VALIDATION error (bad reason) to 400', async () => {
    techOut.techOutEnabled.mockReturnValue(true);
    techOut.markTechOut.mockRejectedValue(Object.assign(
      new Error('reason must be one of sick, emergency, no_show, other'),
      { status: 400, code: 'VALIDATION' },
    ));

    const res = await run('post', '/:technicianId', { body: { reason: 'vacation' } });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'reason must be one of sick, emergency, no_show, other' });
  });

  test('POST maps ALREADY_OUT to 409 already_out and PAST_DATE to 409 past_date', async () => {
    techOut.techOutEnabled.mockReturnValue(true);

    techOut.markTechOut.mockRejectedValueOnce(Object.assign(new Error('dup'), { status: 409, code: 'ALREADY_OUT' }));
    expect((await run('post', '/:technicianId', { body: { reason: 'sick' } })).body).toEqual({ error: 'already_out' });

    techOut.markTechOut.mockRejectedValueOnce(Object.assign(new Error('past'), { status: 409, code: 'PAST_DATE' }));
    const res = await run('post', '/:technicianId', { body: { reason: 'sick' } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'past_date' });
  });

  test('POST forwards an unexpected error to next()', async () => {
    techOut.techOutEnabled.mockReturnValue(true);
    techOut.markTechOut.mockRejectedValue(new Error('boom'));

    await expect(run('post', '/:technicianId', { body: { reason: 'sick' } })).rejects.toThrow('boom');
  });

  test('DELETE clears the absence and maps NOT_OUT to 404 not_out', async () => {
    techOut.techOutEnabled.mockReturnValue(true);
    techOut.clearTechOut.mockResolvedValue({ absence: { id: 'abs-1', cleared_at: 'now' }, resolvedAlerts: [] });
    const ok = await run('delete', '/:technicianId');
    expect(ok.body).toEqual({ absence: { id: 'abs-1', cleared_at: 'now' }, resolvedAlerts: [] });

    techOut.clearTechOut.mockRejectedValue(Object.assign(new Error('nope'), { status: 404, code: 'NOT_OUT' }));
    const notFound = await run('delete', '/:technicianId');
    expect(notFound.statusCode).toBe(404);
    expect(notFound.body).toEqual({ error: 'not_out' });
  });

  describe('POST /:technicianId/auto-assign', () => {
    test('base gate off answers the same 404 { enabled: false } as every other handler', async () => {
      techOut.techOutEnabled.mockReturnValue(false);
      const res = await run('post', '/:technicianId/auto-assign', { body: { date: '2026-09-24' } });
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ enabled: false });
      expect(techOutAutoMove.autoAssignTechDay).not.toHaveBeenCalled();
    });

    test('base gate on but auto-move gate off answers 404 with auto_move_enabled: false', async () => {
      techOut.techOutEnabled.mockReturnValue(true);
      techOutAutoMove.autoMoveEnabled.mockReturnValue(false);
      const res = await run('post', '/:technicianId/auto-assign', { body: { date: '2026-09-24' } });
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ enabled: true, auto_move_enabled: false });
      expect(techOutAutoMove.autoAssignTechDay).not.toHaveBeenCalled();
    });

    test('rejects an impossible calendar date with 400, no service call', async () => {
      techOut.techOutEnabled.mockReturnValue(true);
      techOutAutoMove.autoMoveEnabled.mockReturnValue(true);
      const res = await run('post', '/:technicianId/auto-assign', { body: { date: '2027-02-31' } });
      expect(res.statusCode).toBe(400);
      expect(techOutAutoMove.autoAssignTechDay).not.toHaveBeenCalled();
    });

    test('runs the batch for the given date with the actor from req.technicianId, defaulting date to today ET', async () => {
      techOut.techOutEnabled.mockReturnValue(true);
      techOutAutoMove.autoMoveEnabled.mockReturnValue(true);
      techOutAutoMove.autoAssignTechDay.mockResolvedValue({
        moved: [{ alert_id: 'a1', job_id: 'j1', to_technician_id: 'tech-2' }],
        left_parked: [{ alert_id: 'a2', reason: 'no_eligible_candidate' }],
      });

      const res = await run('post', '/:technicianId/auto-assign', {});

      expect(res.body).toEqual({
        enabled: true,
        auto_move_enabled: true,
        moved: [{ alert_id: 'a1', job_id: 'j1', to_technician_id: 'tech-2' }],
        left_parked: [{ alert_id: 'a2', reason: 'no_eligible_candidate' }],
      });
      expect(techOutAutoMove.autoAssignTechDay).toHaveBeenCalledWith(expect.objectContaining({
        technicianId: TECH_ID, date: expect.any(String), actorId: 'actor-1',
      }));
    });

    test('runs for an explicit date', async () => {
      techOut.techOutEnabled.mockReturnValue(true);
      techOutAutoMove.autoMoveEnabled.mockReturnValue(true);
      techOutAutoMove.autoAssignTechDay.mockResolvedValue({ moved: [], left_parked: [] });

      await run('post', '/:technicianId/auto-assign', { body: { date: '2026-09-24' } });

      expect(techOutAutoMove.autoAssignTechDay).toHaveBeenCalledWith(expect.objectContaining({
        technicianId: TECH_ID, date: '2026-09-24', actorId: 'actor-1',
      }));
    });

    test('forwards an unexpected error to next()', async () => {
      techOut.techOutEnabled.mockReturnValue(true);
      techOutAutoMove.autoMoveEnabled.mockReturnValue(true);
      techOutAutoMove.autoAssignTechDay.mockRejectedValue(new Error('boom'));

      await expect(run('post', '/:technicianId/auto-assign', { body: { date: '2026-09-24' } })).rejects.toThrow('boom');
    });
  });

});
