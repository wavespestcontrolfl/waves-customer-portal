/**
 * server/services/recruiting-comms.js — template pick by language, the
 * STOP-line presence rule (job_application_received keeps it, the other
 * two stages don't), the edited-body interview-link guard, channel
 * eligibility, confirmation-SMS consent/prior-sent gating, the masked
 * comms_history entry shape, and gate-off behavior.
 */

const mockIsEnabled = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...args) => mockIsEnabled(...args) }));

const mockRenderSmsTemplate = jest.fn();
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: (...args) => mockRenderSmsTemplate(...args) }));

const mockSendCustomerMessage = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...args) => mockSendCustomerMessage(...args),
}));

const mockLoadSuppressionState = jest.fn(async () => ({}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: (...args) => mockLoadSuppressionState(...args),
}));

const mockSendOne = jest.fn(async () => ({ messageId: 'sg-1' }));
// Real DEFINITE_REJECTION_STATUSES semantics (sendgrid-mail.js) — a definite
// 4xx rejection is the only class that keeps a send 'failed'; everything
// else (no status, or a status outside this set) is ambiguous.
jest.mock('../services/twilio', () => ({ deriveOutboundNumber: jest.fn(async () => '+19415550199') }));
jest.mock('../services/sendgrid-mail', () => ({
  sendOne: (...args) => mockSendOne(...args),
  isDefiniteRejection: (err) => new Set([400, 401, 403, 404, 405, 413, 415, 422, 429]).has(Number(err && err.status)),
}));

const mockActiveSuppressionFor = jest.fn(async () => null);
jest.mock('../services/email-template-library', () => ({
  activeSuppressionFor: (...args) => mockActiveSuppressionFor(...args),
}));

function makeDb() {
  const tables = {};
  const db = jest.fn((table) => {
    tables[table] = tables[table] || [];
    const rows = tables[table];
    let whereCond = {};
    const builder = {
      where(cond) { whereCond = { ...whereCond, ...cond }; return builder; },
      whereRaw() { return builder; },
      insert(row) {
        const inserted = { id: row.id || `id-${rows.length + 1}`, ...row };
        rows.push(inserted);
        return { returning: async () => [inserted] };
      },
      update(payload) {
        const resolved = { ...payload };
        if (resolved.comms_history && resolved.comms_history.__raw) {
          const { sql, bindings } = resolved.comms_history;
          const matches = rows.filter((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v));
          if (/e->>'outcome' = \?/.test(sql)) {
            // Mirror reconcileCommsHistoryEntryByOutcome: (id, outcome, patch) triples.
            for (const r of matches) {
              r.comms_history = (r.comms_history || []).map((e) => {
                for (let i = 0; i < bindings.length; i += 3) {
                  if (e.id === bindings[i] && e.outcome === bindings[i + 1]) return { ...e, ...JSON.parse(bindings[i + 2]) };
                }
                return e;
              });
            }
          } else if (/jsonb_array_elements/.test(sql)) {
            // Mirror finalizeCommsHistoryEntry: patch the entry with this id in place.
            const [entryId, patchJson] = bindings;
            const patch = JSON.parse(patchJson);
            for (const r of matches) {
              r.comms_history = (r.comms_history || []).map((e) => (e.id === entryId ? { ...e, ...patch } : e));
            }
          } else {
            // Mirror the real COALESCE(...) || jsonb append the raw call does.
            const appended = JSON.parse(bindings[0]);
            for (const r of matches) {
              r.comms_history = [...(r.comms_history || []), ...appended];
            }
          }
          delete resolved.comms_history;
        }
        const matches = rows.filter((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v));
        for (const r of matches) Object.assign(r, resolved);
        const promise = Promise.resolve(matches.length);
        promise.catch = (fn) => Promise.resolve(matches.length).catch(fn);
        return promise;
      },
      first: () => Promise.resolve(rows.find((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v))),
    };
    return builder;
  });
  db.raw = jest.fn((sql, bindings) => ({ __raw: true, sql, bindings }));
  db.schema = { hasTable: jest.fn(async () => true) };
  db.__tables = tables;
  return db;
}
const mockDb = makeDb();
jest.mock('../models/db', () => mockDb);

const RecruitingComms = require('../services/recruiting-comms');
const { lintComms } = require('../services/comms-lint');
const migration = require('../models/migrations/20260920000001_job_applications_interview_comms');

