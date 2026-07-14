// Unit tests for the Mosquito Report V2 aggregator (yard-usability mosquito report).
// Asserts the trust-critical behavior: the status never over-claims (documented
// activity is never "Yard protected"), habitat watch items derive from finding text,
// banned/over-claiming copy is rejected, the outlook leads with the mosquito
// forecast entry, and the section is null when there is nothing to surface.
// Synthetic payloads only (no customer PII).

const {
  buildMosquitoReportV2,
  mosquitoReportV2PdfSignature,
  resolveStatusKey,
  buildHabitat,
  buildOutlook,
} = require('../services/service-report/mosquito-report-v2');

function premium(overrides = {}) {
  return {
    primaryMove: null,
    aiSummaryPersonality: { variants: { straight: { headline: 'Service is complete.', body: 'Yard treatment was completed today.' } } },
    weatherCall: { headline: 'Good treatment window.', body: 'Low rainfall and moderate wind supported exterior application.', factsLine: '88°F · 70% humidity · 6 mph wind' },
    ...overrides,
  };
}

const FOG_APP = { id: 'app-1', method: 'fog_ulv', methodLabel: 'Yard misting' };
const PRESSURE = { displayScore: '1.2', score: 1.2, maxScore: 5, label: 'Low', trend: 'down', showOnCustomerReport: true, enabled: true };

function finding({ title = 'Observation', detail = '', severity = 'low', recommendation = '', category = 'observation' } = {}) {
  return { id: `f-${title}`, title, detail, severity, recommendation, category, zoneId: null };
}

describe('resolveStatusKey — honest status ladder', () => {
  it('treated + nothing documented + low pressure → protected', () => {
    expect(resolveStatusKey({ findings: [], treatedToday: true, pressureScore: 1.2 })).toBe('protected');
  });

  it('treated + nothing documented + untracked pressure → protected', () => {
    expect(resolveStatusKey({ findings: [], treatedToday: true, pressureScore: null })).toBe('protected');
  });

  it('documented activity without a recommendation is never protected', () => {
    const findings = [finding({ title: 'Mosquito activity near shrubs' })];
    expect(resolveStatusKey({ findings, treatedToday: true, pressureScore: 1.0 })).toBe('watching');
  });

  it('a recommendation → recommended; high severity + recommendation → action', () => {
    expect(resolveStatusKey({
      findings: [finding({ title: 'Standing water in plant saucers', recommendation: 'Empty saucers weekly' })],
      treatedToday: true,
    })).toBe('recommended');
    expect(resolveStatusKey({
      findings: [finding({ title: 'Breeding site', severity: 'high', recommendation: 'Drain the kiddie pool' })],
      treatedToday: true,
    })).toBe('action');
  });

  it('no-activity findings do not block protected', () => {
    expect(resolveStatusKey({
      findings: [finding({ title: 'No activity', category: 'no_activity' })],
      treatedToday: true,
      pressureScore: null,
    })).toBe('protected');
  });

  it('elevated pressure blocks protected even when treated', () => {
    expect(resolveStatusKey({ findings: [], treatedToday: true, pressureScore: 3.8 })).toBe('watching');
  });
});

describe('buildHabitat — watch items derive from finding text', () => {
  it('flags standing water and leaves the rest clear', () => {
    const habitat = buildHabitat({
      findings: [finding({ title: 'Standing water in birdbath', detail: 'North side' })],
      applications: [FOG_APP],
    });
    const byKey = Object.fromEntries(habitat.items.map((i) => [i.key, i]));
    expect(byKey.yard_treatment.status).toBe('active');
    expect(byKey.standing_water.status).toBe('watched');
    expect(byKey.foliage.status).toBe('clear');
    expect(byKey.lanai_patio.status).toBe('clear');
    expect(byKey.drainage.status).toBe('clear');
    expect(habitat.summary).toMatch(/flagged/);
  });

  it('no application logged → yard_treatment watched and summary drops the treated claim', () => {
    const habitat = buildHabitat({ findings: [], applications: [] });
    expect(habitat.treatedToday).toBe(false);
    expect(habitat.items.find((i) => i.key === 'yard_treatment').status).toBe('watched');
    expect(habitat.summary).not.toMatch(/treated/i);
  });

  it('no-activity findings never light a watch state', () => {
    const habitat = buildHabitat({
      findings: [finding({ title: 'No standing water observed', category: 'no_activity' })],
      applications: [FOG_APP],
    });
    expect(habitat.items.find((i) => i.key === 'standing_water').status).toBe('clear');
    expect(habitat.summary).toMatch(/no conditions/i);
  });
});

describe('mosquitoReportV2PdfSignature — PDF cache-key component', () => {
  afterEach(() => { delete process.env.MOSQUITO_REPORT_V2; });

  it('is empty when the gate is off, regardless of line', () => {
    delete process.env.MOSQUITO_REPORT_V2;
    expect(mosquitoReportV2PdfSignature({ service_line: 'mosquito' })).toBe('');
  });

  it('marks mosquito-line records only when the gate is on', () => {
    process.env.MOSQUITO_REPORT_V2 = 'true';
    expect(mosquitoReportV2PdfSignature({ service_line: 'mosquito' })).toBe('-mosqv2');
    expect(mosquitoReportV2PdfSignature({ service_type: 'Mosquito Control (Monthly)' })).toBe('-mosqv2');
    // Non-mosquito lines keep their keys — a gate flip must not
    // mass-invalidate cached pest/lawn report PDFs.
    expect(mosquitoReportV2PdfSignature({ service_line: 'pest' })).toBe('');
    expect(mosquitoReportV2PdfSignature({ service_type: 'Lawn Fertilization' })).toBe('');
  });
});

