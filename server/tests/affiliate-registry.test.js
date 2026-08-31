// @waves/affiliate-registry — enum pinning + validator/classifier invariants
// (owner monetization pilot 2026-08-31). The enums are POLICY: changing one
// is a deliberate PR that updates this pin, never a drive-by.

const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');

const registry = require('../../packages/affiliate-registry');

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

const green = (over = {}) => ({
  product_id: 'rain-gauge', status: 'active', risk_class: 'green', merchant: 'amazon',
  approved_affiliate_url: 'https://www.amazon.com/dp/B000TEST01?tag=wavespest-20',
  allowed_post_types: ['protocol'], owner_approved_at: iso(5), ...over,
});
const yellow = (over = {}) => ({
  product_id: 'ant-bait', status: 'active', risk_class: 'yellow', merchant: 'solutions',
  approved_affiliate_url: 'https://www.solutionsstores.com/x?aff=waves',
  allowed_post_types: ['protocol'], owner_approved_at: iso(5),
  epa_reg_number: '12345-67', label_url: 'https://www.solutionsstores.com/label.pdf',
  florida_registration_verified_at: iso(5), label_reviewed_at: iso(5), ...over,
});

describe('affiliate-registry enums (policy pins)', () => {
  test('vocabulary is frozen at the ruling values', () => {
    expect(registry.AFFILIATE_STATUSES).toEqual(['active', 'paused', 'prohibited']);
    expect(registry.AFFILIATE_RISK_CLASSES).toEqual(['green', 'yellow', 'red']);
    expect(registry.PROTECTED_POST_TYPES).toEqual(['location', 'cost', 'decision', 'comparison', 'case-study']);
    expect(registry.YELLOW_LABEL_REVIEW_MAX_AGE_DAYS).toBe(180);
    expect(registry.YELLOW_REVIEW_FIELDS).toEqual(['epa_reg_number', 'label_url', 'florida_registration_verified_at', 'label_reviewed_at']);
    expect(Object.isFrozen(registry.AFFILIATE_RISK_CLASSES)).toBe(true);
  });
});

