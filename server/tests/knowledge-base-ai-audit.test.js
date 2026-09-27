jest.mock('../models/db', () => jest.fn());

const { _internals } = require('../services/knowledge-base');

const { auditSourceFor, buildAuditPrompt, planAuditOutcome } = _internals;

const NOW = new Date('2026-09-27T03:30:00Z'); // 2026-09-26 23:30 ET

const productEntry = {
  id: 'kb-1',
  slug: 'product-sample-sc',
  source: 'auto-sync',
  status: 'active',
  title: 'Sample SC',
  category: 'chemicals',
  content: '**Sample SC**\nDefault Rate: 0.25-1.5 fl_oz',
  last_verified_at: new Date('2026-07-13T12:00:00Z'),
};

const manualEntry = {
  id: 'kb-2',
  slug: 'rodent-service-phases',
  source: 'manual',
  status: 'active',
  title: 'Rodent Service Phases',
  category: 'protocols',
  content: 'Phase 1 inspection…',
};

describe('KB AI audit', () => {
  test('prompt carries today in Eastern time and no verified timestamp', () => {
    const prompt = buildAuditPrompt(productEntry, NOW);
    expect(prompt).toContain("Today's date: 2026-09-26");
    expect(prompt).not.toContain('Last verified');
    expect(prompt).not.toContain('2026-07-13');
    expect(prompt).toContain('generated from the Products catalog data');
  });

  test('hand-written entries get no source line', () => {
    expect(buildAuditPrompt(manualEntry, NOW)).not.toContain('generated from');
  });

  test('generated entries route to their source screen', () => {
    expect(auditSourceFor(productEntry)).toMatchObject({ fixIn: 'products_catalog', link: '/admin/inventory?tab=products' });
    expect(auditSourceFor({ source: 'auto-sync', slug: 'cogs-pre-slab-termidor' })).toMatchObject({ fixIn: 'service_product_usage', link: '/admin/inventory?tab=protocols' });
    expect(auditSourceFor({ source: 'wiki-sync', slug: 'anything' })).toMatchObject({ fixIn: 'agronomic_wiki', link: '/admin/knowledge' });
    expect(auditSourceFor({ source: 'auto-sync', slug: 'pricing-engine-current' })).toMatchObject({ fixIn: 'pricing_config' });
    expect(auditSourceFor({ source: 'auto-sync', slug: 'protocol-mosquito' })).toMatchObject({ fixIn: 'protocols' });
    expect(auditSourceFor({ source: 'protocol-sync', slug: 'lawn-protocol-x' })).toMatchObject({ fixIn: 'protocols', link: '/admin/service-library?tab=protocols' });
    expect(auditSourceFor(manualEntry)).toBeNull();
  });

  test('a flag on a generated entry keeps it searchable and does not stamp verification', () => {
    const out = planAuditOutcome(productEntry, { status: 'flag', confidence: 'high', issues: ['rate'], summary: 'rate off' }, NOW);
    expect(out.auditResult).toBe('flagged');
    expect(out.updates).toEqual({});
    expect(out.rowResult).toBe('flagged-source');
    expect(out.findings).toMatchObject({ fix_in: 'products_catalog', fix_link: '/admin/inventory?tab=products' });
  });

  test('the wiki owns a mirror entry: a verdict never hides or restores it', () => {
    const mirror = { ...manualEntry, source: 'wiki-sync', status: 'flagged', flag_owner: null };
    expect(planAuditOutcome({ ...mirror, status: 'active' }, { status: 'flag' }, NOW).updates).toEqual({});
    expect(planAuditOutcome(mirror, { status: 'pass', confidence: 'high' }, NOW).updates.status).toBeUndefined();
  });

  test('a flag on a hand-written entry hides it but does not stamp verification or confidence', () => {
    const out = planAuditOutcome(manualEntry, { status: 'update-needed', confidence: 'high', summary: 'x' }, NOW);
    expect(out.auditResult).toBe('flagged');
    expect(out.updates).toEqual({ status: 'flagged' });
    expect(out.rowResult).toBe('flagged');
    expect(out.findings.fix_in).toBeUndefined();
  });

  test('a pass verifies the entry and restores one the audit had hidden', () => {
    const out = planAuditOutcome({ ...manualEntry, status: 'flagged', flag_owner: 'ai-review' }, { status: 'pass', confidence: 'medium' }, NOW);
    expect(out.auditResult).toBe('passed');
    expect(out.updates).toEqual({ last_verified_at: NOW, verified_by: 'ai-cron', confidence: 'medium', status: 'active' });
  });

  test('a pass never clears a flag a person set', () => {
    const out = planAuditOutcome({ ...manualEntry, status: 'flagged', flag_owner: 'manual-flag' }, { status: 'pass', confidence: 'high' }, NOW);
    expect(out.updates.status).toBeUndefined();
  });

  test.each([
    [{}],
    [{ status: 'unparsed', summary: 'Could not parse AI response' }],
    [{ status: 'looks fine' }],
    [null],
  ])('no explicit verdict changes nothing (%j)', (parsed) => {
    const out = planAuditOutcome({ ...manualEntry, status: 'flagged', flag_owner: 'ai-review' }, parsed, NOW);
    expect(out.auditResult).toBe('error');
    expect(out.updates).toEqual({});
  });

  test('an unknown confidence value is not written', () => {
    const out = planAuditOutcome(productEntry, { status: 'pass', confidence: 'very_high' }, NOW);
    expect(out.updates.confidence).toBeUndefined();
    expect(out.updates.status).toBeUndefined();
  });
});