describe('buildOutlook — mosquito-first forecast', () => {
  const forecast = {
    month_name: 'July',
    location: { label: 'Bradenton' },
    weather: { summary: 'Hot and wet — daily storms' },
    disclaimer: 'Informational.',
    pests: [
      { key: 'ghost_ant', label: 'Ghost ant', level: 'high', trend: 'up' },
      { key: 'mosquitoes', label: 'Mosquitoes', emoji: '🦟', level: 'high', trend: 'up', note: 'Rain is filling containers.' },
    ],
  };

  it('picks the mosquito entry, not the highest-ranked pest', () => {
    const out = buildOutlook({ forecast, weatherCall: null });
    expect(out.mosquito.label).toBe('Mosquitoes');
    expect(out.mosquito.level).toBe('high');
    expect(out.monthName).toBe('July');
  });

  it('carries the at-service conditions when present', () => {
    const out = buildOutlook({ forecast: null, weatherCall: { headline: 'Good treatment window.', body: 'ok', factsLine: '88°F' } });
    expect(out.conditions.factsLine).toBe('88°F');
    expect(out.mosquito).toBeNull();
  });

  it('returns null with neither a mosquito entry nor conditions', () => {
    expect(buildOutlook({ forecast: null, weatherCall: null })).toBeNull();
    expect(buildOutlook({ forecast: { pests: [{ key: 'ghost_ant', label: 'Ghost ant' }] }, weatherCall: null })).toBeNull();
  });
});

describe('buildMosquitoReportV2 — assembly and guards', () => {
  it('assembles the payload for a treated, clean visit', () => {
    const out = buildMosquitoReportV2({
      premiumExperience: premium(),
      pestPressure: PRESSURE,
      findings: [],
      applications: [FOG_APP],
    });
    expect(out.status.key).toBe('protected');
    expect(out.status.label).toBe('Yard protected');
    expect(out.supportingMetric).toMatchObject({ kind: 'pressure', score: '1.2', caption: 'Mosquito pressure' });
    expect(out.habitat.items).toHaveLength(5);
    expect(out.aiSummary.body).toBe('Yard treatment was completed today.');
  });

  it('returns null with no premium experience', () => {
    expect(buildMosquitoReportV2({ premiumExperience: null })).toBeNull();
  });

  it('returns null when there is nothing to surface', () => {
    expect(buildMosquitoReportV2({
      premiumExperience: { aiSummaryPersonality: null, weatherCall: null, primaryMove: null },
      findings: [],
      applications: [],
    })).toBeNull();
  });

  it('uses the finding-driven move over the source-reduction default', () => {
    const out = buildMosquitoReportV2({
      premiumExperience: premium({ primaryMove: { title: 'Trim the hedge line', why: 'Resting habitat.', impact: 'Less harborage.', dueLabel: 'Before next service' } }),
      findings: [finding({ title: 'Dense foliage on east side', recommendation: 'Trim the hedge line' })],
      applications: [FOG_APP],
    });
    expect(out.primaryMove.title).toBe('Trim the hedge line');
  });

  it('offers the weekly tip-and-toss default ONLY when a breeding-risk habitat was flagged', () => {
    const flagged = buildMosquitoReportV2({
      premiumExperience: premium(),
      findings: [finding({ title: 'Standing water in bucket by the shed' })],
      applications: [FOG_APP],
    });
    expect(flagged.primaryMove.title).toMatch(/tip and toss/i);
    const clean = buildMosquitoReportV2({
      premiumExperience: premium(),
      findings: [],
      applications: [FOG_APP],
    });
    expect(clean.primaryMove).toBeNull();
  });

  it('rejects unsafe technician copy and falls back to the personality copy', () => {
    const out = buildMosquitoReportV2({
      premiumExperience: premium(),
      findings: [],
      applications: [FOG_APP],
      technicianReport: 'Your mosquito infestation is eliminated — the yard is guaranteed bite-free.',
    });
    expect(out.aiSummary.body).toBe('Yard treatment was completed today.');
  });

  it('keeps a rating-only metric when pressure is visible but still insufficient', () => {
    const out = buildMosquitoReportV2({
      premiumExperience: premium(),
      pestPressure: {
        displayScore: null, score: null, maxScore: 5,
        showOnCustomerReport: true, enabled: true,
        canCaptureClientRating: true,
      },
      findings: [],
      applications: [FOG_APP],
    });
    expect(out.supportingMetric.kind).toBe('pressure');
    expect(out.supportingMetric.score).toBeNull();
    expect(out.supportingMetric.rating).not.toBeNull();
  });

  it('insufficient pressure with no rating capture falls through to activity', () => {
    const out = buildMosquitoReportV2({
      premiumExperience: premium(),
      pestPressure: { displayScore: null, score: null, showOnCustomerReport: true, enabled: true },
      activity: { levelWord: 'Light', score: 1, maxScore: 5, label: 'Mosquito Activity' },
      findings: [],
      applications: [FOG_APP],
    });
    expect(out.supportingMetric.kind).toBe('activity');
  });

  it('prefers safe technician copy in the hero summary slot', () => {
    const REPORT = 'A barrier application was made to shaded foliage and the lanai screen line. Activity should taper over the next several days.';
    const out = buildMosquitoReportV2({
      premiumExperience: premium(),
      findings: [],
      applications: [FOG_APP],
      technicianReport: REPORT,
    });
    expect(out.aiSummary).toEqual({ headline: null, body: REPORT });
  });
});
