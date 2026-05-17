const SYSTEM_ASSET_FIELDS = [
  'primary_equipment_id',
  'tank_asset_id',
  'pump_asset_id',
  'reel_asset_id',
  'hose_asset_id',
  'gun_asset_id',
];

const COMPONENT_ASSET_FIELDS = SYSTEM_ASSET_FIELDS.filter(
  field => field !== 'primary_equipment_id',
);

const SYSTEM_ASSET_LABELS = {
  primary_equipment_id: 'Primary equipment',
  tank_asset_id: 'Tank',
  pump_asset_id: 'Pump',
  reel_asset_id: 'Reel',
  hose_asset_id: 'Hose',
  gun_asset_id: 'Gun',
};

const SPRAY_RELATED_CATEGORIES = new Set([
  'sprayer',
  'pump',
  'reel',
  'injection',
  'vehicle',
]);

function isActiveEquipment(row) {
  return !!row && row.status !== 'retired' && row.status !== 'sold' && row.status !== 'lost';
}

function isActiveSystem(row) {
  return row?.active !== false;
}

function isActiveTaxAsset(row) {
  return row?.active !== false && row?.disposed !== true;
}

function normalizeAssetText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[#/\\().,_-]+/g, ' ')
    .replace(/\b(awd|system|spray|sprayer|powered|hose|tank|van|the|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value) {
  return new Set(
    normalizeAssetText(value)
      .split(' ')
      .filter(token => token.length > 1),
  );
}

function overlapScore(left, right) {
  const l = tokenSet(left);
  const r = tokenSet(right);
  if (!l.size || !r.size) return 0;
  let overlap = 0;
  for (const token of l) {
    if (r.has(token)) overlap += 1;
  }
  return overlap / Math.max(l.size, r.size);
}

function scoreEquipmentMatch(source, equipment) {
  const sourceName = normalizeAssetText(source.name);
  const equipmentName = normalizeAssetText(equipment.name);
  const makeModel = normalizeAssetText([equipment.make, equipment.model].filter(Boolean).join(' '));
  let score = 0;

  if (sourceName && equipmentName && sourceName === equipmentName) score += 100;
  if (sourceName && equipmentName && (sourceName.includes(equipmentName) || equipmentName.includes(sourceName))) {
    score += 45;
  }
  if (makeModel && sourceName && (sourceName.includes(makeModel) || makeModel.includes(sourceName))) {
    score += 30;
  }
  score += Math.round(overlapScore(source.name, equipment.name) * 40);
  score += Math.round(overlapScore(source.name, makeModel) * 20);

  if (source.system_type && equipment.category) {
    const systemType = normalizeAssetText(source.system_type);
    const category = normalizeAssetText(equipment.category);
    if (systemType === category) score += 15;
    if (systemType === 'backpack' && category === 'sprayer') score += 18;
    if (systemType === 'tank' && ['vehicle', 'sprayer', 'pump', 'reel'].includes(category)) score += 4;
  }

  return score;
}

function scoreTaxMatch(equipment, taxAsset) {
  let score = 0;
  const equipmentName = normalizeAssetText(equipment.name);
  const taxName = normalizeAssetText(taxAsset.name);
  const makeModel = normalizeAssetText(taxAsset.make_model);

  if (equipment.serial_number && taxAsset.serial_number && equipment.serial_number === taxAsset.serial_number) {
    score += 120;
  }
  if (equipmentName && taxName && equipmentName === taxName) score += 100;
  if (equipmentName && taxName && (equipmentName.includes(taxName) || taxName.includes(equipmentName))) {
    score += 45;
  }
  if (makeModel && equipmentName && (equipmentName.includes(makeModel) || makeModel.includes(equipmentName))) {
    score += 35;
  }
  score += Math.round(overlapScore(equipment.name, taxAsset.name) * 40);
  score += Math.round(overlapScore([equipment.make, equipment.model].filter(Boolean).join(' '), taxAsset.make_model) * 35);

  if (equipment.category && taxAsset.asset_category) {
    if (normalizeAssetText(equipment.category) === normalizeAssetText(taxAsset.asset_category)) score += 10;
    if (equipment.category === 'vehicle' && taxAsset.asset_category === 'vehicle') score += 20;
  }

  return score;
}

function topMatches(source, candidates, scorer, threshold = 35, compact = compactAsset) {
  return candidates
    .map(candidate => ({ candidate, score: scorer(source, candidate) }))
    .filter(match => match.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ candidate, score }) => ({ ...compact(candidate), score }));
}

function compactAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    asset_tag: row.asset_tag,
    category: row.category,
    status: row.status,
    make: row.make,
    model: row.model,
    serial_number: row.serial_number,
    purchase_price: row.purchase_price != null ? Number(row.purchase_price) : null,
    tax_equipment_id: row.tax_equipment_id || null,
  };
}

function compactTaxAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    asset_category: row.asset_category,
    active: row.active,
    disposed: row.disposed,
    purchase_cost: row.purchase_cost != null ? Number(row.purchase_cost) : null,
    current_book_value: row.current_book_value != null ? Number(row.current_book_value) : null,
    serial_number: row.serial_number,
    make_model: row.make_model,
  };
}

function buildEquipmentReconciliation({ systems = [], equipment = [], taxRegister = [], calibrations = [] }) {
  const equipmentById = new Map(equipment.map(row => [row.id, row]));
  const taxById = new Map(taxRegister.map(row => [row.id, row]));
  const calibrationBySystem = new Map(calibrations.map(row => [row.equipment_system_id, row]));
  const activeLinkedEquipmentIds = new Set();
  const linkedTaxIds = new Set();
  const issues = [];
  const activeEquipmentCandidates = equipment.filter(isActiveEquipment);

  const systemRows = systems.map(system => {
    const linkedIds = [
      ...new Set(SYSTEM_ASSET_FIELDS
        .map(field => system[field])
        .filter(Boolean)),
    ];
    const activeLinkedIds = linkedIds.filter(id => isActiveEquipment(equipmentById.get(id)));
    if (isActiveSystem(system)) {
      for (const id of activeLinkedIds) activeLinkedEquipmentIds.add(id);
    }

    const component_assets = Object.fromEntries(
      COMPONENT_ASSET_FIELDS.map(field => [
        field.replace('_asset_id', ''),
        compactAsset(equipmentById.get(system[field])),
      ]),
    );
    const linkedComponents = Object.values(component_assets).filter(Boolean);
    const activeLinkedComponents = COMPONENT_ASSET_FIELDS
      .map(field => equipmentById.get(system[field]))
      .filter(isActiveEquipment);
    const primaryRow = equipmentById.get(system.primary_equipment_id);
    const primaryEquipment = compactAsset(primaryRow);
    const activePrimaryEquipment = isActiveEquipment(primaryRow) ? primaryEquipment : null;
    const activeCalibration = calibrationBySystem.get(system.id) || null;

    if (isActiveSystem(system) && !activePrimaryEquipment && activeLinkedComponents.length === 0) {
      issues.push({
        severity: 'warning',
        type: 'system_unlinked',
        entity: 'equipment_system',
        id: system.id,
        name: system.name,
        message: `${system.name} is active but has no active operational equipment links.`,
      });
    }
    if (isActiveSystem(system) && linkedIds.length > 0 && activeLinkedIds.length === 0) {
      issues.push({
        severity: 'warning',
        type: 'system_inactive_equipment_link',
        entity: 'equipment_system',
        id: system.id,
        name: system.name,
        message: `${system.name} only links to inactive operational equipment.`,
      });
    }
    if (isActiveSystem(system) && !activeCalibration) {
      issues.push({
        severity: 'info',
        type: 'system_missing_active_calibration',
        entity: 'equipment_system',
        id: system.id,
        name: system.name,
        message: `${system.name} has no active calibration.`,
      });
    }

    return {
      id: system.id,
      name: system.name,
      system_type: system.system_type,
      active: system.active,
      primary_equipment_id: system.primary_equipment_id || null,
      primary_equipment: primaryEquipment,
      component_assets,
      linked_equipment_ids: linkedIds,
      active_linked_equipment_ids: activeLinkedIds,
      active_calibration: activeCalibration
        ? {
            id: activeCalibration.id,
            carrier_gal_per_1000: Number(activeCalibration.carrier_gal_per_1000),
            calibrated_at: activeCalibration.calibrated_at,
            expires_at: activeCalibration.expires_at,
          }
        : null,
      suggested_equipment_matches: primaryEquipment
        ? []
        : topMatches(system, activeEquipmentCandidates, scoreEquipmentMatch),
    };
  });

  const equipmentRows = equipment.map(row => {
    const hasValidTaxLink = !!row.tax_equipment_id && taxById.has(row.tax_equipment_id);
    if (hasValidTaxLink) linkedTaxIds.add(row.tax_equipment_id);
    const systemLinks = systemRows
      .filter(system => system.linked_equipment_ids.includes(row.id))
      .map(system => ({ id: system.id, name: system.name, system_type: system.system_type }));
    const activeSystemLinks = systemRows.filter(
      system => isActiveSystem(system) && system.active_linked_equipment_ids.includes(row.id),
    );
    const taxAsset = compactTaxAsset(taxById.get(row.tax_equipment_id));
    const active = isActiveEquipment(row);

    if (active && row.tax_equipment_id && !hasValidTaxLink) {
      issues.push({
        severity: 'warning',
        type: 'equipment_stale_tax_link',
        entity: 'equipment',
        id: row.id,
        name: row.name,
        message: `${row.name} points at missing tax register row ${row.tax_equipment_id}.`,
      });
    } else if (active && !row.tax_equipment_id && Number(row.purchase_price || 0) > 0) {
      issues.push({
        severity: 'info',
        type: 'equipment_missing_tax_link',
        entity: 'equipment',
        id: row.id,
        name: row.name,
        message: `${row.name} has an operational purchase price but no tax register link.`,
      });
    }
    if (active && SPRAY_RELATED_CATEGORIES.has(row.category) && activeSystemLinks.length === 0) {
      issues.push({
        severity: 'info',
        type: 'equipment_missing_system_link',
        entity: 'equipment',
        id: row.id,
        name: row.name,
        message: `${row.name} is spray-related equipment but is not linked to an equipment system.`,
      });
    }

    return {
      ...compactAsset(row),
      linked_systems: systemLinks,
      tax_register: taxAsset,
      suggested_tax_matches: hasValidTaxLink
        ? []
        : topMatches(row, taxRegister, scoreTaxMatch, 35, compactTaxAsset),
    };
  });

  const taxRows = taxRegister.map(row => {
    const linkedEquipment = equipmentRows.filter(eq => eq.tax_equipment_id === row.id);
    if (isActiveTaxAsset(row) && linkedEquipment.length === 0) {
      issues.push({
        severity: 'info',
        type: 'tax_asset_unlinked',
        entity: 'equipment_register',
        id: row.id,
        name: row.name,
        message: `${row.name} is active in the tax register but not linked to operational equipment.`,
      });
    }

    return {
      ...compactTaxAsset(row),
      linked_equipment: linkedEquipment.map(compactAsset),
      suggested_equipment_matches: linkedEquipment.length
        ? []
        : topMatches(row, equipment, (taxAsset, eq) => scoreTaxMatch(eq, taxAsset)),
    };
  });

  const activeSystems = systems.filter(isActiveSystem);
  const activeEquipment = equipment.filter(isActiveEquipment);
  const activeTax = taxRegister.filter(isActiveTaxAsset);

  return {
    summary: {
      systems_total: systems.length,
      systems_active: activeSystems.length,
      systems_with_primary_equipment: systemRows.filter(row => isActiveSystem(row) && row.active_linked_equipment_ids.includes(row.primary_equipment_id)).length,
      systems_with_any_equipment_link: systemRows.filter(row => isActiveSystem(row) && row.active_linked_equipment_ids.length > 0).length,
      systems_without_equipment_link: systemRows.filter(row => isActiveSystem(row) && row.active_linked_equipment_ids.length === 0).length,
      equipment_total: equipment.length,
      equipment_active: activeEquipment.length,
      equipment_linked_to_systems: activeEquipment.filter(row => activeLinkedEquipmentIds.has(row.id)).length,
      equipment_with_tax_link: activeEquipment.filter(row => row.tax_equipment_id && taxById.has(row.tax_equipment_id)).length,
      equipment_without_tax_link: activeEquipment.filter(row => (!row.tax_equipment_id || !taxById.has(row.tax_equipment_id)) && Number(row.purchase_price || 0) > 0).length,
      tax_register_total: taxRegister.length,
      tax_register_active: activeTax.length,
      tax_register_linked_to_equipment: activeTax.filter(row => linkedTaxIds.has(row.id)).length,
      tax_register_unlinked: activeTax.filter(row => !linkedTaxIds.has(row.id)).length,
      issue_count: issues.length,
    },
    systems: systemRows,
    equipment: equipmentRows,
    tax_register: taxRows,
    issues,
  };
}

module.exports = {
  SYSTEM_ASSET_FIELDS,
  COMPONENT_ASSET_FIELDS,
  SYSTEM_ASSET_LABELS,
  buildEquipmentReconciliation,
  normalizeAssetText,
  scoreEquipmentMatch,
  scoreTaxMatch,
};
