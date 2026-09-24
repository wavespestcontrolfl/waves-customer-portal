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
  // A row that never sets a given field is UNDECIDED on any filter over
  // that field and passes it — this keeps every pre-existing fixture below
  // (which only ever sets service_type/service_key) byte-identical to the
  // old dumb passthrough mock. A row that DOES set the field is filtered
  // for real, which is what round-12's new tests need: proving the
  // assessment lane's query no longer bounds by scheduled_date or requires
  // is_callback/a re-service catalog key the way the pest/lawn query still
  // does.
  function stripAlias(field) {
    return String(field).replace(/^[a-z_]+\./, '');
  }
  function evalClause(row, field, op, value) {
    const f = stripAlias(field);
    const rv = row[f];
    if (rv === undefined) return null; // undecided
    if (op === '=') return rv === value;
    if (op === '>=') return rv >= value;
    return true;
  }
  function rawClause(sql, bindings) {
    if (!Array.isArray(bindings) || !/LOWER\(TRIM\(\?\?\)\)\s*=\s*\?/i.test(sql)) return () => null;
    const f = stripAlias(bindings[0]);
    return (row) => (row[f] === undefined ? null : String(row[f]).trim().toLowerCase() === String(bindings[1]));
  }
  const mkChain = () => {
    const filters = [];
    const q = {};
    q.leftJoin = () => q;
    q.select = () => q;
    q.limit = () => q;
    q.where = (...args) => {
      if (typeof args[0] === 'function') {
        // Sub-builder: qb.where(...).orWhere(...).orWhereIn(...) — an OR
        // group. Any clause resolving true passes the group; if every
        // clause is decided and none is true, the group fails; a group
        // with no decided clause at all is undecided (passes).
        const subClauses = [];
        const subQb = {
          where: (f, v) => { subClauses.push((row) => evalClause(row, f, '=', v)); return subQb; },
          orWhere: (f, v) => { subClauses.push((row) => evalClause(row, f, '=', v)); return subQb; },
          orWhereIn: (f, arr) => { subClauses.push((row) => {
            const rv = row[stripAlias(f)];
            return rv === undefined ? null : arr.includes(rv);
          }); return subQb; },
          // scopeToAssessmentBookings' LOWER(TRIM(??)) = ? shape.
          whereRaw: (sql, b) => { subClauses.push(rawClause(sql, b)); return subQb; },
          orWhereRaw: (sql, b) => { subClauses.push(rawClause(sql, b)); return subQb; },
        };
        args[0].call(subQb, subQb);
        filters.push((row) => {
          const results = subClauses.map((fn) => fn(row));
          if (results.some((r) => r === true)) return true;
          if (results.every((r) => r === null)) return true;
          return false;
        });
      } else if (args.length >= 2) {
        const [field, opOrValue, maybeValue] = args;
        const op = args.length === 3 ? opOrValue : '=';
        const value = args.length === 3 ? maybeValue : opOrValue;
        filters.push((row) => evalClause(row, field, op, value) !== false);
      }
      return q;
    };
    q.whereIn = (field, arr) => {
      filters.push((row) => {
        const rv = row[stripAlias(field)];
        return rv === undefined || arr.includes(rv);
      });
      return q;
    };
    q.whereNotIn = (field, arr) => {
      filters.push((row) => {
        const rv = row[stripAlias(field)];
        return rv === undefined || !arr.includes(rv);
      });
      return q;
    };
    q.modify = (fn) => { fn(q); return q; };
    q.first = async () => null;
    const rows = () => listResults.scheduled_services.filter((row) => filters.every((f) => f(row)));
    q.then = (onOk, onErr) => Promise.resolve(rows()).then(onOk, onErr);
    q.catch = (fn) => Promise.resolve(rows()).catch(fn);
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

  test('lane "assessment": a legacy row named "Waves Assessment" with no catalog link and is_callback false still counts as open (Codex round-12 P1)', async () => {
    // No service_key/service_id, is_callback explicitly false — the
    // pest/lawn query's is_callback/catalog-key OR clause would have
    // dropped this row; the assessment lane's own predicate (mirroring
    // inspection-public.js's findOpenVisit(assessmentOnly)) goes by name/
    // catalog identity alone, never is_callback.
    listResults.scheduled_services = [{
      service_type: 'Waves Assessment',
      service_id: null,
      is_callback: false,
      status: 'pending',
    }];
    expect(await openCallbackExistsForLane(dbh, 'cust-1', 'assessment')).toBe(true);
  });

  test('lane "assessment": an overdue non-terminal assessment still counts as open — no date bound (Codex round-12 P1)', async () => {
    // scheduled_date is well in the past; the pest/lawn query's
    // `scheduled_date >= today` bound would have dropped this row. The
    // assessment lane has no date bound — only non-terminal status.
    listResults.scheduled_services = [{
      service_type: 'Waves Assessment',
      service_key: ASSESSMENT_SERVICE_KEY,
      status: 'pending',
      scheduled_date: '2020-01-01',
    }];
    expect(await openCallbackExistsForLane(dbh, 'cust-1', 'assessment')).toBe(true);
  });

  test('lane "assessment": a TERMINAL-status assessment (e.g. completed) does not count as open', async () => {
    listResults.scheduled_services = [{
      service_type: 'Waves Assessment',
      service_key: ASSESSMENT_SERVICE_KEY,
      status: 'completed',
    }];
    expect(await openCallbackExistsForLane(dbh, 'cust-1', 'assessment')).toBe(false);
  });

  test('an unrecognized lane (neither RESERVICE_LANES nor "assessment") short-circuits false with no query', async () => {
    expect(await openCallbackExistsForLane(dbh, 'cust-1', 'bogus-lane')).toBe(false);
  });

  test('no customerId short-circuits false', async () => {
    expect(await openCallbackExistsForLane(dbh, null, 'assessment')).toBe(false);
  });
});
