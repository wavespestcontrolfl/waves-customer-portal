const { PDFDocument } = require('pdf-lib');
const { findEpaLabel, selectEpaSource, downloadEpaLabel, checkEpaSource, currentEpaSourceStatus, findEpaRegistrationByName } = require('../services/epa-product-label');
const row = () => ({ eparegno: '123-456', productname: 'Synthetic product', product_status: 'Active', cancel_flag: 'No', pdffiles: [
  { epa_reg_num: '123-456', pdffile: '000123-00456-20250101.pdf' },
  { epa_reg_num: '123-456', pdffile: '000123-00456-20260101.pdf' },
  { epa_reg_num: '987-654', pdffile: '000987-00654-20270101.pdf' },
] });
afterEach(() => jest.restoreAllMocks());
test('selects latest exact-registration PDF and never persists company contacts', () => {
  const entry = row(); entry.companyinfo = [{ contact_person: 'Synthetic contact' }];
  const source = selectEpaSource({ items: [entry] }, '123-456');
  expect(source.filename).toBe('000123-00456-20260101.pdf');
  expect(JSON.stringify(source)).not.toContain('contact_person');
});
test('returns the record\'s brand names (product name plus alternates, trimmed, deduped, bounded) and active ingredient names', () => {
  const entry = {
    ...row(), productname: '  RF2296 LH EC ',
    altbrandnames: [{ altbrandname: 'GENTROL\u00ae COMPLETE EC3' }, { altbrandname: 'GENTROL\u00ae COMPLETE EC3 ' }, { altbrandname: '' }, {}],
    active_ingredients: [{ active_ing: 'Synthetic ingredient' }, { active_ing: 'Synthetic ingredient' }, {}],
  };
  const source = selectEpaSource({ items: [entry] }, '123-456');
  expect(source.brandNames).toEqual(['RF2296 LH EC', 'GENTROL\u00ae COMPLETE EC3']);
  expect(source.activeIngredientNames).toEqual(['Synthetic ingredient']);
  const many = { ...row(), altbrandnames: Array.from({ length: 60 }, (_, i) => ({ altbrandname: `Name ${i} ${'x'.repeat(400)}` })) };
  const bounded = selectEpaSource({ items: [many] }, '123-456');
  expect(bounded.brandNames.length).toBeLessThanOrEqual(20);
  expect(Math.max(...bounded.brandNames.map((n) => n.length))).toBeLessThanOrEqual(200);
});
test.each(['../123-456', 'https://example.invalid', '123-456-789', 'N/A', '00123-456'])('rejects unsupported registration %s before fetch', async registration => {
  const fetchMock = jest.spyOn(global, 'fetch');
  await expect(findEpaLabel(registration)).rejects.toMatchObject({ statusCode: 422 });
  expect(fetchMock).not.toHaveBeenCalled();
});
test('rejects cancelled, duplicate, and mismatched registrations', () => {
  expect(() => selectEpaSource({ items: [{ ...row(), cancel_flag: 'Yes' }] }, '123-456')).toThrow();
  expect(() => selectEpaSource({ items: [row(), row()] }, '123-456')).toThrow();
  expect(() => selectEpaSource({ items: [row()] }, '123-457')).toThrow();
});
test('cannot follow a response-provided arbitrary PDF URL', async () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  await expect(downloadEpaLabel({ filename: '000123-00456-20260101.pdf', url: 'https://example.invalid/private' })).rejects.toThrow('Invalid EPA document');
  expect(fetchMock).not.toHaveBeenCalled();
});
test('downloads a bounded actual PDF, checks pages and hashes bytes', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const source = selectEpaSource({ items: [row()] }, '123-456');
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(bytes));
  const result = await downloadEpaLabel(source);
  expect(result.pageCount).toBe(1); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
});
test('rejects HTML and oversized PDFs', async () => {
  const source = selectEpaSource({ items: [row()] }, '123-456');
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>not a label</html>'));
  await expect(downloadEpaLabel(source)).rejects.toThrow('did not return a PDF');
  fetchMock.mockResolvedValue(new Response('%PDF-test', { headers: { 'content-length': String(9 * 1024 * 1024) } }));
  await expect(downloadEpaLabel(source)).rejects.toThrow('exceeds the supported size');
});

test.each([new TypeError('network unavailable'), new DOMException('request timed out', 'TimeoutError')])('EPA request failure stays operational and retryable (%s)', async failure => {
  jest.spyOn(global, 'fetch').mockRejectedValue(failure);
  await expect(findEpaLabel('123-456')).rejects.toMatchObject({ statusCode: 502, isOperational: true, message: 'EPA source is unavailable. Try again later.' });
});

