// @vitest-environment jsdom
// A part of a staff page whose code the live build no longer serves shows a
// Reload prompt in its place, while open or held work keeps the tab; the rest
// of the page and the staff layout stay. The prompt reloads like the Reload
// bar: it names what holds the tab and asks once about the page first.
import React, { Suspense } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { lazyPanel } from './LazyPanel';
import { registerReloadHold } from '../lib/reloadHolds';
import { noteServerAnswer, resetPortalVersionForTests } from '../lib/portalVersion';
import { CHUNK_RELOAD_FLAG, handleVitePreloadError, resetStaleChunkReloadForTests } from '../lib/staleChunkReload';

let holding = false;
registerReloadHold('card-payment', () => holding);
let reload;

const PROMPT = 'This part of the page did not load: the portal has a new version.';
const CONNECTION = 'This part of the page did not load. Check your connection and try again.';

// The server names a newer build than this page loaded, as after a deploy
// (lib/portalVersion.js). Only then does the prompt say new version.
function nameNewerBuild() {
  act(() => { noteServerAnswer(new Headers({ 'X-Portal-Build': 'bbb222bbb222', 'X-Portal-Boot': '2000' })); });
}

// A tap as a browser sends it: pointerdown, then click.
function tap(element) {
  fireEvent.pointerDown(element);
  fireEvent.click(element);
}

function missingChunk() {
  return Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/Panel-old.js'));
}

// Stands in for App.jsx's boundary around the whole route tree.
class RouteTreeBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() { return this.state.error ? <p>Route tree crashed: {this.state.error.message}</p> : this.props.children; }
}

function renderPage(Panel, path = '/admin/customers') {
  vi.stubGlobal('location', { ...window.location, pathname: path, reload });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RouteTreeBoundary>
        <input aria-label="Note" />
        <p>Page body</p>
        <Suspense fallback={<p>Opening...</p>}><Panel /></Suspense>
      </RouteTreeBoundary>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  holding = false;
  reload = vi.fn();
  sessionStorage.clear();
  resetStaleChunkReloadForTests();
  resetPortalVersionForTests();
  // The build this page loaded; no answer names a newer one until a test does.
  document.head.insertAdjacentHTML('beforeend', '<meta name="portal-build" content="aaa111aaa111">');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  document.head.querySelectorAll('meta[name="portal-build"]').forEach((el) => el.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a part whose code is missing on a held staff tab shows a Reload prompt in its place, and the rest of the page stays', async () => {
  holding = true;
  nameNewerBuild();
  renderPage(lazyPanel(missingChunk));
  expect(await screen.findByText(PROMPT)).toBeInTheDocument();
  expect(screen.getByText('Page body')).toBeInTheDocument();
  expect(screen.queryByText(/Route tree crashed/)).not.toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
});

test('offline, the prompt says the device is offline, not that the portal has a new version', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  nameNewerBuild();
  renderPage(lazyPanel(missingChunk));
  expect(await screen.findByText('This part of the page did not load: this device is offline.')).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
});

// A chunk can also fail from an asset fault or an outage. The prompt says new
// version only when an answer names a newer build, as the Reload bar does.
test('with no newer build named, the prompt asks to check the connection; once an answer names one, it says new version', async () => {
  renderPage(lazyPanel(missingChunk));
  expect(await screen.findByText(CONNECTION)).toBeInTheDocument();
  expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
  nameNewerBuild();
  expect(screen.getByText(PROMPT)).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
});

test('after the one reload for a missing chunk, the prompt asks to check the connection, even with a newer build named', async () => {
  sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
  nameNewerBuild();
  renderPage(lazyPanel(missingChunk));
  expect(await screen.findByText(CONNECTION)).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
});

test('its first Reload asks about the page and names what holds the tab; Reload anyway then reloads', async () => {
  holding = true;
  renderPage(lazyPanel(missingChunk));
  tap(await screen.findByRole('button', { name: 'Reload' }));
  expect(screen.getByText('A card payment is still going through. Anything not saved on this page will be lost.')).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
  // A tap on the prompt itself is no use of the page, so it never clears
  // what the prompt named.
  tap(screen.getByRole('button', { name: 'Reload anyway' }));
  expect(reload).toHaveBeenCalledTimes(1);
});

test('a use of the page after the prompt named its work clears the names, so the next Reload asks again', async () => {
  nameNewerBuild();
  renderPage(lazyPanel(missingChunk));
  tap(await screen.findByRole('button', { name: 'Reload' }));
  expect(screen.getByText('Anything not saved on this page will be lost.')).toBeInTheDocument();
  fireEvent.input(screen.getByLabelText('Note'), { target: { value: 'more' } });
  expect(screen.getByText(PROMPT)).toBeInTheDocument();
  tap(screen.getByRole('button', { name: 'Reload' }));
  expect(reload).not.toHaveBeenCalled();
  tap(screen.getByRole('button', { name: 'Reload anyway' }));
  expect(reload).toHaveBeenCalledTimes(1);
});

test('while the stale-chunk reload is under way, a part whose import it swallowed shows the loading line, not a crash; it says new version once an answer names one', async () => {
  vi.stubGlobal('location', { ...window.location, pathname: '/admin/customers', reload });
  handleVitePreloadError(new Event('vite:preloadError', { cancelable: true }), reload);
  expect(reload).toHaveBeenCalledTimes(1);
  renderPage(lazyPanel(() => Promise.resolve(undefined)));
  expect(await screen.findByText('Loading...')).toBeInTheDocument();
  expect(screen.queryByText(/Route tree crashed/)).not.toBeInTheDocument();
  nameNewerBuild();
  expect(screen.getByText('Loading the new version...')).toBeInTheDocument();
});

test('a part that loads renders as usual', async () => {
  renderPage(lazyPanel(() => Promise.resolve({ default: () => <p>Revenue panel</p> })));
  expect(await screen.findByText('Revenue panel')).toBeInTheDocument();
});

test('on a customer page, a part whose code is missing throws to the route tree boundary, as before', async () => {
  renderPage(lazyPanel(missingChunk), '/');
  expect(await screen.findByText(/Route tree crashed: Failed to fetch dynamically imported module/)).toBeInTheDocument();
});

test('an error that is not missing code throws to the route tree boundary, as before', async () => {
  renderPage(lazyPanel(() => Promise.reject(new Error('panel bug'))));
  expect(await screen.findByText('Route tree crashed: panel bug')).toBeInTheDocument();
});
