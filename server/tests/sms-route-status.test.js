/**
 * TODAY ROUTE STATUS (texting AI gap 4): the tracker's stop count before the tech is en route, as one
 * finished sentence — rendered into TODAY's visit line, held to a word-for-word copy at draft time, and
 * re-derived at every send seam (sms-eta-freshness) so a changed count refuses the send.
 */
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/stops-ahead', () => ({ peekStopsAhead: jest.fn() }));

const { peekStopsAhead } = require('../services/stops-ahead');
const routeStatus = require('../services/sms-route-status');
const { etaClaimBlockReason, isEtaInfrastructureFailure } = require('../services/sms-eta-freshness');

const GATE = 'GATE_SMS_REAL_ANSWERS';
const TWO = 'Your technician has 2 stops before yours today.';
const STOP = { technicianId: 't1', customerId: 'c1', date: '2026-11-26', windowStart: '10:00:00' };
const snap = (sentence = TWO, id = 'svc-1', ids = [id], stop = STOP) => [{ scheduledServiceId: id, scheduledServiceIds: ids, sentence, stop }];
// A peekStopsAhead result: the count plus what the same read returns (stop identity, open member lines,
// the customer's open physical stops that day).
const P = (n, o = {}) => ({ stopsAhead: n, atStop: false, headingToStop: false, stop: { ...STOP }, memberIds: ['svc-1', 'svc-2'], openStopsToday: 1, ...o });

afterEach(() => {
  delete process.env[GATE];
  peekStopsAhead.mockReset();
});

describe('routeStatusSentence', () => {
  test('one finished sentence per count; never minutes or a clock time', () => {
    expect(routeStatus.routeStatusSentence({ stopsAhead: 0 })).toBe("Your visit is your technician's next stop today.");
    expect(routeStatus.routeStatusSentence({ stopsAhead: 1, atStop: true })).toBe('Your technician is working at the stop before yours.');
    expect(routeStatus.routeStatusSentence({ stopsAhead: 1, atStop: false, headingToStop: true })).toBe('Your technician has 1 stop before yours today.');
    expect(routeStatus.routeStatusSentence({ stopsAhead: 3 })).toBe('Your technician has 3 stops before yours today.');
    for (const n of [0, 1, 2, 3]) expect(routeStatus.routeStatusSentence({ stopsAhead: n })).not.toMatch(/\d+\s*(?:min|am|pm|:)/i);
  });
  test('no count (null, pending, bad shape) = no sentence', () => {
    expect(routeStatus.routeStatusSentence(null)).toBeNull();
    expect(routeStatus.routeStatusSentence({ pending: true })).toBeNull();
    expect(routeStatus.routeStatusSentence({ stopsAhead: -1 })).toBeNull();
  });
  test('the drafting read uses the no-write peek and fails soft', async () => {
    peekStopsAhead.mockResolvedValueOnce(P(2));
    expect(await routeStatus.routeStatusFactFor('db', 'svc-1')).toEqual({ sentence: TWO, stop: STOP, memberIds: ['svc-1', 'svc-2'] });
    expect(peekStopsAhead).toHaveBeenCalledWith('db', 'svc-1');
    peekStopsAhead.mockRejectedValueOnce(new Error('pool'));
    expect(await routeStatus.routeStatusFactFor('db', 'svc-1')).toBeNull();
  });
});

describe('the guard recognizes every ROUTE STATUS sentence shape', () => {
  const shapes = [{ stopsAhead: 0 }, { stopsAhead: 1, atStop: true }, { stopsAhead: 1 }, { stopsAhead: 2 }, { stopsAhead: 3 }]
    .map((r) => routeStatus.routeStatusSentence(r));
  const variants = shapes.flatMap((t) => [t, t.replace(/\.$/, '!'), t.replace(/\.$/, ''), t.replace(/\.$/, '?'), t.toUpperCase(), `Hi! ${t.replace(/\.$/, '.. ')}`]);
  test('three shapes, every count', () => {
    expect(new Set(shapes.map((t) => t.replace(/\d/, 'N'))).size).toBe(4); // next stop, at the stop before, 1 stop, N stops
  });
  test.each(variants)('%p is route wording (a claim without the fact is refused)', async (text) => {
    expect(routeStatus.mentionsStopCount(text)).toBe(true);
    expect(routeStatus.routeStatusDraftViolation(text, '')).toMatch(/ROUTE STATUS/);
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { entries: [], routeStatus: [] }, outgoingBody: text, dbh: 'db' })).toBe('route_status_unbound');
  });
});

