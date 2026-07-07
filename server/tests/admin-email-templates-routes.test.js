process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin', email: 'owner@example.com', name: 'Owner' },
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
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => false),
  newsletterGroupId: jest.fn(() => null),
  serviceGroupId: jest.fn(() => null),
  unsubscribeUrl: jest.fn((token) => `https://example.com/unsubscribe/${token}`),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));

const express = require('express');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const emailTemplatesRouter = require('../routes/admin-email-templates');

function chain({
  result = [],
  first,
  returning,
  countFirst,
  columnInfo,
  updateResult = 1,
  deleteResult = 1,
} = {}) {
  const q = {};
  [
    'where',
    'whereIn',
    'whereRaw',
    'whereNull',
    'whereNotNull',
    'whereIn',
    'whereNotIn',
    'leftJoin',
    'join',
    'select',
    'orderBy',
    'groupBy',
    'limit',
    'max',
    'count',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.del = jest.fn(async () => deleteResult);
  q.first = jest.fn(async () => (countFirst !== undefined ? countFirst : first));
  q.returning = jest.fn(async () => returning || []);
  q.columnInfo = jest.fn(async () => columnInfo || {});
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  q.update.then = (resolve, reject) => Promise.resolve(updateResult).then(resolve, reject);
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
  return tableQueues;
}

function setTransactionQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  const trx = jest.fn((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) {
      throw new Error(`Unexpected trx table ${table}`);
    }
    return queue.shift();
  });
  db.transaction = jest.fn(async (fn) => fn(trx));
  return trx;
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/email-templates', emailTemplatesRouter);
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

function authHeaders(extra = {}) {
  return {
    Authorization: 'Bearer admin',
    ...extra,
  };
}

