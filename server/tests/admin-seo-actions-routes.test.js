process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/seo/seo-action-generator', () => ({
  getSummary: jest.fn(),
  autoApprove: jest.fn(),
  createExperiment: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      // The default IB_FULL_ACCESS_EMAILS allow-list (ib-access.js) is
      // real/unmocked here, so this admin's email must be the owner
      // account for the "owner reaches the service" assertion to hold.
      admin: { id: 'admin-1', role: 'admin', email: 'contact@wavespestcontrol.com', name: 'Owner' },
      // A second, non-owner admin — same role, ordinary admin login — for
      // the owner-only approve guard (owner ruling 2026-09-28).
      admin2: { id: 'admin-2', role: 'admin', email: 'other-admin@example.com', name: 'Other Admin' },
      tech: { id: 'tech-1', role: 'technician', email: 'tech@example.com', name: 'Tech' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const express = require('express');
const db = require('../models/db');
const SeoActionGenerator = require('../services/seo/seo-action-generator');
const seoActionsRouter = require('../routes/admin-seo-actions');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/seo/actions', seoActionsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A `db.transaction(cb)` mock that runs `cb` against a trx object whose
// table calls are provided by the test.
function mockTransaction(trxFactory) {
  db.transaction = jest.fn((cb) => cb(trxFactory()));
}

describe('admin seo actions routes — owner-only approve guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('non-owner admin gets 403 on approve and the action row is never touched', async () => {
    const trxTable = jest.fn();
    mockTransaction(() => trxTable);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/seo/actions/action-1/approve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin2', 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'looks good' }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('This action is limited to the owner account.');
      expect(db.transaction).not.toHaveBeenCalled();
      expect(trxTable).not.toHaveBeenCalled();
    });
  });

  test('owner admin reaches the approve transaction', async () => {
    const action = {
      id: 'action-1',
      diagnosis_id: 'diag-1',
      issue_type: 'thin_content',
      url: '/some-page',
      action_type: 'rewrite_title_meta',
      summary: 'Rewrite title/meta',
      impact_score: 8,
      effort_score: 2,
    };
    const actionsWhere = { first: jest.fn().mockResolvedValue(action) };
    const actionsUpdateWhere = { update: jest.fn().mockResolvedValue(1) };
    const decisionsInsert = jest.fn().mockResolvedValue([1]);
    const trxTable = jest.fn((table) => {
      if (table === 'seo_actions') {
        // First call reads the row (.where().first()), second call updates it
        // (.where().update()) — return an object exposing both chains.
        return {
          where: jest.fn(() => ({ ...actionsWhere, ...actionsUpdateWhere })),
        };
      }
      if (table === 'seo_decisions') {
        return { insert: decisionsInsert };
      }
      throw new Error(`Unexpected table ${table}`);
    });
    trxTable.fn = { now: () => new Date() };
    mockTransaction(() => trxTable);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/seo/actions/action-1/approve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'looks good' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ approved: true, id: 'action-1' });
      expect(db.transaction).toHaveBeenCalled();
      expect(decisionsInsert).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'accepted', decided_by_admin_id: 'admin-1' }),
      );
    });
  });

  test('bulk auto-approve is owner-only too: a non-owner gets 403 and nothing is approved; the owner reaches it', async () => {
    SeoActionGenerator.autoApprove.mockResolvedValue({ approved: 2 });
    await withServer(async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/admin/seo/actions/auto-approve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin2', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'example.test' }),
      });
      expect(denied.status).toBe(403);
      expect((await denied.json()).error).toBe('This action is limited to the owner account.');
      expect(SeoActionGenerator.autoApprove).not.toHaveBeenCalled();

      const allowed = await fetch(`${baseUrl}/admin/seo/actions/auto-approve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'example.test' }),
      });
      expect(allowed.status).toBe(200);
      expect(SeoActionGenerator.autoApprove).toHaveBeenCalledWith('example.test');
    });
  });

  test('a read route on the same router stays open to a non-owner admin', async () => {
    SeoActionGenerator.getSummary.mockResolvedValue({ pending_by_tier: { auto: 3 }, done: 5 });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/seo/actions/summary?domain=wavespestcontrol.com`, {
        headers: { Authorization: 'Bearer admin2' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ pending_by_tier: { auto: 3 }, done: 5 });
    });
  });
});

