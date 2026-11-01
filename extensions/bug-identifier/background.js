// Service worker: the right-click menu, page captures and the toolbar button.
// It never calls the API. It hands photos to the side panel as a `job` in
// chrome.storage.session, tagged with the window it belongs to, and that
// window's panel does the identifying, so the panel is the one place that
// owns results and errors.
import { ImageError, dataUrlToBlob, isValidCrop, toJpegPhoto } from './lib/image.js';

const MENU_IMAGE = 'bugid-image';
const MENU_REGION = 'bugid-region';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_IMAGE, title: 'Identify this bug', contexts: ['image'] });
    chrome.contextMenus.create({
      id: MENU_REGION,
      title: 'Select a bug on this page to identify',
      contexts: ['page', 'frame', 'selection', 'link', 'video'],
    });
  });
});

// Chrome and Edge show panel.html in the side panel. Firefox has no sidePanel
// API: its build declares panel.html as the sidebar (scripts/package.mjs), and
// the toolbar button and the menu items open that sidebar instead.
const firefoxSidebar = globalThis.browser?.sidebarAction;

// The toolbar button opens the panel.
if (chrome.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else if (firefoxSidebar) {
  chrome.action.onClicked.addListener(() => {
    firefoxSidebar.toggle().catch(() => {});
  });
}

// Both open calls only work inside the user gesture, so call this before any await.
function openPanel(tab) {
  if (chrome.sidePanel) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  else if (firefoxSidebar) firefoxSidebar.open().catch(() => {});
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  openPanel(tab);
  if (info.menuItemId === MENU_IMAGE) identifyImage(info, tab);
  if (info.menuItemId === MENU_REGION) startRegionSelect(tab);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || !message) return;
  if (message.type === 'bugid:start-region' && Number.isInteger(message.windowId)) {
    startRegionInWindow(message.windowId);
  } else if (message.type === 'bugid:region' && sender.tab) {
    captureRegion(sender.tab, message.rect);
  } else if (message.type === 'bugid:region-cancel' && sender.tab) {
    setJob(sender.tab.windowId, { status: 'cancelled' });
  }
});

function setJob(windowId, job) {
  return chrome.storage.session.set({ job: { ...job, windowId, at: Date.now() } });
}

function failJob(windowId, err) {
  return setJob(windowId, { status: 'error', error: err instanceof ImageError ? err.code : 'capture_failed' });
}

async function identifyImage(info, tab) {
  await setJob(tab.windowId, { status: 'working', step: 'image' });
  try {
    const photo = await photoFromUrl(info.srcUrl);
    if (photo) {
      await setJob(tab.windowId, { status: 'ready', photo });
      return;
    }
    // The image host would not hand the file to the extension (no CORS), so
    // capture it from the screen instead. Images inside frames, or ones the
    // page swapped out, fall back to the drag-a-box selector.
    const rect = info.frameId ? null : await locateImage(tab.id, info.srcUrl);
    if (!rect) {
      await startRegionSelect(tab, 'not_found');
      return;
    }
    await setJob(tab.windowId, { status: 'ready', photo: await captureVisible(tab, rect) });
  } catch (err) {
    await failJob(tab.windowId, err);
  }
}

// Resolves a photo, or null when the URL cannot be fetched (try a capture).
async function photoFromUrl(srcUrl) {
  if (typeof srcUrl !== 'string') return null;
  if (srcUrl.startsWith('data:image/')) return toJpegPhoto(dataUrlToBlob(srcUrl));
  if (!/^https?:\/\//i.test(srcUrl)) return null;
  let blob;
  try {
    const res = await fetch(srcUrl, { credentials: 'omit' });
    if (!res.ok) return null;
    blob = await res.blob();
  } catch {
    return null;
  }
  try {
    return await toJpegPhoto(blob);
  } catch (err) {
    if (err instanceof ImageError && err.code === 'too_small') throw err;
    return null;
  }
}

async function locateImage(tabId, srcUrl) {
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: findImageRect, args: [srcUrl] });
    const rect = injection && injection.result;
    return isValidCrop(rect) ? rect : null;
  } catch {
    return null;
  }
}

// Runs in the page: scroll the right-clicked image into view and measure it.
// Self-contained, because chrome.scripting serializes it.
async function findImageRect(srcUrl) {
  const img = Array.from(document.images).find((el) => el.currentSrc === srcUrl || el.src === srcUrl);
  if (!img) return null;
  const box = img.getBoundingClientRect();
  if (box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth) {
    img.scrollIntoView({ block: 'center', inline: 'center' });
  }
  // Let the scroll, and the side panel opening beside the page, settle.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const r = img.getBoundingClientRect();
  const x = Math.max(0, r.left);
  const y = Math.max(0, r.top);
  const width = Math.min(innerWidth, r.right) - x;
  const height = Math.min(innerHeight, r.bottom) - y;
  if (width < 8 || height < 8) return null;
  return { x, y, width, height, viewportW: innerWidth };
}

async function startRegionInWindow(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab || typeof tab.id !== 'number') {
    await setJob(windowId, { status: 'error', error: 'page_blocked' });
    return;
  }
  await startRegionSelect(tab);
}

async function startRegionSelect(tab, reason = null) {
  await setJob(tab.windowId, { status: 'selecting', reason });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/select-region.js'] });
  } catch {
    // chrome:// pages, the Web Store, or a tab this extension was not invoked on.
    await setJob(tab.windowId, { status: 'error', error: 'page_blocked' });
  }
}

async function captureRegion(tab, rect) {
  if (!isValidCrop(rect)) {
    await setJob(tab.windowId, { status: 'error', error: 'capture_failed' });
    return;
  }
  await setJob(tab.windowId, { status: 'working', step: 'capture' });
  try {
    await setJob(tab.windowId, { status: 'ready', photo: await captureVisible(tab, rect) });
  } catch (err) {
    await failJob(tab.windowId, err);
  }
}

// captureVisibleTab takes whatever tab the window shows now. Capture only while
// that is still the tab the user picked from, so a tab switch during the image
// fetch or the scroll never sends another page (Codex #7295 r1).
async function captureVisible(tab, rect) {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!active || active.id !== tab.id) throw new ImageError('tab_changed');
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return toJpegPhoto(dataUrlToBlob(dataUrl), rect);
}
