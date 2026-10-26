const { PassThrough } = require('stream');
const PDFDocument = require('pdfkit');
const { renderLegacyServiceReportPdf } = require('../services/pdf/legacy-service-report-pdf');

const SERVICE = {
  service_date: '2026-10-25',
  service_type: 'Residential Pest Control',
  first_name: 'Sample',
  last_name: 'Customer',
  address_line1: '123 Example Avenue',
  city: 'Bradenton',
  state: 'FL',
  zip: '34205',
  technician_name: 'Waves Team',
  soil_temp: 78,
  soil_ph: 6.5,
  thatch_measurement: 0.5,
  soil_moisture: 'Normal',
};

function responseStream() {
  const stream = new PassThrough();
  stream.setHeader = jest.fn();
  return stream;
}

async function renderToBuffer(overrides = {}) {
  const res = responseStream();
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve, reject) => {
    res.on('end', resolve);
    res.on('error', reject);
  });
  renderLegacyServiceReportPdf({
    service: SERVICE,
    products: [],
    reviewedNotes: '',
    fileName: 'Waves-Report-Sample-Customer.pdf',
    ...overrides,
  }, res);
  await ended;
  return { buffer: Buffer.concat(chunks), res };
}

function captureText() {
  const original = PDFDocument.prototype.text;
  const calls = [];
  jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function text(str, ...args) {
    calls.push({ str, args });
    return original.call(this, str, ...args);
  });
  return calls;
}

