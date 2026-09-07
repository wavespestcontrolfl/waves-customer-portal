// assignDispatchJob — the shared manual reassignment path (admin-dispatch,
// admin-schedule, admin-visits, reschedule-public, visit-groups) refuses a
// technician who cannot take field work AT SAVE TIME, whatever a stale
// board offered. Phase 0 item 1 of the Field Team Program.
jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stamped-address', () => ({
  stampedDivergesSql: () => 'FALSE',
  stampedLine2Sql: () => 'NULL',
}));

const db = require('../models/db');
const { assignDispatchJob } = require('../services/dispatch-assignment');

const JOB = { id: 'job-1', status: 'scheduled', technician_id: 't-old', scheduled_date: '2026-09-10' };

function primeReads({ tech }) {
  const jobChain = { where: jest.fn(() => jobChain), first: jest.fn(async () => JOB) };
  const techChain = { where: jest.fn(() => techChain), first: jest.fn(async () => tech) };
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return jobChain;
    if (table === 'technicians') return techChain;
    throw new Error(`unexpected table ${table}`);
  });
  db.transaction = jest.fn(async () => { throw new Error('transaction must not start for a refused technician'); });
  return { jobChain, techChain };
}

describe('assignDispatchJob save-time eligibility', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['prospective placeholder', { employment_status: 'prospective', field_dispatchable: true }, /has not started yet/],
    ['inactive account', { employment_status: 'inactive', field_dispatchable: true }, /no longer active/],
    ['active office-only admin', { employment_status: 'active', field_dispatchable: false }, /not field-dispatchable/],
  ])('refuses a %s with 422 TECH_NOT_ASSIGNABLE before any write', async (_label, techRow, msg) => {
    primeReads({ tech: { id: 't-new', name: 'Tech Two', ...techRow } });
    await expect(assignDispatchJob({ jobId: 'job-1', technicianId: 't-new', actorId: 'admin' }))
      .rejects.toMatchObject({ status: 422, code: 'TECH_NOT_ASSIGNABLE', message: expect.stringMatching(msg) });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('an unknown technician id is refused the same way (no 400 leak of the legacy path)', async () => {
    primeReads({ tech: null });
    await expect(assignDispatchJob({ jobId: 'job-1', technicianId: 't-ghost', actorId: 'admin' }))
      .rejects.toMatchObject({ status: 422, code: 'TECH_NOT_ASSIGNABLE' });
  });

  test('unassigning (null) needs no technician read and short-circuits when already unassigned', async () => {
    const { techChain } = primeReads({ tech: null });
    const jobChain = { where: jest.fn(() => jobChain), first: jest.fn(async () => ({ ...JOB, technician_id: null })) };
    db.mockImplementation((table) => (table === 'scheduled_services' ? jobChain : techChain));
    const out = await assignDispatchJob({ jobId: 'job-1', technicianId: null, actorId: 'admin' });
    expect(out.changed).toBe(false);
    expect(techChain.first).not.toHaveBeenCalled();
  });

  test('an assignable technician who already holds the job is a no-op that names them', async () => {
    primeReads({ tech: { id: 't-old', name: 'Tech One', employment_status: 'active', field_dispatchable: true } });
    const out = await assignDispatchJob({ jobId: 'job-1', technicianId: 't-old', actorId: 'admin' });
    expect(out).toMatchObject({ changed: false, technicianName: 'Tech One' });
  });

  test('the planned-baseline fence still fires before the eligibility read', async () => {
    const { techChain } = primeReads({ tech: { id: 't-new', employment_status: 'prospective', field_dispatchable: false } });
    await expect(assignDispatchJob({ jobId: 'job-1', technicianId: 't-new', actorId: 'admin', expectTechnicianId: 't-someone-else' }))
      .rejects.toMatchObject({ status: 409, code: 'ASSIGNMENT_STALE' });
    expect(techChain.first).not.toHaveBeenCalled();
  });
});
