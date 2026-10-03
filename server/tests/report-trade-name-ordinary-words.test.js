/**
 * The generate-report trade-name screen against the words of a real catalog
 * (prod 2026-10-02): a visit's notes said "yard" and "along with", which made
 * three yard-sign supplies and two fertilizers whose names hold "with" count
 * as products the prompt named. Their ordinary words ("with", "Waves",
 * "application", "pesticide", "serviced") then refused every draft, both
 * providers missed, and the office saw "AI report generation is temporarily
 * unavailable".
 */
const CompletionRecap = require('../services/completion-recap');
const { catalogScreensForPrompt } = require('../routes/admin-schedule')._test;

const CATALOG = [
  { name: 'Pesticide application sign 4x5 (yard sign card)', category: 'supplies', active_ingredient: null },
  { name: 'Yard sign stake 16in plastic (Blackburn)', category: 'supplies', active_ingredient: null },
  { name: 'Yard sign sticker 4x5 "Serviced by Waves"', category: 'supplies', active_ingredient: null },
  { name: 'The Andersons 17-0-3 Fertilizer with Grubout Plus', category: 'fertilizer', active_ingredient: 'Unknown - pending SDS' },
  { name: 'LESCO 24-0-11 with PolyPlus OPTI', category: 'fertilizer', active_ingredient: '24-0-11' },
  { name: 'Taurus SC', category: 'termiticide / insecticide', active_ingredient: 'Fipronil' },
];
const NOTES = 'Applied both non-repellent and repellent solutions targeting spiders, cockroaches and ants. '
  + 'A six foot non-repellent band went around the entire perimeter, and a repellent solution along with a '
  + 'surfactant was used as a quick knockdown within the yard and ornamentals.';
const ORDINARY_DRAFT = 'We came back with the spray around the perimeter and the yard. With the dry season, pests move '
  + 'toward the house; the application went well and the pesticide band is in place. Thanks for choosing Waves.';

describe('the generate-report trade-name screen keeps ordinary words', () => {
  test('notes that say "yard" and "with" name no catalog product', () => {
    expect(catalogScreensForPrompt(CATALOG, NOTES)).toEqual({ names: [], actives: [] });
  });

  test('a supply never joins the screen, even named outright', () => {
    const prompt = 'We put out a Pesticide application sign 4x5 (yard sign card) and a Yard sign sticker 4x5 "Serviced by Waves".';
    expect(catalogScreensForPrompt(CATALOG, prompt).names).toEqual([]);
  });

  test('a product the notes do name still joins it, with its active', () => {
    expect(catalogScreensForPrompt(CATALOG, 'The customer asked about Taurus SC.')).toEqual({ names: ['Taurus SC'], actives: ['Fipronil'] });
  });

  test('"with" is no brand; the names\' own brands still are', () => {
    const fertilizers = CATALOG.filter((row) => row.category === 'fertilizer');
    expect(CompletionRecap.containsProductName(ORDINARY_DRAFT, fertilizers, { wholeWord: true })).toBe(false);
    expect(CompletionRecap.containsProductName('We spread PolyPlus on the lawn.', fertilizers, { wholeWord: true })).toBe(true);
    expect(CompletionRecap.containsProductName('An Andersons blend went down.', fertilizers, { wholeWord: true })).toBe(true);
  });

  test('a visit\'s recorded supply drops out of the screen; its pesticide still screens', async () => {
    const rows = [
      { id: 'p-taurus', name: 'Taurus SC', active_ingredient: 'Fipronil', formulation: 'SC', category: 'termiticide / insecticide' },
      { id: 'p-sticker', name: 'Yard sign sticker 4x5 "Serviced by Waves"', active_ingredient: null, formulation: null, category: 'supplies' },
    ];
    const db = () => ({ whereIn: () => ({ select: async () => rows }) });
    const screen = await CompletionRecap.buildReportTradeNameScreen({
      products: [{ productId: 'p-taurus' }, { productId: 'p-sticker' }],
      db,
    });
    expect(screen(`${ORDINARY_DRAFT} We serviced the home.`)).toBe(false);
    expect(screen('We applied Taurus along the foundation.')).toBe(true);
  });

  test('the incident\'s whole screen passes an ordinary draft and still refuses a named product', async () => {
    const products = [{ name: 'Taurus SC' }, { name: 'Cyper TC' }, { name: 'LESCO 90/10 Nonionic Surfactant' }, { name: 'Alpine WSG' }];
    const screen = await CompletionRecap.buildReportTradeNameScreen({ products, extraNames: catalogScreensForPrompt(CATALOG, NOTES).names });
    expect(screen(ORDINARY_DRAFT)).toBe(false);
    expect(screen('We sprayed Cyper TC in the yard.')).toBe(true);
  });
});
