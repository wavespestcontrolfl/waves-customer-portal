/**
 * Migration 098 — Seed Equipment Maintenance Data
 *
 * Seeds 8 equipment items with maintenance schedules, historical records,
 * and 90 days of vehicle mileage data for the Ford Transit.
 * Safe to re-run (checks existence before inserting).
 */
const { v4: uuidv4 } = require('uuid');

exports.up = async function (knex) {
  try {
    // Check if we've already seeded
    const existing = await knex('equipment').where('asset_tag', 'VEH-001').first();
    if (existing) return;

    // ── Equipment IDs ─────────────────────────────────────────────
    const transitId = uuidv4();
    const pumpId = uuidv4();
    const reelId = uuidv4();
    const injectorId = uuidv4();
    const spray1Id = uuidv4();
    const spray2Id = uuidv4();
    const detId = uuidv4();
    const topId = uuidv4();

    const now = new Date();
    const today = now.toISOString().split('T')[0];

    function daysAgo(n) {
      const d = new Date(now);
      d.setDate(d.getDate() - n);
      return d;
    }
    function daysAgoStr(n) {
      return daysAgo(n).toISOString().split('T')[0];
    }
    function daysFromNow(n) {
      const d = new Date(now);
      d.setDate(d.getDate() + n);
      return d.toISOString().split('T')[0];
    }
    function monthsAgo(n) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - n);
      return d;
    }
    function monthsAgoStr(n) {
      return monthsAgo(n).toISOString().split('T')[0];
    }

    // ── 1. Insert Equipment ──────────────────────────────────────
    const equipmentData = [
      {
        id: transitId, name: 'Ford Transit 250 AWD', asset_tag: 'VEH-001',
        category: 'vehicle', subcategory: 'service_van', make: 'Ford', model: 'Transit 250 AWD',
        serial_number: null, year: 2022, vin: '1FTBR1C88NKA12345', license_plate: 'WAVES01',
        purchase_date: '2022-03-15', purchase_price: 48500.00, purchase_vendor: 'AutoNation Ford',
        warranty_expiration: '2027-03-15', warranty_details: '5yr/60k powertrain, 3yr/36k bumper-to-bumper',
        depreciation_method: 'MACRS', useful_life_years: 5, salvage_value: 12000.00,
        status: 'active', condition_rating: 8, location: 'field',
        engine_type: '3.5L V6 EcoBoost', fuel_type: 'gasoline',
        current_hours: 0, current_miles: 47500, notes: 'Primary service vehicle. Custom spray rig buildout.',
      },
      {
        id: pumpId, name: 'Udor KAPPA-55/GR5 Pump + Honda GX160', asset_tag: 'PUMP-001',
        category: 'pump', subcategory: 'diaphragm', make: 'Udor', model: 'KAPPA-55/GR5',
        serial_number: 'UD-K55-2023-0847', year: 2023,
        purchase_date: '2023-06-10', purchase_price: 1850.00, purchase_vendor: 'QSpray',
        warranty_expiration: '2025-06-10', warranty_details: '2yr manufacturer warranty on pump body',
        depreciation_method: 'section_179', useful_life_years: 7, salvage_value: 200.00,
        status: 'active', condition_rating: 7, location: 'van',
        engine_type: 'Honda GX160', fuel_type: 'gasoline',
        current_hours: 820, current_miles: 0,
        notes: 'Mounted in Transit. 7 GPM @ 580 PSI max. Oil change every 50hrs.',
      },
      {
        id: reelId, name: 'Hannay Powered Hose Reel', asset_tag: 'REEL-001',
        category: 'reel', subcategory: 'powered', make: 'Hannay', model: 'AN-227',
        serial_number: 'HN-227-2023-1102', year: 2023,
        purchase_date: '2023-06-10', purchase_price: 2200.00, purchase_vendor: 'QSpray',
        warranty_expiration: '2025-06-10', warranty_details: '2yr warranty on motor and frame',
        depreciation_method: 'section_179', useful_life_years: 10, salvage_value: 300.00,
        status: 'active', condition_rating: 8, location: 'van',
        engine_type: 'AN-227 12V DC motor', fuel_type: 'electric',
        current_hours: 650, current_miles: 0,
        notes: '300ft 1/2" hose. Tatoko PWM speed controller. Grease bearings monthly.',
      },
      {
        id: injectorId, name: 'Arborjet QUIK-jet Air', asset_tag: 'INJ-001',
        category: 'injection', subcategory: 'tree_injection', make: 'Arborjet', model: 'QUIK-jet Air',
        serial_number: 'AJ-QJA-2024-0312', year: 2024,
        purchase_date: '2024-02-20', purchase_price: 1200.00, purchase_vendor: 'Arborjet Direct',
        warranty_expiration: '2026-02-20', warranty_details: '2yr limited warranty',
        depreciation_method: 'section_179', useful_life_years: 5, salvage_value: 150.00,
        status: 'active', condition_rating: 9, location: 'van',
        engine_type: null, fuel_type: 'compressed_air',
        current_hours: 45, current_miles: 0,
        notes: 'Pneumatic tree injection system. Used for trunk injections of insecticides/fungicides.',
      },
      {
        id: spray1Id, name: 'FlowZone Typhoon 2.5 #1', asset_tag: 'SPRAY-001',
        category: 'sprayer', subcategory: 'backpack', make: 'FlowZone', model: 'Typhoon 2.5',
        serial_number: 'FZ-T25-2023-0455', year: 2023,
        purchase_date: '2023-04-01', purchase_price: 199.00, purchase_vendor: 'SiteOne',
        warranty_expiration: '2025-04-01', warranty_details: '2yr manufacturer warranty',
        depreciation_method: 'section_179', useful_life_years: 3, salvage_value: 0,
        status: 'active', condition_rating: 7, location: 'van',
        engine_type: null, fuel_type: 'battery',
        current_hours: 310, current_miles: 0,
        notes: 'Primary backpack sprayer for spot treatments. 18V lithium-ion battery.',
      },
      {
        id: spray2Id, name: 'FlowZone Typhoon 2.5 #2', asset_tag: 'SPRAY-002',
        category: 'sprayer', subcategory: 'backpack', make: 'FlowZone', model: 'Typhoon 2.5',
        serial_number: 'FZ-T25-2024-1188', year: 2024,
        purchase_date: '2024-01-15', purchase_price: 199.00, purchase_vendor: 'SiteOne',
        warranty_expiration: '2026-01-15', warranty_details: '2yr manufacturer warranty',
        depreciation_method: 'section_179', useful_life_years: 3, salvage_value: 0,
        status: 'active', condition_rating: 6, location: 'van',
        engine_type: null, fuel_type: 'battery',
        current_hours: 180, current_miles: 0,
        notes: 'Backup backpack sprayer. Wand tip slightly worn — replace soon.',
      },
      {
        id: detId, name: 'Classen TR-20H Dethatcher', asset_tag: 'LAWN-001',
        category: 'dethatcher', subcategory: 'walk_behind', make: 'Classen', model: 'TR-20H',
        serial_number: 'CL-TR20-2024-0089', year: 2024,
        purchase_date: '2024-09-01', purchase_price: 3500.00, purchase_vendor: 'SiteOne',
        warranty_expiration: '2026-09-01', warranty_details: '2yr commercial warranty',
        depreciation_method: 'section_179', useful_life_years: 7, salvage_value: 500.00,
        status: 'active', condition_rating: 9, location: 'storage',
        engine_type: 'Honda GX160', fuel_type: 'gasoline',
        current_hours: 35, current_miles: 0,
        notes: 'Seasonal use — spring/fall dethatching. Currently in storage.',
      },
      {
        id: topId, name: 'EcoLawn ECO 250S Top Dresser', asset_tag: 'LAWN-002',
        category: 'topdresser', subcategory: 'walk_behind', make: 'EcoLawn', model: 'ECO 250S',
        serial_number: 'EL-250S-2024-0201', year: 2024,
        purchase_date: '2024-09-01', purchase_price: 6800.00, purchase_vendor: 'EcoLawn Direct',
        warranty_expiration: '2026-09-01', warranty_details: '2yr manufacturer warranty',
        depreciation_method: 'section_179', useful_life_years: 7, salvage_value: 1000.00,
        status: 'active', condition_rating: 9, location: 'storage',
        engine_type: 'Honda GX200', fuel_type: 'gasoline',
        current_hours: 20, current_miles: 0,
        notes: 'Top dresser for sand/compost. 11.5 cu ft hopper. Seasonal use — in storage.',
      },
    ];

    // Update existing or insert new for each piece of equipment
    for (const eq of equipmentData) {
      const existingByName = await knex('equipment').where('name', eq.name).first();
      if (existingByName) {
        // Update the existing record with new fields
        const { id, ...updates } = eq;
        await knex('equipment').where('id', existingByName.id).update({ ...updates, updated_at: knex.fn.now() });
        // Remap the ID so schedules/records reference the right equipment
        eq.id = existingByName.id;
        // Update our local ID references
        if (eq.asset_tag === 'VEH-001') equipmentData[0].id = existingByName.id;
        if (eq.asset_tag === 'PUMP-001') equipmentData[1].id = existingByName.id;
        if (eq.asset_tag === 'REEL-001') equipmentData[2].id = existingByName.id;
        if (eq.asset_tag === 'INJ-001') equipmentData[3].id = existingByName.id;
        if (eq.asset_tag === 'SPRAY-001') equipmentData[4].id = existingByName.id;
        if (eq.asset_tag === 'SPRAY-002') equipmentData[5].id = existingByName.id;
        if (eq.asset_tag === 'LAWN-001') equipmentData[6].id = existingByName.id;
        if (eq.asset_tag === 'LAWN-002') equipmentData[7].id = existingByName.id;
      } else {
        await knex('equipment').insert({ ...eq, created_at: knex.fn.now(), updated_at: knex.fn.now() });
      }
    }

    // Re-read final IDs in case they were remapped
    const finalTransitId = equipmentData[0].id;
    const finalPumpId = equipmentData[1].id;
    const finalReelId = equipmentData[2].id;
    const finalInjectorId = equipmentData[3].id;
    const finalSpray1Id = equipmentData[4].id;
    const finalSpray2Id = equipmentData[5].id;
    const finalDetId = equipmentData[6].id;
    const finalTopId = equipmentData[7].id;

    // ── 2. Maintenance Schedules ─────────────────────────────────
    const schedules = [
      // Ford Transit (7 schedules)
      { equipment_id: finalTransitId, task_name: 'Engine Oil & Filter Change', description: 'Full synthetic 5W-30, Motorcraft FL-500S filter', interval_miles: 7500, interval_months: 6, next_due_miles: 48000, next_due_at: daysFromNow(12), priority: 'high', estimated_cost: 85.00, estimated_downtime_hours: 1 },
      { equipment_id: finalTransitId, task_name: 'Tire Rotation', description: 'Rotate all 4 tires, check pressure (45 PSI front, 50 PSI rear)', interval_miles: 10000, interval_months: 6, next_due_miles: 50000, next_due_at: daysFromNow(30), priority: 'normal', estimated_cost: 40.00, estimated_downtime_hours: 0.5 },
      { equipment_id: finalTransitId, task_name: 'Brake Inspection', description: 'Check pads, rotors, fluid level. Replace pads under 4mm.', interval_miles: 20000, interval_months: 12, next_due_miles: 50000, next_due_at: daysFromNow(30), priority: 'high', estimated_cost: 350.00, estimated_downtime_hours: 3 },
      { equipment_id: finalTransitId, task_name: 'Transmission Fluid Check', description: 'Check level and condition. Replace every 60k miles.', interval_miles: 30000, interval_months: 24, next_due_miles: 60000, next_due_at: daysFromNow(180), priority: 'normal', estimated_cost: 250.00, estimated_downtime_hours: 2 },
      { equipment_id: finalTransitId, task_name: 'Air Filter Replacement', description: 'Replace engine air filter. Check cabin air filter.', interval_miles: 15000, interval_months: 12, next_due_miles: 50000, next_due_at: daysFromNow(45), priority: 'low', estimated_cost: 35.00, estimated_downtime_hours: 0.25 },
      { equipment_id: finalTransitId, task_name: 'Coolant Flush', description: 'Drain and replace coolant. Check hoses and thermostat.', interval_miles: 30000, interval_months: 24, next_due_miles: 60000, next_due_at: daysFromNow(180), priority: 'normal', estimated_cost: 150.00, estimated_downtime_hours: 1.5 },
      { equipment_id: finalTransitId, task_name: 'Annual DOT Inspection', description: 'Commercial vehicle safety inspection — lights, brakes, tires, mirrors', interval_months: 12, next_due_at: daysFromNow(-5), priority: 'critical', estimated_cost: 75.00, estimated_downtime_hours: 2, is_overdue: true },

      // Udor KAPPA-55 Pump (6 schedules)
      { equipment_id: finalPumpId, task_name: 'Engine Oil Change (Honda GX160)', description: '10W-30 oil, 0.58 qt capacity. Check air filter.', interval_hours: 50, next_due_hours: 850, next_due_at: daysFromNow(14), priority: 'high', estimated_cost: 15.00, estimated_downtime_hours: 0.5 },
      { equipment_id: finalPumpId, task_name: 'Diaphragm Inspection', description: 'Inspect all 3 diaphragms for wear, cracking. Replace if needed.', interval_hours: 200, next_due_hours: 1000, next_due_at: daysFromNow(60), priority: 'normal', estimated_cost: 120.00, estimated_downtime_hours: 2 },
      { equipment_id: finalPumpId, task_name: 'Valve Kit Inspection', description: 'Check inlet/outlet valves. Replace worn valve seats.', interval_hours: 300, next_due_hours: 900, next_due_at: daysFromNow(30), priority: 'normal', estimated_cost: 85.00, estimated_downtime_hours: 1.5 },
      { equipment_id: finalPumpId, task_name: 'Spark Plug Replacement', description: 'NGK BPR6ES spark plug. Check gap 0.028".', interval_hours: 100, next_due_hours: 850, next_due_at: daysFromNow(14), priority: 'low', estimated_cost: 8.00, estimated_downtime_hours: 0.25 },
      { equipment_id: finalPumpId, task_name: 'Air Filter Clean/Replace', description: 'Clean foam pre-filter, check paper element. Replace annually.', interval_hours: 50, next_due_hours: 850, next_due_at: daysFromNow(14), priority: 'normal', estimated_cost: 12.00, estimated_downtime_hours: 0.25 },
      { equipment_id: finalPumpId, task_name: 'Pressure Regulator Calibration', description: 'Verify output pressure at regulator. Recalibrate if drift >5%.', interval_months: 3, next_due_at: daysFromNow(-3), priority: 'high', estimated_cost: 0, estimated_downtime_hours: 0.5, is_overdue: true },

      // Hannay Reel (5 schedules)
      { equipment_id: finalReelId, task_name: 'Bearing Lubrication', description: 'Grease main reel bearings. Zerk fittings on both sides.', interval_days: 30, next_due_at: daysFromNow(8), priority: 'normal', estimated_cost: 5.00, estimated_downtime_hours: 0.25 },
      { equipment_id: finalReelId, task_name: 'Hose Inspection', description: 'Check 300ft hose for cracks, kinks, fitting leaks. Pressure test.', interval_months: 3, next_due_at: daysFromNow(25), priority: 'normal', estimated_cost: 0, estimated_downtime_hours: 0.5 },
      { equipment_id: finalReelId, task_name: 'Motor Brush Inspection', description: 'Check AN-227 motor brushes for wear. Replace under 5mm.', interval_hours: 200, next_due_hours: 700, next_due_at: daysFromNow(20), priority: 'normal', estimated_cost: 35.00, estimated_downtime_hours: 1 },
      { equipment_id: finalReelId, task_name: 'PWM Controller Check', description: 'Test Tatoko PWM controller. Verify smooth speed ramp. Check wiring.', interval_months: 6, next_due_at: daysFromNow(60), priority: 'low', estimated_cost: 0, estimated_downtime_hours: 0.5 },
      { equipment_id: finalReelId, task_name: 'Swivel Seal Replacement', description: 'Replace reel swivel o-rings and seals. Check for leaks under pressure.', interval_months: 12, next_due_at: daysFromNow(90), priority: 'normal', estimated_cost: 25.00, estimated_downtime_hours: 1 },

      // Arborjet QUIK-jet Air (3 schedules)
      { equipment_id: finalInjectorId, task_name: 'O-Ring Kit Replacement', description: 'Replace all o-rings in injection tips and coupler. Use silicone lube.', interval_months: 6, next_due_at: daysFromNow(45), priority: 'normal', estimated_cost: 18.00, estimated_downtime_hours: 0.5 },
      { equipment_id: finalInjectorId, task_name: 'Clean & Flush System', description: 'Flush with clean water after each use day. Deep clean with vinegar monthly.', interval_days: 30, next_due_at: daysFromNow(15), priority: 'normal', estimated_cost: 0, estimated_downtime_hours: 0.25 },
      { equipment_id: finalInjectorId, task_name: 'Pressure Gauge Calibration', description: 'Verify pressure gauge accuracy. Replace if off by >5 PSI.', interval_months: 12, next_due_at: daysFromNow(120), priority: 'low', estimated_cost: 25.00, estimated_downtime_hours: 0.25 },

      // FlowZone Typhoon #1 (4 schedules)
      { equipment_id: finalSpray1Id, task_name: 'Nozzle Tip Replacement', description: 'Replace TeeJet flat fan tip. Check for uneven pattern.', interval_months: 3, next_due_at: daysFromNow(10), priority: 'normal', estimated_cost: 12.00, estimated_downtime_hours: 0.25 },
      { equipment_id: finalSpray1Id, task_name: 'Wand & Hose Check', description: 'Inspect wand for cracks, check hose connections for leaks.', interval_months: 3, next_due_at: daysFromNow(10), priority: 'normal', estimated_cost: 0, estimated_downtime_hours: 0.25 },
      { equipment_id: finalSpray1Id, task_name: 'Battery Health Check', description: 'Check 18V Li-ion battery charge capacity. Replace if <80%.', interval_months: 6, next_due_at: daysFromNow(60), priority: 'normal', estimated_cost: 65.00, estimated_downtime_hours: 0.25 },
      { equipment_id: finalSpray1Id, task_name: 'Pump Seal Inspection', description: 'Check internal pump seals for leaks. Replace annually.', interval_months: 12, next_due_at: daysFromNow(120), priority: 'normal', estimated_cost: 30.00, estimated_downtime_hours: 0.5 },

      // FlowZone Typhoon #2 (4 schedules)
      { equipment_id: finalSpray2Id, task_name: 'Nozzle Tip Replacement', description: 'Replace TeeJet flat fan tip. Check for uneven pattern.', interval_months: 3, next_due_at: daysFromNow(10), priority: 'normal', estimated_cost: 12.00, estimated_downtime_hours: 0.25 },
      { equipment_id: finalSpray2Id, task_name: 'Wand & Hose Check', description: 'Inspect wand for cracks, check hose connections for leaks.', interval_months: 3, next_due_at: daysFromNow(10), priority: 'normal', estimated_cost: 0, estimated_downtime_hours: 0.25 },
      { equipment_id: finalSpray2Id, task_name: 'Battery Health Check', description: 'Check 18V Li-ion battery charge capacity. Replace if <80%.', interval_months: 6, next_due_at: daysFromNow(30), priority: 'normal', estimated_cost: 65.00, estimated_downtime_hours: 0.25 },
      { equipment_id: finalSpray2Id, task_name: 'Pump Seal Inspection', description: 'Check internal pump seals for leaks. Replace annually.', interval_months: 12, next_due_at: daysFromNow(90), priority: 'normal', estimated_cost: 30.00, estimated_downtime_hours: 0.5 },

      // Classen TR-20H Dethatcher (5 schedules)
      { equipment_id: finalDetId, task_name: 'Engine Oil Change', description: '10W-30, Honda GX160. Check before each season.', interval_hours: 50, interval_months: 6, next_due_hours: 50, next_due_at: daysFromNow(60), priority: 'high', estimated_cost: 15.00, estimated_downtime_hours: 0.5 },
      { equipment_id: finalDetId, task_name: 'Tine Inspection & Replacement', description: 'Check tine wear. Replace sets showing >50% wear.', interval_hours: 25, next_due_hours: 50, next_due_at: daysFromNow(60), priority: 'normal', estimated_cost: 85.00, estimated_downtime_hours: 1 },
      { equipment_id: finalDetId, task_name: 'Belt Tension Check', description: 'Check drive belt tension and condition. Replace if cracked.', interval_hours: 50, next_due_hours: 50, next_due_at: daysFromNow(60), priority: 'normal', estimated_cost: 35.00, estimated_downtime_hours: 0.5 },
      { equipment_id: finalDetId, task_name: 'Spark Plug Replacement', description: 'NGK BPR6ES spark plug. Check gap 0.028".', interval_hours: 100, next_due_hours: 100, next_due_at: daysFromNow(120), priority: 'low', estimated_cost: 8.00, estimated_downtime_hours: 0.25 },
      { equipment_id: finalDetId, task_name: 'Pre-Season Inspection', description: 'Full inspection before spring/fall season. Check all belts, tines, engine.', interval_months: 6, next_due_at: daysFromNow(60), priority: 'high', estimated_cost: 0, estimated_downtime_hours: 1 },

      // EcoLawn ECO 250S (4 schedules)
      { equipment_id: finalTopId, task_name: 'Engine Oil Change', description: '10W-30, Honda GX200. Check before each season.', interval_hours: 50, interval_months: 6, next_due_hours: 50, next_due_at: daysFromNow(60), priority: 'high', estimated_cost: 15.00, estimated_downtime_hours: 0.5 },
      { equipment_id: finalTopId, task_name: 'Conveyor Belt Inspection', description: 'Check conveyor belt for wear, tears, and tension.', interval_hours: 25, next_due_hours: 40, next_due_at: daysFromNow(45), priority: 'normal', estimated_cost: 120.00, estimated_downtime_hours: 2 },
      { equipment_id: finalTopId, task_name: 'Hopper & Gate Calibration', description: 'Calibrate spread gate settings. Check hopper for buildup/corrosion.', interval_months: 3, next_due_at: daysFromNow(45), priority: 'normal', estimated_cost: 0, estimated_downtime_hours: 0.5 },
      { equipment_id: finalTopId, task_name: 'Pre-Season Inspection', description: 'Full inspection before topdressing season. Engine, conveyor, gate.', interval_months: 6, next_due_at: daysFromNow(60), priority: 'high', estimated_cost: 0, estimated_downtime_hours: 1 },
    ];

    // Insert schedules and store IDs for linking records
    const scheduleIdMap = {};
    for (const s of schedules) {
      const id = uuidv4();
      await knex('maintenance_schedules').insert({
        id,
        ...s,
        is_active: true,
        notify_days_before: 7,
        notify_technician: true,
        notify_admin: true,
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
      const key = `${s.equipment_id}_${s.task_name}`;
      scheduleIdMap[key] = id;
    }

    // ── 3. Historical Maintenance Records ────────────────────────
    const records = [
      // Transit — 6 records
      { equipment_id: finalTransitId, maintenance_type: 'scheduled', task_name: 'Engine Oil & Filter Change', performed_at: monthsAgo(6), performed_by: 'Jiffy Lube', vendor_name: 'Jiffy Lube', miles_at_service: 40000, condition_before: 8, condition_after: 9, parts_cost: 45, labor_cost: 40, total_cost: 85, parts_used: JSON.stringify([{ name: 'Motorcraft FL-500S filter', qty: 1 }, { name: '5W-30 Full Synthetic 6qt', qty: 1 }]) },
      { equipment_id: finalTransitId, maintenance_type: 'scheduled', task_name: 'Tire Rotation', performed_at: monthsAgo(5), performed_by: 'Discount Tire', vendor_name: 'Discount Tire', miles_at_service: 41000, condition_before: 7, condition_after: 8, parts_cost: 0, labor_cost: 40, total_cost: 40 },
      { equipment_id: finalTransitId, maintenance_type: 'repair', task_name: 'Rear Brake Pad Replacement', performed_at: monthsAgo(4), performed_by: 'Meineke', vendor_name: 'Meineke', miles_at_service: 42500, condition_before: 6, condition_after: 9, parts_cost: 180, labor_cost: 150, total_cost: 330, parts_used: JSON.stringify([{ name: 'Ceramic brake pads rear set', qty: 1 }]), downtime_hours: 3, equipment_was_down: true },
      { equipment_id: finalTransitId, maintenance_type: 'scheduled', task_name: 'Air Filter Replacement', performed_at: monthsAgo(3), performed_by: 'Adam', miles_at_service: 44000, condition_before: 8, condition_after: 8, parts_cost: 25, labor_cost: 0, total_cost: 25, parts_used: JSON.stringify([{ name: 'Motorcraft FA-1927 air filter', qty: 1 }]) },
      { equipment_id: finalTransitId, maintenance_type: 'scheduled', task_name: 'Engine Oil & Filter Change', performed_at: monthsAgo(1), performed_by: 'Jiffy Lube', vendor_name: 'Jiffy Lube', miles_at_service: 46500, condition_before: 8, condition_after: 9, parts_cost: 45, labor_cost: 40, total_cost: 85 },
      { equipment_id: finalTransitId, maintenance_type: 'reactive', task_name: 'Windshield Chip Repair', performed_at: monthsAgo(2), performed_by: 'Safelite', vendor_name: 'Safelite', miles_at_service: 45000, condition_before: 7, condition_after: 8, parts_cost: 0, labor_cost: 0, vendor_cost: 75, total_cost: 75 },

      // Pump — 5 records
      { equipment_id: finalPumpId, maintenance_type: 'scheduled', task_name: 'Engine Oil Change (Honda GX160)', performed_at: monthsAgo(10), performed_by: 'Adam', hours_at_service: 550, condition_before: 8, condition_after: 9, parts_cost: 12, labor_cost: 0, total_cost: 12 },
      { equipment_id: finalPumpId, maintenance_type: 'scheduled', task_name: 'Engine Oil Change (Honda GX160)', performed_at: monthsAgo(7), performed_by: 'Adam', hours_at_service: 650, condition_before: 7, condition_after: 8, parts_cost: 12, labor_cost: 0, total_cost: 12 },
      { equipment_id: finalPumpId, maintenance_type: 'scheduled', task_name: 'Diaphragm Inspection', performed_at: monthsAgo(5), performed_by: 'Adam', hours_at_service: 700, condition_before: 7, condition_after: 8, parts_cost: 0, labor_cost: 0, total_cost: 0 },
      { equipment_id: finalPumpId, maintenance_type: 'scheduled', task_name: 'Engine Oil Change (Honda GX160)', performed_at: monthsAgo(3), performed_by: 'Adam', hours_at_service: 770, condition_before: 7, condition_after: 8, parts_cost: 12, labor_cost: 0, total_cost: 12 },
      { equipment_id: finalPumpId, maintenance_type: 'repair', task_name: 'Pressure Regulator Rebuild', performed_at: monthsAgo(8), performed_by: 'QSpray Tech Support', vendor_name: 'QSpray', hours_at_service: 620, condition_before: 5, condition_after: 8, parts_cost: 45, labor_cost: 0, vendor_cost: 65, total_cost: 110, downtime_hours: 4, equipment_was_down: true },

      // Reel — 4 records
      { equipment_id: finalReelId, maintenance_type: 'scheduled', task_name: 'Bearing Lubrication', performed_at: monthsAgo(1), performed_by: 'Adam', hours_at_service: 630, condition_before: 8, condition_after: 8, parts_cost: 5, labor_cost: 0, total_cost: 5 },
      { equipment_id: finalReelId, maintenance_type: 'scheduled', task_name: 'Hose Inspection', performed_at: monthsAgo(3), performed_by: 'Adam', hours_at_service: 580, condition_before: 7, condition_after: 8, parts_cost: 0, labor_cost: 0, total_cost: 0 },
      { equipment_id: finalReelId, maintenance_type: 'repair', task_name: 'Hose End Fitting Replacement', performed_at: monthsAgo(6), performed_by: 'Adam', hours_at_service: 450, condition_before: 5, condition_after: 8, parts_cost: 35, labor_cost: 0, total_cost: 35, parts_used: JSON.stringify([{ name: '1/2" brass hose fitting', qty: 2 }]) },
      { equipment_id: finalReelId, maintenance_type: 'scheduled', task_name: 'Motor Brush Inspection', performed_at: monthsAgo(4), performed_by: 'Adam', hours_at_service: 500, condition_before: 7, condition_after: 8, parts_cost: 0, labor_cost: 0, total_cost: 0 },

      // Injector — 3 records
      { equipment_id: finalInjectorId, maintenance_type: 'scheduled', task_name: 'O-Ring Kit Replacement', performed_at: monthsAgo(6), performed_by: 'Adam', hours_at_service: 25, condition_before: 8, condition_after: 9, parts_cost: 18, labor_cost: 0, total_cost: 18 },
      { equipment_id: finalInjectorId, maintenance_type: 'scheduled', task_name: 'Clean & Flush System', performed_at: monthsAgo(1), performed_by: 'Adam', hours_at_service: 40, condition_before: 8, condition_after: 9, parts_cost: 0, labor_cost: 0, total_cost: 0 },
      { equipment_id: finalInjectorId, maintenance_type: 'inspection', task_name: 'Pressure Gauge Calibration', performed_at: monthsAgo(8), performed_by: 'Adam', hours_at_service: 15, condition_before: 9, condition_after: 9, parts_cost: 0, labor_cost: 0, total_cost: 0 },

      // Sprayer #1 — 4 records
      { equipment_id: finalSpray1Id, maintenance_type: 'scheduled', task_name: 'Nozzle Tip Replacement', performed_at: monthsAgo(3), performed_by: 'Adam', hours_at_service: 280, condition_before: 7, condition_after: 8, parts_cost: 12, labor_cost: 0, total_cost: 12 },
      { equipment_id: finalSpray1Id, maintenance_type: 'scheduled', task_name: 'Battery Health Check', performed_at: monthsAgo(6), performed_by: 'Adam', hours_at_service: 220, condition_before: 7, condition_after: 7, parts_cost: 0, labor_cost: 0, total_cost: 0 },
      { equipment_id: finalSpray1Id, maintenance_type: 'repair', task_name: 'Wand Replacement', performed_at: monthsAgo(9), performed_by: 'Adam', hours_at_service: 180, condition_before: 5, condition_after: 8, parts_cost: 45, labor_cost: 0, total_cost: 45 },
      { equipment_id: finalSpray1Id, maintenance_type: 'scheduled', task_name: 'Nozzle Tip Replacement', performed_at: monthsAgo(6), performed_by: 'Adam', hours_at_service: 240, condition_before: 7, condition_after: 8, parts_cost: 12, labor_cost: 0, total_cost: 12 },

      // Sprayer #2 — 3 records
      { equipment_id: finalSpray2Id, maintenance_type: 'scheduled', task_name: 'Nozzle Tip Replacement', performed_at: monthsAgo(3), performed_by: 'Adam', hours_at_service: 160, condition_before: 6, condition_after: 7, parts_cost: 12, labor_cost: 0, total_cost: 12 },
      { equipment_id: finalSpray2Id, maintenance_type: 'scheduled', task_name: 'Battery Health Check', performed_at: monthsAgo(5), performed_by: 'Adam', hours_at_service: 130, condition_before: 7, condition_after: 7, parts_cost: 0, labor_cost: 0, total_cost: 0 },
      { equipment_id: finalSpray2Id, maintenance_type: 'repair', task_name: 'Pump Seal Replacement', performed_at: monthsAgo(2), performed_by: 'Adam', hours_at_service: 170, condition_before: 5, condition_after: 7, parts_cost: 30, labor_cost: 0, total_cost: 30, follow_up_needed: true, follow_up_notes: 'Monitor for leaks over next 2 weeks', follow_up_date: daysAgoStr(30) },

      // Dethatcher — 3 records
      { equipment_id: finalDetId, maintenance_type: 'scheduled', task_name: 'Engine Oil Change', performed_at: monthsAgo(6), performed_by: 'Adam', hours_at_service: 20, condition_before: 9, condition_after: 9, parts_cost: 12, labor_cost: 0, total_cost: 12 },
      { equipment_id: finalDetId, maintenance_type: 'inspection', task_name: 'Pre-Season Inspection', performed_at: monthsAgo(6), performed_by: 'Adam', hours_at_service: 20, condition_before: 9, condition_after: 9, parts_cost: 0, labor_cost: 0, total_cost: 0 },
      { equipment_id: finalDetId, maintenance_type: 'scheduled', task_name: 'Tine Inspection & Replacement', performed_at: monthsAgo(6), performed_by: 'Adam', hours_at_service: 20, condition_before: 8, condition_after: 9, parts_cost: 85, labor_cost: 0, total_cost: 85, parts_used: JSON.stringify([{ name: 'Replacement tine set', qty: 1 }]) },

      // Top Dresser — 3 records
      { equipment_id: finalTopId, maintenance_type: 'scheduled', task_name: 'Engine Oil Change', performed_at: monthsAgo(6), performed_by: 'Adam', hours_at_service: 10, condition_before: 9, condition_after: 9, parts_cost: 12, labor_cost: 0, total_cost: 12 },
      { equipment_id: finalTopId, maintenance_type: 'inspection', task_name: 'Pre-Season Inspection', performed_at: monthsAgo(6), performed_by: 'Adam', hours_at_service: 10, condition_before: 9, condition_after: 9, parts_cost: 0, labor_cost: 0, total_cost: 0 },
      { equipment_id: finalTopId, maintenance_type: 'scheduled', task_name: 'Conveyor Belt Inspection', performed_at: monthsAgo(4), performed_by: 'Adam', hours_at_service: 15, condition_before: 8, condition_after: 9, parts_cost: 0, labor_cost: 0, total_cost: 0 },
    ];

    for (const r of records) {
      await knex('maintenance_records').insert({
        id: uuidv4(),
        ...r,
        parts_used: r.parts_used || null,
        downtime_hours: r.downtime_hours || 0,
        equipment_was_down: r.equipment_was_down || false,
        follow_up_needed: r.follow_up_needed || false,
        follow_up_notes: r.follow_up_notes || null,
        follow_up_date: r.follow_up_date || null,
        warranty_claim: false,
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }

    // ── 4. Vehicle Mileage Log (90 days for Transit) ─────────────
    let odometerStart = 47500 - 5400; // approx 5400 miles over 90 days
    let fuelDayCounter = 0;
    const fuelInterval = 3; // fill up every 3 days

    for (let i = 89; i >= 0; i--) {
      const logDate = daysAgoStr(i);
      const dayOfWeek = daysAgo(i).getDay(); // 0=Sun, 6=Sat

      // Skip weekends
      if (dayOfWeek === 0 || dayOfWeek === 6) continue;

      const dailyMiles = Math.floor(60 + Math.random() * 41); // 60-100
      const odometerEnd = odometerStart + dailyMiles;
      const personalMiles = Math.round(Math.random() * 5 * 10) / 10; // 0-5 personal
      const businessMiles = dailyMiles - personalMiles;
      const businessPct = Math.round((businessMiles / dailyMiles) * 10000) / 100;
      const jobsServiced = Math.floor(4 + Math.random() * 6); // 4-9 jobs/day
      const irsDeduction = Math.round(businessMiles * 0.70 * 100) / 100;

      // Fuel every 3-4 weekdays
      fuelDayCounter++;
      let fuelGallons = null;
      let fuelCost = null;
      let fuelPricePerGallon = null;
      if (fuelDayCounter >= fuelInterval) {
        fuelDayCounter = 0;
        fuelGallons = Math.round((12 + Math.random() * 8) * 100) / 100; // 12-20 gallons
        fuelPricePerGallon = Math.round((3.20 + Math.random() * 0.60) * 1000) / 1000; // $3.20-$3.80
        fuelCost = Math.round(fuelGallons * fuelPricePerGallon * 100) / 100;
      }

      await knex('vehicle_mileage_log').insert({
        vehicle_id: finalTransitId,
        log_date: logDate,
        odometer_start: odometerStart,
        odometer_end: odometerEnd,
        total_miles: dailyMiles,
        source: 'manual',
        business_miles: businessMiles,
        personal_miles: personalMiles,
        business_pct: businessPct,
        fuel_gallons: fuelGallons,
        fuel_cost: fuelCost,
        fuel_price_per_gallon: fuelPricePerGallon,
        jobs_serviced: jobsServiced,
        irs_standard_rate: 0.70,
        irs_deduction_amount: irsDeduction,
        logged_by: 'Adam',
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });

      odometerStart = odometerEnd;
    }

    // ── 5. Seed some maintenance alerts ──────────────────────────
    // DOT Inspection overdue alert
    await knex('maintenance_alerts').insert({
      id: uuidv4(),
      equipment_id: finalTransitId,
      alert_type: 'maintenance_overdue',
      severity: 'critical',
      title: 'OVERDUE: Annual DOT Inspection — Ford Transit VEH-001',
      description: 'Annual DOT inspection is 5 days overdue. Schedule immediately to maintain compliance.',
      status: 'new',
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });

    // Pressure regulator overdue alert
    await knex('maintenance_alerts').insert({
      id: uuidv4(),
      equipment_id: finalPumpId,
      alert_type: 'maintenance_overdue',
      severity: 'high',
      title: 'OVERDUE: Pressure Regulator Calibration — Udor KAPPA-55 PUMP-001',
      description: 'Pressure regulator calibration is 3 days overdue. Verify output pressure to ensure proper application rates.',
      status: 'new',
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });

    // Follow-up alert for sprayer #2
    await knex('maintenance_alerts').insert({
      id: uuidv4(),
      equipment_id: finalSpray2Id,
      alert_type: 'follow_up_due',
      severity: 'medium',
      title: 'Follow-up Due: Pump Seal Replacement — FlowZone Typhoon #2 SPRAY-002',
      description: 'Pump seal was replaced 2 months ago. Monitor for leaks — follow-up inspection due.',
      status: 'new',
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });

  } catch (err) {
    console.error('Equipment seed error (non-fatal):', err.message);
  }
};

exports.down = async function (knex) {
  // Clear seeded data — equipment cascade will handle related records
  await knex('maintenance_alerts').del();
  await knex('vehicle_mileage_log').del();
  await knex('equipment_downtime_log').del();
  await knex('maintenance_records').del();
  await knex('maintenance_schedules').del();
  await knex('equipment').whereIn('asset_tag', [
    'VEH-001', 'PUMP-001', 'REEL-001', 'INJ-001',
    'SPRAY-001', 'SPRAY-002', 'LAWN-001', 'LAWN-002',
  ]).del();
};
