const {
  PROMPT_VERSIONS,
  TREE_SHRUB_MAIN_REPORT_PROMPT,
  RECURRING_PEST_MAIN_REPORT_PROMPT,
  TREE_SHRUB_TREATMENT_NARRATIVE_PROMPT,
  RECURRING_PEST_VISIT_SUMMARY_PROMPT,
  buildTreeShrubTreatmentNarrativePrompt,
  buildTreeShrubTreatmentFallback,
  buildRecurringPestVisitSummaryUserMessage,
} = require('../services/service-report/pest-tree-copy-prompt');

describe('pest/tree main report prompt modules', () => {
  test('tree/shrub preserves plant, method, scope, and provenance boundaries', () => {
    expect(TREE_SHRUB_MAIN_REPORT_PROMPT).toContain('Foliar spray, root injection, soil drench, and trunk injection are distinct');
    expect(TREE_SHRUB_MAIN_REPORT_PROMPT).toContain('same product recorded with different methods represents separate work');
    expect(TREE_SHRUB_MAIN_REPORT_PROMPT).toContain('Reviewed photo signals remain separate unconfirmed context');
    expect(TREE_SHRUB_MAIN_REPORT_PROMPT).toContain('Missing data is unknown');
    expect(TREE_SHRUB_MAIN_REPORT_PROMPT).toContain('Return exactly the existing WHAT WE DID / WHAT WE FOUND');
  });

  test('recurring pest keeps observations distinct from labeled capability', () => {
    expect(RECURRING_PEST_MAIN_REPORT_PROMPT).toContain('Missing pressure is not zero');
    expect(RECURRING_PEST_MAIN_REPORT_PROMPT).toContain('also helps control other labeled crawling pests in the treated areas');
    expect(RECURRING_PEST_MAIN_REPORT_PROMPT).toContain('Never total overlapping lists or state a numeric coverage count');
    expect(RECURRING_PEST_MAIN_REPORT_PROMPT).toContain('Never imply termite protection or a bond, rodent service, mosquito service');
  });

  test('main and adapter prompts stay separate contracts with explicit versions', () => {
    expect(PROMPT_VERSIONS).toEqual({
      main: 'pest_tree_main_copy_v1',
      treeTreatment: 'tree_shrub_treatment_narrative_v1',
      pestVisitSummary: 'pest_visit_summary_narrative_v3',
    });
    expect(TREE_SHRUB_TREATMENT_NARRATIVE_PROMPT).toContain('Return one plain-text paragraph');
    expect(TREE_SHRUB_TREATMENT_NARRATIVE_PROMPT).not.toContain('WHAT WE DID\n');
    expect(RECURRING_PEST_VISIT_SUMMARY_PROMPT).toContain('Return JSON only');
    expect(RECURRING_PEST_VISIT_SUMMARY_PROMPT).not.toContain('PRODUCT LABELED COVERAGE block');
  });
});
describe('tree/shrub treatment narrative adapter', () => {
  const mixedApplications = [
    {
      name: 'Brand must stay in the table',
      activeIngredient: 'Dinotefuran 20%',
      kind: 'systemic',
      method: 'root_injection',
      applicationArea: 'six palms',
      targets: ['mealybugs'],
      whatItDoes: 'unapproved claim that must not enter the prompt',
    },
    {
      name: 'Brand must stay in the table',
      activeIngredient: 'Dinotefuran 20%',
      kind: 'systemic',
      method: 'soil_injection',
      location: 'entry palms',
      targets: ['scale'],
    },
    {
      name: 'Brand must stay in the table',
      activeIngredient: 'Dinotefuran 20%',
      kind: 'systemic',
      method: 'trunk_injection',
      plantGroup: 'two specimen palms',
      targets: ['borers'],
    },
  ];

  test('retains same-product mixed methods and their actual scopes without brands or unapproved mechanisms', () => {
    const prompt = buildTreeShrubTreatmentNarrativePrompt({
      products: mixedApplications,
      findingsText: 'Mealybug activity remains but is substantially improved on the entry palms.',
      photoSummary: 'Reviewed photos show sticky residue on several leaves.',
    });

    expect(prompt.match(/^- dinotefuran/gm)).toHaveLength(3);
    expect(prompt).toContain('recorded method: root injection; recorded scope: six palms');
    expect(prompt).toContain('recorded method: soil injection; recorded scope: entry palms');
    expect(prompt).toContain('recorded method: trunk injection; recorded scope: two specimen palms');
    expect(prompt).toContain('substantially improved');
    expect(prompt).toContain('Reviewed photo signals (separate unconfirmed context)');
    expect(prompt).not.toContain('Brand must stay');
    expect(prompt).not.toContain('unapproved claim');
    expect(prompt).toContain('without inventing percentages');
  });

  test('missing findings remain unknown and duplicate photo text is not promoted to a finding', () => {
    const photoSignal = 'Yellowing is visible in the reviewed photo set.';
    const absent = buildTreeShrubTreatmentNarrativePrompt({ products: mixedApplications, findingsText: '' });
    expect(absent).toContain('What we found this visit: Not supplied');
    expect(absent).not.toMatch(/routine visit|no significant findings|nothing found/i);

    const duplicated = buildTreeShrubTreatmentNarrativePrompt({
      products: mixedApplications,
      findingsText: photoSignal,
      photoSummary: photoSignal,
    });
    expect(duplicated).toContain('What we found this visit: Not supplied');
    expect(duplicated).toContain(`Reviewed photo signals (separate unconfirmed context): ${photoSignal}`);
  });

  test('only an explicitly approved explanation enters the grounding block', () => {
    const prompt = buildTreeShrubTreatmentNarrativePrompt({ products: [{
      activeIngredient: 'Imidacloprid',
      method: 'soil_drench',
      approvedExplanation: { approved: true, text: 'Supports control of the recorded target through the approved soil application.' },
    }] });
    expect(prompt).toContain('approved explanation: Supports control');
  });

  test('deterministic tree fallback keeps actives, mixed methods, and scope without inferred mechanisms', () => {
    const fallback = buildTreeShrubTreatmentFallback({ products: [
      ...mixedApplications,
      { name: 'Support Brand', kind: 'other', activeIngredient: 'Nonionic surfactant', method: 'foliar_spray' },
    ] });
    expect(fallback).toContain('dinotefuran by root injection for six palms');
    expect(fallback).toContain('dinotefuran by soil injection for entry palms');
    expect(fallback).toContain('dinotefuran by trunk injection for two specimen palms');
    expect(fallback).not.toMatch(/Brand|surfactant|absorbed|systemic|weeks/i);
  });

  test('tree fallback uses a functional description when an active is absent', () => {
    expect(buildTreeShrubTreatmentFallback({ products: [{
      name: 'Unexposed Trade Name', kind: 'herbicide', method: 'spot_treatment', targets: ['broadleaf weeds'], area: 'bedding areas',
    }] })).toBe('Today we applied a treatment application by spot treatment for bedding areas, targeting broadleaf weeds.');
    expect(buildTreeShrubTreatmentFallback({ products: [{
      activeIngredient: 'Imidacloprid', method: 'constructor', area: 'entry palms',
    }] })).toBe('Today we applied imidacloprid by constructor for entry palms.');
  });

  test('brand-derived kind cannot become a mechanism when active and approved facts are absent', () => {
    const safariFromCurrentMapper = {
      name: 'Safari 20 SG',
      kind: 'systemic',
      activeIngredient: null,
      method: 'foliar_spray',
      area: 'six palms',
      targets: ['scale'],
      whatItDoes: 'systemic product absorbed by the plant',
    };
    const prompt = buildTreeShrubTreatmentNarrativePrompt({ products: [safariFromCurrentMapper] });
    const fallback = buildTreeShrubTreatmentFallback({ products: [safariFromCurrentMapper] });

    expect(prompt).toContain('- a treatment application — recorded method: foliar spray; recorded scope: six palms');
    expect(prompt).not.toMatch(/application category: systemic|approved application role: systemic|absorbed by the plant/i);
    expect(prompt).not.toContain('Safari');
    expect(fallback).toBe('Today we applied a treatment application by foliar spray for six palms, targeting scale.');
    expect(fallback).not.toMatch(/systemic|Safari/i);
  });

  test('an explicit approved broad role may identify an application without an active', () => {
    const prompt = buildTreeShrubTreatmentNarrativePrompt({ products: [{
      name: 'Hidden Brand', kind: 'systemic', method: 'soil_drench',
      approvedRole: { approved: true, text: 'insecticide' },
    }] });
    expect(prompt).toContain('- an insecticide application — recorded method: soil drench; approved application role: insecticide');
  });

  test('recurring visit-summary adapter serializes supplied facts without interpreting them', () => {
    const facts = {
      technicianRecap: 'Treated the documented exterior areas.',
      pressureLabel: null,
      customerVisibleFindings: [{ text: 'Customer reported activity near the kitchen.' }],
      nextVisit: null,
    };

    expect(buildRecurringPestVisitSummaryUserMessage(facts)).toBe(
      `Grounding facts:\n${JSON.stringify(facts, null, 2)}\n\nReturn only the JSON object.`,
    );
  });
  test('concentration formatting preserves leading and multiple active ingredient names', () => {
    const products = [
      { activeIngredient: '6% Fe (EDDHA chelate)', method: 'soil_drench', area: 'entry palms' },
      { activeIngredient: 'Azoxystrobin 0.31% + Propiconazole 0.75%', method: 'foliar_spray', area: 'hibiscus' },
    ];
    for (const output of [buildTreeShrubTreatmentNarrativePrompt({ products }), buildTreeShrubTreatmentFallback({ products })]) {
      expect(output).toMatch(/Fe \(eddha chelate\)/i);
      expect(output).toContain('azoxystrobin + propiconazole');
      expect(output).not.toContain('%');
    }
  });

  test('fallback keeps all recorded targets with their own application method and scope', () => {
    const fallback = buildTreeShrubTreatmentFallback({ products: [
      { activeIngredient: 'Dinotefuran', method: 'root_injection', area: 'palms', targets: ['scale', 'mealybugs', 'aphids', 'whiteflies'] },
      { activeIngredient: 'Azoxystrobin', method: 'foliar_spray', area: 'hibiscus', targets: ['leaf spot'] },
    ] });
    expect(fallback).toBe('Today we applied dinotefuran by root injection for palms, targeting scale, mealybugs, aphids and whiteflies; azoxystrobin by foliar spray for hibiscus, targeting leaf spot.');
  });

});
