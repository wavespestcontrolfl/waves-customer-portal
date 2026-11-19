// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import SafeMarkdown from './SafeMarkdown';

afterEach(cleanup);

describe('SafeMarkdown', () => {
  it('renders headings, lists and bold as elements', () => {
    const { container } = render(
      <MemoryRouter>
        <SafeMarkdown markdown={'# Offer\n\nStart **Monday**.\n\n- one\n- two\n\n1. first'} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Offer' })).toBeInTheDocument();
    expect(container.querySelector('strong')).toHaveTextContent('Monday');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(1);
  });

  it('drops a trailing heading anchor and links only https targets', () => {
    const { container } = render(
      <SafeMarkdown markdown={'## 3. Pay {#pay}\n\nSee [terms](https://example.com/t) or [bad](http://example.com).'} />,
    );
    expect(screen.getByRole('heading', { name: '3. Pay' })).toBeInTheDocument();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com/t');
    expect(container).toHaveTextContent('[bad](http://example.com)');
  });

  it('never turns raw HTML or an unsafe link into elements', () => {
    const { container } = render(
      <MemoryRouter>
        <SafeMarkdown markdown={'<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n[click](javascript:alert(1))'} />
      </MemoryRouter>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('<script>alert(1)</script>');
    expect(container).toHaveTextContent('[click](javascript:alert(1))');
  });
});
