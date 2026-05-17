const fs = require('fs');
const path = require('path');
const {
  buildEquipmentReconciliation,
  scoreEquipmentMatch,
  scoreTaxMatch,
} = require('../services/equipment-reconciliation');

const systems = [
  {
    id: 'system-flowzone-1',
    name: 'FlowZone Typhoon 2.5 #1',
    system_type: 'backpack',
    active: true,
  },
  {
    id: 'system-tank-1',
    name: '110-Gallon Spray Tank #1',
    system_type: 'tank',
    active: true,
    pump_asset_id: 'equipment-pump-1',
    reel_asset_id: 'equipment-reel-1',
  },
  {
    id: 'system-retired',
    name: 'Retired Spray Rig',
    system_type: 'tank',
    active: false,
  },
];

const equipment = [
  {
    id: 'equipment-flowzone-1',
    name: 'FlowZone Typhoon 2.5 #1',
    asset_tag: 'BP-001',
    category: 'sprayer',
    status: 'active',
    make: 'FlowZone',
    model: 'Typhoon 2.5',
    purchase_price: 250,
  },
  {
    id: 'equipment-pump-1',
    name: 'Udor Kappa 40GR Pump',
    asset_tag: 'PUMP-001',
    category: 'pump',
    status: 'active',
    purchase_price: 900,
    tax_equipment_id: 'tax-pump-1',
  },
  {
    id: 'equipment-reel-1',
    name: 'Hannay 1500 Hose Reel',
    asset_tag: 'REEL-001',
    category: 'reel',
    status: 'active',
  },
  {
    id: 'equipment-van-1',
    name: 'Ford Transit 250 Service Van',
    asset_tag: 'VAN-001',
    category: 'vehicle',
    status: 'active',
    make: 'Ford',
    model: 'Transit 250',
    serial_number: 'VIN-123',
    purchase_price: 35000,
  },
];

const taxRegister = [
  {
    id: 'tax-pump-1',
    name: 'Udor Kappa 40GR Pump',
    asset_category: 'pump',
    active: true,
    disposed: false,
    purchase_cost: 900,
  },
  {
    id: 'tax-van-1',
    name: 'Ford Transit 250',
    asset_category: 'vehicle',
    active: true,
    disposed: false,
    serial_number: 'VIN-123',
    make_model: 'Ford Transit 250',
    purchase_cost: 35000,
  },
];

