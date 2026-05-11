process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockS3Send = jest.fn();

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});
jest.mock('../config', () => ({
  jwt: { secret: 'test-jwt-secret' },
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const roles = {
      admin: { id: 'admin-1', role: 'admin' },
      'tech-1': { id: 'tech-1', role: 'technician' },
      'tech-2': { id: 'tech-2', role: 'technician' },
    };
    const tech = roles[token];
    if (!tech) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = tech;
    req.technicianId = tech.id;
    req.techRole = tech.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/photo.jpg'),
}));

const express = require('express');
const db = require('../models/db');
const projectsRouter = require('../routes/admin-projects');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    orderByRaw: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    del: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/projects', projectsRouter);
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

describe('admin projects routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.fn.now.mockReturnValue('NOW');
    mockS3Send.mockResolvedValue({});
  });

  test('technician cannot read another technician project detail', async () => {
    const projectQuery = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        created_by_tech_id: 'tech-1',
        customer_id: 'customer-1',
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'projects as p') return projectQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1`, {
        headers: { Authorization: 'Bearer tech-2' },
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Project access denied');
    });
  });

  test('technician cannot read another technician project activity', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        created_by_tech_id: 'tech-1',
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/activity`, {
        headers: { Authorization: 'Bearer tech-2' },
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Project access denied');
    });
  });

  test('admin can read project activity history', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        created_by_tech_id: 'tech-1',
      }),
    });
    const activityRows = [
      {
        id: 'activity-1',
        action: 'project_report_sent',
        description: 'Project report sent: Pest Inspection',
        metadata: { project_id: 'project-1' },
        created_at: '2026-05-06T12:00:00.000Z',
        admin_user_id: 'admin-1',
        actor_name: 'Admin User',
      },
    ];
    const activityRead = chain({
      limit: jest.fn().mockResolvedValue(activityRows),
    });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'activity_log as a') return activityRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/activity`, {
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.activity).toEqual(activityRows);
      expect(activityRead.whereRaw).toHaveBeenCalledWith("a.metadata->>'project_id' = ?", ['project-1']);
      expect(activityRead.limit).toHaveBeenCalledWith(100);
    });
  });

  test('technician can update project linked to assigned service record', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        created_by_tech_id: 'admin-1',
        service_record_id: 'service-1',
      }),
    });
    const serviceRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'service-1' }),
    });
    const projectUpdate = chain();
    const projectUpdated = chain({
      first: jest.fn().mockResolvedValue({ id: 'project-1', title: 'Updated title' }),
    });
    const projectQueries = [projectRead, projectUpdate, projectUpdated];
    db.mockImplementation((table) => {
      if (table === 'projects') return projectQueries.shift();
      if (table === 'service_records') return serviceRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer tech-2', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated title' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.project.title).toBe('Updated title');
      expect(projectUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ title: 'Updated title' }));
    });
  });

  test('invalid image content is rejected on upload', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'project-1', customer_id: 'customer-1', created_by_tech_id: 'tech-1' }),
    });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const fd = new FormData();
      fd.append('photo', new Blob(['<svg></svg>'], { type: 'image/png' }), 'bad.png');
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech-1' },
        body: fd,
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/not a supported image/);
    });
  });

  test('project create writes customer activity', async () => {
    const createdProject = {
      id: 'project-1',
      customer_id: 'customer-1',
      project_type: 'pest_inspection',
      status: 'draft',
      created_by_tech_id: 'admin-1',
    };
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'customer-1' }),
    });
    const projectInsert = chain({
      returning: jest.fn().mockResolvedValue([createdProject]),
    });
    const activityInsert = chain();
    db.mockImplementation((table) => {
      if (table === 'customers') return customerRead;
      if (table === 'projects') return projectInsert;
      if (table === 'activity_log') return activityInsert;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: 'customer-1', project_type: 'pest_inspection' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.project.id).toBe('project-1');
      expect(activityInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        admin_user_id: 'admin-1',
        customer_id: 'customer-1',
        action: 'project_created',
        metadata: expect.objectContaining({ project_id: 'project-1', project_type: 'pest_inspection' }),
      }));
    });
  });

  test('technician cannot create an ad hoc project without an assigned visit link', async () => {
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'customer-1' }),
    });
    db.mockImplementation((table) => {
      if (table === 'customers') return customerRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: 'customer-1', project_type: 'pest_inspection' }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toMatch(/assigned visit/);
    });
  });

  test('project create rejects service links for a different customer', async () => {
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'customer-1' }),
    });
    const serviceRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'service-1', customer_id: 'customer-2', technician_id: 'tech-1' }),
    });
    db.mockImplementation((table) => {
      if (table === 'customers') return customerRead;
      if (table === 'service_records') return serviceRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: 'customer-1',
          project_type: 'pest_inspection',
          service_record_id: 'service-1',
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/does not belong/);
    });
  });

  test('send persists channel delivery results for later admin reloads', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        project_type: 'pest_inspection',
        project_date: '2026-05-06',
        title: 'Inspection report',
        findings: { areas_inspected: 'Kitchen' },
        recommendations: 'Treat the documented pest activity and follow up if activity continues.',
        report_token: null,
        sent_at: null,
      }),
    });
    const markSent = chain();
    const updatedProjectRead = chain({
      first: jest.fn().mockImplementation(() => ({
        id: 'project-1',
        customer_id: 'customer-1',
        project_type: 'pest_inspection',
        project_date: '2026-05-06',
        title: 'Inspection report',
        findings: { areas_inspected: 'Kitchen' },
        recommendations: 'Treat the documented pest activity and follow up if activity continues.',
        report_token: String(markSent.update.mock.calls[0][0].report_token),
        sent_at: 'NOW',
      })),
    });
    const sequenceRead = chain();
    const persistDelivery = chain();
    const photoCount = chain({
      first: jest.fn().mockResolvedValue({ count: '1' }),
    });
    const activityInsert = chain();
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'customer-1',
        first_name: 'Van',
        last_name: 'Lee',
        phone: null,
        email: null,
      }),
    });
    const projectQueries = [projectRead, markSent, updatedProjectRead, sequenceRead, persistDelivery];
    db.mockImplementation((table) => {
      if (table === 'projects') return projectQueries.shift();
      if (table === 'customers') return customerRead;
      if (table === 'project_photos') return photoCount;
      if (table === 'activity_log') return activityInsert;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.report_url).toMatch(/^\/report\/project\/van-lee-[a-f0-9]{12}$/);
      expect(body.channels.sms).toEqual({ ok: false, error: 'No phone on file' });
      expect(body.channels.email).toEqual({ ok: false, error: 'No email on file' });
      expect(body.sent).toBe(false);
      expect(body.delivery_status).toBe('failed');
      expect(persistDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
        delivery_channels: body.channels,
        delivery_status: 'failed',
        last_delivery_at: 'NOW',
      }));
      expect(persistDelivery.update.mock.calls[0][0]).not.toHaveProperty('status', 'sent');
      expect(activityInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        admin_user_id: 'admin-1',
        customer_id: 'customer-1',
        action: 'project_report_delivery_failed',
        metadata: expect.objectContaining({ project_id: 'project-1', channels: body.channels, delivery_status: 'failed' }),
      }));
    });
  });

  test('send blocks incomplete reports unless an override reason is supplied', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        project_type: 'wdo_inspection',
        project_date: null,
        findings: { wdo_finding: 'No visible signs of WDO observed' },
        recommendations: null,
        report_token: null,
        sent_at: null,
      }),
    });
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'customer-1', first_name: 'Van', last_name: 'Lee' }),
    });
    const photoCount = chain({
      first: jest.fn().mockResolvedValue({ count: '0' }),
    });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'customers') return customerRead;
      if (table === 'project_photos') return photoCount;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.error).toMatch(/missing required details/);
      expect(body.missing.map(item => item.key)).toEqual(expect.arrayContaining([
        'project_date',
        'recommendations',
        'photos',
        'wdo_property_address',
        'wdo_inspection_scope',
      ]));
      expect(projectRead.update).not.toHaveBeenCalled();
    });
  });

  test('photo delete does not drop database row when storage delete fails', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'project-1', created_by_tech_id: 'tech-1' }),
    });
    const photoRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'photo-1',
        project_id: 'project-1',
        s3_key: 'project-photos/project-1/photo.jpg',
      }),
    });
    const photoDelete = chain();
    const storageError = new Error('S3 timeout');
    mockS3Send.mockRejectedValue(storageError);

    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'project_photos') return table === 'project_photos' && photoRead.first.mock.calls.length === 0
        ? photoRead
        : photoDelete;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos/photo-1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer tech-1' },
      });
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body.error).toMatch(/storage/);
      expect(photoDelete.del).not.toHaveBeenCalled();
    });
  });

  test('photo delete removes database row when storage object is already missing', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'project-1', customer_id: 'customer-1', created_by_tech_id: 'tech-1' }),
    });
    const photoRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'photo-1',
        project_id: 'project-1',
        s3_key: 'project-photos/project-1/missing.jpg',
      }),
    });
    const photoDelete = chain();
    const activityInsert = chain();
    const missingError = new Error('No such key');
    missingError.name = 'NoSuchKey';
    mockS3Send.mockRejectedValue(missingError);

    const photoQueries = [photoRead, photoDelete];
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'project_photos') return photoQueries.shift();
      if (table === 'activity_log') return activityInsert;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/photos/photo-1`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer tech-1' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(photoDelete.del).toHaveBeenCalledTimes(1);
      expect(activityInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        admin_user_id: 'tech-1',
        action: 'project_photo_deleted',
        metadata: expect.objectContaining({ photo_id: 'photo-1' }),
      }));
    });
  });
});
