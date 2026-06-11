/**
 * Round-trip fidelity tests for services/content-astro/frontmatter.js.
 *
 * The original hand-rolled YAML subset corrupted 324 of 531 live pages in the
 * Astro content repo on a parse→stringify round-trip (publishRefresh /
 * publishMetadataRewrite rewrite ENTIRE live frontmatter through this module):
 *   1. inline flow arrays of objects (`schema:` JSON-LD on 312 pages) parsed
 *      as arrays of STRINGS and re-emitted as quoted JSON strings;
 *   2. scalars with a mid-string ` #` were re-emitted unquoted, so real YAML
 *      parsers truncated them at the comment marker (11 live
 *      meta_descriptions).
 *
 * Ground truth below is js-yaml itself: every stringify output must be loaded
 * back by a real YAML parser to the exact same data.
 */

const yaml = require('js-yaml');
const fm = require('../services/content-astro/frontmatter');

// parse(stringify(data)) and a REAL YAML parse of the emitted frontmatter
// must both deep-equal the input.
function expectRoundTrip(data, content = '\nBody text.\n') {
  const out = fm.stringify(data, content);
  const reparsed = fm.parse(out);
  expect(reparsed.data).toEqual(data);
  // parse consumes the single newline after the closing `---` (stringify
  // re-adds it), so a leading newline on the input body is not echoed back.
  expect(reparsed.content).toBe(content.startsWith('\n') ? content.slice(1) : content);

  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(out);
  expect(m).not.toBeNull();
  const truth = yaml.load(m[1], { schema: yaml.CORE_SCHEMA, json: true }) || {};
  expect(truth).toEqual(data);
  return out;
}

describe('frontmatter parse', () => {
  test('source without frontmatter returns empty data and untouched content', () => {
    expect(fm.parse('Just a body.')).toEqual({ data: {}, content: 'Just a body.' });
  });

  test('parses scalars, arrays, nested objects, quoted strings', () => {
    const src = [
      '---',
      'title: "Pest Control in Sarasota, FL"',
      'slug: pest-control-sarasota-fl',
      'count: 12',
      'draft: false',
      'nothing:',
      'tags:',
      '  - ants',
      '  - roaches',
      'author:',
      '  name: "Adam Benetti"',
      '  years_swfl: 12',
      '---',
      'Body here.',
    ].join('\n');
    const { data, content } = fm.parse(src);
    expect(data).toEqual({
      title: 'Pest Control in Sarasota, FL',
      slug: 'pest-control-sarasota-fl',
      count: 12,
      draft: false,
      nothing: null,
      tags: ['ants', 'roaches'],
      author: { name: 'Adam Benetti', years_swfl: 12 },
    });
    expect(content).toBe('Body here.');
  });

  test('P0 class 1: inline flow array of JSON-LD objects parses as OBJECTS, not strings', () => {
    const src = [
      '---',
      'schema: [{"@context":"https://schema.org","@graph":[{"@type":"Place","@id":"{{siteUrl}}/#place","address":{"@type":"PostalAddress","postalCode":"34202"}}]}]',
      '---',
      'Body.',
    ].join('\n');
    const { data } = fm.parse(src);
    expect(Array.isArray(data.schema)).toBe(true);
    expect(typeof data.schema[0]).toBe('object');
    expect(data.schema[0]['@context']).toBe('https://schema.org');
    expect(data.schema[0]['@graph'][0]['@type']).toBe('Place');
    expect(data.schema[0]['@graph'][0].address.postalCode).toBe('34202');
  });

  test('date-like scalars stay STRINGS (publish pipeline treats dates as strings)', () => {
    const src = ['---', 'published: 2026-05-08', 'modified: "2026-06-11T12:00:00"', '---', ''].join('\n');
    const { data } = fm.parse(src);
    expect(data.published).toBe('2026-05-08');
    expect(data.modified).toBe('2026-06-11T12:00:00');
  });

  test('comment lines are ignored; quoted # is preserved', () => {
    const src = ['---', '# a comment', 'desc: "Unit #4 ready"', '---', ''].join('\n');
    expect(fm.parse(src).data).toEqual({ desc: 'Unit #4 ready' });
  });
});

