/**
 * GATE_REPORT_SIMPLE_WEB (owner 2026-10-17: "skip wdo, and pre treatment, but
 * for everything else the simple layout") on the project report /data payload:
 * - gate off → no simpleWebReport key, for every project type;
 * - gate on → simpleWebReport: true, except for the WDO inspection and the
 *   pre-construction termite certificate, which never switch.
 */
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  reportSimpleWebLive: jest.fn(() => false),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));
jest.mock('../services/report-followup-appointment', () => ({
  findReportFollowupAppointment: jest.fn().mockResolvedValue(null),
}));

const express = require('express');
const db = require('../models/db');
const gates = require('../config/feature-gates');
const reportsRouter = require('../routes/reports-public');

const TOKEN = '0123456789abcdef0123456789abcdef';

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue(1),
    orderBy: jest.fn().mockReturnThis(),
    ...overrides,
  };
}

async function withServer(fn) {
  const app = express();
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function mockProject(projectType, { project = {}, visitTechnicianId = null, technicians = {} } = {}) {
  const projectQueries = [chain({
    first: jest.fn().mockResolvedValue({
      id: 'project-1',
      customer_id: 'customer-1',
      report_token: TOKEN,
      report_viewed_at: 'earlier',
      project_type: projectType,
      status: 'sent',
      title: 'Synthetic project',
      first_name: 'Pat',
      last_name: 'Tester',
      city: 'Testville',
      state: 'FL',
      findings: { evidence_type: 'Synthetic evidence' },
      ...project,
    }),
  })];
  db.mockImplementation((table) => {
    if (table === 'projects as p' || table === 'projects') return projectQueries.shift();
    if (table === 'project_photos') return chain({ orderBy: jest.fn().mockResolvedValue([]) });
    if (table === 'service_records') return chain({ first: jest.fn().mockResolvedValue(visitTechnicianId ? { technician_id: visitTechnicianId } : undefined) });
    if (table === 'technicians') {
      const q = chain();
      q.where = jest.fn((cond) => { q.first = jest.fn().mockResolvedValue(technicians[cond.id] || undefined); return q; });
      return q;
    }
    if (table === 'activity_log') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
}

async function getData(baseUrl) {
  const res = await fetch(`${baseUrl}/reports/project/${TOKEN}/data`);
  return { status: res.status, body: await res.json() };
}

describe('GET /reports/project/:token/data simple web report (GATE_REPORT_SIMPLE_WEB)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.fn.now.mockReturnValue('NOW');
  });

  test.each(['pest_inspection', 'bed_bug', 'termite_treatment', 'wdo_inspection', 'pre_treatment_termite_certificate'])(
    'gate off: %s carries no simpleWebReport key',
    async (projectType) => {
      gates.reportSimpleWebLive.mockReturnValue(false);
      mockProject(projectType);
      await withServer(async (baseUrl) => {
        const { status, body } = await getData(baseUrl);
        expect(status).toBe(200);
        expect('simpleWebReport' in body).toBe(false);
        expect(body.projectType).toBe(projectType);
      });
    },
  );

  test.each(['pest_inspection', 'bed_bug', 'termite_treatment', 'rodent_trapping'])(
    'gate on: %s is flagged',
    async (projectType) => {
      gates.reportSimpleWebLive.mockReturnValue(true);
      mockProject(projectType);
      await withServer(async (baseUrl) => {
        const { status, body } = await getData(baseUrl);
        expect(status).toBe(200);
        expect(body.simpleWebReport).toBe(true);
        // nothing else in the payload moves
        expect(body.findings).toEqual({ evidence_type: 'Synthetic evidence' });
        expect(body.projectType).toBe(projectType);
      });
    },
  );

  test.each(['wdo_inspection', 'pre_treatment_termite_certificate'])(
    'gate on: %s never switches',
    async (projectType) => {
      gates.reportSimpleWebLive.mockReturnValue(true);
      mockProject(projectType);
      await withServer(async (baseUrl) => {
        const { status, body } = await getData(baseUrl);
        expect(status).toBe(200);
        expect('simpleWebReport' in body).toBe(false);
      });
    },
  );

  // Codex P1 #6353: the work-order layout prints a Technician row. An office
  // staffer who typed up the project must never be named as the technician.
  const createdByOffice = {
    project: {
      service_record_id: 'visit-1',
      created_by_tech_id: 'tech-office',
      technician_name: 'Office Creator',
    },
    visitTechnicianId: 'tech-field',
    technicians: {
      'tech-field': { id: 'tech-field', name: 'Field Tech' },
      'tech-office': { id: 'tech-office', name: 'Office Creator' },
    },
  };

  test('gate on: the Technician row names who performed the visit, not who created the project', async () => {
    gates.reportSimpleWebLive.mockReturnValue(true);
    mockProject('pest_inspection', createdByOffice);
    await withServer(async (baseUrl) => {
      const { status, body } = await getData(baseUrl);
      expect(status).toBe(200);
      expect(body.performingTechnicianName).toBe('Field Tech');
      // technicianName keeps its meaning (the creator) for the pages that read it
      expect(body.technicianName).toBe('Office Creator');
    });
  });

  test('gate on: a linked visit with no technician names nobody', async () => {
    gates.reportSimpleWebLive.mockReturnValue(true);
    mockProject('pest_inspection', { ...createdByOffice, visitTechnicianId: null });
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.simpleWebReport).toBe(true);
      expect(body.performingTechnicianName).toBeNull();
    });
  });

  test('gate off: no performingTechnicianName key', async () => {
    gates.reportSimpleWebLive.mockReturnValue(false);
    mockProject('pest_inspection', createdByOffice);
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('performingTechnicianName' in body).toBe(false);
    });
  });

  test('a gates module without the reader reads as off', async () => {
    const saved = gates.reportSimpleWebLive;
    gates.reportSimpleWebLive = undefined;
    try {
      mockProject('pest_inspection');
      await withServer(async (baseUrl) => {
        const { body } = await getData(baseUrl);
        expect('simpleWebReport' in body).toBe(false);
      });
    } finally {
      gates.reportSimpleWebLive = saved;
    }
  });
});