describe('routeStatusDraftViolation', () => {
  const facts = `UPCOMING SERVICES:\n- Quarterly Pest TODAY on Thu, Nov 26, window 10-12pm, tech Sam, no live tech location known, ROUTE STATUS (copy word for word): "${TWO}"\n`;
  test('a word-for-word copy passes; no stop wording passes', () => {
    expect(routeStatus.routeStatusDraftViolation(`Hi! ${TWO}`, facts)).toBeNull();
    expect(routeStatus.routeStatusDraftViolation('Your visit is today between 10 and 12.', facts)).toBeNull();
  });
  test('a different count, a paraphrase or stop wording with no fact is a violation', () => {
    expect(routeStatus.routeStatusDraftViolation('Your technician has 1 stop before yours today.', facts)).toMatch(/ROUTE STATUS/);
    expect(routeStatus.routeStatusDraftViolation('He is two stops away.', facts)).toMatch(/ROUTE STATUS/);
    expect(routeStatus.routeStatusDraftViolation('You are his next stop!', 'UPCOMING SERVICES:\n- none\n')).toMatch(/ROUTE STATUS/);
    expect(routeStatus.routeStatusDraftViolation("You're next on the route!", facts)).toMatch(/ROUTE STATUS/);
    expect(routeStatus.routeStatusDraftViolation('He has two more visits before you.', facts)).toMatch(/ROUTE STATUS/);
  });
  // The structural rule: a count / order word with stop words, or with route nouns + a position link to you.
  const ROUTE_VARIANTS = [
    'The technician has two more stops, then yours.',
    'He has a couple more houses and then you.',
    "Three jobs to go and then it's you.",
    'Sam has one house ahead of yours.',
    'Two homes until yours.',
    'He is on his last stop before you.',
  ];
  test.each(ROUTE_VARIANTS)('route wording at draft time: %p', (reply) => {
    expect(routeStatus.routeStatusDraftViolation(reply, facts)).toMatch(/ROUTE STATUS/);
  });
  test('ordinary scheduling copy is not route wording', () => {
    for (const reply of ['Please call before your appointment.', 'Call before your visit if the gate is locked.', 'Your next visit is Tuesday.', 'See you next week!', 'We will call you first thing.', 'Your visit is after lunch.', 'Are you available next Tuesday?', 'You have 2 visits left this year.', 'You have 3 visits to go on your plan.', 'Your first visit is on Monday, then the next one in March.', 'We treat the house, then the yard.', 'Your next service is due in March.']) {
      expect(routeStatus.routeStatusDraftViolation(reply, '')).toBeNull();
    }
  });
  test('wired into validateLiveEtaMinutes (gate on only)', () => {
    const { validateLiveEtaMinutes } = require('../services/sms-shadow-drafter');
    expect(validateLiveEtaMinutes({ reply: 'He has 3 stops before you.', factsBlock: facts }).ok).toBe(true);
    process.env[GATE] = 'true';
    expect(validateLiveEtaMinutes({ reply: 'He has 3 stops before you.', factsBlock: facts }).ok).toBe(false);
    expect(validateLiveEtaMinutes({ reply: TWO, factsBlock: facts }).ok).toBe(true);
  });
});

