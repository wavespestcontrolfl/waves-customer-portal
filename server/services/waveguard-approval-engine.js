function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function rateUnitsMatch(a, b) {
  const left = normalizeText(a).replace(/\s+/g, '_');
  const right = normalizeText(b).replace(/\s+/g, '_');
  if (!left || !right) return false;
  const aliases = {
    floz: 'fl_oz',
    'fl oz': 'fl_oz',
    fluid_ounce: 'fl_oz',
    fluid_ounces: 'fl_oz',
    lbs: 'lb',
    pounds: 'lb',
    ounces: 'oz',
  };
  return (aliases[left] || left) === (aliases[right] || right);
}

function collectProductIds(sections) {
  const ids = new Set();
  for (const section of sections) {
    for (const item of section || []) {
      if (item?.product?.id) ids.add(String(item.product.id));
      if (item?.productId) ids.add(String(item.productId));
    }
  }
  return ids;
}

function productGroups(product) {
  const groups = [
    ['moa', product?.moa_group],
    ['frac', product?.frac_group],
    ['irac', product?.irac_group],
    ['hrac', product?.hrac_group],
    ['hrac', product?.hrac_group_secondary],
  ].filter(([, value]) => value);
  const seen = new Set();
  return groups.filter(([type, value]) => {
    const key = `${type}:${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function latestComparableGroupApplication(knex, customerId, product, groupType, groupValue, serviceDate) {
  const groupColumn = `${groupType}_group`;
  const rows = await knex('service_products as sp')
    .join('service_records as sr', 'sp.service_record_id', 'sr.id')
    .leftJoin('products_catalog as pc', function () {
      this.on('sp.product_name', '=', 'pc.name');
    })
    .where('sr.customer_id', customerId)
    .where('sr.status', 'completed')
    .where('sr.service_date', '<', serviceDate)
    .where(function () {
      this.where(`pc.${groupColumn}`, groupValue);
      if (groupType === 'hrac') this.orWhere('pc.hrac_group_secondary', groupValue);
      if (groupType === 'moa') this.orWhere('sp.moa_group', groupValue);
    })
    .modify((query) => {
      if (product?.category) query.where('sp.product_category', product.category);
    })
    .orderBy('sr.service_date', 'desc')
    .select('sr.service_date', 'sp.product_name', `pc.${groupColumn} as catalog_group`, 'pc.hrac_group_secondary as catalog_group_secondary', 'sp.moa_group')
    .limit(1)
    .catch(() => []);
  return rows[0] || null;
}

function latestAssessmentStressed(plan) {
  const flags = plan?.propertyGate?.latestAssessment?.stressFlags || {};
  return !!(flags.drought_stress || flags.heat_stress || flags.recent_scalp);
}

function productIsPgr(product, input) {
  const category = normalizeText(product?.category);
  const name = normalizeText(product?.name || input?.name);
  return category.includes('plant growth regulator')
    || category === 'pgr'
    || name.includes('primo')
    || name.includes('pgr');
}

function serviceSuggestsDethatching(service, submittedProducts) {
  const text = [
    service?.service_type,
    service?.serviceType,
    service?.notes,
    ...(submittedProducts || []).map((p) => p.name),
  ].map(normalizeText).join(' ');
  return /\bdethatch|\bdethatching|\bthatch removal\b/.test(text);
}

async function evaluateWaveGuardManagerApprovals(knex, {
  customerId,
  service,
  plan,
  products = [],
  serviceDate,
}) {
  const blocks = [];
  const warnings = [];
  const submittedProductIds = [...new Set((products || []).map((p) => p.productId).filter(Boolean).map(String))];
  const plannedIds = collectProductIds([plan?.protocol?.base, plan?.mixCalculator?.items]);
  const conditionalIds = collectProductIds([plan?.protocol?.conditional]);
  const catalogRows = submittedProductIds.length
    ? await knex('products_catalog').whereIn('id', submittedProductIds).catch(() => [])
    : [];
  const catalogById = new Map(catalogRows.map((row) => [String(row.id), row]));

  for (const input of products || []) {
    if (!input.productId) continue;
    const productId = String(input.productId);
    const product = catalogById.get(productId);
    if (!product) continue;

    if (conditionalIds.has(productId) && !plannedIds.has(productId)) {
      blocks.push({
        code: 'conditional_protocol_product_review',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} is conditional on the WaveGuard protocol card and was not in the generated mix; manager review is required before applying it.`,
      });
    } else if ((plannedIds.size || conditionalIds.size) && !plannedIds.has(productId) && !conditionalIds.has(productId)) {
      blocks.push({
        code: 'off_protocol_product',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} is not part of the current WaveGuard protocol card.`,
      });
    }

    const enteredRate = Number(input.rate);
    const maxRate = Number(product.max_label_rate_per_1000);
    const hasEnteredRate = Number.isFinite(enteredRate) && enteredRate > 0;
    const hasLabelMax = Number.isFinite(maxRate) && maxRate > 0;
    if (
      hasEnteredRate
      && hasLabelMax
      && enteredRate > maxRate
      && rateUnitsMatch(input.rateUnit, product.rate_unit)
    ) {
      blocks.push({
        code: 'high_rate_application',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} rate ${enteredRate} ${input.rateUnit || ''}/1k exceeds label max ${maxRate} ${product.rate_unit || ''}/1k.`,
      });
    } else if (hasEnteredRate && hasLabelMax && !rateUnitsMatch(input.rateUnit, product.rate_unit)) {
      blocks.push({
        code: 'label_rate_unit_review',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} rate unit ${input.rateUnit || 'unknown'} does not match label unit ${product.rate_unit || 'unknown'}; manager review is required before applying it.`,
      });
    }

    if (productIsPgr(product, input) && latestAssessmentStressed(plan)) {
      blocks.push({
        code: 'pgr_on_stressed_turf',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} is a PGR and the latest assessment flags stressed turf.`,
      });
    }

    for (const [groupType, groupValue] of productGroups(product)) {
      const last = await latestComparableGroupApplication(knex, customerId, product, groupType, groupValue, serviceDate);
      const lastGroups = groupType === 'moa'
        ? [last?.catalog_group, last?.moa_group]
        : groupType === 'hrac'
          ? [last?.catalog_group, last?.catalog_group_secondary]
          : [last?.catalog_group];
      if (!last || !lastGroups.some((lastGroup) => String(lastGroup || '') === String(groupValue))) continue;
      const code = groupType === 'frac' && normalizeText(product.category).includes('fungicide')
        ? 'fungicide_frac_rotation_approval'
        : `repeat_${groupType}_group`;
      blocks.push({
        code,
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} repeats ${groupType.toUpperCase()} ${groupValue}; last matching application was ${last.product_name || 'unknown product'} on ${String(last.service_date).slice(0, 10)}.`,
      });
    }
  }

  const turfProfile = await knex('customer_turf_profiles')
    .where({ customer_id: customerId, active: true })
    .first()
    .catch(() => null);
  const grassType = normalizeText(turfProfile?.grass_type || plan?.propertyGate?.trackName || plan?.propertyGate?.trackKey);
  const cultivar = normalizeText(turfProfile?.cultivar);
  if ((grassType.includes('st augustine') || grassType.includes('st_augustine') || cultivar.includes('floratam')) && serviceSuggestsDethatching(service, products)) {
    blocks.push({
      code: 'st_augustine_dethatching',
      severity: 'block',
      message: 'St. Augustine dethatching requires manager approval because stolon damage risk is high.',
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const block of blocks) {
    const key = `${block.code}:${block.productId || ''}:${block.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(block);
  }

  return {
    approvalRequired: deduped.length > 0,
    blocks: deduped,
    warnings,
  };
}

function managerApprovalSummary(approval, blocks, actor) {
  return {
    reasonCode: approval.reasonCode,
    note: approval.note || null,
    approvedByTechnicianId: actor?.technicianId || null,
    approvedByRole: actor?.role || null,
    approvedAt: new Date().toISOString(),
    blocks: (blocks || []).map((block) => ({
      code: block.code,
      message: block.message,
      productId: block.productId || null,
      productName: block.productName || null,
    })),
  };
}

module.exports = {
  evaluateWaveGuardManagerApprovals,
  managerApprovalSummary,
};