function capturePageOrder() {
  const originalText = PDFDocument.prototype.text;
  const originalAddPage = PDFDocument.prototype.addPage;
  const events = [];
  jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function text(str, ...args) {
    events.push({ type: 'text', str: String(str) });
    return originalText.call(this, str, ...args);
  });
  jest.spyOn(PDFDocument.prototype, 'addPage').mockImplementation(function addPage(...args) {
    events.push({ type: 'page' });
    return originalAddPage.call(this, ...args);
  });
  return events;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('legacy public service report Field PDF', () => {
  test('renders the existing report content through the shared Field document shell', async () => {
    const calls = captureText();
    const { buffer, res } = await renderToBuffer({
      weather: { temp: 82, humidity: 70, wind: '5 mph', cloudCover: 20 },
      products: [{
        product_name: 'Example Product',
        active_ingredient: 'Example Ingredient',
        moa_group: '3A',
        product_category: 'Insecticide',
      }],
      reviewedNotes: 'Reviewed customer-facing visit summary.',
      dryTimes: {
        lawn: 'Until dry',
        foundation: 'Until dry',
        interior: 'Until dry',
        rainAdvisory: 'Follow the product label.',
      },
      irrigation: {
        recommendation: 'Resume normal irrigation after the application has dried.',
        instructions: [{ allowed: true, text: 'Normal irrigation may resume tomorrow.' }],
      },
    });

    expect(buffer.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1_000);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'inline; filename="Waves-Report-Sample-Customer.pdf"'
    );

    const rendered = calls.map(({ str }) => String(str));
    expect(rendered).toEqual(expect.arrayContaining([
      'Service Report',
      'Customer',
      'Sample Customer',
      '123 Example Avenue, Bradenton, FL 34205',
      'Service Details',
      'October 25, 2026',
      'Residential Pest Control',
      'Conditions at Time of Service',
      'Air Temp: 82°F  Humidity: 70%  Wind: 5 mph  Cloud Cover: 20%',
      'Soil Temp: 78°F  Soil pH: 6.5  Thatch: 0.5"  Moisture: Normal',
      'Technician Notes',
      'Reviewed customer-facing visit summary.',
      'Products Applied',
      'Example Product',
      'Example Ingredient',
      '3A',
      'Insecticide',
      'Estimated Dry Times',
      '• Lawn treatment: Until dry',
      'Rain advisory: Follow the product label.',
      'Irrigation Recommendations',
      'Irrigation Recommendations · continued',
      'Resume normal irrigation after the application has dried.',
      '4',
      'Normal irrigation may resume tomorrow.',
      'Report Information',
    ]));
    const safetyCall = calls.find(({ str }) => String(str).startsWith('Every product we use and our safety protocol:'));
    expect(safetyCall).toBeDefined();
    expect(safetyCall.str).toContain('https://www.wavespestcontrol.com/products-and-safety/');
    expect(safetyCall.args.at(-1)).toEqual(expect.objectContaining({
      link: 'https://www.wavespestcontrol.com/products-and-safety/#safety-protocol',
    }));
    expect(rendered.some((text) => text.startsWith('Generated '))).toBe(true);
  });

  test('paginates a long product table with continuation chrome, repeated headings, and every row', async () => {
    const calls = captureText();
    const addPage = jest.spyOn(PDFDocument.prototype, 'addPage');
    const products = Array.from({ length: 72 }, (_, index) => ({
      product_name: `Synthetic Product ${index + 1}`,
      active_ingredient: `Ingredient ${index + 1}`,
      moa_group: String(index % 10),
      product_category: index % 2 ? 'Insecticide' : 'Herbicide',
    }));

    const { buffer } = await renderToBuffer({ products });
    const rendered = calls.map(({ str }) => String(str));
    const pageObjects = (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;

    expect(addPage).toHaveBeenCalled();
    expect(pageObjects).toBeGreaterThan(2);
    expect(rendered).toContain('Service Report · continued');
    expect(rendered).toContain('Products Applied · continued');
    expect(rendered).toContain('Service report · Page 2');
    products.forEach((product) => expect(rendered).toContain(product.product_name));
    expect(rendered).toContain('Report Information');
  });

  test('moves a near-boundary wrapped product row before drawing it, never during a cell', async () => {
    const events = capturePageOrder();
    const products = Array.from({ length: 5 }, (_, index) => ({
      product_name: `Boundary Product ${index + 1}`,
      active_ingredient: 'Thiencarbazone-methyl + Iodosulfuron-methyl-sodium + Dicamba',
      moa_group: '2 + 4',
      product_category: 'Herbicide',
    }));
    const reviewedNotes = Array.from(
      { length: 7 },
      (_, index) => `Reviewed customer-facing sentence ${index + 1} documents the completed visit without internal notes.`
    ).join('\n');

    const { buffer } = await renderToBuffer({ products, reviewedNotes });
    expect((buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length).toBeGreaterThan(1);

    products.forEach((product) => {
      const nameIndex = events.findIndex((event) => event.type === 'text' && event.str === product.product_name);
      const categoryIndex = events.findIndex((event, index) => (
        index > nameIndex && event.type === 'text' && event.str === product.product_category
      ));
      expect(nameIndex).toBeGreaterThan(-1);
      expect(categoryIndex).toBeGreaterThan(nameIndex);
      expect(events.slice(nameIndex, categoryIndex + 1).some((event) => event.type === 'page')).toBe(false);
    });

    const productPageBreaks = events.reduce((breaks, event, index) => {
      if (event.type !== 'page') return breaks;
      const nextProductIndex = events.findIndex((candidate, candidateIndex) => (
        candidateIndex > index
        && candidate.type === 'text'
        && /^Boundary Product \d+$/.test(candidate.str)
      ));
      const previousProductIndex = events.findLastIndex((candidate, candidateIndex) => (
        candidateIndex < index
        && candidate.type === 'text'
        && /^Boundary Product \d+$/.test(candidate.str)
      ));
      if (nextProductIndex > -1 && previousProductIndex > -1) {
        breaks.push({ index, nextProductIndex });
      }
      return breaks;
    }, []);

    expect(productPageBreaks.length).toBeGreaterThan(0);
    productPageBreaks.forEach(({ index, nextProductIndex }) => {
      const continuation = events.slice(index, nextProductIndex).filter((event) => event.type === 'text').map((event) => event.str);
      expect(continuation).toContain('Products Applied · continued');
      expect(continuation).toEqual(expect.arrayContaining(['Product', 'Active Ingredient', 'MOA Group', 'Category']));
    });
  });
});
