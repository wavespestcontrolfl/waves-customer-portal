jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
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
  findReportFollowupAppointment: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { findReportFollowupAppointment } = require('../services/report-followup-appointment');
const reportsRouter = require('../routes/reports-public');

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

function appServer() {
  const app = express();
  app.use('/reports', reportsRouter);
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

describe('public project reports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.fn.now.mockReturnValue('NOW');
  });

  test('WDO: fee-bearing captions are scrubbed and a dirty legacy filing gates the PDF', async () => {
    const wdoProjectRow = {
      id: 'project-2',
      customer_id: 'customer-1',
      report_token: '0123456789abcdef0123456789abcdef',
      report_viewed_at: 'earlier',
      project_type: 'wdo_inspection',
      status: 'sent',
      title: 'WDO inspection',
      first_name: 'Van',
      last_name: 'Lee',
      city: 'Bradenton',
      state: 'FL',
      findings: { wdo_finding: 'No visible signs of WDO observed' },
      wdo_sent_filings: JSON.stringify([{
        s3_key: 'wdo/filing.pdf',
        findings: { comments: 'Inspection fee $250 collected on site.' },
      }]),
    };
    const projectRead = chain({ first: jest.fn().mockResolvedValue(wdoProjectRow) });
    const photosRead = chain({
      orderBy: jest.fn().mockResolvedValue([
        { id: 'photo-1', category: 'damage', caption: 'Inspection fee $250 noted at panel', visit: 'primary', s3_key: 'k1' },
      ]),
    });
    getSignedUrl.mockResolvedValueOnce('https://signed.example/p.jpg');
    const projectQueries = [projectRead];
    db.mockImplementation((table) => {
      if (table === 'projects as p' || table === 'projects') return projectQueries.shift();
      if (table === 'project_photos') return photosRead;
      if (table === 'service_records') return chain();
      if (table === 'activity_log') return chain();
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      // photo caption is technician free text — scrubbed at the egress
      expect(body.photos[0].caption).toBe('Inspection fee [fee removed] noted at panel');
      // the archived binary carries the raw fee — never advertised...
      expect(body.fdacsPdfAvailable).toBe(false);
      // ...while the page's snapshot findings render scrubbed
      expect(body.findings.comments).toBe('Inspection fee [fee removed] collected on site.');
    });
  });

  test('WDO: /fdacs-pdf 404s a dirty legacy filing with the generic body', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-2',
        customer_id: 'customer-1',
        report_token: '0123456789abcdef0123456789abcdef',
        project_type: 'wdo_inspection',
        status: 'sent',
        wdo_sent_filings: JSON.stringify([{
          s3_key: 'wdo/filing.pdf',
          findings: { comments: 'Inspection fee $250 collected on site.' },
        }]),
      }),
    });
    const projectQueries = [projectRead];
    db.mockImplementation((table) => {
      if (table === 'projects as p' || table === 'projects') return projectQueries.shift();
      if (table === 'service_records') return chain();
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/fdacs-pdf`);
      const body = await res.json();
      expect(res.status).toBe(404);
      expect(body.error).toBe('Report not found');
    });
  });

  test('returns report data when one project photo cannot be signed', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        report_token: '0123456789abcdef0123456789abcdef',
        report_viewed_at: null,
        project_type: 'pest_inspection',
        status: 'sent',
        title: 'Inspection report',
        first_name: 'Van',
        last_name: 'Lee',
        city: 'Bradenton',
        state: 'FL',
      }),
    });
    const markViewed = chain();
    const activityInsert = chain();
    const photosRead = chain({
      orderBy: jest.fn().mockResolvedValue([
        {
          id: 'photo-1',
          category: 'entry_point',
          caption: 'Front entry',
          visit: 'primary',
          s3_key: 'project-photos/project-1/front.jpg',
        },
        {
          id: 'photo-2',
          category: 'damage',
          caption: 'Damaged trim',
          visit: 'primary',
          s3_key: 'project-photos/project-1/missing.jpg',
        },
      ]),
    });
    getSignedUrl
      .mockResolvedValueOnce('https://signed.example/front.jpg')
      .mockRejectedValueOnce(new Error('NoSuchKey'));

    const projectQueries = [projectRead, markViewed];
    db.mockImplementation((table) => {
      if (table === 'projects as p') return projectQueries.shift();
      if (table === 'projects') return projectQueries.shift();
      if (table === 'activity_log') return activityInsert;
      if (table === 'project_photos') return photosRead;
      // The router.param('token') suppression gate checks every 32-hex token
      // against service_records (report_view_token) — no row means "not a
      // service report", and the request falls through to the project route.
      if (table === 'service_records') return chain();
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.photos).toEqual([
        expect.objectContaining({ id: 'photo-1', url: 'https://signed.example/front.jpg' }),
        expect.objectContaining({ id: 'photo-2', url: null }),
      ]);
      expect(markViewed.update).toHaveBeenCalledWith({ report_viewed_at: 'NOW' });
      expect(activityInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        customer_id: 'customer-1',
        action: 'project_report_viewed',
        metadata: expect.objectContaining({ project_id: 'project-1', project_type: 'pest_inspection' }),
      }));
    });
  });

  test('resolves readable project report slug by token prefix', async () => {
    const projectRead = chain({
      limit: jest.fn().mockResolvedValue([
        {
          id: 'project-1',
          customer_id: 'customer-1',
          report_token: '0123456789abcdef0123456789abcdef',
          report_viewed_at: '2026-05-02T14:00:00.000Z',
          project_type: 'rodent_trapping',
          status: 'sent',
          title: 'Rodent trapping',
          first_name: 'Georgia',
          last_name: 'Lobban',
          city: 'Bradenton',
          state: 'FL',
        },
      ]),
    });
    const photosRead = chain({
      orderBy: jest.fn().mockResolvedValue([]),
    });

    db.mockImplementation((table) => {
      if (table === 'projects as p') return projectRead;
      if (table === 'project_photos') return photosRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/georgia-lobban-0123456789ab/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.customerName).toBe('Georgia Lobban');
      expect(body.projectType).toBe('rodent_trapping');
      expect(projectRead.where).toHaveBeenCalledWith('p.report_token', 'like', '0123456789ab%');
      expect(projectRead.limit).toHaveBeenCalledWith(2);
    });
  });

  // The hero contact block prints the customer's email/phone on customer-only
  // report links, but a WDO link is also emailed to the third parties named
  // on the FDACS form (sendWdoReportCopies) — the payload must withhold the
  // homeowner's direct contact details there.
  // Owner EXPLICIT ruling 2026-07-16 (destination acknowledged: WDO links go
  // to the realtor/title company on the FDACS form): every report shows the
  // full identity block — WDO included. Supersedes the earlier withholding.
  test('customer email/phone serve on every project type, WDO included', async () => {
    const baseRow = {
      id: 'project-1',
      customer_id: 'customer-1',
      report_token: '0123456789abcdef0123456789abcdef',
      report_viewed_at: '2026-05-02T14:00:00.000Z',
      status: 'sent',
      first_name: 'Georgia',
      last_name: 'Lobban',
      customer_email: 'georgia@example.com',
      customer_phone: '9415550100',
      city: 'Bradenton',
      state: 'FL',
    };
    const photosRead = () => chain({ orderBy: jest.fn().mockResolvedValue([]) });

    for (const [projectType, expectedEmail, expectedPhone] of [
      ['pest_inspection', 'georgia@example.com', '9415550100'],
      ['wdo_inspection', 'georgia@example.com', '9415550100'],
    ]) {
      const projectRead = chain({
        first: jest.fn().mockResolvedValue({ ...baseRow, project_type: projectType }),
      });
      db.mockImplementation((table) => {
        if (table === 'projects as p') return projectRead;
        if (table === 'project_photos') return photosRead();
        if (table === 'service_records') return chain();
        throw new Error(`Unexpected table query: ${table}`);
      });

      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/data`);
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.projectType).toBe(projectType);
        expect(body.customerEmail).toBe(expectedEmail);
        expect(body.customerPhone).toBe(expectedPhone);
      });
    }
  });

  // 2026-07-16 egress-hygiene audit fixes: the public project JSON never
  // carries internal finding keys or the internal window_end, and it ships
  // the same privacy headers as the sibling /fdacs-pdf route.
  test('public payload strips internal finding keys, drops window_end, and sets privacy headers', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-hyg',
        customer_id: 'customer-1',
        scheduled_service_id: 'ss-source',
        report_token: '0123456789abcdef0123456789abcdef',
        report_viewed_at: '2026-05-02T14:00:00.000Z',
        status: 'sent',
        project_type: 'wdo_inspection',
        first_name: 'Test',
        last_name: 'Customer',
        findings: JSON.stringify({
          wdo_finding: 'No visible signs of WDO observed',
          inspection_fee: '$250',
        }),
        recommendations: 'Inspection fee $250. Keep mulch pulled back from the foundation. Repair cost $1,250 for the sill plate.',
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'projects as p') return projectRead;
      if (table === 'project_photos') return chain({ orderBy: jest.fn().mockResolvedValue([]) });
      if (table === 'service_records') return chain();
      throw new Error(`Unexpected table query: ${table}`);
    });
    // A real linked follow-up whose SOURCE row carries window_end — the
    // serializer must surface window_start and drop window_end (internal
    // job-duration block). Mocked so the assertion actually exercises the
    // serializer, not a null upcomingAppointment (codex P2).
    findReportFollowupAppointment.mockResolvedValue({
      service_type: 'WDO Re-Inspection',
      scheduled_date: '2999-01-05',
      window_start: '08:00:00',
      window_end: '12:00:00',
      technician_name: 'Alex',
      status: 'confirmed',
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/data`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-robots-tag')).toContain('noindex');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(body.findings.wdo_finding).toBe('No visible signs of WDO observed');
      expect(body.findings.inspection_fee).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('$250');
      // the inspection fee is scrubbed at egress; the rest of the narrative —
      // including a legitimate repair estimate — survives intact
      expect(body.recommendations).toContain('Inspection fee [fee removed].');
      expect(body.recommendations).toContain('Keep mulch pulled back');
      expect(body.recommendations).toContain('Repair cost $1,250');
      expect(body.recommendations).not.toContain('$250');
      // appointment surfaced, window_start present, window_end stripped
      expect(body.upcomingAppointment).toBeTruthy();
      expect(body.upcomingAppointment.windowStart).toBe('08:00:00');
      expect(body.upcomingAppointment.windowEnd).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('12:00:00');
    });
  });
});
