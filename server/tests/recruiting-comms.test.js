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
    const excludeIds = [];
    const builder = {
      where(cond) { whereCond = { ...whereCond, ...cond }; return builder; },
      whereRaw() { return builder; },
      whereIn(col, arr) { rows.__inFilter = (r) => arr.includes(r[col]); return builder; },
      select() {
        const inFilter = rows.__inFilter; delete rows.__inFilter;
        return Promise.resolve(rows.filter((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v) && (!inFilter || inFilter(r))));
      },
      insert(row) {
        const inserted = { id: row.id || `id-${rows.length + 1}`, ...row };
        rows.push(inserted);
        const p = Promise.resolve([inserted]);
        p.returning = async () => [inserted];
        return p;
      },
      whereNot(col, val) { excludeIds.push(val); return builder; },
      forUpdate() { return builder; },
      modify(fn) { fn(builder); return builder; },
      update(payload) {
        const resolved = { ...payload };
        if (resolved.comms_history && resolved.comms_history.__raw) {
          const { sql, bindings } = resolved.comms_history;
          const matches = rows.filter((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v) && !excludeIds.includes(r.id));
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
        const matches = rows.filter((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v) && !excludeIds.includes(r.id));
        for (const r of matches) Object.assign(r, resolved);
        const promise = Promise.resolve(matches.length);
        promise.catch = (fn) => Promise.resolve(matches.length).catch(fn);
        return promise;
      },
      first: () => Promise.resolve(rows.find((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v) && !excludeIds.includes(r.id))),
    };
    return builder;
  });
  db.raw = jest.fn((sql, bindings) => ({ __raw: true, sql, bindings }));
  db.schema = { hasTable: jest.fn(async () => true) };
  db.transaction = jest.fn(async (fn) => fn(db));
  db.__tables = tables;
  return db;
}
const mockDb = makeDb();
jest.mock('../models/db', () => mockDb);

const RecruitingComms = require('../services/recruiting-comms');
const { lintComms } = require('../services/comms-lint');
const migration = require('../models/migrations/20260920000001_job_applications_interview_comms');

