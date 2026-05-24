jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const {
  heartbeatPipelineRun,
  reapStaleSeoRuns,
  _internals,
} = require('../services/seo/seo-pipeline-runs');

afterEach(() => {
  db.mockReset();
});

function updateReturningBuilder(rows = []) {
  const builder = {
    where: jest.fn(() => builder),
    update: jest.fn(() => builder),
    returning: jest.fn(() => Promise.resolve(rows)),
  };
  return builder;
}

function updateBuilder(result = 1) {
  const builder = {
    where: jest.fn(() => builder),
    update: jest.fn(() => Promise.resolve(result)),
  };
  return builder;
}

describe('SEO pipeline run state', () => {
  test('stale cutoff uses configured minutes with a safe default', () => {
    const now = new Date('2026-05-24T12:00:00.000Z');

    expect(_internals.staleCutoff(now, 30).toISOString()).toBe('2026-05-24T11:30:00.000Z');
    expect(_internals.staleAfterMinutes('15')).toBe(15);
    expect(_internals.staleAfterMinutes('0')).toBe(30);
    expect(_internals.staleAfterMinutes('bad')).toBe(30);
  });

  test('reaps stale pipeline and site-audit rows by heartbeat timestamp', async () => {
    const now = new Date('2026-05-24T12:00:00.000Z');
    const pipelineBuilder = updateReturningBuilder([{ id: 'pipeline-1' }]);
    const auditBuilder = updateReturningBuilder([{ id: 'audit-1' }]);
    db.mockImplementation((table) => {
      if (table === 'seo_pipeline_runs') return pipelineBuilder;
      if (table === 'seo_site_audit_runs') return auditBuilder;
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await reapStaleSeoRuns({ now, staleMinutes: 20 });

    expect(result.reaped).toBe(2);
    expect(pipelineBuilder.where).toHaveBeenCalledWith({ status: 'running' });
    expect(pipelineBuilder.where).toHaveBeenCalledWith('updated_at', '<', new Date('2026-05-24T11:40:00.000Z'));
    expect(pipelineBuilder.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      completed_at: now,
      updated_at: now,
      error: expect.stringContaining('No SEO pipeline heartbeat for 20 minutes'),
    }));
    expect(auditBuilder.where).toHaveBeenCalledWith({ status: 'running' });
    expect(auditBuilder.update).toHaveBeenCalledWith({ status: 'failed', updated_at: now });
  });

  test('heartbeat updates only the active running pipeline row', async () => {
    const builder = updateBuilder(1);
    db.mockReturnValue(builder);

    await heartbeatPipelineRun('run-1', { current_step: 'site_audit', pages: 25 });

    expect(db).toHaveBeenCalledWith('seo_pipeline_runs');
    expect(builder.where).toHaveBeenCalledWith({ id: 'run-1', status: 'running' });
    expect(builder.update).toHaveBeenCalledWith(expect.objectContaining({
      result: { current_step: 'site_audit', pages: 25 },
      updated_at: expect.any(Date),
    }));
  });
});