function baseApp(overrides = {}) {
  return {
    id: 'app-1',
    language: 'en',
    contact_snapshot: { name: 'Jane Doe', phone: '9415550142', email: 'jane@example.com' },
    interview_token: null,
    interview_mode: null,
    interview_at: null,
    sms_consent: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockLoadSuppressionState.mockResolvedValue({});
  mockSendOne.mockResolvedValue({ messageId: 'sg-1' });
  mockActiveSuppressionFor.mockResolvedValue(null);
  mockDb.__tables.job_applications = [];
  mockDb.__tables.email_messages = [];
});

describe('STOP-line presence rule (seeded copy)', () => {
  test('job_application_received (en + es) keeps the STOP line', () => {
    for (const key of ['job_application_received', 'job_application_received_es']) {
      const tpl = migration._TEMPLATES.find((t) => t.template_key === key);
      const result = lintComms(tpl.body, { channel: 'sms', audience: 'applicant', stopExpected: true });
      expect(result.failures.filter((f) => f.rule.includes('stop'))).toEqual([]);
      expect(tpl.body).toMatch(/Reply STOP to opt out\./);
    }
  });

  test('job_interview_invite and job_interview_confirmation (en + es) carry NO STOP line', () => {
    for (const base of ['job_interview_invite', 'job_interview_confirmation']) {
      for (const key of [base, `${base}_es`]) {
        const tpl = migration._TEMPLATES.find((t) => t.template_key === key);
        const result = lintComms(tpl.body, { channel: 'sms', audience: 'applicant', stopExpected: false });
        expect(result.failures.filter((f) => f.rule.includes('stop'))).toEqual([]);
        expect(tpl.body).not.toMatch(/Reply STOP/i);
      }
    }
  });
});