describe('admin email template routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockReturnValue(true);
    db.schema = { hasTable: jest.fn() };
    db.raw = jest.fn((sql) => sql);
    db.transaction = jest.fn();
  });

  test('requires an admin user before route handlers run', async () => {
    await withServer(async (baseUrl) => {
      const unauthenticated = await fetch(`${baseUrl}/admin/email-templates`);
      expect(unauthenticated.status).toBe(401);
      expect(await unauthenticated.json()).toEqual({ error: 'Admin authentication required' });

      const technician = await fetch(`${baseUrl}/admin/email-templates`, {
        headers: { Authorization: 'Bearer tech' },
      });
      expect(technician.status).toBe(403);
      expect(await technician.json()).toEqual({ error: 'Admin access required' });
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('returns recent email template render issues', async () => {
    const auditQuery = chain({
      result: [{
        id: 'audit-1',
        created_at: '2026-05-25T12:00:00.000Z',
        metadata: {
          template_key: 'estimate.expiring_notice',
          event_type: 'missing_payload',
          workflow: 'estimate.expiring_notice:est-1',
          entity_type: 'estimate',
          entity_id: '11111111-1111-1111-1111-111111111111',
          reason: 'Missing required variables: expires_at',
          unresolved_placeholders: ['expires_at'],
        },
      }],
    });
    setDbQueues({
      audit_log: [auditQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/issues?limit=10`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(auditQuery.limit).toHaveBeenCalledWith(10);
      expect(await res.json()).toEqual({
        issues: [{
          id: 'audit-1',
          created_at: '2026-05-25T12:00:00.000Z',
          template_key: 'estimate.expiring_notice',
          event_type: 'missing_payload',
          workflow: 'estimate.expiring_notice:est-1',
          entity_type: 'estimate',
          entity_id: '11111111-1111-1111-1111-111111111111',
          reason: 'Missing required variables: expires_at',
          unresolved_placeholders: ['expires_at'],
        }],
      });
    });
  });

  test('clamps email template issue limit to a positive integer', async () => {
    const auditQuery = chain({ result: [] });
    db.mockImplementation(() => auditQuery);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/issues?limit=-5`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(auditQuery.limit).toHaveBeenCalledWith(1);
    });
  });

  test('updates template settings and normalizes variable contracts', async () => {
    const existing = {
      id: 'template-1',
      template_key: 'estimate.expiring_notice',
      name: 'Old name',
      mode: 'service',
      purpose: 'estimate',
      legal_classification: 'transactional_relationship',
      audience: 'customer',
      message_priority: 'normal',
      content_sensitivity: 'normal',
      send_stream: 'service_operational',
      suppression_group_key: 'service_operational',
      layout_wrapper_id: 'service_default_v1',
      from_name: 'Waves Pest Control',
      from_email: 'contact@wavespestcontrol.com',
      reply_to: 'contact@wavespestcontrol.com',
      allowed_variables: '[]',
      required_variables: '[]',
      optional_variables: '[]',
      status: 'draft',
    };
    const loadQuery = chain({ first: existing });
    const updateQuery = chain();
    const updatedQuery = chain({
      first: {
        ...existing,
        name: 'Estimate Expiring Notice',
        allowed_variables: '["first_name","estimate_url"]',
      },
    });
    setDbQueues({
      email_templates: [loadQuery, updateQuery, updatedQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/estimate.expiring_notice`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: 'Estimate Expiring Notice',
          mode: 'service',
          sendStream: 'service_operational',
          defaultCtaLabel: 'View estimate',
          defaultCtaUrlVariable: 'estimate_url',
          allowedVariables: 'first_name, estimate_url',
          requiredVariables: ['first_name'],
          optionalVariables: '["estimate_url"]',
          fromEmail: 'Service@Example.COM',
          suppressionGroupKey: null,
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.template.name).toBe('Estimate Expiring Notice');
      expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Estimate Expiring Notice',
        from_email: 'service@example.com',
        default_cta_label: 'View estimate',
        default_cta_url_variable: 'estimate_url',
        suppression_group_key: null,
        allowed_variables: '["first_name","estimate_url"]',
        required_variables: '["first_name"]',
        optional_variables: '["estimate_url"]',
      }));
    });
  });

  test('rejects invalid template settings before writing', async () => {
    const loadQuery = chain({
      first: {
        id: 'template-1',
        template_key: 'bad.settings',
        name: 'Bad settings',
        mode: 'service',
        send_stream: 'service_operational',
      },
    });
    setDbQueues({ email_templates: [loadQuery] });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/bad.settings`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ sendStream: 'raw_provider_stream' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/sendStream must be one of/);
      expect(db).toHaveBeenCalledTimes(1);
    });
  });

  test('rejects invalid template keys on create', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ templateKey: '../bad', name: 'Bad template' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/templateKey must be a stable key/);
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('reads a template detail payload with versions and fixtures', async () => {
    const template = { id: 'template-1', template_key: 'estimate.expiring_notice', name: 'Estimate expiring' };
    const versions = [{ id: 'version-1', template_id: 'template-1', status: 'active' }];
    const fixtures = [{ id: 'fixture-1', template_id: 'template-1', name: 'Default', is_default: true }];
    setDbQueues({
      email_templates: [chain({ first: template })],
      email_template_versions: [chain({ result: versions })],
      email_template_fixtures: [chain({ result: fixtures })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/estimate.expiring_notice`, {
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ template, versions, fixtures });
    });
  });

  test('creates a default fixture and clears the previous default in one transaction', async () => {
    const template = { id: 'template-1', template_key: 'estimate.expiring_notice' };
    const clearDefaultQuery = chain();
    const insertQuery = chain({
      returning: [{ id: 'fixture-1', template_id: 'template-1', name: 'Happy path', is_default: true }],
    });
    setDbQueues({
      email_templates: [chain({ first: template })],
    });
    setTransactionQueues({
      email_template_fixtures: [clearDefaultQuery, insertQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/estimate.expiring_notice/fixtures`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: 'Happy path',
          isDefault: true,
          payload: { first_name: 'Sam', estimate_url: 'https://example.com/estimate' },
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.fixture.id).toBe('fixture-1');
      expect(clearDefaultQuery.where).toHaveBeenCalledWith({ template_id: 'template-1' });
      expect(clearDefaultQuery.update).toHaveBeenCalledWith(expect.objectContaining({ is_default: false }));
      expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
        template_id: 'template-1',
        name: 'Happy path',
        is_default: true,
        payload: JSON.stringify({ first_name: 'Sam', estimate_url: 'https://example.com/estimate' }),
      }));
    });
  });

  test('updates fixture payloads and default state', async () => {
    const existing = {
      id: 'fixture-1',
      template_id: 'template-1',
      template_key: 'estimate.expiring_notice',
      name: 'Old fixture',
      is_default: false,
    };
    const clearDefaultQuery = chain();
    const updateFixtureQuery = chain({
      returning: [{ ...existing, name: 'Updated fixture', is_default: true }],
    });
    setDbQueues({
      'email_template_fixtures as f': [chain({ first: existing })],
    });
    setTransactionQueues({
      email_template_fixtures: [clearDefaultQuery, updateFixtureQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/fixtures/fixture-1`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: 'Updated fixture',
          isDefault: true,
          payload: { first_name: 'Lee' },
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.fixture.name).toBe('Updated fixture');
      expect(clearDefaultQuery.where).toHaveBeenCalledWith({ template_id: 'template-1' });
      expect(updateFixtureQuery.where).toHaveBeenCalledWith({ id: 'fixture-1' });
      expect(updateFixtureQuery.update).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Updated fixture',
        is_default: true,
        payload: JSON.stringify({ first_name: 'Lee' }),
      }));
    });
  });

  test('rejects fixture payloads that are not JSON objects', async () => {
    setDbQueues({
      email_templates: [chain({ first: { id: 'template-1', template_key: 'estimate.expiring_notice' } })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/estimate.expiring_notice/fixtures`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: 'Bad payload', payload: ['not', 'an', 'object'] }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('payload must be a JSON object');
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  test('deletes a default fixture and promotes the oldest fallback', async () => {
    const existing = {
      id: 'fixture-1',
      template_id: 'template-1',
      template_key: 'estimate.expiring_notice',
      is_default: true,
    };
    const deleteQuery = chain();
    const fallbackQuery = chain({ first: { id: 'fixture-2', template_id: 'template-1' } });
    const promoteQuery = chain();
    setDbQueues({
      'email_template_fixtures as f': [chain({ first: existing })],
    });
    setTransactionQueues({
      email_template_fixtures: [deleteQuery, fallbackQuery, promoteQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/fixtures/fixture-1`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ deleted: true });
      expect(deleteQuery.where).toHaveBeenCalledWith({ id: 'fixture-1' });
      expect(deleteQuery.del).toHaveBeenCalled();
      expect(fallbackQuery.where).toHaveBeenCalledWith({ template_id: 'template-1' });
      expect(promoteQuery.where).toHaveBeenCalledWith({ id: 'fixture-2' });
      expect(promoteQuery.update).toHaveBeenCalledWith(expect.objectContaining({ is_default: true }));
    });
  });

  test('deletes an email automation by key', async () => {
    const existing = {
      id: 'automation-1',
      automation_key: 'custom.cleanup',
      status: 'draft',
    };
    const skipRunsQuery = chain({ result: 2 });
    const deleteQuery = chain();
    setTransactionQueues({
      email_template_automations: [chain({ first: existing }), deleteQuery],
      email_template_automation_runs: [skipRunsQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/automations/custom.cleanup`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ deleted: true, skipped_runs: 2 });
      expect(skipRunsQuery.where).toHaveBeenCalledWith({ automation_id: 'automation-1' });
      expect(skipRunsQuery.whereIn).toHaveBeenCalledWith('status', ['queued', 'scheduled', 'retry_scheduled']);
      expect(skipRunsQuery.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'skipped',
        exit_reason: 'automation deleted by admin',
      }));
      expect(deleteQuery.where).toHaveBeenCalledWith({ id: 'automation-1' });
      expect(deleteQuery.del).toHaveBeenCalled();
    });
  });

  test('protects operational email automations from hard delete', async () => {
    const existing = {
      id: 'automation-1',
      automation_key: 'invoice.sent',
      status: 'active',
    };
    setTransactionQueues({
      email_template_automations: [chain({ first: existing })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/automations/invoice.sent`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({ error: 'automation is protected from hard delete' });
    });
  });

  test('requires email automations to be draft or archived before hard delete', async () => {
    const existing = {
      id: 'automation-1',
      automation_key: 'custom.active',
      status: 'active',
    };
    setTransactionQueues({
      email_template_automations: [chain({ first: existing })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/automations/custom.active`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({ error: 'automation must be draft or archived before hard delete' });
    });
  });

  test('protects operational email templates from hard delete', async () => {
    setDbQueues({
      email_templates: [chain({
        first: {
          id: 'template-1',
          template_key: 'estimate.delivery',
          status: 'active',
        },
      })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/estimate.delivery`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({ error: 'template is protected from hard delete' });
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  test('requires email templates to be draft or archived before hard delete', async () => {
    setDbQueues({
      email_templates: [chain({
        first: {
          id: 'template-1',
          template_key: 'custom.active',
          status: 'active',
        },
      })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/custom.active`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({ error: 'template must be draft or archived before hard delete' });
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  test('guards email template delete when automations still reference it', async () => {
    setDbQueues({
      email_templates: [chain({ first: { id: 'template-1', template_key: 'custom.orphan', status: 'draft' } })],
      email_template_automations: [chain({
        result: [
          { automation_key: 'custom.orphan' },
          { automation_key: 'custom.orphan.followup' },
        ],
      })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/custom.orphan`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual({
        error: 'template is referenced by automations',
        automations: ['custom.orphan', 'custom.orphan.followup'],
      });
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  test('deletes an unreferenced email template inside a transaction', async () => {
    const deleteQuery = chain();
    setDbQueues({
      email_templates: [chain({ first: { id: 'template-1', template_key: 'orphan.template', status: 'draft' } })],
      email_template_automations: [chain({ result: [] })],
    });
    setTransactionQueues({
      email_templates: [deleteQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/orphan.template`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ deleted: true });
      expect(deleteQuery.where).toHaveBeenCalledWith({ id: 'template-1' });
      expect(deleteQuery.del).toHaveBeenCalled();
    });
  });

  test('updates automations with validated template and suppression group references', async () => {
    const existing = {
      id: 'automation-1',
      automation_key: 'estimate.extension_notice',
      name: 'Extension notice',
      trigger_event_key: 'estimate.extended',
      template_key: 'estimate.extension_notice',
      audience: 'customer',
      status: 'draft',
      legal_classification: 'transactional_relationship',
      delay_minutes: 0,
      suppression_group_key: 'service_operational',
      conditions: '{}',
      exit_conditions: '{}',
      retry_policy: '{}',
      quiet_hours: '{}',
      timezone: 'America/New_York',
      owner: 'operations',
    };
    const updateQuery = chain({
      returning: [{ ...existing, status: 'active', delay_minutes: 30 }],
    });
    setDbQueues({
      email_template_automations: [chain({ first: existing }), updateQuery],
      email_templates: [chain({ first: { id: 'template-1', template_key: 'estimate.extension_notice' } })],
      email_preference_groups: [chain({ first: { key: 'service_operational' } })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/automations/estimate.extension_notice`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          status: 'active',
          delayMinutes: 30,
          templateKey: 'estimate.extension_notice',
          suppressionGroupKey: 'service_operational',
          conditions: { estimate_status: ['sent', 'viewed'] },
          exitConditions: { status: ['accepted', 'expired'] },
          retryPolicy: { max_attempts: 3, backoff_minutes: [15, 60, 240] },
          quietHours: { enabled: true, start: '20:00', end: '08:00' },
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.automation.status).toBe('active');
      expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'active',
        delay_minutes: 30,
        last_published_by: 'admin-1',
        conditions: JSON.stringify({ estimate_status: ['sent', 'viewed'] }),
        exit_conditions: JSON.stringify({ status: ['accepted', 'expired'] }),
        retry_policy: JSON.stringify({ max_attempts: 3, backoff_minutes: [15, 60, 240] }),
        quiet_hours: JSON.stringify({ enabled: true, start: '20:00', end: '08:00' }),
      }));
    });
  });

  test('rejects invalid automation status values', async () => {
    setDbQueues({
      email_template_automations: [chain({
        first: {
          id: 'automation-1',
          automation_key: 'estimate.extension_notice',
          name: 'Extension notice',
          template_key: 'estimate.extension_notice',
          audience: 'customer',
          status: 'draft',
          legal_classification: 'transactional_relationship',
        },
      })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/automations/estimate.extension_notice`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status: 'enabled-ish' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toMatch(/status must be one of/);
      expect(db).toHaveBeenCalledTimes(1);
    });
  });

  test('rejects malformed automation guard JSON instead of clearing it', async () => {
    setDbQueues({
      email_template_automations: [chain({
        first: {
          id: 'automation-1',
          automation_key: 'estimate.extension_notice',
          name: 'Extension notice',
          template_key: 'estimate.extension_notice',
          audience: 'customer',
          status: 'draft',
          legal_classification: 'transactional_relationship',
          conditions: JSON.stringify({ renewal_count_gt: 0 }),
        },
      })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/automations/estimate.extension_notice`, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ conditions: '{not valid json' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('conditions must be a JSON object');
      expect(db).toHaveBeenCalledTimes(1);
    });
  });

  test('dry-runs estimate automations against source tables when available', async () => {
    const countQuery = chain({ countFirst: { count: '7' } });
    db.schema.hasTable.mockResolvedValue(true);
    setDbQueues({
      email_template_automations: [chain({
        first: {
          automation_key: 'estimate.extension_notice',
          template_key: 'estimate.extension_notice',
          dry_run_notes: 'Estimate extensions in the last window.',
        },
      })],
      estimates: [
        chain({ columnInfo: { created_at: {}, status: {}, renewal_count: {} } }),
        countQuery,
      ],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/automations/estimate.extension_notice/dry-run`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.dryRun).toEqual(expect.objectContaining({
        source: 'estimates',
        candidate_count: 7,
        window_days: 30,
      }));
      expect(db.schema.hasTable).toHaveBeenCalledWith('estimates');
      expect(countQuery.whereNotIn).toHaveBeenCalledWith('status', ['accepted', 'expired', 'archived', 'declined', 'cancelled']);
      expect(countQuery.where).toHaveBeenCalledWith('renewal_count', '>', 0);
    });
  });

  test('processes due automation execution runs from the admin endpoint', async () => {
    const dueRunsQuery = chain({ result: [] });
    setDbQueues({
      email_template_automation_runs: [dueRunsQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/automations/runs/process-due`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ limit: 10 }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ processed: 0, results: [] });
      expect(dueRunsQuery.whereIn).toHaveBeenCalledWith('status', ['queued', 'scheduled', 'retry_scheduled', 'running']);
      expect(dueRunsQuery.limit).toHaveBeenCalledWith(10);
    });
  });

  test('blocks admin automation execution endpoints when the send gate is disabled', async () => {
    isEnabled.mockReturnValue(false);

    await withServer(async (baseUrl) => {
      const triggerRes = await fetch(`${baseUrl}/admin/email-templates/automations/trigger`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          triggerEventKey: 'estimate.auto_renewed',
          payload: { estimate_id: 'est-1' },
        }),
      });
      expect(triggerRes.status).toBe(403);
      expect(await triggerRes.json()).toEqual({ error: 'Email template automations are disabled' });

      const processRes = await fetch(`${baseUrl}/admin/email-templates/automations/runs/process-due`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ limit: 10 }),
      });
      expect(processRes.status).toBe(403);
      expect(await processRes.json()).toEqual({ error: 'Email template automations are disabled' });
    });

    expect(db).not.toHaveBeenCalled();
  });

  test('lists automation execution run history for an automation', async () => {
    const runs = [{ id: 'run-1', automation_key: 'estimate.extension_notice', status: 'sent' }];
    const runsQuery = chain({ result: runs });
    setDbQueues({
      email_template_automation_runs: [runsQuery],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/automations/estimate.extension_notice/runs?limit=25`, {
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ runs });
      expect(runsQuery.where).toHaveBeenCalledWith({ automation_key: 'estimate.extension_notice' });
      expect(runsQuery.limit).toHaveBeenCalledWith(25);
    });
  });

  test('enriches suppressions with the matching customer and blocked-send tallies', async () => {
    const suppressionRows = [
      {
        id: 'sup-1',
        email: 'Bad@Example.com',
        group_key: null,
        suppression_type: 'bounce',
        status: 'active',
        suppressed_at: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'sup-2',
        email: 'orphan@example.com',
        group_key: null,
        suppression_type: 'bounce',
        status: 'active',
        suppressed_at: '2026-07-02T00:00:00.000Z',
      },
    ];
    const customerRows = [
      {
        id: 'cust-1',
        first_name: 'Pat',
        last_name: 'Jones',
        phone: '+19415550100',
        pipeline_stage: 'active_customer',
        email: 'bad@example.com',
        service_contact_email: null,
        service_contact2_email: null,
        service_contact3_email: null,
      },
    ];
    const blockedRows = [
      { email_lc: 'bad@example.com', blocked_count: '3', last_blocked_at: '2026-07-06T14:00:00.000Z' },
    ];
    const customersQuery = chain({ result: customerRows });
    setDbQueues({
      'email_suppressions as s': [chain({ result: suppressionRows })],
      customers: [customersQuery],
      'notification_prefs as np': [chain({ result: [] })],
      email_messages: [chain({ result: blockedRows })],
      email_suppressions: [chain({ result: [{ group_key: null, suppression_type: 'bounce', count: '2' }] })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/suppressions`, {
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.suppressions).toHaveLength(2);
      const [matched, orphan] = body.suppressions;
      expect(matched.customer).toEqual({
        id: 'cust-1',
        first_name: 'Pat',
        last_name: 'Jones',
        phone: '+19415550100',
        pipeline_stage: 'active_customer',
        matched_field: 'email',
      });
      expect(matched.blocked_count).toBe(3);
      expect(matched.last_blocked_at).toBe('2026-07-06T14:00:00.000Z');
      expect(orphan.customer).toBeNull();
      expect(orphan.blocked_count).toBe(0);
      expect(orphan.last_blocked_at).toBeNull();
      expect(body.stats).toEqual([{ group_key: null, suppression_type: 'bounce', count: 2 }]);
      expect(customersQuery.whereNull).toHaveBeenCalledWith('deleted_at');
    });
  });

  test('falls back to notification_prefs.billing_email when no customers column matches', async () => {
    const suppressionRows = [
      {
        id: 'sup-1',
        email: 'Billing@Example.com',
        group_key: null,
        suppression_type: 'bounce',
        status: 'active',
        suppressed_at: '2026-07-01T00:00:00.000Z',
      },
    ];
    const billingRows = [
      {
        id: 'cust-2',
        first_name: 'Robin',
        last_name: 'Vale',
        phone: '+19415550111',
        pipeline_stage: 'active_customer',
        billing_email_lc: 'billing@example.com',
      },
    ];
    const billingQuery = chain({ result: billingRows });
    setDbQueues({
      'email_suppressions as s': [chain({ result: suppressionRows })],
      customers: [chain({ result: [] })],
      'notification_prefs as np': [billingQuery],
      email_messages: [chain({ result: [] })],
      email_suppressions: [chain({ result: [] })],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/email-templates/suppressions`, {
        headers: authHeaders(),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.suppressions).toHaveLength(1);
      expect(body.suppressions[0].customer).toEqual({
        id: 'cust-2',
        first_name: 'Robin',
        last_name: 'Vale',
        phone: '+19415550111',
        pipeline_stage: 'active_customer',
        matched_field: 'billing_email',
      });
      expect(billingQuery.join).toHaveBeenCalledWith('customers as c', 'c.id', 'np.customer_id');
      expect(billingQuery.whereNull).toHaveBeenCalledWith('c.deleted_at');
    });
  });
});
