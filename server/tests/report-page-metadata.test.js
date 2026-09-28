const {
  applyHtmlMetadata,
  loadServiceReportCardContent,
  loadServiceReportPageMetadata,
  metadataForServiceReport,
  redactReportPath,
  reportOgImage,
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

  test('injects htmlClass onto the html tag for section-scoped first paint', () => {
    const html = '<html lang="en"><head><title>Old</title></head><body></body></html>';

    const updated = applyHtmlMetadata(html, {
      title: 'Waves',
      htmlClass: 'admin-app',
    });

    expect(updated).toContain('<html lang="en" class="admin-app">');
  });

  test('htmlClass injection is idempotent and appends to an existing class attribute', () => {
    const alreadyTagged = '<html lang="en" class="admin-app"><head><title>Old</title></head><body></body></html>';
    const otherClass = '<html lang="en" class="theme-dark"><head><title>Old</title></head><body></body></html>';

    expect(
      applyHtmlMetadata(alreadyTagged, { htmlClass: 'admin-app' }),
    ).toContain('<html lang="en" class="admin-app">');
    expect(
      applyHtmlMetadata(otherClass, { htmlClass: 'admin-app' }),
    ).toContain('<html lang="en" class="theme-dark admin-app">');
  });

  test('leaves the html tag untouched when htmlClass is not provided', () => {
    const html = '<html lang="en"><head><title>Old</title></head><body></body></html>';

    const updated = applyHtmlMetadata(html, { title: 'Waves Tech' });

    expect(updated).toContain('<html lang="en">');
    expect(updated).not.toContain('class=');
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

  test('auto_send report metadata carries an absolute, escaped og:image (link-preview-cards)', async () => {
    const first = jest.fn().mockResolvedValue({
      service_type: 'Pest Inspection',
      service_date: '2026-06-11',
      structured_notes: JSON.stringify({ typedReportDelivery: 'auto_send' }),
    });
    const where = jest.fn().mockReturnValue({ first });
    const knex = jest.fn().mockReturnValue({ where });

    const metadata = await loadServiceReportPageMetadata('/report/0123456789abcdef0123456789abcdef', knex);
    expect(metadata.image.url).toMatch(/^https?:\/\/.+\/og\/report\/0123456789abcdef0123456789abcdef\.jpg$/);
    expect(metadata.image.width).toBe(1200);
    expect(metadata.image.height).toBe(630);
    expect(metadata.image.alt).toBe('Waves Pest Control service report — Pest Inspection');
  });

  test('reportOgImage builds an absolute /og/report/:token.jpg URL', () => {
    const image = reportOgImage('0123456789abcdef0123456789abcdef', { service_type: 'Rodent Trapping' });
    expect(image.url).toMatch(/\/og\/report\/0123456789abcdef0123456789abcdef\.jpg$/);
    expect(image.alt).toBe('Waves Pest Control service report — Rodent Trapping');
  });

  describe('loadServiceReportCardContent (the /og/report/:token.jpg card)', () => {
    test('resolves eyebrow/headline/subline for an auto_send report', async () => {
      const first = jest.fn().mockResolvedValue({
        service_type: 'Quarterly Pest Control Service',
        service_date: '2026-05-16',
        structured_notes: null,
      });
      const where = jest.fn().mockReturnValue({ first });
      const knex = jest.fn().mockReturnValue({ where });

      const content = await loadServiceReportCardContent('0123456789abcdef0123456789abcdef', knex);
      expect(content).toEqual({
        eyebrow: 'SERVICE REPORT',
        headline: 'Quarterly Pest Control Service',
        subline: 'May 16, 2026',
      });
    });

    test('a suppressed (internal_only) report yields no card content — no existence leak', async () => {
      const first = jest.fn().mockResolvedValue({
        service_type: 'Rodent Trapping',
        service_date: '2026-06-11',
        structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }),
      });
      const where = jest.fn().mockReturnValue({ first });
      const knex = jest.fn().mockReturnValue({ where });

      expect(await loadServiceReportCardContent('0123456789abcdef0123456789abcdef', knex)).toBeNull();
    });

    test('a malformed token never reaches the database', async () => {
      const knex = jest.fn(() => { throw new Error('must not query for a malformed token'); });
      expect(await loadServiceReportCardContent('not-a-hex-token', knex)).toBeNull();
    });
  });

  describe('applyHtmlMetadata image support (link-preview-cards)', () => {
    const baseHtml = [
      '<html><head>',
      '<meta property="og:title" content="Old title" />',
      '<meta name="twitter:card" content="summary" />',
      '<title>Old title</title>',
      '</head><body></body></html>',
    ].join('');

    test('sets og:image + dimensions/alt + twitter:image and upgrades twitter:card to summary_large_image', () => {
      const updated = applyHtmlMetadata(baseHtml, {
        title: 'A report',
        image: {
          url: 'https://portal.wavespestcontrol.com/og/report/abc.jpg',
          width: 1200,
          height: 630,
          alt: 'Waves Pest Control service report — Pest Control',
        },
      });
      expect(updated).toContain('<meta property="og:image" content="https://portal.wavespestcontrol.com/og/report/abc.jpg" />');
      expect(updated).toContain('<meta property="og:image:width" content="1200" />');
      expect(updated).toContain('<meta property="og:image:height" content="630" />');
      expect(updated).toContain('<meta property="og:image:alt" content="Waves Pest Control service report — Pest Control" />');
      expect(updated).toContain('<meta name="twitter:image" content="https://portal.wavespestcontrol.com/og/report/abc.jpg" />');
      expect(updated).toContain('<meta name="twitter:card" content="summary_large_image" />');
    });

    test('escapes an untrusted alt string (defense in depth — alt only ever carries our own eyebrow/service text)', () => {
      const updated = applyHtmlMetadata(baseHtml, {
        image: { url: 'https://example.com/x.jpg', alt: '"><script>alert(1)</script>' },
      });
      expect(updated).not.toContain('<script>');
      expect(updated).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    test('omitting image leaves any previously-set image tags untouched (idempotent no-op)', () => {
      const withImage = applyHtmlMetadata(baseHtml, {
        image: { url: 'https://portal.wavespestcontrol.com/og/default.jpg', width: 1200, height: 630 },
      });
      const again = applyHtmlMetadata(withImage, { title: 'Just a title change' });
      expect(again).toContain('<meta property="og:image" content="https://portal.wavespestcontrol.com/og/default.jpg" />');
      expect(again).toContain('<title>Just a title change</title>');
    });

    test('previewTitle sets only the link-preview title; the page <title> keeps the full title', () => {
      const updated = applyHtmlMetadata(baseHtml, { title: 'Your invoice · Waves Pest Control', previewTitle: 'Waves' });
      expect(updated).toContain('<meta property="og:title" content="Waves" />');
      expect(updated).toContain('<meta name="twitter:title" content="Waves" />');
      expect(updated).toContain('<title>Your invoice · Waves Pest Control</title>');
    });

    test('no image field never touches twitter:card (stays whatever the page already had)', () => {
      const updated = applyHtmlMetadata(baseHtml, { title: 'No image here' });
      expect(updated).toContain('<meta name="twitter:card" content="summary" />');
    });
  });
});