describe('routeStatusBlockReason (send time)', () => {
  test('no route snapshot: unchanged path, no read', async () => {
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: null, outgoingBody: TWO, dbh: 'db' })).toBeNull();
    expect(peekStopsAhead).not.toHaveBeenCalled();
  });
  test('the same count now passes; a body without stop wording reads nothing', async () => {
    const trx = 'trx';
    peekStopsAhead.mockResolvedValue(P(2));
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap() }, outgoingBody: `Good morning! ${TWO}`, dbh: trx })).toBeNull();
    expect(peekStopsAhead).toHaveBeenCalledWith(trx, 'svc-1');
    peekStopsAhead.mockClear();
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap() }, outgoingBody: 'Thanks!', dbh: trx })).toBeNull();
    expect(peekStopsAhead).not.toHaveBeenCalled();
  });
  test('a changed count, or no count any more, is stale', async () => {
    peekStopsAhead.mockResolvedValueOnce(P(1));
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap() }, outgoingBody: TWO, dbh: 'db' })).toBe('route_status_changed');
    peekStopsAhead.mockResolvedValueOnce(null);
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap() }, outgoingBody: TWO, dbh: 'db' })).toBe('route_status_changed');
  });
  test('an unreadable route refuses as retryable infrastructure', async () => {
    peekStopsAhead.mockRejectedValueOnce(new Error('timeout'));
    const reason = await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap() }, outgoingBody: TWO, dbh: 'db' });
    expect(reason).toBe('route_status_recheck_failed');
    expect(isEtaInfrastructureFailure(reason)).toBe(true);
    expect(isEtaInfrastructureFailure('route_status_changed')).toBe(false);
  });
  test('a listed sibling line no longer an open member of the stop (moved, cancelled): stale', async () => {
    const two = snap(TWO, 'svc-1', ['svc-1', 'svc-2']);
    peekStopsAhead.mockResolvedValueOnce(P(2, { memberIds: ['svc-1'] }));
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: two }, outgoingBody: TWO, dbh: 'db' })).toBe('route_status_changed');
    peekStopsAhead.mockResolvedValueOnce(P(2));
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: two }, outgoingBody: TWO, dbh: 'db' })).toBeNull();
  });
  test('a stop moved whole (other technician, window or day) is stale even when the count still matches', async () => {
    for (const moved of [{ technicianId: 't2' }, { windowStart: '13:00:00' }, { date: '2026-11-27' }]) {
      peekStopsAhead.mockResolvedValueOnce(P(2, { stop: { ...STOP, ...moved } }));
      expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap() }, outgoingBody: TWO, dbh: 'db' })).toBe('route_status_changed');
    }
    peekStopsAhead.mockResolvedValueOnce(P(2));
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap(TWO, 'svc-1', ['svc-1'], null) }, outgoingBody: TWO, dbh: 'db' })).toBe('route_status_changed');
  });
  test('a second open physical stop for the customer that day (pest + lawn): stale, from the same read', async () => {
    peekStopsAhead.mockResolvedValueOnce(P(2, { openStopsToday: 2 }));
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap() }, outgoingBody: TWO, dbh: 'db' })).toBe('route_status_changed');
    expect(peekStopsAhead).toHaveBeenCalledTimes(1);
  });
  test('an opted-in draft with NO sentence (empty array) refuses route wording added later; plain copy passes', async () => {
    const empty = { entries: [], routeStatus: [] };
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: empty, outgoingBody: TWO, dbh: 'db' })).toBe('route_status_unbound');
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: empty, outgoingBody: "You're next on the route!", dbh: 'db' })).toBe('route_status_unbound');
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: empty, outgoingBody: 'Your next visit is Tuesday.', dbh: 'db' })).toBeNull();
    expect(peekStopsAhead).not.toHaveBeenCalled();
  });
  test.each([
    'The technician has two more stops, then yours.',
    'He has a couple more houses and then you.',
    "Three jobs to go and then it's you.",
    'Sam has one house ahead of yours.',
    'Two homes until yours.',
    'He is on his last stop before you.',
  ])('route wording at send time, with an empty route snapshot: %p', async (body) => {
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { entries: [], routeStatus: [] }, outgoingBody: body, dbh: 'db' })).toBe('route_status_unbound');
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap() }, outgoingBody: body, dbh: 'db' })).toBe('route_status_unbound');
  });
  test('next-in-line wording without the word "stop" is route wording at send', async () => {
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap() }, outgoingBody: "You're next on the route!", dbh: 'db' })).toBe('route_status_unbound');
  });
  test('an edited count the snapshot does not hold is unbound', async () => {
    expect(await routeStatus.routeStatusBlockReason({ liveEtaSnapshot: { routeStatus: snap() }, outgoingBody: 'Your technician has 1 stop before yours today.', dbh: 'db' })).toBe('route_status_unbound');
  });
  test('etaClaimBlockReason runs it on a snapshot that carries only a route status', async () => {
    peekStopsAhead.mockResolvedValueOnce(P(0));
    const reason = await etaClaimBlockReason({ liveEtaSnapshot: { entries: [], routeStatus: snap() }, factsGeneratedAt: new Date().toISOString(), outgoingBody: TWO, dbh: 'db' });
    expect(reason).toBe('route_status_changed');
    peekStopsAhead.mockResolvedValueOnce(P(2));
    expect(await etaClaimBlockReason({ liveEtaSnapshot: { entries: [], routeStatus: snap() }, factsGeneratedAt: new Date().toISOString(), outgoingBody: TWO, dbh: 'db' })).toBeNull();
  });
});

