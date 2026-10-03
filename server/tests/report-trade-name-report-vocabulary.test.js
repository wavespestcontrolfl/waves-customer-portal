/**
 * Report vocabulary inside catalog names (audit 2026-10-03, prod read-only):
 * over the 274 most recent pest AI reports, a note that read like its report
 * marked a catalog product "mentioned" by a plain word in its name, and that
 * product's full screen then refused the report itself for 135 of them
 * (49%). These names and words are the audit's own. The plain words count
 * only in the mention check: the visit's own products, and a product the note
 * does name, keep their full screen (#5729).
 */
const CompletionRecap = require('../services/completion-recap');
const { catalogScreensForPrompt } = require('../routes/admin-schedule')._test;

const CATALOG = [
  { name: 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer', category: 'fertilizer' },
  { name: 'LESCO Manicure 6FL Contact Fungicide', category: 'fungicide' },
  { name: 'Primo Maxx Plant Growth Regulator for Turf', category: 'pgr' },
  { name: 'LESCO Moisture Manager', category: 'soil moisture management aid' },
  { name: 'HexPro Termite Monitoring Baiting System', category: 'termite monitoring' },
  { name: 'SUPERthrive Foliage-Pro 9-3-6', category: 'fertilizer' },
  { name: 'LESCO Three-Way Selective Herbicide', category: 'herbicide' },
  { name: 'Tim-bor Professional Insecticide and Fungicide', category: 'insecticide' },
  { name: 'Advion Cockroach Gel Bait', category: 'bait', active_ingredient: 'Indoxacarb' },
  { name: 'Termidor SC', category: 'termiticide', active_ingredient: 'Fipronil' },
];
const NOTE = 'German cockroach activity was high under the kitchen sink and behind the fridge. Moisture around the sink '
  + 'pipe draws them. Baited the cabinets and the bait stations, and I will keep monitoring the system of stations. '
  + 'Plant growth along the foundation is heavy; three areas need trimming. Customer can contact us with questions.';
const DRAFT = "WHAT WE FOUND\n\nGerman cockroach activity was high under the kitchen sink, and moisture around the sink pipe draws them.\n\n"
  + "WHAT WE DID AND WHY\n\nWe baited the cabinets and kept monitoring the system of stations around the home.\n\n"
  + "WHAT TO EXPECT\n\nPlant growth along the foundation gives them cover; trimming three areas will help.\n\n"
  + "WHAT'S NEXT\n\nContact us if you see more activity.";

describe('plain words inside catalog names', () => {
  test('a note that reads like a report names no catalog product by its plain words', () => {
    expect(catalogScreensForPrompt(CATALOG, NOTE).names).toEqual([]);
  });

  test('a product the note does name is still named, by its brand word', () => {
    expect(catalogScreensForPrompt(CATALOG, 'The customer asked about Termidor and the Advion gel.').names)
      .toEqual(['Advion Cockroach Gel Bait', 'Termidor SC']);
    expect(catalogScreensForPrompt(CATALOG, 'Used some hexpro stations and manicure on the lawn edge.').names)
      .toEqual(['LESCO Manicure 6FL Contact Fungicide', 'HexPro Termite Monitoring Baiting System']);
  });

  // The screen as the route builds it under the writer rules: what the note
  // names, in full, plus the catalog-wide brand screen.
  const routeScreen = (note) => CompletionRecap.buildReportTradeNameScreen({
    extraNames: catalogScreensForPrompt(CATALOG, note).names, wholeCatalog: true, catalogRows: CATALOG, mentionedText: note,
  });

  test('so an ordinary report written from that note passes the screen', async () => {
    expect((await routeScreen(NOTE))(DRAFT)).toBe(false);
  });

  test('and the brands themselves are still refused', async () => {
    const screen = await routeScreen(NOTE);
    for (const named of ['We applied Manicure to the edges.', 'We installed HexPro stations.', 'We used Tim-bor in the attic.', 'Then Primo Maxx was applied.', 'The Advion went in the cabinets.']) {
      expect(screen(named)).toBe(true);
    }
  });

  test('a product the note does name keeps its full screen (#5729)', async () => {
    const screen = await routeScreen('The customer asked about the LESCO Moisture Manager.');
    expect(screen('We noted moisture by the track.')).toBe(true);
  });

  test('a name left with only plain long words falls back to its own short words, never "and"', async () => {
    const screen = await CompletionRecap.buildReportTradeNameScreen({ extraNames: ['Tim-bor Professional Insecticide and Fungicide'] });
    expect(screen('We treated the attic and the crawl space, and checked the vents.')).toBe(false);
    expect(screen('Tim bor dust went in the voids.')).toBe(true);
  });
});
