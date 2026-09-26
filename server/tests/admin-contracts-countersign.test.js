/**
 * POST /api/admin/contracts/:id/countersign — certified-operator
 * countersignature on a signed termite annual protection agreement (owner
 * ruling 2026-09-25, A-14). A RECORD step after the customer signs; it must
 * never gate activation, charging, or visit creation.
 *
 * Follows the repo convention for exercising the REAL admin-auth middleware
 * (adminAuthenticate + requireAdmin) against a mocked db — see
 * admin-service-outlines-tech-authz.test.js: a technician-role JWT must 403
 * on the whole router (admin-contracts.js applies router.use(adminAuthenticate,
 * requireAdmin) at the top), exactly as a leaked/legit tech token would in
 * prod.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'countersign-test-secret';

const ANNUAL_KEY = 'service_agreement.termite_annual_protection';

const mockWrites = [];
let mockRows = {};

function normalizeTable(table) {
  return String(table).replace(/ as \w+$/i, '');
}

function mockBuilder(rawTable) {
  const table = normalizeTable(rawTable);
  const b = { table, filters: [] };
  const chain = () => b;
  for (const m of ['leftJoin', 'select', 'whereIn', 'whereNull', 'whereNotNull', 'forUpdate', 'orderBy', 'limit']) b[m] = jest.fn(chain);
  b.where = jest.fn((arg) => { b.filters.push(arg); return b; });
  b.first = jest.fn(async () => {
    const value = table in mockRows ? mockRows[table] : null;
    return (typeof value === 'function' ? value(b) : value) ?? null;
  });
  b.update = jest.fn(async (payload) => {
    mockWrites.push({ table, op: 'update', payload, filters: b.filters.slice() });
    return mockRows.__updateResult ?? 1;
  });
  b.insert = jest.fn(async (payload) => { mockWrites.push({ table, op: 'insert', payload }); return [1]; });
  return b;
}

jest.mock('../models/db', () => {
  const fn = jest.fn((table) => mockBuilder(table));
  fn.transaction = jest.fn(async (cb) => cb(fn));
  fn.raw = jest.fn((s) => s);
  return fn;
});
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/document-contract-delivery', () => ({
  deliverDocumentRequest: jest.fn(),
  documentRequestStats: jest.fn(),
  listDocumentRequests: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/termite-program-agreement', () => ({ ANNUAL_TEMPLATE_KEY: 'service_agreement.termite_annual_protection' }));
jest.mock('../services/pdf/contract-pdf', () => ({
  generateContractPDF: jest.fn((contract, customer, res) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.end(`PDF:${contract.countersigner_name || ''}`);
  }),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../models/db');
const adminContracts = require('../routes/admin-contracts');

const TECH = { id: 'tech-9', role: 'technician', employment_status: 'active', auth_token_version: 1, must_change_password: false, first_name: 'Tessa', last_name: 'Tech' };
const techToken = jwt.sign({ technicianId: TECH.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);
const ADMIN = {
  id: 'admin-9', role: 'admin', employment_status: 'active', auth_token_version: 1, must_change_password: false, first_name: 'Adam', last_name: 'Owner',
  name: 'Adam', applicator_printed_name: 'Adam Owner', fl_applicator_license: 'JE000000', license_expiry: null,
};
const adminToken = jwt.sign({ technicianId: ADMIN.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);
// A second admin who is NOT the designated certified operator.
const OTHER_ADMIN = { ...ADMIN, id: 'admin-7', first_name: 'Olive', last_name: 'Office', name: 'Olive', applicator_printed_name: null, fl_applicator_license: null };
const otherAdminToken = jwt.sign({ technicianId: OTHER_ADMIN.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/contracts', adminContracts);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}

const CONTRACT_ID = 'contract-1';
const BASE_CONTRACT = {
  id: CONTRACT_ID,
  customer_id: 'cust-1',
  contract_type: 'document_template',
  document_template_key: ANNUAL_KEY,
  status: 'signed',
  signed_at: new Date('2026-09-24T14:00:00Z'),
  title: 'Waves Subterranean Termite Protection — Annual Service Agreement',
  countersigned_at: null,
};

beforeEach(() => {
  mockWrites.length = 0;
  mockRows = {};
  db.mockClear();
  process.env.TERMITE_CERTIFIED_OPERATOR_TECHNICIAN_IDS = ADMIN.id;
  const staffById = { [TECH.id]: TECH, [ADMIN.id]: ADMIN, [OTHER_ADMIN.id]: OTHER_ADMIN };
  mockRows.technicians = (b) => {
    const filter = b.filters.find((f) => f && f.id);
    return staffById[filter?.id] || null;
  };
});

const adminHdrs = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
const techHdrs = { authorization: `Bearer ${techToken}`, 'content-type': 'application/json' };

describe('POST /api/admin/contracts/:id/countersign — auth', () => {
  test('a technician token 403s (router-level lockdown, not a per-route carve-out)', async () => {
    mockRows.customer_contracts = BASE_CONTRACT;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: techHdrs, body: '{}' });
      expect(res.status).toBe(403);
    });
    expect(mockWrites).toHaveLength(0);
  });
});

describe('POST /api/admin/contracts/:id/countersign — admin', () => {
  test('wrong template: an autopay authorization contract 400s', async () => {
    mockRows.customer_contracts = { ...BASE_CONTRACT, contract_type: 'autopay_authorization', document_template_key: null };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: '{}' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/annual agreement/i);
    });
    expect(mockWrites.filter((w) => w.op === 'update' && w.table === 'customer_contracts')).toHaveLength(0);
  });

  test('wrong template: a document_template contract on a different key 400s', async () => {
    mockRows.customer_contracts = { ...BASE_CONTRACT, document_template_key: 'service_agreement.termite_bait_program_purchase' };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: '{}' });
      expect(res.status).toBe(400);
    });
  });

  test('not-yet-signed: status !== signed 409s', async () => {
    mockRows.customer_contracts = { ...BASE_CONTRACT, status: 'viewed' };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: '{}' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/not been signed/i);
    });
    expect(mockWrites.filter((w) => w.op === 'update' && w.table === 'customer_contracts')).toHaveLength(0);
  });

  test('idempotent: already countersigned 409s and does not write again', async () => {
    mockRows.customer_contracts = { ...BASE_CONTRACT, countersigned_at: new Date('2026-09-25T12:00:00Z') };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: '{}' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/already been countersigned/i);
    });
    expect(mockWrites.filter((w) => w.op === 'update' && w.table === 'customer_contracts')).toHaveLength(0);
  });

  test('happy path: signed annual agreement gets countersigned under the row lock, stamps the admin identity, and the event lands', async () => {
    let reads = 0;
    mockRows.customer_contracts = (b) => {
      // peek + locked read see the pre-countersign row; the post-write re-read sees the stamp.
      if (reads++ < 2) return BASE_CONTRACT;
      // loadContract's post-write re-read (contractQuery aliases the table as cc).
      return { ...BASE_CONTRACT, countersigned_at: new Date(), countersigned_by: ADMIN.id, countersigner_name: 'Adam Owner' };
    };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: JSON.stringify({ name: 'Adam Owner' }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true);
      expect(body.contract.countersignedAt).toBeTruthy();
      expect(body.contract.countersignerName).toBe('Adam Owner');
    });

    const builders = db.mock.results.map((r) => r.value);
    const contractBuilder = builders.find((v) => v.table === 'customer_contracts' && v.forUpdate.mock.calls.length);
    expect(contractBuilder.forUpdate).toHaveBeenCalled();
    // Customer row locked BEFORE the contract row (codex #4842 r2 P2).
    const customerLock = builders.findIndex((v) => v.table === 'customers' && v.forUpdate.mock.calls.length);
    expect(customerLock).toBeGreaterThanOrEqual(0);
    expect(customerLock).toBeLessThan(builders.indexOf(contractBuilder));

    const [update] = mockWrites.filter((w) => w.op === 'update' && w.table === 'customer_contracts');
    expect(update.payload.countersigned_by).toBe(ADMIN.id);
    expect(update.payload.countersigner_name).toBe('Adam Owner');
    expect(update.payload.countersigned_at).toBeInstanceOf(Date);

    const event = mockWrites.find((w) => w.table === 'customer_contract_events');
    expect(event.payload).toEqual(expect.objectContaining({
      contract_id: CONTRACT_ID,
      customer_id: 'cust-1',
      event_type: 'countersigned',
      actor_type: 'admin',
      actor_id: ADMIN.id,
    }));
    expect(JSON.parse(event.payload.metadata)).toEqual({ countersignerName: 'Adam Owner', applicatorLicense: 'JE000000' });
  });

  test('a blank or one-character typed name 400s and writes nothing — the operator types their own name, never auto-filled', async () => {
    for (const body of ['{}', JSON.stringify({ name: '   ' }), JSON.stringify({ name: 'A' }), JSON.stringify({ name: 'x'.repeat(181) })]) {
      mockRows.customer_contracts = BASE_CONTRACT;
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/type your full name/i);
      });
    }
    expect(mockWrites).toHaveLength(0);
  });

  test('the recorded name is the verified operator\'s printed name — the typed name only has to match it', async () => {
    let reads = 0;
    mockRows.customer_contracts = () => {
      // peek + locked read see the pre-countersign row; the post-write re-read sees the stamp.
      if (reads++ < 2) return BASE_CONTRACT;
      return { ...BASE_CONTRACT, countersigned_at: new Date(), countersigner_name: 'Adam Owner' };
    };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, {
        method: 'POST', headers: adminHdrs, body: JSON.stringify({ name: '  adam   OWNER ' }),
      });
      expect(res.status).toBe(200);
    });
    const [update] = mockWrites.filter((w) => w.op === 'update' && w.table === 'customer_contracts');
    expect(update.payload.countersigner_name).toBe('Adam Owner');
  });

  test('a typed name that is not the operator\'s own (e.g. someone else\'s) 400s and writes nothing', async () => {
    mockRows.customer_contracts = BASE_CONTRACT;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: JSON.stringify({ name: 'Adam Benetti, Certified Operator' }) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/exactly as it appears/i);
    });
    expect(mockWrites).toHaveLength(0);
  });

  test('lost race: the guarded update matches no row (another countersign landed first) — 409, no event', async () => {
    mockRows.customer_contracts = BASE_CONTRACT;
    mockRows.__updateResult = 0;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: JSON.stringify({ name: 'Adam Owner' }) });
      expect(res.status).toBe(409);
    });
    const [update] = mockWrites.filter((w) => w.op === 'update' && w.table === 'customer_contracts');
    expect(update.filters).toEqual(expect.arrayContaining([{ id: CONTRACT_ID }]));
    expect(mockWrites.find((w) => w.table === 'customer_contract_events')).toBeUndefined();
  });

  test('contract not found 404s', async () => {
    mockRows.customer_contracts = null;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/missing/countersign`, { method: 'POST', headers: adminHdrs, body: '{}' });
      expect(res.status).toBe(404);
    });
  });
});

describe('POST /api/admin/contracts/:id/countersign — certified operator only (codex #4842 r1 P1)', () => {
  const post = (baseUrl, headers, name = 'Adam Owner') => fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, {
    method: 'POST', headers, body: JSON.stringify({ name }),
  });

  test('another admin — even typing the operator\'s name — 403s before anything is read or written', async () => {
    mockRows.customer_contracts = BASE_CONTRACT;
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { authorization: `Bearer ${otherAdminToken}`, 'content-type': 'application/json' });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/designated certified operator/i);
    });
    expect(mockWrites).toHaveLength(0);
  });

  test('no designation configured: nobody can countersign (fail closed)', async () => {
    delete process.env.TERMITE_CERTIFIED_OPERATOR_TECHNICIAN_IDS;
    mockRows.customer_contracts = BASE_CONTRACT;
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, adminHdrs)).status).toBe(403);
    });
    expect(mockWrites).toHaveLength(0);
  });

  test('the designated account without a current applicator license 403s', async () => {
    for (const license of [{ fl_applicator_license: '' }, { license_expiry: '2020-01-01' }]) {
      mockWrites.length = 0;
      const lapsed = { ...ADMIN, ...license };
      mockRows.technicians = (b) => {
        const filter = b.filters.find((f) => f && f.id);
        return filter?.id === ADMIN.id ? lapsed : null;
      };
      mockRows.customer_contracts = BASE_CONTRACT;
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, adminHdrs);
        expect(res.status).toBe(403);
        expect((await res.json()).error).toMatch(/applicator license/i);
      });
      expect(mockWrites.filter((w) => w.op === 'update' && w.table === 'customer_contracts')).toHaveLength(0);
    }
  });
});

describe('GET /api/admin/contracts/:id/pdf — executed copy incl. countersignature (codex #4842 r1 P2)', () => {
  const { generateContractPDF } = require('../services/pdf/contract-pdf');

  test('a countersigned agreement renders from the current row, countersignature included', async () => {
    mockRows.customer_contracts = { ...BASE_CONTRACT, countersigned_at: new Date('2026-09-25T15:00:00Z'), countersigner_name: 'Adam Owner' };
    mockRows.customers = { first_name: 'Sam', last_name: 'Customer' };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/pdf`, { headers: adminHdrs });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/pdf/);
      expect(await res.text()).toBe('PDF:Adam Owner');
    });
    expect(generateContractPDF).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONTRACT_ID, countersigner_name: 'Adam Owner' }),
      { first_name: 'Sam', last_name: 'Customer' },
      expect.anything(),
      { signed: true },
    );
  });

  test('an unsigned agreement 409s; a missing one 404s; a technician token 403s', async () => {
    await withServer(async (baseUrl) => {
      mockRows.customer_contracts = { ...BASE_CONTRACT, status: 'viewed' };
      expect((await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/pdf`, { headers: adminHdrs })).status).toBe(409);
      mockRows.customer_contracts = null;
      expect((await fetch(`${baseUrl}/api/admin/contracts/missing/pdf`, { headers: adminHdrs })).status).toBe(404);
      mockRows.customer_contracts = BASE_CONTRACT;
      expect((await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/pdf`, { headers: techHdrs })).status).toBe(403);
    });
  });
});

test('the applicator license is valid THROUGH its expiry day in ET (not expired at UTC midnight)', async () => {
  jest.useFakeTimers({ now: new Date('2026-12-31T22:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
  try {
    const lastDay = { ...ADMIN, license_expiry: '2026-12-31' };
    mockRows.technicians = (b) => {
      const filter = b.filters.find((f) => f && f.id);
      return filter?.id === ADMIN.id ? lastDay : null;
    };
    let reads = 0;
    mockRows.customer_contracts = () => {
      // peek + locked read see the pre-countersign row; the post-write re-read sees the stamp.
      if (reads++ < 2) return BASE_CONTRACT;
      return { ...BASE_CONTRACT, countersigned_at: new Date(), countersigner_name: 'Adam Owner' };
    };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: JSON.stringify({ name: 'Adam Owner' }) });
      expect(res.status).toBe(200);
    });
  } finally {
    jest.useRealTimers();
  }
});

test('a contract repointed to another customer while waiting on the customer lock 409s and writes nothing', async () => {
  let reads = 0;
  mockRows.customer_contracts = () => (reads++ === 0 ? BASE_CONTRACT : { ...BASE_CONTRACT, customer_id: 'cust-merged' });
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: JSON.stringify({ name: 'Adam Owner' }) });
    expect(res.status).toBe(409);
  });
  expect(mockWrites).toHaveLength(0);
});

describe('executed agreements after cancellation (codex #4842 r4)', () => {
  test('an agreement cancelled AFTER the customer signed can still be countersigned', async () => {
    const cancelledAfter = { ...BASE_CONTRACT, status: 'cancelled', cancelled_at: new Date('2026-09-25T10:00:00Z') };
    let reads = 0;
    mockRows.customer_contracts = () => (reads++ < 2 ? cancelledAfter : { ...cancelledAfter, countersigned_at: new Date(), countersigner_name: 'Adam Owner' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: JSON.stringify({ name: 'Adam Owner' }) });
      expect(res.status).toBe(200);
    });
    expect(mockWrites.filter((w) => w.op === 'update' && w.table === 'customer_contracts')).toHaveLength(1);
  });

  test('an agreement cancelled BEFORE anyone signed is never countersignable', async () => {
    mockRows.customer_contracts = { ...BASE_CONTRACT, status: 'cancelled', signed_at: null };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/countersign`, { method: 'POST', headers: adminHdrs, body: JSON.stringify({ name: 'Adam Owner' }) });
      expect(res.status).toBe(409);
    });
    expect(mockWrites).toHaveLength(0);
  });

  test('the executed PDF stays available after cancellation; a never-signed cancelled contract 409s', async () => {
    mockRows.customers = { first_name: 'Sam', last_name: 'Customer' };
    await withServer(async (baseUrl) => {
      mockRows.customer_contracts = { ...BASE_CONTRACT, status: 'cancelled', countersigned_at: new Date(), countersigner_name: 'Adam Owner' };
      expect((await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/pdf`, { headers: adminHdrs })).status).toBe(200);
      mockRows.customer_contracts = { ...BASE_CONTRACT, status: 'cancelled', signed_at: null };
      expect((await fetch(`${baseUrl}/api/admin/contracts/${CONTRACT_ID}/pdf`, { headers: adminHdrs })).status).toBe(409);
    });
  });
});
