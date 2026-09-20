/**
 * admin-careers.js — stage-preview shape, PATCH .../status notify/resend
 * behavior: mint-once token, same-status no-send, resend sends without a
 * status_history entry, and gate-off reports sent:{sms:'disabled',
 * email:'disabled'}. interview_token itself never rides in a response.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.techRole = 'admin';
    next();
  },
}));

const mockIsEnabled = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...args) => mockIsEnabled(...args) }));

const mockChannelEligibility = jest.fn(async () => ({
  sms: { available: true, to: '(941) ***-0142', reason: null },
  email: { available: true, to: 'j***@example.com', reason: null },
}));
const mockBuildVars = jest.fn((app) => ({ first_name: 'Jane', interview_url: app.interview_token ? `https://x/${app.interview_token}` : '' }));
const mockRenderStageSmsBody = jest.fn(async () => ({ body: 'Hi Jane, pick a time: [interview link]', templateKey: 'job_interview_invite' }));
const mockBuildEmailContent = jest.fn(() => ({ subject: "Let's set up your interview with Waves", text: 'Pick a time: [interview link]' }));
const mockInterviewUrlFor = jest.fn((token) => (token ? `https://portal.wavespestcontrol.com/careers/interview/${token}` : null));
const mockBodyKeepsInterviewLink = jest.fn((body, url) => body.includes('[interview link]') || (!!url && body.includes(url)));
const mockSubstituteInterviewLinkPlaceholder = jest.fn((body, url) => body.split('[interview link]').join(url));
const mockSendStageComms = jest.fn(async () => ({ sms: 'sent', email: 'sent' }));
const mockErrorSummary = jest.fn((err) => (err && err.message) || 'error');

jest.mock('../services/recruiting-comms', () => ({
  channelEligibility: (...args) => mockChannelEligibility(...args),
  buildVars: (...args) => mockBuildVars(...args),
  renderStageSmsBody: (...args) => mockRenderStageSmsBody(...args),
  buildEmailContent: (...args) => mockBuildEmailContent(...args),
  interviewUrlFor: (...args) => mockInterviewUrlFor(...args),
  bodyKeepsInterviewLink: (...args) => mockBodyKeepsInterviewLink(...args),
  substituteInterviewLinkPlaceholder: (...args) => mockSubstituteInterviewLinkPlaceholder(...args),
  sendStageComms: (...args) => mockSendStageComms(...args),
  errorSummary: (...args) => mockErrorSummary(...args),
  INTERVIEW_LINK_PLACEHOLDER: '[interview link]',
}));

function makeDb() {
  let rows = [];
  function tableApi(table) {
    if (table !== 'job_applications') throw new Error(`unexpected table ${table}`);
    let whereCond = {};
    const builder = {
      where(cond) { whereCond = { ...whereCond, ...cond }; return builder; },
      forUpdate() { return builder; },
      first: () => Promise.resolve((() => {
        const row = rows.find((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v));
        return row ? { ...row } : undefined;
      })()),
      update(payload) {
        return {
          returning: () => {
            const resolved = { ...payload };
            if (typeof resolved.status_history === 'string') {
              try { resolved.status_history = JSON.parse(resolved.status_history); } catch { /* noop */ }
            }
            const matches = rows.filter((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v));
            for (const r of matches) Object.assign(r, resolved);
            return Promise.resolve(matches.map((r) => ({ ...r })));
          },
        };
      },
    };
    return builder;
  }
  const db = jest.fn((table) => tableApi(table));
  db.transaction = async (fn) => fn(tableApi);
  db.__rows = () => rows;
  db.__setRows = (r) => { rows = r; };
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
}
const mockDb = makeDb();
jest.mock('../models/db', () => mockDb);

const express = require('express');
const adminCareersRouter = require('../routes/admin-careers');