describe('admin seo actions routes — execute commits done + experiment together', () => {
  const approvedRow = {
    id: 'action-1',
    url: 'https://wavespestcontrol.com/bradenton-pest-control',
    action_type: 'rewrite_title_meta',
    status: 'open',
    approval_status: 'approved',
    execution_status: 'queued',
    started_at: null,
  };

  // A transactional fake: an update made through `trx` reaches `committed`
  // only when the callback resolves (knex commits then). A rejected callback
  // discards it, like a rollback.
  function mockStagedTransaction(row) {
    const committed = [];
    const trxs = [];
    db.transaction = jest.fn(async (cb) => {
      const staged = [];
      const trx = jest.fn((table) => {
        if (table !== 'seo_actions') throw new Error(`Unexpected table ${table}`);
        const q = {
          where: jest.fn(() => q),
          whereNot: jest.fn(() => q),
          first: jest.fn(async () => row),
          update: jest.fn((patch) => ({
            returning: jest.fn(async () => {
              const executable = row && row.status === 'open'
                && row.approval_status === 'approved' && row.execution_status !== 'done';
              if (!executable) return [];
              staged.push(patch);
              return [{ ...row, ...patch }];
            }),
          })),
        };
        return q;
      });
      trx.fn = { now: () => 'now()' };
      trxs.push(trx);
      const result = await cb(trx);
      committed.push(...staged);
      return result;
    });
    return { committed, trxs };
  }

  function postExecute(baseUrl) {
    return fetch(`${baseUrl}/admin/seo/actions/action-1/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin2', 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'title updated in the CMS' }),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Mark done commits the done row and creates the experiment in the same transaction', async () => {
    const { committed, trxs } = mockStagedTransaction(approvedRow);
    SeoActionGenerator.createExperiment.mockResolvedValue({ id: 'exp-1' });

    await withServer(async (baseUrl) => {
      const res = await postExecute(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ executed: true, id: 'action-1', experiment_id: 'exp-1' });
    });

    expect(committed).toEqual([expect.objectContaining({
      execution_status: 'done',
      executor: 'manual',
      execution_notes: 'title updated in the CMS',
    })]);
    expect(SeoActionGenerator.createExperiment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'action-1', execution_status: 'done' }),
      trxs[0],
    );
    expect(db).not.toHaveBeenCalled();
  });

  test('a failed experiment insert rolls the done write back and returns 500', async () => {
    const { committed, trxs } = mockStagedTransaction(approvedRow);
    SeoActionGenerator.createExperiment.mockRejectedValue(new Error('insert into seo_url_experiments failed'));

    await withServer(async (baseUrl) => {
      const res = await postExecute(baseUrl);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Execution failed' });
    });

    expect(committed).toEqual([]);
    expect(SeoActionGenerator.createExperiment).toHaveBeenCalledWith(expect.anything(), trxs[0]);
    expect(db).not.toHaveBeenCalled();
  });

  test('an action that is not approved gets 409 and no experiment', async () => {
    const { committed } = mockStagedTransaction({ ...approvedRow, approval_status: 'pending' });

    await withServer(async (baseUrl) => {
      const res = await postExecute(baseUrl);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Action must be open, approved, and not already executed' });
    });

    expect(committed).toEqual([]);
    expect(SeoActionGenerator.createExperiment).not.toHaveBeenCalled();
  });

  test('a missing action gets 404', async () => {
    mockStagedTransaction(undefined);

    await withServer(async (baseUrl) => {
      const res = await postExecute(baseUrl);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Action not found' });
    });

    expect(SeoActionGenerator.createExperiment).not.toHaveBeenCalled();
  });
});

describe('admin seo actions routes — list filters', () => {
  test('a comma-separated execution_status lists every named state; a single value still works', async () => {
    const calls = [];
    const query = {
      orderBy: jest.fn(() => query),
      limit: jest.fn(() => query),
      offset: jest.fn(() => query),
      where: jest.fn((...args) => { calls.push(['where', ...args]); return query; }),
      whereIn: jest.fn((...args) => { calls.push(['whereIn', ...args]); return query; }),
      then: (resolve) => resolve([{ id: 'action-1', execution_status: 'queued' }]),
    };
    db.mockImplementation(() => query);

    await withServer(async (baseUrl) => {
      const progress = await fetch(
        `${baseUrl}/admin/seo/actions?domain=example.test&approval_status=approved&execution_status=queued,manual_required,failed`,
        { headers: { Authorization: 'Bearer admin' } },
      );
      expect(progress.status).toBe(200);
      expect(await progress.json()).toEqual([{ id: 'action-1', execution_status: 'queued' }]);
      expect(calls).toContainEqual(['where', 'approval_status', 'approved']);
      expect(calls).toContainEqual(['whereIn', 'execution_status', ['queued', 'manual_required', 'failed']]);

      calls.length = 0;
      const done = await fetch(`${baseUrl}/admin/seo/actions?execution_status=done`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(done.status).toBe(200);
      expect(calls).toContainEqual(['whereIn', 'execution_status', ['done']]);
    });
  });
});
