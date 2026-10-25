// Completed protocol actions publish on the customer report: the public
// /api/reports/:token/data `protocol.actions` and the lawn and tree & shrub
// "Today's focus" both read buildProtocolPayload. Their sources are the
// picked action labels and the [Protocol] / [Protocol optional] / [Action]
// note lines, which the completion screen did not check for entry codes
// ([Next] and [Found] lines it did).
//
// - The completion refuses an entry code in any of those sources, untyped
//   and typed alike; ordinary gate-visit work still completes.
// - The report builder drops a stored line that reads like an entry code,
//   so records saved before the screen covered them stay clean.
// Mocked database, same harness as
// complete-scheduled-service-application-limits.test.js.
process.env.JWT_SECRET = 'completion-service-test-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => sql);
  db.schema = { hasColumn: jest.fn(async () => false), hasTable: jest.fn(async () => false) };
  db.transaction = jest.fn(async (callback) => callback(db));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/completion-attempts', () => ({
  COMPLETION_SMS_DEFINITE_REJECTION_PREFIX: jest.requireActual('../services/completion-attempts').COMPLETION_SMS_DEFINITE_REJECTION_PREFIX,
  STALE_SIDE_EFFECTS_MS: jest.requireActual('../services/completion-attempts').STALE_SIDE_EFFECTS_MS,
  claimCompletionAttempt: jest.fn(),
  hashCompletionRequest: jest.fn(() => 'synthetic-request-hash'),
  markCompletionAttemptFailed: jest.fn(async () => {}),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({})),
}));
jest.mock('../services/visit-groups', () => ({ lockStopForRow: jest.fn(async () => {}), stopBaseKey: jest.fn(() => 'fixture-stop') }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: jest.fn(async () => null) }));

const db = require('../models/db');
const attempts = require('../services/completion-attempts');
const profiles = require('../services/service-completion-profiles');
const bermuda = require('../services/lawn-bermuda-removal');
const { completeScheduledService } = require('../services/complete-scheduled-service');
const { buildProtocolPayload } = require('../services/service-report/report-data');
const { etDateString } = require('../utils/datetime-et');

const SERVICE_ID = '00000000-0000-4000-8000-000000000401';
const TECH_ID = '00000000-0000-4000-8000-000000000402';
const actor = { techRole: 'technician', technicianId: TECH_ID };

describe('report builder: stored protocol lines', () => {
  test('a stored action, observation or recommendation that reads like an entry code is dropped; ordinary work stays', () => {
    const payload = buildProtocolPayload({
      technician_notes: [
        '[Protocol] Web sweep',
        '[Action] Side gate code is 4417',
        '[Protocol optional] Lockbox is 2468',
        '[Action] Treated along the side gate',
        '[Found] Ants on the patio',
        '[Found] Keypad 9921 by the garage',
        '[Next] Keep the pool gate closed',
        '[Next] Gate code 1357 changes monthly',
      ].join('\n'),
      structured_notes: JSON.stringify({ protocolActionsCompleted: ['Granular bait in beds', 'Used the garage code 8642'] }),
      service_data: JSON.stringify({ protocol: { actions: ['Entry pin 5531 at the front door'], observations: [], recommendations: [] } }),
    });

    expect(payload.actions).toEqual(['Granular bait in beds', 'Web sweep', 'Treated along the side gate']);
    expect(payload.observations).toEqual(['Ants on the patio']);
    expect(payload.recommendations).toEqual(['Keep the pool gate closed']);
  });
});

describe('completion: protocol actions get the entry-code screen', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = {
      id: SERVICE_ID,
      customer_id: '00000000-0000-4000-8000-000000000403',
      property_id: '00000000-0000-4000-8000-000000000404',
      technician_id: TECH_ID,
      service_type: 'Quarterly Pest Control',
      scheduled_date: etDateString(),
      status: 'on_site',
    };
    const builder = {};
    for (const method of ['where', 'leftJoin', 'select', 'orderBy', 'whereNot', 'whereIn', 'whereRaw', 'forUpdate', 'whereNotNull', 'whereNull', 'limit']) {
      builder[method] = jest.fn(() => builder);
    }
    builder.first = jest.fn(async () => service);
    builder.columnInfo = jest.fn(async () => ({}));
    // A plain await of a query reads as no rows.
    builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    db.mockImplementation(() => builder);
    attempts.claimCompletionAttempt.mockResolvedValue({ action: 'proceed', attempt: { id: 'fixture-attempt' } });
    // The first refusal after the screen: a completion that reaches it got
    // past the entry-code check.
    jest.spyOn(bermuda, 'bermudaPairViolation').mockResolvedValue('Fixture: past the copy screens.');
  });
  afterEach(() => { jest.restoreAllMocks(); });

  const complete = (body) => completeScheduledService({ serviceId: SERVICE_ID, body: { products: [], ...body }, actor });
  const refused = (result) => expect(result).toMatchObject({ status: 422, body: { code: 'completion_access_code' } });
  const pastTheScreen = (result) => expect(result).toMatchObject({ status: 400, body: { code: 'lawn_bermuda_pair_required' } });

  test.each([
    ['an [Action] note line', { technicianNotes: '[Action] Side gate code is 4417' }],
    ['a [Protocol] note line', { technicianNotes: 'Visit went fine.\n[Protocol] Lockbox is 2468' }],
    ['a [Protocol optional] note line', { technicianNotes: '[Protocol optional] Keypad 9921 at the side door' }],
    ['a picked action label', { protocolActionsCompleted: ['Web sweep', 'Gate code 1357 for the pool'] }],
  ])('untyped: %s with an entry code is refused', async (_label, body) => {
    refused(await complete(body));
    expect(attempts.markCompletionAttemptFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: 'completion_access_code' }), expect.anything());
  });

  test('untyped: ordinary gate-visit work in the same places still completes', async () => {
    pastTheScreen(await complete({
      technicianNotes: '[Action] Treated along the side gate\n[Protocol] Web sweep',
      protocolActionsCompleted: ['Granular bait in beds'],
    }));
  });

  describe('typed (termite bait station)', () => {
    const structuredFindings = { type: 'termite_bait_station', values: { stations_checked: '0', termite_activity: 'None observed', bait_consumption: 'None — bait intact' } };

    beforeEach(() => {
      profiles.resolveCompletionProfileForScheduledService.mockResolvedValue({ findingsType: 'termite_bait_station' });
    });

    test('an [Action] note line with an entry code is refused', async () => {
      refused(await complete({ structuredFindings, technicianNotes: '[Action] Opened the side gate with code 4417' }));
    });

    test('a picked action label with an entry code is refused', async () => {
      refused(await complete({ structuredFindings, protocolActionsCompleted: ['Lockbox is 2468'] }));
    });

    test('ordinary actions still complete', async () => {
      pastTheScreen(await complete({ structuredFindings, technicianNotes: '[Action] Checked the stations by the side gate' }));
    });
  });
});
