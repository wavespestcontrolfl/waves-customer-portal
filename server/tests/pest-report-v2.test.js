// Unit tests for the Pest Report V2 aggregator (protection-first pest report).
// Asserts the trust-critical behavior: protection status maps correctly from the
// premium-experience defense label, internal A/B/C/D zone letters never leak into
// customer copy, banned/over-claiming copy is rejected, the seasonal forecast ranks
// rising pests first, and the section is null when there is nothing to surface.
// Synthetic payloads only (no customer PII).

const { buildPestReportV2, stripZoneLetter, buildForecast } = require('../services/service-report/pest-report-v2');

function premium(overrides = {}) {
  return {
    propertyDefenseStatus: {
      overallLabel: 'strong',
      summary: 'Your property is in a strong position after this visit.',
      items: [
        { key: 'perimeter_shield', label: 'Perimeter shield', status: 'active', detail: 'Exterior protection was applied today.' },
        { key: 'front_entry', label: 'Front entry', status: 'clear', detail: 'No active entry finding was documented.' },
      ],
    },
    primaryMove: { title: 'Pull mulch back from the entry', why: 'Mulch holds moisture.', impact: 'Reduces recurring activity.', dueLabel: 'Before next service' },
    bugFiles: [
      { pestKey: 'ghost_ant', suspectLabel: 'Ghost ant', likelyId: { label: 'Ghost ant', confirmedByTech: true }, whereSeen: { text: 'A · Front yard' }, whyItMatters: { text: 'Ghost ants trail toward entry points.' }, whatWeDid: { text: 'Perimeter spray' }, yourMove: { text: 'Pull mulch back' } },
    ],
    aiSummaryPersonality: { variants: { straight: { headline: 'Service is complete.', body: 'No interior activity documented today.' } } },
    pressureReceipt: { headline: 'Since starting WaveGuard', stats: [{ label: 'Visits completed', value: '6' }] },
    weatherCall: { headline: 'Good treatment window.', body: 'Low rainfall.' },
    ...overrides,
  };
}

const PRESSURE = { displayScore: '1.4', score: 1.4, maxScore: 5, label: 'Low', trend: 'down', showOnCustomerReport: true, enabled: true };

describe('buildPestReportV2 — protection status mapping', () => {
  const cases = [
    ['strong', 'protected', 'good'],
    ['watch', 'watching', 'watch'],
    ['needs_attention', 'recommended', 'watch'],
    ['action_required', 'action', 'attention'],
  ];
  it.each(cases)('overallLabel %s → status %s/%s', (overallLabel, key, tone) => {
    const out = buildPestReportV2({ premiumExperience: premium({ propertyDefenseStatus: { overallLabel, summary: 'ok', items: [{ key: 'x', label: 'X', status: 'active', detail: 'y' }] } }) });
    expect(out.status.key).toBe(key);
    expect(out.status.tone).toBe(tone);
  });

  it('falls back to "watching" for an unknown/missing label', () => {
    const out = buildPestReportV2({ premiumExperience: premium({ propertyDefenseStatus: { overallLabel: 'bogus', summary: 'ok', items: [{ key: 'x', label: 'X', status: 'active' }] } }) });
    expect(out.status.key).toBe('watching');
  });
});

describe('buildPestReportV2 — no internal zone letters reach the customer', () => {
  it('strips the leading "A · " zone letter from bug-file location', () => {
    const out = buildPestReportV2({ premiumExperience: premium() });
    expect(out.bugFiles[0].whereSeen).toBe('Front yard');
    expect(out.bugFiles[0].whereSeen).not.toMatch(/^[A-D]\s*·/);
  });

  it('stripZoneLetter leaves clean labels untouched', () => {
    expect(stripZoneLetter('A · Front yard')).toBe('Front yard');
    expect(stripZoneLetter('Front entry')).toBe('Front entry');
    expect(stripZoneLetter('B · Back yard')).toBe('Back yard');
  });
});

describe('buildPestReportV2 — copy safety', () => {
  it('drops an over-claiming status summary in favor of a safe fallback', () => {
    const out = buildPestReportV2({ premiumExperience: premium({ propertyDefenseStatus: { overallLabel: 'strong', summary: 'Your infestation is eliminated and pests are guaranteed gone.', items: [{ key: 'x', label: 'X', status: 'active', detail: 'y' }] } }) });
    expect(out.statusSummary).not.toMatch(/infestation|eliminated|guaranteed/i);
    expect(out.statusSummary.length).toBeGreaterThan(0);
  });
});

describe('buildPestReportV2 — supporting metric', () => {
  it('uses pest pressure when present (with trend)', () => {
    const out = buildPestReportV2({ premiumExperience: premium(), pestPressure: PRESSURE });
    expect(out.supportingMetric).toMatchObject({ kind: 'pressure', score: '1.4', label: 'Low', trend: 'down' });
  });

  it('falls back to typed activity when there is no pressure', () => {
    const out = buildPestReportV2({ premiumExperience: premium(), activity: { levelWord: 'Light', score: 1, maxScore: 5, trend: 'improving', label: 'Cockroach Activity' } });
    expect(out.supportingMetric.kind).toBe('activity');
    expect(out.supportingMetric.label).toBe('Light');
  });

  it('hides pressure when showOnCustomerReport is false', () => {
    const out = buildPestReportV2({ premiumExperience: premium(), pestPressure: { ...PRESSURE, showOnCustomerReport: false } });
    expect(out.supportingMetric).toBeNull();
  });
});

describe('buildPestReportV2 — seasonal forecast', () => {
  const forecast = {
    month_name: 'June', location: { label: 'Bradenton' }, weather: { summary: '88°F', available: true },
    summary: 'Hot, humid → ants climbing.', disclaimer: 'Informational.',
    pests: [
      { key: 'spider', label: 'Spider', emoji: '🕷️', level: 'low', trend: 'flat', score10: 2 },
      { key: 'ghost_ant', label: 'Ghost ant', emoji: '🐜', level: 'high', trend: 'up', score10: 8 },
      { key: 'german_roach', label: 'German roach', emoji: '🪳', level: 'elevated', trend: 'up', score10: 6 },
      { key: 'termite', label: 'Termite', emoji: '🪵', level: 'moderate', trend: 'flat', score10: 4 },
    ],
  };

  it('ranks rising pests first and caps at 3', () => {
    const out = buildForecast(forecast);
    expect(out.pests).toHaveLength(3);
    expect(out.pests.map((p) => p.key)).toEqual(['ghost_ant', 'german_roach', 'termite']);
    expect(out.monthName).toBe('June');
  });

  it('returns null when there are no pests', () => {
    expect(buildForecast({ pests: [] })).toBeNull();
    expect(buildForecast(null)).toBeNull();
  });
});

describe('buildPestReportV2 — empty guards', () => {
  it('returns null with no premium experience', () => {
    expect(buildPestReportV2({ premiumExperience: null })).toBeNull();
  });

  it('returns null when premium produced nothing renderable', () => {
    expect(buildPestReportV2({ premiumExperience: {} })).toBeNull();
  });
});