describe('validateProduct', () => {
  test('a well-formed green and a well-formed yellow row validate clean', () => {
    expect(registry.validateProduct(green())).toEqual([]);
    expect(registry.validateProduct(yellow())).toEqual([]);
  });
  test('red is only ever a prohibited denial record', () => {
    expect(registry.validateProduct({ product_id: 'pro-x', status: 'prohibited', risk_class: 'red', merchant: 'x' })).toEqual([]);
    expect(registry.validateProduct(green({ risk_class: 'red' })).join(' ')).toMatch(/red-class/);
  });
  test('amazon rows must be direct amazon.com with a tag — shortlinks and tag-less rows are invalid', () => {
    expect(registry.validateProduct(green({ approved_affiliate_url: 'https://amzn.to/x' })).join(' ')).toMatch(/amazon\.com directly/);
    expect(registry.validateProduct(green({ approved_affiliate_url: 'https://www.amazon.com/dp/B1' })).join(' ')).toMatch(/tag=/);
    // merchant is normalized (trim + lowercase) before the Amazon rules apply (Codex r4 P1)
    expect(registry.validateProduct(green({ merchant: ' Amazon ', approved_affiliate_url: 'https://amzn.to/x' })).join(' ')).toMatch(/amazon\.com directly/);
  });
  test('Amazon policy keys off hostname / normalized merchant, not exact spelling; prohibited rows carry no URL (astro #503 parity)', () => {
    expect(registry.validateProduct(green({ merchant: 'Amazon US', approved_affiliate_url: 'https://amzn.to/x' })).join(' ')).toMatch(/amazon\.com directly/);
    expect(registry.validateProduct(green({ merchant: 'Some Store', approved_affiliate_url: 'https://www.amazon.com/dp/B1' })).join(' ')).toMatch(/tag=/);
    expect(registry.validateProduct({ product_id: 'pro-x', status: 'prohibited', risk_class: 'red', merchant: 'x', plain_url: 'https://example.com/p' }).join(' ')).toMatch(/must not carry plain_url/);
  });
  test('amazon plain_url is the UNTRACKED fallback: direct amazon.com, no tag/ascsubtag (Codex PR3 r4)', () => {
    expect(registry.validateProduct(green({ plain_url: 'https://amzn.to/x' })).join(' ')).toMatch(/plain_url must be a direct amazon\.com/);
    expect(registry.validateProduct(green({ plain_url: 'https://www.amazon.com/dp/B000TEST01?tag=wavespest-20' })).join(' ')).toMatch(/no tag=/);
    expect(registry.validateProduct(green({ plain_url: 'https://www.amazon.com/dp/B000TEST01' }))).toEqual([]);
  });
  test('protected post types can never be declared eligible', () => {
    for (const pt of registry.PROTECTED_POST_TYPES) {
      expect(registry.validateProduct(green({ allowed_post_types: ['protocol', pt] })).join(' ')).toMatch(/protected local-service/);
    }
  });
  test('active rows require owner approval; yellow rows require all four review fields', () => {
    expect(registry.validateProduct(green({ owner_approved_at: undefined })).join(' ')).toMatch(/owner_approved_at/);
    for (const f of registry.YELLOW_REVIEW_FIELDS) {
      expect(registry.validateProduct(yellow({ [f]: undefined })).join(' ')).toMatch(new RegExp(f));
    }
  });
  test('review/approval dates must be real calendar dates and not in the future (Codex r2 P1)', () => {
    const now = { now: new Date() };
    expect(registry.parseReviewDate('2099-02-31')).toBeNull();
    expect(registry.parseReviewDate('2026-02-30')).toBeNull();
    expect(registry.parseReviewDate('2026-08-30T25:00:00Z')).toBeNull();
    expect(registry.parseReviewDate('2026-08-30')).toEqual({ dateOnly: '2026-08-30' });
    expect(registry.parseReviewDate('2026-08-30T12:00:00Z').instant).toBeInstanceOf(Date);
    expect(registry.validateProduct(green({ owner_approved_at: iso(-30) }), now).join(' ')).toMatch(/owner_approved_at/);
    expect(registry.validateProduct(yellow({ label_reviewed_at: '2099-02-31' }), now).join(' ')).toMatch(/label_reviewed_at/);
    expect(registry.validateProduct(yellow({ florida_registration_verified_at: iso(-2) }), now).join(' ')).toMatch(/florida_registration_verified_at/);
    expect(registry.classifyProduct(yellow({ label_reviewed_at: '2099-02-31' }), now)).toBe('stale_label_review');
    expect(registry.classifyProduct(green({ owner_approved_at: iso(-30) }), now)).toBe('inactive');
  });
  test('date-only values are America/New_York calendar days, not UTC midnight (Codex r5 P1)', () => {
    // 2026-08-31T02:00Z is 2026-08-30 22:00 ET — "tomorrow" in UTC terms is
    // still today in ET, and 2026-08-31 is a FUTURE ET date.
    const now = new Date('2026-08-31T02:00:00Z');
    expect(registry.etCalendarDate(now)).toBe('2026-08-30');
    expect(registry.validateProduct(green({ owner_approved_at: '2026-08-31' }), { now }).join(' ')).toMatch(/owner_approved_at/);
    expect(registry.validateProduct(green({ owner_approved_at: '2026-08-30' }), { now })).toEqual([]);
    // 180-day window counts ET calendar days: reviewed 2026-03-03 is exactly 180 days before 2026-08-30 → still current;
    // 2026-03-02 is 181 → stale. (UTC midnight math would have flipped these hours early.)
    expect(registry.classifyProduct(yellow({ label_reviewed_at: '2026-03-03', florida_registration_verified_at: '2026-03-03', owner_approved_at: '2026-03-03' }), { now })).toBe('active');
    expect(registry.classifyProduct(yellow({ label_reviewed_at: '2026-03-02', florida_registration_verified_at: '2026-03-02', owner_approved_at: '2026-03-02' }), { now })).toBe('stale_label_review');
    // Timestamped values compare as instants.
    expect(registry.validateProduct(green({ owner_approved_at: '2026-08-31T01:00:00Z' }), { now })).toEqual([]);
    expect(registry.validateProduct(green({ owner_approved_at: '2026-08-31T03:00:00Z' }), { now }).join(' ')).toMatch(/owner_approved_at/);
  });
  test('non-https URLs are invalid', () => {
    expect(registry.validateProduct(green({ approved_affiliate_url: 'http://www.amazon.com/dp/B1?tag=t' })).length).toBeGreaterThan(0);
    expect(registry.validateProduct(green({ plain_url: 'javascript:alert(1)' })).join(' ')).toMatch(/plain_url/);
  });
});

