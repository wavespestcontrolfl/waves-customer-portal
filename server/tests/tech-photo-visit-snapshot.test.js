process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockTables = {};

function rowsFor(table, where) {
  return (mockTables[table] || []).filter((row) => !where
    || Object.entries(where).every(([key, value]) => row[key] === value));
}

function mockChain(table) {
  const state = { where: null };
  const chain = {
    where: jest.fn((where) => { state.where = where; return chain; }),
    orderBy: jest.fn(() => chain),
    first: jest.fn(async (...columns) => {
      const row = rowsFor(table, state.where)[0] || null;
      if (!row || !columns.length) return row;
      return Object.fromEntries(columns.flat().map((column) => [column, row[column]]));
    }),
    then: (resolve, reject) => Promise.resolve(rowsFor(table, state.where)).then(resolve, reject),
  };
  return chain;
}

jest.mock('../models/db', () => jest.fn((table) => mockChain(table)));
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  s3: { bucket: 'photo-route-test', region: 'us-east-1' },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/pdf-queue', () => ({ enqueuePdfRenderJob: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ createAlertOnce: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => {
  class Command { constructor(input) { this.input = input; } }
  class S3Client { async send() { return {}; } }
  return {
    S3Client,
    PutObjectCommand: Command,
    DeleteObjectCommand: Command,
    GetObjectCommand: Command,
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn(async () => 'https://example.invalid/photo') }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/service-photos', () => {
  const actual = jest.requireActual('../services/service-photos');
  return {
    ...actual,
    uploadServicePhotoForVisit: jest.fn(async (input) => {
      const live = mockTables.scheduled_services.find((row) => row.id === input.scheduledServiceId);
      const expected = actual.parseExpectedServicePhotoVisit(input.expectedVisit);
      if (actual.servicePhotoVisitChanged(expected, live)) {
        throw Object.assign(new Error('Visit changed'), {
          statusCode: 409, code: 'visit_identity_changed', isOperational: true,
        });
      }
      return {
        photo: { id: 'photo-1', s3_key: 'staged/photo-1.jpg' },
        staged: true,
        reconcileRequired: false,
        serviceRecordId: null,
        visit: actual.servicePhotoVisitSnapshot(live),
      };
    }),
  };
});

const express = require('express');
const router = require('../routes/tech-track');

async function withServer(fn) {
  const app = express();
  app.use('/api/tech/services', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('tech photo visit snapshot route contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTables.scheduled_services = [{
      id: 'visit-1',
      customer_id: 'customer-1',
      property_id: 'property-1',
      technician_id: 'tech-1',
      scheduled_date: '2026-10-02',
      status: 'on_site',
    }];
    mockTables.service_records = [];
    mockTables.scheduled_service_photo_staging = [];
  });

  test('a non-null property snapshot from GET is accepted unchanged by POST', async () => {
    await withServer(async (baseUrl) => {
      const read = await fetch(`${baseUrl}/api/tech/services/visit-1/photos`, {
        headers: { Authorization: 'Bearer admin' },
      });
      expect(read.status).toBe(200);
      const snapshot = (await read.json()).visit;
      expect(snapshot).toMatchObject({
        customerId: 'customer-1',
        propertyId: 'property-1',
        technicianId: 'tech-1',
        scheduledDate: '2026-10-02',
        status: 'on_site',
      });

      const form = new FormData();
      form.append('photo', new Blob(['route-photo'], { type: 'image/jpeg' }), 'route.jpg');
      form.append('photoType', 'after');
      form.append('expectedVisit', JSON.stringify(snapshot));
      const write = await fetch(`${baseUrl}/api/tech/services/visit-1/photos`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
        body: form,
      });
      expect(write.status).toBe(200);
      expect(await write.json()).toMatchObject({
        photo: { id: 'photo-1', staged: true },
        reconcileRequired: false,
        visit: { propertyId: 'property-1', revision: snapshot.revision },
      });
    });
  });
});
