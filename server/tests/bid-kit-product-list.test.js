// Bid kit Product List sync (GATE_BID_KIT_PRODUCT_LIST_SYNC): the snapshot and fingerprint, the diff, the auto sign-off decision
// table, the PDF, and the run itself. The database, the store, the file storage and the bell service are stand-ins here (the SQL
// runs in bid-kit-product-list.db.test.js); every bell spec goes through the real notification rules. Synthetic products only.
const mockTables = { 'service_products as sp': [], service_products: [], products_catalog: [], purchase_receipt_lines: [] };
// Every query the job builds, with the builder calls it made, so a test can check what each one joined and filtered on.
const mockQueries = [];
jest.mock('../models/db', () => {
  const chain = (table) => {
    const calls = [];
    const node = new Proxy({}, {
      get: (_target, prop) => {
        if (prop === 'then') {
          return (resolve, reject) => {
            mockQueries.push({ table, calls });
            // The same table serves two queries: the one that joins the catalog is the linked one; the other is the unlinked lines.
            const linked = calls.some((c) => c.method === 'join' && String(c.args[0]).startsWith('products_catalog'));
            const key = table === 'service_products as sp' && !linked ? 'service_products' : table;
            return Promise.resolve(mockTables[key]).then(resolve, reject);
          };
        }
        return (...args) => { calls.push({ method: prop, args }); return node; };
      },
    });
    return node;
  };
  return Object.assign((table) => chain(table), { __db: true });
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/bid-kit-store', () => ({
  listItems: jest.fn(), fileInfo: jest.fn(), replaceFile: jest.fn(), logActivity: jest.fn(), updateItem: jest.fn(),
}));
jest.mock('../services/bid-kit-files', () => ({ putFile: jest.fn(), deleteFile: jest.fn() }));
jest.mock('../services/admin-alert-episodes', () => ({ raiseAdminAlertWithReopen: jest.fn(), openAdminAlertKeys: jest.fn(), closeAdminAlertKeys: jest.fn() }));

const { PDFDocument, PDFRawStream, PDFName, PDFDict, decodePDFRawStream } = require('pdf-lib');
const store = require('../services/bid-kit-store');
const files = require('../services/bid-kit-files');
const episodes = require('../services/admin-alert-episodes');
const lib = require('../services/bid-kit-product-list');
const pdf = require('../services/pdf/product-list-pdf');
const { validateFile } = jest.requireActual('../services/bid-kit-files');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const product = (n, over = {}) => ({
  product_id: ID(n), name: `Synthetic Product ${n}`, category: 'Insecticide', active_ingredient: `ingredient ${n}`,
  epa_reg_number: `100-${n}`, label_url: `https://labels.example.test/${n}.pdf`, sds_url: `https://sds.example.test/${n}.pdf`, uses: 3, ...over,
});
const snap = (rows) => rows.map(lib.snapshotOf);

describe('snapshot and fingerprint', () => {
  test('the fingerprint does not depend on row order and changes with any shown field', () => {
    const a = [product(1), product(2), product(3)];
    expect(lib.fingerprintOf(snap(a))).toBe(lib.fingerprintOf(snap([a[2], a[0], a[1]])));
    for (const over of [{ name: 'Renamed' }, { active_ingredient: 'other' }, { epa_reg_number: '100-99' }, { label_url: 'https://labels.example.test/new.pdf' }, { sds_url: null }]) {
      expect(lib.fingerprintOf(snap([a[0], { ...a[1], ...over }, a[2]]))).not.toBe(lib.fingerprintOf(snap(a)));
    }
  });
  test('a use count alone is not a change; whitespace is ignored', () => {
    const a = [product(1)];
    expect(lib.fingerprintOf(snap([{ ...a[0], uses: 99 }]))).toBe(lib.fingerprintOf(snap(a)));
    expect(lib.fingerprintOf(snap([{ ...a[0], name: ` ${a[0].name} ` }]))).toBe(lib.fingerprintOf(snap(a)));
  });
  test('the stored snapshot keeps hashes, never the label links themselves', () => {
    const s = lib.snapshotOf(product(1));
    expect(JSON.stringify(s)).not.toMatch(/example\.test/);
    expect(Object.keys(s).sort()).toEqual(['ai', 'cat', 'epa', 'id', 'label', 'name', 'sds']);
  });
});

