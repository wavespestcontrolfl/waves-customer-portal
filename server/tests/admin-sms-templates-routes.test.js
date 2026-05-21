process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole)
      ? next()
      : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const express = require('express');
const db = require('../models/db');
const smsTemplatesRouter = require('../routes/admin-sms-templates');

function chain({ result = [], first, deleteResult = 1 } = {}) {
  const q = {};
  ['where', 'orderBy', 'insert', 'onConflict', 'ignore'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.first = jest.fn(async () => first);
  q.del = jest.fn(async () => deleteResult);
  q.returning = jest.fn(async () => result);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) {
      throw new Error(`Unexpected db table ${table}`);
    }
    return queue.shift();
  });
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/sms-templates', smsTemplatesRouter);
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

describe('admin SMS template routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = {
      hasTable: jest.fn(async () => true),
      hasColumn: jest.fn(async () => true),
    };
  });

  test('protects seeded SMS templates from hard delete', async () => {
    setDbQueues({
      sms_templates: [chain({
        first: {
          id: 'sms-1',
          template_key: 'invoice_sent',
          category: 'billing',
        },
      })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sms-templates/sms-1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({ error: 'template is protected from hard delete' });
      expect(db).toHaveBeenCalledTimes(1);
    });
  });

  test('deletes custom SMS templates', async () => {
    const deleteQuery = chain();
    setDbQueues({
      sms_templates: [
        chain({
          first: {
            id: 'sms-custom-1',
            template_key: 'custom_followup',
            category: 'custom',
          },
        }),
        deleteQuery,
      ],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sms-templates/sms-custom-1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(deleteQuery.where).toHaveBeenCalledWith({ id: 'sms-custom-1' });
      expect(deleteQuery.del).toHaveBeenCalled();
    });
  });
});
