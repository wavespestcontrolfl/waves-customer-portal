// @vitest-environment jsdom
// "From the Waves blog" (GATE_REPORT_BLOG_POST): the post picked at
// completion, under the status card of the live report, opening the live
// article. Owner 2026-10-22: it shows the post's main image and never the
// raw URL.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BlogPostCard } from './ReportViewPage';

const POST = {
  title: 'How to Get Rid of Ghost Ants in Sarasota Without Losing Your Mind',
  url: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-ghost-ants-in-sarasota/',
};

afterEach(cleanup);

describe('BlogPostCard', () => {
  it('links the picked post by its title, and never prints the raw URL', () => {
    render(<BlogPostCard data={{ blogPost: POST }} mode="live" />);
    expect(screen.getByRole('heading', { name: 'From the Waves blog' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: POST.title });
    expect(link).toHaveAttribute('href', POST.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByText(/wavespestcontrol\.com\/pest-control/)).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows the post\'s main image inside the link when the payload has one', () => {
    const imageUrl = 'https://www.wavespestcontrol.com/images/2025/11/ghost-ants.webp';
    const { container } = render(<BlogPostCard data={{ blogPost: { ...POST, imageUrl } }} mode="live" />);
    const img = container.querySelector('a.blog-post-link img.blog-post-image');
    expect(img).toHaveAttribute('src', imageUrl);
    expect(screen.getByRole('link', { name: POST.title })).toHaveAttribute('href', POST.url);
  });

  it('drops an image URL that is not https', () => {
    const { container } = render(<BlogPostCard data={{ blogPost: { ...POST, imageUrl: 'javascript:alert(1)' } }} mode="live" />);
    expect(container.querySelector('img')).toBeNull();
  });

  it.each([
    ['no post', {}, 'live'],
    ['a post without a title', { blogPost: { ...POST, title: '' } }, 'live'],
    ['a post with a broken URL', { blogPost: { ...POST, url: 'not a url' } }, 'live'],
    ['the PDF view', { blogPost: POST }, 'pdf'],
  ])('%s renders nothing', (_label, data, mode) => {
    const { container } = render(<BlogPostCard data={data} mode={mode} />);
    expect(container).toBeEmptyDOMElement();
  });
});
