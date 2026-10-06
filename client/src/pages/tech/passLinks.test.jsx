// @vitest-environment jsdom
// The pass link is taken as the text wrote it: only sentence punctuation around
// it is dropped. Synthetic data only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { withPassLinks } from './passLinks';

afterEach(cleanup);

const hrefOf = (text) => {
  cleanup();
  render(<p>{withPassLinks(text)}</p>);
  return screen.getByRole('link', { name: 'Open visitor pass' }).getAttribute('href');
};

describe('withPassLinks', () => {
  it('keeps a "!" the link ends in and a balanced bracket pair', () => {
    expect(hrefOf('Your pass: https://pass.example.com/v/abc!')).toBe('https://pass.example.com/v/abc!');
    expect(hrefOf('Your pass: https://pass.example.com/v/a_(b)')).toBe('https://pass.example.com/v/a_(b)');
    expect(hrefOf('Your pass: https://pass.example.com/v?x=[1]')).toBe('https://pass.example.com/v?x=[1]');
  });

  it('reads the https scheme in any letter case', () => {
    expect(hrefOf('Your pass: HTTPS://pass.example.com/v/abc')).toBeTruthy();
  });

  it('drops a sentence period or comma, and a closing bracket the link did not open', () => {
    expect(hrefOf('Show https://pass.example.com/v/abc.')).toBe('https://pass.example.com/v/abc');
    expect(hrefOf('Show https://pass.example.com/v/abc, then go in')).toBe('https://pass.example.com/v/abc');
    expect(hrefOf('(pass: https://pass.example.com/v/abc).')).toBe('https://pass.example.com/v/abc');
    expect(hrefOf('Show https://pass.example.com/v/abc; then go in')).toBe('https://pass.example.com/v/abc');
    expect(hrefOf('Pass https://pass.example.com/v/abc: tap it')).toBe('https://pass.example.com/v/abc');
    expect(hrefOf('Got it at https://pass.example.com/v/abc?')).toBe('https://pass.example.com/v/abc');
  });

  it('leaves http, javascript and plain text alone', () => {
    expect(withPassLinks('Scan the QR at the guard house')).toBe('Scan the QR at the guard house');
    expect(withPassLinks('http://pass.example.com/v/x')).toBe('http://pass.example.com/v/x');
    expect(withPassLinks('javascript:alert(1)')).toBe('javascript:alert(1)');
  });
});
