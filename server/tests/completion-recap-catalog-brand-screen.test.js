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
  { name: 'Pesticide application sign 4x5 (yard sign card)', active_ingredient: null, category: 'supplies' },
  { name: 'Yard sign sticker 4x5 "Serviced by Waves"', active_ingredient: null, category: 'supplies' },
  { name: 'Atticus Talak 7.9 F', active_ingredient: 'Bifenthrin', aliases: ['Talstar P', 'Premium: Dispatch wetting agent', 'Organic acidifier', 'Headway ONLY if severe'] },
  { name: 'Advance Termite Bait Station', active_ingredient: null },
  { name: 'LESCO Green Flo 6-0-0 10% Ca', active_ingredient: null },
  { name: 'Termite protection notice sticker 5.5x4', active_ingredient: null, category: 'supplies' },
  { name: 'Permethrin SFR', active_ingredient: 'Permethrin' },
  { name: 'Prodiamine 65 WDG Pre-Emergent Herbicide', active_ingredient: 'Prodiamine' },
  { name: 'Non-ionic Surfactant', active_ingredient: null },
  { name: 'Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide', display_name: 'Arena 0.25G Granular', active_ingredient: 'Clothianidin' },
];

const build = (extra = {}) => buildReportTradeNameScreen({ wholeCatalog: true, catalogRows: CATALOG, ...extra });

describe('catalog-wide brand screen', () => {
  test.each([
    'We used Termidor along the thresholds.',
    'We set Trapper stations in the garage.',
    'We applied Demand CS around the foundation.',
    'The weeds got a T-Zone application.',
    'We applied BoraCare to the sill plate.',
    'We applied Talak around the foundation.',
    'We applied Green Flo to the lawn.',
    'We applied Talstar around the foundation.',
    'We applied Talstar P around the foundation.',
    'We added Dispatch to the tank.',
    'We added an Organic acidifier to the tank.',
    'We installed Advance Termite Bait Station units along the slab.',
    'We installed Advance bait stations along the slab.',
    'We set T-Rex traps in the attic.',
    'We set trex traps in the attic.',
    'We applied Arena 0.25G to the beds.',
    'WE APPLIED TERMIDOR AROUND THE FOUNDATION.',
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
    'We added a non-ionic surfactant to the tank.',
    'The lawn was green, and the rat snap traps in the garage were empty.',
    'We added an organic acidifier to the tank, and the Premium plan covers it.',
    'We made headway only on the front beds and will dispatch a technician if it returns.',
    'We checked the termite bait stations in advance of the rainy season.',
    'Advance notice: the Application was posted and Serviced by Waves today.',
    'A pre-emergent treatment is planned for spring.',
    'WHAT WE DID AND WHY\nWe treated the thresholds.',
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

  test('an alias the prompt writes out is screened in any case, and only then', async () => {
    const copy = 'Talstar p was discussed, and we added a dispatch wetting agent to the tank.';
    expect((await build())(copy)).toBe(false);
    expect((await build({ mentionedText: 'Customer asked about talstar p.' }))(copy)).toBe(true);
    expect((await build({ mentionedText: 'Tech note: used DISPATCH wetting agent.' }))(copy)).toBe(true);
    expect((await build({ mentionedText: 'Treated the thresholds.' }))(copy)).toBe(false);
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
    // Registered aliases are read with the catalog and screened with it.
    const withAliases = (table) => ({
      select: async () => (table === 'product_aliases'
        ? [{ product_id: 'p1', alias_name: 'Hydretain' }]
        : [{ id: 'p1', name: 'Moisture Manager Humectant', active_ingredient: null }]),
    });
    withAliases.transaction = async (fn) => fn(withAliases);
    const aliasScreen = await buildReportTradeNameScreen({ wholeCatalog: true, db: withAliases });
    expect(aliasScreen('We watered in Hydretain across the front lawn.')).toBe(true);
    expect(aliasScreen('We watered in the front lawn.')).toBe(false);
    const failing = () => ({ select: async () => { throw new Error('catalog read failed'); } });
    failing.transaction = async (fn) => fn(failing);
    await expect(buildReportTradeNameScreen({ wholeCatalog: true, db: failing })).rejects.toThrow();
    await expect(buildReportTradeNameScreen({ wholeCatalog: true })).rejects.toThrow();
  });
});
