// GATE_LAWN_V13 has no bahia track, so the pricing knowledge entry written by the KB sync stops
// promising one. The customer guide at /service-details/lawn_care names no grass at all (owner
// 2026-11-26: "dont mention the lawn types"), gate on or off.
jest.mock('../models/db', () => jest.fn());
const { lawnTrackKnowledgeLines, lawnTrackNames } = require('../services/lawn-program');
const { buildServiceDetailsContent } = require('../services/estimate-service-details');

afterEach(() => { delete process.env.GATE_LAWN_V13; });

const lawnRow = (content) => content.systemBox.rows.find((row) => row[0] === 'Built for your lawn');
const guide = async () => {
  const db = require('../models/db');
  db.mockImplementation(() => { throw new Error('no registry in this test'); });
  return buildServiceDetailsContent('lawn_care', {}, {});
};

describe('gate off', () => {
  test('the knowledge line is the old text and the guide row names no grass', async () => {
    expect(lawnTrackKnowledgeLines()).toEqual(['Tracks: St. Augustine | Bermuda | Zoysia | Bahia']);
    expect(lawnTrackNames()).toEqual(['St. Augustine', 'Bermuda', 'Zoysia', 'Bahia']);
    expect(lawnRow(await guide())).toEqual(['Built for your lawn', 'We inspect your lawn before anything goes down and use only products labeled for it']);
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

  test('the customer guide row is the same plain row and names no grass', async () => {
    const content = await guide();
    expect(lawnRow(content)).toEqual(['Built for your lawn', 'We inspect your lawn before anything goes down and use only products labeled for it']);
    expect(JSON.stringify(content.systemBox)).not.toMatch(/Bahia|Bermuda|Zoysia|St\. Augustine/);
  });
});

describe('the public quote contract for a bahia lawn', () => {
  const fs = require('fs');
  const path = require('path');
  const message = "Your grass type needs a quick look from our team before we finalize lawn pricing — we'll send your exact price shortly.";
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').replace(/\\'/g, "'");

  test('/calculate answers the bahia reason with the customer message, and the contract doc quotes both', () => {
    const route = read('server/routes/public-quote.js');
    expect(route).toContain("quoteRequiredReason === 'lawn_v13_bahia_no_program'");
    expect(route).toContain(message);
    const doc = read('docs/public-route-contracts.md').replace(/\s+/g, ' ');
    expect(doc).toContain("reason: 'lawn_v13_bahia_no_program'");
    expect(doc).toContain(`"${message}"`);
  });

  test('the engine reason that /calculate reads is the one a bahia lawn carries', () => {
    process.env.GATE_LAWN_V13 = 'true';
    try {
      const { priceLawnCare } = require('../services/pricing-engine/service-pricing');
      const line = priceLawnCare({ turfSf: 4500, turfConfidence: 'HIGH' }, { track: 'bahia' });
      expect(line.customQuoteReason).toBe('lawn_v13_bahia_no_program');
      expect(line.requiresManualReview).toBe(true);
    } finally { delete process.env.GATE_LAWN_V13; }
  });
});
