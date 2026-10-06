// GATE_LAWN_V13 has no bahia track, so the copy that lists the lawn tracks (the pricing knowledge
// entry written by the KB sync, and the customer guide at /service-details/lawn_care) stops
// promising one and says the office reviews bahia lawns. Gate off, both are the old text.
jest.mock('../models/db', () => jest.fn());
const { lawnTrackKnowledgeLines, lawnTrackNames } = require('../services/lawn-program');
const { buildServiceDetailsContent } = require('../services/estimate-service-details');

afterEach(() => { delete process.env.GATE_LAWN_V13; });

const grassRow = (content) => content.systemBox.rows.find((row) => row[0] === 'Built for your grass');
const guide = async () => {
  const db = require('../models/db');
  db.mockImplementation(() => { throw new Error('no registry in this test'); });
  return buildServiceDetailsContent('lawn_care', {}, {});
};

describe('gate off', () => {
  test('the knowledge line and the guide row are the old text', async () => {
    expect(lawnTrackKnowledgeLines()).toEqual(['Tracks: St. Augustine | Bermuda | Zoysia | Bahia']);
    expect(lawnTrackNames()).toEqual(['St. Augustine', 'Bermuda', 'Zoysia', 'Bahia']);
    expect(grassRow(await guide())).toEqual(['Built for your grass', 'St. Augustine, Bermuda, Zoysia, and Bahia each run their own product track. We confirm the grass before anything goes down, because a product that helps one grass can injure another']);
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_LAWN_V13 = 'true'; });

  test('the knowledge entry lists the three tracks and says bahia has no program', () => {
    const lines = lawnTrackKnowledgeLines();
    expect(lines[0]).toBe('Tracks: St. Augustine | Bermuda | Zoysia');
    expect(lines[1]).toMatch(/Bahiagrass lawns: no program/);
    expect(lines.join('\n')).not.toMatch(/\| Bahia/);
  });

  test('the customer guide stops promising a bahia track and says the team reviews bahia lawns', async () => {
    const row = grassRow(await guide());
    expect(row).toHaveLength(2);
    expect(row[1]).toContain('Bahiagrass lawns: our team reviews these before quoting');
    expect(row[1]).toContain('St. Augustine, Bermuda or Zoysia');
    expect(row[1]).not.toMatch(/Bahia each run|Bahia\b.*product track/);
  });
});