describe('equipment system reconciliation', () => {
  test('links component assets and flags active systems without equipment links', () => {
    const report = buildEquipmentReconciliation({
      systems,
      equipment,
      taxRegister,
      calibrations: [
        {
          id: 'calibration-tank-1',
          equipment_system_id: 'system-tank-1',
          carrier_gal_per_1000: '2.25',
          calibrated_at: '2026-05-17T12:00:00.000Z',
          expires_at: '2026-06-16T12:00:00.000Z',
        },
      ],
    });

    expect(report.summary.systems_active).toBe(2);
    expect(report.summary.systems_with_any_equipment_link).toBe(1);
    expect(report.summary.systems_without_equipment_link).toBe(1);

    const tank = report.systems.find((system) => system.id === 'system-tank-1');
    expect(tank.component_assets.pump).toMatchObject({
      id: 'equipment-pump-1',
      asset_tag: 'PUMP-001',
    });
    expect(tank.component_assets.reel).toMatchObject({
      id: 'equipment-reel-1',
      asset_tag: 'REEL-001',
    });
    expect(tank.active_calibration).toMatchObject({
      id: 'calibration-tank-1',
      carrier_gal_per_1000: 2.25,
    });

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'system_unlinked',
          id: 'system-flowzone-1',
        }),
      ]),
    );
  });

  test('suggests operational and tax-register matches without mutating links', () => {
    const report = buildEquipmentReconciliation({
      systems,
      equipment,
      taxRegister,
      calibrations: [],
    });

    const flowzone = report.systems.find((system) => system.id === 'system-flowzone-1');
    expect(flowzone.suggested_equipment_matches[0]).toMatchObject({
      id: 'equipment-flowzone-1',
      asset_tag: 'BP-001',
    });

    const van = report.equipment.find((row) => row.id === 'equipment-van-1');
    expect(van.tax_register).toBeNull();
    expect(van.suggested_tax_matches[0]).toMatchObject({
      id: 'tax-van-1',
      name: 'Ford Transit 250',
      asset_category: 'vehicle',
    });

    const taxVan = report.tax_register.find((row) => row.id === 'tax-van-1');
    expect(taxVan.linked_equipment).toEqual([]);
    expect(taxVan.suggested_equipment_matches[0]).toMatchObject({
      id: 'equipment-van-1',
      asset_tag: 'VAN-001',
    });
  });

  test('treats stale tax-register ids as missing links', () => {
    const report = buildEquipmentReconciliation({
      systems: [],
      equipment: [
        {
          id: 'equipment-stale-tax',
          name: 'Ford Transit 250 Service Van',
          category: 'vehicle',
          status: 'active',
          purchase_price: 35000,
          tax_equipment_id: 'tax-row-that-does-not-exist',
        },
      ],
      taxRegister,
      calibrations: [],
    });

    expect(report.summary.equipment_with_tax_link).toBe(0);
    expect(report.summary.equipment_without_tax_link).toBe(1);
    expect(report.equipment[0].tax_register).toBeNull();
    expect(report.equipment[0].suggested_tax_matches[0]).toMatchObject({
      id: 'tax-van-1',
      asset_category: 'vehicle',
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'equipment_stale_tax_link',
          id: 'equipment-stale-tax',
        }),
      ]),
    );
  });

  test('retired equipment does not satisfy active system reconciliation', () => {
    const report = buildEquipmentReconciliation({
      systems: [
        {
          id: 'system-retired-link',
          name: 'Tank linked to retired pump',
          system_type: 'tank',
          active: true,
          pump_asset_id: 'equipment-retired-pump',
        },
      ],
      equipment: [
        {
          id: 'equipment-retired-pump',
          name: 'Retired Udor Pump',
          category: 'pump',
          status: 'retired',
        },
      ],
      taxRegister: [],
      calibrations: [],
    });

    expect(report.summary.systems_with_any_equipment_link).toBe(0);
    expect(report.summary.systems_without_equipment_link).toBe(1);
    expect(report.systems[0].linked_equipment_ids).toEqual(['equipment-retired-pump']);
    expect(report.systems[0].active_linked_equipment_ids).toEqual([]);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'system_unlinked' }),
        expect.objectContaining({ type: 'system_inactive_equipment_link' }),
      ]),
    );
  });

  test('inactive systems do not hide active spray equipment link gaps', () => {
    const report = buildEquipmentReconciliation({
      systems: [
        {
          id: 'system-inactive-flowzone',
          name: 'Inactive FlowZone System',
          system_type: 'backpack',
          active: false,
          primary_equipment_id: 'equipment-flowzone-1',
        },
      ],
      equipment: [equipment[0]],
      taxRegister: [],
      calibrations: [],
    });

    expect(report.summary.equipment_linked_to_systems).toBe(0);
    expect(report.equipment[0].linked_systems).toEqual([
      {
        id: 'system-inactive-flowzone',
        name: 'Inactive FlowZone System',
        system_type: 'backpack',
      },
    ]);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'equipment_missing_system_link',
          id: 'equipment-flowzone-1',
        }),
      ]),
    );
  });

  test('match scoring favors exact system names and serial-number tax links', () => {
    expect(scoreEquipmentMatch(systems[0], equipment[0])).toBeGreaterThanOrEqual(100);
    expect(scoreTaxMatch(equipment[3], taxRegister[1])).toBeGreaterThanOrEqual(120);
  });
});

describe('equipment system asset-link migration', () => {
  test('adds primary equipment and component FKs to the operational equipment table', () => {
    const source = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'models',
        'migrations',
        '20260517000002_link_equipment_system_assets.js',
      ),
      'utf8',
    );

    expect(source).toContain('primary_equipment_id');
    expect(source).toContain('REFERENCES equipment(id)');
    expect(source).toContain('END;\n    $$;');
    expect(source).toContain('equipment_systems_${column}_equipment_fkey');
    expect(source).toContain('clearOrphanAssetLinks');
    expect(source).toContain('NOT EXISTS');
    expect(source).toContain("asset_tag = 'PUMP-001'");
    expect(source).toContain("asset_tag = 'REEL-001'");
  });
});

describe('equipment system asset-link route guards', () => {
  test('validates UUID-shaped equipment links before querying Postgres', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'routes', 'admin-equipment-systems.js'),
      'utf8',
    );

    expect(source).toContain('const UUID_RE =');
    expect(source).toContain('invalidSystemAssetIdFields');
    expect(source).toContain('Invalid equipment link ids');
    expect(source).toContain('invalid_fields');
  });
});
