const db = require('../models/db');

class ApplicationLimitChecker {
  async checkLimits(customerId, productId, proposedDate = new Date()) {
    const product = await db('products_catalog').where({ id: productId }).first();
    if (!product) return { allowed: true, warnings: [], blocks: [] };

    const results = { allowed: true, warnings: [], blocks: [] };
    const customer = await db('customers').where({ id: customerId }).first();
    const county = this.getCounty(customer);
    const yearStart = this.getYearStart(proposedDate);

    // Product-specific history
    const history = await db('property_application_history')
      .where({ customer_id: customerId, product_id: productId })
      .where('application_date', '>=', yearStart)
      .orderBy('application_date', 'desc');

    // MOA group history
    const moaHistory = product.moa_group ? await db('property_application_history')
      .where({ customer_id: customerId, moa_group: product.moa_group })
      .orderBy('application_date', 'desc').limit(10) : [];

    // Get applicable limits
    const productLimits = await db('product_limits').where({ product_id: productId });
    const moaLimits = product.moa_group ? await db('product_limits')
      .where({ match_type: 'moa_group', match_value: product.moa_group }) : [];
    const nitrogenLimits = this.isNitrogenFertilizer(product)
      ? await db('product_limits').where({ match_type: 'nitrogen' }).where(function () {
          this.whereNull('jurisdiction').orWhere('jurisdiction', county).orWhere('jurisdiction', 'all');
        }) : [];

    const allLimits = [...productLimits, ...moaLimits, ...nitrogenLimits];

    for (const limit of allLimits) {
      const check = await this.evaluateLimit(limit, history, moaHistory, proposedDate, product);

      if (check.violated) {
        const entry = { type: limit.limit_type, message: check.message, description: limit.description, current: check.current, max: check.max };
        if (limit.severity === 'hard_block') {
          results.blocks.push(entry);
          results.allowed = false;
        } else {
          results.warnings.push({ ...entry, severity: limit.severity });
        }
      } else if (check.approaching) {
        results.warnings.push({ type: limit.limit_type, severity: 'info', message: check.message, current: check.current, max: check.max });
      }
    }

    return results;
  }

  async evaluateLimit(limit, history, moaHistory, proposedDate, product) {
    switch (limit.limit_type) {
      case 'annual_max_apps': {
        const count = history.length;
        const max = limit.limit_value;
        if (count >= max) return { violated: true, message: `${product.name}: ${count}/${max} applications this year — LIMIT REACHED.`, current: count, max };
        if (count >= max - 1) return { approaching: true, message: `${product.name}: ${count}/${max} this year — this would be the LAST allowed.`, current: count, max };
        return { violated: false, current: count, max };
      }

      case 'min_interval_days': {
        if (!history.length) return { violated: false };
        const lastApp = new Date(history[0].application_date + 'T12:00:00');
        const daysSince = Math.floor((proposedDate - lastApp) / 86400000);
        const minDays = limit.limit_value;
        if (daysSince < minDays) return { violated: true, message: `${product.name}: only ${daysSince} days since last app (min ${minDays}). Next allowed: ${new Date(lastApp.getTime() + minDays * 86400000).toLocaleDateString()}.`, current: daysSince, max: minDays };
        if (daysSince < minDays + 7) return { approaching: true, message: `${product.name}: ${daysSince} days since last app (min ${minDays}). Just cleared.`, current: daysSince, max: minDays };
        return { violated: false, current: daysSince, max: minDays };
      }

      case 'annual_max_rate': {
        const totalApplied = history.reduce((sum, h) => sum + (parseFloat(h.application_rate) || 0), 0);
        const maxRate = limit.limit_value;
        if (totalApplied >= maxRate * 0.95) return { violated: true, message: `${product.name}: cumulative ${totalApplied.toFixed(3)} ${limit.limit_unit} approaching/exceeding max ${maxRate}.`, current: totalApplied, max: maxRate };
        return { violated: false, current: totalApplied, max: maxRate };
      }

      case 'seasonal_blackout': {
        if (!limit.season_start || !limit.season_end) return { violated: false };
        const start = new Date(limit.season_start);
        const end = new Date(limit.season_end);
        start.setFullYear(proposedDate.getFullYear());
        end.setFullYear(proposedDate.getFullYear());
        if (proposedDate >= start && proposedDate <= end) return { violated: true, message: `BLACKOUT: ${(limit.jurisdiction || '').replace(/_/g, ' ')} restricts nitrogen ${start.toLocaleDateString()} — ${end.toLocaleDateString()}. Use iron/potassium only.`, current: 'in_blackout', max: 'none' };
        const daysUntil = Math.floor((start - proposedDate) / 86400000);
        if (daysUntil > 0 && daysUntil <= 14) return { approaching: true, message: `Nitrogen blackout starts in ${daysUntil} days. May be last nitrogen window.`, current: daysUntil, max: 0 };
        return { violated: false };
      }

      case 'consecutive_use_max':
      case 'moa_rotation_max': {
        let consecutive = 0;
        for (const app of moaHistory) {
          if (app.moa_group === product.moa_group) consecutive++;
          else break;
        }
        const max = limit.limit_value;
        if (consecutive >= max) {
          const alternatives = await db('products_catalog')
            .where('category', product.category).whereNot('moa_group', product.moa_group)
            .where({ active: true }).select('name', 'moa_group').limit(3);
          const altNames = alternatives.map(a => `${a.name} (${a.moa_group})`).join(', ');
          return { violated: true, message: `MOA rotation due: ${consecutive} consecutive ${product.moa_group}. Rotate to: ${altNames || 'check catalog'}.`, current: consecutive, max };
        }
        if (consecutive >= max - 1) return { approaching: true, message: `${product.moa_group}: ${consecutive}/${max} consecutive. Rotate after next use.`, current: consecutive, max };
        return { violated: false, current: consecutive, max };
      }

      default: return { violated: false };
    }
  }