describe('frontmatter stringify', () => {
  test('emits exact delimiters and prefixes body with a newline', () => {
    const out = fm.stringify({ a: 1 }, 'body');
    expect(out).toBe('---\na: 1\n---\nbody');
    const out2 = fm.stringify({ a: 1 }, '\nbody');
    expect(out2).toBe('---\na: 1\n---\nbody');
  });

  test('empty data emits an empty frontmatter block (old behavior)', () => {
    expect(fm.stringify({}, '\nbody')).toBe('---\n---\nbody');
  });

  test('preserves key insertion order', () => {
    const out = fm.stringify({ zebra: 1, alpha: 2, mango: 3 }, '\n');
    const keys = out.split('\n').filter((l) => /^[a-z]+:/.test(l)).map((l) => l.split(':')[0]);
    expect(keys).toEqual(['zebra', 'alpha', 'mango']);
  });

  test('P0 class 2: a mid-string " #" value is quoted so YAML parsers do not truncate it', () => {
    const data = {
      meta_description: 'Pest control near me in Venice, FL — call now #1 rated local exterminator.',
    };
    const out = expectRoundTrip(data);
    // The emitted line must not leave ` #` bare.
    const line = out.split('\n').find((l) => l.startsWith('meta_description:'));
    expect(yaml.load(line).meta_description).toBe(data.meta_description);
  });

  test('date-like strings are emitted quoted (would otherwise re-parse as timestamps)', () => {
    const out = fm.stringify({ published: '2026-05-08', modified: '2026-06-11T12:00:00' }, '\n');
    // Ground truth: a DEFAULT_SCHEMA (timestamp-aware) parser must still see strings.
    const truth = yaml.load(out.replace(/^---\n/, '').replace(/\n---\n$/, ''));
    expect(truth.published).toBe('2026-05-08');
    expect(truth.modified).toBe('2026-06-11T12:00:00');
  });

  test('JSON-LD schema field emits as a single-line JSON flow value (repo convention)', () => {
    const schema = [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'Waves' }] }];
    const out = fm.stringify({ title: 'T', schema }, '\n');
    const schemaLines = out.split('\n').filter((l) => l.startsWith('schema:'));
    expect(schemaLines).toHaveLength(1);
    expect(schemaLines[0]).toBe(`schema: ${JSON.stringify(schema)}`);
  });

  test('non-JSON-LD arrays of objects keep block style (blog spoke_links convention)', () => {
    const out = fm.stringify(
      { spoke_links: [{ domain: 'bradentonflpestcontrol.com', anchor: 'pest control in Bradenton' }] },
      '\n',
    );
    expect(out).toContain('spoke_links:\n  - domain: bradentonflpestcontrol.com\n');
  });

  test('undefined values are skipped (old behavior)', () => {
    const out = fm.stringify({ keep: 'yes', drop: undefined }, '\n');
    expect(out).toContain('keep:');
    expect(out).not.toContain('drop');
  });
});

