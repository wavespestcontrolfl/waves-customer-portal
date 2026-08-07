const migration = require('../models/migrations/20260807200000_lawn_product_target_fills');

const { FILLS } = migration;

// Every ACTIVE products_catalog.name in prod on 2026-08-07 (read-only pull).
// THE TRIPWIRE THIS MIGRATION EXISTS FOR: 20260723000001 keyed its fills on
// names that a dedupe migration had already deactivated, so the values landed
// on dead rows and the picker kept serving empty targets. A FILLS name that
// is not in this snapshot is that bug returning.
const ACTIVE_CATALOG_NAMES_2026_08_07 = [
  '46-0-0 Urea Professional Fertilizer',
  'Acelepryn Insecticide',
  'Acelepryn Xtra',
  'Adjourn SC',
  'ADORN Fungicide',
  'Advance Termite Bait Station',
  'Advion Ant Bait Gel',
  'Advion Cockroach Gel Bait',
  'Advion Evolution Cockroach Gel Bait',
  'Advion WDG Granular',
  'Alpine WSG',
  'Altosid 30 Day Briquets',
  'Anuew EZ Plant Growth Regulator',
  'Aprehend',
  'Arborjet Arbor OTC Fungicide 1 oz',
  'Arborjet Arbor OTC Fungicide 5 oz',
  'Arborjet Ima-Jet 10',
  'Arborjet Ima-Jet Systemic Insecticide',
  'ArborJet Mn-Jet Fe Micros',
  'Arborjet NUTRIROOT 1 gal',
  'Arborjet NUTRIROOT 1 qt',
  'Arborjet NUTRIROOT 2.5 gal',
  'Arborjet Palm-Jet Palm Nutrition',
  'Arborjet PHOSPHO-Jet Systemic Fungicide',
  'Arborjet Propizol Injectable Fungicide',
  'Arborjet Tree-Age G-4 Injectable Insecticide',
  'ArborJet Tree-Age R10 Insecticide',
  'Arena 50 WDG',
  'Armada 50 WDG',
  'Artavia 2 SC (Azoxy)',
  'Atrazine 4L',
  'Atticus Gunner',
  'Atticus Talak',
  'Avid Insecticide',
  'Azatin O Biological Insecticide',
  'Badge SC Bactericide/Fungicide',
  'Banol Fungicide',
  'Barricade 4FL',
  'Barricade 65WG',
  'BASF Pillar SC Intrinsic Brand Fungicide',
  'Bifen I/T',
  'Bifen XTS',
  'Blindside Herbicide',
  'Bloom City Clean Kelp',
  'Bora-Care',
  'BRANDT Agra Sol Micro Mix',
  'BRANDT Indicate 5',
  'Celsius WG',
  'Certainty Turf Herbicide',
  'Chelated Liquid Iron (brand TBD)',
  'Chipco Signature',
  'Compass Fungicide',
  'Conserve SC',
  'Contrac Blox',
  'Cytogro Liquid Biostimulant',
  'Cyzmic CS',
  'Delta Dust',
  'Demand CS',
  'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide',
  'Dismiss 64 oz',
  'Dismiss NXT',
  'Dispatch Sprayable Wetting Agent',
  'Distance IGR',
  'Dominion 2L 1 gal',
  'Dominion 2L 27.5 oz',
  'Drive XLR8 Post Emergent Liquid Herbicide',
  'Dylox 420 SL T&O Insecticide',
  'Eagle 20EW Fungicide',
  'Elector PSP',
  'Endurant PR Turf Colorant',
  'Envu Specticle Flo Pre-Emergent Liquid Herbicide',
  'Espoma Organic Alfalfa Meal 2-0-2',
  'Espoma Organic Soil Acidifier',
  'Floramite Miticide 1 qt',
  'Floramite SC/LS 8 oz',
  'Forbid 4F',
  'Fusilade II Post Emergent Liquid Herbicide',
  'Gentrol IGR',
  'Gravex 20 EW',
  'Harris 49% Vinegar Concentrate Professional',
  'Headway Fungicide',
  'Headway G',
  'Heritage Action Fungicide',
  'Heritage G',
  'Heritage TL',
  'HexPro Termite Monitoring Baiting System',
  'Hexygon IQ Miticide',
  'Hydretain Liquid',
  'In2Care Mosquito Station',
  'Kontos Insecticide/Miticide',
  'KPHITE 7LP Systemic Fungicide',
  'LESCO 0-0-18 Bio KMAG 1% Fe 1% Mg 1% Mn 2.17% S Organic Turf Granular Fertilizer',
  'LESCO 0-0-62 AM MOP Turfgrass Soluble Fertilize',
  'LESCO 13-0-13 60% PolyPlus Landscape',
  'LESCO 13-24-6 Landscape Starter',
  'LESCO 15-0-15 30% PolyPlus 1% Fe',
  'LESCO 16-4-8 50% PolyPlus OPTI 0.05%Cu 1%Fe 0.4%Mn 0.15%Zn MOP Turfgrass Granular',
  'LESCO 17-0-10 50% CRN Mini Granular',
  'LESCO 20-0-0 60% CRN Plus Micros Turfgrass Liquid Fertilizer',
  'LESCO 20-2-10 30% PolyPlus',
  'LESCO 20-20-20 Soluble',
  'LESCO 24-0-10 75% PolyPlus OPTI45 Spar-TECH 10% Cl MOP Turfgrass Granular Fertilizer 50 lb. Bag',
  'LESCO 24-0-11 with PolyPlus OPTI',
  'LESCO 24-2-11 50% NOS Plus BIO 6% Fe',
  'LESCO 6-0-0 Liquid',
  'LESCO 7-1-7 40% PolyPlus',
  'LESCO 8-0-10 100% PolyPlus Landscape',
  'LESCO 8-0-10 50% PolyPlus OPTI45 Spar-TECH 1% Fe 1% Mg 1% Mn 0.1% B KMAG Palm & Tropical Ornamental Granular Fertilizer',
  'LESCO 8-0-10 Palm & Tropical',
  'LESCO 8-2-12 100% Poly Plus OPTI Kieserite 4% Mg 9.26% S 0.15% B 0.05% Cu 0.15% Fe 2% Mn 0.15% Zn Palm & Tropical Ornamental Granular Fertilizer',
  'LESCO 9-0-24 56% PolyPlus',
  'LESCO 90/10 Nonionic Surfactant',
  'LESCO CarbonPro-L w/ MobilEX Biostimulant Liquid Soil Amendment',
  'LESCO Chelated AM + Micros Turf & Ornamental Liquid Micronutrient',
  'LESCO Chelated Iron Plus',
  'LESCO Crosscheck Plus',
  'LESCO Elite 0-0-28 AM 7.5% Fe 6.5% Mn 9% S Turfgrass Granular Fertilizer',
  'LESCO Green Flo 6-0-0 10% Ca',
  'LESCO Green Flo Phyte Plus 0-0-26 + Micros Liquid Fertilizer',
  'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer',
  'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer',
  'LESCO Manicure 6FL Contact Fungicide',
  'LESCO Moisture Manager',
  'LESCO Stonewall 0-0-7',
  'LESCO Stonewall 0.37% 18-0-10',
  'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide',
  'LESCO T-Storm 2G Fungicide',
  'LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide',
  'LESCO Three-Way Selective Herbicide',
  'LESCO Tracker Green Spray Indicator Dye',
  'LESCO-Wet Plus Nonionic Wetting Agent',
  'Mainspring GNL Insecticide',
  'Manor',
  'Medallion SC',
  'Merit 2F',
  'Monument 75WG',
  'Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide',
  'Nufarm Cleary 3336F Fungicide',
  'Onslaught Fastcap',
  'Permethrin SFR',
  'PGF Complete 16-4-8',
  'Pillar G Intrinsic',
  'Primo Maxx Plant Growth Regulator for Turf',
  'Prodiamine 65 WDG',
  'QP MSM 60DF Turf Herbicide',
  'Quali-Pro',
  'Quali-Pro PPZ 14.3 Propiconazole',
  'Quali-Pro T-Nex Plant Growth Regulator',
  'Recognition Post Emergent Herbicide',
  'Roundup QuikPro SC',
  'Safari 20 SG',
  'Scion Insecticide',
  'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide',
  'Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide',
  'Segment II Herbicide',
  'Sequestar 6% Fe EDDHA Soluble Micronutrient',
  'Shortstop 2SC Plant Growth Regulator for Trees & Shrubs',
  'Snapshot 2.5TG',
  'Southern Ag Copper Fungicide 27.15%',
  'Specticle Flo',
  'SpeedZone Southern',
  'Subdue Maxx Fungicide',
  'SuffOil-X Spray Oil Emulsion',
  'Summit Mosquito Dunk Tablets',
  'SUPERthrive Foliage-Pro 9-3-6',
  'SureGuard SC',
  'Suspend Polyzone',
  'Suspend SC',
  'T-Zone SE',
  'Talstar P',
  'Talstar XTRA Granular Insecticide (Verge)',
  'Talus 70 DF IGR',
  'Taurus SC',
  'Tekko Pro IGR',
  'Tekko Trio',
  'Temprid FX',
  'Tenacity Herbicide',
  'Termidor Foam',
  'Termidor SC',
  'Tetrino Insecticide',
  'The Andersons Humic DG',
  'The Andersons Turf Fertilizer with Grub/Crabgrass Control',
  'Tim-bor Professional Insecticide and Fungicide',
  'Topchoice Granular Insecticide',
  'Torque SC',
  'Trapper T-Rex Rat Snap Trap',
  'Trelona ATBS Bait Station',
  'Trelona Compressed Termite Bait Cartridges',
  'Tribute Total WDG',
  'TriTek Spray Oil Emulsion (OMRI)',
  'Velista',
  'Vendetta Plus',
  'Victor Expanded Trigger Rat Snap Trap',
  'Zylam Insecticide',
];

