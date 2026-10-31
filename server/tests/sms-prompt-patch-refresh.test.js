// SMS prompt patch refresh watcher (GATE_SMS_PROMPT_AUTOPROMOTE): it is installed in every mode, so a
// runtime flip from off or observe to 'true' loads the active patch in a process that booted earlier.
// No real database: models/db is a recording fake. All rules and versions are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const GOOD_RULE = 'When the facts do not list an arrival window, say you will confirm it instead of naming one.';
const MINUTE = 60 * 1000;

let mockReads;
let mockActiveRow;
jest.mock('../models/db', () => {
  const handle = jest.fn(() => ({ where: () => ({ first: async () => { mockReads.count += 1; return mockActiveRow; } }) }));
  return handle;
});

const patch = require('../services/sms-prompt-patch');
const drafter = require('../services/sms-shadow-drafter');

const SAVED = process.env.GATE_SMS_PROMPT_AUTOPROMOTE;
const setMode = (mode) => {
  if (mode === undefined) delete process.env.GATE_SMS_PROMPT_AUTOPROMOTE;
  else process.env.GATE_SMS_PROMPT_AUTOPROMOTE = mode;
};

beforeEach(() => {
  jest.useFakeTimers();
  mockReads = { count: 0 };
  const built = patch.buildBlock([GOOD_RULE]);
  mockActiveRow = { id: 'p1', patch_no: 1, version_tag: 'C', base_version: drafter.currentPromptVersionBase(), patch_text: built.text, patch_sha: built.sha, rules: [GOOD_RULE] };
  patch.stopPatchRefresh();
  patch.setActivePatchSnapshot(null);
});
afterEach(() => {
  patch.stopPatchRefresh();
  patch.setActivePatchSnapshot(null);
  jest.useRealTimers();
  if (SAVED === undefined) delete process.env.GATE_SMS_PROMPT_AUTOPROMOTE;
  else process.env.GATE_SMS_PROMPT_AUTOPROMOTE = SAVED;
});

describe.each([[undefined], ['observe']])('booted with the gate %s', (bootMode) => {
  test('no database read while the mode is not true; the first minute after a flip to true loads the active patch', async () => {
    setMode(bootMode);
    patch.startPatchRefresh();
    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    expect(mockReads.count).toBe(0);
    expect(patch.getActivePatch()).toBeNull();

    setMode('true'); // a runtime flip; no restart
    await jest.advanceTimersByTimeAsync(MINUTE);
    expect(mockReads.count).toBe(1);
    expect(patch.getActivePatch()).toMatchObject({ patchNo: 1, tag: 'C' });
  });

  test('a flip back to off or observe drops the snapshot and stops the reads', async () => {
    setMode('true');
    patch.startPatchRefresh();
    await jest.advanceTimersByTimeAsync(0);
    expect(patch.getActivePatch()).toMatchObject({ patchNo: 1 });

    setMode(bootMode);
    await jest.advanceTimersByTimeAsync(MINUTE);
    const readsAfterFlip = mockReads.count;
    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    expect(mockReads.count).toBe(readsAfterFlip);
    expect(patch.getActivePatch()).toBeNull();
  });
});

test('starting twice installs one watcher', async () => {
  setMode('true');
  patch.startPatchRefresh();
  patch.startPatchRefresh();
  await jest.advanceTimersByTimeAsync(0);
  expect(mockReads.count).toBe(1);
  await jest.advanceTimersByTimeAsync(MINUTE);
  expect(mockReads.count).toBe(2);
});