describe('template pick by language', () => {
  test('renders the _es key when language is es and the row exists', async () => {
    mockRenderSmsTemplate.mockImplementation(async (key) => (key === 'job_application_received_es' ? 'cuerpo es' : undefined));
    const app = baseApp({ language: 'es' });
    const result = await RecruitingComms.renderStageSmsBody(app, 'application_received', { first_name: 'Jane' });
    expect(result).toEqual({ body: 'cuerpo es', templateKey: 'job_application_received_es' });
    expect(mockRenderSmsTemplate).toHaveBeenCalledWith('job_application_received_es', expect.anything(), expect.anything());
  });

  test('falls back to the en key when the _es row does not exist', async () => {
    mockRenderSmsTemplate.mockImplementation(async (key) => (key === 'job_application_received' ? 'english body' : undefined));
    const app = baseApp({ language: 'es' });
    const result = await RecruitingComms.renderStageSmsBody(app, 'application_received', { first_name: 'Jane' });
    expect(result).toEqual({ body: 'english body', templateKey: 'job_application_received' });
  });

  test('en applications never try the _es key', async () => {
    mockRenderSmsTemplate.mockResolvedValue('english body');
    const app = baseApp({ language: 'en' });
    await RecruitingComms.renderStageSmsBody(app, 'application_received', { first_name: 'Jane' });
    expect(mockRenderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(mockRenderSmsTemplate).toHaveBeenCalledWith('job_application_received', expect.anything(), expect.anything());
  });
});

describe('edited-body interview-link guard', () => {
  const url = 'https://portal.wavespestcontrol.com/careers/interview/abc123';

  test('accepts the placeholder', () => {
    expect(RecruitingComms.bodyKeepsInterviewLink(`Pick a time: ${RecruitingComms.INTERVIEW_LINK_PLACEHOLDER}`, url)).toBe(true);
  });

  test('accepts the real interview url', () => {
    expect(RecruitingComms.bodyKeepsInterviewLink(`Pick a time: ${url}`, url)).toBe(true);
  });

  test('rejects a body with neither', () => {
    expect(RecruitingComms.bodyKeepsInterviewLink('Pick a time, no link here.', url)).toBe(false);
  });

  test('substitutePlaceholder replaces the placeholder with the real url', () => {
    const out = RecruitingComms.substituteInterviewLinkPlaceholder(
      `Pick a time: ${RecruitingComms.INTERVIEW_LINK_PLACEHOLDER}`, url,
    );
    expect(out).toBe(`Pick a time: ${url}`);
  });
});

describe('channel eligibility', () => {
  test('no email on file -> email unavailable, reason no_email', async () => {
    const app = baseApp({ contact_snapshot: { name: 'Jane Doe', phone: '9415550142', email: null } });
    const result = await RecruitingComms.channelEligibility(app);
    expect(result.email).toEqual({ available: false, to: null, reason: 'no_email' });
  });

  test('no phone on file -> sms unavailable, reason no_phone', async () => {
    const app = baseApp({ contact_snapshot: { name: 'Jane Doe', phone: null, email: 'jane@example.com' } });
    const result = await RecruitingComms.channelEligibility(app);
    expect(result.sms).toEqual({ available: false, to: null, reason: 'no_phone' });
  });

  test('a phone on the suppression list -> sms unavailable, reason suppressed', async () => {
    mockLoadSuppressionState.mockResolvedValue({ suppression: { reason: 'opt_out_keyword' } });
    const app = baseApp();
    const result = await RecruitingComms.channelEligibility(app);
    expect(result.sms.available).toBe(false);
    expect(result.sms.reason).toBe('suppressed');
  });

  test('phone present and not suppressed -> sms available, masked', async () => {
    const app = baseApp();
    const result = await RecruitingComms.channelEligibility(app);
    expect(result.sms).toEqual({ available: true, to: '(941) ***-0142', reason: null });
  });
});

describe('confirmation SMS eligibility (applicant-triggered)', () => {
  test('eligible when sms_consent is true', () => {
    expect(RecruitingComms.confirmationSmsEligible({ sms_consent: true }, {})).toBe(true);
  });
  test('eligible with a prior sent sms even without consent (owner already texted this thread)', () => {
    expect(RecruitingComms.confirmationSmsEligible({ sms_consent: false }, { priorSmsSent: true })).toBe(true);
  });
  test('not eligible with neither', () => {
    expect(RecruitingComms.confirmationSmsEligible({ sms_consent: false }, { priorSmsSent: false })).toBe(false);
  });
});

describe('history entry masking', () => {
  test('sms entry masks the phone', () => {
    const entry = RecruitingComms.historyEntry({
      stage: 'application_received', channel: 'sms', to: '9415550142', outcome: 'sent', code: null, body: 'hi', by: 'system',
    });
    expect(entry.to).toBe('(941) ***-0142');
    expect(entry).toMatchObject({ stage: 'application_received', channel: 'sms', outcome: 'sent', by: 'system' });
    expect(typeof entry.at).toBe('string');
  });

  test('email entry masks the address', () => {
    const entry = RecruitingComms.historyEntry({
      stage: 'application_received', channel: 'email', to: 'jane@example.com', outcome: 'sent', code: null, body: 'hi', by: 'system',
    });
    expect(entry.to).toBe('j***@example.com');
  });
});

describe('maskPhone / maskEmail', () => {
  test('maskPhone formats as (area) ***-last4', () => {
    expect(RecruitingComms.maskPhone('9415550142')).toBe('(941) ***-0142');
    expect(RecruitingComms.maskPhone('+19415550142')).toBe('(941) ***-0142');
  });
  test('maskEmail keeps the first local char and the domain', () => {
    expect(RecruitingComms.maskEmail('jane@example.com')).toBe('j***@example.com');
  });
});

describe('sendStageComms', () => {
  test('gate OFF -> nothing sent, outcome disabled for every requested channel', async () => {
    mockIsEnabled.mockReturnValue(false);
    const app = baseApp();
    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: true, by: 'system' });
    expect(result).toEqual({ sms: 'disabled', email: 'disabled' });
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockSendOne).not.toHaveBeenCalled();
  });

  test('SMS sent -> sendCustomerMessage called with audience applicant + transactional_allowed, history appended', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane, thanks for applying.');
    mockSendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted' });
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false, by: 'system' });

    expect(result.sms).toBe('sent');
    expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '9415550142',
      channel: 'sms',
      audience: 'applicant',
      purpose: 'application_received',
      entryPoint: 'recruiting_comms',
      identityTrustLevel: 'phone_provided_unverified',
      consentBasis: { status: 'transactional_allowed', source: 'job_application' },
    }));
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history).toHaveLength(1);
    expect(stored.comms_history[0]).toMatchObject({ channel: 'sms', outcome: 'sent', to: '(941) ***-0142' });
  });

  test('SMS blocked -> outcome blocked, history records the block code', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane.');
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SMS_OPTED_OUT' });
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false });
    expect(result.sms).toBe('blocked');
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[0]).toMatchObject({ outcome: 'blocked', code: 'SMS_OPTED_OUT' });
  });

  test('disabled/missing template -> outcome skipped, code template_disabled, sendCustomerMessage never called', async () => {
    mockRenderSmsTemplate.mockResolvedValue(undefined);
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false });
    expect(result.sms).toBe('skipped');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[0]).toMatchObject({ outcome: 'skipped', code: 'template_disabled' });
  });

  test('no phone on file -> sms skipped without attempting a send', async () => {
    const app = baseApp({ contact_snapshot: { name: 'Jane Doe', phone: null, email: 'jane@example.com' } });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false });
    expect(result.sms).toBe('skipped');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('email sent -> sendOne called, email_messages row logged as sent', async () => {
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: false, email: true, by: 'system' });

    expect(result.email).toBe('sent');
    expect(mockSendOne).toHaveBeenCalledWith(expect.objectContaining({ to: 'jane@example.com', subject: 'We received your application' }));
    // Tracked handoff + no click tracking on a body that carries a bearer link.
    const sendArgs = mockSendOne.mock.calls[0][0];
    expect(sendArgs.disableTracking).toBe(true);
    expect(sendArgs.customArgs).toMatchObject({ send_attempt_token: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const row = mockDb.__tables.email_messages.find((r) => r.recipient_id === 'app-1');
    expect(row.status).toBe('sent');
    expect(row.recipient_type).toBe('job_application');
  });

  test('email send failure (definite 4xx) -> outcome failed, email_messages row marked failed', async () => {
    mockSendOne.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: false, email: true });
    expect(result.email).toBe('failed');
    const row = mockDb.__tables.email_messages.find((r) => r.recipient_id === 'app-1');
    expect(row.status).toBe('failed');
  });

  test('email send failure (5xx, ambiguous) -> outcome uncertain, ledger status uncertain (Codex P2)', async () => {
    mockSendOne.mockRejectedValue(Object.assign(new Error('service unavailable'), { status: 503 }));
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: false, email: true });
    expect(result.email).toBe('uncertain');
    const row = mockDb.__tables.email_messages.find((r) => r.recipient_id === 'app-1');
    expect(row.status).toBe('uncertain');
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[0]).toMatchObject({ channel: 'email', outcome: 'uncertain' });
  });

  test('email send failure (network error, no status at all) -> outcome uncertain, not failed', async () => {
    mockSendOne.mockRejectedValue(new Error('ECONNRESET'));
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: false, email: true });
    expect(result.email).toBe('uncertain');
    const row = mockDb.__tables.email_messages.find((r) => r.recipient_id === 'app-1');
    expect(row.status).toBe('uncertain');
  });

  test('email_messages ledger insert failure refuses the send (Codex P1) — no sendOne call, no untracked send', async () => {
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    // Override just the FIRST db() call (the email_messages insert) to throw
    // synchronously, as a real Knex insert failure would.
    mockDb.mockImplementationOnce((table) => {
      if (table !== 'email_messages') throw new Error(`unexpected table ${table} before the ledger insert`);
      return { insert: () => { throw new Error('insert boom'); } };
    });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: false, email: true });

    expect(result.email).toBe('failed');
    expect(mockSendOne).not.toHaveBeenCalled();
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[0]).toMatchObject({ channel: 'email', outcome: 'failed', code: 'ledger_write_failed' });
  });

  test('email suppressed -> outcome blocked, code email_suppressed, sendOne never called, ledger row blocked', async () => {
    mockActiveSuppressionFor.mockResolvedValue({ suppression_type: 'bounce', group_key: null });
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: false, email: true });

    expect(result.email).toBe('blocked');
    expect(mockSendOne).not.toHaveBeenCalled();
    expect(mockActiveSuppressionFor).toHaveBeenCalledWith(
      expect.objectContaining({ send_stream: 'recruiting_operational', suppression_group_key: 'recruiting_operational' }),
      'jane@example.com',
      'recruiting_operational',
    );
    const row = mockDb.__tables.email_messages.find((r) => r.recipient_id === 'app-1');
    expect(row.status).toBe('blocked');
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[0]).toMatchObject({ channel: 'email', outcome: 'blocked', code: 'email_suppressed' });
  });

  test('email not suppressed -> sendOne is called and the message sends', async () => {
    mockActiveSuppressionFor.mockResolvedValue(null);
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: false, email: true });

    expect(result.email).toBe('sent');
    expect(mockSendOne).toHaveBeenCalledTimes(1);
  });

  test('sendCustomerMessage deliveryOutcome uncertain -> outcome uncertain (not failed)', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane.');
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: false, deliveryOutcome: 'uncertain' });
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false });

    expect(result.sms).toBe('uncertain');
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[0]).toMatchObject({ outcome: 'uncertain' });
  });
});

