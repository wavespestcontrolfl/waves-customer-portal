process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan' };
    next();
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/photos', () => ({
  CUSTOMER_DWELL_TTL_SECONDS: 86400,
  getViewUrl: jest.fn(),
  getDownloadUrl: jest.fn(async () => 'https://storage.example/signed-download'),
}));
jest.mock('../models/db', () => jest.fn());

const express = require('express');
const db = require('../models/db');
const PhotoService = require('../services/photos');
const documentsRouter = require('../routes/documents');

let storedDocument = null;
let inserts = [];

function installDb() {
  db.mockImplementation((table) => {
    const q = {
      where() { return q; },
      first: jest.fn(async () => table === 'customer_documents' ? storedDocument : null),
      update: jest.fn(async () => 1),
      insert: jest.fn(async row => { inserts.push({ table, row }); return [row]; }),
    };
    return q;
  });
}

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/documents', documentsRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  jest.clearAllMocks();
  inserts = [];
  storedDocument = null;
  installDb();
});

describe('stored customer document routes', () => {
  test('authenticated download redirects to signed private bytes', async () => {
    storedDocument = {
      id: 'doc-1',
      customer_id: 'cust-1',
      s3_key: 'customer-documents/cust-1/agreement.pdf',
      file_name: 'Agreement.pdf',
    };

    const response = await fetch(`${base}/api/documents/doc-1/download`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://storage.example/signed-download');
    expect(PhotoService.getDownloadUrl).toHaveBeenCalledWith(
      'customer-documents/cust-1/agreement.pdf',
      'Agreement.pdf',
      900,
    );
  });

  test('a metadata-only row is not advertised as a working download', async () => {
    storedDocument = { id: 'doc-2', customer_id: 'cust-1', s3_key: null, file_name: 'Missing.pdf' };

    const response = await fetch(`${base}/api/documents/doc-2/download`, { redirect: 'manual' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Document file is not available' });
    expect(PhotoService.getDownloadUrl).not.toHaveBeenCalled();
  });

  test('does not mint a public share token for a metadata-only row', async () => {
    storedDocument = { id: 'doc-3', customer_id: 'cust-1', s3_key: '', file_name: 'Missing.pdf' };

    const response = await fetch(`${base}/api/documents/share/doc-3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'This document does not have a downloadable file yet.' });
    expect(inserts.some(row => row.table === 'document_share_links')).toBe(false);
  });
});
