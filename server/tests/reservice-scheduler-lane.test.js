/**
 * server/services/reservice-scheduler.js — the lane predicate
 * (laneForCallbackRow) and its transactional dedupe check
 * (openCallbackExistsForLane), focused on the 'assessment' lane
 * inspection-public.js's commit relies on (Codex pre-push P1 :911,
 * round 5, 2026-09-24).
 *
 * Every other consumer of this module (voice-relay-reservice.test.js,
 * voice-relay-sandbox-dry-run.test.js, reservice-public.test.js) mocks it
 * wholesale, so this is the one place the REAL laneForCallbackRow /
 * openCallbackExistsForLane implementation is exercised directly.
 *
 * The lane predicate, precisely: laneForCallbackRow checks
 * ASSESSMENT_SERVICE_KEY ('lawn_inspection') / isAssessmentServiceType
 * (service_type === "Waves Assessment", case-insensitive) FIRST — before
 * the pest_re_service / lawn_re_service checks — so an assessment row can
 * never fall through to the function's own pest default. It is NOT a
 * RESERVICE_LANES member (that map is reservice-public.js's own two-lane
 * catalog); openCallbackExistsForLane's guard accepts 'assessment'
 * explicitly alongside RESERVICE_LANES[lane], and its query's OR clause
 * was widened to also match service_key = ASSESSMENT_SERVICE_KEY.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const listResults = { scheduled_services: [] };
jest.mock('../models/db', () => {
  const mkChain = () => {
    const q = {};
    const passthrough = ['leftJoin', 'where', 'whereIn', 'select', 'limit'];
    for (const m of passthrough) q[m] = () => q;
    q.then = (onOk, onErr) => Promise.resolve(listResults.scheduled_services).then(onOk, onErr);
    q.catch = (fn) => Promise.resolve(listResults.scheduled_services).catch(fn);
    return q;
  };
  return jest.fn(() => mkChain());
});

const {
  RESERVICE_LANES,
  laneForCallbackRow,
  openCallbackExistsForLane,
} = require('../services/reservice-scheduler');
const { ASSESSMENT_SERVICE_KEY } = require('../services/assessment-booking');
// openCallbackExistsForLane takes a db-like callable (a plain `db` or a
// `trx`) as its first arg — the mocked module itself serves fine here.
const dbh = require('../models/db');

afterEach(() => {
  listResults.scheduled_services = [];
});

describe('laneForCallbackRow — the lane predicate', () => {
  test('an assessment row (by service_key) classifies as "assessment", checked before the pest/lawn cases', () => {
    expect(laneForCallbackRow({ serviceKey: ASSESSMENT_SERVICE_KEY, serviceType: 'Waves Assessment' })).toBe('assessment');
  });

  test('an assessment row identified only by its denormalized service_type label (no serviceKey) also classifies as "assessment" — never falls through to the pest default', () => {
    expect(laneForCallbackRow({ serviceKey: null, serviceType: 'Waves Assessment' })).toBe('assessment');
    expect(laneForCallbackRow({ serviceType: 'waves assessment' })).toBe('assessment'); // case-insensitive, matches isAssessmentServiceType
  });

  test('pest/lawn classification is byte-identical to before (RESERVICE_LANES keys, then the lawn/turf label regex, default pest)', () => {
    expect(laneForCallbackRow({ serviceKey: RESERVICE_LANES.pest.serviceKey })).toBe('pest');
    expect(laneForCallbackRow({ serviceKey: RESERVICE_LANES.lawn.serviceKey })).toBe('lawn');
    expect(laneForCallbackRow({ serviceKey: null, serviceType: 'Lawn Care Re-Service' })).toBe('lawn');
    expect(laneForCallbackRow({ serviceKey: null, serviceType: 'Turf treatment retreat' })).toBe('lawn');
    expect(laneForCallbackRow({ serviceKey: null, serviceType: 'Pest Control Re-Service' })).toBe('pest');
    // Unclassifiable row (no key, no lawn/turf label) still defaults to
    // pest — the existing fallback, unaffected.
    expect(laneForCallbackRow({ serviceKey: 'something_else', serviceType: 'Some Other Service' })).toBe('pest');
  });

  test('RESERVICE_LANES itself carries only the two reservice lanes — the assessment lane is intentionally NOT a member', () => {
    expect(Object.keys(RESERVICE_LANES).sort()).toEqual(['lawn', 'pest']);
  });
});

describe('openCallbackExistsForLane — the transactional dedupe check', () => {
  test('lane "assessment": an open assessment row is found', async () => {
    listResults.scheduled_services = [{ service_type: 'Waves Assessment', service_key: ASSESSMENT_SERVICE_KEY }];
    expect(await openCallbackExistsForLane(dbh, 'cust-1', 'assessment')).toBe(true);
  });

  test('lane "assessment": only a pest re-service row on file — no false positive', async () => {
    listResults.scheduled_services = [{ service_type: 'Pest Control Re-Service', service_key: RESERVICE_LANES.pest.serviceKey }];
    expect(await openCallbackExistsForLane(dbh, 'cust-1', 'assessment')).toBe(false);
  });

  test('lane "pest" is unaffected by an assessment row on file — no false hit from the widened query (reservice behavior byte-identical)', async () => {
    listResults.scheduled_services = [{ service_type: 'Waves Assessment', service_key: ASSESSMENT_SERVICE_KEY }];
    expect(await openCallbackExistsForLane(dbh, 'cust-1', 'pest')).toBe(false);
  });

  test('lane "pest" still finds a real open pest re-service — unaffected', async () => {
    listResults.scheduled_services = [{ service_type: 'Pest Control Re-Service', service_key: RESERVICE_LANES.pest.serviceKey }];
    expect(await openCallbackExistsForLane(dbh, 'cust-1', 'pest')).toBe(true);
  });

  test('an unrecognized lane (neither RESERVICE_LANES nor "assessment") short-circuits false with no query', async () => {
    expect(await openCallbackExistsForLane(dbh, 'cust-1', 'bogus-lane')).toBe(false);
  });

  test('no customerId short-circuits false', async () => {
    expect(await openCallbackExistsForLane(dbh, null, 'assessment')).toBe(false);
  });
});
