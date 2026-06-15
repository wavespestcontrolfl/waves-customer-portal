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
