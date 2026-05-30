const {
  buildOutline,
  normalizeTurfType,
  validateContent,
} = require('../services/lawn-service-outline');

const MODULE_TEXT = {
  lawn_program_overview: 'Waves lawn care is a documented turf health program.',
  assessment_protocol: 'Each visit starts with assessment of turf color, density, weeds, insects, disease, irrigation, stress, mowing, thatch, shade, and progress.',
  st_augustine_protocol_summary: 'St. Augustine is managed as one core turf program, then adjusted by site conditions.',
  bermuda_protocol_summary: 'Bermuda can produce dense, durable turf, but it requires active management.',
  zoysia_protocol_summary: 'Zoysia is managed conservatively because excess stimulation can increase thatch and disease pressure.',
  bahia_protocol_summary: 'Bahia care is about realistic improvement, weed reduction, mole cricket monitoring, and expectation management.',
  mixed_turf_summary: 'Mixed turf requires more careful treatment decisions.',
  unknown_turf_summary: 'We will confirm turf type and site conditions during the first visit before finalizing treatment decisions.',
  season_jan_mar: 'Early-year visits focus on prevention and baseline observations.',
  season_apr_may: 'Late spring is often focused on final spring nutrition decisions, iron and color support, weed and sedge checks, insect-pressure preparation, and summer heat planning.',
  season_jun_sep: 'Summer service often shifts toward stress management, pest scouting, micronutrient support, moisture observations, and careful product selection.',
  season_oct_dec: 'Fall and winter visits focus on recovery, disease prevention where risk supports it, winter hardening, dormancy expectations, and annual reporting.',
  product_transparency: 'Product choices depend on turf type, season, weather, label directions, local rules, and what the lawn is showing.',
  safety_and_label_compliance: 'When a pesticide product is used, it is applied according to label directions. EPA registration numbers are provided where applicable.',
  local_fertilizer_rules: 'Local fertilizer rules may affect whether nitrogen or phosphorus can be applied during certain months.',
  post_service_reports: 'The estimate outline explains what may be used; the post-service report shows what was actually done.',
  gps_tracking: 'GPS-tracked service history documents arrival and completion.',
  service_reminders: 'Service reminders keep customers informed before and after visits.',
  customer_portal: 'The customer portal keeps service reports, photos, recommendations, service history, and communication in one place.',
  what_this_does_not_include: 'Some issues require separate work or customer action.',
};

function makeDb() {
  const moduleRows = Object.entries(MODULE_TEXT).map(([key, plain_text]) => ({
    key,
    plain_text,
    status: 'approved',
    version: 1,
  }));
  const rule = {
    jurisdiction_id: 'sarasota_county_fl',
    jurisdiction_name: 'Sarasota County, FL',
    version: '2026-05-30',
    public_summary: 'Local fertilizer rules may restrict nitrogen and phosphorus applications during the summer rainy season.',
    nitrogen_restricted: true,
    phosphorus_restricted: true,
    phosphorus_soil_test_required: true,
    restricted_start_month: 6,
    restricted_start_day: 1,
    restricted_end_month: 9,
    restricted_end_day: 30,
  };

  const db = jest.fn((table) => {
    const chain = {
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      orWhere: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      select: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      first: jest.fn(() => Promise.resolve(table === 'jurisdiction_fertilizer_rules' ? rule : null)),
      then: (resolve, reject) => {
        const value = table === 'lawn_service_content_modules' ? moduleRows : [];
        return Promise.resolve(value).then(resolve, reject);
      },
    };
    return chain;
  });
  db.fn = { now: jest.fn(() => new Date('2026-05-30T12:00:00Z')) };
  return db;
}

describe('lawn service outline composer', () => {
  test('normalizes supported turf aliases', () => {
    expect(normalizeTurfType('St. Aug')).toBe('st_augustine');
    expect(normalizeTurfType('bermuda grass')).toBe('bermuda');
    expect(normalizeTurfType('zoysiagrass')).toBe('zoysia');
    expect(normalizeTurfType('Bahia')).toBe('bahia');
    expect(normalizeTurfType('multiple turf zones')).toBe('mixed');
    expect(normalizeTurfType('')).toBe('unknown');
  });

  test('blocks product cards when turf is unknown or mixed', () => {
    const unknown = validateContent({ title: 'Outline', sections: [{}], productCards: [] }, {
      turfType: 'unknown',
      includeProductCards: true,
      jurisdictionRule: { jurisdiction_id: 'generic_swfl' },
    });
    const mixed = validateContent({ title: 'Outline', sections: [{}], productCards: [] }, {
      turfType: 'mixed',
      includeProductCards: true,
      jurisdictionRule: { jurisdiction_id: 'generic_swfl' },
    });
    expect(unknown.status).toBe('blocked');
    expect(mixed.status).toBe('blocked');
    expect(unknown.errors.join(' ')).toMatch(/Product cards cannot be sent/);
  });

  test('detects banned safety and guarantee claims', () => {
    const result = validateContent({
      title: 'Outline',
      intro: 'This is safe for pets and guaranteed results.',
      sections: [{ title: 'One', body: 'Body' }],
      productCards: [],
    }, {
      turfType: 'st_augustine',
      includeProductCards: false,
      jurisdictionRule: { jurisdiction_id: 'sarasota_county_fl' },
    });
    expect(result.status).toBe('blocked');
    expect(result.errors).toEqual(expect.arrayContaining([
      'Banned phrase detected: safe for pets',
      'Banned phrase detected: guaranteed results',
    ]));
  });

  test('builds May St. Augustine outline with spring focus and conditional protocol language', async () => {
    const db = makeDb();
    const outline = await buildOutline({
      db,
      estimate: {
        id: 'estimate-1',
        customer_name: 'Jane Client',
        address: '123 Main St, Sarasota, FL',
        service_interest: 'Lawn care',
        waveguard_tier: 'Premium',
        token: 'estimate-token',
        estimate_data: JSON.stringify({ turfType: 'St. Augustine' }),
      },
      input: { month: 5, includeProductCards: false },
      now: new Date('2026-05-30T12:00:00Z'),
    });

    expect(outline.validation.status).toBe('passed');
    expect(outline.summary.turfType).toBe('st_augustine');
    expect(outline.summary.seasonBand).toBe('apr_may');
    expect(outline.content.title).toContain('St. Augustine');
    expect(outline.content.sections.find((section) => section.key === 'season_focus').body).toContain('Late spring');
    expect(JSON.stringify(outline.content)).toContain('LESCO 24-2-11 may be relevant');
    expect(JSON.stringify(outline.content)).not.toContain('will be applied');
  });
});
