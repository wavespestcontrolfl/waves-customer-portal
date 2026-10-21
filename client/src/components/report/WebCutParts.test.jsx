// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FooterIdentity, PrintOnly, webCutView } from './WebCutParts';

afterEach(cleanup);

describe('webCutView', () => {
  it('applies only to the web view with a webTop object (even an empty one)', () => {
    expect(webCutView(true, { webTop: {} })).toEqual({ on: true, rootClass: ' is-cut', printOnly: ' doc-print-only' });
    expect(webCutView(true, {})).toEqual({ on: false, rootClass: '', printOnly: '' });
    expect(webCutView(false, { webTop: { action: 'x' } })).toEqual({ on: false, rootClass: '', printOnly: '' });
    expect(webCutView(true, null).on).toBe(false);
  });
});

describe('PrintOnly', () => {
  it('with the trim: the div carries doc-print-only beside its own classes', () => {
    const { container } = render(<PrintOnly cut={{ on: true }} className="doc-keep" data-glass="card">x</PrintOnly>);
    expect(container.firstChild.className).toBe('doc-keep doc-print-only');
    expect(container.firstChild.getAttribute('data-glass')).toBe('card');
  });
  it('without the trim: exactly the plain div, no class attribute at all (the PDF markup)', () => {
    const { container } = render(<PrintOnly cut={{ on: false }}>x</PrintOnly>);
    expect(container.innerHTML).toBe('<div>x</div>');
    const withClass = render(<PrintOnly cut={{ on: false }} className="doc-keep">x</PrintOnly>);
    expect(withClass.container.innerHTML).toBe('<div class="doc-keep">x</div>');
  });
});

describe('FooterIdentity', () => {
  it('prints the identity line; with the trim it sits in a print-only span', () => {
    const plain = render(<p><FooterIdentity cut={{ on: false }} /></p>).container;
    expect(plain.querySelector('.doc-print-only')).toBeNull();
    expect(plain.textContent).toMatch(/Family-owned pest control and lawn care in Southwest Florida/);
    cleanup();
    const cut = render(<p><FooterIdentity cut={{ on: true }} /></p>).container;
    expect(cut.querySelector('span.doc-print-only').textContent).toMatch(/Family-owned pest control/);
  });
});
