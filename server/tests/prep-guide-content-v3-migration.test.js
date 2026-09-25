/**
 * 20260924000001 — prep guide content v3.
 *
 * Guards the compliance rules the 2026-07-15 refresh established (they
 * must never regress in prep copy) plus the v3 additions: links are plain
 * https URLs on an allowlist of hosts (no affiliate tags — Amazon Associates
 * forbids Special Links in email; the affiliate pilot is web-only), list
 * blocks carry items, bed bug copy has no heat-treatment component, and the
 * publish/rollback mechanics mirror the refresh migration.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false), sendOne: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({}));

const migration = require('../models/migrations/20260924000001_prep_guide_content_v3');
const { normalizeBlocks, renderTemplate } = require('../services/email-template-library');

const { TEMPLATES, MIGRATION_MARKER } = migration;

const EXPECTED_KEYS = [
  'prep.flea', 'prep.cockroach', 'prep.bed_bug', 'prep.rodent',
  'prep.termite', 'prep.mosquito', 'prep.lawn', 'prep.interior_pest',
];

const LINK_HOST_ALLOWLIST = new Set([
  'nexgardforpets.com',
  'www.simparicatrio.com',
  'www.bravecto.com',
  'www.credelio.com',
  'www.revolutionplus.com',
  'frontline.com',
  'yourpetandyou.elanco.com',
  'www.amazon.com',
  'www.chewy.com',
  'www.wavespestcontrol.com',
]);

const MD_LINK_RE = /\[([^\]\n]+)\]\((\S+?)\)/g;

function textChunks(t) {
  const chunks = [];
  chunks.push(`${t.key} subject: ${t.subject}`);
  chunks.push(`${t.key} preview: ${t.preview}`);
  for (const b of t.blocks) {
    if (typeof b.content === 'string') chunks.push(`${t.key}: ${b.content}`);
    for (const item of b.items || []) chunks.push(`${t.key}: ${item}`);
    for (const row of b.rows || []) chunks.push(`${t.key}: ${row.label} ${row.value}`);
  }
  return chunks;
}

function allNewCopy() {
  return TEMPLATES.flatMap(textChunks);
}

function allLinks() {
  const links = [];
  for (const chunk of allNewCopy()) {
    for (const m of chunk.matchAll(MD_LINK_RE)) links.push({ chunk, label: m[1], href: m[2] });
  }
  return links;
}

describe('prep guide v3 content compliance', () => {
  test('covers exactly the eight guides and never wildlife', () => {
    expect(TEMPLATES.map((t) => t.key).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(TEMPLATES.map((t) => t.key)).not.toContain('prep.wildlife');
  });

  test('re-entry copy never says safe/safely', () => {
    for (const chunk of allNewCopy()) {
      expect(chunk).not.toMatch(/\bsafe(ly)?\b/i);
    }
  });

  test('no fixed re-entry windows (hours/minutes tied to leaving or re-entering)', () => {
    for (const chunk of allNewCopy()) {
      expect(chunk).not.toMatch(/(out of the (home|house|kitchen|room)|stay (out|away|off)|re-?enter|be out)[^.]{0,50}\d+\s*(–|-|to)?\s*\d*\s*(hour|hr|minute|min)/i);
    }
  });

  test('brand and pricing wording rules', () => {
    for (const chunk of allNewCopy()) {
      expect(chunk).not.toMatch(/Waves Lawn (&|and) Pest/i);
      expect(chunk).not.toMatch(/per visit/i);
    }
  });

  test('no fumigation or tenting content (owner prohibition)', () => {
    for (const chunk of allNewCopy()) {
      expect(chunk).not.toMatch(/fumigat|tent(ing|ed)?\b/i);
    }
  });

  test('bed bug guide describes chemical/IPM work only — no heat-treatment or steam component', () => {
    const bedBug = TEMPLATES.find((t) => t.key === 'prep.bed_bug');
    for (const chunk of textChunks(bedBug)) {
      expect(chunk).not.toMatch(/heat[- ]treat|whole[- ]room heat|steam/i);
    }
  });

  test('every guide that describes products uses the EPA-registered phrasing', () => {
    for (const t of TEMPLATES) {
      const joined = textChunks(t).join(' ');
      if (/\bproducts?\b/i.test(joined)) expect(joined).toMatch(/EPA-registered/);
    }
  });

  test('every guide keeps the required structure: service details, Pets & kids, what to expect, one FAQ, exact CTA, signature', () => {
    for (const t of TEMPLATES) {
      const headings = t.blocks.filter((b) => b.type === 'heading').map((b) => b.content);
      expect(headings).toContain('Pets & kids');
      expect(headings.some((x) => /what to expect/i.test(x))).toBe(true);
      expect(t.blocks.filter((b) => b.type === 'details').length).toBeGreaterThanOrEqual(2);
      expect(t.blocks.filter((b) => b.type === 'details' && b.variant === 'faq').length).toBe(1);
      const cta = t.blocks.find((b) => b.type === 'cta');
      expect(cta).toEqual({ type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' });
      expect(t.blocks.filter((b) => b.type === 'signature').length).toBe(1);
      expect(typeof t.subject).toBe('string');
      expect(t.subject.length).toBeGreaterThan(10);
      expect(typeof t.preview).toBe('string');
    }
  });

  test('list blocks carry non-empty items and survive the editor normalizer', () => {
    for (const t of TEMPLATES) {
      const lists = t.blocks.filter((b) => b.type === 'list');
      expect(lists.length).toBeGreaterThan(0);
      for (const l of lists) {
        expect(Array.isArray(l.items)).toBe(true);
        expect(l.items.length).toBeGreaterThan(0);
        for (const item of l.items) expect(String(item).trim()).not.toBe('');
      }
      const normalized = normalizeBlocks(t.blocks);
      const normalizedLists = normalized.filter((b) => b.type === 'list');
      expect(normalizedLists.map((b) => b.items)).toEqual(lists.map((b) => b.items));
      // FAQ variant must survive too (codex #2741 r2).
      expect(normalized.filter((b) => b.type === 'details' && b.variant === 'faq').length).toBe(1);
    }
  });

  test('every link is plain https on an allowlisted host with no affiliate or tracking parameters', () => {
    const links = allLinks();
    expect(links.length).toBeGreaterThan(10);
    for (const { href, label } of links) {
      const url = new URL(href);
      expect(url.protocol).toBe('https:');
      expect(LINK_HOST_ALLOWLIST.has(url.host)).toBe(true);
      expect(label.trim()).not.toBe('');
      for (const key of url.searchParams.keys()) {
        // Amazon Associates `tag=`, Google click ids, UTM: none belong in a
        // transactional email.
        expect(key).not.toMatch(/^(tag|gclid|gad_source|utm_.*|ref|linkCode|ascsubtag)$/i);
      }
      expect(href).not.toMatch(/amzn\.to|wavespestcont-20/);
    }
  });

  test('no link label or href carries a template variable (links are author-authored only)', () => {
    for (const { label, href } of allLinks()) {
      expect(label).not.toMatch(/\{\{/);
      expect(href).not.toMatch(/\{\{/);
    }
  });

  test('every guide renders through the email renderer with anchors and check rows, and the plain-text arm carries the URLs', () => {
    const payload = {
      first_name: 'Taylor',
      project_type: 'Flea Treatment',
      service_date: 'October 3',
      property_address: '123 Palm Ave',
      technician_name: 'Adam',
      prep_url: 'https://portal.wavespestcontrol.com/prep/abc',
    };
    for (const t of TEMPLATES) {
      const rendered = renderTemplate({
        template: { template_key: t.key, from_name: 'Waves Pest Control', from_email: 'contact@wavespestcontrol.com' },
        version: { subject: t.subject, preview_text: t.preview, blocks: t.blocks },
        payload,
      });
      const html = rendered.html || rendered.bodyHtml || '';
      const text = rendered.text || rendered.bodyText || '';
      expect(html).toContain('Open prep guide');
      expect(html).toContain('&#10003;'); // list check rows
      expect(html).not.toMatch(/\]\(https?:/); // no raw markdown leaked into HTML
      const linkCount = textChunks(t).reduce((n, c) => n + [...c.matchAll(MD_LINK_RE)].length, 0);
      const anchors = html.match(/<a class="dm-link" href="https:\/\/[^"]+" target="_blank" rel="noopener"/g) || [];
      expect(anchors.length).toBe(linkCount); // every authored link becomes exactly one anchor
      if (linkCount > 0) expect(text).toMatch(/\(https:\/\/[^)]+\)/); // text arm shows destinations
      expect(html).not.toContain('{{');
    }
  });
});

describe('publish mechanics', () => {
  function makeKnex({ withMarker = true } = {}) {
    const state = {
      template: { id: 't-1', template_key: 'prep.flea', active_version_id: 'v-1' },
      versions: [{ id: 'v-1', template_id: 't-1', version_number: 3, status: 'active', subject: 'Old subj', preview_text: 'Old prev', blocks: '[]', validation_snapshot: withMarker ? JSON.stringify({ source: MIGRATION_MARKER }) : JSON.stringify({ source: 'seed' }) }],
      templateUpdates: [],
      versionUpdates: [],
      inserted: [],
    };
    const knex = jest.fn((table) => {
      if (table === 'email_templates') {
        const q = {
          where: jest.fn(() => q),
          first: jest.fn(async () => state.template),
          update: jest.fn(async (patch) => { state.templateUpdates.push(patch); return 1; }),
        };
        return q;
      }
      if (table === 'email_template_versions') {
        const filters = {};
        const q = {
          where: jest.fn((a, b, c) => {
            if (typeof a === 'object') Object.assign(filters, a);
            else if (c !== undefined) filters[`${a}${b}`] = c;
            return q;
          }),
          whereNot: jest.fn(() => q),
          orderBy: jest.fn(() => q),
          first: jest.fn(async () => {
            if (filters.id) return state.versions.find((v) => v.id === filters.id) || null;
            if (filters.status === 'archived') return state.versions.filter((v) => v.status === 'archived').sort((a, b) => b.version_number - a.version_number)[0] || null;
            return state.versions.slice().sort((a, b) => b.version_number - a.version_number)[0] || null;
          }),
          insert: jest.fn((row) => ({
            returning: jest.fn(async () => {
              const created = { id: `v-${state.versions.length + 1}`, ...row };
              state.versions.push(created);
              state.inserted.push(created);
              return [created];
            }),
          })),
          update: jest.fn(async (patch) => { state.versionUpdates.push({ filters: { ...filters }, patch }); return 1; }),
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    });
    knex.schema = { hasTable: jest.fn(async () => true) };
    return { knex, state };
  }

  test('up publishes a new active version per template with the migration marker, new subject, and archives the prior active', async () => {
    const { knex, state } = makeKnex();
    await migration.up(knex);
    expect(state.inserted).toHaveLength(TEMPLATES.length);
    const first = state.inserted[0];
    expect(first.version_number).toBe(4);
    expect(first.status).toBe('active');
    expect(first.subject).toBe(TEMPLATES[0].subject);
    expect(first.preview_text).toBe(TEMPLATES[0].preview);
    expect(JSON.parse(first.validation_snapshot).source).toBe(MIGRATION_MARKER);
    expect(JSON.parse(first.blocks)).toEqual(TEMPLATES[0].blocks);
    expect(state.versionUpdates.some((u) => u.patch.status === 'archived')).toBe(true);
    expect(state.templateUpdates.some((u) => u.active_version_id === first.id)).toBe(true);
  });

  test('up is a no-op when the template tables are missing', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false) };
    await migration.up(knex);
    expect(knex).not.toHaveBeenCalled();
  });

  test('down restores the prior archived version only when the active one carries this migration marker', async () => {
    const marked = makeKnex({ withMarker: true });
    marked.state.versions.push({ id: 'v-0', template_id: 't-1', version_number: 2, status: 'archived', blocks: '[]' });
    await migration.down(marked.knex);
    expect(marked.state.versionUpdates.some((u) => u.filters.id === 'v-0' && u.patch.status === 'active')).toBe(true);
    expect(marked.state.versionUpdates.some((u) => u.filters.id === 'v-1' && u.patch.status === 'archived')).toBe(true);
    expect(marked.state.templateUpdates.some((u) => u.active_version_id === 'v-0')).toBe(true);

    const unmarked = makeKnex({ withMarker: false });
    unmarked.state.versions.push({ id: 'v-0', template_id: 't-1', version_number: 2, status: 'archived', blocks: '[]' });
    await migration.down(unmarked.knex);
    expect(unmarked.state.versionUpdates).toHaveLength(0);
    expect(unmarked.state.templateUpdates).toHaveLength(0);
  });
});
