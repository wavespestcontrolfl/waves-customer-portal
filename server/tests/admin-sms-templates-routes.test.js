process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/audit-log', () => ({
  auditNotificationTemplateIssue: jest.fn(async () => undefined),
}));
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
  ['where', 'orderBy', 'insert', 'onConflict', 'ignore', 'merge', 'limit'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.del = jest.fn(async () => deleteResult);
  q.returning = jest.fn(async () => result);
  q.select = jest.fn(async () => result);
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

  test('rejects template body updates with undeclared placeholders', async () => {
    const updateQuery = chain();
    setDbQueues({
      sms_templates: [
        chain({
          first: {
            id: 'sms-1',
            template_key: 'invoice_sent',
            category: 'billing',
            variables: JSON.stringify(['first_name', 'pay_url']),
          },
        }),
        updateQuery,
      ],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sms-templates/sms-1`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'Hello {first_name}, pay here: {bad_url}' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body).toMatchObject({
        error: 'Template body contains unknown placeholders',
        unknown_placeholders: ['bad_url'],
        allowed_placeholders: ['first_name', 'pay_url'],
      });
      expect(updateQuery.update).not.toHaveBeenCalled();
    });
  });

  test('accepts template body updates when placeholders are declared', async () => {
    const updateQuery = chain();
    setDbQueues({
      sms_templates: [
        chain({
          first: {
            id: 'sms-1',
            template_key: 'invoice_sent',
            category: 'billing',
            variables: JSON.stringify(['first_name', 'pay_url']),
          },
        }),
        updateQuery,
      ],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sms-templates/sms-1`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'Hello {first_name}, pay here: {pay_url}' }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
        body: 'Hello {first_name}, pay here: {pay_url}',
      }));
    });
  });

  test('rejects variant bodies with undeclared placeholders', async () => {
    const variantQuery = chain();
    setDbQueues({
      sms_templates: [
        chain({
          first: {
            id: 'sms-1',
            template_key: 'invoice_sent',
            variables: ['first_name', 'pay_url'],
          },
        }),
      ],
      sms_template_variants: [variantQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sms-templates/invoice_sent/variants`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          variantKey: 'short',
          body: 'Pay here: {bad_url}',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.unknown_placeholders).toEqual(['bad_url']);
      expect(variantQuery.insert).not.toHaveBeenCalled();
    });
  });

  test('creates SMS template variants with declared placeholders', async () => {
    const variant = {
      id: 'var-1',
      template_key: 'invoice_sent',
      variant_key: 'short',
      name: 'Short',
      body: 'Pay here: {pay_url}',
      weight: 2,
      status: 'active',
      is_control: true,
    };
    const variantQuery = chain({ result: [variant] });
    setDbQueues({
      sms_templates: [
        chain({
          first: {
            id: 'sms-1',
            template_key: 'invoice_sent',
            variables: ['first_name', 'pay_url'],
          },
        }),
      ],
      sms_template_variants: [variantQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sms-templates/invoice_sent/variants`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          variantKey: 'short',
          name: 'Short',
          body: 'Pay here: {pay_url}',
          weight: 2,
          isControl: true,
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.variant).toEqual(variant);
      expect(variantQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
        template_key: 'invoice_sent',
        variant_key: 'short',
        body: 'Pay here: {pay_url}',
        weight: 2,
        is_control: true,
      }));
      expect(variantQuery.merge).toHaveBeenCalledWith(expect.objectContaining({
        body: 'Pay here: {pay_url}',
        weight: 2,
        is_control: true,
      }));
    });
  });

  test('updates SMS template variants with declared placeholders', async () => {
    const updated = {
      id: 'var-1',
      template_key: 'invoice_sent',
      variant_key: 'short',
      body: 'Hello {first_name}, pay here: {pay_url}',
      weight: 3,
      status: 'paused',
    };
    const updateQuery = chain({ result: [updated] });
    setDbQueues({
      sms_templates: [
        chain({
          first: {
            id: 'sms-1',
            template_key: 'invoice_sent',
            variables: ['first_name', 'pay_url'],
          },
        }),
      ],
      sms_template_variants: [updateQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sms-templates/invoice_sent/variants/short`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          body: 'Hello {first_name}, pay here: {pay_url}',
          weight: 3,
          status: 'paused',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.variant).toEqual(updated);
      expect(updateQuery.where).toHaveBeenCalledWith({
        template_key: 'invoice_sent',
        variant_key: 'short',
      });
      expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
        body: 'Hello {first_name}, pay here: {pay_url}',
        weight: 3,
        status: 'paused',
      }));
    });
  });

  test('deletes SMS template variants', async () => {
    const deleteQuery = chain();
    setDbQueues({
      sms_template_variants: [deleteQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sms-templates/invoice_sent/variants/short`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(deleteQuery.where).toHaveBeenCalledWith({
        template_key: 'invoice_sent',
        variant_key: 'short',
      });
      expect(deleteQuery.del).toHaveBeenCalled();
    });
  });

  test('lists recent SMS template issues from audit log', async () => {
    const issue = {
      id: 'audit-1',
      metadata: {
        template_key: 'estimate_sent',
        event_type: 'inactive_template',
        reason: 'template inactive',
      },
      created_at: '2026-05-25T10:00:00.000Z',
    };
    const auditQuery = chain({ result: [issue] });
    setDbQueues({
      audit_log: [auditQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/sms-templates/issues?limit=5`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.issues).toEqual([issue]);
      expect(auditQuery.where).toHaveBeenCalledWith({
        action: 'notification_template.sms.render_issue',
      });
      expect(auditQuery.limit).toHaveBeenCalledWith(5);
      expect(auditQuery.select).toHaveBeenCalledWith('id', 'metadata', 'created_at');
    });
  });
});

describe('getTemplate inactive-row behavior', () => {
  const { auditNotificationTemplateIssue: auditSpy } = require('../services/audit-log');

  beforeEach(() => auditSpy.mockClear());

  test('inactive row skips SILENTLY — the pause switch is not a render defect', async () => {
    // The follow-up cron polls disabled stages every tick; auditing here
    // would flood the issues feed with deliberate kill-switch events.
    db.schema = { hasTable: jest.fn(async () => true) };
    setDbQueues({
      sms_templates: [chain({ first: { template_key: 'estimate_followup_questions', is_active: false, body: 'x' } })],
    });

    const body = await smsTemplatesRouter.getTemplate('estimate_followup_questions', {}, {});

    expect(body).toBe(null);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  test('missing row still audits (a real defect)', async () => {
    db.schema = { hasTable: jest.fn(async () => true) };
    setDbQueues({
      sms_templates: [chain({ first: undefined })],
    });

    const body = await smsTemplatesRouter.getTemplate('estimate_followup_questions', {}, {});

    expect(body).toBe(null);
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'missing_template' }));
  });
});