function appRow(overrides = {}) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    role: 'technician',
    status: 'reviewed',
    language: 'en',
    contact_snapshot: { name: 'Jane Doe', phone: '9415550142', email: 'jane@example.com' },
    interview_token: null,
    interview_token_created_at: null,
    interview_mode: null,
    interview_at: null,
    interview_end_at: null,
    interview_booked_at: null,
    sms_consent: false,
    comms_history: [],
    status_history: [],
    ai_score: null,
    ai_recommendation: null,
    ai_screen: null,
    created_at: new Date('2027-01-01T00:00:00.000Z'),
    updated_at: new Date('2027-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

let server;
let base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/careers', adminCareersRouter);
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockChannelEligibility.mockResolvedValue({
    sms: { available: true, to: '(941) ***-0142', reason: null },
    email: { available: true, to: 'j***@example.com', reason: null },
  });
  mockBuildVars.mockImplementation((app) => ({ first_name: 'Jane', interview_url: app.interview_token ? `https://x/${app.interview_token}` : '' }));
  mockRenderStageSmsBody.mockResolvedValue({ body: 'Hi Jane, pick a time: [interview link]', templateKey: 'job_interview_invite' });
  mockBuildEmailContent.mockReturnValue({ subject: "Let's set up your interview with Waves", text: 'Pick a time: [interview link]' });
  mockInterviewUrlFor.mockImplementation((token) => (token ? `https://portal.wavespestcontrol.com/careers/interview/${token}` : null));
  mockBodyKeepsInterviewLink.mockImplementation((body, url) => body.includes('[interview link]') || (!!url && body.includes(url)));
  mockSubstituteInterviewLinkPlaceholder.mockImplementation((body, url) => body.split('[interview link]').join(url));
  mockSendStageComms.mockResolvedValue({ sms: 'sent', email: 'sent' });
  mockDb.__setRows([]);
});

async function patch(id, payload) {
  const res = await fetch(`${base}/api/admin/careers/${id}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

describe('GET /:id/stage-preview', () => {
  test('non-interview status -> templated:false, bodies null', async () => {
    mockDb.__setRows([appRow()]);
    const res = await fetch(`${base}/api/admin/careers/aaaaaaaa-0000-4000-8000-000000000001/stage-preview?status=offer`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'offer', templated: false, sms_body: null, email_subject: null, email_body: null, interview_url: null });
  });

  test('interview status with no token yet -> placeholder body, interview_url null, never mints', async () => {
    mockDb.__setRows([appRow()]);
    const res = await fetch(`${base}/api/admin/careers/aaaaaaaa-0000-4000-8000-000000000001/stage-preview?status=interview`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.templated).toBe(true);
    expect(body.interview_url).toBeNull();
    expect(body.sms_body).toContain('[interview link]');
    expect(mockDb.__rows()[0].interview_token).toBeNull(); // never minted by preview
  });

  test('interview status with an existing token -> real interview_url', async () => {
    mockDb.__setRows([appRow({ interview_token: 'a'.repeat(64) })]);
    const res = await fetch(`${base}/api/admin/careers/aaaaaaaa-0000-4000-8000-000000000001/stage-preview?status=interview`);
    const body = await res.json();
    expect(body.interview_url).toBe(`https://portal.wavespestcontrol.com/careers/interview/${'a'.repeat(64)}`);
  });

  test('sending_enabled reflects the gate', async () => {
    mockIsEnabled.mockReturnValue(false);
    mockDb.__setRows([appRow()]);
    const res = await fetch(`${base}/api/admin/careers/aaaaaaaa-0000-4000-8000-000000000001/stage-preview?status=interview`);
    const body = await res.json();
    expect(body.sending_enabled).toBe(false);
  });
});