function mockKnex() {
  const calls = [];
  const proto = {
    _name: null,
    _guard: null,
    whereRaw(sql, bindings) {
      if (sql.includes('LOWER(name)')) [this._name] = bindings;
      else this._guard = sql;
      return this;
    },
    async update(row) {
      calls.push({ name: this._name, guard: this._guard, wrote: row.target_pests });
      return 1;
    },
  };
  const knex = () => Object.create(proto);
  knex.schema = { hasTable: async () => true };
  return { knex, calls };
}

describe('lawn product target fills migration', () => {
  test('every FILLS name resolves to an ACTIVE catalog row', () => {
    const active = new Set(ACTIVE_CATALOG_NAMES_2026_08_07.map((n) => n.toLowerCase()));
    const dead = FILLS.map(([name]) => name).filter((n) => !active.has(n.toLowerCase()));
    expect(dead).toEqual([]);
  });

  test('no product gets more than 6 targets (owner cap 2026-08-07)', () => {
    const over = FILLS.filter(([, targets]) => targets.length > 6);
    expect(over.map(([name]) => name)).toEqual([]);
  });

  test('no fill lists an uncontrollable organism', () => {
    // UF/IFAS: no chemical control exists for either; a chip is a treatment
    // claim no product can support.
    const banned = FILLS.filter(([, targets]) =>
      targets.some((t) => /ganoderma|thielaviopsis/i.test(t)));
    expect(banned.map(([name]) => name)).toEqual([]);
  });

  test('turf fills never use the "(palms)" nutrition variants', () => {
    // The classifier files "(palm)"-marked tokens onto tree & shrub only.
    const palmMarked = FILLS.filter(([, targets]) =>
      targets.some((t) => /\(palms?\)/i.test(t)));
    expect(palmMarked.map(([name]) => name)).toEqual([]);
  });

  test('every write is gated on the field being empty', async () => {
    const { knex, calls } = mockKnex();
    await migration.up(knex);
    expect(calls).toHaveLength(FILLS.length);
    const ungated = calls.filter(
      (c) => !c.guard || !/target_pests IS NULL/.test(c.guard) || !/\[\]/.test(c.guard),
    );
    expect(ungated.map((c) => c.name)).toEqual([]);
  });

  test('writes the intended list for each product', async () => {
    const { knex, calls } = mockKnex();
    await migration.up(knex);
    calls.forEach((c, i) => {
      const [name, targets] = FILLS[i];
      expect(c.name).toBe(name);
      expect(c.wrote).toBe(JSON.stringify(targets));
    });
  });

  test('down() touches nothing at all', async () => {
    const { knex, calls } = mockKnex();
    await migration.down(knex);
    expect(calls).toEqual([]);
  });
});
