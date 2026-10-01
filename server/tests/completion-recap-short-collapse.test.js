// "Bifen I/T" must not match the word "it": a collapsed pair shorter than
// four letters is an ordinary word, not a brand. The real echoes still match.
const { containsProductName, buildReportTradeNameScreen } = require('../services/completion-recap');

const BIFEN = [{ name: 'Bifen I/T' }];
const opts = { wholeWord: true };

describe('product-name matcher: short collapsed pairs', () => {
  test('ordinary "it" never matches Bifen I/T', () => {
    expect(containsProductName('We kept the spray off it, and it dried before we left.', BIFEN, opts)).toBe(false);
  });

  test('real echoes of Bifen I/T still match', () => {
    expect(containsProductName('We used Bifen on the shrubs.', BIFEN, opts)).toBe(true);
    expect(containsProductName('An I/T product went on the shrubs.', BIFEN, opts)).toBe(true);
    expect(containsProductName('Bifen I/T went on the shrubs.', BIFEN, opts)).toBe(true);
  });

  test('a short collapse with a digit is still a product designation', () => {
    const treeAge = [{ name: 'Arborjet Tree-Age G-4 Injectable Insecticide' }];
    expect(containsProductName('We injected the oak with G4.', treeAge, opts)).toBe(true);
    expect(containsProductName('We injected the oak with G-4.', treeAge, opts)).toBe(true);
  });

  test('longer collapsed echoes are unchanged', () => {
    expect(containsProductName('We used TZone inside.', [{ name: 'T-Zone SE' }], opts)).toBe(true);
    expect(containsProductName('We applied BoraCare to the wood.', [{ name: 'Bora-Care' }], opts)).toBe(true);
  });

  test('the report trade-name screen passes copy with "it" for a Bifen I/T visit', async () => {
    const screen = await buildReportTradeNameScreen({ products: BIFEN, extraNames: [], db: null });
    expect(screen('Light activity along the back fence; we kept the spray off it.')).toBe(false);
    expect(screen('We sprayed Bifen I/T along the fence.')).toBe(true);
  });
});

describe('report trade-name screen: ordinary pest and bait words', () => {
  test('"ant bait" and "bait gel" are copy, not Advion Ant Bait Gel', async () => {
    const screen = await buildReportTradeNameScreen({ products: [{ name: 'Advion Ant Bait Gel' }], extraNames: [], db: null });
    expect(screen('We placed ant bait along the back of the counter.')).toBe(false);
    expect(screen('We put bait gel in the cabinet hinges.')).toBe(false);
    expect(screen('We used Advion in the kitchen.')).toBe(true);
    expect(screen('Advion ant gel went under the sink.')).toBe(true);
  });

  test('singular pest words are copy too', async () => {
    const screen = await buildReportTradeNameScreen({ products: [{ name: 'Contrac Rat Bait' }, { name: 'Wasp Freeze Bee Spray' }], extraNames: [], db: null });
    expect(screen('We checked the rat bait stations by the shed.')).toBe(false);
    expect(screen('A bee nest was under the eave.')).toBe(false);
    expect(screen('We refilled the Contrac blocks.')).toBe(true);
  });
});