// Drives a send input's locked handoff the way the pipeline does: the
// caller's transaction wraps the pipeline callback, which stamps the durable
// pre-provider transition (onProviderStart) and then reaches the provider.
const boundary = (input) => input.withSmsHandoff(async (trx, onProviderStart) => {
  await onProviderStart();
  return { ok: true };
});

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

  test('an email on the suppression ledger (bounce/unsubscribe) -> email unavailable, reason suppressed', async () => {
    mockActiveSuppressionFor.mockResolvedValueOnce({ suppression_type: 'bounce', group_key: null });
    const result = await RecruitingComms.channelEligibility(baseApp());
    expect(result.email).toEqual({ available: false, to: 'j***@example.com', reason: 'suppressed' });
  });

  test('an email suppression lookup failure keeps the preview informational (available) — the send re-checks authoritatively', async () => {
    mockActiveSuppressionFor.mockRejectedValueOnce(new Error('ledger down'));
    const result = await RecruitingComms.channelEligibility(baseApp());
    expect(result.email.available).toBe(true);
  });

  test('receiptStillEligible: true only while the application is new/reviewed with no later-stage or owner text live (Codex r20 P2)', async () => {
    mockDb.__tables.job_applications.push(
      { id: 'r-new', status: 'new', comms_history: [{ id: 'e1', stage: 'application_received', channel: 'sms', outcome: 'pending' }] },
      { id: 'r-adv', status: 'interview', comms_history: [] },
      { id: 'r-owner', status: 'new', comms_history: [{ id: 'e2', stage: 'owner_reply', channel: 'sms', outcome: 'sent' }] },
      { id: 'r-email-only', status: 'reviewed', comms_history: [{ id: 'e3', stage: 'interview_invite', channel: 'email', outcome: 'sent' }, { id: 'e4', stage: 'applicant_reply', channel: 'sms', outcome: 'received' }] },
    );
    await expect(RecruitingComms.receiptStillEligible('r-new')).resolves.toBe(true);
    await expect(RecruitingComms.receiptStillEligible('r-adv')).resolves.toBe(false);
    await expect(RecruitingComms.receiptStillEligible('r-owner')).resolves.toBe(false);
    await expect(RecruitingComms.receiptStillEligible('r-email-only')).resolves.toBe(true);
    await expect(RecruitingComms.receiptStillEligible('missing')).resolves.toBe(false);
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
  test('the SMS ledger entry is written as pending BEFORE the pipeline, becomes handoff at the provider boundary (preSendCheck), and is reconciled in place afterwards', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane.');
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    let seenBeforeProvider = null; let seenAtProvider = null;
    mockSendCustomerMessage.mockImplementation(async (input) => {
      const outcomes = () => mockDb.__tables.job_applications.find((r) => r.id === 'app-1').comms_history.map((e) => e.outcome);
      seenBeforeProvider = outcomes();
      await boundary(input); // the pipeline runs this right before Twilio
      seenAtProvider = outcomes();
      return { sent: true, blocked: false, deliveryOutcome: 'accepted' };
    });
    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false, by: 'system' });
    expect(result.sms).toBe('sent');
    expect(seenBeforeProvider).toEqual(['pending']);
    expect(seenAtProvider).toEqual(['handoff']);
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
  test('an UNCERTAIN provider outcome is never queued for replay even when the pipeline marks it retryable: the handoff evidence stays', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane, thanks for applying.');
    // Twilio timeout after the boundary: ambiguous, yet retryable + nextAllowedAt
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: false, deliveryOutcome: 'uncertain', retryable: true, nextAllowedAt: '2027-03-17T12:00:00.000Z', code: 'PROVIDER_TIMEOUT' });
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.sms_log = [];
    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false, by: 'system' });
    expect(result.sms).toBe('uncertain');
    expect(mockDb.__tables.sms_log.filter((r) => r.status === 'scheduled')).toHaveLength(0);
    const entry = mockDb.__tables.job_applications.find((r) => r.id === 'app-1').comms_history[0];
    expect(entry).toMatchObject({ outcome: 'uncertain', code: 'PROVIDER_TIMEOUT' });
    expect(entry.scheduled_for).toBeUndefined();
  });

  test('a retryable QUIET_HOURS/send-window hold queues the text on the scheduled-SMS rail as an applicant send', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jane, thanks for applying.');
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, deferred: true, nextAllowedAt: '2027-03-17T12:00:00.000Z', code: 'SEND_WINDOW_CLOSED' });
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false, by: 'system' });
    expect(result.sms).toBe('deferred');
    // the queue row and the ledger transition commit in ONE transaction
    expect(mockDb.transaction).toHaveBeenCalled();
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
    // a definite pre-provider failure (the pipeline's own not_sent outcome) is failed, never uncertain
    mockSendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('contract'), { providerOutcome: { sent: false, deliveryOutcome: 'not_sent', code: 'CONTRACT_VIOLATION' } }));
    result = await RecruitingComms.sendStageComms(app, 'application_received', { sms: true, email: false, by: 'system' });
    expect(result.sms).toBe('failed');
    stored = mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    expect(stored.comms_history[1]).toMatchObject({ outcome: 'uncertain' });
  });
});

