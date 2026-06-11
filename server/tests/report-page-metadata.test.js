const {
  applyHtmlMetadata,
  loadServiceReportPageMetadata,
  metadataForServiceReport,
  redactReportPath,
  reportTokenFromPath,
} = require('../services/report-page-metadata');

describe('report page metadata', () => {
  test('extracts only plain service report tokens from report paths', () => {
    expect(reportTokenFromPath('/report/0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef');
    expect(reportTokenFromPath('/report/0123456789abcdef0123456789abcdef/')).toBe('0123456789abcdef0123456789abcdef');
    expect(reportTokenFromPath('/report/project/georgia-lobban-0123456789ab')).toBe(null);
    expect(reportTokenFromPath('/api/reports/0123456789abcdef0123456789abcdef/data')).toBe(null);
  });

  test('redacts service report bearer tokens before logging paths', () => {
    expect(redactReportPath('/report/0123456789abcdef0123456789abcdef')).toBe('/report/[redacted]');
    expect(redactReportPath('/report/0123456789abcdef0123456789abcdef/')).toBe('/report/[redacted]/');
    expect(redactReportPath('/report/project/0123456789abcdef0123456789abcdef')).toBe('/report/project/0123456789abcdef0123456789abcdef');
  });

  test('builds report-specific title and share description from the service record', () => {
    const metadata = metadataForServiceReport({
      service_type: 'Quarterly Pest Control Service',
      service_date: '2026-05-16',
    });

    expect(metadata).toMatchObject({
      title: 'Service report · May 16, 2026 · Quarterly Pest Control Service',
      description: 'Waves service report for May 16, 2026: Quarterly Pest Control Service. View visit details, action items, and next service.',
      themeColor: '#111111',
    });
  });

  test('formats service DATE values as calendar dates instead of UTC instants', () => {
    const fromDateObject = metadataForServiceReport({
      service_type: 'Quarterly Pest Control Service',
      service_date: new Date('2026-05-16T00:00:00.000Z'),
    });
    const fromIsoMidnight = metadataForServiceReport({
      service_type: 'Quarterly Pest Control Service',
      service_date: '2026-05-16T00:00:00.000Z',
    });

    expect(fromDateObject.title).toBe('Service report · May 16, 2026 · Quarterly Pest Control Service');
    expect(fromIsoMidnight.title).toBe('Service report · May 16, 2026 · Quarterly Pest Control Service');
  });

  test('applies title, social description, and monochrome theme color to index html', () => {
    const html = [
      '<html><head>',
      '<meta name="theme-color" content="#0ea5e9" />',
      '<meta name="description" content="Old description" />',
      '<meta property="og:title" content="Old title" />',
      '<meta property="og:description" content="Old social description" />',
      '<meta name="twitter:title" content="Old title" />',
      '<meta name="twitter:description" content="Old social description" />',
      '<title>Old title</title>',
      '</head><body></body></html>',
    ].join('');

    const updated = applyHtmlMetadata(html, {
      title: 'Service report · May 16, 2026 · WaveGuard pest',
      description: 'Waves service report for May 16, 2026: WaveGuard pest.',
      themeColor: '#111111',
    });

    expect(updated).toContain('<title>Service report · May 16, 2026 · WaveGuard pest</title>');
    expect(updated).toContain('<meta name="theme-color" content="#111111" />');
    expect(updated).toContain('<meta name="description" content="Waves service report for May 16, 2026: WaveGuard pest." />');
    expect(updated).toContain('<meta property="og:title" content="Service report · May 16, 2026 · WaveGuard pest" />');
    expect(updated).toContain('<meta name="twitter:title" content="Service report · May 16, 2026 · WaveGuard pest" />');
  });

  test('loads report metadata with a lightweight token lookup', async () => {
    const first = jest.fn().mockResolvedValue({
      service_type: 'Residential Pest Control',
      service_date: '2026-05-17',
    });
    const where = jest.fn().mockReturnValue({ first });
    const knex = jest.fn().mockReturnValue({ where });

    const metadata = await loadServiceReportPageMetadata('/report/0123456789abcdef0123456789abcdef', knex);

    expect(knex).toHaveBeenCalledWith('service_records');
    expect(where).toHaveBeenCalledWith({ report_view_token: '0123456789abcdef0123456789abcdef' });
    expect(first).toHaveBeenCalledWith('service_type', 'service_date', 'structured_notes');
    expect(metadata.title).toBe('Service report · May 17, 2026 · Residential Pest Control');
  });

  test('suppressed typed reports fall back to generic metadata (no existence leak)', async () => {
    const first = jest.fn().mockResolvedValue({
      service_type: 'Rodent Trapping',
      service_date: '2026-06-11',
      structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }),
    });
    const where = jest.fn().mockReturnValue({ first });
    const knex = jest.fn().mockReturnValue({ where });

    const metadata = await loadServiceReportPageMetadata('/report/0123456789abcdef0123456789abcdef', knex);
    expect(metadata).toBeNull();
  });

  test('auto_send typed reports keep their metadata', async () => {
    const first = jest.fn().mockResolvedValue({
      service_type: 'Pest Inspection',
      service_date: '2026-06-11',
      structured_notes: JSON.stringify({ typedReportDelivery: 'auto_send' }),
    });
    const where = jest.fn().mockReturnValue({ first });
    const knex = jest.fn().mockReturnValue({ where });

    const metadata = await loadServiceReportPageMetadata('/report/0123456789abcdef0123456789abcdef', knex);
    expect(metadata.title).toBe('Service report · June 11, 2026 · Pest Inspection');
  });
});