describe('round-trip fidelity (parse → stringify → parse, js-yaml as ground truth)', () => {
  test('simple blog post shapes', () => {
    expectRoundTrip({
      title: 'Ant Trails in Bradenton',
      slug: '/ant-trails-bradenton/',
      meta_description: 'Bradenton homeowners: identify ant trails and entry points.',
      secondary_keywords: ['ant trails', 'ant control bradenton'],
      reading_time_min: 3,
      draft: false,
      published: '2026-05-08',
      updated: '2026-06-11',
      author: { name: 'Adam Benetti', fdacs_license: 'JB351547', years_swfl: 12 },
      hero_image: { src: '/images/blog/x/hero.webp', alt: 'Ant trail near a patio' },
      domains: ['wavespestcontrol.com'],
    });
  });

  test('service page with full JSON-LD schema flow array (class-1 fixture)', () => {
    expectRoundTrip({
      title: 'Pest Control in Sarasota, FL',
      slug: 'pest-control-sarasota-fl',
      date: '2026-02-02T18:34:38',
      modified: '2026-06-10T12:00:00',
      metaDescription:
        'Pest control near me in Sarasota, FL — {{brandShort}} treats drywood termites. Call ☎️ {{cityPhone}} for a FREE estimate.',
      canonical: '{{siteUrl}}/pest-control-sarasota-fl/',
      schema: [
        {
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'Place',
              '@id': '{{siteUrl}}/#place',
              address: {
                '@type': 'PostalAddress',
                streetAddress: '9040 Town Center Pkwy',
                addressLocality: 'Lakewood Ranch',
                postalCode: '34202',
              },
            },
            {
              '@type': ['LocalBusiness', 'Organization'],
              '@id': '{{siteUrl}}/#organization',
              openingHours: ['Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday Open 24 hours'],
              description: 'Customized extermination for Florida’s subtropical climate, year-round.',
              telephone: '+1-941-297-2606',
            },
          ],
        },
      ],
      robots: 'follow, index, max-snippet:-1, max-video-preview:-1, max-image-preview:large',
      cityPhone: '(941) 297-2606',
      faq: {
        items: [
          { q: 'What pests are worst in Sarasota?', a: 'Depends on the neighborhood: roaches downtown, drywood termites on Siesta Key.' },
          { q: 'How fast can you get here?', a: 'Same-day when you call before noon.' },
        ],
      },
    });
  });

  test('mid-string # in meta_description (class-2 fixture)', () => {
    expectRoundTrip({
      meta_description: 'Voted #1 in Venice — call now #1 rated, no contracts.',
      title: 'Best Exterminator #1 Pick',
    });
  });

  test('quoted strings containing colons and URLs', () => {
    expectRoundTrip({
      canonical: 'https://www.wavespestcontrol.com/pest-control-sarasota-fl/',
      metaTitle: 'Pest Control Near Me in Sarasota, FL | Exterminator Near Me: 24 Hour',
      tracking: { domains: ['wavespestcontrol.com'] },
      note: 'key: value lookalike',
    });
  });

  test('arrays: empty, scalar, and block object arrays', () => {
    expectRoundTrip({
      related_services: [],
      service_areas_tag: ['Bradenton', 'Sarasota'],
      spoke_links: [
        { domain: 'bradentonflpestcontrol.com', anchor: 'pest control in Bradenton', placement: 'in_body' },
      ],
    });
  });

  test('multiline string values survive', () => {
    expectRoundTrip({
      summary: 'Line one.\nLine two with detail.\nLine three.',
      title: 'Multiline',
    });
  });

  test('multiline markdown body is separated intact', () => {
    const body = '\n# Heading\n\nParagraph with --- inline dashes.\n\n- list item\n\n```js\nconst x = 1;\n```\n';
    const out = fm.stringify({ title: 'T' }, body);
    const { data, content } = fm.parse(out);
    expect(data).toEqual({ title: 'T' });
    expect(content).toBe(body.slice(1)); // leading \n consumed by the delimiter
  });

  test('null values survive', () => {
    expectRoundTrip({ hero_image: null, title: 'T' });
  });

  test('booleans, numbers, and boolean-lookalike strings', () => {
    expectRoundTrip({
      draft: false,
      featured: true,
      reading_time_min: 7,
      score: 0.85,
      version_str: 'true story',
      city: 'Venice',
    });
  });

  test('strings that look like YAML specials stay strings', () => {
    expectRoundTrip({
      a: 'null',
      b: 'true',
      c: '2026-06-11',
      d: '- not a list',
      e: '[not, an, array]',
      f: '{not: an object}',
      g: '#not a comment',
    });
  });
});
