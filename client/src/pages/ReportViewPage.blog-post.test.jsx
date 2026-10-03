// @vitest-environment jsdom
// "From the Waves blog" (GATE_REPORT_BLOG_POST): the post picked at
// completion, at the bottom of the live report, opening the live article.
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
  it('links the picked post by its title, with where it lives', () => {
    render(<BlogPostCard data={{ blogPost: POST }} mode="live" />);
    expect(screen.getByRole('heading', { name: 'From the Waves blog' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: POST.title });
    expect(link).toHaveAttribute('href', POST.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('wavespestcontrol.com/pest-control/get-rid-of-ghost-ants-in-sarasota/')).toBeInTheDocument();
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