describe('sendStageComms channel isolation', () => {
  test('an email-leg throw (suppression lookup) keeps the SMS outcome and still appends both entries', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane, pick a time: https://portal.example/careers/interview/x');
    mockSendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted' });
    mockActiveSuppressionFor.mockRejectedValueOnce(Object.assign(
      new Error('select * from email_suppressions where email = jane@example.com'),
      { name: 'error', code: '57014' },
    ));
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });

    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: true, by: 'tech-1' });

    expect(result.sms).toBe('sent');
    expect(result.email).toBe('failed');
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history.map((e) => [e.channel, e.outcome])).toEqual([['sms', 'sent'], ['email', 'failed']]);
    // the suppression-lookup failure is settled inside sendRawEmail now (fail closed, ledger 'failed')
    expect(stored.comms_history[1].code).toBe('suppression_lookup_failed');
  });
});

describe('sendStageComms pre-handoff evidence', () => {
  test('the SMS ledger entry exists BEFORE sendCustomerMessage is called, and is reconciled in place afterwards', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane.');
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    let seenAtHandoff = null;
    mockSendCustomerMessage.mockImplementation(async () => {
      seenAtHandoff = mockDb.__tables.job_applications.find((r) => r.id === 'app-1').comms_history.map((e) => e.outcome);
      return { sent: true, blocked: false, deliveryOutcome: 'accepted' };
    });
    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false, by: 'system' });
    expect(result.sms).toBe('sent');
    expect(seenAtHandoff).toEqual(['handoff']);
    // durable routing evidence rides the handoff entry
    expect(mockDb.__tables.job_applications.find((r) => r.id === 'app-1').comms_history[0]).toHaveProperty('from_number', '+19415550199');
    // the same resolved number is forced on the send itself
    expect(mockSendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({ fromNumber: '+19415550199' });
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history).toHaveLength(1); // reconciled in place, not appended twice
    expect(stored.comms_history[0]).toMatchObject({ channel: 'sms', outcome: 'sent', finalized_at: expect.any(String) });
  });

  test('a failed evidence write REFUSES the send (fail closed) and records evidence_write_failed', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane.');
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const original = mockDb.getMockImplementation();
    let updates = 0;
    mockDb.mockImplementation((table) => {
      const api = original(table);
      if (table === 'job_applications') {
        const origUpdate = api.update;
        api.update = (payload) => {
          updates += 1;
          if (updates === 1) { const p = Promise.reject(Object.assign(new Error('write boom'), { name: 'error', code: '57014' })); p.catch(() => {}); return p; }
          return origUpdate(payload);
        };
      }
      return api;
    });
    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false, by: 'system' });
    mockDb.mockImplementation(original);
    expect(result.sms).toBe('failed');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history.map((e) => [e.outcome, e.code])).toEqual([['failed', 'evidence_write_failed']]);
  });
});

