// Waves Pest Insider part pictures (parts.js; owner 2026-11-19: "if we
// mention things like waist or antennae, features, we should show a
// picture"). Every text with a part word has a reviewed list, and every
// issue that names a part shows a labeled real photo with its credit line.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  PARTS, PART_DIR, PHOTO_DIR, PART_BASE_URL, PART_WIDTH, PART_HEIGHT, PART_DESIGN, LICENSES, DIAGRAMS,
  panelSize, partWordsIn, factText, speciesText, validateParts, partPictureForFact, partPictureForSpecies,
} = require('../services/pest-insider/parts');
const { FACTS } = require('../services/pest-insider/facts');
const { POSTS, POST_URLS, postUrl } = require('../services/pest-insider/posts');
const { SPECIES } = require('../services/pest-insider/plan');
const { renderIssue, escapeHtml } = require('../services/pest-insider/render');
const raw = require('../data/pest-insider-parts-v1.json');

const root = path.join(__dirname, '../..');
// The facts an issue can lead with: those with a reviewed post.
const leadFacts = FACTS.filter((fact) => Object.prototype.hasOwnProperty.call(POSTS, fact.id));
const pictured = (map) => Object.entries(map).filter(([, entry]) => entry.picture);
const allPictures = () => [...pictured(PARTS.facts), ...pictured(PARTS.species)];

describe('the part rule', () => {
  test('every lead fact and species whose shown text has a part word has a reviewed list', () => {
    const missing = [
      ...leadFacts.filter((fact) => partWordsIn(factText(fact.id)).length && !PARTS.facts[fact.id]).map((fact) => `fact ${fact.id}: ${partWordsIn(factText(fact.id)).join(', ')}`),
      ...SPECIES.filter((species) => partWordsIn(species.fact).length && !PARTS.species[species.slug]).map((species) => `species ${species.slug}: ${partWordsIn(species.fact).join(', ')}`),
    ];
    expect(missing).toEqual([]);
  });

  test('the tripwire matches whole words only, the ones the owner named among them', () => {
    expect(partWordsIn('Look at the Waist and antennae; the waist again.')).toEqual(['waist', 'antennae']);
    expect(partWordsIn('A waistline, antennas-free headway')).toEqual(['antennas']);
    expect(partWordsIn('Rats can jump eight feet')).toEqual(['feet']);
  });

  test('a list with parts has a picture; an empty list has none and says why', () => {
    for (const kind of ['facts', 'species']) {
      for (const [id, entry] of Object.entries(raw[kind])) {
        expect([kind, id, Boolean(PARTS[kind][id].picture)]).toEqual([kind, id, entry.parts.length > 0]);
        if (!entry.parts.length) expect([kind, id, typeof entry.why]).toEqual([kind, id, 'string']);
      }
    }
  });

  test('the cases the plan named show their parts', () => {
    expect(PARTS.facts.T03.parts).toEqual(['waist', 'antennae']);
    expect(PARTS.facts.T01.parts).toEqual(['pellets', 'wings']);
    expect(PARTS.facts.L02.parts).toEqual(['leaf blades']);
    for (const slug of ['earwig', 'puss-caterpillar', 'bigheaded-ant', 'house-centipede', 'io-moth-caterpillar']) expect([slug, Boolean(partPictureForSpecies(slug))]).toEqual([slug, true]);
  });
});

