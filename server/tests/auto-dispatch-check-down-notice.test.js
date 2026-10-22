// check-down-notice.js — ONE notice when every AI move check of a night
// broke (owner audit 2026-10-22, finding 1: Oct 15-19 the tool moved nothing
// for five nights and no notice named it), closed the first night a check
// answers again.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => ({}));

const checkDown = require('../services/auto-dispatch/check-down-notice');

const NOW = new Date('2026-10-23T08:12:00Z');
const KEY = 'auto-dispatch-check-down';

function depsOf() {
  return {
    db: { name: 'db' },
    episodes: {
      raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', rang: true })),
      closeAdminAlertKeys: jest.fn(async () => 1),
    },
  };
}
const raised = (deps) => deps.episodes.raiseAdminAlertWithReopen.mock.calls;
// The run's check tally (proofreader/nightly.js newRunState) on a night Claude refused every call.
const tally = (over = {}) => ({ calls: 17, allowed: 0, held: 0, unsure: 17, broke: 17, answered: 0, brokeCause: 'anthropic_400', ...over });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_AUTO_DISPATCH_CHECK_DOWN_NOTICE = 'true';
});
afterAll(() => { delete process.env.GATE_AUTO_DISPATCH_CHECK_DOWN_NOTICE; });

test('every check broke: one System notice that names the cause, through the shared reopen helper (Codex #6465 r1)', async () => {
  const deps = depsOf();
  expect(await checkDown.noteRun(tally(), { nowDate: NOW, deps })).toEqual({ action: 'down' });
  expect(raised(deps)).toHaveLength(1);
  const [category, title, body, opts] = raised(deps)[0];
  expect(category).toBe('system');
  expect(title).toBe('System — restore the auto-dispatch move check');
  expect(body).toBe('17 planned moves stayed put: every move check failed (the provider refused the call).');
  // The code itself is in the detail, never in the why (no code words there).
  expect(opts.detail).toContain('every check failed (anthropic_400): the provider refused the call');
  expect(opts.detail).toContain('Railway');
  expect(opts).toMatchObject({ dedupeKey: KEY, refreshOnDedupe: true, bellDefault: true, link: '/admin/agents?tab=dispatch' });
  // The helper decides the ring under the key's lock: a standing row is
  // rewritten quietly; it overrides this for a reopen (a closed row rings).
  expect(opts.ringOnRefresh()).toBe(false);
  expect(opts).not.toHaveProperty('dedupeVersion');
  expect(opts.metadata).toEqual({
    area: 'System', severity: 'needs-you', subject: { type: 'check', id: 'auto-dispatch-move-check' }, doneWhen: 'check_answers', who: 'person',
    cause: 'anthropic_400', broke: 17,
  });
  expect(deps.episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
});

test('every broken night makes the same call: the helper keeps one row per outage', async () => {
  const deps = depsOf();
  await checkDown.noteRun(tally({ broke: 3, unsure: 3 }), { nowDate: NOW, deps });
  await checkDown.noteRun(tally({ broke: 5, unsure: 5 }), { nowDate: NOW, deps });
  expect(raised(deps)).toHaveLength(2);
  expect(raised(deps).map(([, , body]) => body.split(' stayed')[0])).toEqual(['3 planned moves', '5 planned moves']);
  expect(new Set(raised(deps).map(([, , , opts]) => opts.dedupeKey))).toEqual(new Set([KEY]));
});

test('a dry run (the check is on but was not asked) changes nothing: it never closes a standing outage (Codex #6465 r1)', async () => {
  const deps = depsOf();
  expect(await checkDown.noteRun(null, { enabled: true, nowDate: NOW, deps })).toEqual({ action: 'none' });
  expect(deps.episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  expect(raised(deps)).toHaveLength(0);
});

test('one move is singular', async () => {
  const deps = depsOf();
  await checkDown.noteRun(tally({ broke: 1, unsure: 1, brokeCause: 'anthropic_timeout' }), { nowDate: NOW, deps });
  expect(raised(deps)[0][2]).toBe('1 planned move stayed put: every move check failed (the model timed out).');
});

test('one usable answer closes it: the check works again (a later outage rings anew)', async () => {
  const deps = depsOf();
  expect(await checkDown.noteRun(tally({ answered: 1, broke: 4 }), { nowDate: NOW, deps })).toEqual({ action: 'closed' });
  expect(deps.episodes.closeAdminAlertKeys).toHaveBeenCalledWith(deps.db, [KEY], 'check_answers', { now: NOW, resolution: 'The move check answered again' });
  expect(raised(deps)).toHaveLength(0);
});

test('a night that asked nothing changes nothing', async () => {
  const deps = depsOf();
  expect(await checkDown.noteRun(tally({ calls: 0, unsure: 0, broke: 0, brokeCause: null }), { nowDate: NOW, deps })).toEqual({ action: 'none' });
  expect(raised(deps)).toHaveLength(0);
  expect(deps.episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
});

test('gate off: a standing notice closes (a rollback leaves none) and nothing is raised', async () => {
  delete process.env.GATE_AUTO_DISPATCH_CHECK_DOWN_NOTICE;
  const deps = depsOf();
  expect(await checkDown.noteRun(tally(), { nowDate: NOW, deps })).toEqual({ action: 'off' });
  expect(deps.episodes.closeAdminAlertKeys).toHaveBeenCalledWith(deps.db, [KEY], 'gate_off', expect.objectContaining({ now: NOW }));
  expect(raised(deps)).toHaveLength(0);
});

test('the check itself off: the notice closes, nothing is raised', async () => {
  const deps = depsOf();
  expect(await checkDown.noteRun(null, { enabled: false, nowDate: NOW, deps })).toEqual({ action: 'check_off' });
  expect(deps.episodes.closeAdminAlertKeys).toHaveBeenCalledWith(deps.db, [KEY], 'check_off', expect.objectContaining({ resolution: 'The move check is turned off' }));
  expect(raised(deps)).toHaveLength(0);
});

test('a failure never throws to the run', async () => {
  const deps = depsOf();
  deps.episodes.raiseAdminAlertWithReopen.mockRejectedValue(new Error('db down'));
  await expect(checkDown.noteRun(tally(), { nowDate: NOW, deps })).resolves.toEqual({ action: 'error' });
});

test.each([
  ['anthropic_400', 'refused the call'], ['anthropic_401', 'rejected the API key'], ['openai_403', 'rejected the API key'],
  ['anthropic_429', 'limiting how often'], ['anthropic_529', 'down or overloaded'], ['anthropic_timeout', 'did not answer in time'],
  ['no_key', 'no API key'], ['bad_answer', 'cannot read'], ['empty_json', 'cannot read'], ['check_failed', 'database read failed'],
  ['error', 'the call failed'],
])('cause %s reads in plain words', (code, words) => {
  expect(checkDown.causeText(code)).toContain(words);
});

test.each(['anthropic_400', 'anthropic_401', 'anthropic_429', 'anthropic_529', 'anthropic_timeout', 'no_key', 'bad_answer', 'check_failed', 'some_new_code'])(
  'every cause composes under the notice rules (%s)',
  async (code) => {
    const deps = depsOf();
    await checkDown.noteRun(tally({ brokeCause: code }), { nowDate: NOW, deps });
    // The helper got a composed notice: the rules ran (a violation would have thrown inside noteRun).
    expect(raised(deps)).toHaveLength(1);
    expect(raised(deps)[0][2].length).toBeLessThanOrEqual(110);
  },
);

test('the why stays inside 110 characters even for a long cause', async () => {
  const deps = depsOf();
  await checkDown.noteRun(tally({ broke: 1234, brokeCause: 'unknown_provider_some_very_long_provider_name_that_goes_on' }), { nowDate: NOW, deps });
  expect(raised(deps)).toHaveLength(1);
  expect(raised(deps)[0][2].length).toBeLessThanOrEqual(110);
});
