// Resilient Stripe.js loader — shared by every payment surface.
//
// Replaces six hand-rolled `<script>` injectors that each had a fatal flaw:
//   - PayPageV2 / OnboardingPage cached the load promise and, on the FIRST
//     failure, cached the *rejection* forever — wedging the page until a full
//     browser reload (the real-world "Failed to load Stripe" + reload-4×
//     symptom seen on the invoice pay page).
//   - AutopayCard / MobileManualCardSheet / PortalPage had no `onerror` at all,
//     so a failed load hung the await forever (permanent spinner).
//
// This loader is built to survive a flaky mobile network:
//   - never caches a rejection (next call retries fresh),
//   - auto-retries with a timeout so a transient blip self-heals silently,
//   - reuses an already-loaded SDK (window.Stripe) instead of re-injecting,
//   - removes a failed <script> tag so attempts don't pile up.

const STRIPE_JS_SRC = 'https://js.stripe.com/v3/';
const LOAD_TIMEOUT_MS = 12000; // hung load (neither load nor error fires) → give up + retry
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 600;

// Shared in-flight/successful load. Reset to null on failure so a rejection is
// NEVER cached — the next caller starts a clean attempt.
let sdkPromise = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One attempt: inject the script, resolve with the Stripe constructor.
function injectOnce() {
  return new Promise((resolve, reject) => {
    if (window.Stripe) {
      resolve(window.Stripe);
      return;
    }

    const script = document.createElement('script');
    script.src = STRIPE_JS_SRC;
    script.async = true;
    script.setAttribute('data-stripe-js', 'true');

    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      fn();
    };

    const removeTag = () => {
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    const timer = setTimeout(() => finish(() => {
      removeTag();
      reject(new Error('Stripe.js load timed out'));
    }), LOAD_TIMEOUT_MS);

    script.onload = () => finish(() => {
      if (window.Stripe) resolve(window.Stripe);
      else { removeTag(); reject(new Error('Stripe.js loaded but window.Stripe is unavailable')); }
    });

    script.onerror = () => finish(() => {
      removeTag();
      reject(new Error('Failed to load Stripe'));
    });

    document.head.appendChild(script);
  });
}

async function loadWithRetry() {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await injectOnce();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await delay(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastErr || new Error('Failed to load Stripe');
}

// Resolve with the Stripe constructor (`window.Stripe`). Use when the caller
// needs the constructor itself (e.g. the estimate-deposit modal).
export function loadStripeSdk() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (sdkPromise) return sdkPromise;
  sdkPromise = loadWithRetry().catch((err) => {
    sdkPromise = null; // never cache a rejection — the wedge bug we're fixing
    throw err;
  });
  return sdkPromise;
}

// Resolve with an initialized Stripe instance for the given publishable key.
// This is what almost every surface wants.
export async function getStripe(publishableKey) {
  if (!publishableKey || typeof publishableKey !== 'string') {
    throw new Error('Missing Stripe publishable key');
  }
  const StripeCtor = await loadStripeSdk();
  return StripeCtor(publishableKey);
}