describe('classifyProduct', () => {
  const now = { now: new Date() };
  test('the four states map to the gate codes', () => {
    expect(registry.classifyProduct(green(), now)).toBe('active');
    expect(registry.classifyProduct(yellow(), now)).toBe('active');
    expect(registry.classifyProduct({ product_id: 'p', status: 'prohibited', risk_class: 'red', merchant: 'x' }, now)).toBe('prohibited');
    expect(registry.classifyProduct(green({ risk_class: 'red' }), now)).toBe('prohibited');
    expect(registry.classifyProduct(green({ status: 'paused' }), now)).toBe('inactive');
    expect(registry.classifyProduct(green({ owner_approved_at: undefined }), now)).toBe('inactive');
    expect(registry.classifyProduct(green({ approved_affiliate_url: 'https://amzn.to/x' }), now)).toBe('inactive');
  });
  // Fixtures are UTC-relative while the classifier counts ET calendar days —
  // margins of ±2 keep this stable across the 8pm–midnight ET skew window.
  test('yellow review staleness: missing fields or >180 days old is stale_label_review', () => {
    expect(registry.classifyProduct(yellow({ label_reviewed_at: undefined }), now)).toBe('stale_label_review');
    expect(registry.classifyProduct(yellow({ label_reviewed_at: iso(182) }), now)).toBe('stale_label_review');
    expect(registry.classifyProduct(yellow({ florida_registration_verified_at: iso(200) }), now)).toBe('stale_label_review');
    expect(registry.classifyProduct(yellow({ label_reviewed_at: iso(178), florida_registration_verified_at: iso(178) }), now)).toBe('active');
  });
});

describe('productIndex / validateRegistry / loadRegistry', () => {
  test('duplicate product_ids poison both copies (never a usable winner)', () => {
    const reg = { version: 1, products: [green(), green({ status: 'paused' })] };
    const idx = registry.productIndex({ registry: reg });
    expect(idx.get('rain-gauge').state).toBe('inactive');
    expect(registry.validateRegistry(reg).some((p) => p.errors.join(' ').includes('duplicate'))).toBe(true);
  });
  test('registryUrls returns approved AND plain URLs', () => {
    const reg = { version: 1, products: [green({ plain_url: 'https://www.amazon.com/dp/B000TEST01' })] };
    expect(registry.registryUrls({ registry: reg }).sort()).toEqual([
      'https://www.amazon.com/dp/B000TEST01',
      'https://www.amazon.com/dp/B000TEST01?tag=wavespest-20',
    ]);
  });
  test('a missing or malformed registry file loads as empty (fail closed, never a throw)', () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'affreg-'));
    const prev = process.env.AFFILIATE_REGISTRY_PATH;
    try {
      process.env.AFFILIATE_REGISTRY_PATH = join(dir, 'missing.json');
      registry._resetCache();
      expect(registry.loadRegistry().products).toEqual([]);
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{not json');
      process.env.AFFILIATE_REGISTRY_PATH = bad;
      registry._resetCache();
      expect(registry.loadRegistry().products).toEqual([]);
      expect(registry.productIndex().size).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.AFFILIATE_REGISTRY_PATH;
      else process.env.AFFILIATE_REGISTRY_PATH = prev;
      registry._resetCache();
    }
  });
  test('a malformed top-level registry is a reported problem, never coerced to "no products, no errors" (Codex r1 P1)', () => {
    for (const bad of [{}, [], null, { products: [] }, { version: 'x', products: [] }, { version: 1, products: {} }]) {
      expect(registry.validateRegistry(bad).length).toBeGreaterThan(0);
    }
    expect(registry.validateRegistry({ version: 1, products: [] })).toEqual([]);
  });
  test('the vendored registry.json in this repo validates clean AND matches its recorded upstream checksum', () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    registry._resetCache();
    expect(registry.validateRegistry(registry.loadRegistry())).toEqual([]);
    const pkgDir = join(__dirname, '..', '..', 'packages', 'affiliate-registry');
    const recorded = readFileSync(join(pkgDir, 'upstream-checksum.txt'), 'utf8').trim();
    expect(registry.registryChecksum(readFileSync(join(pkgDir, 'registry.json')))).toBe(recorded);
  });
});