test('EPA body-stream failure stays operational and retryable', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new TypeError('stream disconnected')); } });
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(stream));
  await expect(findEpaLabel('123-456')).rejects.toMatchObject({ statusCode: 502, isOperational: true });
});

test.each(['<html>upstream error</html>', '{"items":', '{"items":{}}'])('malformed EPA payload is operational (%s)', async payload => {
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(payload));
  await expect(findEpaLabel('123-456')).rejects.toMatchObject({ statusCode: 502, isOperational: true });
});

test('a malformed PDF is a document-review error', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response('%PDF-1.7\ninvalid document'));
  await expect(downloadEpaLabel(selectEpaSource({ items: [row()] }, '123-456'))).rejects.toMatchObject({ statusCode: 422, isOperational: true });
});

test('a successful forced source check replaces cached unavailability immediately', async () => {
  const pdf = await PDFDocument.create(); pdf.setTitle('Synthetic cache refresh fixture'); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const source = { ...selectEpaSource({ items: [row()] }, '123-456'), sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
  jest.spyOn(Date, 'now').mockReturnValue(4000000);
  const fetched = jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('network unavailable'));
  expect(await currentEpaSourceStatus(source)).toBe('unavailable');
  fetched.mockImplementation(async url => new Response(url.includes('/ords/') ? JSON.stringify({ items: [row()] }) : bytes));
  expect(await currentEpaSourceStatus(source, { refresh: true })).toBe('current');
  expect(await currentEpaSourceStatus(source)).toBe('current');
  expect(fetched).toHaveBeenCalledTimes(3);
});

test('source checks coalesce, then invalidate a superseded label after at most 60 seconds', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const source = { ...selectEpaSource({ items: [row()] }, '123-456'), sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
  let latest = row();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(2000000);
  const fetched = jest.spyOn(global, 'fetch').mockImplementation(async url => new Response(url.includes('/ords/') ? JSON.stringify({ items: [latest] }) : bytes));
  expect(await Promise.all([currentEpaSourceStatus(source), currentEpaSourceStatus(source)])).toEqual(['current', 'current']);
  expect(fetched).toHaveBeenCalledTimes(2);
  latest = { ...row(), pdffiles: [{ epa_reg_num: '123-456', pdffile: '000123-00456-20260202.pdf' }] };
  clock.mockReturnValue(2060001);
  expect(await currentEpaSourceStatus(source)).toBe('superseded');
  expect(fetched).toHaveBeenCalledTimes(3);
});

test('a changed PDF checksum and an unavailable EPA lookup never count as current', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const source = { ...selectEpaSource({ items: [row()] }, '123-456'), sha256: 'older-pdf-bytes' };
  const clock = jest.spyOn(Date, 'now').mockReturnValue(3000000);
  const fetched = jest.spyOn(global, 'fetch').mockImplementation(async url => new Response(url.includes('/ords/') ? JSON.stringify({ items: [row()] }) : bytes));
  expect(await currentEpaSourceStatus(source)).toBe('superseded');
  clock.mockReturnValue(3060001); fetched.mockRejectedValue(new Error('EPA unavailable'));
  expect(await currentEpaSourceStatus(source)).toBe('unavailable');
});

test('a cached answer keeps the time EPA gave it', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const source = { ...selectEpaSource({ items: [row()] }, '123-456'), sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
  const clock = jest.spyOn(Date, 'now').mockReturnValue(6000000);
  jest.spyOn(global, 'fetch').mockImplementation(async url => new Response(url.includes('/ords/') ? JSON.stringify({ items: [row()] }) : bytes));
  expect(await checkEpaSource(source)).toEqual({ status: 'current', checkedAt: 6000000 });
  clock.mockReturnValue(6050000);
  expect(await checkEpaSource(source)).toEqual({ status: 'current', checkedAt: 6000000 });
  expect(await currentEpaSourceStatus(source)).toBe('current');
});

