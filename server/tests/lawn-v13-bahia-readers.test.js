// get_protocol (protocol-reader) under GATE_LAWN_V13: bahia has no program, so the reader says so
// and no longer tells callers to ask for it. Gate off, the old note and the bahia track are unchanged.
const protocolsJson = require('../config/protocols.json');
const { getProtocol, normalizeLawnTrack, LAWN_TRACK_ALIASES } = require('../services/protocol-reader');

afterEach(() => { delete process.env.GATE_LAWN_V13; });

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_LAWN_V13 = 'true'; });

  test.each(['bahia', 'D', 'd_bahia', 'D_Bahia'])('lawn_track %s: no program, no protocol, and the note says why', (lawn_track) => {
    const result = getProtocol({ service_type: 'lawn', lawn_track });
    expect(result.protocol).toBeUndefined();
    expect(result.no_program).toBe(true);
    expect(result.available_tracks).toEqual(['st_augustine', 'bermuda', 'zoysia']);
    expect(result.note).toMatch(/Bahiagrass has no lawn program under v13/);
    expect(result.note).toMatch(/Celsius/);
    expect(result.note).not.toMatch(/Specify/);
  });

  test('an unknown track lists only the tracks that exist and never offers bahia', () => {
    const result = getProtocol({ service_type: 'lawn', lawn_track: 'nope' });
    expect(result.available_tracks).toEqual(['st_augustine', 'bermuda', 'zoysia']);
    expect(result.note).toContain('st_augustine, bermuda, zoysia');
    expect(result.note).not.toMatch(/D = Bahia/);
    expect(result.no_program).toBeUndefined();
  });

  test('the other tracks still resolve', () => {
    for (const lawn_track of ['st_augustine', 'bermuda', 'zoysia', 'C1']) expect(getProtocol({ service_type: 'lawn', lawn_track }).protocol).toBeDefined();
  });

  test('the aliases stay in the table for the old program', () => {
    expect(LAWN_TRACK_ALIASES).toMatchObject({ d: 'bahia', d_bahia: 'bahia' });
  });
});

describe('gate off', () => {
  test('bahia and its aliases resolve to the old bahia track, and the note is the old text', () => {
    expect(normalizeLawnTrack('D')).toBe('bahia');
    expect(getProtocol({ service_type: 'lawn', lawn_track: 'bahia' }).protocol).toBe(protocolsJson.lawn.bahia);
    const unknown = getProtocol({ service_type: 'lawn', lawn_track: 'nope' });
    expect(unknown.available_tracks).toEqual(Object.keys(protocolsJson.lawn));
    expect(unknown.note).toBe('Specify st_augustine, bermuda, zoysia, or bahia (legacy A/B = St. Augustine, C1 = Bermuda, C2 = Zoysia, D = Bahia).');
  });
});