describe('sendStageComms — send-window hold', () => {
  test('a retryable QUIET_HOURS/send-window hold queues the text on the scheduled-SMS rail as an applicant send', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane, thanks for applying.');
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, retryable: true, deferred: true, nextAllowedAt: '2027-03-17T12:00:00.000Z', code: 'SEND_WINDOW_CLOSED' });
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false, by: 'system' });
    expect(result.sms).toBe('deferred');
    const queued = (mockDb.__tables.sms_log || []).find((r) => r.status === 'scheduled');
    expect(queued).toMatchObject({ customer_id: null, direction: 'outbound', message_type: 'job_application_received', to_phone: '9415550142', from_phone: '+19415550199' });
    expect(queued.scheduled_for.toISOString()).toBe('2027-03-17T12:00:00.000Z');
    expect(JSON.parse(queued.metadata)).toMatchObject({ audience: 'applicant', purpose: 'application_received', job_application_id: 'app-1', consent_basis: { status: 'transactional_allowed' } });
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[0]).toMatchObject({ outcome: 'deferred', scheduled_for: '2027-03-17T12:00:00.000Z' });
  });
});

describe('reconcileCommsHistoryEntryByOutcome', () => {
  test('patches only the entry whose current outcome matches — never downgrades sent/uncertain evidence', async () => {
    mockDb.__tables.job_applications.push({ id: 'app-9', comms_history: [
      { id: 'a', outcome: 'deferred' }, { id: 'b', outcome: 'uncertain' }, { id: 'c', outcome: 'handoff' },
    ] });
    await RecruitingComms.reconcileCommsHistoryEntryByOutcome('app-9', 'a', { deferred: { outcome: 'blocked' }, handoff: { outcome: 'uncertain' } });
    await RecruitingComms.reconcileCommsHistoryEntryByOutcome('app-9', 'b', { deferred: { outcome: 'blocked' }, handoff: { outcome: 'uncertain' } });
    await RecruitingComms.reconcileCommsHistoryEntryByOutcome('app-9', 'c', { deferred: { outcome: 'blocked' }, handoff: { outcome: 'uncertain' } });
    const row = mockDb.__tables.job_applications.find((r) => r.id === 'app-9');
    expect(row.comms_history.map((e) => e.outcome)).toEqual(['blocked', 'uncertain', 'uncertain']);
  });
});