test('EPA\'s own record of a cancelled registration or a removed label is "inactive"; an empty answer is an outage', async () => {
  const source = { ...selectEpaSource({ items: [row()] }, '123-456'), sha256: 'synthetic-pdf-bytes' };
  let answer;
  jest.spyOn(Date, 'now').mockReturnValue(5000000);
  jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(answer)));
  const check = (items) => { answer = { items }; return currentEpaSourceStatus(source, { refresh: true }); };
  expect(await check([{ ...row(), cancel_flag: 'Yes' }])).toBe('inactive');
  expect(await check([{ ...row(), product_status: 'Cancelled' }])).toBe('inactive');
  expect(await check([{ ...row(), pdffiles: [] }])).toBe('inactive');
  expect(await check([])).toBe('unavailable');
  expect(await check([row(), row()])).toBe('unavailable');
});

describe('findEpaRegistrationByName — exact brand-name proof, never containment', () => {
  const recordFor = (registration, productname, alts, extra = {}) => ({
    eparegno: registration, productname, product_status: 'Active', cancel_flag: 'No',
    altbrandnames: alts.map((altbrandname) => ({ altbrandname })),
    pdffiles: [{ epa_reg_num: registration, pdffile: `${registration.split('-')[0].padStart(6, '0')}-${registration.split('-')[1].padStart(5, '0')}-20260204.pdf` }],
    ...extra,
  });
  const GENTROL_RECORD = recordFor('89459-119', 'RF2296 LH EC', ['GENTROL\u00ae COMPLETE EC3'], { active_ingredients: [{ active_ing: '(S)-Hydroprene' }] });
  const GENTROL_SEARCH = { items: [
    { eparegno: '2724-351-432', productname: 'TURBOCIDE GOLD WITH GENTROL', product_name_status: 'Active', product_status: 'Active', altrntbrndnames: null },
    { eparegno: '2724-351-50809', productname: 'ZEOCON GENTROL IGR CONCENTRATE', product_name_status: 'Active', product_status: 'Active', altrntbrndnames: null },
    { eparegno: '2724-304-50809', productname: 'ZOECON GENTROL E.C. IGR', product_name_status: 'Active', product_status: 'Inactive', altrntbrndnames: null },
    { eparegno: '89459-84', productname: 'GENTROL COMPLETE AEROSOL', product_name_status: 'Active', product_status: 'Active', altrntbrndnames: null },
    { eparegno: '2724-469', productname: 'GENTROL POINT SOURCE ROACH CONTROL DEVICE', product_name_status: null, product_status: 'Active', altrntbrndnames: null },
    { eparegno: '89459-119', productname: 'GENTROL\u00ae COMPLETE EC3', product_name_status: 'Active', product_status: 'Active', altrntbrndnames: null },
    { eparegno: '2724-351', productname: 'ZOECON GENTROL IGR CONCENTRATE', product_name_status: 'Active', product_status: 'Active', altrntbrndnames: null },
  ] };
  const TAURUS_SEARCH = { items: [{ eparegno: '53883-279', productname: 'TAURUS SC TERMITICIDE/INSECTICIDE', product_name_status: 'Active', product_status: 'Active', altrntbrndnames: '"TAURUS SC - NY"' }] };

  // Routes EPA's two fixed endpoints: the name search and the exact record.
  function epa({ search = {}, records = {} }) {
    return jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const text = String(url);
      const searchMatch = /\/riname\/([^/]+)$/.exec(text);
      if (searchMatch) {
        const answer = search[decodeURIComponent(searchMatch[1])];
        return answer instanceof Error ? Promise.reject(answer) : new Response(typeof answer === 'string' ? answer : JSON.stringify(answer || { items: [] }));
      }
      const recordMatch = /\/ppls\/(\d+-\d+)$/.exec(text);
      if (recordMatch) return new Response(JSON.stringify({ items: records[recordMatch[1]] ? [records[recordMatch[1]]] : [] }));
      throw new Error(`unexpected EPA url ${text}`);
    });
  }
  const urls = (fetched) => fetched.mock.calls.map(([url]) => String(url));

  test('Gentrol Complete EC3: the unique exact alternate name finds 89459-119 and its newest label', async () => {
    const fetched = epa({ search: { GENTROL: GENTROL_SEARCH }, records: { '89459-119': GENTROL_RECORD } });
    const result = await findEpaRegistrationByName('Gentrol Complete EC3');
    expect(result).toEqual({
      status: 'found', registration: '89459-119', labelUrl: 'https://www3.epa.gov/pesticides/chem_search/ppls/089459-00119-20260204.pdf',
      matchedName: 'GENTROL\u00ae COMPLETE EC3', acceptedDate: null, via: 'name_search',
    });
    expect(urls(fetched)).toEqual([
      'https://ordspub.epa.gov/ords/pesticides/cswu/ProductSearch/partialprodsearch/v2/riname/GENTROL',
      'https://ordspub.epa.gov/ords/pesticides/cswu/ppls/89459-119',
    ]);
  });

  test('equality, never containment: "Gentrol" alone and "Gentrol Complete" match nothing', async () => {
    epa({ search: { GENTROL: GENTROL_SEARCH }, records: { '89459-119': GENTROL_RECORD } });
    expect(await findEpaRegistrationByName('Gentrol')).toMatchObject({ status: 'not_found', reason: 'no_exact_name' });
    expect(await findEpaRegistrationByName('Gentrol Complete')).toMatchObject({ status: 'not_found' });
  });

  test('"Taurus SC" matches TAURUS SC TERMITICIDE/INSECTICIDE (category nouns dropped) and the alternate "TAURUS SC - NY" does not hurt', async () => {
    epa({ search: { TAURUS: TAURUS_SEARCH }, records: { '53883-279': recordFor('53883-279', 'TAURUS SC TERMITICIDE/INSECTICIDE', ['TAURUS SC - NY'], { active_ingredients: [{ active_ing: 'Fipronil' }] }) } });
    expect(await findEpaRegistrationByName('Taurus SC')).toMatchObject({ status: 'found', registration: '53883-279', via: 'name_search' });
  });

  test('two active registrations with the same exact name are ambiguous and nothing is fetched for either', async () => {
    const fetched = epa({ search: { ACME: { items: [
      { eparegno: '111-22', productname: 'ACME KILL', product_status: 'Active', product_name_status: 'Active' },
      { eparegno: '333-44', productname: 'ACME KILL INSECTICIDE', product_status: 'Active', product_name_status: null },
    ] } } });
    expect(await findEpaRegistrationByName('Acme Kill')).toEqual({ status: 'ambiguous', registrations: ['111-22', '333-44'] });
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  test('a distributor product (three-part number with the same name) fills nothing', async () => {
    const fetched = epa({ search: { TRISTAR: { items: [
      { eparegno: '8033-106', productname: 'TRISTAR 8.5 SL', product_status: 'Active', product_name_status: 'Active' },
      { eparegno: '8033-106-1001', productname: 'TRISTAR 8.5 SL', product_status: 'Active', product_name_status: 'Active' },
    ] } } });
    expect(await findEpaRegistrationByName('TriStar 8.5 SL')).toEqual({ status: 'ambiguous', reason: 'distributor_product', registrations: ['8033-106', '8033-106-1001'] });
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  test('an inactive distributor registration is ignored', async () => {
    epa({ search: { TRISTAR: { items: [
      { eparegno: '8033-106', productname: 'TRISTAR 8.5 SL', product_status: 'Active', product_name_status: 'Active' },
      { eparegno: '8033-106-1001', productname: 'TRISTAR 8.5 SL', product_status: 'Inactive', product_name_status: 'Active' },
    ] } }, records: { '8033-106': recordFor('8033-106', 'TRISTAR 8.5 SL', [], { active_ingredients: [{ active_ing: 'Acetamiprid' }] }) } });
    expect(await findEpaRegistrationByName('TriStar 8.5 SL')).toMatchObject({ status: 'found', registration: '8033-106' });
  });

  test('a name built from the active ingredient is generic, not proof ("Prodiamine 65 WDG")', async () => {
    epa({ search: { PRODIAMINE: { items: [{ eparegno: '100-200', productname: 'PRODIAMINE 65 WDG', product_status: 'Active', product_name_status: 'Active' }] } },
      records: { '100-200': recordFor('100-200', 'PRODIAMINE 65 WDG', [], { active_ingredients: [{ active_ing: 'Prodiamine' }] }) } });
    expect(await findEpaRegistrationByName('Prodiamine 65 WDG')).toEqual({ status: 'not_found', reason: 'generic_name' });
  });

  test('a short first word searches the first word of 3+ letters ("M-Pede" searches PEDE)', async () => {
    const fetched = epa({ search: { PEDE: { items: [{ eparegno: '10163-324', productname: 'M-PEDE', product_status: 'Active', product_name_status: 'Active' }] } },
      records: { '10163-324': recordFor('10163-324', 'M-PEDE', [], { active_ingredients: [{ active_ing: 'Potassium salts of fatty acids' }] }) } });
    expect(await findEpaRegistrationByName('M-Pede')).toMatchObject({ status: 'found', registration: '10163-324' });
    expect(urls(fetched)[0]).toMatch(/\/riname\/PEDE$/);
  });

  test('alternate names parse every double-quoted segment', async () => {
    epa({ search: { ALPHA: { items: [{ eparegno: '55-66', productname: 'SOMETHING ELSE', product_status: 'Active', altrntbrndnames: '"BETA ONE", "ALPHA TWO"' }] } },
      records: { '55-66': recordFor('55-66', 'SOMETHING ELSE', ['ALPHA TWO']) } });
    expect(await findEpaRegistrationByName('Alpha Two')).toMatchObject({ status: 'found', registration: '55-66' });
  });

  test('the exact record is the authority: a search hit whose record lacks the name is not_found', async () => {
    epa({ search: { GENTROL: GENTROL_SEARCH }, records: { '89459-119': recordFor('89459-119', 'RF2296 LH EC', []) } });
    expect(await findEpaRegistrationByName('Gentrol Complete EC3')).toMatchObject({ status: 'not_found', reason: 'record_name_differs' });
  });

  test('a name with no word of letters is generic and makes no request', async () => {
    const fetched = epa({});
    expect(await findEpaRegistrationByName('Insecticide')).toEqual({ status: 'not_found', reason: 'generic_name' });
    expect(await findEpaRegistrationByName('96 12')).toEqual({ status: 'not_found', reason: 'generic_name' });
    expect(fetched).not.toHaveBeenCalled();
  });

  test('a listing number that EPA\'s record agrees with is used, with no name search', async () => {
    const fetched = epa({ records: { '89459-119': GENTROL_RECORD } });
    const result = await findEpaRegistrationByName('Gentrol Complete EC3', { listingRegistration: '89459-119' });
    expect(result).toMatchObject({ status: 'found', registration: '89459-119', via: 'listing' });
    expect(urls(fetched)).toEqual(['https://ordspub.epa.gov/ords/pesticides/cswu/ppls/89459-119']);
  });

  test('a listing number the record does not agree with is never used and is remembered as a mismatch', async () => {
    epa({ search: { GENTROL: GENTROL_SEARCH }, records: { '89459-119': GENTROL_RECORD, '279-3206': recordFor('279-3206', 'BIFEN XTS', []) } });
    expect(await findEpaRegistrationByName('Gentrol Complete EC3', { listingRegistration: '279-3206' }))
      .toMatchObject({ status: 'found', registration: '89459-119', via: 'name_search', listingMismatch: true });
    epa({ search: { ZZZ: { items: [] } }, records: { '279-3206': recordFor('279-3206', 'BIFEN XTS', []) } });
    expect(await findEpaRegistrationByName('Zzz Product', { listingRegistration: '279-3206' }))
      .toEqual({ status: 'not_found', reason: 'no_exact_name', listingMismatch: true });
  });

  test('a listing number that is not a two-part registration is ignored without a request', async () => {
    const fetched = epa({ search: { GENTROL: GENTROL_SEARCH }, records: { '89459-119': GENTROL_RECORD } });
    const result = await findEpaRegistrationByName('Gentrol Complete EC3', { listingRegistration: '2724-351-50809' });
    expect(result).toMatchObject({ status: 'found', via: 'name_search' });
    expect(result.listingMismatch).toBeUndefined();
    expect(urls(fetched).every((url) => !url.includes('2724-351-50809'))).toBe(true);
  });

  test('never throws: network failure, bad JSON and a wrong shape are all unavailable', async () => {
    epa({ search: { GENTROL: new TypeError('network down') } });
    expect(await findEpaRegistrationByName('Gentrol Complete EC3')).toEqual({ status: 'unavailable' });
    epa({ search: { GENTROL: '<html>error</html>' } });
    expect(await findEpaRegistrationByName('Gentrol Complete EC3')).toEqual({ status: 'unavailable' });
    epa({ search: { GENTROL: { items: 'nope' } } });
    expect(await findEpaRegistrationByName('Gentrol Complete EC3')).toEqual({ status: 'unavailable' });
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('boom'));
    expect(await findEpaRegistrationByName('Gentrol Complete EC3', { listingRegistration: '89459-119' })).toEqual({ status: 'unavailable' });
  });

  test('the only variable in a URL is the encoded, upper-cased search word', async () => {
    const fetched = epa({ search: { 'A1B': { items: [] } } });
    await findEpaRegistrationByName('a1b/../../evil?x=1');
    expect(urls(fetched)).toEqual(['https://ordspub.epa.gov/ords/pesticides/cswu/ProductSearch/partialprodsearch/v2/riname/A1B']);
  });
});
