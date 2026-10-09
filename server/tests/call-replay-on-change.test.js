// Call check on change (GATE_CALL_REPLAY_EVAL_ON_CHANGE): the reviewed-call
// replay is asked for when the extractor changed, not every Monday. Proves the
// fingerprint moves with each thing that decides the extractor's answers, and
// the life of the one admin item.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const onChange = require('../services/eval/call-replay-on-change');

const fixture = (text) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'call-replay-')), 'reviewed-calls.json');
  fs.writeFileSync(file, text);
  return file;
};
const prompts = (version = 'v9-aaaa') => ({ extractionPromptVersion: (names, opts = {}) => (opts.agentProposedSlotCommitment ? `${version}a` : version) });
const route = (primary = 'gpt-x', fallback = 'claude-y') => ({ primary: { provider: 'openai', model: primary }, fallback: { provider: 'anthropic', model: fallback } });
const print = (over = {}) => onChange.extractorFingerprint({ fixturePath: over.fixturePath || fixture('[1]'), deps: { prompts: over.prompts || prompts(), route: over.route || route() } }).fingerprint;

describe('gate', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  test('on only for exactly "true"', () => {
    delete process.env.GATE_CALL_REPLAY_EVAL_ON_CHANGE;
    expect(onChange.callReplayOnChangeLive()).toBe(false);
    process.env.GATE_CALL_REPLAY_EVAL_ON_CHANGE = 'true';
    expect(onChange.callReplayOnChangeLive()).toBe(true);
  });
});

describe('extractorFingerprint', () => {
  test('is stable for the same extractor', () => {
    expect(print()).toBe(print());
  });

  test.each([
    ['the prompt', { prompts: prompts('v10-bbbb') }],
    ['the primary model', { route: route('gpt-z') }],
    ['the fallback model', { route: route('gpt-x', 'claude-z') }],
    ['the reviewed-call fixture', { fixturePath: fixture('[1,2]') }],
  ])('changes when %s changes', (_label, over) => {
    expect(print(over)).not.toBe(print());
  });

  test('reads the real prompt module, route and fixture', () => {
    const { fingerprint, parts } = onChange.extractorFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(parts.prompt).toBeTruthy();
    expect(parts.promptWithSlots).not.toBe(parts.prompt);
    expect(parts.primary).toMatch(/^(openai|anthropic|gemini)\/.+/);
  });
});

describe('checkCallReplayDue', () => {
  const now = new Date('2026-10-09T07:45:00Z');
  function deps({ checked, openKeys = [] }) {
    return {
      fingerprint: { fingerprint: 'fp-new', parts: { prompt: 'v9-aaaa', primary: 'openai/gpt-x', fallback: 'anthropic/claude-y' } },
      db: () => ({ where: () => ({ first: async () => (checked ? { value: checked } : undefined) }) }),
      episodes: {
        openAdminAlertKeys: jest.fn(async () => openKeys),
        closeAdminAlertKeys: jest.fn(async () => 0),
        raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', rang: true })),
      },
    };
  }

  test('the extractor changed since the last run: one item keyed by the new version; items for older versions are closed', async () => {
    const d = deps({ checked: 'fp-old', openKeys: ['call-replay-due:fp-old', 'call-replay-due:fp-new'] });
    expect(await onChange.checkCallReplayDue({ now, deps: d })).toEqual({ due: true, fingerprint: 'fp-new' });
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['call-replay-due:fp-old']);
    const [category, title, why, opts] = d.episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect([category, title]).toEqual(['system', 'System — run the call check in the terminal']);
    expect(why).toBe('The call extractor changed and the reviewed-call check has not run on the new version.');
    expect(opts).toMatchObject({ dedupeKey: 'call-replay-due:fp-new', link: '/admin/agents' });
    expect(opts.metadata).toMatchObject({ severity: 'needs-you', doneWhen: 'call_check_run' });
    expect(opts.detail).toContain('openai/gpt-x, then anthropic/claude-y');
  });

  test('the replay never ran: the item says so', async () => {
    const d = deps({ checked: null });
    await onChange.checkCallReplayDue({ now, deps: d });
    expect(d.episodes.raiseAdminAlertWithReopen.mock.calls[0][2]).toBe('The reviewed-call check has not run on this version of the call extractor.');
  });

  test('the replay already ran on this version: nothing is raised and the open item is closed', async () => {
    const d = deps({ checked: 'fp-new', openKeys: ['call-replay-due:fp-new'] });
    expect(await onChange.checkCallReplayDue({ now, deps: d })).toEqual({ due: false, fingerprint: 'fp-new' });
    expect(d.episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['call-replay-due:fp-new']);
  });
});

test('markChecked upserts the one settings row', async () => {
  const calls = [];
  const conn = () => ({ insert: (row) => { calls.push(['insert', row]); return { onConflict: (k) => { calls.push(['conflict', k]); return { merge: async (patch) => { calls.push(['merge', patch]); } }; } }; } });
  await onChange.markChecked('fp-new', { conn, now: new Date('2026-10-09T12:00:00Z') });
  expect(calls[0][1]).toMatchObject({ key: onChange.SETTING_KEY, value: 'fp-new', category: 'eval' });
  expect(calls[1]).toEqual(['conflict', 'key']);
  expect(calls[2][1]).toMatchObject({ value: 'fp-new' });
});
