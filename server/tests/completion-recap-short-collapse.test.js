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
