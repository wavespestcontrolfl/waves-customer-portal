process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockS3Send = jest.fn();
const mockAnthropicCreate = jest.fn();

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
jest.mock('../services/project-email', () => ({
  PREP_TEMPLATE_BY_PROJECT_TYPE: { rodent_exclusion: 'prep.rodent' },
  resolveProjectEmailRecipient: jest.fn((customer = {}) => ({
    email: customer.email || '',
    name: customer.first_name || '',
    role: 'primary',
  })),
  resolvePortalInviteRecipient: jest.fn((customer = {}) => ({
    email: customer.email || '',
    name: customer.first_name || '',
    role: 'primary',
  })),
  sendProjectReportReady: jest.fn(async () => ({ ok: true, messageId: 'sg-report' })),
  sendPrepGuide: jest.fn(async () => ({ ok: true, messageId: 'sg-prep' })),
  sendPortalInvite: jest.fn(async () => ({ ok: true, messageId: 'sg-invite' })),
  prepTemplateForProjectType: jest.fn((projectType) => (
    projectType === 'rodent_exclusion' ? 'prep.rodent' : null
  )),
  isPrepTemplateKey: jest.fn((key) => [
    'prep.rodent',
    'prep.flea',
    'prep.mosquito',
    'prep.lawn',
    'prep.termite',
    'prep.interior_pest',
  ].includes(key)),
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
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicCreate },
})));
jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  lookupPropertyFromAITrio: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { lookupPropertyFromAITrio } = require('../services/property-lookup/ai-property-lookup');
const ProjectEmail = require('../services/project-email');
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

