// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DocumentActionBar from './DocumentActionBar';

const shell = vi.hoisted(() => ({ native: false, plugins: false }));
vi.mock('../native/nativeFile', () => ({
  isNativeApp: () => shell.native,
  canSaveNative: () => shell.native && shell.plugins,
  canShareNative: () => shell.native && shell.plugins,
  saveUrlNative: vi.fn(async () => true),
  shareUrlNative: vi.fn(async () => true),
}));

afterEach(cleanup);

// Regression: in an app built before the Filesystem/Share plugins (2026-07-07)
// Download PDF was a bare <a download> that covered the app with the PDF and
// left no way back.
describe('DocumentActionBar Download PDF', () => {
  it.each([
    ['a web browser shows it', false, false, true],
    ['the current app shows it', true, true, true],
    ['an app built before the save plugins hides it', true, false, false],
  ])('%s', (_label, native, plugins, shown) => {
    shell.native = native;
    shell.plugins = plugins;
    render(<DocumentActionBar pdfUrl="/api/service-outlines/tok/pdf" />);
    const download = screen.queryByRole('link', { name: 'Download PDF' });
    if (shown) expect(download).toBeInTheDocument();
    else expect(download).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Portal Login' })).toBeInTheDocument();
  });
});
