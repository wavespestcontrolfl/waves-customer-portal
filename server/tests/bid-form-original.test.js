const { PDFDocument, PDFPage, PDFName, PDFNumber, PDFString, degrees } = require('pdf-lib');
describe('bid form original integrity beyond the content streams', () => {
  const form = require('../services/pdf/bid-form-original');
  const build = async (sourcePdf) => form.assertOriginalBidForm(await PDFDocument.load(sourcePdf), 'north_port_pr27_02', 1);
  const blankPage = async (mutate = async () => {}) => {
    const pdf = await PDFDocument.create(); const page = pdf.addPage([612, 792]);
    page.drawText('Synthetic approved-content stand-in');
    await mutate(pdf, page);
    return Buffer.from(await pdf.save());
  };
  // Treat a synthetic packet as the reviewed original by recording ITS
  // fingerprints, exactly as the reviewer script would for a real one.
  const original = form.FORM_PAGE_FINGERPRINTS.north_port_pr27_02;
  const approve = async (sourcePdf) => {
    const doc = await PDFDocument.load(sourcePdf);
    form.FORM_PAGE_FINGERPRINTS.north_port_pr27_02 = { ...form.pageFingerprint(doc, doc.getPage(0)), packet: form.packetFingerprint(doc, 0) };
  };
  afterEach(() => { form.FORM_PAGE_FINGERPRINTS.north_port_pr27_02 = original; });
  test.each(['Filter', 'DecodeParms'])('page stream %s changes are pinned even with identical bytes', async (key) => {
    const sourcePdf = await blankPage(); await approve(sourcePdf);
    const doc = await PDFDocument.load(sourcePdf); const page = doc.getPage(0);
    const stream = doc.context.lookup(page.node.Contents().asArray()[0]);
    stream.dict.set(PDFName.of(key), key === 'Filter' ? PDFName.of('ASCIIHexDecode') : doc.context.obj({ Predictor: 12 }));
    expect(() => form.assertOriginalBidForm(doc, 'north_port_pr27_02', 1)).toThrow(/does not match/);
  });
  test('referenced Helvetica resources cannot be replaced without invalidating the original', async () => {
    const sourcePdf = await blankPage(); await approve(sourcePdf);
    const doc = await PDFDocument.load(sourcePdf);
    const fonts = doc.getPage(0).node.Resources().lookup(PDFName.of('Font'));
    const [name, reference] = fonts.entries()[0];
    expect(name.toString()).toMatch(/^\/Helvetica-\d+$/);
    doc.context.lookup(reference).set(PDFName.of('BaseFont'), PDFName.of('Courier-Bold'));
    expect(() => form.assertOriginalBidForm(doc, 'north_port_pr27_02', 1)).toThrow(/does not match/);
  });
  test('the reviewer script fingerprint is stable across reloads and includes resources', async () => {
    const sourcePdf = await blankPage();
    const a = await PDFDocument.load(sourcePdf); const b = await PDFDocument.load(sourcePdf);
    expect(form.pageFingerprint(a, a.getPage(0))).toEqual(form.pageFingerprint(b, b.getPage(0)));
    expect(form.pageFingerprint(a, a.getPage(0)).resources).toMatch(/^[0-9a-f]{64}$/);
  });
  test.each([
    ['original', [0, 0, 612, 792], [0, 0, 612, 792], true],
    ['clipped price column', [0, 0, 612, 792], [0, 0, 300, 792], false],
    ['shifted media origin', [20, 0, 612, 792], [0, 0, 612, 792], false],
    ['shifted crop origin', [0, 0, 612, 792], [20, 0, 612, 792], false],
  ])('%s page is accepted only with the reviewed visible layout', async (name, media, crop, accepted) => {
    // The reviewed original carries the same explicit box entries; a
    // packet's dictionary keys are pinned as written, not by their effect.
    await approve(await blankPage(async (pdf, page) => { page.setMediaBox(0, 0, 612, 792); page.setCropBox(0, 0, 612, 792); }));
    const sourcePdf = await blankPage(async (pdf, page) => { page.setMediaBox(...media); page.setCropBox(...crop); });
    if (accepted) await expect(build(sourcePdf)).resolves.toBeInstanceOf(PDFPage);
    else await expect(build(sourcePdf)).rejects.toThrow(/does not match/);
  });
  test('a selected page scaled with /UserUnit is refused (GH codex P2 r7 on #4270)', async () => {
    await approve(await blankPage());
    await expect(build(await blankPage(async (pdf, page) => page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))))).rejects.toThrow(/does not match/);
    const unit = (value) => blankPage(async (pdf, page) => page.node.set(PDFName.of('UserUnit'), PDFNumber.of(value)));
    await approve(await unit(1));
    await expect(build(await unit(1))).resolves.toBeInstanceOf(PDFPage);
    await expect(build(await unit(2))).rejects.toThrow(/does not match/);
  });
  test('a selected page whose trim box or other dictionary state changed is refused (GH codex P2 r8 on #4270)', async () => {
    await approve(await blankPage());
    await expect(build(await blankPage(async (pdf, page) => page.node.set(PDFName.of('TrimBox'), pdf.context.obj([20, 20, 300, 400]))))).rejects.toThrow(/other pages of this PDF differ/);
    await expect(build(await blankPage(async (pdf, page) => page.node.set(PDFName.of('Trans'), pdf.context.obj({ S: 'Fade' }))))).rejects.toThrow(/other pages of this PDF differ/);
  });
  test('a page carrying annotations or widgets is refused before fingerprinting', async () => {
    await approve(await blankPage());
    const sourcePdf = await blankPage(async (pdf, page) => { pdf.getForm().createTextField('bidder').addToPage(page, { x: 50, y: 50, width: 200, height: 20 }); });
    await expect(build(sourcePdf)).rejects.toThrow(/annotations or form fields/);
  });
  const packet = (text, { flatten = false, extraPage = false, mutateOther = () => {} } = {}) => blankPage(async (pdf) => {
    const other = pdf.addPage([612, 792]);
    other.drawText('Bidder attestation page');
    const field = pdf.getForm().createTextField('company');
    field.addToPage(other, { x: 50, y: 50, width: 200, height: 20 });
    if (text) field.setText(text);
    if (flatten) pdf.getForm().flatten();
    if (extraPage) pdf.addPage([612, 792]);
    mutateOther(other, field, pdf);
  });
  test('default form resources are pinned even for blank fields', async () => {
    const sourcePdf = await packet(null); await approve(sourcePdf);
    const doc = await PDFDocument.load(sourcePdf);
    doc.catalog.lookup(PDFName.of('AcroForm')).set(PDFName.of('DR'), doc.context.obj({ Font: { Changed: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier' } } }));
    expect(() => form.assertOriginalBidForm(doc, 'north_port_pr27_02', 1)).toThrow(/other pages of this PDF differ/);
  });
  test('page-label prefixes are not confused with widget page references', async () => {
    const sourcePdf = await blankPage(async (pdf) => {
      pdf.catalog.set(PDFName.of('PageLabels'), pdf.context.obj({ Nums: [0, { P: PDFString.of('Original') }] }));
    });
    await approve(sourcePdf);
    const doc = await PDFDocument.load(sourcePdf);
    doc.catalog.lookup(PDFName.of('PageLabels')).lookup(PDFName.of('Nums')).lookup(1).set(PDFName.of('P'), PDFString.of('Changed'));
    expect(() => form.assertOriginalBidForm(doc, 'north_port_pr27_02', 1)).toThrow(/other pages of this PDF differ/);
  });
  test('XFA content is refused before getForm can silently remove it', async () => {
    const sourcePdf = await packet(null); await approve(sourcePdf);
    const doc = await PDFDocument.load(sourcePdf);
    const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
    acroForm.set(PDFName.of('XFA'), PDFString.of('<xfa>changed form</xfa>'));
    expect(() => form.assertOriginalBidForm(doc, 'north_port_pr27_02', 1)).toThrow(/XFA/);
    expect(acroForm.get(PDFName.of('XFA'))).toBeDefined();
  });
  test('field reparenting and inherited values are pinned', async () => {
    const sourcePdf = await packet(null); await approve(sourcePdf);
    const doc = await PDFDocument.load(sourcePdf);
    const before = form.packetFingerprint(doc, 0);
    const field = doc.getForm().getTextField('company');
    const parent = doc.context.obj({ V: PDFString.of('Inherited bidder') });
    field.acroField.dict.set(PDFName.of('Parent'), doc.context.register(parent));
    expect(field.getText()).toBe('Inherited bidder');
    expect(form.packetFingerprint(doc, 0)).not.toBe(before);
    expect(() => form.assertOriginalBidForm(doc, 'north_port_pr27_02', 1)).toThrow(/already filled in/);
  });
  test('blank fields elsewhere in the packet are allowed; filled ones are refused', async () => {
    await approve(await packet(null));
    await expect(build(await packet(null))).resolves.toBeInstanceOf(PDFPage);
    await expect(build(await packet('Previously filled bidder'))).rejects.toThrow(/already filled in/);
  });
  test('a packet whose other pages were filled and flattened, or re-paged, is refused (GH codex P2 r3 on #4270)', async () => {
    await approve(await packet(null));
    // Flattening leaves no field value to inspect: the entry is baked into
    // the other page's content stream and its widget is gone.
    const flattened = await PDFDocument.load(await packet('Previously filled bidder', { flatten: true }));
    expect(flattened.getForm().getFields().some((field) => field.acroField.dict.get(PDFName.of('V')) != null)).toBe(false);
    await expect(build(await packet('Previously filled bidder', { flatten: true }))).rejects.toThrow(/other pages of this PDF differ/);
    await expect(build(await packet(null, { extraPage: true }))).rejects.toThrow(/other pages of this PDF differ/);
    await expect(build(await blankPage())).rejects.toThrow(/other pages of this PDF differ/);
  });
  test.each([
    ['cropped', (other) => other.setCropBox(0, 0, 300, 792)],
    ['rotated', (other) => other.setRotation(degrees(90))],
    ['widget moved without a value', (other, field) => { field.acroField.getWidgets()[0].setRectangle({ x: 60, y: 50, width: 200, height: 20 }); }],
    // `/UserUnit` doubles the printed size while every hashed box stays
    // identical (GH codex P2 r7 on #4270).
    ['scaled (/UserUnit 2)', (other) => other.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))],
  ])('a %s attestation page elsewhere in the packet is refused (GH codex P2 r4 on #4270)', async (name, mutateOther) => {
    await approve(await packet(null));
    await expect(build(await packet(null, { mutateOther }))).rejects.toThrow(/other pages of this PDF differ/);
  });
  const signatureField = (pdf, page, value) => {
    const dict = pdf.context.obj({ FT: 'Sig', T: PDFString.of('Signature1'), Type: 'Annot', Subtype: 'Widget', Rect: [300, 50, 500, 80], F: 4 });
    if (value) dict.set(PDFName.of('V'), pdf.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite' }));
    const ref = pdf.context.register(dict);
    dict.set(PDFName.of('P'), page.ref);
    page.node.addAnnot(ref);
    pdf.getForm().acroForm.addField(ref);
    pdf.getForm().acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(1));
  };
  test('the original\'s unsigned signature fields (SigFlags 1) are accepted; a signed or append-only packet is refused', async () => {
    // The reviewed North Port original ships five empty /Sig fields with
    // SigFlags 1; the round-1 check refused it outright.
    const unsigned = await packet(null, { mutateOther: (other) => {} });
    await approve(await packet(null, { mutateOther: (other, field, pdf) => signatureField(pdf, other, false) }));
    await expect(build(await packet(null, { mutateOther: (other, field, pdf) => signatureField(pdf, other, false) }))).resolves.toBeInstanceOf(PDFPage);
    await expect(build(await packet(null, { mutateOther: (other, field, pdf) => signatureField(pdf, other, true) }))).rejects.toThrow(/signed or prepared for signature/);
    await expect(build(await packet(null, { mutateOther: (other, field, pdf) => { signatureField(pdf, other, false); pdf.getForm().acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3)); } }))).rejects.toThrow(/signed or prepared for signature/);
    expect(unsigned).toBeInstanceOf(Buffer);
  });
  test.each([
    ['an open action', (pdf) => pdf.catalog.set(PDFName.of('OpenAction'), pdf.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') })), /actions, scripts, attachments/],
    ['document actions', (pdf) => pdf.catalog.set(PDFName.of('AA'), pdf.context.obj({ WC: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } })), /actions, scripts, attachments/],
    ['an attachment', (pdf) => pdf.attach(Buffer.from('stale bid'), 'bid.txt'), /actions, scripts, attachments/],
    ['a permissions dictionary', (pdf) => pdf.catalog.set(PDFName.of('Perms'), pdf.context.obj({})), /actions, scripts, attachments/],
    ['a page action', (pdf, other) => other.node.set(PDFName.of('AA'), pdf.context.obj({ O: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } })), /actions, scripts, attachments/],
    ['document JavaScript the original lacks', (pdf) => pdf.addJavaScript('stale', 'app.alert(1)'), /other pages of this PDF differ/],
  ])('a packet carrying %s is refused (GH codex P2 r5 on #4270)', async (name, mutateDocument, message) => {
    await approve(await packet(null));
    await expect(build(await packet(null, { mutateOther: (other, field, pdf) => mutateDocument(pdf, other) }))).rejects.toThrow(message);
  });
  test('primitive values are framed so re-split numbers and a parent field\'s action change the packet (GH codex P2 r6 on #4270)', async () => {
    // [300 50 500 80] and [30 0 50500 80] concatenate to the same digits.
    const rect = (x, y, width, height) => (other, field) => field.acroField.getWidgets()[0].setRectangle({ x, y, width, height });
    const a = await PDFDocument.load(await packet(null, { mutateOther: rect(300, 50, 200, 30) }));
    const b = await PDFDocument.load(await packet(null, { mutateOther: rect(30, 0, 50470, 80) }));
    expect(form.packetFingerprint(a, 0)).not.toBe(form.packetFingerprint(b, 0));
    // A hierarchical field's parent sits above every widget the page
    // annotations reach; its own action must still be pinned.
    const parentAction = (other, field, pdf) => {
      const parent = pdf.getForm().createTextField('bidder.name');
      parent.addToPage(other, { x: 50, y: 100, width: 200, height: 20 });
      pdf.context.lookup(parent.acroField.dict.get(PDFName.of('Parent'))).set(PDFName.of('AA'), pdf.context.obj({ F: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } }));
    };
    const plainParent = (other, field, pdf) => pdf.getForm().createTextField('bidder.name').addToPage(other, { x: 50, y: 100, width: 200, height: 20 });
    await approve(await packet(null, { mutateOther: plainParent }));
    await expect(build(await packet(null, { mutateOther: plainParent }))).resolves.toBeInstanceOf(PDFPage);
    await expect(build(await packet(null, { mutateOther: parentAction }))).rejects.toThrow(/other pages of this PDF differ/);
  });
  test('a swapped image behind identical drawing commands is refused (GH codex P2 r2 on #4270)', async () => {
    // Two pages whose content streams are byte-identical: pdf-lib names the
    // XObject deterministically per document, so only the image bytes differ.
    const png = (shade) => { const { PNG } = require('pngjs'); const img = new PNG({ width: 2, height: 2 }); img.data.fill(shade); return PNG.sync.write(img); };
    const withImage = (bytes) => blankPage(async (pdf, page) => { const image = await pdf.embedPng(bytes); page.drawImage(image, { x: 10, y: 10, width: 20, height: 20 }); });
    let reviewed; let swapped;
    try { reviewed = await withImage(png(0)); swapped = await withImage(png(255)); } catch { return; } // pngjs unavailable: covered by the resource-hash unit test above
    const a = await PDFDocument.load(reviewed); const b = await PDFDocument.load(swapped);
    const fa = form.pageFingerprint(a, a.getPage(0)); const fb = form.pageFingerprint(b, b.getPage(0));
    expect(fa.contents).toBe(fb.contents);
    expect(fa.resources).not.toBe(fb.resources);
    await approve(reviewed);
    await expect(build(reviewed)).resolves.toBeInstanceOf(PDFPage);
    await expect(build(swapped)).rejects.toThrow(/does not match/);
  });

});
