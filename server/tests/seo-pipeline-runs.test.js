jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const {
  claimPipelineRun,
  claimQueuedPipelineRun,
  enqueuePipelineRun,
  heartbeatPipelineRun,
  releasePipelineRun,
  reapStaleSeoRuns,
  _internals,
} = require('../services/seo/seo-pipeline-runs');

afterEach(() => {
  db.mockReset();
  delete db.raw;
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

function selectFirstBuilder(row = null) {
  const builder = {
    where: jest.fn(() => builder),
    first: jest.fn(() => Promise.resolve(row)),
  };
  return builder;
}

function insertReturningBuilder(rows = []) {
  const builder = {
    insert: jest.fn(() => builder),
    returning: jest.fn(() => Promise.resolve(rows)),
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
    expect(_internals.pipelineDaysBack('12')).toBe(12);
    expect(_internals.pipelineDaysBack('bad')).toBe(7);
    expect(_internals.isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(_internals.isUuid('not-a-uuid')).toBe(false);
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

  test('releasePipelineRun returns an interrupted running run to the queue', async () => {
    const now = new Date('2026-05-24T12:00:00.000Z');
    const claimAfter = new Date('2026-05-24T12:02:00.000Z');
    const builder = updateBuilder(1);
    const rawResult = { raw: 'jsonb-merge' };
    db.mockReturnValue(builder);
    db.raw = jest.fn(() => rawResult);

    const result = await releasePipelineRun(
      '11111111-1111-4111-8111-111111111111',
      'worker received SIGTERM',
      now,
      claimAfter,
      14,
    );

    expect(result).toBe(1);
    expect(db).toHaveBeenCalledWith('seo_pipeline_runs');
    expect(builder.where).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'running',
    });
    expect(db.raw).toHaveBeenCalledWith(expect.stringContaining('jsonb_build_object'), [
      now,
      claimAfter,
      14,
      'worker received SIGTERM',
    ]);
    expect(builder.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued',
      completed_at: null,
      error: null,
      updated_at: now,
      result: rawResult,
    }));
  });

  test('enqueues new pipeline runs instead of starting them in the web process', async () => {
    const pipelineReaper = updateReturningBuilder([]);
    const auditReaper = updateReturningBuilder([]);
    const existingBuilder = selectFirstBuilder(null);
    const createdRun = { id: 'run-1', status: 'queued', domain: 'wavespestcontrol.com' };
    const insertBuilder = insertReturningBuilder([createdRun]);
    db
      .mockImplementationOnce(() => pipelineReaper)
      .mockImplementationOnce(() => auditReaper)
      .mockImplementationOnce(() => existingBuilder)
      .mockImplementationOnce(() => insertBuilder);

    const result = await enqueuePipelineRun({
      domain: 'https://www.wavespestcontrol.com/path',
      idempotencyKey: 'seo-key-1',
      requestedBy: 'tech-1',
      daysBack: 11,
    });

    expect(result).toEqual({ enqueued: true, run: createdRun });
    expect(existingBuilder.where).toHaveBeenCalledWith({ idempotency_key: 'seo-key-1' });
    expect(insertBuilder.insert).toHaveBeenCalledWith(expect.objectContaining({
      idempotency_key: 'seo-key-1',
      domain: 'wavespestcontrol.com',
      status: 'queued',
      requested_by: 'tech-1',
      result: expect.objectContaining({
        queued: true,
        options: { days_back: 11 },
      }),
    }));
  });

  test('legacy claimPipelineRun preserves the claimed running-row contract', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const pipelineReaper = updateReturningBuilder([]);
    const auditReaper = updateReturningBuilder([]);
    const existingBuilder = selectFirstBuilder(null);
    const insertBuilder = insertReturningBuilder([{ id: runId, status: 'queued', domain: 'wavespestcontrol.com' }]);
    const claimPipelineReaper = updateReturningBuilder([]);
    const claimAuditReaper = updateReturningBuilder([]);
    db
      .mockImplementationOnce(() => pipelineReaper)
      .mockImplementationOnce(() => auditReaper)
      .mockImplementationOnce(() => existingBuilder)
      .mockImplementationOnce(() => insertBuilder)
      .mockImplementationOnce(() => claimPipelineReaper)
      .mockImplementationOnce(() => claimAuditReaper);
    db.raw = jest.fn().mockResolvedValue({
      rows: [{ id: runId, status: 'running', domain: 'wavespestcontrol.com' }],
    });

    const result = await claimPipelineRun({
      domain: 'wavespestcontrol.com',
      idempotencyKey: 'seo-key-legacy',
      daysBack: 7,
    });

    expect(result.claimed).toBe(true);
    expect(result.run).toEqual(expect.objectContaining({
      id: runId,
      status: 'running',
    }));
  });

  test('claims one queued run with a locked queued-to-running transition', async () => {
    const now = new Date('2026-05-24T12:00:00.000Z');
    const pipelineReaper = updateReturningBuilder([]);
    const auditReaper = updateReturningBuilder([]);
    db
      .mockImplementationOnce(() => pipelineReaper)
      .mockImplementationOnce(() => auditReaper);
    db.raw = jest.fn().mockResolvedValue({
      rows: [{ id: 'run-1', status: 'running', domain: 'wavespestcontrol.com' }],
    });

    const result = await claimQueuedPipelineRun({ id: '11111111-1111-4111-8111-111111111111', now });

    expect(result.claimed).toBe(true);
    expect(result.run.status).toBe('running');
    expect(db.raw.mock.calls[0][0]).toContain("WHERE status = 'queued'");
    expect(db.raw.mock.calls[0][0]).toContain("result->>'requeue_claim_after' IS NULL");
    expect(db.raw.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(db.raw.mock.calls[0][0]).toContain("SET status = 'running'");
    expect(db.raw.mock.calls[0][1]).toEqual([
      '11111111-1111-4111-8111-111111111111',
      now,
      now,
      now,
      now,
    ]);
  });

  test('does not send malformed claim ids into the uuid cast', async () => {
    db.raw = jest.fn();

    await expect(claimQueuedPipelineRun({ id: 'not-a-uuid' })).resolves.toEqual({
      claimed: false,
      run: null,
    });
    expect(db.raw).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });
});
