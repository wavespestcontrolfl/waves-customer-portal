const Renderer = require('../services/social-card-renderer');

describe('social card renderer', () => {
  test('renders campaign SVG with brand palette and local campaign text', () => {
    const svg = Renderer.renderSocialCardSvg({
      variant: 'campaign',
      city: 'Sarasota',
      service: 'termite',
      topic: 'termite swarm season',
      detail: 'Watch for discarded wings near windows and doors after humid evenings.',
      cta: 'Schedule an inspection',
    });

    expect(svg).toContain('SARASOTA');
    // headline words survive wrapping
    expect(svg).toContain('termite');
    expect(svg).toContain('season');
    // CTA is uppercased per brand identity
    expect(svg).toContain('SCHEDULE AN INSPECTION');
    expect(svg).toContain('wavespestcontrol.com');
    // brand palette: Waves Blue + Gold, and explicitly NOT the old teal
    expect(svg).toContain('#009CDE');
    expect(svg).toContain('#FFD700');
    expect(svg).not.toMatch(/#007f83/i);
  });

  test('renders privacy-safe review SVG without profile-photo dependence', () => {
    const svg = Renderer.renderSocialCardSvg({
      variant: 'review',
      city: 'Bradenton',
      reviewerDisplayName: 'Jessica, Bradenton',
      excerpt: 'Helpful, professional, and clear.',
    });

    expect(svg).toContain('5-STAR GOOGLE REVIEW');
    expect(svg).toContain('Jessica, Bradenton');
    // excerpt words survive wrapping
    expect(svg).toContain('Helpful');
    expect(svg).toContain('professional');
    expect(svg).not.toContain('profilePhoto');
  });

  test('renders a brand blog-share card from a post title + excerpt', () => {
    const svg = Renderer.renderSocialCardSvg({
      variant: 'blog',
      title: 'Sand Fleas in Southwest Florida: What is Actually Biting You',
      excerpt: 'Those itchy welts after the beach usually are not sand fleas at all — here is what is really biting.',
      cta: 'Read the full guide',
    });

    expect(svg).toContain('FROM THE WAVES BLOG');
    expect(svg).toContain('Sand'); // title word survives wrapping
    expect(svg).toContain('really'); // excerpt word survives wrapping
    expect(svg).toContain('READ THE FULL GUIDE'); // uppercase brand CTA
    expect(svg).toContain('#009CDE');
    expect(svg).not.toMatch(/#007f83/i);
  });

  test('renders a split-panel versus card with both pests, VS badge, and verdict', () => {
    const svg = Renderer.renderSocialCardSvg({
      variant: 'versus',
      city: 'Venice',
      service: 'Termite',
      left: { name: 'Termite Swarmer', points: ['Straight antennae', 'Both wing pairs equal length', 'Thick, straight waist'] },
      right: { name: 'Winged Ant', points: ['Bent antennae', 'Front wings longer than back', 'Pinched waist'] },
      verdict: 'Wings on the windowsill? Check the waist first.',
    });

    expect(svg).toContain('VENICE');
    expect(svg).toContain('PEST ID: KNOW THE DIFFERENCE');
    expect(svg).toContain('Termite Swarmer');
    expect(svg).toContain('Winged Ant');
    expect(svg).toContain('>VS</text>');
    expect(svg).toContain('Straight antennae');
    expect(svg).toContain('Pinched waist');
    expect(svg).toContain('windowsill?'); // verdict words survive wrapping
    expect(svg).toContain('wavespestcontrol.com');
    expect(svg).toContain('#009CDE');
    expect(svg).not.toMatch(/#007f83/i);
  });

  test('versus card escapes untrusted pest names and renders 4:3 for GBP', () => {
    const svg = Renderer.renderSocialCardSvg({
      variant: 'versus',
      platform: 'gbp',
      left: { name: 'A<script>alert(1)</script>', points: ['x & y'] },
      right: { name: 'B', points: [] },
      verdict: '"Quotes" too',
    });
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="900"');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('x &amp; y');
  });

  test('sizes the card per platform (square for IG/FB, 4:3 for GBP)', () => {
    const square = Renderer.renderSocialCardSvg({ variant: 'campaign', topic: 'x', platform: 'instagram' });
    expect(square).toContain('width="1080"');
    expect(square).toContain('height="1080"');

    const gbp = Renderer.renderSocialCardSvg({ variant: 'campaign', topic: 'x', platform: 'gbp' });
    expect(gbp).toContain('width="1200"');
    expect(gbp).toContain('height="900"');

    expect(Renderer.PLATFORM_SIZES.gbp).toEqual({ w: 1200, h: 900 });
  });

  test('renders optimized JPEG base64 for platform uploads', async () => {
    const base64 = await Renderer.renderSocialCardJpegBase64({
      variant: 'campaign',
      city: 'Venice',
      service: 'mosquito',
      topic: 'mosquito surge after afternoon storms',
      detail: 'Standing water and dense shade can push mosquito pressure up quickly.',
      cta: 'Request an estimate',
    });

    expect(base64.length).toBeGreaterThan(1000);
    expect(base64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('photo card overlays (creative engine)', () => {
  test('campaign overlay carries brand chrome but no opaque card ground', () => {
    const svg = Renderer.renderPhotoOverlaySvg({
      variant: 'photo',
      city: 'Sarasota',
      service: 'general pest',
      topic: 'Peak summer pest pressure',
      cta: 'Book inspection',
      platform: 'square',
    });

    expect(svg).toContain('SARASOTA');
    expect(svg).toContain('GENERAL PEST');
    expect(svg).toContain('BOOK INSPECTION'); // CTA uppercased per brand
    expect(svg).toContain('wavespestcontrol.com');
    // legibility scrims exist…
    expect(svg).toContain('scrimBottom');
    expect(svg).toContain('scrimTop');
    // …but the photo must show through: no sand/white full-bleed ground
    expect(svg).not.toContain(`fill="${Renderer.COLORS.sand}"`);
    expect(svg).toContain('#FFD700'); // gold CTA/accents survive
  });

  test('review overlay shows stars, quote, reviewer, and privacy note', () => {
    const svg = Renderer.renderPhotoOverlaySvg({
      variant: 'photo_review',
      city: 'Venice',
      reviewerDisplayName: 'Karen, Venice',
      excerpt: 'Great local team, responsive and thorough.',
      platform: 'square',
    });

    expect(svg).toContain('5-STAR GOOGLE REVIEW');
    expect((svg.match(/#FFC400/g) || []).length).toBeGreaterThanOrEqual(5); // 5 stars
    expect(svg).toContain('Great local team');
    expect(svg).toContain('Karen, Venice');
    expect(svg).toContain('privacy-safe display');
  });

  test('escapes untrusted text in overlays', () => {
    const svg = Renderer.renderPhotoOverlaySvg({
      variant: 'photo',
      topic: 'ants & roaches <script>alert(1)</script>',
      city: 'Sarasota',
      platform: 'square',
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&amp;');
  });

  test('composites a background into platform-sized JPEGs', async () => {
    const sharp = require('sharp');
    const background = await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 60, g: 120, b: 180 } },
    }).jpeg().toBuffer();

    const square = await Renderer.renderPhotoCardJpegBase64(
      { variant: 'photo', city: 'Sarasota', topic: 'Chinch bug pressure', cta: 'Request estimate' },
      { platform: 'square', backgroundBase64: background.toString('base64') }
    );
    const gbp = await Renderer.renderPhotoCardJpegBase64(
      { variant: 'photo_review', city: 'Venice', excerpt: 'Five stars.', reviewerDisplayName: 'K., Venice' },
      { platform: 'gbp', backgroundBase64: background.toString('base64') }
    );

    const squareMeta = await sharp(Buffer.from(square, 'base64')).metadata();
    expect([squareMeta.width, squareMeta.height]).toEqual([1080, 1080]);
    const gbpMeta = await sharp(Buffer.from(gbp, 'base64')).metadata();
    expect([gbpMeta.width, gbpMeta.height]).toEqual([1200, 900]);
  });

  test('refuses to render a photo card without a background', async () => {
    await expect(
      Renderer.renderPhotoCardJpegBase64({ variant: 'photo', topic: 'x' }, { platform: 'square' })
    ).rejects.toThrow(/backgroundBase64/);
  });
});

describe('milestone card', () => {
  test('renders the review count, star row, average, and thank-you line', () => {
    const svg = Renderer.renderSocialCardSvg({
      variant: 'milestone', city: 'Sarasota', count: 1000, averageRating: 4.9, thanks: 'Thank you, Southwest Florida.',
    });
    expect(svg).toContain('MILESTONE');
    expect(svg).toContain('>1,000</text>');
    expect(svg).toContain('GOOGLE REVIEWS');
    expect(svg).toContain('4.9 average rating');
    expect(svg).toContain('Southwest'); // thanks line survives wrapping
    expect(svg).toContain('#FFC400'); // star fill
    expect(svg).not.toMatch(/#007f83/i);
  });

  test('milestone card omits the average when none is supplied and sizes for GBP', () => {
    const svg = Renderer.renderSocialCardSvg({ variant: 'milestone', count: 250, platform: 'gbp' });
    expect(svg).toContain('width="1200"');
    expect(svg).not.toContain('average rating');
    expect(svg).toContain('>250</text>');
  });
});