describe('drafter: facts line and snapshot', () => {
  const drafter = require('../services/sms-shadow-drafter');
  const today = { type: 'Quarterly Pest', date: '2026-11-26', window: '10-12pm', tech: 'Sam', isToday: true, status: 'confirmed', trackState: 'scheduled', routeStatus: TWO };
  test('gate on: TODAY line carries the quoted sentence; gate off: byte-identical to no route status', () => {
    const ctx = { summary: 'x', upcomingServices: [today] };
    const { routeStatus: _drop, ...plainRow } = today;
    const plainCtx = { summary: 'x', upcomingServices: [plainRow] };
    expect(drafter.buildFactsBlock(ctx)).toBe(drafter.buildFactsBlock(plainCtx));
    process.env[GATE] = 'true';
    expect(drafter.buildFactsBlock(ctx)).toContain(`no live tech location known, ROUTE STATUS (copy word for word): "${TWO}"`);
    expect(routeStatus.routeStatusSentencesInFacts(drafter.buildFactsBlock(ctx))).toEqual([TWO]);
  });
  test('the prompt clause is gate-on only', () => {
    expect(drafter.buildSystemPrompt({ summary: 'x' })).not.toContain('ROUTE STATUS');
    process.env[GATE] = 'true';
    expect(drafter.buildSystemPrompt({ summary: 'x' })).toContain("When TODAY's visit line carries ROUTE STATUS");
  });
  test('snapshot carries the route status; a context without it is unchanged', () => {
    expect(drafter.buildLiveEtaSnapshot({ liveEtaGroups: [] })).toBeNull();
    const groups = [{ scheduledServiceId: 'svc-1', scheduledServiceIds: ['svc-1', 'svc-2'], sentence: TWO }];
    expect(drafter.buildLiveEtaSnapshot({ liveEtaGroups: [], routeStatusGroups: groups })).toEqual({ entries: [], routeStatus: groups });
    // opted in but no sentence (or a failed read): the empty array is persisted so send time can refuse added route wording
    expect(drafter.buildLiveEtaSnapshot({ liveEtaGroups: [], routeStatusGroups: [] })).toEqual({ entries: [], routeStatus: [] });
    const live = { liveEtaGroups: [{ minutes: 9, scheduledServiceIds: ['svc-9'] }] };
    expect(drafter.buildLiveEtaSnapshot(live)).not.toHaveProperty('routeStatus');
  });
});

describe('context-aggregator loadRouteStatusFacts', () => {
  const { etDateString } = require('../utils/datetime-et');
  const { loadRouteStatusFacts } = require('../services/context-aggregator');
  const TODAY = etDateString();
  test('today + technician + not yet en route only; one read per stop; siblings share it', async () => {
    peekStopsAhead.mockResolvedValue(P(2, { stop: { ...STOP, date: TODAY } }));
    const rows = [
      { id: 'a', technician_id: 't1', scheduled_date: TODAY, window_start: '10:00:00', status: 'confirmed', track_state: 'scheduled' },
      { id: 'b', technician_id: 't1', scheduled_date: TODAY, window_start: '10:00:00', status: 'confirmed', track_state: null },
      { id: 'c', technician_id: null, scheduled_date: TODAY, window_start: '12:00:00', status: 'confirmed', track_state: 'scheduled' },
      { id: 'd', technician_id: 't1', scheduled_date: TODAY, window_start: '14:00:00', status: 'en_route', track_state: 'en_route' },
      { id: 'e', technician_id: 't1', scheduled_date: '2099-01-01', window_start: '10:00:00', status: 'confirmed', track_state: 'scheduled' },
    ];
    const out = await loadRouteStatusFacts(rows, 'c1', TODAY);
    expect(peekStopsAhead).toHaveBeenCalledTimes(1);
    expect(out.perRow).toEqual([TWO, TWO, null, null, null]);
    expect(out.groups).toEqual([{ scheduledServiceId: 'a', scheduledServiceIds: ['a', 'b'], sentence: TWO, stop: { ...STOP, date: TODAY } }]);
  });
  test('a route read whose stop identity is not the visit row shown (dispatch moved it in between): no sentence', async () => {
    const row = { id: 'a', technician_id: 't1', scheduled_date: TODAY, window_start: '10:00:00', status: 'confirmed', track_state: 'scheduled' };
    for (const moved of [{ technicianId: 't2' }, { windowStart: '13:00:00' }, { customerId: 'c9' }, { date: '2099-01-01' }]) {
      peekStopsAhead.mockResolvedValueOnce(P(2, { stop: { ...STOP, date: TODAY, ...moved } }));
      expect(await loadRouteStatusFacts([row], 'c1', TODAY)).toEqual({ perRow: [null], groups: [] });
    }
  });
  test('more than one open physical stop today (from the same read): no sentence', async () => {
    peekStopsAhead.mockResolvedValue(P(2, { openStopsToday: 2 }));
    const row = { id: 'a', technician_id: 't1', scheduled_date: TODAY, window_start: '10:00:00', status: 'confirmed', track_state: 'scheduled' };
    expect(await loadRouteStatusFacts([row], 'c1', TODAY)).toEqual({ perRow: [null], groups: [] });
  });
  test('a failed read is no sentence and no snapshot group', async () => {
    peekStopsAhead.mockRejectedValue(new Error('down'));
    const out = await loadRouteStatusFacts([{ id: 'a', technician_id: 't1', scheduled_date: TODAY, window_start: '10:00:00', status: 'confirmed', track_state: 'scheduled' }], 'c1', TODAY);
    expect(out).toEqual({ perRow: [null], groups: [] });
  });
});