  async getPropertyComplianceStatus(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    const county = this.getCounty(customer);
    const yearStart = this.getYearStart(new Date());

    const applications = await db('property_application_history')
      .where({ customer_id: customerId }).where('application_date', '>=', yearStart)
      .leftJoin('products_catalog', 'property_application_history.product_id', 'products_catalog.id')
      .select('property_application_history.*', 'products_catalog.name as product_name')
      .orderBy('application_date', 'desc');

    const byProduct = {};
    for (const app of applications) {
      if (!byProduct[app.product_id]) byProduct[app.product_id] = { name: app.product_name, apps: [] };
      byProduct[app.product_id].apps.push(app);
    }

    const status = { products: [], warnings: 0, blocks: 0, county, totalApplications: applications.length };
    for (const [productId, data] of Object.entries(byProduct)) {
      const check = await this.checkLimits(customerId, productId);
      status.products.push({ productId, productName: data.name, applicationsThisYear: data.apps.length, lastApplied: data.apps[0]?.application_date, limits: check });
      status.warnings += check.warnings.length;
      status.blocks += check.blocks.length;
    }

    // Nitrogen budget
    const nitrogenApps = applications.filter(a => this.isNitrogenFertilizer(a));
    const totalN = nitrogenApps.reduce((sum, a) => {
      const npk = (a.product_name || '').match(/(\d+)-(\d+)-(\d+)/);
      const nPct = npk ? parseInt(npk[1]) / 100 : 0;
      return sum + ((parseFloat(a.quantity_applied) || 0) * nPct);
    }, 0);

    status.nitrogenBudget = {
      applied: Math.round(totalN * 100) / 100,
      limit: 4.0, remaining: Math.round((4.0 - totalN) * 100) / 100,
      unit: 'lb N/1000sf', county,
      inBlackout: this.isInBlackout(new Date(), county),
    };

    return status;
  }

  getCounty(customer) {
    if (!customer) return 'all';
    const city = (customer.city || '').toLowerCase();
    if (['bradenton', 'lakewood ranch', 'parrish', 'palmetto', 'ellenton'].includes(city)) return 'manatee_county';
    if (['sarasota', 'venice', 'nokomis', 'osprey', 'north port', 'englewood'].includes(city)) return 'sarasota_county';
    return 'all';
  }

  isNitrogenFertilizer(product) {
    const cat = (product.category || '').toLowerCase();
    if (cat !== 'fertilizer') return false;
    const name = (product.name || product.product_name || '').toLowerCase();
    const npk = name.match(/(\d+)-(\d+)-(\d+)/);
    if (npk && parseInt(npk[1]) > 0) return true;
    if (name.includes('urea') || name.includes('ammonium') || name.includes('nitrogen')) return true;
    return false;
  }

  isInBlackout(date, county) {
    if (county !== 'sarasota_county' && county !== 'manatee_county') return false;
    const month = date.getMonth();
    return month >= 5 && month <= 8;
  }

  getYearStart(date) { return new Date(date.getFullYear(), 0, 1).toISOString().split('T')[0]; }
}

module.exports = new ApplicationLimitChecker();
