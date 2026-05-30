const {
  approvedReportProductFacts,
  attachApprovedReportProductFacts,
  loadLawnProgramOverviewContext,
} = require('../services/service-report/report-data');

function makeKnex(catalogRows) {
  return jest.fn((table) => {
    expect(table).toBe('products_catalog');
    const chain = {
      whereIn: jest.fn(() => chain),
      select: jest.fn(() => Promise.resolve(catalogRows)),
    };
    return chain;
  });
}

function makeOutlineKnex(outlineRow) {
  return jest.fn((table) => {
    expect(table).toBe('service_outline_packets');
    const chain = {
      where: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      orWhereIn: jest.fn(() => chain),
      select: jest.fn(() => chain),
      orderByRaw: jest.fn(() => chain),
      first: jest.fn(() => Promise.resolve(outlineRow)),
    };
    chain.where.mockImplementation((arg) => {
      if (typeof arg === 'function') arg.call(chain);
      return chain;
    });
    return chain;
  });
}

function makeOutlineKnexWithChains(outlineRow) {
  const chains = [];
  const knex = jest.fn((table) => {
    expect(table).toBe('service_outline_packets');
    const chain = {
      where: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      select: jest.fn(() => chain),
      orderByRaw: jest.fn(() => chain),
      first: jest.fn(() => Promise.resolve(outlineRow)),
    };
    chains.push(chain);
    return chain;
  });
  knex.chains = chains;
  return knex;
}

describe('service report approved product facts', () => {
  test('exposes approved pesticide facts with EPA number and customer copy', () => {
    const facts = approvedReportProductFacts({
      approved_for_service_report: true,
      name: 'Celsius WG',
      category: 'herbicide',
      product_type: 'pesticide',
      active_ingredient: 'thiencarbazone-methyl',
      epa_reg_number: '432-1507',
      public_summary: 'Selective weed control for labeled warm-season turf.',
      customer_precaution_summary: 'Follow technician instructions before re-entering treated areas.',
      reentry_summary: 'Stay off treated areas until dry unless the label requires longer.',
      label_verified_at: '2026-05-30',
      label_version: '2026-label',
    });

    expect(facts).toMatchObject({
      productType: 'pesticide',
      epaRegNumber: '432-1507',
      serviceReportSummary: 'Selective weed control for labeled warm-season turf.',
      precautionSummary: 'Follow technician instructions before re-entering treated areas.',
      reentrySummary: 'Stay off treated areas until dry unless the label requires longer.',
    });
  });

  test('blocks unapproved facts and pesticide facts without real EPA number', () => {
    expect(approvedReportProductFacts({
      approved_for_service_report: false,
      category: 'herbicide',
      product_type: 'pesticide',
      epa_reg_number: '432-1507',
    })).toBeNull();

    expect(approvedReportProductFacts({
      approved_for_service_report: true,
      category: 'herbicide',
      product_type: 'pesticide',
      epa_reg_number: 'N/A',
    })).toBeNull();
  });

  test('enriches service products from approved catalog facts without overwriting actual application values', async () => {
    const products = [{
      id: 'service-product-1',
      product_id: 'catalog-1',
      product_name: 'Field Name',
      product_category: '',
      active_ingredient: '',
      epa_reg_number: '',
    }];
    const enriched = await attachApprovedReportProductFacts(makeKnex([{
      id: 'catalog-1',
      approved_for_service_report: true,
      name: 'Catalog Name',
      category: 'herbicide',
      product_type: 'pesticide',
      active_ingredient: 'active from catalog',
      epa_reg_number: '123-456',
      public_summary: 'Approved summary.',
      customer_safety_summary: 'Approved safety copy.',
    }]), products);

    expect(enriched[0].product_name).toBe('Field Name');
    expect(enriched[0].active_ingredient).toBe('active from catalog');
    expect(enriched[0].epa_reg_number).toBe('123-456');
    expect(enriched[0].approved_report_product_facts).toMatchObject({
      serviceReportSummary: 'Approved summary.',
      precautionSummary: 'Approved safety copy.',
    });
  });
});

describe('lawn service report outline context', () => {
  test('links the latest approved lawn outline without exposing a token', async () => {
    const context = await loadLawnProgramOverviewContext(makeOutlineKnex({
      id: 'packet-1',
      title: 'Your Waves Lawn Care Program Overview',
      status: 'sent',
      estimate_id: 'estimate-1',
      turf_type: 'st_augustine',
      sent_at: '2026-05-30T14:00:00.000Z',
      view_count: 2,
      content_library_version: 'content-1',
      protocol_version: 'st-augustine-v4',
      product_registry_version: 'products-1',
      template_version: 'mvp-1',
      summary_json: { turfLabel: 'St. Augustine', productCardCount: 4 },
      content_json: {},
    }), {
      customer_id: 'customer-1',
      service_data: JSON.stringify({ estimateId: 'estimate-1' }),
    }, 'lawn');

    expect(context).toMatchObject({
      linked: true,
      packetId: 'packet-1',
      estimateId: 'estimate-1',
      turfType: 'St. Augustine',
      productCardCount: 4,
      distinctionCopy: 'The program overview explains what may be used through the season. This service report documents what was actually done today.',
    });
    expect(context).not.toHaveProperty('token');
    expect(context).not.toHaveProperty('publicUrl');
    expect(context.contextCopy).toContain('sent on 2026-05-30');
  });

  test('returns limited context for lawn reports without an outline', async () => {
    const context = await loadLawnProgramOverviewContext(makeOutlineKnex(null), {
      customer_id: 'customer-1',
    }, 'lawn');

    expect(context).toMatchObject({
      linked: false,
      title: 'Your Waves Lawn Care Program Overview',
    });
    expect(context.distinctionCopy).toContain('what was actually done today');
  });

  test('does not link customer fallback outlines created after the service date', async () => {
    const knex = makeOutlineKnexWithChains({
      id: 'packet-older',
      title: 'Existing Lawn Program',
      status: 'approved',
      estimate_id: null,
      turf_type: 'bahia',
      approved_at: '2026-05-15T14:00:00.000Z',
      summary_json: { turfLabel: 'Bahia' },
      content_json: {},
    });

    const context = await loadLawnProgramOverviewContext(knex, {
      customer_id: 'customer-1',
      service_date: '2026-05-16',
    }, 'lawn');

    expect(context.linked).toBe(true);
    const fallbackQuery = knex.chains[1];
    expect(fallbackQuery.where).toHaveBeenCalledWith({ customer_id: 'customer-1' });
    expect(fallbackQuery.whereRaw).toHaveBeenCalledWith(
      'COALESCE(sent_at, approved_at, created_at) <= ?',
      ['2026-05-17T03:59:59.000Z'],
    );
  });
});
