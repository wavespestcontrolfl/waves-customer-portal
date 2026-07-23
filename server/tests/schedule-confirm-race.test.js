process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })) }));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Customer' };
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');
const scheduleRouter = require('../routes/schedule');

function readChain(service) {
  const chain = {};
  chain.where = jest.fn(() => chain);
  chain.whereIn = jest.fn(() => chain);
  chain.forUpdate = jest.fn(() => chain);
  chain.first = jest.fn(async () => service);
  return chain;
}

function updateChain(updatedCount) {
  const chain = {};
  chain.where = jest.fn(() => chain);
  chain.update = jest.fn(async () => updatedCount);
  return chain;
}

function insertChain() {
  return { insert: jest.fn(async () => [1]) };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('customer appointment confirmation race guard', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns a conflict instead of overwriting a staff transition after the read', async () => {
    const update = updateChain(0);
    db.mockReturnValueOnce(readChain({ id: 'svc-1', status: 'pending', source_action: null }))
      .mockReturnValueOnce(update);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/schedule/svc-1/confirm`, { method: 'POST' });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'This appointment changed before it could be confirmed. Refresh to see the latest status.',
      });
    });

    expect(update.where).toHaveBeenCalledWith({ id: 'svc-1', customer_id: 'cust-1', status: 'pending' });
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('confirms when the observed customer-owned status is still current', async () => {
    db.mockReturnValueOnce(readChain({ id: 'svc-1', status: 'rescheduled', source_action: null }))
      .mockReturnValueOnce(updateChain(1));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/schedule/svc-1/confirm`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, message: 'Appointment confirmed' });
    });

    expect(logger.info).toHaveBeenCalledWith('Appointment confirmed by customer: svc-1');
  });
});

describe('customer appointment reschedule race guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.transaction = jest.fn(async (callback) => callback(db));
  });

  const service = {
    id: 'svc-1',
    customer_id: 'cust-1',
    status: 'confirmed',
    source_action: null,
    service_type: 'Pest Control',
    scheduled_date: '2026-07-20',
    notes: 'Gate code on file',
    updated_at: new Date('2026-07-15T14:00:00.000Z'),
  };

  test('locks before reading and appends to the latest staff notes', async () => {
    const lockedService = { ...service, notes: 'Staff updated gate code' };
    const read = readChain(lockedService);
    const update = updateChain(1);
    const requestInsert = insertChain();
    db.mockReturnValueOnce(read).mockReturnValueOnce(update).mockReturnValueOnce(requestInsert);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/schedule/svc-1/reschedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notes: 'Please move this visit' }),
      });
      expect(response.status).toBe(200);
    });

    expect(read.forUpdate).toHaveBeenCalledTimes(1);
    expect(update.where).toHaveBeenCalledWith({
      id: 'svc-1',
      customer_id: 'cust-1',
      status: 'confirmed',
    });
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
      notes: 'Staff updated gate code | RESCHEDULE REQUEST: Please move this visit',
    }));
    expect(requestInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'cust-1',
      category: 'schedule_change',
      source: 'customer_portal_reschedule',
      status: 'new',
    }));
  });

  test('persists the request atomically and alerts the scheduling team', async () => {
    db.mockReturnValueOnce(readChain(service)).mockReturnValueOnce(updateChain(1)).mockReturnValueOnce(insertChain());

    // The route rejects preferredDate before the start of the current ET day,
    // so a frozen date rots once the calendar passes it; 48h ahead in UTC is
    // always at least tomorrow in ET.
    const preferredDate = new Date(Date.now() + 48 * 3600 * 1000).toISOString().slice(0, 10);

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/schedule/svc-1/reschedule`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferredDate, notes: 'Afternoon please' }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).success).toBe(true);
    });

    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, options] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('schedule');
    expect(title).toContain('Pat Customer');
    expect(body).toContain('Afternoon please');
    expect(options.metadata.scheduledServiceId).toBe('svc-1');
  });
});
