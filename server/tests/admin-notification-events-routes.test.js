process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const notificationEventsRouter = require('../routes/admin-notification-events');

function chain(result = []) {
  const q = {};
  [
    'leftJoin',
    'select',
    'whereNotNull',
    'whereNull',
    'orderBy',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
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
  app.use('/admin/notification-events', notificationEventsRouter);
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

describe('admin notification event routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = {
      hasTable: jest.fn(async (table) => ['email_template_automations', 'sms_templates'].includes(table)),
      hasColumn: jest.fn(async (_table, column) => column === 'trigger_event_key'),
    };
  });

  test('groups catalog events with email automations and SMS templates', async () => {
    setDbQueues({
      'email_template_automations as a': [chain([
        {
          automation_key: 'estimate.delivery',
          template_key: 'estimate.delivery',
          trigger_event_key: 'estimate.sent',
          template_name: 'Estimate delivery',
          subject: 'Your estimate is ready',
          preview_text: 'Open your Waves estimate.',
          status: 'active',
          active_version_id: 'version-1',
          active_version_number: 1,
          version_status: 'active',
          audience: 'lead',
          frequency_cap: 'once_per_estimate',
          delay_minutes: 0,
        },
      ])],
      sms_templates: [
        chain([
          {
            id: 'sms-1',
            template_key: 'estimate_sent',
            name: 'Estimate Sent',
            body: 'Hi {first_name}',
            is_active: true,
            category: 'estimates',
            variables: ['first_name'],
            trigger_event_key: 'estimate.sent',
          },
        ]),
        chain([
          {
            id: 'sms-2',
            template_key: 'review_request',
            name: 'Review Request',
            body: 'Review us',
            is_active: true,
            category: 'reviews',
            variables: [],
            trigger_event_key: null,
          },
        ]),
      ],
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/notification-events`, {
        headers: { Authorization: 'Bearer tech' },
      });
      const body = await res.json();
      const estimateSent = body.events.find((event) => event.event_key === 'estimate.sent');
      const smsOnly = body.events.find((event) => event.event_key === '__sms_only__');

      expect(res.status).toBe(200);
      expect(estimateSent.status).toBe('paired');
      expect(estimateSent.email_automations).toHaveLength(1);
      expect(estimateSent.sms_templates).toHaveLength(1);
      expect(smsOnly.sms_templates).toHaveLength(1);
      expect(body.catalog.length).toBeGreaterThan(0);
    });
  });
});