describe('PATCH /:id/status', () => {
  test('same status + no note + no resend -> no-op, sent not_requested', async () => {
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    const { status, body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'reviewed' });
    expect(status).toBe(200);
    expect(body.sent).toEqual({ sms: 'not_requested', email: 'not_requested' });
    expect(mockDb.__rows()[0].status_history).toHaveLength(0);
    expect(mockSendStageComms).not.toHaveBeenCalled();
  });

  test('status change to interview with notify mints a token once; response never carries the raw token', async () => {
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    const { status, body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', {
      status: 'interview',
      notify: { sms: true, email: true },
    });
    expect(status).toBe(200);
    expect(body.application.interview_token).toBeUndefined();
    expect(body.application.interview_url).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/careers\/interview\/[0-9a-f]{64}$/);
    expect(body.sent).toEqual({ sms: 'sent', email: 'sent' });

    const row = mockDb.__rows()[0];
    expect(row.status).toBe('interview');
    expect(row.status_history).toHaveLength(1);
    expect(row.interview_token).toMatch(/^[0-9a-f]{64}$/);
    const firstToken = row.interview_token;

    // A SECOND patch (e.g. a note-only edit) must reuse the same token, not mint again.
    const second = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'interview', note: 'still interviewing' });
    expect(second.status).toBe(200);
    expect(mockDb.__rows()[0].interview_token).toBe(firstToken);
  });

  test('resend:true on an already-interview application sends without a new status_history entry', async () => {
    mockDb.__setRows([appRow({ status: 'interview', interview_token: 'b'.repeat(64) })]);
    const { status, body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', {
      status: 'interview', resend: true, notify: { sms: true, email: false },
    });
    expect(status).toBe(200);
    expect(body.sent.sms).toBe('sent');
    expect(mockDb.__rows()[0].status_history).toHaveLength(0); // no history entry for resend
    expect(mockSendStageComms).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
      'interview_invite',
      expect.objectContaining({ sms: true, email: false, by: 'tech-1' }),
    );
  });

  test('re-entering interview from a non-blocking stage clears the stale booking (slot was released)', async () => {
    mockDb.__setRows([appRow({
      status: 'rejected', interview_token: 'e'.repeat(64), interview_mode: 'phone',
      interview_at: '2027-03-16T20:00:00.000Z', interview_end_at: '2027-03-16T20:30:00.000Z',
      interview_booked_at: '2027-03-01T15:00:00.000Z',
    })]);
    const { status } = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'interview' });
    expect(status).toBe(200);
    const row = mockDb.__rows()[0];
    expect(row.status).toBe('interview');
    expect(row.interview_booked_at).toBeNull();
    expect(row.interview_at).toBeNull();
    expect(row.interview_mode).toBeNull();
    expect(row.interview_token).toBe('e'.repeat(64)); // the link itself is kept
  });

  test('rejected -> offer also clears the stale booking (offer blocks a slot too)', async () => {
    mockDb.__setRows([appRow({
      status: 'rejected', interview_token: 'g'.repeat(64), interview_mode: 'in_person',
      interview_at: '2027-03-16T20:00:00.000Z', interview_booked_at: '2027-03-01T15:00:00.000Z',
    })]);
    const { status } = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'offer' });
    expect(status).toBe(200);
    expect(mockDb.__rows()[0].interview_booked_at).toBeNull();
    expect(mockDb.__rows()[0].interview_at).toBeNull();
  });

  test('offer -> interview keeps the booking (offer still blocks the slot)', async () => {
    mockDb.__setRows([appRow({
      status: 'offer', interview_token: 'f'.repeat(64), interview_mode: 'phone',
      interview_at: '2027-03-16T20:00:00.000Z', interview_booked_at: '2027-03-01T15:00:00.000Z',
    })]);
    const { status } = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'interview' });
    expect(status).toBe(200);
    expect(mockDb.__rows()[0].interview_booked_at).toBe('2027-03-01T15:00:00.000Z');
  });

  test('stage moved out of Interview between commit and send -> nothing sent, sent:{stale}', async () => {
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    // Simulate another admin rejecting the candidate right after our commit:
    // the post-commit authority re-read sees 'rejected'.
    const rows = mockDb.__rows();
    const originalTableApi = mockDb.getMockImplementation();
    let firstReadDone = false;
    mockDb.mockImplementation((table) => {
      const api = originalTableApi(table);
      if (table === 'job_applications') {
        const origFirst = api.first;
        api.first = async (...cols) => {
          const r = await origFirst.call(api, ...cols);
          if (r && cols.includes('interview_token') && !firstReadDone) { firstReadDone = true; return { ...r, status: 'rejected' }; }
          return r;
        };
      }
      return api;
    });
    const { status, body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'interview', notify: { sms: true, email: true } });
    mockDb.mockImplementation(originalTableApi);
    expect(status).toBe(200);
    expect(body.sent).toEqual({ sms: 'stale', email: 'stale' });
    expect(mockSendStageComms).not.toHaveBeenCalled();
    expect(rows[0].status).toBe('interview'); // the committed transition stands
  });

  test('resend WITH a note keeps the note as a same-status history entry', async () => {
    mockDb.__setRows([appRow({ status: 'interview', interview_token: 'h'.repeat(64) })]);
    const { status } = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'interview', resend: true, note: 'resent after voicemail', notify: { sms: true } });
    expect(status).toBe(200);
    const row = mockDb.__rows()[0];
    expect(row.status_history).toHaveLength(1);
    expect(row.status_history[0]).toMatchObject({ from: 'interview', to: 'interview', note: 'resent after voicemail' });
  });

  test('same status + note (no resend) -> history entry appended, nothing sent', async () => {
    mockDb.__setRows([appRow({ status: 'interview', interview_token: 'c'.repeat(64) })]);
    const { status, body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'interview', note: 'left a voicemail' });
    expect(status).toBe(200);
    expect(body.sent).toEqual({ sms: 'not_requested', email: 'not_requested' });
    expect(mockDb.__rows()[0].status_history).toHaveLength(1);
    expect(mockSendStageComms).not.toHaveBeenCalled();
  });

  test('gate OFF with notify -> transition happens, nothing sent, sent:{sms:disabled,email:disabled}', async () => {
    mockIsEnabled.mockReturnValue(false);
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    const { status, body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'interview', notify: { sms: true, email: true } });
    expect(status).toBe(200);
    expect(body.sent).toEqual({ sms: 'disabled', email: 'disabled' });
    // only the requested channel reads 'disabled'
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    const only = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'interview', notify: { sms: true } });
    expect(only.body.sent).toEqual({ sms: 'disabled', email: 'not_requested' });
    expect(mockSendStageComms).not.toHaveBeenCalled();
    // Transition still happened.
    expect(mockDb.__rows()[0].status).toBe('interview');
    // No token minted while dark.
    expect(mockDb.__rows()[0].interview_token).toBeNull();
  });

  test('a SELECTED channel with an explicitly blank body is refused with 400 — never silently the default template (Codex r16 P2)', async () => {
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    const blankSms = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'interview', notify: { sms: true, sms_body: '   ' } });
    expect(blankSms.status).toBe(400);
    expect(blankSms.body.error).toMatch(/text message is empty/i);
    const blankEmail = await patch('aaaaaaaa-0000-4000-8000-000000000001', { status: 'interview', notify: { email: true, email_body: '' } });
    expect(blankEmail.status).toBe(400);
    expect(blankEmail.body.error).toMatch(/email body is empty/i);
    expect(mockDb.__rows()[0].status).toBe('reviewed'); // nothing committed
    expect(mockSendStageComms).not.toHaveBeenCalled();
  });

  test('an edited body missing the interview link is refused with 400, before any write', async () => {
    mockBodyKeepsInterviewLink.mockReturnValue(false);
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    const { status, body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', {
      status: 'interview',
      notify: { sms: true, sms_body: 'Come interview with us, no link here.' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/interview link/i);
    expect(mockDb.__rows()[0].status).toBe('reviewed'); // nothing committed
    expect(mockSendStageComms).not.toHaveBeenCalled();
  });

  test('a sendStageComms throw after the transition committed responds 200 with sent:failed for the requested channels, not a 500', async () => {
    mockSendStageComms.mockRejectedValue(new Error('sendgrid down'));
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    const { status, body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', {
      status: 'interview', notify: { sms: true, email: true },
    });
    expect(status).toBe(200);
    expect(body.sent).toEqual({ sms: 'failed', email: 'failed' });
    // The transition itself still committed — a comms failure never rolls
    // back or masks the status change.
    expect(body.application.status).toBe('interview');
    expect(mockDb.__rows()[0].status).toBe('interview');
  });

  test('sent:failed only covers channels actually requested; the other stays not_requested', async () => {
    mockSendStageComms.mockRejectedValue(new Error('sendgrid down'));
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    const { body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', {
      status: 'interview', notify: { sms: true, email: false },
    });
    expect(body.sent).toEqual({ sms: 'failed', email: 'not_requested' });
  });

  test('the response re-reads the row after sending, so comms_history appended by the send is included', async () => {
    mockSendStageComms.mockImplementation(async (app) => {
      const row = mockDb.__rows().find((r) => r.id === app.id);
      row.comms_history = [
        ...(row.comms_history || []),
        { at: new Date().toISOString(), channel: 'sms', outcome: 'sent' },
      ];
      return { sms: 'sent', email: 'sent' };
    });
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    const { body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', {
      status: 'interview', notify: { sms: true, email: true },
    });
    expect(body.application.comms_history).toHaveLength(1);
    expect(body.application.comms_history[0]).toMatchObject({ channel: 'sms', outcome: 'sent' });
  });

  test('a re-read failure after a successful send falls back to the pre-send committed row (not a 500)', async () => {
    mockSendStageComms.mockResolvedValue({ sms: 'sent', email: 'sent' });
    mockDb.__setRows([appRow({ status: 'reviewed' })]);
    // The route now reads the row twice outside the transaction: the pre-send
    // authority check (must succeed) and the post-send re-read (this one fails).
    const origImpl = mockDb.getMockImplementation();
    let outsideTrxReads = 0;
    mockDb.mockImplementation((table) => {
      outsideTrxReads += 1;
      if (outsideTrxReads === 2) { mockDb.mockImplementation(origImpl); throw new Error('re-read boom'); }
      return origImpl(table);
    });
    const { status, body } = await patch('aaaaaaaa-0000-4000-8000-000000000001', {
      status: 'interview', notify: { sms: true, email: true },
    });
    expect(status).toBe(200);
    expect(body.application.status).toBe('interview');
    expect(body.sent).toEqual({ sms: 'sent', email: 'sent' });
  });

  test('well-formed but unknown application id -> 404', async () => {
    mockDb.__setRows([]);
    const { status } = await patch('bbbbbbbb-0000-4000-8000-000000000099', { status: 'reviewed' });
    expect(status).toBe(404);
  });

  test('malformed id -> 404', async () => {
    const res = await fetch(`${base}/api/admin/careers/not-a-uuid/status`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'reviewed' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /:id detail never exposes the raw token', () => {
  test('opening the detail acknowledges the applicant reply rows (sms_log + messages) as read', async () => {
    mockDb.__setRows([appRow({ status: 'interview' })]);
    const updates = [];
    const origImpl = mockDb.getMockImplementation();
    mockDb.mockImplementation((table) => {
      if (table === 'sms_log' || table === 'messages') {
        const q = {};
        ['where', 'whereRaw', 'andWhere', 'orWhereNull'].forEach((m) => { q[m] = jest.fn(() => q); });
        q.update = jest.fn(async (payload) => { updates.push([table, payload]); return 1; });
        return q;
      }
      return origImpl(table);
    });
    const res = await fetch(`${base}/api/admin/careers/aaaaaaaa-0000-4000-8000-000000000001`, { headers: { Authorization: 'Bearer admin' } });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    mockDb.mockImplementation(origImpl);
    expect(updates.map(([t, p]) => [t, p.is_read])).toEqual([['sms_log', true], ['messages', true]]);
  });

  test('detail signs applicant attachments per ledger entry (reply_media)', async () => {
    const smsMedia = require('../services/sms-media');
    const spy = jest.spyOn(smsMedia, 'signMediaForClient').mockResolvedValue([{ key: 'k', url: 'https://signed/x', contentType: 'image/jpeg' }]);
    mockDb.__setRows([appRow({ status: 'interview', comms_history: [{ id: 'e-7', channel: 'sms', stage: 'applicant_reply', outcome: 'received', media: [{ key: 'k', contentType: 'image/jpeg' }] }] })]);
    const res = await fetch(`${base}/api/admin/careers/aaaaaaaa-0000-4000-8000-000000000001`, { headers: { Authorization: 'Bearer admin' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply_media).toEqual({ 'e-7': [{ key: 'k', url: 'https://signed/x', contentType: 'image/jpeg' }] });
    spy.mockRestore();
  });

  test('detail carries interview_url, not interview_token', async () => {
    mockDb.__setRows([appRow({ interview_token: 'd'.repeat(64), status: 'interview' })]);
    const res = await fetch(`${base}/api/admin/careers/aaaaaaaa-0000-4000-8000-000000000001`);
    const body = await res.json();
    expect(body.application.interview_token).toBeUndefined();
    expect(body.application.interview_url).toBe(`https://portal.wavespestcontrol.com/careers/interview/${'d'.repeat(64)}`);
  });

  test('no token yet -> interview_url null', async () => {
    mockDb.__setRows([appRow({ status: 'new' })]);
    const res = await fetch(`${base}/api/admin/careers/aaaaaaaa-0000-4000-8000-000000000001`);
    const body = await res.json();
    expect(body.application.interview_url).toBeNull();
  });
});