// appointmentManagedProjectTypes now runs two distinct() queries against
// service_completion_profiles (project_required rows = still-backed types,
// then service_report rows). Discriminate on the captured where() mode.
function modeAwareProfilesChain({ flipped = [], backed = [], first = null } = {}) {
  let mode = null;
  const c = chain({
    first: jest.fn().mockResolvedValue(first),
  });
  c.where = jest.fn((args) => {
    if (args && args.completion_mode) mode = args.completion_mode;
    return c;
  });
  c.distinct = jest.fn(async () => (mode === 'project_required' ? backed : flipped));
  return c;
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
    delete process.env.ANTHROPIC_API_KEY;
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

  test('managed project type stays creatable for a linked project_required appointment', async () => {
    // Phase-1 cutover makes one_time_pest_treatment appointment-managed via
    // OTHER keys, but general_appointment stays project_required — its linked
    // appointments must keep the Projects flow (they need a project to complete).
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    const createdProject = { id: 'project-2', customer_id: 'customer-1', project_type: 'one_time_pest_treatment', status: 'draft' };
    const scheduledRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'svc-9', service_id: 'service-3', service_type: 'General Appointment',
        customer_id: 'customer-1', scheduled_date: '2026-06-11',
      }),
    });
    const profilesChain = modeAwareProfilesChain({
      flipped: [{ project_type: 'one_time_pest_treatment' }],
      backed: [{ project_type: 'one_time_pest_treatment' }],
      first: {
        service_key: 'general_appointment', completion_mode: 'project_required',
        project_type: 'one_time_pest_treatment', active: true,
      },
    });
    const projectInsert = chain({ returning: jest.fn().mockResolvedValue([createdProject]) });
    db.mockImplementation((table) => {
      if (table === 'customers') return chain({ first: jest.fn().mockResolvedValue({ id: 'customer-1' }) });
      if (table === 'scheduled_services') return scheduledRead;
      if (table === 'services') return chain({ first: jest.fn().mockResolvedValue({ service_key: 'general_appointment', name: 'General Appointment', category: 'specialty', billing_type: 'one_time' }) });
      if (table === 'service_completion_profiles') return profilesChain;
      if (table === 'projects') return projectInsert;
      if (table === 'activity_log') return chain();
      throw new Error(`Unexpected table query: ${table}`);
    });

    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/projects`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ customer_id: 'customer-1', project_type: 'one_time_pest_treatment', scheduled_service_id: 'svc-9' }),
        });
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.project.id).toBe('project-2');
      });
    } finally {
      delete db.schema;
    }
  });

  test('linked project_required appointment cannot create a DIFFERENT managed type', async () => {
    // The bypass is scoped to the linked profile's own type — linking a
    // general_appointment while submitting mosquito_event must still 422.
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    const profilesChain = modeAwareProfilesChain({
      flipped: [
        { project_type: 'one_time_pest_treatment' },
        { project_type: 'mosquito_event' },
      ],
      backed: [{ project_type: 'one_time_pest_treatment' }],
      first: {
        service_key: 'general_appointment', completion_mode: 'project_required',
        project_type: 'one_time_pest_treatment', active: true,
      },
    });
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({
        first: jest.fn().mockResolvedValue({ id: 'svc-9', service_id: 'service-3', service_type: 'General Appointment', customer_id: 'customer-1' }),
      });
      if (table === 'services') return chain({ first: jest.fn().mockResolvedValue({ service_key: 'general_appointment', name: 'General Appointment', category: 'specialty', billing_type: 'one_time' }) });
      if (table === 'service_completion_profiles') return profilesChain;
      throw new Error(`Unexpected table query: ${table}`);
    });

    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/projects`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ customer_id: 'customer-1', project_type: 'mosquito_event', scheduled_service_id: 'svc-9' }),
        });
        const body = await res.json();
        expect(res.status).toBe(422);
        expect(body.code).toBe('project_type_appointment_managed');
      });
    } finally {
      delete db.schema;
    }
  });

  test('service_record_id link to a typed completion is rejected too', async () => {
    // The route accepts service_record_id without scheduled_service_id —
    // that path must resolve the same profile guard (Codex P1 side door).
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    db.mockImplementation((table) => {
      if (table === 'service_records') return chain({
        first: jest.fn().mockResolvedValue({ scheduled_service_id: 'svc-7' }),
      });
      if (table === 'scheduled_services') return chain({
        first: jest.fn().mockResolvedValue({ id: 'svc-7', service_id: 'service-9', service_type: 'Rodent Trapping' }),
      });
      if (table === 'services') return chain({ first: jest.fn().mockResolvedValue({ service_key: 'rodent_trapping', name: 'Rodent Trapping', category: 'specialty', billing_type: 'one_time' }) });
      if (table === 'service_completion_profiles') return modeAwareProfilesChain({
        flipped: [{ project_type: 'rodent_trapping' }],
        backed: [],
        first: {
          service_key: 'rodent_trapping', completion_mode: 'service_report',
          project_type: 'rodent_trapping', active: true,
        },
      });
      throw new Error(`Unexpected table query: ${table}`);
    });

    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/projects`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ customer_id: 'customer-1', project_type: 'rodent_trapping', service_record_id: 'rec-12' }),
        });
        const body = await res.json();
        expect(res.status).toBe(422);
        expect(body.code).toBe('scheduled_service_appointment_managed');
      });
    } finally {
      delete db.schema;
    }
  });

  test('managed project type is rejected for unlinked creations', async () => {
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    db.mockImplementation((table) => {
      if (table === 'service_completion_profiles') return modeAwareProfilesChain({
        flipped: [{ project_type: 'one_time_pest_treatment' }],
        backed: [],
      });
      throw new Error(`Unexpected table query: ${table}`);
    });

    try {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/projects`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ customer_id: 'customer-1', project_type: 'one_time_pest_treatment' }),
        });
        const body = await res.json();
        expect(res.status).toBe(422);
        expect(body.code).toBe('project_type_appointment_managed');
      });
    } finally {
      delete db.schema;
    }
  });

  test('wdo intelligence uses selected customer address and returns field suggestions', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    lookupPropertyFromAITrio.mockResolvedValue({
      propertyType: 'Single Family',
      squareFootage: 1840,
      yearBuilt: 2004,
      stories: 1,
      constructionMaterial: 'CBS',
      _aiConfidence: 'medium',
      _aiSourceUrl: 'https://example.test/property',
    });
    mockAnthropicCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          suggestedFindings: {
            property_address: '8920 Forty Ninth Ave Bradenton FL',
            structures_inspected: 'Main single-family residential structure and attached garage.',
            structure_type: 'Wood Frame',
            inspection_scope: 'Visible and readily accessible interior areas, garage, attic access, exterior perimeter, and accessible structural components.',
            previous_treatment_evidence: 'Yes',
            previous_treatment_notes: 'Photo appears to show a prior treatment notice near the garage.',
          },
          propertySummary: 'Single-family CBS home, approximately 1,840 square feet.',
          confidence: 'medium',
          reviewNotes: ['Verify any detached structures in the field.'],
        }),
      }],
    });

    const customerRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'customer-1',
        first_name: 'Van',
        last_name: 'Lee',
        address_line1: '8920 49th Ave E',
        city: 'Bradenton',
        state: 'FL',
        zip: '34211',
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'customers') return customerRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/wdo-intelligence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: 'customer-1',
          findings: { property_address: '' },
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(lookupPropertyFromAITrio).toHaveBeenCalledWith('8920 49th Ave E Bradenton, FL 34211');
      expect(body.suggestedFindings).toEqual(expect.objectContaining({
        property_address: '8920 49th Ave E Bradenton, FL 34211',
        structures_inspected: 'Main single-family residential structure and attached garage.',
        structure_type: 'CMU / Concrete Masonry Unit',
        inspection_scope: expect.stringContaining('Visible and readily accessible'),
      }));
      expect(body.suggestedFindings.property_address).toBe('8920 49th Ave E Bradenton, FL 34211');
      expect(body.suggestedFindings.previous_treatment_evidence).toBe('');
      expect(body.suggestedFindings.previous_treatment_notes).toBe('');
      expect(body.propertyProfile).toEqual(expect.objectContaining({
        propertyType: 'Single Family',
        squareFootage: 1840,
      }));
      expect(mockAnthropicCreate).toHaveBeenCalledWith(expect.objectContaining({
        model: expect.any(String),
        messages: expect.any(Array),
      }));
    });
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('wdo intelligence blanks unsupported construction suggestions without supporting facts', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    lookupPropertyFromAITrio.mockResolvedValue({
      propertyType: 'Single Family',
      squareFootage: 1840,
      yearBuilt: 2004,
      stories: 1,
      _aiConfidence: 'medium',
    });
    mockAnthropicCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          suggestedFindings: {
            structures_inspected: 'Main single-family residential structure.',
            structure_type: 'Wood Frame',
            inspection_scope: 'Visible and readily accessible interior areas and exterior perimeter.',
          },
          confidence: 'medium',
        }),
      }],
    });

    const customerRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'customer-1',
        first_name: 'Van',
        last_name: 'Lee',
        address_line1: '8920 49th Ave E',
        city: 'Bradenton',
        state: 'FL',
        zip: '34211',
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'customers') return customerRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/wdo-intelligence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: 'customer-1', findings: {} }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.suggestedFindings.structures_inspected).toBe('Main single-family residential structure.');
      expect(body.suggestedFindings.structure_type).toBe('');
    });
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('wdo intelligence maps canonical wood-frame facts to dropdown value', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    lookupPropertyFromAITrio.mockResolvedValue({
      propertyType: 'Single Family',
      constructionMaterial: 'WOOD_FRAME',
      _aiConfidence: 'medium',
    });
    mockAnthropicCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          suggestedFindings: {
            structures_inspected: 'Main single-family residential structure.',
            structure_type: '',
            inspection_scope: 'Visible and readily accessible interior areas and exterior perimeter.',
          },
          confidence: 'medium',
        }),
      }],
    });

    const customerRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'customer-1',
        first_name: 'Van',
        last_name: 'Lee',
        address_line1: '8920 49th Ave E',
        city: 'Bradenton',
        state: 'FL',
        zip: '34211',
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'customers') return customerRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/wdo-intelligence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: 'customer-1', findings: {} }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.suggestedFindings.structures_inspected).toBe('Main single-family residential structure.');
      expect(body.suggestedFindings.structure_type).toBe('Wood Frame');
    });
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('wdo intelligence maps brick construction facts to the masonry dropdown value', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    lookupPropertyFromAITrio.mockResolvedValue({
      propertyType: 'Single Family',
      constructionMaterial: 'BRICK',
      _aiConfidence: 'medium',
    });
    mockAnthropicCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          suggestedFindings: {
            structures_inspected: 'Main single-family residential structure.',
            structure_type: '',
            inspection_scope: 'Visible and readily accessible interior areas and exterior perimeter.',
          },
          confidence: 'medium',
        }),
      }],
    });

    const customerRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'customer-1',
        first_name: 'Van',
        last_name: 'Lee',
        address_line1: '8920 49th Ave E',
        city: 'Bradenton',
        state: 'FL',
        zip: '34211',
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'customers') return customerRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/wdo-intelligence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: 'customer-1', findings: {} }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.suggestedFindings.structure_type).toBe('CMU / Concrete Masonry Unit');
    });
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('wdo intelligence requires technician project or assigned visit scope', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'customer-1' }),
    });
    db.mockImplementation((table) => {
      if (table === 'customers') return customerRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/wdo-intelligence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech-1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: 'customer-1',
          property_address: '8920 49th Ave E Bradenton, FL 34211',
          findings: {},
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Technician projects must be linked to an assigned visit');
      expect(lookupPropertyFromAITrio).not.toHaveBeenCalled();
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
    });
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('wdo intelligence rejects oversized prior-treatment photos before AI review', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    db.mockImplementation((table) => {
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const fd = new FormData();
      fd.append('property_address', '8920 49th Ave E Bradenton, FL 34211');
      fd.append('findings', JSON.stringify({ property_address: '' }));
      fd.append('previous_treatment_photo', new Blob([new Uint8Array(5 * 1024 * 1024)], { type: 'image/png' }), 'large.png');

      const res = await fetch(`${baseUrl}/admin/projects/wdo-intelligence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
        body: fd,
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/too large/i);
      expect(lookupPropertyFromAITrio).not.toHaveBeenCalled();
      expect(mockAnthropicCreate).not.toHaveBeenCalled();
    });
    delete process.env.ANTHROPIC_API_KEY;
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
    const projectColumnInfo = chain({
      columnInfo: jest.fn().mockResolvedValue({}),
    });
    const sequenceRead = chain();
    const persistDelivery = chain();
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
    const projectQueries = [projectRead, projectColumnInfo, markSent, updatedProjectRead, sequenceRead, persistDelivery];
    db.mockImplementation((table) => {
      if (table === 'projects') return projectQueries.shift();
      if (table === 'customers') return customerRead;
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

  test('send uses the project report email template when email is available', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        project_type: 'rodent_exclusion',
        project_date: '2026-05-06',
        title: 'Rodent report',
        findings: { entry_points_found: 'Garage door seal' },
        recommendations: 'Seal entry points and monitor traps.',
        report_token: 'abcdef123456abcdef123456abcdef12',
        sent_at: null,
      }),
    });
    const markToken = chain();
    const updatedProjectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        project_type: 'rodent_exclusion',
        project_date: '2026-05-06',
        title: 'Rodent report',
        findings: { entry_points_found: 'Garage door seal' },
        recommendations: 'Seal entry points and monitor traps.',
        report_token: 'abcdef123456abcdef123456abcdef12',
        sent_at: null,
      }),
    });
    const projectColumnInfo = chain({
      columnInfo: jest.fn().mockResolvedValue({}),
    });
    const sequenceRead = chain();
    const persistDelivery = chain();
    const activityInsert = chain();
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'customer-1',
        first_name: 'Van',
        last_name: 'Lee',
        phone: null,
        email: 'van@example.com',
      }),
    });
    const projectQueries = [projectRead, projectColumnInfo, markToken, updatedProjectRead, sequenceRead, persistDelivery];
    db.mockImplementation((table) => {
      if (table === 'projects') return projectQueries.shift();
      if (table === 'customers') return customerRead;
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
      expect(body.channels.email).toEqual({ ok: true, messageId: 'sg-report' });
      expect(ProjectEmail.sendProjectReportReady).toHaveBeenCalledWith(expect.objectContaining({
        project: expect.objectContaining({ id: 'project-1' }),
        customer: expect.objectContaining({ email: 'van@example.com' }),
        reportUrl: expect.stringContaining('/report/project/'),
        isResend: false,
      }));
      expect(persistDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
        delivery_status: 'sent',
        status: 'sent',
      }));
    });
  });

  test('admin can send a project prep guide email', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        project_type: 'rodent_exclusion',
      }),
    });
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'customer-1',
        first_name: 'Van',
        email: 'van@example.com',
      }),
    });
    const activityInsert = chain();
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'customers') return customerRead;
      if (table === 'activity_log') return activityInsert;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-prep-guide`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ sent: true, template_key: 'prep.rodent' });
      expect(ProjectEmail.sendPrepGuide).toHaveBeenCalledWith(expect.objectContaining({
        templateKey: 'prep.rodent',
        project: expect.objectContaining({ id: 'project-1' }),
        customer: expect.objectContaining({ id: 'customer-1' }),
      }));
      expect(activityInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        action: 'project_prep_guide_sent',
        metadata: expect.objectContaining({
          project_id: 'project-1',
          template_key: 'prep.rodent',
          channel: 'email',
        }),
      }));
    });
  });

  test('prep guide route rejects project types without a mapped guide', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        project_type: 'bed_bug',
      }),
    });
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({ id: 'customer-1', email: 'van@example.com' }),
    });
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'customers') return customerRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-prep-guide`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/No prep guide/);
      expect(ProjectEmail.sendPrepGuide).not.toHaveBeenCalled();
    });
  });

  test('admin can send a project portal invite email', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        project_type: 'pest_inspection',
      }),
    });
    const customerRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'customer-1',
        first_name: 'Van',
        email: 'van@example.com',
      }),
    });
    const activityInsert = chain();
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'customers') return customerRead;
      if (table === 'activity_log') return activityInsert;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/projects/project-1/send-portal-invite`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin' },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ sent: true, template_key: 'portal.invite' });
      expect(ProjectEmail.sendPortalInvite).toHaveBeenCalledWith(expect.objectContaining({
        project: expect.objectContaining({ id: 'project-1' }),
        customer: expect.objectContaining({ id: 'customer-1' }),
      }));
      expect(activityInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        action: 'project_portal_invite_sent',
        metadata: expect.objectContaining({
          project_id: 'project-1',
          template_key: 'portal.invite',
          channel: 'email',
        }),
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
    db.mockImplementation((table) => {
      if (table === 'projects') return projectRead;
      if (table === 'customers') return customerRead;
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
        'wdo_property_address',
        'wdo_inspection_scope',
      ]));
      expect(body.missing.map(item => item.key)).not.toContain('photos');
      expect(body.missing.map(item => item.key)).not.toContain('recommendations');
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
