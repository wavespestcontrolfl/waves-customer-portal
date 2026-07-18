/**
 * Tech IB get_protocol — regression tests for the protocols.json rendering
 * fixes: legacy lawn-track labels must resolve to real track keys (the old
 * default 'A' never matched, so EVERY lawn protocol query fell to the
 * "specify a track" note), and every non-lawn program in protocols.json must
 * be reachable (pest/rodent/mosquito/palm/cockroach/bed_bug/termite formerly
 * returned "not found" despite carrying full visit data).
 */

const { executeTechTool } = require('../services/intelligence-bar/tech-tools');
const protocols = require('../config/protocols.json');

describe('tech IB get_protocol', () => {
  test.each([
    ['A', 'st_augustine'],
    ['B', 'st_augustine'],
    ['C1', 'bermuda'],
    ['C2', 'zoysia'],
    ['D', 'bahia'],
    ['st_augustine', 'st_augustine'],
    ['bahia', 'bahia'],
  ])('lawn track %s resolves to %s', async (input, expected) => {
    const r = await executeTechTool('get_protocol', { service_type: 'lawn', lawn_track: input });
    expect(r.track).toBe(expected);
    expect(Array.isArray(r.protocol?.visits)).toBe(true);
  });

  test('lawn with no track defaults to st_augustine instead of the dead A key', async () => {
    const r = await executeTechTool('get_protocol', { service_type: 'lawn' });
    expect(r.track).toBe('st_augustine');
  });

  test('unknown lawn track returns the real available tracks', async () => {
    const r = await executeTechTool('get_protocol', { service_type: 'lawn', lawn_track: 'nope' });
    expect(r.available_tracks).toEqual(Object.keys(protocols.lawn));
  });

  test.each(
    Object.keys(protocols).filter((k) => k !== 'lawn'),
  )('program %s is reachable with its visit data', async (key) => {
    const r = await executeTechTool('get_protocol', { service_type: key });
    expect(r.type).toBe(key);
    expect(r.protocol?.visits?.length).toBe(protocols[key].visits.length);
  });

  test('synonyms map to programs (roach → cockroach, palm → palm_injection)', async () => {
    expect((await executeTechTool('get_protocol', { service_type: 'roach' })).type).toBe('cockroach');
    expect((await executeTechTool('get_protocol', { service_type: 'palm' })).type).toBe('palm_injection');
  });

  test('unknown service lists available programs instead of a dead-end note', async () => {
    const r = await executeTechTool('get_protocol', { service_type: 'volcano_control' });
    expect(r.available_programs).toEqual(expect.arrayContaining(['pest', 'rodent', 'lawn']));
  });
});
