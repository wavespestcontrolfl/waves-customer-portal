const Renderer = require('../services/social-card-renderer');

describe('social card renderer', () => {
  test('renders campaign SVG with exact local campaign text', () => {
    const svg = Renderer.renderSocialCardSvg({
      variant: 'campaign',
      city: 'Sarasota',
      service: 'termite',
      topic: 'termite swarm season',
      detail: 'Watch for discarded wings near windows and doors after humid evenings.',
      cta: 'Schedule an inspection',
    });

    expect(svg).toContain('WAVES');
    expect(svg).toContain('SARASOTA');
    expect(svg).toContain('termite swarm');
    expect(svg).toContain('season');
    expect(svg).toContain('Schedule an inspection');
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
    expect(svg).toContain('Helpful, professional, and clear.');
    expect(svg).not.toContain('profilePhoto');
  });

  test('renders JPEG base64 for platform uploads', async () => {
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
