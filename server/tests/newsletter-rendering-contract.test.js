const {
  newsletterPalette,
  wrapNewsletter,
  wrapEmail,
} = require('../services/email-template');
const {
  assembleBeehiivNewsletter,
  assemblePestInsiderNewsletter,
} = require('../services/newsletter-draft');
const {
  WAVES_ADDRESS_LINE,
  WAVES_SUPPORT_PHONE_E164,
} = require('../constants/business');

function occurrenceCount(value, needle) {
  return String(value).split(needle).length - 1;
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
  const [r, g, b] = channels.map((channel) => (
    channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function renderedThemeNames(html, idPattern) {
  const palette = newsletterPalette();
  const themeByStyle = new Map(palette.sectionHeaders.map((theme) => [
    `${theme.text}|${theme.background}|${theme.accent}`,
    theme.name,
  ]));

  return [...html.matchAll(new RegExp(`<h2 id="${idPattern}"(?: class="[^"]*")? style="([^"]+)"`, 'g'))]
    .map((match) => {
      const style = match[1];
      const colors = /color:(#[0-9A-F]{6});background:(#[0-9A-F]{6});border-left:4px solid (#[0-9A-F]{6});/i.exec(style);
      return colors ? themeByStyle.get(`${colors[1].toUpperCase()}|${colors[2].toUpperCase()}|${colors[3].toUpperCase()}`) : null;
    });
}

describe('newsletter rendering contract', () => {
  test('flagship masthead is "Waves Newsletter" (no "The", no subtitle, 20px) under the 2026 Waves logo, with the universal footer', () => {
    const html = wrapNewsletter({
      body: '<p>Issue body</p>',
      newsletterType: 'local-weekly-fresh-events',
      unsubscribeUrl: 'https://portal.wavespestcontrol.com/unsubscribe/test-token',
    });
    const masthead = /<img src="([^"]+)" alt="Waves Newsletter" width="(\d+)"/.exec(html);

    // Owner directive 2026-07-28: the retired identities must never
    // resurrect, and dropping the tagline must not leave an empty <p>.
    expect(html).not.toContain('Fresh This Week');
    expect(html).not.toContain('A local weekend guide from the Waves crew');
    expect(html).not.toMatch(/<h1[^>]*>Waves Newsletter<\/h1>\s*<p[^>]*>\s*<\/p>/);

    expect({
      documentTitle: /<title>([^<]+)<\/title>/.exec(html)?.[1],
      visibleHeading: /<h1[^>]*>([^<]+)<\/h1>/.exec(html)?.[1],
      retiredTaglineCount: occurrenceCount(html, 'A local weekend guide from the Waves crew'),
      mastheadUrl: masthead?.[1],
      mastheadWidth: Number(masthead?.[2]),
      // The beehiiv-era masthead ASSET stays retired: header art must never
      // depend on the old beehiiv account's CDN surviving.
      hasBeehiivHostedAsset: /media\.beehiiv\.com/.test(html),
      footerAddressCount: occurrenceCount(html, WAVES_ADDRESS_LINE),
      footerPhoneLinkCount: occurrenceCount(html, `href="tel:${WAVES_SUPPORT_PHONE_E164}"`),
      wavesLogoCount: occurrenceCount(html, 'waves-logo-2026.png'),
      appBadgeCount: (html.match(/app-email\/(?:apple-app-store|google-play)-badge\.png/g) || []).length,
      socialIconCount: occurrenceCount(html, 'app-email/social/'),
      unsubscribeCount: occurrenceCount(html, '>Unsubscribe</a>'),
    }).toMatchInlineSnapshot(`
      {
        "appBadgeCount": 2,
        "documentTitle": "Waves Newsletter",
        "footerAddressCount": 1,
        "footerPhoneLinkCount": 1,
        "hasBeehiivHostedAsset": false,
        "mastheadUrl": "https://portal.wavespestcontrol.com/waves-logo-2026.png",
        "mastheadWidth": 72,
        "retiredTaglineCount": 0,
        "socialIconCount": 5,
        "unsubscribeCount": 1,
        "visibleHeading": "Waves Newsletter",
        "wavesLogoCount": 2,
      }
    `);
  });

  test('non-flagship lanes keep the generic publication masthead', () => {
    const html = wrapNewsletter({
      body: '<p>Issue body</p>',
      unsubscribeUrl: 'https://portal.wavespestcontrol.com/unsubscribe/test-token',
    });

    expect(/<h1[^>]*>([^<]+)<\/h1>/.exec(html)?.[1]).toBe('Waves Newsletter');
    expect(html).not.toContain('A local weekend guide from the Waves crew');
    expect(html).not.toMatch(/media\.beehiiv\.com/);
    expect(html).toContain('alt="Waves Newsletter"');
  });

  test('keeps universal footer copy and social targets readable on mobile', () => {
    const html = wrapNewsletter({
      body: '<p>Issue body</p>',
      unsubscribeUrl: 'https://portal.wavespestcontrol.com/unsubscribe/test-token',
      preferredSourcesCta: true,
      footerNote: 'Footer note',
    });
    const pageBackground = /<body[^>]*background:(#[0-9A-F]{6})/i.exec(html)?.[1];
    const mutedColor = /font-size:14px;letter-spacing:0\.01em;color:(#[0-9A-F]{6});line-height:1\.65/i.exec(html)?.[1];

    expect(pageBackground).toBe('#EDF4FA');
    expect(mutedColor).toBe('#4F5B70');
    expect(contrastRatio(mutedColor, pageBackground)).toBeGreaterThanOrEqual(4.5);
    expect(html).not.toMatch(/font-size:(?:11|12|13)px/);
    expect(html).toContain('padding:4px');
    expect(html).toContain('width="20" height="20"');
  });

  test('dark-mode layer: designed dark overrides + hooks ship on every glass page; only the newsletter opts its cards in', () => {
    const html = wrapNewsletter({ body: '<p>x</p>', newsletterType: 'local-weekly-fresh-events' });
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('[data-ogsc]');
    expect(html).toContain('class="dm-body"');
    expect(html).toContain('class="dm-page"');
    expect(html).toContain('class="dm-card"');
    // Heading darkening is SCOPED to dark-aware cards — transactional
    // emails keep light cards, so their navy headings must stay navy.
    expect(html).toContain('.dm-card h1, .dm-card h2');
    const transactional = wrapEmail({ heading: 'Invoice ready', intro: 'Hi.', lines: [['Total', '$10']] });
    expect(transactional).not.toContain('class="dm-card"');
    // Transactional glass cards force the OPAQUE white fallback in dark
    // mode — rgba would composite over the dark page into a mid-grey.
    expect(transactional).toContain('class="dm-lightcard"');
    expect(transactional).toContain('.dm-lightcard { background: #FFFFFF !important; }');
    expect(transactional).toContain('class="dm-ink"');
    expect(transactional).toContain('class="dm-page-text"');
    // Every anchor inside the dark-aware newsletter card recolors.
    expect(html).toContain('.dm-card a { color: #6CC1F0 !important; }');
    // Logo sits in its own block row ABOVE the masthead title.
    expect(html).toMatch(/<div style="display:block;text-align:center;"><a [^>]+><img [^>]*waves[^>]*><\/a><\/div>\s*<h1 class="dm-ink"/i);
  });

  test('keeps every canonical Waves section theme at WCAG AA contrast', () => {
    const themes = newsletterPalette().sectionHeaders;

    // Owner directive 2026-07-29: Waves blue + gold/yellow ONLY.
    expect(themes).toMatchInlineSnapshot(`
      [
        {
          "accent": "#009CDE",
          "background": "#E3F5FD",
          "name": "waves-blue",
          "text": "#04395E",
        },
        {
          "accent": "#F4B014",
          "background": "#FFF9D6",
          "name": "sunshine",
          "text": "#664500",
        },
      ]
    `);
    for (const theme of themes) {
      expect(contrastRatio(theme.text, theme.background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('renders the theme rotation inline across flagship and Pest Insider sections', async () => {
    const eventHtml = await assembleBeehiivNewsletter({
      selectedSubject: 'Four local picks',
      events: Array.from({ length: 4 }, (_, index) => ({
        eventId: `a0000000-0000-4000-8000-00000000000${index}`,
        title: `Event ${index + 1}`,
        emoji: '🌊',
        description: `Description ${index + 1}`,
      })),
    });
    const pestHtml = await assemblePestInsiderNewsletter({
      crawlHeading: "What's Crawling",
      crawlText: 'Mosquitoes are active.',
      pestOfMonth: { name: 'Mosquito' },
      lawnHeading: 'The Lawn Corner',
      lawnText: 'Watch the turf.',
      mythQuestion: 'Do dryer sheets work?',
      mythVerdict: 'No.',
      pitchHeading: 'Take Back the Yard',
      closingHeading: 'See You Outside',
    });

    expect({
      flagship: renderedThemeNames(eventHtml, 'evt-[^"]+'),
      pestInsider: renderedThemeNames(pestHtml, 'pi-[^"]+'),
    }).toMatchInlineSnapshot(`
      {
        "flagship": [
          "waves-blue",
          "sunshine",
          "waves-blue",
          "sunshine",
        ],
        "pestInsider": [
          "waves-blue",
          "sunshine",
          "waves-blue",
          "sunshine",
          "waves-blue",
          "sunshine",
        ],
      }
    `);
  });
});