describe('sendStageComms — invite supersedes queued invites; suppression lookup failure settles the ledger', () => {
  test('a held invite retires the older queued invite only AFTER its own queue row persisted (never strands the applicant)', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, deferred: true, nextAllowedAt: '2027-03-17T12:00:00.000Z', code: 'SEND_WINDOW_CLOSED' });
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.sms_log = [{ id: 'q1', status: 'scheduled', message_type: 'job_interview_invite', metadata: JSON.stringify({ job_application_id: 'app-1' }) }];
    const order = [];
    const original = mockDb.getMockImplementation();
    mockDb.mockImplementation((table) => {
      const api = original(table);
      if (table === 'sms_log') {
        const origInsert = api.insert; const origUpdate = api.update;
        api.insert = (row) => { order.push('insert'); return origInsert(row); };
        api.update = (payload) => { order.push('retire'); return origUpdate(payload); };
      }
      return api;
    });
    await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: false, by: 'tech-1' });
    mockDb.mockImplementation(original);
    expect(order).toEqual(['insert', 'retire']);
    const rows = mockDb.__tables.sms_log;
    expect(rows.find((r) => r.id === 'q1').status).toBe('cancelled');
    expect(rows.filter((r) => r.status === 'scheduled')).toHaveLength(1); // the replacement
  });

  test('stillEligible is consulted before EACH provider leg; a stage change mid-send stales the email leg only', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    mockSendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted' });
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const answers = [true, false];
    const stillEligible = jest.fn(async () => answers.shift());
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: true, by: 'tech-1', stillEligible });
    expect(stillEligible).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ sms: 'sent', email: 'stale' });
    expect(mockSendOne).not.toHaveBeenCalled();
  });

  test('deferred: an invite queued by an OVERLAPPING attempt moments ago owns the send — this attempt yields (blocked, no second queue row) (Codex r19 P2)', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, deferred: true, nextAllowedAt: '2027-03-17T12:00:00.000Z', code: 'SEND_WINDOW_CLOSED' });
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.sms_log = [{ id: 'rival', status: 'scheduled', message_type: 'job_interview_invite', created_at: new Date(Date.now() - 3000), metadata: JSON.stringify({ job_application_id: 'app-1', ledger_entry_id: 'rival-entry' }) }];
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: false, by: 'tech-1' });
    expect(result.sms).toBe('blocked');
    expect(mockDb.__tables.sms_log.filter((r) => r.status === 'scheduled').map((r) => r.id)).toEqual(['rival']);
    const mine = mockDb.__tables.job_applications.find((r) => r.id === 'app-1').comms_history[0];
    expect(mine).toMatchObject({ outcome: 'blocked', code: 'superseded_by_queued_invite' });
  });

  test('deferred: an OLDER queued invite (outside the overlap window) is retired in favour of this one, and its ledger entry settles blocked', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, deferred: true, nextAllowedAt: '2027-03-17T12:00:00.000Z', code: 'SEND_WINDOW_CLOSED' });
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [{ id: 'old-entry', at: new Date(Date.now() - 3600000).toISOString(), stage: 'interview_invite', channel: 'sms', outcome: 'deferred' }] });
    mockDb.__tables.sms_log = [{ id: 'old', status: 'scheduled', message_type: 'job_interview_invite', created_at: new Date(Date.now() - 3600000), metadata: JSON.stringify({ job_application_id: 'app-1', ledger_entry_id: 'old-entry' }) }];
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: false, by: 'tech-1' });
    expect(result.sms).toBe('deferred');
    expect(mockDb.__tables.sms_log.find((r) => r.id === 'old').status).toBe('cancelled');
    expect(mockDb.__tables.sms_log.filter((r) => r.status === 'scheduled')).toHaveLength(1);
    const history = mockDb.__tables.job_applications.find((r) => r.id === 'app-1').comms_history;
    expect(history.find((e) => e.id === 'old-entry')).toMatchObject({ outcome: 'blocked', code: 'superseded_by_newer_queue' });
  });

  test('a gate-suppressed send (sent:true + deliveryOutcome not_sent) is NOT delivery: blocked, no handoff evidence, queued invites untouched (Codex r22 P1)', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    mockSendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, suppressed: true, deliveryOutcome: 'not_sent', code: 'TEMPLATE_DISABLED' });
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.sms_log = [{ id: 'q1', status: 'scheduled', message_type: 'job_interview_invite', created_at: new Date(Date.now() - 3600000), metadata: JSON.stringify({ job_application_id: 'app-1' }) }];
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: false, by: 'tech-1' });
    expect(result.sms).toBe('blocked');
    expect(mockDb.__tables.job_applications.find((r) => r.id === 'app-1').comms_history[0]).toMatchObject({ outcome: 'blocked', code: 'TEMPLATE_DISABLED' });
    expect(mockDb.__tables.sms_log.find((r) => r.id === 'q1').status).toBe('scheduled');
  });

  test('an admin-clicked interview invite carries admin attribution but NOT the send-window operator exemption (Codex r24 P2)', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    mockSendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted' });
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: false, by: 'tech-1' });
    const input = mockSendCustomerMessage.mock.calls[0][0];
    expect(input.operatorInitiated).toBeUndefined();
    expect(input.metadata.adminUserId).toBe('tech-1');
  });

  test('a sent interview invite retires invites still queued for the same application', async () => {
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

describe('eligibility at the provider boundaries', () => {
  test('SMS: a preSendCheck is passed to the pipeline; email: beforeProvider stales the email at the SendGrid boundary and settles the ledger', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    mockSendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted' });
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const answers = [true, true, false]; // sms leg check, sms preSendCheck (not invoked by the mock), email leg check → still true; the boundary check returns false
    let calls = 0;
    const stillEligible = jest.fn(async () => { calls += 1; return calls <= 2; });
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: true, by: 'tech-1', stillEligible });
    const smsInput = mockSendCustomerMessage.mock.calls[0][0];
    expect(typeof smsInput.withSmsHandoff).toBe('function');
    await expect(boundary(smsInput)).resolves.toMatchObject({ ok: false, code: 'RECRUITING_STALE' });
    expect(result.sms).toBe('sent');
    expect(result.email).toBe('stale');
    expect(mockSendOne).not.toHaveBeenCalled();
    const ledger = mockDb.__tables.email_messages.find((r) => r.recipient_id === 'app-1');
    expect(ledger.status).toBe('failed');
  });

  test('email: the application row is held through the SendGrid request and the final eligibility read runs inside that lock (Codex r20 P1)', async () => {
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.email_messages = [];
    const seenConns = [];
    // gate check → true, locked boundary check → false (the applicant withdrew while SendGrid's guards ran)
    const answers = [true, true, false];
    const stillEligible = jest.fn(async (conn) => { seenConns.push(conn); return answers.shift(); });
    mockSendOne.mockClear();
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: false, email: true, by: 'tech-1', stillEligible });
    expect(result.email).toBe('stale');
    expect(mockSendOne).not.toHaveBeenCalled();
    expect(seenConns[seenConns.length - 1]).toBe(mockDb); // the held transaction
    expect(mockDb.__tables.email_messages[0]).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/stale/) });
  });

  test('email: a handoff transaction failing BEFORE the provider settles the claimed (sending) row as failed (Codex r23 P2)', async () => {
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.email_messages = [];
    mockSendOne.mockClear();
    const realTx = mockDb.transaction;
    let calls = 0;
    mockDb.transaction = jest.fn(async (fn) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('could not obtain lock'), { code: '55P03' }); // the handoff transaction
      return fn(mockDb);
    });
    try {
      const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: false, email: true, by: 'tech-1' });
      expect(result.email).toBe('failed');
      expect(mockSendOne).not.toHaveBeenCalled();
      expect(mockDb.__tables.email_messages[0]).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/handoff failed before the provider/) });
    } finally {
      mockDb.transaction = realTx;
    }
  });

  test('openApplicationIdForPhone scopes evidence to the sending line (Codex r23 P2)', async () => {
    mockDb.__tables.job_applications.push(
      { id: 'app-A', status: 'interview', contact_snapshot: { phone: '9415550142' }, comms_history: [{ id: 'a1', at: new Date(Date.now() - 7200000).toISOString(), handoff_at: new Date(Date.now() - 7200000).toISOString(), stage: 'interview_invite', channel: 'sms', outcome: 'sent', from_number: '+19415550199' }] },
      { id: 'app-B', status: 'new', contact_snapshot: { phone: '9415550142' }, comms_history: [{ id: 'b1', at: new Date(Date.now() - 600000).toISOString(), handoff_at: new Date(Date.now() - 600000).toISOString(), stage: 'application_received', channel: 'sms', outcome: 'sent', from_number: '+19415550777' }] },
    );
    await expect(RecruitingComms.openApplicationIdForPhone('9415550142')).resolves.toBe('app-B');                                  // no line: newest evidence overall
    await expect(RecruitingComms.openApplicationIdForPhone('9415550142', { fromNumber: '+19415550199' })).resolves.toBe('app-A'); // line A's thread
    await expect(RecruitingComms.openApplicationIdForPhone('9415550142', { fromNumber: '+19415550777' })).resolves.toBe('app-B');
  });

  test('email: a suppression that lands after the pre-provider gate is caught under the address lock right before SendGrid (Codex r22 P1)', async () => {
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.email_messages = [];
    mockSendOne.mockClear();
    mockDb.raw.mockClear();
    mockActiveSuppressionFor
      .mockResolvedValueOnce(null)                                   // pre-provider gate: clean
      .mockResolvedValueOnce({ suppression_type: 'bounce', group_key: null }); // locked re-read: the webhook just wrote a bounce
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: false, email: true, by: 'tech-1' });
    expect(result.email).toBe('blocked');
    expect(mockSendOne).not.toHaveBeenCalled();
    // the address key was taken inside the handoff transaction
    expect(mockDb.raw.mock.calls.some((c) => /pg_advisory_xact_lock/.test(c[0]) && /customer-email:jane@example.com/.test(String(c[1])))).toBe(true);
    // the re-read went through the held transaction
    expect(mockActiveSuppressionFor.mock.calls[1][3]).toBe(mockDb);
    expect(mockDb.__tables.email_messages[0]).toMatchObject({ status: 'blocked' });
  });

  test('email: SendGrid acceptance survives a failed ledger settlement / rejected commit — never reported as failed (Codex r21 P2)', async () => {
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.email_messages = [];
    mockSendOne.mockClear();
    // the handoff transaction rejects at commit, after the provider answered
    const realTx = mockDb.transaction;
    let calls = 0;
    mockDb.transaction = jest.fn(async (fn) => {
      calls += 1;
      const out = await fn(mockDb);
      if (calls === 2 && mockSendOne.mock.calls.length) throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
      return out;
    });
    try {
      const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: false, email: true, by: 'tech-1' });
      expect(mockSendOne).toHaveBeenCalledTimes(1);
      expect(result.email).toBe('sent');
      const entry = mockDb.__tables.job_applications.find((r) => r.id === 'app-1').comms_history.find((e) => e.channel === 'email');
      expect(entry.outcome).toBe('sent');
    } finally {
      mockDb.transaction = realTx;
    }
  });

  test('SMS: the handoff is stamped BEFORE the eligibility read, which is the last await before the provider (Codex r14)', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const outcomes = () => mockDb.__tables.job_applications.find((r) => r.id === 'app-1').comms_history.map((e) => e.outcome);
    const seenByEligibility = [];
    const stillEligible = jest.fn(async () => { seenByEligibility.push(outcomes()); return true; });
    mockSendCustomerMessage.mockImplementation(async (input) => {
      await expect(boundary(input)).resolves.toEqual({ ok: true });
      return { sent: true, blocked: false, deliveryOutcome: 'accepted' };
    });
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: false, by: 'tech-1', stillEligible });
    expect(result.sms).toBe('sent');
    // leg check (nothing written yet), then the boundary check under the row
    // lock — the stamp follows the pipeline's rechecks (onProviderStart), all
    // inside the same lock, so the read sees 'pending' and nothing can change
    // before Twilio (Codex r19 P1).
    expect(seenByEligibility).toEqual([[], ['pending']]);
    expect(stillEligible.mock.calls[1][0]).toBe(mockDb); // read through the held transaction
    const entry = mockDb.__tables.job_applications.find((r) => r.id === 'app-1').comms_history[0];
    expect(entry.outcome).toBe('sent');
    expect(typeof entry.handoff_at).toBe('string');
  });

  test('SMS: a concurrent resend that appended a NEWER interview_invite attempt supersedes this one at the boundary — one text, not two', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const row = () => mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    mockSendCustomerMessage.mockImplementation(async (input) => {
      // the other admin's attempt lands in the ledger while this one is inside the validators
      row().comms_history.push({ id: 'other-attempt', at: new Date().toISOString(), stage: 'interview_invite', channel: 'sms', outcome: 'pending', body: 'x', by: 'tech-2' });
      const check = await boundary(input);
      expect(check).toMatchObject({ ok: false, code: 'RECRUITING_SUPERSEDED' });
      return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: check.code };
    });
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: false, by: 'tech-1' });
    expect(result.sms).toBe('blocked');
    const [mine, other] = row().comms_history;
    // never stamped handoff (no delivery evidence), settled as blocked
    expect(mine).toMatchObject({ outcome: 'blocked', code: 'RECRUITING_SUPERSEDED' });
    expect(mine.handoff_at).toBeUndefined();
    // the newer attempt is untouched — it delivers
    expect(other).toMatchObject({ id: 'other-attempt', outcome: 'pending' });
  });

  test('SMS: an OLDER resend that crossed the boundary moments ago refuses this overlapping one, even though nothing newer exists (Codex r18 P2)', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    // the other admin's attempt stamped handoff 5 s ago, before this one's pending append landed
    mockDb.__tables.job_applications.push({ ...app, comms_history: [
      { id: 'earlier', at: new Date(Date.now() - 6000).toISOString(), handoff_at: new Date(Date.now() - 5000).toISOString(), stage: 'interview_invite', channel: 'sms', outcome: 'handoff', body: 'x', by: 'tech-2' },
    ] });
    mockSendCustomerMessage.mockImplementation(async (input) => {
      const check = await boundary(input);
      expect(check).toMatchObject({ ok: false, code: 'RECRUITING_SUPERSEDED' });
      return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: check.code };
    });
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: false, by: 'tech-1' });
    expect(result.sms).toBe('blocked');
  });

  test('SMS: a deliberate resend well after the previous one crossed the boundary is NOT treated as overlapping', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [
      { id: 'earlier', at: new Date(Date.now() - 20 * 60000).toISOString(), handoff_at: new Date(Date.now() - 20 * 60000).toISOString(), stage: 'interview_invite', channel: 'sms', outcome: 'sent', body: 'x', by: 'tech-2' },
    ] });
    mockSendCustomerMessage.mockImplementation(async (input) => {
      await expect(boundary(input)).resolves.toEqual({ ok: true });
      return { sent: true, blocked: false, deliveryOutcome: 'accepted' };
    });
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: true, email: false, by: 'tech-1' });
    expect(result.sms).toBe('sent');
  });

  test('email: the previewed (unedited) copy submitted back keeps the built html with its button; edited copy is re-wrapped WITH the scheduling button (Codex r18 P2)', async () => {
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.email_messages = [];
    const built = RecruitingComms.buildEmailContent(app, 'interview_invite', RecruitingComms.buildVars(app, 'interview_invite'));
    expect(built.html).toContain('href="');
    mockSendOne.mockClear();
    await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: false, email: true, by: 'tech-1', emailSubject: built.subject, emailBody: built.text });
    expect(mockSendOne.mock.calls[0][0].html).toBe(built.html);

    mockDb.__tables.email_messages = [];
    mockSendOne.mockClear();
    await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: false, email: true, by: 'tech-1', emailSubject: built.subject, emailBody: `${built.text}\n\nWe are excited to meet you.` });
    const html = mockSendOne.mock.calls[0][0].html;
    expect(html).not.toBe(built.html);
    expect(html).toContain('We are excited to meet you.');
    expect(html).toMatch(new RegExp(`href="[^"]*careers/interview/${'a'.repeat(64)}`));
  });

  test('SMS: owner replies are distinct messages — a newer owner_reply never supersedes an in-flight one', async () => {
    const app = baseApp();
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    const row = () => mockDb.__tables.job_applications.find((r) => r.id === 'app-1');
    mockSendCustomerMessage.mockImplementation(async (input) => {
      row().comms_history.push({ id: 'second-reply', at: new Date().toISOString(), stage: 'owner_reply', channel: 'sms', outcome: 'pending', body: 'and one more thing', by: 'tech-1' });
      await expect(boundary(input)).resolves.toEqual({ ok: true });
      return { sent: true, blocked: false, deliveryOutcome: 'accepted' };
    });
    const result = await RecruitingComms.sendStageComms(app, 'owner_reply', { sms: true, email: false, by: 'tech-1', smsBody: 'See you Tuesday' });
    expect(result.sms).toBe('sent');
  });

  test('email: a newer live email_messages row for the same application + template supersedes this attempt before SendGrid', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Pick a time: https://x/careers/interview/a');
    const app = baseApp({ interview_token: 'a'.repeat(64) });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    mockDb.__tables.email_messages = [];
    mockActiveSuppressionFor.mockImplementationOnce(async () => {
      // the other admin's attempt inserts its row while this one is in the suppression lookup
      // settled 'uncertain' (SendGrid timeout) — the applicant may already hold it, so it still supersedes (Codex r15 P2)
      mockDb.__tables.email_messages.push({ id: 'newer-attempt', recipient_type: 'job_application', recipient_id: 'app-1', template_key: 'job_interview_invite', status: 'uncertain', queued_at: new Date(Date.now() + 1000) });
      return null;
    });
    const result = await RecruitingComms.sendStageComms(app, 'interview_invite', { sms: false, email: true, by: 'tech-1' });
    expect(result.email).toBe('stale');
    expect(mockSendOne).not.toHaveBeenCalled();
    const mine = mockDb.__tables.email_messages.find((r) => r.id !== 'newer-attempt');
    expect(mine).toMatchObject({ status: 'failed', error_message: 'superseded: a newer attempt of this stage exists' });
    expect(mockDb.__tables.email_messages.find((r) => r.id === 'newer-attempt').status).toBe('uncertain');
  });
});

