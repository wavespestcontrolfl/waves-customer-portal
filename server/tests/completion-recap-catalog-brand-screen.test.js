// The catalog-wide brand screen (writer rules): a catalog product that is not
// one of this visit's is caught by its brand word or its name as a phrase,
// never by an ordinary word that happens to sit inside a catalog name.
const { buildReportTradeNameScreen } = require('../services/completion-recap');

const CATALOG = [
  { name: 'Termidor SC', active_ingredient: 'Fipronil' },
  { name: 'Trapper T-Rex Rat Snap Trap', active_ingredient: null },
  { name: 'Demand CS', active_ingredient: 'Lambda-cyhalothrin' },
  { name: 'Suspend Polyzone', active_ingredient: 'Deltamethrin' },
  { name: 'Southern Ag Copper Fungicide 27.15%', active_ingredient: 'Copper' },
  { name: 'T-Zone SE', active_ingredient: 'Triclopyr; Sulfentrazone' },
  { name: 'Bora-Care', active_ingredient: 'Disodium octaborate tetrahydrate' },
  { name: 'Pesticide application sign 4x5 (yard sign card)', active_ingredient: null },
  { name: 'Termite protection notice sticker 5.5x4', active_ingredient: null },
  { name: 'Permethrin SFR', active_ingredient: 'Permethrin' },
];

const build = (extra = {}) => buildReportTradeNameScreen({ wholeCatalog: true, catalogRows: CATALOG, ...extra });

describe('catalog-wide brand screen', () => {
  test.each([
    'We used Termidor along the thresholds.',
    'We set Trapper stations in the garage.',
    'We applied Demand CS around the foundation.',
    'The weeds got a T-Zone application.',
    'We applied BoraCare to the sill plate.',
    'The weeds got a tzone application.',
    'The full name, trapper t-rex rat snap trap, went in the attic.',
  ])('a brand word or a product name is caught: %s', async (text) => {
    expect((await build())(text)).toBe(true);
  });

  test.each([
    'We placed snap traps in the garage and checked the bait stations.',
    'Suspend watering for 24 hours after the visit.',
    'Customer demand for a second visit was noted; keep your distance from wet surfaces.',
    'We saw southern chinch bug damage along the driveway.',
    'A pesticide application sign was posted and termite protection was discussed.',
    'WHAT WE FOUND\nGhost ants were trailing along the kitchen threshold.',
    '- Exterior perimeter treatment\n- Granular ant bait in the lawn',
  ])('ordinary wording passes: %s', async (text) => {
    expect((await build())(text)).toBe(false);
  });

  test('an active ingredient that leads a catalog name is not a brand word', async () => {
    expect((await build())('We applied a Permethrin band to the fence line.')).toBe(false);
  });

  test("the visit's own products keep the full screen", async () => {
    const screen = await build({ products: [{ name: 'Trapper T-Rex Rat Snap Trap' }] });
    expect(screen('We set snap stations in the garage.')).toBe(true);
  });

  test('a brand the prompt mentions is caught in any case and position', async () => {
    const screen = await build({ mentionedText: 'Customer asked about termidor. Treated the thresholds.' });
    expect(screen('Termidor was discussed at the door.')).toBe(true);
    expect(screen('You asked about termidor.')).toBe(true);
    // An unmentioned brand keeps the narrow rule.
    expect(screen('Suspend watering for 24 hours after the visit.')).toBe(false);
  });

  test('off by default: no catalog-wide screen without wholeCatalog', async () => {
    const screen = await buildReportTradeNameScreen({ products: [], catalogRows: CATALOG });
    expect(screen('We used Termidor along the thresholds.')).toBe(false);
  });

  test('reads the catalog itself when no rows are passed, and a failed read throws', async () => {
    const reader = (rows) => {
      const db = () => ({ select: async () => rows });
      db.transaction = async (fn) => fn(db);
      return db;
    };
    const screen = await buildReportTradeNameScreen({ wholeCatalog: true, db: reader(CATALOG) });
    expect(screen('We used Termidor along the thresholds.')).toBe(true);
    const failing = () => ({ select: async () => { throw new Error('catalog read failed'); } });
    failing.transaction = async (fn) => fn(failing);
    await expect(buildReportTradeNameScreen({ wholeCatalog: true, db: failing })).rejects.toThrow();
    await expect(buildReportTradeNameScreen({ wholeCatalog: true })).rejects.toThrow();
  });
});