describe('sendStageComms — pipeline throw after provider acceptance', () => {
  test('err.providerOutcome with sent:true is preserved as sent; a bare throw is uncertain, never failed', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane.');
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockSendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('audit persistence failed'), { providerOutcome: { sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM9' } }));
    let result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false, by: 'system' });
    expect(result.sms).toBe('sent');
    let stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[0]).toMatchObject({ outcome: 'sent' });
    mockSendCustomerMessage.mockRejectedValueOnce(new Error('boom'));
    result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false, by: 'system' });
    expect(result.sms).toBe('uncertain');
    stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[1]).toMatchObject({ outcome: 'uncertain' });
  });
});

describe('sendStageComms — invite supersedes queued invites; suppression lookup failure settles the ledger', () => {
  test('a new interview invite retires invites still queued for the same application', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    mockSendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted' });
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.sms_log = [{ id: 'q1', status: 'scheduled', message_type: 'job_interview_invite', metadata: JSON.stringify({ job_application_id: 'app-1' }) }];
    await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: false, by: 'tech-1' });
    expect(mockDb.__tables.sms_log.find((r) => r.id === 'q1').status).toBe('cancelled');
  });

  test('a suppression lookup error fails closed and settles the owned ledger row as failed', async () => {
    mockActiveSuppressionFor.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'error', code: '57014' }));
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: false, email: true, by: 'system' });
    expect(result.email).toBe('failed');
    expect(mockSendOne).not.toHaveBeenCalled();
    const ledger = mockDb.__tables.email_messages.find((r) => r.recipient_id === 'app-1');
    expect(ledger.status).toBe('failed');
  });
});

describe('outbound choke point normalizes applicant SMS', () => {
  test('send-customer-message applies the text-only normalization to audience applicant', () => {
    const src = require('fs').readFileSync(require.resolve('../services/messaging/send-customer-message'), 'utf8');
    expect(src).toMatch(/\['customer', 'lead', 'applicant'\]\.includes\(sendInput\.audience\) && !sendHasMedia/);
  });
});

describe('owner reply on the recruiting rail', () => {
  test('sendOwnerReply sends job_owner_reply under purpose applicant_reply from the reply line, with handoff evidence', async () => {
    mockSendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted' });
    const app = baseApp({ interview_token: 'a'.repeat(64), status: 'interview' });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const res = await RecruitingComms.sendOwnerReply({ applicationId: 'app-1', body: 'See you Tuesday!', by: 'tech-1', fromNumber: '+19415550777' });
    expect(res.outcome).toBe('sent');
    const input = mockSendCustomerMessage.mock.calls[0][0];
    expect(input).toMatchObject({ audience: 'applicant', purpose: 'applicant_reply', entryPoint: 'recruiting_owner_reply', operatorInitiated: true });
    expect(input.metadata).toMatchObject({ original_message_type: 'job_owner_reply', fromNumber: '+19415550777', adminUserId: 'tech-1' });
    const stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[0]).toMatchObject({ stage: 'owner_reply', outcome: 'sent', from_number: '+19415550777', by: 'tech-1' });
  });
});

describe('owner reply eligibility', () => {
  test('a closed application (rejected/withdrawn/hired) refuses the owner reply — outcome closed, nothing sent', async () => {
    mockDb.__tables.job_applications.push({ ...baseApp(), id: 'app-2', status: 'rejected', comms_history: [] });
    const res = await RecruitingComms.sendOwnerReply({ applicationId: 'app-2', body: 'hello', by: 'tech-1' });
    expect(res.outcome).toBe('closed');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });
});