describe('owner reply — boundary guard and evidence-owning application', () => {
  test('sendOwnerReply passes a stillEligible guard that re-reads the application status', async () => {
    mockSendCustomerMessage.mockResolvedValue({ sent: true, blocked: false, deliveryOutcome: 'accepted' });
    const app = baseApp({ status: 'interview' });
    mockDb.__tables.job_applications.push({ ...app, comms_history: [] });
    await RecruitingComms.sendOwnerReply({ applicationId: 'app-1', body: 'ok', by: 'tech-1' });
    const input = mockSendCustomerMessage.mock.calls[0][0];
    expect(typeof input.withSmsHandoff).toBe('function');
    mockDb.__tables.job_applications.find((r) => r.id === 'app-1').status = 'rejected';
    await expect(boundary(input)).resolves.toMatchObject({ ok: false, code: 'RECRUITING_STALE' });
  });

  test('openApplicationIdForPhone picks the open application whose ledger owns the newest SMS attempt, not the newest row', async () => {
    mockDb.__tables.job_applications.push(
      { ...baseApp(), id: 'app-old', status: 'interview', updated_at: '2027-03-10T00:00:00.000Z', comms_history: [{ channel: 'sms', outcome: 'sent', at: '2027-03-10T12:00:00.000Z' }] },
      { ...baseApp(), id: 'app-new', status: 'new', updated_at: '2027-03-15T00:00:00.000Z', comms_history: [] },
    );
    await expect(RecruitingComms.openApplicationIdForPhone('+19415550142')).resolves.toBe('app-old');
  });
});

describe('applicant emails never invite an email reply', () => {
  test('copy directs questions to the phone, not a reply', () => {
    const app = baseApp();
    for (const stage of ['application_received', 'interview_invite', 'interview_confirmation']) {
      for (const language of ['en', 'es']) {
        const built = RecruitingComms.buildEmailContent({ ...app, language, interview_token: 'a'.repeat(64), interview_mode: 'phone', interview_at: '2027-03-16T20:00:00.000Z' }, stage, RecruitingComms.buildVars({ ...app, language, interview_token: 'a'.repeat(64), interview_mode: 'phone', interview_at: '2027-03-16T20:00:00.000Z' }, stage));
        expect((built.text || '').toLowerCase()).not.toMatch(/reply to this email|responde a este correo/);
      }
    }
  });
});