describe('category is part of the snapshot (the completeness rule reads it)', () => {
  const fertilizer = product(1, { category: 'Fertilizer', epa_reg_number: 'N/A', label_url: null, sds_url: null });
  test('a category change changes the fingerprint, ignoring case and spacing', () => {
    expect(lib.fingerprintOf(snap([{ ...fertilizer, category: 'Insecticide' }]))).not.toBe(lib.fingerprintOf(snap([fertilizer])));
    expect(lib.fingerprintOf(snap([{ ...fertilizer, category: ' fertilizer ' }]))).toBe(lib.fingerprintOf(snap([fertilizer])));
  });
  test('the diff reports it as a change to the category, and it makes a list incomplete when a no-number product turns into a pesticide', () => {
    const turned = { ...fertilizer, category: 'Herbicide' };
    expect(lib.diffSnapshots(snap([fertilizer]), snap([turned])).changed).toEqual([{ id: ID(1), name: 'Synthetic Product 1', fields: ['cat'] }]);
    expect(lib.listIsComplete([fertilizer])).toBe(true);
    expect(lib.listIsComplete([turned])).toBe(false);
  });
  test('a snapshot stored before the category was part of it does not count as changed on that alone', () => {
    const { cat: _cat, ...old } = lib.snapshotOf(fertilizer);
    expect(lib.diffSnapshots([old], snap([fertilizer]))).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('visit lines recorded without a catalog product', () => {
  const cat = (n, over = {}) => ({ id: ID(n), name: `Synthetic Product ${n}`, category: 'Insecticide', active_ingredient: `ingredient ${n}`, epa_reg_number: `100-${n}`, label_url: 'https://l.example.test/x.pdf', sds_url: 'https://s.example.test/x.pdf', active: true, ...over });
  const linked = (n, uses = 3) => ({ ...product(n), uses: String(uses) });
  test('an exact name match (after the matcher normalizer) folds into the linked catalog row and counts its uses', () => {
    const { rows, unmatched } = lib.foldUnlinked([linked(1, 3)], [{ product_name: 'synthetic  PRODUCT-1', uses: '2' }], [cat(1)]);
    expect(unmatched).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product_id: ID(1), uses: 5 });
  });
  test('a match to a product with no linked lines creates its row from the catalog', () => {
    const { rows } = lib.foldUnlinked([], [{ product_name: 'Synthetic Product 7', uses: 1 }], [cat(7, { category: 'Herbicide' })]);
    expect(rows).toEqual([expect.objectContaining({ product_id: ID(7), name: 'Synthetic Product 7', category: 'Herbicide', epa_reg_number: '100-7', uses: 1 })]);
  });
  test('an inactive catalog row counts when it is the only exact match; an active one is preferred over it', () => {
    expect(lib.foldUnlinked([], [{ product_name: 'Synthetic Product 8', uses: 1 }], [cat(8, { active: false })]).rows.map((r) => r.product_id)).toEqual([ID(8)]);
    const both = [cat(8, { active: false }), cat(9, { name: 'Synthetic Product 8' })];
    expect(lib.foldUnlinked([], [{ product_name: 'Synthetic Product 8', uses: 1 }], both).rows.map((r) => r.product_id)).toEqual([ID(9)]);
  });
  test('two exact candidates or none stay unmatched, with their names and line counts', () => {
    const twin = [cat(1), cat(2, { name: 'Synthetic Product 1' })];
    const result = lib.foldUnlinked([linked(3)], [{ product_name: 'Synthetic Product 1', uses: 2 }, { product_name: 'Taurus SC', uses: 5 }, { product_name: 'taurus  sc', uses: 1 }, { product_name: '', uses: 1 }], twin);
    expect(result.rows.map((r) => r.product_id)).toEqual([ID(3)]);
    expect(result.unmatched.map((u) => [u.name, u.uses])).toEqual([['', 1], ['Synthetic Product 1', 2], ['Taurus SC', 6]]);
  });
  test('the detail sentence counts the lines and names each distinct name', () => {
    expect(lib.unmatchedSentence([{ name: 'Taurus SC', norm: 'taurus sc', uses: 6 }, { name: 'Bifen I/T', norm: 'bifen i t', uses: 3 }]))
      .toBe('9 visit lines recorded without a catalog product are not on the list: Taurus SC, Bifen I T.');
    expect(lib.unmatchedSentence([{ name: 'Taurus SC', norm: 'taurus sc', uses: 1 }])).toBe('1 visit line recorded without a catalog product is not on the list: Taurus SC.');
    expect(lib.unmatchedSentence([])).toBe('');
  });
  test('the set of unmatched names is part of the fingerprint; with none it is the same as before', () => {
    const rows = snap([product(1)]);
    const a = [{ name: 'Taurus SC', norm: 'taurus sc', uses: 1 }];
    expect(lib.fingerprintOf(rows, a)).not.toBe(lib.fingerprintOf(rows));
    expect(lib.fingerprintOf(rows, [...a, { name: 'Bifen I/T', norm: 'bifen i t', uses: 1 }])).not.toBe(lib.fingerprintOf(rows, a));
    expect(lib.fingerprintOf(rows, [{ name: 'TAURUS  sc', norm: 'taurus sc', uses: 9 }])).toBe(lib.fingerprintOf(rows, a));
    expect(lib.fingerprintOf(rows, [])).toBe(lib.fingerprintOf(rows));
  });
});

describe('diffSnapshots', () => {
  test('reports added, removed and changed products with the changed field names', () => {
    const before = snap([product(1), product(2), product(3)]);
    const after = snap([product(1), product(2, { sds_url: null, active_ingredient: 'new' }), product(4)]);
    const diff = lib.diffSnapshots(before, after);
    expect(diff.added.map((p) => p.id)).toEqual([ID(4)]);
    expect(diff.removed.map((p) => p.id)).toEqual([ID(3)]);
    expect(diff.changed).toEqual([{ id: ID(2), name: 'Synthetic Product 2', fields: ['ai', 'sds'] }]);
  });
  test('no difference is three empty lists', () => {
    const s = snap([product(1)]);
    expect(lib.diffSnapshots(s, s)).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('listIsComplete', () => {
  test('a registered row counts only with an EPA number in EPA format (a note like TBD is never complete)', () => {
    expect(lib.listIsComplete([product(1, { epa_reg_number: 'TBD' })])).toBe(false);
    expect(lib.listIsComplete([product(1, { epa_reg_number: 'See label' })])).toBe(false);
    expect(lib.listIsComplete([product(1, { epa_reg_number: '228-631-10404' })])).toBe(true);
    expect(lib.listIsComplete([product(1, { epa_reg_number: '5481-641-101563' })])).toBe(true);
  });
  test('a registered pesticide needs both links', () => {
    expect(lib.listIsComplete([product(1)])).toBe(true);
    expect(lib.listIsComplete([product(1, { label_url: '' })])).toBe(false);
    expect(lib.listIsComplete([product(1, { sds_url: null })])).toBe(false);
  });
  test('a pesticide category with the N/A placeholder or no number is incomplete; a fertilizer with N/A is fine', () => {
    expect(lib.listIsComplete([product(1, { epa_reg_number: 'N/A' })])).toBe(false);
    expect(lib.listIsComplete([product(1, { epa_reg_number: null, category: 'Termiticide' })])).toBe(false);
    expect(lib.listIsComplete([product(1, { epa_reg_number: 'N/A', category: 'Fertilizer', label_url: null, sds_url: null })])).toBe(true);
    expect(lib.listIsComplete([product(1, { epa_reg_number: 'None', category: null, label_url: null, sds_url: null })])).toBe(true);
  });
});

describe('the auto sign-off decision table', () => {
  const base = (n) => snap(Array.from({ length: n }, (_, i) => product(i + 1)));
  const run = ({ previous = 'ok', wasSignedOff = true, complete = true, before = base(2), after, bought = [] }) => {
    const diff = lib.diffSnapshots(before, after);
    return lib.decideSignOff({ previous, wasSignedOff, complete, diff, bought: new Set(bought) });
  };
  test('a SiteOne-only addition signs off', () => {
    expect(run({ after: [...base(2), lib.snapshotOf(product(3))], bought: [ID(3)] })).toMatchObject({ auto: true, reasons: [] });
  });
  test('an addition with no SiteOne purchase asks, and names the product', () => {
    const d = run({ after: [...base(2), lib.snapshotOf(product(3))] });
    expect(d).toMatchObject({ auto: false, reasons: ['not_siteone'] });
    expect(d.outside.map((p) => p.id)).toEqual([ID(3)]);
  });
  test('one SiteOne and one other addition asks', () => {
    const d = run({ after: [...base(2), lib.snapshotOf(product(3)), lib.snapshotOf(product(4))], bought: [ID(3)] });
    expect(d.auto).toBe(false);
    expect(d.outside.map((p) => p.id)).toEqual([ID(4)]);
  });
  test('a changed link on a SiteOne product signs off; on any other product it asks', () => {
    const after = [base(2)[0], lib.snapshotOf(product(2, { sds_url: 'https://sds.example.test/new.pdf' }))];
    expect(run({ after, bought: [ID(2)] }).auto).toBe(true);
    expect(run({ after }).auto).toBe(false);
  });
  test('an incomplete list asks even when every change is a SiteOne purchase', () => {
    expect(run({ complete: false, after: [...base(2), lib.snapshotOf(product(3))], bought: [ID(3)] })).toMatchObject({ auto: false, reasons: ['incomplete'] });
  });
  test('a removed-only change signs off', () => {
    expect(run({ after: base(1) })).toMatchObject({ auto: true, reasons: [] });
  });
  test('the first run and a file replaced by hand always ask', () => {
    expect(run({ previous: 'first_run', after: base(2) })).toMatchObject({ auto: false, reasons: ['first_run'] });
    expect(run({ previous: 'file_replaced', after: base(2) })).toMatchObject({ auto: false, reasons: ['file_replaced'] });
  });
  test('an earlier version nobody signed off is never signed off by a later SiteOne-only change', () => {
    expect(run({ wasSignedOff: false, after: [...base(2), lib.snapshotOf(product(3))], bought: [ID(3)] })).toMatchObject({ auto: false, reasons: ['unsigned_before'] });
  });
});

describe('the bell words', () => {
  const { composeAdminAlert } = require('../services/admin-alert-compose');
  test('a non-SiteOne addition is named in plain words, inside the notification rules', () => {
    const diff = { added: [{ id: ID(9), name: 'Gentrol Complete EC3' }], removed: [], changed: [] };
    const decision = { auto: false, reasons: ['not_siteone'], outside: diff.added };
    const { spec, detail } = lib.alertFor(ID(1), { diff, decision, previous: 'ok' });
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe('Estimates — check the product list and sign off');
    expect(composed.why).toBe('Added Gentrol Complete EC3 (not a SiteOne purchase); check and sign off.');
    expect(composed.link).toBe(`/admin/bids?tab=kit&item=${ID(1)}`);
    expect(detail).toMatch(/Added: Gentrol Complete EC3 \(not a SiteOne purchase\)\./);
  });
  test('a name the rules refuse falls back to a count, never loses the bell', () => {
    const diff = { added: [{ id: ID(9), name: 'Bad_Name 2026-10-25' }], removed: [], changed: [] };
    const { spec } = lib.alertFor(ID(1), { diff, decision: { auto: false, reasons: ['not_siteone'], outside: diff.added }, previous: 'ok' });
    expect(composeAdminAlert(spec).why).toBe('1 change to the list; check it and sign off.');
  });
  test('first run and a hand-replaced file have their own sentence', () => {
    const empty = { added: [], removed: [], changed: [] };
    const first = lib.alertFor(ID(1), { diff: empty, decision: { reasons: ['first_run'], outside: [] }, previous: 'first_run' });
    expect(composeAdminAlert(first.spec).why).toBe('The list now rebuilds itself; check this version once.');
    const replaced = lib.alertFor(ID(1), { diff: empty, decision: { reasons: ['file_replaced'], outside: [] }, previous: 'file_replaced' });
    expect(composeAdminAlert(replaced.spec).why).toBe('The file was replaced by hand; check the rebuilt list.');
  });
  test('many names stay inside the why limit', () => {
    const added = Array.from({ length: 8 }, (_, i) => ({ id: ID(i + 10), name: `Synthetic Long Product Name Number ${i}` }));
    const { spec } = lib.alertFor(ID(1), { diff: { added, removed: [], changed: [] }, decision: { reasons: ['not_siteone'], outside: added }, previous: 'ok' });
    expect(composeAdminAlert(spec).why.length).toBeLessThanOrEqual(110);
  });
});

describe('the PDF', () => {
  const textOf = (doc) => {
    let out = '';
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const data = Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
      for (const [, array] of data.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
        out += [...array.matchAll(/<([0-9a-f]+)>/gi)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
        out += '\n';
      }
    }
    return out;
  };
  const linksOf = (doc) => {
    const uris = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      const action = obj.lookup(PDFName.of('A'));
      if (action instanceof PDFDict && action.lookup(PDFName.of('URI'))) uris.push(action.lookup(PDFName.of('URI')).decodeText());
    }
    return uris;
  };
  const rows = [
    product(1, { name: 'Synthetic Insecticide One' }),
    product(2, { name: 'Synthetic Herbicide Two', sds_url: null }),
    product(3, { name: 'Synthetic Fertilizer Three', category: 'Fertilizer', epa_reg_number: 'N/A', label_url: null, sds_url: null, active_ingredient: 'nitrogen' }),
  ];
  const build = (list) => pdf.buildProductListPdf({ rows: list, asOf: '2026-10-25', businessName: 'Waves Pest Control, LLC', licenseNumber: 'JB351547' });

  test('renders a PDF the kit accepts, with the heading, the intro line and both table titles', async () => {
    const buffer = await build(rows);
    expect(() => validateFile({ buffer, originalname: pdf.fileNameFor('2026-10-25'), mimetype: 'application/pdf', size: buffer.length })).not.toThrow();
    const doc = await PDFDocument.load(buffer);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    const text = textOf(doc);
    expect(text).toContain('Product List');
    expect(text).toContain('Waves Pest Control, LLC · FDACS license JB351547 · Products applied in the 12 months to October 25, 2026 (ET).');
    expect(text).toContain('Every pesticide is EPA-registered and used according to its label.');
    expect(text).toContain('Registered pesticides (2)');
    expect(text).toContain('Fertilizers, adjuvants and other products (1)');
    expect(text).toContain('Synthetic Fertilizer Three');
    expect(text).toContain('100-1');
  });
  test('links the Label and SDS words; a missing SDS on a pesticide is bold missing, on a fertilizer n/a', async () => {
    const doc = await PDFDocument.load(await build(rows));
    const links = linksOf(doc);
    expect(links).toEqual(expect.arrayContaining(['https://labels.example.test/1.pdf', 'https://sds.example.test/1.pdf', 'https://labels.example.test/2.pdf']));
    expect(links).not.toContain('https://sds.example.test/2.pdf');
    expect(links).toHaveLength(3);
    const text = textOf(doc);
    expect(text).toContain('missing');
    expect(text).toContain('n/a');
  });
  test('a long list breaks across pages and repeats the table header', async () => {
    const many = Array.from({ length: 120 }, (_, i) => product(i + 1, { name: `Synthetic Product With A Fairly Long Name Number ${i + 1}`, active_ingredient: 'a fairly long active ingredient name that wraps' }));
    const doc = await PDFDocument.load(await build(many));
    expect(doc.getPageCount()).toBeGreaterThan(2);
    expect((textOf(doc).match(/Active ingredient/g) || []).length).toBeGreaterThanOrEqual(doc.getPageCount() - 1);
  });
  test('an empty second table says so', async () => {
    const text = textOf(await PDFDocument.load(await build([rows[0]])));
    expect(text).toContain('Fertilizers, adjuvants and other products (0)');
    expect(text).toContain('None in this period.');
  });
  test('link cell wording', () => {
    expect(pdf.linkCell('https://x.example.test/a.pdf', 'Label', true)).toMatchObject({ text: 'Label', link: 'https://x.example.test/a.pdf' });
    expect(pdf.linkCell('  ', 'SDS', true)).toMatchObject({ text: 'missing', bold: true, link: null });
    expect(pdf.linkCell(null, 'SDS', false)).toMatchObject({ text: 'n/a', bold: false, link: null });
    expect(pdf.longDay('2026-01-05')).toBe('January 5, 2026');
    expect(pdf.fileNameFor('2026-10-25')).toBe('product-list-2026-10-25.pdf');
  });
  test('rows are sorted by category with empty last, then name', () => {
    const sorted = lib.sortRows([product(1, { category: null, name: 'A' }), product(2, { category: 'Herbicide', name: 'B' }), product(3, { category: 'Fertilizer', name: 'Z' }), product(4, { category: 'Herbicide', name: 'A' })]);
    expect(sorted.map((r) => r.name)).toEqual(['Z', 'A', 'B', 'A']);
    expect(sorted.map((r) => r.category)).toEqual(['Fertilizer', 'Herbicide', 'Herbicide', null]);
  });
});

describe('runBidKitProductListSync', () => {
  const ITEM = ID(500);
  const KEY = 'bid-kit/item/old.pdf';
  const NEW_KEY = 'bid-kit/item/new.pdf';
  const NOW = new Date('2026-10-26T10:05:00Z');
  const refOf = (key) => require('node:crypto').createHash('sha256').update(key).digest('hex').slice(0, 16);
  const rowsBefore = [product(1), product(2)];
  const itemRow = (over = {}) => ({
    id: ITEM, kind: 'document', item_key: 'product_list', updated_at: new Date('2026-10-25T12:00:00Z'), attested_at: new Date('2026-10-25T12:00:00Z'),
    details: { product_list_sync: { fingerprint: lib.fingerprintOf(snap(rowsBefore)), file_ref: refOf(KEY), rows: snap(rowsBefore) } }, ...over,
  });
  let run;
  let live;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_BID_KIT = 'true';
    process.env.GATE_BID_KIT_PRODUCT_LIST_SYNC = 'true';
    live = { rows: [...rowsBefore], bought: [] };
    mockTables['service_products as sp'] = live.rows;
    mockTables.purchase_receipt_lines = [];
    mockTables.service_products = [];
    mockTables.products_catalog = [];
    store.listItems.mockResolvedValue([itemRow()]);
    store.fileInfo.mockResolvedValue({ key: KEY });
    store.replaceFile.mockResolvedValue({ item: itemRow(), oldKey: KEY });
    store.logActivity.mockResolvedValue();
    // The fenced update, run against the listed row; the row it returns carries a later version.
    store.updateItem.mockImplementation(async (id, compute) => {
      const row = (await store.listItems())[0];
      const decision = compute(row);
      const details = decision.patch.details ? JSON.parse(decision.patch.details) : row.details;
      return { item: { ...row, details, updated_at: new Date('2026-10-26T12:00:00Z') }, before: row };
    });
    files.putFile.mockImplementation(async (id, file) => ({ key: NEW_KEY, fileName: file.originalname, contentType: 'application/pdf', size: file.size }));
    files.deleteFile.mockResolvedValue();
    episodes.openAdminAlertKeys.mockResolvedValue([]);
    episodes.closeAdminAlertKeys.mockResolvedValue(1);
    episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n1', rang: true });
    run = () => lib.runBidKitProductListSync({ now: NOW });
  });
  afterEach(() => { delete process.env.GATE_BID_KIT; delete process.env.GATE_BID_KIT_PRODUCT_LIST_SYNC; });
  const setList = (rows, purchased = []) => { mockTables['service_products as sp'] = rows; mockTables.purchase_receipt_lines = purchased.map((n) => ({ product_id: ID(n) })); };

  test('either gate off = nothing is read', async () => {
    delete process.env.GATE_BID_KIT_PRODUCT_LIST_SYNC;
    expect(await run()).toEqual({ skipped: 'gate_off' });
    process.env.GATE_BID_KIT_PRODUCT_LIST_SYNC = 'true';
    delete process.env.GATE_BID_KIT;
    expect(await run()).toEqual({ skipped: 'gate_off' });
    expect(store.listItems).not.toHaveBeenCalled();
  });
  test('no product list item on the kit = nothing is built', async () => {
    store.listItems.mockResolvedValue([]);
    expect(await run()).toEqual({ skipped: 'no_item' });
    expect(files.putFile).not.toHaveBeenCalled();
  });
  test('the same list as last time writes nothing and rings nothing', async () => {
    expect(await run()).toEqual({ changed: false });
    expect(files.putFile).not.toHaveBeenCalled();
    expect(store.replaceFile).not.toHaveBeenCalled();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
  });
  test('an empty list leaves the file alone', async () => {
    setList([]);
    expect(await run()).toEqual({ skipped: 'no_products' });
    expect(files.putFile).not.toHaveBeenCalled();
  });
  test('first run: replaces the file, does not sign it off, one bell', async () => {
    store.listItems.mockResolvedValue([itemRow({ details: null })]);
    const result = await run();
    expect(result).toMatchObject({ changed: true, signedOff: false, reasons: ['first_run'] });
    const [, stored, version, options] = store.replaceFile.mock.calls[0];
    expect(stored.key).toBe(NEW_KEY);
    expect(version).toEqual(new Date('2026-10-25T12:00:00Z'));
    expect(options.attestBySystem).toBe(false);
    expect(options.details.product_list_sync).toMatchObject({ file_ref: refOf(NEW_KEY), built_at: NOW.toISOString() });
    expect(options.details.product_list_sync.rows).toHaveLength(2);
    expect(files.putFile.mock.calls[0][1]).toMatchObject({ originalname: 'product-list-2026-10-26.pdf', mimetype: 'application/pdf' });
    expect(files.deleteFile).toHaveBeenCalledWith(KEY);
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect(category).toBe('system');
    expect(headline).toBe('Estimates — check the product list and sign off');
    expect(why).toBe('The list now rebuilds itself; check this version once.');
    expect(opts).toMatchObject({ bell: true, dedupeKey: `bid-kit:product-list:${ITEM}`, refreshOnDedupe: true, link: `/admin/bids?tab=kit&item=${ITEM}` });
    expect(store.logActivity.mock.calls.map((c) => c[1])).toEqual(['bid_kit_file_uploaded']);
  });
  test('a SiteOne-only addition replaces the file and signs it off as the system, logged as automatic, with no bell', async () => {
    setList([...rowsBefore, product(3)], [3]);
    const result = await run();
    expect(result).toEqual({ changed: true, signedOff: true, rang: false });
    expect(store.replaceFile.mock.calls[0][3].attestBySystem).toBe(true);
    const attested = store.logActivity.mock.calls.find((c) => c[1] === 'bid_kit_attested');
    expect(attested[0]).toBeNull();
    expect(attested[3]).toMatchObject({ bid_kit_item_id: ITEM, auto: 'siteone_purchases', added: ['Synthetic Product 3'] });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`bid-kit:product-list:${ITEM}`], 'signed_off', expect.any(Object));
  });
  test('an addition with no SiteOne purchase replaces the file, leaves it unsigned and names the product in one bell', async () => {
    setList([...rowsBefore, product(3, { name: 'Gentrol Complete EC3' })], []);
    const result = await run();
    expect(result).toMatchObject({ changed: true, signedOff: false, reasons: ['not_siteone'] });
    expect(store.replaceFile.mock.calls[0][3].attestBySystem).toBe(false);
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[0][2]).toBe('Added Gentrol Complete EC3 (not a SiteOne purchase); check and sign off.');
    expect(store.logActivity.mock.calls.some((c) => c[1] === 'bid_kit_attested')).toBe(false);
  });
  test('an incomplete list asks even when the new product is a SiteOne purchase', async () => {
    setList([...rowsBefore, product(3, { sds_url: null })], [3]);
    const result = await run();
    expect(result).toMatchObject({ signedOff: false, reasons: ['incomplete'] });
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[0][2]).toMatch(/missing its EPA number, label or SDS/);
  });
  test('a removed-only change signs off', async () => {
    setList([rowsBefore[0]]);
    expect(await run()).toMatchObject({ changed: true, signedOff: true });
  });
  test('a version nobody signed off stays unsigned, and its bell is rewritten rather than stacked', async () => {
    store.listItems.mockResolvedValue([itemRow({ attested_at: null })]);
    setList([...rowsBefore, product(3)], [3]);
    expect(await run()).toMatchObject({ signedOff: false, reasons: ['unsigned_before'] });
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[0][3].dedupeKey).toBe(`bid-kit:product-list:${ITEM}`);
  });
  test('a file replaced by hand since the last rebuild asks, whatever changed', async () => {
    store.fileInfo.mockResolvedValue({ key: 'bid-kit/item/by-hand.pdf' });
    setList([...rowsBefore, product(3)], [3]);
    expect(await run()).toMatchObject({ signedOff: false, reasons: ['file_replaced'] });
  });
  test('a row the owner changed since it was read is skipped: the new file is removed and nothing rings', async () => {
    setList([...rowsBefore, product(3)], [3]);
    store.replaceFile.mockResolvedValue({ conflict: true });
    expect(await run()).toEqual({ skipped: 'conflict' });
    expect(files.deleteFile).toHaveBeenCalledWith(NEW_KEY);
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(store.logActivity).not.toHaveBeenCalled();
  });
  test('a failed write that rolled back removes the new file; an unknown commit keeps it', async () => {
    setList([...rowsBefore, product(3)], [3]);
    store.replaceFile.mockRejectedValueOnce(Object.assign(new Error('x'), { bidKitOutcome: 'rolled_back' }));
    expect(await run()).toEqual({ failed: true });
    expect(files.deleteFile).toHaveBeenCalledWith(NEW_KEY);
    files.deleteFile.mockClear();
    store.replaceFile.mockRejectedValueOnce(Object.assign(new Error('x'), { bidKitOutcome: 'unknown' }));
    expect(await run()).toEqual({ failed: true });
    expect(files.deleteFile).not.toHaveBeenCalled();
  });
  const withPending = (over = {}) => itemRow({
    attested_at: null,
    details: { product_list_sync: { ...itemRow().details.product_list_sync, pending_alert: { why: 'Added Gentrol Complete EC3 (not a SiteOne purchase); check and sign off.', detail: 'Product list: Added: Gentrol Complete EC3 (not a SiteOne purchase). Check the product list and sign off.' } } }, ...over,
  });

  test('an unchanged list whose file was replaced by hand is rebuilt and flagged once, never auto signed off', async () => {
    store.fileInfo.mockResolvedValue({ key: 'bid-kit/item/by-hand.pdf' });
    expect(await run()).toMatchObject({ changed: true, signedOff: false, reasons: ['file_replaced'] });
    expect(files.putFile).toHaveBeenCalledTimes(1);
    const options = store.replaceFile.mock.calls[0][3];
    expect(options.attestBySystem).toBe(false);
    expect(options.details.product_list_sync.file_ref).toBe(refOf(NEW_KEY));
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[0][2]).toBe('The file was replaced by hand; check the rebuilt list.');
    // The next day the refs match again: nothing.
    store.listItems.mockResolvedValue([itemRow({ details: { product_list_sync: options.details.product_list_sync } })]);
    store.fileInfo.mockResolvedValue({ key: NEW_KEY });
    jest.clearAllMocks();
    expect(await run()).toEqual({ changed: false });
    expect(files.putFile).not.toHaveBeenCalled();
  });
  test('a row with no file at all counts as replaced', async () => {
    store.fileInfo.mockResolvedValue({ key: null });
    expect(await run()).toMatchObject({ changed: true, reasons: ['file_replaced'] });
  });
  test('when the owner is to be asked, the bell words are saved in the same update as the file; an automatic sign-off saves none', async () => {
    setList([...rowsBefore, product(3, { name: 'Gentrol Complete EC3' })], []);
    await run();
    expect(store.replaceFile.mock.calls[0][3].details.product_list_sync.pending_alert).toEqual({
      why: 'Added Gentrol Complete EC3 (not a SiteOne purchase); check and sign off.',
      detail: expect.stringContaining('Gentrol Complete EC3 (not a SiteOne purchase)'),
    });
    store.replaceFile.mockClear();
    setList([...rowsBefore, product(3)], [3]);
    await run();
    expect(store.replaceFile.mock.calls[0][3].details.product_list_sync).not.toHaveProperty('pending_alert');
  });
  test('after the bell is raised, the saved words are cleared by a fenced update that leaves the rest and the sign-off alone', async () => {
    setList([...rowsBefore, product(3, { name: 'Gentrol Complete EC3' })], []);
    const synced = lib.fingerprintOf(snap([...rowsBefore, product(3, { name: 'Gentrol Complete EC3' })]));
    store.listItems.mockResolvedValue([withPending({ details: { product_list_sync: { fingerprint: synced, file_ref: refOf(NEW_KEY), rows: [], pending_alert: { why: 'x', detail: 'y' } } } })]);
    await run();
    // A different stored list is never cleared by this update; this list's words go and every other key stays.
    const compute = store.updateItem.mock.calls[0][1];
    expect(compute({ details: { product_list_sync: { fingerprint: 'F', pending_alert: { why: 'a', detail: 'b' } } } })).toEqual({ patch: {} });
    const ours = compute({ details: { other: 1, product_list_sync: { fingerprint: synced, rows: [1], pending_alert: { why: 'a', detail: 'b' } } } });
    expect(Object.keys(ours.patch)).toEqual(['details']);
    expect(JSON.parse(ours.patch.details)).toEqual({ other: 1, product_list_sync: { fingerprint: synced, rows: [1] } });
  });
  test('a bell that failed to raise keeps its words on the row; the next run raises it before the unchanged return, then clears it', async () => {
    setList([...rowsBefore, product(3, { name: 'Gentrol Complete EC3' })], []);
    episodes.raiseAdminAlertWithReopen.mockRejectedValueOnce(new Error('bell down'));
    expect(await run()).toEqual({ failed: true });
    const saved = store.replaceFile.mock.calls[0][3].details.product_list_sync;
    expect(saved.pending_alert).toBeDefined();
    expect(store.updateItem).not.toHaveBeenCalled();
    // Next day: the list is the same as the fingerprint stored, the file is ours, the words are still there.
    jest.clearAllMocks();
    store.listItems.mockResolvedValue([itemRow({ attested_at: null, details: { product_list_sync: saved } })]);
    store.fileInfo.mockResolvedValue({ key: NEW_KEY });
    store.updateItem.mockImplementation(async (id, compute) => ({ item: { ...itemRow({ attested_at: null }), details: { product_list_sync: { ...saved, pending_alert: undefined } }, updated_at: new Date('2026-10-27T12:00:00Z') }, before: compute({ details: { product_list_sync: saved } }) }));
    episodes.openAdminAlertKeys.mockResolvedValue([]);
    episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: 'n1', rang: true });
    expect(await run()).toEqual({ changed: false });
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    const [, headline, why, opts] = episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect(headline).toBe('Estimates — check the product list and sign off');
    expect(why).toBe(saved.pending_alert.why);
    expect(opts).toMatchObject({ dedupeKey: `bid-kit:product-list:${ITEM}`, dedupeVersion: saved.fingerprint, detail: saved.pending_alert.detail });
    expect(store.updateItem).toHaveBeenCalledTimes(1);
  });
  test('a failed retry is logged and never blocks the rest of the run; the words stay for the next day', async () => {
    store.listItems.mockResolvedValue([withPending()]);
    episodes.raiseAdminAlertWithReopen.mockRejectedValue(new Error('bell down'));
    expect(await run()).toEqual({ changed: false });
    expect(store.updateItem).not.toHaveBeenCalled();
  });
  test('words saved for an item the owner has since signed off are cleared without a bell', async () => {
    store.listItems.mockResolvedValue([withPending({ attested_at: new Date('2026-10-26T01:00:00Z') })]);
    expect(await run()).toEqual({ changed: false });
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(store.updateItem).toHaveBeenCalledTimes(1);
  });
  test('after a retry the rebuild in the same run uses the version the clearing update produced', async () => {
    store.listItems.mockResolvedValue([withPending()]);
    setList([...rowsBefore, product(3)], [3]);
    await run();
    // The saved bell is raised first, then the rebuild's own (the new list is a SiteOne add on a version nobody signed off): same key.
    expect(episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(2);
    expect(new Set(episodes.raiseAdminAlertWithReopen.mock.calls.map((c) => c[3].dedupeKey)).size).toBe(1);
    expect(store.replaceFile.mock.calls[0][2]).toEqual(new Date('2026-10-26T12:00:00Z'));
  });
  test('unmatched visit lines never block the automatic sign-off, and are counted in the result and the log', async () => {
    setList([...rowsBefore, product(3)], [3]);
    mockTables.service_products = [{ product_name: 'Taurus SC', uses: '5' }, { product_name: 'Bifen I/T', uses: '3' }];
    mockTables.products_catalog = [];
    // The stored fingerprint was made without them, so the unmatched set alone already changes the list.
    const result = await run();
    expect(result).toEqual({ changed: true, signedOff: true, rang: false, unmatched: { lines: 8, names: ['Bifen I/T', 'Taurus SC'] } });
    expect(store.logActivity.mock.calls[0][3]).toMatchObject({ unmatched: { lines: 8 } });
    expect(require('../services/logger').info.mock.calls.flat().join(' ')).toMatch(/unmatchedLines=8 unmatchedNames=2/);
  });
  test('a change in the unmatched set alone rebuilds the list; the same set again does nothing', async () => {
    mockTables.service_products = [{ product_name: 'Taurus SC', uses: 5 }];
    const first = await run();
    expect(first).toMatchObject({ changed: true });
    const synced = store.replaceFile.mock.calls[0][3].details.product_list_sync;
    store.listItems.mockResolvedValue([itemRow({ details: { product_list_sync: synced } })]);
    store.fileInfo.mockResolvedValue({ key: NEW_KEY });
    jest.clearAllMocks();
    expect(await run()).toEqual({ changed: false });
    mockTables.service_products = [{ product_name: 'Taurus SC', uses: 5 }, { product_name: 'Cyzmic CS', uses: 2 }];
    expect(await run()).toMatchObject({ changed: true });
  });
  test('a bell that is raised names the unmatched lines in its detail, also on the first run and for a hand-replaced file', async () => {
    mockTables.service_products = [{ product_name: 'Taurus SC', uses: '5' }];
    setList([...rowsBefore, product(3)], []);
    await run();
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[0][3].detail).toMatch(/5 visit lines recorded without a catalog product are not on the list: Taurus SC\./);
    expect(store.replaceFile.mock.calls[0][3].details.product_list_sync.pending_alert.detail).toMatch(/not on the list: Taurus SC\./);
    jest.clearAllMocks();
    store.listItems.mockResolvedValue([itemRow({ details: null })]);
    store.fileInfo.mockResolvedValue({ key: KEY });
    await run();
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[0][3].detail).toMatch(/not on the list: Taurus SC\./);
    jest.clearAllMocks();
    store.listItems.mockResolvedValue([itemRow()]);
    store.fileInfo.mockResolvedValue({ key: 'bid-kit/item/by-hand.pdf' });
    await run();
    expect(episodes.raiseAdminAlertWithReopen.mock.calls[0][3].detail).toMatch(/not on the list: Taurus SC\./);
  });
  test('a category change on an unchanged product rebuilds the list and is reported', async () => {
    setList([rowsBefore[0], { ...rowsBefore[1], category: 'Herbicide' }]);
    expect(await run()).toMatchObject({ changed: true });
  });
  test('both product queries count the 12 months on the visit date of the service record, never on when the line was written', async () => {
    mockQueries.length = 0;
    mockTables.service_products = [{ product_name: 'Taurus SC', uses: 1 }];
    await run();
    const lines = mockQueries.filter((q) => q.table === 'service_products as sp');
    expect(lines).toHaveLength(2);
    for (const query of lines) {
      expect(query.calls.some((c) => c.method === 'join' && c.args[0] === 'service_records as sr' && c.args[1] === 'sr.id' && c.args[2] === 'sp.service_record_id')).toBe(true);
      const filter = query.calls.find((c) => c.method === 'whereRaw').args[0];
      expect(filter).toMatch(/sr\.service_date > \(\(now\(\) AT TIME ZONE 'America\/New_York'\)::date - 365\)/);
      expect(filter).not.toMatch(/created_at|applied_at/);
    }
  });
  test('a sign-off by the owner closes the open bell on the next run', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue([`bid-kit:product-list:${ITEM}`]);
    expect(await run()).toEqual({ changed: false });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`bid-kit:product-list:${ITEM}`], 'signed_off', expect.any(Object));
  });
  test('an archived product list item: its open bell is closed and nothing is built', async () => {
    store.listItems.mockResolvedValue([]);
    episodes.openAdminAlertKeys.mockResolvedValue([`bid-kit:product-list:${ID(499)}`]);
    expect(await run()).toEqual({ skipped: 'no_item' });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`bid-kit:product-list:${ID(499)}`], 'archived', expect.any(Object));
    expect(files.putFile).not.toHaveBeenCalled();
  });
  test('the bell of an older, archived item is closed; the live item keeps its own', async () => {
    store.listItems.mockResolvedValue([itemRow({ attested_at: null })]);
    episodes.openAdminAlertKeys.mockResolvedValue([`bid-kit:product-list:${ID(499)}`, `bid-kit:product-list:${ITEM}`]);
    expect(await run()).toEqual({ changed: false });
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
    expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`bid-kit:product-list:${ID(499)}`], 'archived', expect.any(Object));
  });
  test('a failed stale-bell read never blocks the run', async () => {
    episodes.openAdminAlertKeys.mockRejectedValueOnce(new Error('read failed'));
    expect(await run()).toEqual({ changed: false });
  });
});