describe('the pictures', () => {
  test('each is drawn in a whole 1164x680 JPEG that ships with the portal; an older picture may stay for sent emails', async () => {
    const sharp = require('sharp');
    const dir = path.join(root, PART_DIR);
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
    expect(allPictures().map(([, entry]) => entry.picture.file).filter((f) => !files.includes(f))).toEqual([]);
    expect(files.filter((f) => !/^[a-z0-9-]+-[0-9a-f]{10}\.jpg$/.test(f))).toEqual([]);
    for (const [id, { picture }] of allPictures()) {
      expect(picture.file).toMatch(new RegExp(`^${id.toLowerCase()}-[0-9a-f]{10}\\.jpg$`));
      expect(picture.url).toBe(`${PART_BASE_URL}${picture.file}`);
      const jpeg = fs.readFileSync(path.join(dir, picture.file));
      const meta = await sharp(jpeg).metadata();
      expect([id, meta.format, meta.width, meta.height]).toEqual([id, 'jpeg', PART_WIDTH * 2, PART_HEIGHT * 2]);
      // the whole picture decodes (a file cut short by a failed write does not), and stays light for email
      await expect(sharp(jpeg).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
      expect([id, jpeg.length <= 220 * 1024]).toEqual([id, true]);
    }
  });

  test('each photo is in the photos folder with the bytes its sha16 names, and the folder holds no other file', () => {
    const dir = path.join(root, PHOTO_DIR);
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
    expect(files).toEqual(Object.keys(raw.photos).sort());
    for (const [file, photo] of Object.entries(raw.photos)) {
      expect([file, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex').slice(0, 16)]).toEqual([file, photo.sha16]);
    }
    // every photo is used by some picture
    const used = new Set(allPictures().flatMap(([, { picture }]) => picture.panels.map((panel) => panel.photo)));
    expect(Object.keys(raw.photos).filter((file) => !used.has(file))).toEqual([]);
  });

  test('a change to any drawn word, mark, crop or photo gives the picture a new file name', () => {
    const fileOf = (mutate) => {
      const d = JSON.parse(JSON.stringify(raw));
      mutate(d);
      return validateParts(d).facts.T03.picture.file;
    };
    const base = PARTS.facts.T03.picture.file;
    expect(fileOf(() => {})).toBe(base);
    expect(fileOf((d) => { d.facts.T03.heading = 'Look at the waist and antennae'; })).not.toBe(base);
    expect(fileOf((d) => { d.facts.T03.panels[0].marks[0].r = 17; })).not.toBe(base);
    expect(fileOf((d) => { d.facts.T03.panels[0].crop = [81, 0, 858, 769]; })).not.toBe(base);
    expect(fileOf((d) => { d.photos['termite-340864961.jpg'].sha16 = '0000000000000000'; })).not.toBe(base);
    expect(PART_DESIGN).toBe(1);
  });

  test('an email links each picture at the file the portal serves from client/public, with no route of its own', () => {
    expect(PART_BASE_URL).toBe('https://portal.wavespestcontrol.com/pest-insider/parts/');
    expect(PART_DIR).toBe('client/public/pest-insider/parts');
  });

  test('two side-by-side panels are shorter when they carry names', () => {
    expect([panelSize(1, false), panelSize(2, true), panelSize(2, false)]).toEqual([[566, 272], [279, 250], [279, 272]]);
    expect(DIAGRAMS).toEqual(['folded-blade']);
  });
});

describe('the email', () => {
  const BASE = {
    subject: 'Termites in winter',
    preview: 'Look at the waist.',
    lead: { headline: 'x', sentences: [{ text: 'A sentence.' }], postUrl: [...POST_URLS][0] },
    idItem: { text: 'It raises a generation in about a week.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
  };
  const leadFor = (id) => ({ ...BASE.lead, postUrl: postUrl(id), factId: id });
  const speciesItem = (slug) => {
    const species = SPECIES.find((s) => s.slug === slug);
    return { text: species.fact, species: { slug, name: species.name } };
  };

  test('every lead fact with parts shows its picture after the card, with its alt text and credit line; one with none shows no part picture', () => {
    for (const fact of leadFacts) {
      const html = renderIssue({ ...BASE, lead: leadFor(fact.id) }).html_body;
      const picture = partPictureForFact(fact.id);
      if (!picture) { expect([fact.id, html.includes(PART_BASE_URL)]).toEqual([fact.id, false]); continue; }
      expect([fact.id, html.includes(`<img src="${picture.url}" alt="${escapeHtml(picture.alt)}" width="582" height="340"`)]).toEqual([fact.id, true]);
      // a picture shows its credit line right under it
      const after = html.slice(html.indexOf(picture.url));
      for (const credit of picture.credits) expect([fact.id, after.includes(`href="${escapeHtml(credit.source)}"`)]).toEqual([fact.id, true]);
    }
  });

  test('every species with parts shows its picture inside its card; one with none shows no part picture', () => {
    for (const species of SPECIES) {
      const html = renderIssue({ ...BASE, idItem: speciesItem(species.slug) }).html_body;
      const picture = partPictureForSpecies(species.slug);
      expect([species.slug, html.includes(PART_BASE_URL)]).toEqual([species.slug, Boolean(picture)]);
      if (picture) expect([species.slug, html.includes(`<img src="${picture.url}" alt="${escapeHtml(picture.alt)}"`)]).toEqual([species.slug, true]);
    }
  });

  test('the credit line names each author and license, links the photo page and the license, and says Waves cropped and labeled it', () => {
    const html = renderIssue({ ...BASE, lead: leadFor('T03'), idItem: speciesItem('earwig') }).html_body;
    expect(html).toContain('Photos via iNaturalist: termite, <a');
    expect(html).toContain('>© Zakqary Roy</a>');
    expect(html).toContain(`href="${LICENSES['CC BY 4.0']}"`);
    expect(html).toContain('fire ant, <a');
    expect(html).toContain('>cgmayers</a>');
    expect(html).toContain(`href="${LICENSES.CC0}"`);
    expect(html).toContain('</a>). Cropped and labeled by Waves.');
    // a single photo needs no subject
    expect(html).toContain('Photo via iNaturalist: <a');
    expect(html).toContain('>sealgyu</a>');
    // a diagram is drawn by Waves: no credit line
    const l02 = renderIssue({ ...BASE, lead: leadFor('L02') }).html_body;
    expect(l02).toContain(partPictureForFact('L02').url);
    expect(l02).not.toContain('Cropped and labeled by Waves');
  });

  test('the plain-text part carries no picture and no credit', () => {
    const r = renderIssue({ ...BASE, lead: leadFor('T03'), idItem: speciesItem('earwig') });
    expect(r.text_body).not.toContain(PART_BASE_URL);
    expect(r.text_body).not.toContain('Cropped and labeled');
  });
});

describe('validateParts', () => {
  const refuse = (mutate, message) => {
    const d = JSON.parse(JSON.stringify(raw));
    mutate(d);
    expect(() => validateParts(d)).toThrow(message);
  };

  test.each([
    ['a share-alike photo', (d) => { d.photos['termite-340864961.jpg'].license = 'CC BY-SA 4.0'; }, /license is one of CC0, CC BY 4.0, Public domain/],
    ['a CC BY photo with no author', (d) => { d.photos['termite-340864961.jpg'].author = null; }, /a CC BY photo names its author/],
    ['a photo from another site', (d) => { d.photos['termite-340864961.jpg'].source = 'https://example.com/termite'; }, /source is an https page on/],
    ['a photo page over http', (d) => { d.photos['termite-340864961.jpg'].source = 'http://www.inaturalist.org/observations/1'; }, /source is an https page on/],
    ['a photo key it does not know', (d) => { d.photos['termite-340864961.jpg'].ai = false; }, /no ai/],
    ['a heading not in the text', (d) => { d.facts.T03.heading = 'Look closely at termites'; }, /the heading is the text's own words/],
    ['a label not in the text', (d) => { d.facts.T03.panels[0].marks[0].label = 'thick waist'; }, /the label "thick waist" is not the text's own words/],
    ['a panel name not in the text', (d) => { d.facts.T03.panels[0].name = 'white ants'; }, /the panel name "white ants"/],
    ['a part the text does not name', (d) => { d.facts.T03.parts.push('legs'); }, /the text does not name legs/],
    ['a part no label circles', (d) => { d.facts.T03.panels[0].marks.pop(); d.facts.T03.panels[1].marks.pop(); }, /no label circles antennae/],
    ['an empty list with no why', (d) => { delete d.facts.L05.why; }, /says why in a line/],
    ['an empty list with a picture', (d) => { d.facts.L05.heading = 'Mowing higher grows a deeper root system'; }, /a list with no parts has no picture/],
    ['a crop of another shape', (d) => { d.species.earwig.panels[0].crop = [0, 0, 1024, 1024]; }, /the crop keeps the panel's shape/],
    ['a crop smaller than the panel', (d) => { d.species.earwig.panels[0].crop = [0, 0, 400, 192]; }, /at least 566x272/],
    ['one named panel of two', (d) => { delete d.facts.T03.panels[1].name; }, /both have names or neither does/],
    ['a name on a lone panel', (d) => { d.species.earwig.panels[0].name = 'earwig'; }, /one panel has no name/],
    ['a mark outside its panel', (d) => { d.species.earwig.panels[0].marks[0].at = [[600, 92]]; }, /inside the 566x272 panel/],
    ['three spots on one mark', (d) => { d.species.earwig.panels[0].marks[0].at = [[1, 1], [2, 2], [3, 3]]; }, /1 or 2 spots/],
    ['a turn that is not a right angle', (d) => { d.species.earwig.panels[0].rotate = 45; }, /rotate is 90, 180 or 270/],
    ['a diagram no drawer draws', (d) => { d.facts.L02.panels[0].diagram = 'rolled-blade'; }, /no diagram rolled-blade/],
    ['a diagram with a photo', (d) => { d.facts.L02.panels[0].photo = 'earwig-370935894.jpg'; }, /a diagram panel has no photo/],
    ['a photo the list does not have', (d) => { d.species.earwig.panels[0].photo = 'earwig-1.jpg'; }, /no photo earwig-1.jpg/],
    ['an entry for no fact', (d) => { d.facts.Z99 = { parts: [], why: 'none' }; }, /facts.Z99: no such fact/],
    ['an entry for no species', (d) => { d.species['not-a-bug'] = { parts: [], why: 'none' }; }, /species.not-a-bug: no such species/],
    ['a file with no photos map', (d) => { delete d.photos; }, /the file has photos, facts and species maps/],
  ])('refuses %s', (_label, mutate, message) => refuse(mutate, message));

  test('the shown texts are the lead fact (title and lead) and the species fact', () => {
    expect(factText('T03')).toContain('look at the waist and antennae');
    expect(speciesText('earwig')).toBe(SPECIES.find((s) => s.slug === 'earwig').fact);
    expect([factText('Z99'), speciesText('not-a-bug')]).toEqual([null, null]);
  });
});
