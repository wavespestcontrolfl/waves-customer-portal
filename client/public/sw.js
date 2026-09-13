const APP_CACHE_PREFIX = 'waves-customer-';
// v12: v11 buckets grew without bound (one owner phone held 263 builds /
// 13.8k entries / 1.5 GB, and WebKit reads the whole index on the first
// caches.open() after a cold start — an 11 s blank screen). Bumping the
// name drops that bucket once via the activate sweep; pruneStaleAssets
// keeps the new one bounded to the current build.
const CACHE_NAME = 'waves-customer-v12-shell-pruned';
// Pre-prefix buckets (e.g. 'waves-v10-admin-activation-stable') that the
// APP_CACHE_PREFIX sweep never matched and so outlived every update.
const LEGACY_CACHE_PATTERN = /^waves-v\d+-/;
const OFFLINE_URL = '/';

const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reconnecting…</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#0f1923;color:#e2e8f0;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;
    justify-content:center;padding:24px;text-align:center}
  .logo{width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);
    display:flex;align-items:center;justify-content:center;font-weight:800;font-size:26px;color:#fff;margin-bottom:18px}
  h1{font-size:18px;margin:0 0 6px;font-weight:700}
  p{font-size:13px;margin:0 0 18px;color:#94a3b8;max-width:320px;line-height:1.5}
  button{padding:10px 22px;background:#0ea5e9;color:#fff;border:0;border-radius:8px;
    font-size:14px;font-weight:600;cursor:pointer}
</style></head>
<body><div class="wrap">
  <div class="logo">W</div>
  <h1>Reconnecting…</h1>
  <p>Waves needs a connection to load. We'll reload automatically when you're back online.</p>
  <button onclick="location.reload()">Try again</button>
</div>
<script>
  addEventListener('online', () => location.reload());
  // Re-attempt periodically in case the offline event misses (iOS sometimes does).
  setTimeout(() => { if (navigator.onLine) location.reload(); }, 4000);
</script></body></html>`;

function shellAssetUrls(html) {
  const urls = new Set();
  const re = /(?:src|href)=["'](\/assets\/[^"']+)["']/g;
  let match;
  while ((match = re.exec(String(html || '')))) urls.add(match[1]);
  return [...urls];
}

// Every cached /assets/* entry carries the builds it belongs to, so pruning
// can keep whole generations — the shell's direct assets AND the page chunks
// it lazy-loads later — without a dependency manifest. The id derives from
// the shell's asset set; hashed chunk names carry no build id of their own.
// It is a short digest, not the asset list itself: ~300 assets × ~30 chars
// per entry would put megabytes of header text into the cache index that
// WebKit reads on the first open — the very cost this worker is removing.
const BUILD_HEADER = 'x-waves-build';
// An installing worker and the active one share the cache but not their
// navigation order (module state is per instance). The installer records
// when its precache began; an active navigation that began earlier must
// not commit its (older) shell over the installer's.
const INSTALL_MARK_URL = '/__waves/install-commit';
const INSTALL_STARTED_HEADER = 'x-waves-install-started';
// Equality counts as superseding. Date.now() has coarse resolution (and
// coarser still where timer precision is reduced for privacy), so an active
// navigation and an installer that began within the same tick read the same
// value; under a strict `>` the navigation would treat the tie as "not
// superseded" and replace the just-installed shell with its older one,
// leaving the cache describing — and tagging chunks for — the wrong
// generation. The marker only ever records an install, never a navigation,
// so the tie can only cost that navigation its (background) refresh.
async function installCommittedAfter(cache, startedAt) {
  const mark = await cache.match(INSTALL_MARK_URL);
  const installStarted = Number(mark && mark.headers.get(INSTALL_STARTED_HEADER));
  return Number.isFinite(installStarted) && installStarted >= startedAt;
}
function buildIdOf(assets) {
  const key = [...assets].sort().join('|');
  let a = 5381; let b = 0;
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    a = ((a * 33) ^ c) >>> 0; // djb2
    b = (c + (b << 6) + (b << 16) - b) >>> 0; // sdbm
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

// A chunk unchanged across builds is used by several of them at once, and a
// retained build must not lose its claim because a newer page also used the
// chunk (a navigation whose shell refresh failed is live but never cached, so
// its build is never retained). The header lists the builds that used the
// entry, newest claims first, capped so repeated never-cached builds cannot
// grow it without bound. The worker cannot tell which tab made a request,
// so every use claims BOTH the live build and the cached shell's build (the
// "previous" generation the next prune retains); the claims lead the list,
// so the cap only ever sheds older, unretained builds.
const BUILD_TAGS_KEPT = 3;
// A claim is PROVISIONAL when the worker inferred it rather than read it: on
// an /assets/ request it cannot tell which tab asked, so it claims the live
// build AND the cached shell's, knowing only one of them really used the
// chunk. A firm claim comes from a shell's own HTML, which does list its
// assets. Provisional claims count for the ordinary prune exactly as firm
// ones do — that is what keeps a shared chunk for a retained build. They
// stop counting only when the bucket is out of quota and the choice is
// between dropping a chunk that may be refetchable and leaving the device
// permanently unable to cache a newer shell.
const PROVISIONAL_CLAIM = '~';
const claimIdOf = tag => (tag && tag[0] === PROVISIONAL_CLAIM ? tag.slice(1) : tag);
const provisionalClaim = buildId => (buildId ? `${PROVISIONAL_CLAIM}${claimIdOf(buildId)}` : buildId);
function rawTagsOf(response) {
  const raw = response && response.headers.get(BUILD_HEADER);
  return raw ? raw.split(',').map(t => t.trim()).filter(Boolean) : [];
}
function buildTagsOf(response) {
  return rawTagsOf(response).map(claimIdOf);
}
function firmTagsOf(response) {
  return rawTagsOf(response).filter(tag => tag[0] !== PROVISIONAL_CLAIM);
}

// Merge claims into the entry's existing ones, newest first. A build claimed
// firmly anywhere in the merge stays firm: a later provisional guess about a
// chunk must never downgrade a claim read off a shell that actually lists it.
function tagWithBuild(response, buildIds) {
  const headers = new Headers(response.headers);
  const order = [].concat(buildIds).filter(Boolean).concat(rawTagsOf(response));
  const firm = new Set(order.filter(tag => tag[0] !== PROVISIONAL_CLAIM));
  const seen = new Set();
  const tags = [];
  for (const tag of order) {
    const id = claimIdOf(tag);
    if (seen.has(id)) continue;
    seen.add(id);
    tags.push(firm.has(id) ? id : provisionalClaim(id));
  }
  headers.set(BUILD_HEADER, tags.slice(0, BUILD_TAGS_KEPT).join(','));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Each build publishes the list of hashed files it emitted (a Vite plugin
// writes it; see client/vite.config.js). The worker caches it beside that
// build's shell, so it can tell which chunks a retained generation actually
// OWNS. That is the one thing an /assets/ request cannot reveal on its own:
// the worker has no way to know which tab asked, so without this list it has
// to claim the chunk for the live build and the cached one both and hope.
// When the list is missing — an older deploy, a failed fetch, dev — the
// worker falls back to exactly the guess it made before.
const BUILD_MANIFEST_URL = '/build-assets.json';
const MANIFEST_KEY_PREFIX = '/__waves/manifest/';
const manifestKey = buildId => `${MANIFEST_KEY_PREFIX}${buildId}`;

// The list for the build whose shell was just fetched. A deploy can land
// between the two requests, which would file the NEXT build's list under
// this build's id; the shell's own hashed assets are in its own list by
// construction, so a missing one proves the two came from different builds.
async function fetchBuildManifest(assets) {
  try {
    const response = await fetch(new Request(BUILD_MANIFEST_URL, { cache: 'reload' }));
    if (!response.ok) return null;
    const owned = JSON.parse(await response.text());
    if (!Array.isArray(owned) || !owned.length) return null;
    const ownedSet = new Set(owned);
    if (!assets.every(url => ownedSet.has(url))) return null;
    return owned;
  } catch {
    return null;
  }
}

// A claim already on the entry. Strength matters: a firm claim must still
// be written over a provisional tag for the same build, or a chunk cached
// before its build's list arrived would stay a guess forever and the quota
// prune could drop it despite the list proving the build owns it.
function claimSatisfiedBy(rawTags, claim) {
  if (rawTags.includes(claim)) return true;
  // A provisional claim is satisfied by an existing firm one; never the reverse.
  return claim[0] === PROVISIONAL_CLAIM && rawTags.includes(claimIdOf(claim));
}

// Lists are read on every /assets/ hit and miss, and reading the cache is
// the cost this worker exists to remove, so keep the ones we have read in
// memory. Only positive results are memoized: another worker instance may
// write a list this one has already looked for, and caching that absence
// would keep this instance guessing for the rest of its life.
const ownedAssetsMemo = new Map();
async function ownedAssetsOf(cache, buildId) {
  if (!buildId) return null;
  if (ownedAssetsMemo.has(buildId)) return ownedAssetsMemo.get(buildId);
  try {
    const stored = await cache.match(manifestKey(buildId));
    if (!stored) return null;
    const owned = JSON.parse(await stored.text());
    if (!Array.isArray(owned)) return null;
    const set = new Set(owned);
    ownedAssetsMemo.set(buildId, set);
    return set;
  } catch {
    return null;
  }
}

// Claims for a chunk the worker cannot attribute to a tab. A build whose
// list names the chunk owns it — a firm claim. A build whose list exists and
// does NOT name it never claims it at all. Only a build with no list falls
// back to the old guess: firm for the live build, provisional for the cached
// one, exactly as before this manifest existed.
async function claimsForAsset(cache, pathname, liveId, cachedId) {
  const claims = [];
  for (const id of [liveId, cachedId]) {
    if (!id || claims.some(claim => claimIdOf(claim) === id)) continue;
    const owned = await ownedAssetsOf(cache, id);
    if (!owned) claims.push(id === liveId ? id : provisionalClaim(id));
    else if (owned.has(pathname)) claims.push(id);
  }
  return claims;
}

// The build the cached shell currently describes — what a lazily loaded
// chunk fetched right now belongs to. Worker globals do not survive
// termination, so read it from the cache each time (one small parse, and
// only on an /assets/ cache miss).
// `knownCachedBuild` mirrors the last value read or written, so the asset
// hit fast path can check a chunk's claims without touching the cache. A
// read that started before a refresh wrote a newer shell must not set it
// back: `cachedShellSeq` advances on every shell write, and a read only
// publishes its result if no write happened while it was in flight.
let knownCachedBuild = null;
let cachedShellSeq = 0;
async function cachedBuildId(cache) {
  const seq = cachedShellSeq;
  const shell = await cache.match(OFFLINE_URL);
  if (!shell) return null;
  const buildId = buildIdOf(shellAssetUrls(await shell.text()));
  if (seq === cachedShellSeq) knownCachedBuild = buildId;
  return buildId;
}

// The only way to write '/'. A refresh can store its shell and then put the
// prior one back (superseded while the write was pending), so the restore
// moves the cached build just as much as the commit did: a reader that
// sampled the temporary shell would otherwise publish a build the cache no
// longer holds, the hit fast path would stop adding the restored build's
// claim to a shared chunk, and the next prune would drop a chunk a live tab
// still needs. Bump the sequence on BOTH sides of the write — a read that
// straddles either edge refuses to publish — and leave the memo describing
// what the cache actually holds, or null when that is not known (a write
// that failed part-way leaves the entry unread).
async function putShell(cache, response, buildId) {
  cachedShellSeq += 1;
  let stored = false;
  try {
    await cache.put(OFFLINE_URL, response);
    stored = true;
  } finally {
    cachedShellSeq += 1;
    knownCachedBuild = stored ? (buildId || null) : null;
  }
}

// The build pages are running right now. A navigation hands the page build
// B's HTML before B's background shell refresh finishes, so chunks B loads
// in that window must not be stamped with the still-cached build A; the
// navigation handler advances this memo from the fresh HTML immediately,
// and a refresh requested before that never writes its build back over it
// (see replaceCompleteShell).
// Memoized per worker lifetime, seeded from the cached shell after a cold
// start. Never used to decide what the previous build was — that comes
// from the cached shell itself (cachedBuildId), or pruning would never fire.
let liveBuildId = null;
let navigationSeq = 0; // issued to each navigation as its HTML arrives, in order
let liveBuildSeq = 0; // token of the navigation that last advanced liveBuildId
// Navigation bodies and queued refreshes finish out of order; only the
// newest navigation's build may take the memo, never an older one that
// finished late (it would mis-tag the newer page's chunks).
function advanceLiveBuild(buildId, seq) {
  if (seq < liveBuildSeq) return;
  liveBuildSeq = seq;
  liveBuildId = buildId;
}
async function currentBuildId(cache) {
  if (liveBuildId) return liveBuildId;
  // Cold worker: seed from the cached shell. A navigation can land while
  // that read is in flight, and it is the newer truth — never overwrite it.
  const seeded = await cachedBuildId(cache);
  if (!liveBuildId) liveBuildId = seeded;
  return liveBuildId;
}

// Asset-cache writes — the prune, a cache hit's re-tag, a miss's store —
// run one at a time. Unserialized, the prune reads a chunk's old tag, a
// page of the retained build re-tags it meanwhile, and the prune's delete
// then removes an entry whose new tag it would have kept. The lock is
// origin-wide (Web Locks): a newer sw.js installing beside the active
// worker shares CACHE_NAME but not module globals, so its install-time
// prune must queue behind the active worker's writes too. A lock held by
// a terminated worker is released with it. Never nested: a shell refresh
// takes the asset lock only for bounded, non-reentrant steps.
const ASSET_WRITE_LOCK = 'waves-asset-writes';
const SHELL_REFRESH_LOCK = 'waves-shell-refresh';
function serializeOn(name, fallbackChain, fn) {
  if (self.navigator.locks?.request) return self.navigator.locks.request(name, fn);
  const run = fallbackChain.promise.then(fn);
  fallbackChain.promise = run.catch(() => {});
  return run;
}
const assetWriteChain = { promise: Promise.resolve() };
function withAssetWrites(fn) {
  return serializeOn(ASSET_WRITE_LOCK, assetWriteChain, fn);
}

// Add build claims to a cached entry. Runs under the write lock and merges
// into whatever the cache holds NOW — a queued write must not carry an
// older copy's tags over an entry a shell refresh re-wrote meanwhile.
// `fallback` is stored when the entry is gone (pruned in between).
function claimBuilds(cache, request, fallback, claims) {
  return withAssetWrites(async () => {
    const latest = (await cache.match(request)) || fallback;
    return cache.put(request, tagWithBuild(latest, claims));
  });
}

// Every navigation kicks off a background shell refresh, so two can overlap
// across a deploy (old shell A and new shell B in flight together). Each
// refresh reads the previous shell, writes, then prunes — interleaved, A's
// prune deletes B's assets after B stored its shell, leaving '/' pointing
// at a missing entry script. Serialize the whole read-write-prune unit,
// origin-wide for the same reason as the asset writes: an installing
// worker's precache and the active worker's navigation refresh overlap.
const shellRefreshChain = { promise: Promise.resolve() };
function withShellRefresh(fn) {
  return serializeOn(SHELL_REFRESH_LOCK, shellRefreshChain, fn);
}
async function cacheCompleteShellResponse(shellResponse, enqueuedSeq = navigationSeq, { supersedable = true, startedAt = Date.now() } = {}) {
  return withShellRefresh(() => replaceCompleteShell(shellResponse, enqueuedSeq, supersedable, startedAt));
}

async function replaceCompleteShell(shellResponse, enqueuedSeq, supersedable, startedAt = Date.now()) {
  const cache = await caches.open(CACHE_NAME);
  // Superseded by a newer navigation of this worker, or by an installing
  // worker whose precache began after this request did.
  const isSuperseded = async () => supersedable && (enqueuedSeq < liveBuildSeq || await installCommittedAfter(cache, startedAt));
  // A navigation that began before a newer one can still finish after it
  // (its network response was slower); its shell is the older deploy's and
  // must not replace the newer shell already cached — nor its build be
  // retained over the newer one at the next prune. The install precache
  // is never superseded: the worker needs a shell.
  if (await isSuperseded()) throw new Error('Shell refresh superseded by a newer navigation');
  if (!shellResponse.ok) throw new Error(`Shell request failed (${shellResponse.status})`);

  const html = await shellResponse.clone().text();
  const assets = shellAssetUrls(html);
  if (!assets.length) throw new Error('Shell contains no build assets');
  const buildId = buildIdOf(assets);

  // Fetch every hashed dependency before storing the new HTML. If any fetch
  // fails, installation rejects and the previous worker/cache remains active;
  // customers never receive an offline shell whose entry chunk is missing.
  const assetResponses = await Promise.all(assets.map(async assetUrl => {
    const response = await fetch(new Request(assetUrl, { cache: 'reload' }));
    if (!response.ok) throw new Error(`Shell asset failed (${response.status}): ${assetUrl}`);
    return [assetUrl, response];
  }));
  // Fetched with the assets, not after the commit: a later deploy would
  // serve the next build's list. A null result simply leaves this build
  // without one, and the worker guesses as it always has.
  const ownedAssets = await fetchBuildManifest(assets);
  // The asset fetches above take time; a newer navigation may have landed
  // meanwhile. Check again before committing anything.
  if (await isSuperseded()) throw new Error('Shell refresh superseded by a newer navigation');
  // Read the previous build BEFORE overwriting its shell: a different id
  // means a deploy shipped, and everything older than that build is dead weight.
  const previousBuildId = await cachedBuildId(cache);
  // Under the write lock, keeping the claims an existing entry already
  // holds. An entry that already existed is claimed by the previous build
  // too: if a write fails (quota) the shell is not replaced, and a run of
  // such failures must not push the still-cached build off the tag cap
  // of an asset it shares. Entries this batch CREATED belong only to the
  // new build, and are removed again if the batch fails — otherwise a
  // failed generation would sit in the bucket, unprunable, holding the
  // very quota the next refresh needs. Every started write settles before
  // the lock is released.
  const commitGeneration = async () => {
    const created = [];
    // Undo only what is still solely this generation's: once the batch
    // released the write lock, a newer page may have loaded an entry it
    // created and claimed it for its own build — it is that build's now.
    const rollBackCreated = () => Promise.allSettled(created.map(async assetUrl => {
      const current = await cache.match(assetUrl);
      if (current && buildTagsOf(current).some(tag => tag !== buildId)) return;
      await cache.delete(assetUrl);
    }));
    await withAssetWrites(async () => {
      const results = await Promise.allSettled(assetResponses.map(async ([assetUrl, response]) => {
        const existing = await cache.match(assetUrl);
        const claims = existing ? [buildId, previousBuildId, ...rawTagsOf(existing)] : [buildId];
        if (!existing) created.push(assetUrl);
        // Clone: a retry below re-reads the same fetched body.
        await cache.put(assetUrl, tagWithBuild(response.clone(), claims));
      }));
      const failed = results.find(r => r.status === 'rejected');
      if (failed) {
        await rollBackCreated();
        throw failed.reason;
      }
    });
    // The asset batch waits on the write lock and then on every write; a
    // newer navigation can advance the live build meanwhile. Committing
    // this older shell now would leave the cache describing a generation
    // behind the page (if the newer refresh then fails), so the chunks
    // that page loads get tagged with the older build and are pruned at
    // the next deploy. Check once more, right before the write that
    // commits, and give back what this batch created.
    if (await isSuperseded()) {
      await withAssetWrites(rollBackCreated);
      throw new Error('Shell refresh superseded by a newer navigation');
    }
    // The shell write can hit the quota too; the generation is only
    // committed once '/' points at it, so undo its new entries as well.
    // The install's marker is part of its commit: an install whose marker
    // did not persist would leave the active worker's older in-flight
    // navigation free to overwrite the shell it just stored, so it fails
    // (quota retries below; the previous worker keeps serving otherwise).
    const previousShell = await cache.match(OFFLINE_URL);
    const restorePreviousShell = async () => {
      if (previousShell) await putShell(cache, previousShell.clone(), previousBuildId).catch(() => {});
    };
    try {
      await putShell(cache, shellResponse.clone(), buildId);
      if (!supersedable) await cache.put(INSTALL_MARK_URL, new Response('', { headers: { [INSTALL_STARTED_HEADER]: String(startedAt) } }));
    } catch (err) {
      await restorePreviousShell();
      await withAssetWrites(rollBackCreated);
      throw err;
    }
    // The shell write itself yields to other fetch events; a newer
    // navigation can advance the live build while it is pending. The
    // check and the write cannot be atomic, so detect it afterward and
    // put the prior shell back — no newer refresh can have run meanwhile,
    // this refresh still holds the shell-refresh lock.
    if (await isSuperseded()) {
      await restorePreviousShell();
      await withAssetWrites(rollBackCreated);
      throw new Error('Shell refresh superseded by a newer navigation');
    }
  };
  try {
    await commitGeneration();
  } catch (err) {
    // This bucket can fill up on its own: two retained generations plus
    // their route chunks, and the prune that drops the older one only runs
    // AFTER a refresh commits. A quota failure here would then repeat on
    // every refresh and every later install (the stale-bucket reclaim
    // never touches the current bucket), leaving the device unable to
    // cache a newer shell until storage is cleared by hand. Drop the
    // generation older than the cached one — what the commit's own prune
    // would have dropped — and try once more. The cached generation (and
    // the live page's) stays intact either way.
    if (!isQuotaError(err)) throw err;
    await pruneStaleAssets(cache, [previousBuildId, liveBuildId]);
    try {
      await commitGeneration();
    } catch (retryErr) {
      // Still out of room. Every build whose own shell refresh failed is
      // live but never cached, so the chunks its pages loaded claim the
      // CACHED build provisionally — and the cached build is always
      // retained. A run of such builds therefore fills the bucket with
      // entries no retention set can drop, and the device is left unable
      // to cache any newer shell: the exact failure this worker exists to
      // prevent. Drop what only a guess is holding and try once more. A
      // chunk lost this way is refetched from the network on next use;
      // the shells and the assets they list are firm, so both retained
      // generations survive.
      if (!isQuotaError(retryErr)) throw retryErr;
      await pruneStaleAssets(cache, [previousBuildId, liveBuildId], { firmOnly: true });
      await commitGeneration();
    }
  }
  // The memo already describes this build: putShell set it as part of the
  // write that committed the shell, and nothing has moved '/' since.
  // Refreshes are queued, so an older one can finish after a newer
  // navigation already advanced the live build — writing its own build back
  // would mis-tag the newer page's chunks. Only claim the memo if no
  // navigation moved it since this refresh was requested (install path).
  // After the commit, so a failed refresh never leaves a list for a build
  // whose shell was not stored; before the prune, so the prune can drop the
  // lists of generations it is about to evict. A failed write is not fatal:
  // the build just has no list and falls back to the guess.
  if (ownedAssets) {
    await cache.put(manifestKey(buildId), new Response(JSON.stringify(ownedAssets), {
      headers: { 'Content-Type': 'application/json' },
    })).then(() => ownedAssetsMemo.set(buildId, new Set(ownedAssets))).catch(() => {});
  }
  advanceLiveBuild(buildId, enqueuedSeq);
  // Keep the generation just replaced too: a tab still running the previous
  // build lazy-loads its chunks after the shell moved on, and an offline
  // navigation may read the old shell moments before its replacement. Two
  // generations bound the cache. The live build is also protected: when
  // this refresh is an older one landing late, a newer navigation may have
  // cached its own chunks already, and its queued refresh only restores the
  // shell's direct assets — not the routes that page already loaded.
  if (previousBuildId !== buildId) await pruneStaleAssets(cache, [buildId, previousBuildId, liveBuildId]);
}

// Drop every cached /assets/* entry tagged with none of the retained builds
// (or with no tag at all). Runs only when the shell's build changed (a deploy),
// never on a plain navigation, so page chunks cached on use stay with their
// build until it is two deploys old.
function pruneStaleAssets(cache, retainedBuildIds, { firmOnly = false } = {}) {
  const retained = new Set(retainedBuildIds.filter(Boolean).map(claimIdOf));
  return withAssetWrites(async () => {
    const requests = await cache.keys();
    await Promise.all(requests.map(async request => {
      const pathname = new URL(request.url).pathname;
      // A retained build keeps its file list; a dropped one loses it, or the
      // lists would outlive every generation and grow without bound.
      if (pathname.startsWith(MANIFEST_KEY_PREFIX)) {
        const listedBuild = pathname.slice(MANIFEST_KEY_PREFIX.length);
        if (!retained.has(listedBuild)) {
          await cache.delete(request);
          ownedAssetsMemo.delete(listedBuild);
        }
        return;
      }
      if (!pathname.startsWith('/assets/')) return;
      const cached = await cache.match(request);
      // firmOnly: a chunk survives only if a RETAINED build really listed it.
      // Chunks kept alive solely by a provisional claim go, freeing the space
      // a run of never-cached builds would otherwise hold forever.
      const tags = firmOnly ? firmTagsOf(cached) : buildTagsOf(cached);
      if (!tags.some(tag => retained.has(claimIdOf(tag)))) await cache.delete(request);
    }));
  });
}

async function precacheOnce() {
  // Fetch under the shell-refresh lock: an installing worker shares the
  // cache with the active one but not its ordering state, so fetching
  // only after any in-flight commit guarantees the shell it stores is at
  // least as new as the one cached.
  const startedAt = Date.now();
  await withShellRefresh(async () => {
    const shellRequest = new Request(OFFLINE_URL, { cache: 'reload' });
    const shellResponse = await fetch(shellRequest);
    await replaceCompleteShell(shellResponse, navigationSeq, false, startedAt);
  });
}

function isQuotaError(err) {
  return !!err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message || '')));
}

async function precacheCompleteShell() {
  try {
    await precacheOnce();
  } catch (err) {
    // The bloated v11 bucket may hold the origin's whole quota while this
    // v12 precache runs (stale buckets are normally swept at activate), so
    // the install would fail forever and the device stay on the slow
    // worker. Reclaim space and retry once; other failures propagate.
    if (!isQuotaError(err)) throw err;
    await reclaimStaleCacheSpace();
    await precacheOnce();
  }
}

function isStaleCacheName(k) {
  return (k.startsWith(APP_CACHE_PREFIX) && k !== CACHE_NAME) || LEGACY_CACHE_PATTERN.test(k);
}
async function sweepStaleCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter(isStaleCacheName).map(k => caches.delete(k)));
}

// Free quota without taking the active worker's offline shell away: the
// retry may still fail (connectivity), and the old worker then keeps
// serving until a later install succeeds. Every stale bucket keeps its
// shell and the assets that shell references and loses everything else —
// the hundreds of superseded builds that filled it. Pre-prefix legacy
// buckets get the same trim, not a delete: a device that never ran a
// v11 worker still serves from one (same '/' shell key), and the activate
// sweep removes them whole once this worker has taken over.
async function reclaimStaleCacheSpace() {
  const keys = await caches.keys();
  await Promise.all(keys.filter(isStaleCacheName).map(async k => {
    const old = await caches.open(k);
    const shell = await old.match(OFFLINE_URL);
    const keep = new Set(shell ? shellAssetUrls(await shell.text()) : []);
    const requests = await old.keys();
    await Promise.all(requests.map(async request => {
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith('/assets/') && !keep.has(pathname)) await old.delete(request);
    }));
  }));
}

self.addEventListener('install', event => {
  event.waitUntil(precacheCompleteShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(sweepStaleCaches().then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept: external requests, API calls, WebSocket
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws/')) return;

  // HTML navigation requests: network-first with offline fallback.
  // ALWAYS return a Response (never undefined) so iOS standalone PWAs
  // never render a blank screen on flaky cellular.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    // Order navigations by when they BEGIN, not when their response lands:
    // an earlier request can be answered by the older deploy yet resolve
    // after a later request answered by the newer one.
    const navSeq = ++navigationSeq;
    const startedAt = Date.now();
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        // Refresh the offline shell only after all of the HTML's hashed assets
        // are available. Keep serving the current page immediately; if this
        // background refresh fails, the last complete shell remains intact.
        if (response && response.ok) {
          // Advance the live build before the (serialized, possibly slow)
          // refresh lands, so chunks this page loads meanwhile are tagged
          // with its own build. A shell without assets is not a build.
          event.waitUntil(response.clone().text().then(html => {
            const assets = shellAssetUrls(html);
            if (!assets.length) return;
            advanceLiveBuild(buildIdOf(assets), navSeq);
          }).catch(() => {}));
          event.waitUntil(cacheCompleteShellResponse(response.clone(), navSeq, { startedAt }).catch(() => {}));
        }
        return response;
      } catch {
        const currentCache = await caches.open(CACHE_NAME);
        const cached = (await currentCache.match(OFFLINE_URL)) || (await currentCache.match(event.request));
        if (cached) return cached;
        return new Response(OFFLINE_FALLBACK_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // Hashed assets (/assets/index-CRewFOq2.js) — immutable, so cache on first
  // use; pruneStaleAssets evicts them once the shell moves to a newer build.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => cache.match(event.request).then(cached => {
        if (cached) {
          // A chunk unchanged between builds keeps its hash, so a hit may
          // not carry the live build's tag (or the cached shell's) yet; add
          // them, keeping older claims, so the prune sees the chunk as the
          // retained builds' when the ones that first stored it age out.
          const tags = rawTagsOf(cached);
          // Firm tags only: a provisional tag for either build may still need
          // upgrading once that build's file list proves it owns the chunk.
          if (liveBuildId && knownCachedBuild && tags.includes(liveBuildId) && tags.includes(knownCachedBuild)) return cached;
          // Clone before handing `cached` to respondWith: on a cold worker the
          // build lookup awaits the cached shell, and the page can lock the
          // body in that window, making a later clone() throw.
          const copy = cached.clone();
          const touch = Promise.all([currentBuildId(cache), cachedBuildId(cache)])
            .then(([buildId, cachedId]) => claimsForAsset(cache, url.pathname, buildId, cachedId))
            .then(claims => {
              if (!claims.length || claims.every(claim => claimSatisfiedBy(tags, claim))) return undefined;
              return claimBuilds(cache, event.request, copy, claims);
            }).catch(() => {});
          try { event.waitUntil(touch); } catch { /* fire and forget */ }
          return cached;
        }
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            // Tag the chunk with the build it was loaded for, so the prune
            // keeps it with that build's shell instead of guessing from HTML.
            // The worker cannot tell which tab asked: the live build is the
            // newest navigation's, but a tab on the cached shell's build may
            // be the requester (a newer navigation whose refresh failed is
            // live yet never cached), so the cached build claims it too —
            // PROVISIONALLY, because only one of the two really used it and
            // the cached build is always retained. Left firm, chunks from a
            // run of never-cached builds would be unprunable and wedge the
            // bucket; see the firmOnly escalation in the quota recovery.
            const store = Promise.all([currentBuildId(cache), cachedBuildId(cache)])
              .then(([buildId, cachedId]) => claimsForAsset(cache, url.pathname, buildId, cachedId))
              .then(claims => claimBuilds(cache, event.request, clone, claims.length ? claims : ['untagged']))
              .catch(() => {});
            // The respondWith promise is still pending here, so the event
            // can still be extended; if a browser disagrees, fall back to
            // fire-and-forget rather than failing the asset load.
            try { event.waitUntil(store); } catch { /* fire and forget */ }
          }
          return response;
        });
      }))
    );
    return;
  }

  // Everything else (manifest, icons, etc.) — network first, cache fallback
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});

// Home-screen icon badge (Badging API — iOS 16.4+ installed PWAs):
// data.badge is the server-computed unread count; data.badgeAt orders
// overlapping pushes — counts are absolute snapshots, so a slower delivery
// carrying an older (lower) snapshot must not overwrite a newer one. The
// last-applied {seq, count} lives in the Cache API (SW scope has no
// localStorage, and worker globals don't survive termination); the cache
// name is outside APP_CACHE_PREFIX so activate's old-cache sweep never
// clears it. The whole compare-and-apply runs under a Web Lock: the check
// spans awaits, so two overlapping push handlers could otherwise both read
// the old state before either writes, and the PAGE writes the same state
// when it clears the badge on read (NotificationBell syncAppBadge, same
// lock name + key) — a delayed push must not resurrect a count the admin
// already cleared. 0 clears the badge; no numeric badge leaves it alone.
const BADGE_STATE_CACHE = 'waves-badge-state';
const BADGE_SEQ_KEY = '/__badge-seq';
const BADGE_LOCK = 'waves-badge';
function withBadgeLock(fn) {
  // Browsers without Web Locks fall back to best-effort unserialized.
  if (self.navigator.locks?.request) return self.navigator.locks.request(BADGE_LOCK, fn);
  return fn();
}
async function applyAppBadge(count, seq) {
  if (!('setAppBadge' in self.navigator)) return;
  try {
    await withBadgeLock(async () => {
      if (Number.isFinite(seq)) {
        const cache = await caches.open(BADGE_STATE_CACHE);
        const prevRes = await cache.match(BADGE_SEQ_KEY);
        let prev = { seq: 0, count: -1 };
        if (prevRes) { try { prev = await prevRes.json(); } catch { /* corrupt → treat as empty */ } }
        if (prev.seq > seq) return; // an older overlapping push arrived late — ignore it
        // Equal stamps are ms ties between concurrent snapshots: keep the
        // higher count — during a burst counts only grow; decreases come
        // from reads, which stamp strictly newer via the page path.
        if (prev.seq === seq && prev.count >= count) return;
        await cache.put(BADGE_SEQ_KEY, new Response(JSON.stringify({ seq, count })));
      }
      if (count > 0) await self.navigator.setAppBadge(count);
      else await self.navigator.clearAppBadge();
    });
  } catch { /* badge is garnish — never fail the push handler over it */ }
}

self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  const requireInteraction = data.priority === 'urgent';
  if (Number.isInteger(data.badge)) {
    event.waitUntil(applyAppBadge(data.badge, Number(data.badgeAt)));
  }
  let destination = '/';
  try {
    const candidate = new URL(data.url || '/', self.location.origin);
    if (candidate.origin === self.location.origin) {
      destination = `${candidate.pathname}${candidate.search}${candidate.hash}`;
    }
  } catch { /* default to the app root */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Waves', {
      body: data.body || '', icon: '/waves-logo.png', badge: '/waves-logo.png',
      tag: data.tag || 'waves', data: { url: destination },
      actions: data.actions || [],
      vibrate: data.vibrate || [200, 100, 200],
      silent: !!data.silent,
      renotify: !!data.renotify,
      requireInteraction,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || '/'));
});

// Deliberately NO pushsubscriptionchange handler: rotating the server row
// from the SW would need an unauthenticated mutating route (the SW can't
// reach the admin JWT in localStorage), which AGENTS.md classifies as P0.
// An endpoint rotation while the app is closed is instead healed by
// syncPushSubscription (push-subscribe.js) on the next app open/resume.
