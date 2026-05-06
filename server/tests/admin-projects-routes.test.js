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
    whereIn: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
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
      first: jest.fn().mockResolvedValue({ id: 'project-1', created_by_tech_id: 'tech-1' }),
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

  test('send persists channel delivery results for later admin reloads', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        project_type: 'pest_inspection',
        report_token: null,
        sent_at: null,
      }),
    });
    const markSent = chain();
    const persistDelivery = chain();
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'customer-1',
        first_name: 'Van',
        last_name: 'Lee',
        phone: null,
        email: null,
      }),
    });
    const projectQueries = [projectRead, markSent, persistDelivery];
    db.mockImplementation((table) => {
      if (table === 'projects') return projectQueries.shift();
      if (table === 'customers') return customerRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.channels.sms).toEqual({ ok: false, error: 'No phone on file' });
      expect(body.channels.email).toEqual({ ok: false, error: 'No email on file' });
      expect(persistDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
        delivery_channels: body.channels,
        last_delivery_at: 'NOW',
      }));
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
      first: jest.fn().mockResolvedValue({ id: 'project-1', created_by_tech_id: 'tech-1' }),
    });
    const photoRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'photo-1',
        project_id: 'project-1',
        s3_key: 'project-photos/project-1/missing.jpg',
      }),
    });
    const photoDelete = chain();
    const missingError = new Error('No such key');
    missingError.name = 'NoSuchKey';
    mockS3Send.mockRejectedValue(missingError);

    const photoQueries = [photoRead, photoDelete];
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'project_photos') return photoQueries.shift();
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
    });
  });
});
