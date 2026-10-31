// Side panel: takes a photo (chosen, dropped, pasted, or handed over by the
// service worker from the right-click menu), asks the Waves API what it is,
// and renders the answer.
import { MAX_PHOTOS, PRIVACY_URL } from './lib/config.js';
import { IdentifyError, identify } from './lib/api.js';
import { ImageError, toJpegPhoto } from './lib/image.js';
import { renderResult } from './lib/render.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['start', 'status', 'error', 'result'];
const JOB_MAX_AGE_MS = 10 * 60 * 1000;

const IMAGE_ERRORS = {
  unreadable: "We couldn't open that image. Try saving it to your computer and choosing it here.",
  too_small: 'That image is too small to identify. Try a bigger photo, or a closer one.',
  page_blocked: "Chrome didn't let the extension capture this page. Right-click the page and choose “Select a bug on this page to identify”, or choose a photo instead. Pages like chrome:// and the Chrome Web Store can't be captured.",
  capture_failed: "We couldn't capture that. Please try again, or choose a photo instead.",
};
const API_ERRORS = {
  unavailable: "Bug identification isn't available yet. Please check back soon.",
  network: "We can't reach Waves right now. Check your connection and try again.",
  timeout: 'That took too long. Please try again.',
  busy: 'Bug identification is briefly unavailable. Please try again in a few minutes.',
  bad_photo: 'Please choose a JPEG, PNG or WebP photo of the bug.',
  too_large: 'That photo is too large. Please try a smaller one.',
  server: 'Something went wrong on our end. Please try again.',
};
// Worth retrying with the same photos.
const TRANSIENT = new Set(['network', 'timeout', 'busy', 'server']);

const state = {
  windowId: null,
  photos: [], // the photos behind the result on screen
  appendAsk: null, // set while the user adds a confirming photo
  retryPhotos: null,
  busy: false,
  lastView: 'start',
};

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
  if (view === 'start' || view === 'result') state.lastView = view;
  window.scrollTo(0, 0);
}

function showStatus(text, spinning) {
  $('status-text').textContent = text;
  $('spinner').hidden = !spinning;
  show('status');
}

function showError(text, retryPhotos = null) {
  state.retryPhotos = retryPhotos;
  $('error-text').textContent = text;
  $('error-retry').textContent = retryPhotos ? 'Try again' : 'Start over';
  show('error');
}

function setAppendAsk(ask) {
  state.appendAsk = ask;
  $('append-note').textContent = ask ? `Add one more photo: ${ask}` : '';
  $('append-note').hidden = !ask;
}

function reset() {
  state.photos = [];
  setAppendAsk(null);
  show('start');
}

function apiErrorMessage(err) {
  if (!(err instanceof IdentifyError)) return API_ERRORS.server;
  if (err.kind === 'limit') return err.serverMessage || 'Please try again later.';
  return API_ERRORS[err.kind] || API_ERRORS.server;
}

async function run(photos) {
  if (state.busy) return;
  state.busy = true;
  showStatus(photos.length > 1 ? 'Checking your photos…' : 'Identifying your bug…', true);
  try {
    const result = await identify(photos.map(({ data, mimeType }) => ({ data, mimeType })));
    state.photos = photos;
    setAppendAsk(null);
    renderResult($('result'), result, {
      photos,
      canAddPhoto: photos.length < MAX_PHOTOS,
      onAddPhoto: (nextPhoto) => {
        setAppendAsk(nextPhoto.ask || 'a closer, sharper photo of the same bug.');
        show('start');
      },
      onReset: reset,
    });
    show('result');
  } catch (err) {
    showError(apiErrorMessage(err), err instanceof IdentifyError && TRANSIENT.has(err.kind) ? photos : null);
  } finally {
    state.busy = false;
  }
}

function acceptPhoto(photo) {
  run(state.appendAsk ? [...state.photos, photo].slice(-MAX_PHOTOS) : [photo]);
}

async function acceptFile(file) {
  if (!file) return;
  showStatus('Reading your photo…', true);
  try {
    acceptPhoto(await toJpegPhoto(file));
  } catch (err) {
    showError(IMAGE_ERRORS[err instanceof ImageError ? err.code : 'unreadable'] || IMAGE_ERRORS.unreadable);
  }
}

// ── jobs handed over by the service worker (right-click menu, page capture) ──

function clearJob() {
  return chrome.storage.session.remove('job');
}

async function handleJob(job) {
  if (!job || typeof job !== 'object' || job.windowId !== state.windowId) return;
  if (typeof job.at !== 'number' || Date.now() - job.at > JOB_MAX_AGE_MS) {
    await clearJob();
    return;
  }
  if (job.status === 'working') {
    showStatus(job.step === 'capture' ? 'Capturing the bug…' : 'Getting the image…', true);
  } else if (job.status === 'selecting') {
    showStatus(job.reason === 'not_found'
      ? "We couldn't grab that image directly. Drag a box around the bug on the page instead, or press Esc to cancel."
      : 'Drag a box around the bug on the page. Press Esc to cancel.', false);
  } else if (job.status === 'cancelled') {
    await clearJob();
    show(state.lastView);
  } else if (job.status === 'error') {
    await clearJob();
    showError(IMAGE_ERRORS[job.error] || IMAGE_ERRORS.capture_failed);
  } else if (job.status === 'ready') {
    await clearJob();
    if (job.photo && typeof job.photo.data === 'string') acceptPhoto(job.photo);
  }
}

// ── inputs ──

function wireInputs() {
  const drop = $('drop');
  const file = $('file');
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      file.click();
    }
  });
  file.addEventListener('change', () => {
    const [chosen] = file.files;
    file.value = '';
    acceptFile(chosen);
  });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('dragging');
    const dropped = Array.from(event.dataTransfer.files).find((f) => f.type.startsWith('image/'));
    if (dropped) acceptFile(dropped);
    else showError('Drop an image file here, or right-click an image on the page and choose “Identify this bug”.');
  });
  document.addEventListener('paste', (event) => {
    const item = Array.from(event.clipboardData ? event.clipboardData.items : []).find((i) => i.type.startsWith('image/'));
    if (item) acceptFile(item.getAsFile());
  });
  $('select').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'bugid:start-region', windowId: state.windowId });
  });
  $('error-retry').addEventListener('click', () => {
    if (state.retryPhotos) run(state.retryPhotos);
    else show(state.lastView);
  });
  $('privacy').href = PRIVACY_URL;
}

async function init() {
  wireInputs();
  state.windowId = (await chrome.windows.getCurrent()).id;
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.job) handleJob(changes.job.newValue);
  });
  const { job } = await chrome.storage.session.get('job');
  handleJob(job);
}

init();
