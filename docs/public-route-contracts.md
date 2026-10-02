# Public route contracts

## Combined visit summary

`GET /api/visit-summary/:token` (`server/routes/visit-summary-public.js`) and
the `/visit/:token` React shell use a 64-character lowercase hex bearer token.
The API format-gates before any database read, hashes the token for lookup,
and returns the same 404 for malformed, unknown, revoked, or ineligible links.
Only issued, non-revoked links on closing/closed visits with a complete,
identity-matched saved packet resolve. Backfilled and withheld service reports
are excluded. The payload contains the service date and each visible service's
record id, type, outcome, and existing report link; no technician notes,
access codes, customer contact details, prices, invoice tokens, or payments.

The API and shell share the existing public report limiter (20 requests/minute
per IP). Privacy headers (`no-store`, `noindex`, and `no-referrer`) precede the
limiter; the API also stamps them before the global API limiter. Tokens are
redacted by the shared URL logger. `GATE_VISIT_CLOSEOUT` controls new packet
creation, not issued links: disabling it does not revoke customer summaries.
The admin-only `POST /api/admin/visit-closeouts/:visitId/revoke-summary`
sets `service_visits.summary_token_revoked_at`; reads immediately refuse the
link and future dispatch checks refuse it. Revocation does not block packet
recovery or alter individual report/receipt tokens. The page
only opens each service's existing report; it adds no write or ask endpoint.

Security contract for every route the portal serves with NO session auth
at all: token-gated customer surfaces, machine-to-machine webhooks, and
the anonymous public API. Routes behind the customer JWT (`authenticate`,
e.g. `/api/services`, `/api/schedule`) or the staff bearer are NOT public
and do not belong here. This is the list `AGENTS.md` refers to — **a new
public route outside this document is a P0**, and any change to a listed
route's auth, gate, rate limit, payload, or headers is security-critical
and must be reflected here in the same PR.

Read this when a diff touches a `server/routes/*` handler that runs with
neither `adminAuthenticate` nor customer `authenticate` in front of it, a
`server/index.js` mount, or anything under `server/services` that a
listed route calls. It is deliberately verbose:
each entry records the owner rulings and the exact guards that were argued
out in review, so a reviewer can check a diff against the contract instead
of re-deriving it.

Conventions used below: "token format gate" = a regex check on the path
token before any DB read; "generic 404" = unknown, malformed, dark-gated,
and ineligible rows are indistinguishable (no existence oracle); "privacy
headers" = `Cache-Control: no-store`, `X-Robots-Tag: noindex`,
`Referrer-Policy: no-referrer`.

## Routes

Customer page-view log (no payload, gate, or header change): the data GET of
`/api/public/appointment/:token`, `/api/public/reschedule/:token`,
`/api/public/reservice/:token`, `/api/public/secure-card/:token`, and
`/api/public/inspection/:token` records one `customer_page_views` row once
the token has resolved to a row (never for a malformed, unknown, or
dark-gated token; a resolved-but-closed page such as a completed visit or a
closed card request still counts as a view), through
`server/services/customer-page-views.js`. Those GETs are not contractually
read-only (their entries below describe POST writes and, for secure-card,
render-time stamps), and none names a sole write companion, so the view write
rides the GET. `/api/public/track/:token` is the exception: its GET stays
strictly read-only (see its entry), so its view is recorded by the dedicated
`POST /api/public/track/:token/view` companion instead. The log is
fire-and-forget (never awaited, never throws, never alters the response),
skips bot/preview user agents, staff browsers (`waves_admin` marker cookie),
and `WAVES_ADMIN_IPS`, and stores only a sha256 of the IP and a 500-char user
agent. The same page + subject + ip hash is deduped inside a fixed 10-minute
lookback from its latest row, so a page left open past the window logs one
more row per window. A failed insert or lookup logs only the page name,
subject type and error code, never the error message (a Knex message carries
SQL text and bound values, which can include a bearer token).

Invoice/receipt address preservation: a saved `invoices.customer_address_snapshot`
supplies the displayed customer address on `/api/pay/:token`, `/invoice.pdf`,
`/api/receipt/:token` and its PDF. Legacy rows retain their existing address
fallback until an approved manual primary-property change freezes it. Contact
recipients, third-party Bill-To authority, amounts, and permanent receipt tokens
are unchanged; snapshots remain authoritative when the rollout gate is off.

Pest Pressure technician direct score (owner ruling 2026-09-24): on the
service-report payload (`/api/reports/:token/data` and the renders that share
`buildReportV1Data`), when the visit's rating was entered by staff
(`client_pest_rating_source = 'technician'`) `pestPressure.score` /
`displayScore` equal that 0–5 rating exactly, and `label` resolves from the
active six-band labels (0 None · 1 Very Low · 2 Low · 3 Moderate · 4 Elevated ·
5 High; a customized label set is kept). When `showComponentBreakdownToCustomer`
is on, such reports' `components` object is a single
`technicianActivityRating` entry (`{ value, weight: 100, present: true }`)
instead of the five weighted components; customer-rated reports keep the
five-component blend. Customer-visible pressure numbers no longer floor at
0.3 — a rating of 0 reads 0.0. Auth, gates, headers and the rating POST are
unchanged.

Re-service report card (owner-approved design 2026-09-26, Fast Complete PR D;
`GATE_RESERVICE_REPORT_CARD` — dark, off unless exactly `'true'`, read at call
time): on the service-report payload (`/api/reports/:token/data` and the PDF,
which share `buildReportV1Data`), when the card gate is on AND the existing
`reserviceReport` callback block is composed (`GATE_RESERVICE_REPORT_COPY` on,
a pest/lawn callback record), gate on adds an optional `data.reserviceReportCard`
object `{ version: 1, youToldUs, whatWeDid, stillSeeing }`; gate off, or no
callback block, omits the key entirely (never `null`), so the payload is
byte-identical to before. `server/services/service-report/reservice-report-card.js`
is the pure builder.
- `youToldUs` (`null` or `{ source, quoted, lead, text, pests }`): the
  customer's booking words, read ONLY from the copy frozen onto
  `service_records.service_data.reserviceRequest` at completion (from the
  locked `scheduled_services.customer_request` / `_source` / `_pests` row;
  never read live, so a later booking edit cannot rewrite a permanent report;
  records completed before the freeze carry none). `source` is
  `picker` | `text` | `call` | `office`, or `null` when only pest chips are
  on file (no words shown). Picker and text words are the
  customer's verbatim words (`quoted: true`); a call paraphrase
  (`lead: 'On your call, you mentioned'`) and office words
  (`lead: 'As reported to our office:'`) are never quoted. `text` always passes
  the report writer's customer-words scrub (`scrubCustomerText`: pest talk
  only, access details such as gate codes removed) and the banned
  customer-copy screen, and is capped at 280 characters; a scrub that is
  unavailable or throws drops the words (never shown raw). A call / office
  paraphrase written about the customer in the third person is dropped.
  `pests` are display labels of the picker's chip keys. Nothing left → `null`.
- `whatWeDid` (`null` or `{ pests, where, found, safetyLine }`): only for a
  performed (`treated`) outcome; pests from the product rows' targets, where
  from `areas_serviced`, `found` from the technician's own activity tap, and
  the safety line only with a recorded wet application.
- `stillSeeing`: the topic word for the "Still seeing …? Tell us" button. The
  button links only the existing authenticated `/?tab=schedule` portal route,
  rendered only when the payload's existing `reserviceEligible === true` and in
  the live view (never the PDF); no re-service token or new route is exposed.
The PDF prints `youToldUs` and `whatWeDid`; its cache key gains `-rcd1` only
when the card is present.

Pest Report V2 "expectations" blocks (owner-approved 2026-09-27/28,
`GATE_PEST_REPORT_EXPECTATIONS` — dark, off unless exactly `'true'`, read at
call time, no redeploy to flip): on the pest-line service-report payload
(`/api/reports/:token/data` and the PDF, which share `buildReportV1Data` /
`reports-public.js`'s pest V2 composition), gate on adds an optional
`data.pestReportV2.expectations` object with up to three keys — `rain`,
`spiders`, `whatToExpect` — each present only when that block has something
to say; gate off, or nothing to say, omits the whole `expectations` key —
unlike the always-present-but-nullable `defense` / `aiSummary` / `forecast`
siblings on `pestReportV2`, no `expectations: null` and no null child key
is ever serialized (codex P0 #5137 round 6); server/services/service-report/
pest-report-expectations.js is the pure builder. `pest-report-v2.js` now
builds `expectations` BEFORE its own emptiness predicate and counts a
non-null result among the fields that keep the section alive (codex P2
2026-09-29 round 3): a sparse callback report — `suppressDefense`, with no
primary move, supporting metric, AI summary, or customer concern — used to
return `null` (no `pestReportV2` at all) before `expectations` was ever
computed, silently discarding a recorded rain / eave-sweeping / product
expectation exactly where it would have been the section's ONLY content.
Such a visit's public payload now carries a minimal `pestReportV2` object
(status/statusSummary plus `expectations`, every other field null/empty) in
that case; gate off is unaffected (`expectations` stays `null`, so the
emptiness predicate is byte-identical to before this fix). `rain: { lines: [string] }`
— one line stating the trailing 7-day rainfall at the property
(`application-conditions.js` `fetchServiceWeekWeather`; low-confidence
city-collective readings are hedged in the wording, never presented as an
exact number), then an OPTIONAL rain-fast clause ("...rain-fast about N
after it dries, per the label.") that appears ONLY when
`products_catalog.rainfast_minutes` is actually set for an applied product —
NULL for every current pest product as of 2026-09-27, so this clause never
fires against real data today. When MORE THAN ONE applied product carries a
positive `rainfast_minutes` (a future catalog state), the clause states the
LONGEST interval across them (codex P2 2026-09-29 round 2: array order is
incidental, never a safety ranking — the customer needs the wait time that
covers every applied product, not whichever happened to sort first). There
is deliberately NO generic fallback sentence when the catalog has no number
(revised 2026-09-28): a plain "rain-fast once it has dried" claim is itself
unsupported — most labels don't state rain-fastness at all, and some
instead say to avoid rain within a window after application — so with no
sourced number the clause is simply absent, never a hard-coded or invented
duration. Then, **live view only**, a forward-looking heavy-rain caveat
sourced from the NWS forecast (`weather-forecast.js`
`getDailyRainOutlookBounded`) — read from forecast TEXT only
(storm/thunderstorm/heavy rain in `shortForecast`; codex P2 2026-09-29
round 2: `rainChance` alone is the probability of ANY precipitation, not its
intensity, and `getDailyRainOutlookBounded` exposes no quantitative amount
to fall back on, so a high chance of light rain must never trigger this
caveat on the bare percentage) — `reports-public.js` computes that forecast
signal only when `mode === 'live'` AND the visit's `service_date` is RECENT
(codex P1 2026-09-29 round 4: within the last 2 ET calendar days —
`isRecentServiceDate`, an ET-calendar-day comparison via `etDateString`/
`addETDays`, never 24h epoch-ms arithmetic — today, yesterday, or the day
before; older never fetches the forecast at all), and always passes `false`
for the PDF and any other static render or an older live reopen, so the
PDF/static payload's `rain.lines` can only ever be the trailing-week fact +
optional rainfast clause, never the forecast sentence, and a customer who
reopens a weeks-old live report link never gets a heavy-rain caveat dated
to TODAY's weather framed as being about that old treatment. On a LIVE
render, the forecast caveat fires INDEPENDENTLY of whether the trailing-week
total is settled (codex P2 #5137 deferred finding c): a same-day live report
with an open trailing-week window has no settled weekly rain fact at all
(`settledWeekWeatherForRender` — see below — passes `weekWeather: null` on
every render, live included), so the caveat is its own standalone line
rather than a clause appended to a sentence that, on that render, never
exists; when a settled trailing-week fact IS present, the caveat still
appends to that sentence exactly as before, so there is never a redundant
second line for the same signal. Either way the caveat is a treatment claim,
so it appears only when the visit recorded at least one application; an
inspection- or sweep-only visit gets no caveat (codex r2 on #5265). A PDF/static
render carries the trailing-week fact
ONLY once that 7-day window has closed (`application-conditions.js` stamps
each result with `windowClosed`; `reports-public.js`
`settledWeekWeatherForRender` drops an open, still-accumulating week from
every non-live render so no mid-window rain total is ever baked into a
cached document — the rain block is simply absent until the window closes,
and — codex P2 2026-09-28 round 5 — the LIVE page withholds it too: an open window is served from the forecast endpoint, whose current-day value includes hours that have not happened yet, so no render describes predicted rain as observed); a second line may add an ants-after-rain expectation, but
ONLY when an actual rain signal clears a threshold (>= 0.5" during SWFL
rainy season Jun–Oct, >= 1" otherwise; a low-confidence reading always uses
the higher 1" bar) or the same live-only forecast signal fires — never on
the calendar month alone, and never when there is no rain data at all. That
second line's WORDING is itself gated (owner ruling 2026-09-28, revised
codex P1 2026-09-29 rounds 2–3): "trails ... usually mean the colony
is moving through the treated band" is a TREATMENT claim and requires the
SAME confirmed exterior/perimeter application evidence the `whatToExpect`
pyrethroid barrier sentence below requires (an explicit, non-inferred
`perimeter_spray`/`broadcast_spray` method, or an `applicationArea` chip
that the CONTROLLED classification — `shared/treatment-area-scopes.json`,
the same source `report-data.js`'s own interior/exterior scope reads —
places in its `exterior` list, matched by EXACT chip key after a comma
split and normalization, never a substring/regex match: an earlier
unanchored `entry points?` alternative matched the controlled INTERIOR
chip "Interior entry points" too, since it never anchored on the
"Interior" prefix) on a product whose class is `non_repellent` or
`pyrethroid` — an ant bait, roach gel, or IGR is never a perimeter band
either, regardless of where it was placed. An unrecognized or free-text
area string never qualifies, fail closed. No applications at all
(inspection/sweep-only visit), an interior-only application, or unknown
method/area all fall back to a treatment-neutral sentence (rain pushes ants
indoors; text us if activity persists) that states the same honest
biological fact without claiming a treatment is responsible. The
treated-band claim, and the ant/colony-specific non-repellent what-to-expect
line, additionally require an application the technician TAGGED for ants
(the structured `targets` list, word-bounded match on "ant"/"ants" — codex
P1 2026-09-28 round 4): a non-repellent applied for roaches only, or the
auto-seeded pest mix on a visit with no ant target, gets pest-neutral
transfer wording instead. Ant bait keeps its ant wording (the product is
an ant bait by definition). The spider
card's LOCATION wording ("around the eaves and entry points") requires a
recorded action that names the eaves/soffit; a generic web action such as
"Removed accessible webs from the recorded exterior areas." opens the card
but gets location-neutral wording ("the webs we could reach on the
exterior") — codex P2 2026-09-28 round 5. The same
predicate feeds the `EXPECTATIONS` grounding section below; that path is
structurally incapable of proving perimeter evidence (its product list is
deduped by catalog product, not by application) and so always gets the
neutral wording, never a stronger claim than the deterministic card itself
would make with the same missing evidence. The pest week's rain reading is
**FROZEN AT FIRST RENDER** (codex P0 2026-09-28, refined codex P1
2026-09-29 rounds 3–4 — the SAME pin the lawn water balance above uses,
for the identical reason): `report-data.js`'s `resolvePestWeekWeather` /
`resolvePestWeekWeatherForBuild`, called from INSIDE `buildReportV1Data`
itself, is the ONE canonical resolution every caller shares — the direct
PDF route's pre-render pass, `pdf-queue.js`'s pre-render pass, AND the
browser's own independent live `/data` fetch all call `buildReportV1Data`.
`pestWeekWeatherPendingReason` (public, top-level, sibling of the boolean)
says WHY: `open_window` (time-dependent — `pdf-queue.js` defers the job to
the next ET midnight, reason `pest_week_weather_unsettled`),
`no_coordinates` (a legacy record the geocoder backstop may still fill —
also deferred, `pest_week_weather_no_coordinates`), or `unavailable` /
`unfrozen` (a provider outage, a fetch timeout or a failed freeze — TRANSIENT,
reason `pest_week_weather_unavailable`, which takes the queue's normal
5/30/240-minute failure retry ladder instead of waiting for midnight; codex
P2 2026-09-28 round 5). A record whose completion-time identity snapshot has
FROZEN `mapCenter` (even as null) can never regain coordinates, so its
missing coordinates are PERMANENT and cacheable, not pending. Reports the
Pest V2 composer excludes — cockroach-family typed reports, or
`PEST_REPORT_V2` off — never resolve weather at all (no fetch, no pin, never
uncacheable over weather). The lookup is OPT-IN (codex P2 2026-09-28 round 4, `pestWeekWeather: true`
in `buildReportV1Data`'s options): only the `/data` response builder
(which also serves the direct PDF route) and `pdf-queue.js` pass it; every
other caller — e.g. the public `/:token/map.svg` handler, which renders no
expectations — skips the resolution entirely (no fetch, no pin write, and
`pestWeekWeatherUncacheable` stays false), so a cold provider outage can
never hold a request that has no use for the weather. Live requests bound
the lookup at 1.2 s; PDF pre-renders stay unbounded.
Inside `reports-public.js`, `buildServiceReportV1ResponseData`'s own
`pestWeekWeather` param (`pestExpectationsWeather`, mirroring the
`upcomingVisitsCard`/`nearYou` opt-in pattern) is what threads that value
down to `buildReportV1Data` above AND gates the separate live heavy-rain NWS
forecast fetch (`fetchPestRainForecastHeavySafe`, its own ~1.2 s deadline)
further down the same function — the direct PDF route and the `/data` route
both pass `pestExpectationsWeather: true`; `POST /:token/ask` (the Q&A
endpoint) does not (codex P2 2026-09-28 round 4 originally scoped the
opt-in to `report-data.js` only, which left the WRAPPER passing
`pestWeekWeather: true` unconditionally for every one of its own callers,
`/ask` included — codex P2 #5137 deferred finding a). `/ask` calls the
builder purely for report CONTEXT and `answerServiceReportQuestion` never
reads `data.pestReportV2.expectations`, so it was paying up to ~1.2 s for
the week-weather lookup and another ~1.2 s for the forecast on every
customer question, under the general report limiter, for a field it never
serves.
The first successful render freezes the settled week onto
`service_records.structured_notes.pestWeekWeather` (first-writer-wins, an
atomic conditional UPDATE guarded on the key's absence — no preceding
read, exactly like the lawn freeze); every later reader — a pre-render
preflight OR a live view, in either order — replays the SAME persisted
value. This is what makes `pestWeekWeatherUncacheable` sound: an earlier
design fetched the week INDEPENDENTLY in each of the three call sites (a
preflight racing its own short deadline in one process invocation cannot
know what the browser's own fetch, in a SEPARATE request, will resolve
moments later — a successful preflight followed by a browser-side timeout
would cache a PDF that disagrees with what the browser actually rendered);
the pin removes that divergence entirely, since there is no longer a
separate fetch anywhere to disagree with the render.
`pestWeekWeatherUncacheable` is a public, top-level boolean
`report-data.js` attaches directly to the object `buildReportV1Data`
returns (sibling of `pestReportV2`, which is composed later in
`reports-public.js`'s wrapper — so the marker survives even when
`pestReportV2` itself composes to nothing), TRUE whenever the gate is on,
either the visit has NO coordinates yet (codex P2 2026-09-28 round 4:
that state is PENDING, not permanent — the hourly geocoder backstop fills
null customer/service-location coordinates, the same `no_coordinates`
rule the lawn water balance uses — so nothing is fetched but nothing is
cached either) or a fetch was attempted and the result is not both SETTLED (`windowClosed === true`) AND POPULATED
(`rainInches != null`) AND successfully FROZEN — an open window, a
provider outage disguised as a "settled" empty reading
(`fetchServiceWeekWeather`'s own fallback can legitimately return
`{ rainInches: null, windowClosed: true }` for a geocoded property when
every source misses), an unexpected fetch exception, and a freeze write
that could not be persisted (or read back) are all treated alike — never
cacheable, since a retry (of the freeze, or simply the window closing) can
recover any of them and the render only shows "no rain block" because the
data is missing, not because none exists. The raw provider numbers
(`rainInches`, `dailyRain`, ...) that feed `expectations.rain` are
server-internal only, carried from `buildReportV1Data` to the caller
solely through the same opt-in `expectationFactsOut` out-param
`moa_group`/`rainfast_minutes` already use — never attached to the object
the function returns, so nothing beyond the boolean marker and the
customer-facing `rain.lines` sentence documented above reaches the public
payload. **LIVE requests only** are additionally bounded to a short
(~1200ms) deadline on the resolver call — `resolvePestWeekWeatherForBuild`
— so a slow provider never holds a customer's page load; on a timeout the
request gets the SAME `{ unavailable: true }` sentinel a fetch exception
produces, and the underlying resolution keeps running in the background
(never cancelled) and still freezes the real answer once it settles — the
timed-out request is never itself the one writing a freeze, so it can
never persist a wrong or partial answer. A background PDF/static
pre-render pass (the direct route or `pdf-queue.js`) is not a live UX
concern and stays UNBOUNDED, matching the lawn water balance's own
equivalent fetch exactly (no deadline there either). Both PDF
cache-decision sites (the direct `/:token` route and the queued renderer
in `pdf-queue.js`) read `pestWeekWeatherUncacheable` straight off the
object `buildReportV1Data` returns and skip storing under the stable
`-pex2` key when it is set, so a later render — once the window closes or
the provider recovers — is what gets cached, not a permanent "no rain
block" copy. This flag rides the JSON payload the same way
`lawnAssessment.weekWeatherUncacheable` already does; it is a boolean
cache-eligibility marker, not visit data.
`spiders: { headline, whatWeDid, expectation }` — a fixed,
non-guaranteeing acknowledgment card whose SOLE trigger (owner ruling
2026-09-28, revised: a spider-targeted product does NOT by itself establish
that eaves were treated — the tech may have tagged it while applying it
somewhere else entirely) is a recorded COMPLETED eave/web/soffit protocol
action; no such action recorded → no spider section at all, regardless of
any spider-targeted product. That gate alone is not enough to CLAIM webs
were knocked down, though (codex P2 #5137 deferred finding b): the
completedActions "serviced-eaves" choice, "Completed the recorded eave and
soffit service." (`client/src/lib/service-completion-choices.js`), names the
eaves/soffit and so opens the section, but records no web-removal work of
any kind — it could just as easily be a residual application or a plain
inspection. Every wording below opens with "We swept webs and egg sacs...", so
that specific claim additionally requires an action that actually says a web
was removed: either it names web(s)/webbing/a cobweb directly (the
completedActions "removed-webs" choice, "Removed accessible webs from the
recorded exterior areas.") or it explicitly SWEPT (the protocol library's
"Swept eaves, window frames, door frames, and lanai" — sweeping IS the
web-removal act). A location-only eave/soffit action with neither gets NO
card at all, gate on or off, residual evidence or not — an unproven "we
swept webs" claim is never invented just because a treatment
happened to reach the eaves. `whatWeDid` / `expectation` are
ALWAYS one of two fixed combinations (no `nextStep`: owner 2026-10-01, webs
are not a return-visit item): (1) the action was recorded but no
spider-labeled pyrethroid residual (from the explicit `whatToExpect`
product-name map below) was also applied, OR was applied with no evidence
tying it to the eaves — de-web-only wording, no treatment claim ("We
swept webs and any egg sacs from your eaves and entry points.") and an
expectation that never credits a residual; (2) the action was recorded AND
a product tagged for spiders that also classifies `pyrethroid` in the
explicit map was applied WITH evidence it reached the eaves/soffit area
(owner ruling 2026-09-28, P1 audit rounds 2–3: a spider-targeted pyrethroid
applied anywhere is not enough — the application's own recorded area must
be the EXACT controlled chip key "Eaves / soffit" or "Eaves / soffits"
(`shared/treatment-area-scopes.json`; there is no "overhang" chip, so
nothing else stands in for it — matched by exact key, never a substring),
or the visit separately recorded a genuine `treatmentApplied: true` eave
action, never just the sweep-only action that gates the section in the
first place) → combined wording ("We
swept webs and any egg sacs, then applied a residual insecticide to the eaves
and entry points where spiders build.") with a residual-backed expectation — even here, the eaves-treated
claim rests on recorded, structured evidence, never on the product tag
alone and never on free text. Neither combination ever interpolates a raw
completed protocol-action label. Raw protocol-action labels
(`server/services/service-report/report-data.js`'s
`completedProtocolActionLabels` / `completedProtocolActionEntries` — the
latter keeps each entry's `treatmentApplied` for the residual-evidence check
above) are internal tech/protocol vocabulary and are SERVER-INTERNAL ONLY:
`reports-public.js` computes them directly from the DB-joined `service` row
for this one gated builder call and they are never attached to `data`/the
object `buildReportV1Data` returns, so no public report payload — `/data`,
the PDF, `/map.svg`, or any other render — carries a `protocolActionLabels`
field or any completed-action label text, regardless of the gate.
`whatToExpect: { lines: [string] }` — up to 3 de-duplicated, honest lines
keyed to product class, resolved through an EXPLICIT, CLOSED map keyed by
the exact catalog product name only (owner ruling 2026-09-28, revised:
active_ingredient / moa_group / category inference was replaced after 2
rounds of misclassification — e.g. it would have called an Advion Ant Bait
Gel a roach product via the shared "bait" category). Currently mapped:
Taurus SC, Alpine WSG → non-repellent; Atticus Talak (the catalog's
canonical `products_catalog.name` — migration
20260712100000_catalog_label_rate_backfill.js) AND the longer "Atticus
Talak 7.9 F" display spelling several fixtures use, Demand CS,
Onslaught Fastcap → pyrethroid barrier; Delta Dust → its OWN `dust` class
(owner ruling 2026-09-28, P1 audit round 2: a dust formulation goes into
cracks/voids, never a surface barrier, so it never shares the pyrethroid
barrier copy); Advion Evolution Cockroach Gel Bait, Advion Cockroach Gel
Bait → roach gel bait; Advion Ant Bait Gel → ant bait; Advion WDG Granular
(a granular bait broadcast by the pound, with no approved line) → no class;
Gentrol IGR, Tekko Pro IGR → IGR; LESCO 90/10 Nonionic Surfactant is
explicitly mapped to no class. A product NOT in this map gets no line —
fail closed, never guessed; extending the map to a new product requires an
owner-verified name, never reintroduced inference. The pyrethroid barrier
sentence additionally requires structured application evidence (an EXPLICIT
`method` of `perimeter_spray` / `broadcast_spray`, or an `applicationArea`
chip the controlled classification — `shared/treatment-area-scopes.json`'s
`exterior` list — places there, matched by EXACT chip key after a comma
split and normalization, never a substring/regex match, codex P1 2026-09-29
round 3) that the application was exterior — an inferred (not explicitly
recorded) method is treated as unknown, never assumed exterior; an
unrecognized or free-text area string never qualifies either, fail closed;
when the method/area is unknown or indicates an interior application, the
report uses different, non-barrier wording for the SAME product class
rather than silently asserting the claim. The non-repellent "6-foot
perimeter band" sentence needs one non-repellent application that is both
ant-tagged and recorded as a band: an explicit `perimeter_spray` method or a
perimeter/foundation chip (Perimeter, Exterior perimeter, Property
perimeter, Foundation, Foundation perimeter) by exact key; any other
exterior chip is spot work and gets the general non-repellent wording. Each line names the active ingredient from a
closed product-name map (fipronil, dinotefuran, indoxacarb, bifenthrin,
lambda-cyhalothrin, esfenvalerate, deltamethrin, (S)-hydroprene,
pyriproxyfen and novaluron; owner 2026-10-01: never a brand name), and the
barrier sentence names only the products recorded exterior. The bait and
dust lines make no placement claim (the builder reads no area or method),
the AI writer's plain variant leaves out label durations ("up to 8
months") and customer instructions, and the Tekko Pro 6-month
cockroach-nymph sentence needs a roach target on that application. Never a
"guaranteed" or "eliminated" claim (screened through the existing
`validateCustomerCopy` banned-copy guard). The what-to-expect facts (never the rain block, never
the spider block, never the live forecast clause) also feed an `EXPECTATIONS` section
into the AI report writer's grounding context
(`report-copy-context.js`'s `buildReportCopyContext`) under the same gate,
so generated copy never contradicts the deterministic blocks — that
grounding text is a prompt input, not part of any customer-fetchable
payload. The grounding carries NO rain or ants-after-rain lines at all
(codex P1 2026-09-28 round 4): the writer runs at completion, the same day
as the visit, when the trailing 7-day window is by definition still
accumulating, so any total would be a partial reading baked permanently
into saved summary text while the PDF deliberately withholds that same
number until `windowClosed` — only the product-class what-to-expect lines
ground the writer; that caller has no per-application method/area data (its product
list is deduped by catalog product, not by application), so it always
falls back to the non-barrier pyrethroid wording rather than assuming a
barrier — the same fail-closed default, never a contradiction with the
deterministic card. The grounding never resolves weekly weather for the visit (no
serviced-parcel lookup, no pin read) — rain is a render-time card only. `moa_group` and `rainfast_minutes` (the catalog facts
that drive this classification) are SERVER-INTERNAL ONLY (codex P0
2026-09-28): they are never present on `data.applications[].product` in any
render (gate on or off, every service line) — `report-data.js`'s
`buildReportV1Data` hands them to the caller solely through an opt-in
`expectationFactsOut` out-param that is never attached to the object the
function returns, the same "server-internal, never on `data`" contract
`completedProtocolActionLabels` uses.

Report plan summary (owner ask 2026-09-28): `GATE_REPORT_PLAN_SUMMARY` (off
unless exactly `true`, read at startup). On, the LIVE service-report payload
(`/api/reports/:token/data`, the only caller that opts in with
`planSummary: true`, built with `mode: 'live'`; the `/ask` Q&A build and every
other build neither read nor carry it) may carry `planSummary: { year, visitsThisYear,
reservicesThisYear }` for the token's own customer, only when that customer
is an active plan member (`isActivePlanCustomer`, fail-closed to non-member)
with at least one performed visit this year; anyone else gets no field and no
plan wording on the page. The plan is account-level, so the counts cover the
account's visits, not only this property's. `visitsThisYear` counts PERFORMED
visits in the current ET calendar year: completed, customer-visible service
records whose outcome is not inspection-only, customer-declined or incomplete
(the Pest Pressure prior-visit rule, `pest-pressure/first-visit.js`), never a
schedule row's status alone, and one physical stop counts once (grouped
services share the booking's `visit_id`, and a booking's sibling completion
records — detailed form, recap rail — count as that one booking). `reservicesThisYear` counts how many
of those stops were callbacks, decided by the record's frozen completion-time
evidence only: its `is_callback`, or its `service_data.completedServiceKey` of
`pest_re_service` / `lawn_re_service` — never the booking row (repointable
after closeout) or a "Re-Service" display name; a rodent-program visit, such
as the included trapping follow-up, never counts, by its key or its rodent
line. Counts only: no
price, no "at no charge" claim (a callback can be billed; see
`reservice-report.js`), no upcoming visits, dates, address, technician, or
token. `stripLiveOnlyScheduleFields` also
deletes it from every non-live render (PDF, static, sms_preview), the same
staleness rule as `nextAppointment`. No new route and no write; auth, headers
and rate limits are unchanged.

Report near-you line (owner ask 2026-09-28, "lawn only"):
`GATE_REPORT_NEAR_YOU` (off unless exactly `true`, read at startup). On, the
LIVE service-report payload (`/api/reports/:token/data` only — the one caller
that opts in with `nearYou: true`; the `/ask` Q&A build and every other build
neither read nor carry it) may carry `nearYou: { city, pest }` on a LAWN report
only: the lawn pest most often recorded among OTHER lawn customers in this
report's own service city over the last 30 ET days. A visit's city is the one
its own report shows: the frozen `reportIdentitySnapshot` city when the record
has one, else the stamped service address city, else the customer's (the
report query's `COALESCE(ss.service_address_city, customers.city)`), so a
customer who later moved never carries old findings to the new city; compared
trimmed and case-blind. Records count only when completed, performed
(not inspection-only, customer-declined or incomplete) and customer-visible;
the pest comes only from each visit's closeout form snapshot
(`structured_notes.formObservations`, server-allowlisted at completion), matched
exactly to a definite-live-pest observation — never from `service_findings`
titles, which can be free text — and is shown as a fixed customer noun
(`LAWN_DEFINITE_LIVE_PEST_CUSTOMER_TERMS`).
A pest is named only once at least 3 distinct customers
(`NEAR_YOU_MIN_CUSTOMERS`) had it — the privacy floor, so one household's
problem is never broadcast; ties go to the label that sorts first; below the
floor the field is omitted. `city` echoes the report's own city; there is no
count, customer name, or address in it. `stripLiveOnlyScheduleFields` also
deletes it from every non-live render (PDF, static, sms_preview). No new route
and no write; auth, headers and rate limits are unchanged.

Report product wording (owner-approved 2026-09-28, verbatim from the reviewed
wording page): `GATE_REPORT_PRODUCT_COPY` (off unless exactly `true`, read at
CALL time via `reportProductCopyGateOn()` in
`server/services/service-report/report-product-copy.js` — the
`reportProductCopy` feature-gates map entry is for `logGateStatus` only).
Unlike `planSummary`/`nearYou` above, this field is attached unconditionally
by `buildReportV1Data` (not behind an opt-in param) but IS live-view-only in
its own right (codex P1 2026-09-28): the PDF/static/sms_preview cache keys
never varied on this gate, so caching it under the worker's own gate state
(rather than what the browser actually rendered, on a rolling deploy where
old and new workers disagree) would serve stale or mismatched copy. It is
therefore stripped from every non-live mode at the same payload boundary
`stripLiveOnlyScheduleFields` uses —
`stripLiveOnlyReportProductCopy(data)` (`server/services/service-report/
report-data.js`), called from `buildServiceReportV1ResponseData`'s
`mode !== 'live'` block (covers the `/data` route's pdf/static/sms_preview
modes and the direct PDF route, which shares that function) and
unconditionally from `pdf-queue.js`'s queued renderer (which builds its
payload outside that function, mirroring how it also calls
`stripLiveOnlyScheduleFields` directly). On a live render, an applied
product that matches the static reviewed config
(`server/config/report-product-copy.js`) — by EPA registration number
primarily (`product.epa_reg_number`, resolved off the catalog join the same
way the existing product-safety fields are; a NON-EMPTY EPA reg is
authoritative and never falls back to a name alias) and NOT on a
termite-family report (`serviceLine !== 'termite'`, `detectServiceLine` /
`service.service_line` from `service-line-configs.js` — Taurus SC and other
pest-line products carry ant/roach-specific wording that does not belong on
a termite liquid/trench/bait visit), or by an explicit normalized-name alias
list when no EPA reg is recorded at all (a hand-entered row with no catalog
`product_id` still carries its snapshotted `product_name`) — gets
`applications[N].product.report_copy: { how_it_works, also_labeled_for,
pets_kids }`. Since owner ruling 2026-09-29, `also_labeled_for` is a single
composed sentence — `Labeled for {N}+ {City} pests` (e.g. "Labeled for 75+
Bradenton pests"), or `Labeled for {N}+ pests` when no usable city is
available — never a named pest list. `N` is the product's raw label pest
count (`alsoLabeledForPestCount` in `server/config/report-product-copy.js`,
each with a source/date comment) floored to a multiple of 25
(`floorToMultipleOf25`); `City` is the visit's own city — `service.city` as
`buildReportV1Data` already resolves it (the visit's stamped service address
city via `COALESCE(ss.service_address_city, customers.city)`, i.e. the
property serviced, falling back to the customer's own city), normalized for
display (`normalizeReportCity`: trimmed, internal whitespace collapsed, and
title-cased when the raw value is entirely upper-case or entirely lower-case; mixed case is kept as entered — never invented)
before it is composed into the sentence (`buildAlsoLabeledForText`); a
blank/unusable city (or none at all) drops to the no-city wording rather
than blocking the rest of the copy. `also_labeled_for` is OMITTED (never a
null/empty string) for products with no `alsoLabeledForPestCount` at all —
narrow products (gel baits, granular bait, IGRs) and the LESCO 90/10
Nonionic Surfactant (an adjuvant, not a pesticide). Matching is exact only —
never a substring/fuzzy match, same posture as
`pest-report-expectations.js`'s `PRODUCT_EXPECTATION_CLASS` — so a product
absent from the config (every catalog product not on the owner-approved
page) gets NO `report_copy` key at all, fail closed. Every line clears the
shared banned-copy screen (`premium-experience.js`'s `validateCustomerCopy`)
before it can render, and `pets_kids` is sanitized through
`stripFixedReentryTiming` (the same AGENTS.md fixed-minute-reentry-figure
guard `precaution_summary`/`reentry_summary` are swept with, reused from
`social-media.js`) BEFORE the banned-copy screen runs on it — the sanitized
text is what gets screened, so a fixed-minute claim is replaced with the
safe idiom rather than dropping the whole copy block — at the SOURCE inside
`reportProductCopyForApplicationProduct`, live included, so the live report
gets the same guard the PDF does. Customer-display only: this copy is never
read by the AI report writer's grounding (`report-copy-context.js` builds
its own product-evidence list independently of `buildReportV1Data`'s
`applications`, so it never sees `report_copy`), and it never reaches the
PDF's rendered document at all (`ServiceReportDocument.jsx` carries no
`report_copy` render) — the PDF's content-insensitive storage key is
therefore unaffected by this gate. No new route and no write; auth, headers
and rate limits are unchanged.

Invoice line-item ownership metadata: `/api/pay/:token` and
`/api/receipt/:token` return the invoice's persisted `line_items` as `lineItems`.
On itemized accepted-plan invoices, each base-application row intentionally may
include `client_id` (`scheduled_<scheduled-service UUID>_primary`),
`accepted_service_type`, and `accepted_service_id` (the catalog service UUID).
These values freeze the billed row's service ownership for combined-visit
closeout. They are opaque, non-bearer references that grant no read or write
access; no sibling invoice, report, receipt, or other bearer token rides a line
item. Legacy and unrelated invoice rows may omit the ownership fields.

Visit note: `/api/pay/:token` returns `service.techNotes` only as the reviewed
report text (`customerSafeVisitNotes` with `projectLine`, server/services/context-aggregator.js;
owner ruling 2026-10-01: customers see only the report text, never the tech's
raw note). The invoice keeps the note as it stood when billed, which on older
invoices is the raw note, so the route screens it on the way out against the
visit's own record (`service_records` by the invoice's `service_record_id` and
`customer_id`). A raw note, a combined-visit invoice (it keeps none) or a
missing record returns null.

`/api/pay/:token`
(+ `/setup`, `/quote`, `/finalize`, `/confirm`, `/consent`,
`/capture-setup`, `/setup-complete`, `/update-amount`, `/error`,
`/invoice.pdf`, `/attachments/:id` — the invoice pay surface; router-wide
60/min limiter + url-safe 20-64 token format gate with generic 404,
mirroring pay-statement.js; legacy 25-32 char invoice tokens remain
valid. A received estimate deposit awaiting invoice reconciliation blocks
the pay-page GET and new collection with HTTP 409 and
`reconciliationRequired: true`. The deposit ledger is the hold authority;
payer-billed invoices are exempt. Recording an already-settled PaymentIntent
and permanent receipt access remain available. OWNER RULING 2026-08-16,
superseding the earlier "no sibling-
invoice data on this surface" P0: with GATE_PAY_INCLUDE_BALANCE on, the
pay page ITEMIZES the customer's other open self-pay invoices — numbers,
dates, amounts, an accepted forwarded-link disclosure — and the Pay
button charges the COMBINED total via one PI carrying a per-invoice
metadata allocation (services/pay-combined.js is the one authority for
selection, allocation, and settle). Sibling TOKENS still never ride the
payload, and gate off ⇒ byte-identical to the single-invoice surface.
Off-Stripe tender block (2026-08-29; ZELLE-ONLY since 2026-09-02 — owner
ruling, Venmo and PayPal retired over their fees): the GET payload carries
an OPTIONAL `manualPayOptions` = `{ zelle: { recipient }, amountDue,
version, creditPending? }` only when `ZELLE_RECIPIENT` is set (unset ⇒ key
absent, payload byte-identical — that is the kill switch; `VENMO_HANDLE` /
`PAYPAL_ME_HANDLE` are ignored and cannot resurrect a tender) AND the
invoice is collectible, not saved-method-required, not fully covered by
account credit, not riding a combined-balance session, has no saved-card
charge reconciliation pending, and any stamped PaymentIntent is still
cancelable (inspect-only, fail-closed — unverifiable ⇒ key withheld). The
recipient is the business's own Zelle contact, never customer data. The
client re-reads this payload on expand / tab re-focus / 45 s cadence and
keeps every control disabled until a fresh read succeeds; no pre-filled
transfer link exists for Zelle, so nothing on the page constructs a
payment URL from the payload. FAQ flag (2026-09-03): with
GATE_PAY_PAGE_FAQ=true the GET payload carries `payFaq: true` — a display
flag for the copy-only "Common questions" accordion under the Pay button;
no other field changes, no customer or invoice data rides it, and gate off
⇒ key absent, payload byte-identical — unset the gate to kill it. THIRD-PARTY
BILL-TO WITHDRAWAL (2026-09-12): a combined-visit invoice whose Bill-To moved
to a payer AFTER the homeowner already held this link keeps a collectible
status and a NULL `payer_id` — the move is recorded only in its withdrawal
stamp — so every money seam on this surface reads the invoice ROW, not its
status. `/setup`, `/quote`, `/finalize`, `/confirm` and `/update-amount`
refuse such an invoice through the shared collectibility gate, and `/consent`,
`/capture-setup` and `/setup-complete` refuse it with
`409 { error, code: 'invoice_withdrawn_from_customer' }`. What that refusal
guarantees, precisely: no consent is recorded and no Auto Pay enrollment
happens for a withdrawn invoice — the authorization row and the ownership
judgement commit in ONE transaction, and the enrollment re-judges ownership
inside its own. A Bill-To change that lands mid-request, after the Stripe
`attach` but before that fence, can leave the method attached to the
customer's Stripe record; it is inert (no consent, not enrolled, not
default) and the request still answers 409. The attach cannot join a database
transaction, and the customer did ask to save the card. A
withdrawn invoice is also absent from the authenticated portal's balance and
Pay Now list, and carries no `manualPayOptions`. Nothing else in the payload
changes; an invoice that returns to self-pay is released by the Bill-To
reconciliation and collects normally again). TERMITE RENEWAL ELIGIBILITY
(2026-09-28, dark behind GATE_TERMITE_ANNUAL_PLAN — only an invoice that is a
termite annual-plan RENEWAL successor's prepay invoice, found through its own
`annual_prepay_term_id` link, is ever judged; every other invoice is
byte-identical and costs no extra query): a renewal pay link the customer
already holds stops collecting once the prior year's plan no longer backs the
renewal — the prior plan was cancelled, refunded, or had its dates moved, the
account was deleted, the renewal payment is under dispute, or the renewal's
payment grace has closed. `/setup`, `/quote`, `/finalize` and `/update-amount`
then answer `409 { error, renewalNotPayable: true }` with a customer-safe
message (no plan, parent or reason detail rides the payload), and `/finalize`
additionally runs its charge UNDER the renewal gate with the same check
repeated inside it, so a prior-plan change either waits for the charge or is
seen by it. `/confirm`, receipts and `invoice.pdf` are unchanged — recording a
payment Stripe already collected always remains available). RENDERED CONSENT
VERSION (2026-09-30, codex #5434 r1 P1 — every surface that captures a
saved-payment-method consent): the client bundles its own copy of the consent
text (`client/src/lib/paymentMethodConsentText.js`), so a tab left open across
a copy change keeps rendering the older text. (The v12 copy family — base
card/ACH, the immediate-charge prepay variants and the after-visit variants of
GATE_PAY_AFTER_FIRST_VISIT — all carry the rate-review sentence; the base and prepay
variants are `v12_2026-09-30`, the revised after-visit variants
`v13_2026-10-01` (#5481's v12 after-visit rows carry the text without it); a one-time card HOLD snapshots its own disclosure
under `hold_v1_2026-10-01`, which never qualifies for enrollment.) Every save-the-method capture
therefore carries `consentTextVersion`, the `CONSENT_VERSION` the tab
rendered beside its checkbox. `/setup`, `/update-amount` and `/finalize`
refuse a save (requested, or forced by a required-save invoice) whose
attestation is not the server's current version — or is absent — with
`409 { error, code: 'CONSENT_VERSION_STALE' }` BEFORE any Stripe work (on the
estimate accept, a tab that attests its saved-card capture per #5481 —
`recurringCardConsentVersion` / `Variant` / `Tender` — is judged by that
verification inside the accept transaction instead, whose stale or
mismatched attestation answers `CONSENT_VARIANT_STALE`), and
thread the version into the mint, which stamps it on the PaymentIntent
(`metadata.consent_text_version`, beside `save_card_opt_in`; carried across a
tender replacement). A `/setup` that would REUSE an open PaymentIntent — or
an `/update-amount` on one — whose stamp differs from the one it would write
(an older version, or none — the rollout) cancels and replaces it instead of
updating in place (the `replaced` response re-mounts Elements): the stale tab
that minted it can confirm straight with Stripe (Express Checkout), and an
in-place re-stamp would let the webhook record the newer version against
text that tab never rendered. A replacement carries a SUPERSET of the old
intent's metadata (`waves_customer_id`, `save_card_opt_in`, the consent
stamp, …) with the new values winning, so the webhook mirrors keyed on
those stamps keep working across the swap, and the `replaced` response carries
`methodCategory` (the tender the fresh intent is locked to) so the page
re-mounts its form on that tender instead of defaulting to card. `/finalize`
never re-stamps in
place either: under the invoice lock it reads the PaymentIntent's live stamp
and refuses with `409 { error, staleBalance: true }` (the page reloads and
re-syncs through `/setup`) when it differs from the one it would write. `/capture-setup` does the same and stamps the
SetupIntent. `/consent` and `/setup-complete` record ONLY under the intent's
own current stamp — never the posting bundle's constant, since a redirect
return posts from a freshly loaded, possibly newer bundle — answering the
same 409 otherwise (the payment itself already settled; only the saved-method
authorization is withheld), and the `payment_intent.succeeded` save mirror and
the `covered_capture` webhook apply the identical rule: a stale or absent
stamp keeps the method saved but unconsented and unenrolled and parks one
Billing bell per intent for the office to re-collect the authorization. A
plain one-off payment (no save) attests nothing and is unchanged. Existing
rows are untouched — the enrollment floor (v8+) does not move, so no existing
customer is re-asked),
`/api/pay/statement/:token` (+ `/setup`, `/quote`, `/finalize`) — payer NET
statement self-serve pay, **gated behind GATE_PAYER_STATEMENTS** (404 when off),
64-hex `payer_statements.token` format gate + public-route rate limit; resolves
a `payer_statements` row (never a homeowner record), charges the PAYER's Stripe
customer only, exposes only the consolidated statement + serviced addresses
already on it (no homeowner PII/links); settlement happens via the webhook,
not the route,
`/api/receipt/:token` (inspection-credit terms come only from this invoice's
persisted offers; a combined visit includes its billed packet members, matched
by packet and customer identity. Unrelated visits and payer-billed invoices
never expose homeowner credit terms), `/api/contracts/:token`, `/api/booking/*`,
`/api/public/estimates/:token/ask`,
`/api/public/estimates/:token/find-slots`,
`/api/public/estimates/:token/available-slots`, `/reserve` and
`/reserve/:scheduledServiceId/extend` (the recurring
service profile uses the converter's canonical stored/engine service rows.
Generated or saved tier selections replace the listed service cadences and
retain omitted companion programs; choosing a tier is not a service removal.
The existing pest-only recurring choice on eligible one-time-toggle estimates
retains its intentional companion exclusion, using the acceptance predicate.
With default-off `GATE_SCHEDULING_CAPACITY`, these public availability surfaces
use whole-route feasibility, technician eligibility, existing arrival promises,
blocked time and return-by-shift-end checks. Only evaluated whole-hour starts
on the shared customer grid (09:00–17:00 ET, `scheduling/customer-windows.js`;
the customer-facing day closes at 18:00, and `booking_config.day_end` was
migrated to 18:00 on 2026-09-23) are offered; estimate ASAP and booking
open-day expansion cannot create additional starts. 12:00 is an ordinary
offerable and reservable hour unless `GATE_BOOKING_LUNCH_BLOCK` is set, in
which case every customer-facing offer AND commit surface (estimate picker +
reserve, /book, public reschedule, public re-service, the assistant's
availability engine) refuses a window overlapping 12:00–13:00. The estimate cache separates capacity mode
from legacy mode. Assigned technicians have independent route capacity;
unassigned work remains a fixed blocker. Public responses expose no full route,
provider legs or exact route coordinates. Scheduling traffic lookups share a
40-request/800-element allowance per application process per 15 minutes across
HTTP requests and fall back to the conservative model when exhausted; response
data remains request-local. Existing stops are planned at the owner planning
minutes (`scheduling/planning-minutes.js`, owner 2026-09-25) rather than their
window span; the visit being offered keeps its own resolved allowance.
`/book`'s self-booking offers (`/api/booking/availability`, `/find-slots`,
the `/capture-intent` revalidation, public re-service, and inspection
booking) evaluate the new visit at every position in the technician's route,
including BETWEEN two existing stops, not only appended after the stored
order, only while `GATE_BOOK_CAPACITY_COMMIT` AND `GATE_SCHEDULING_CAPACITY`
are both live (`bookInsertionOffersLive()`, routes/booking.js) — the same
condition the estimate routes' own insertion already required (owner
2026-09-28). That commit (`createSelfBooking`) re-verifies with live traffic
and saves the certified route order, so an inserted offer it confirms is
exactly what gets persisted. The voice agent keeps append-only offers
because its own commit does not save a route order: it inserts the new row
with no `route_order` at all, so an inserted offer would commit as an
unnumbered stop sorted after the route, not at the position it was offered
at. `/book` offers minted with mid-route insertion carry a signed policy tag
(`BOOK_INSERTION_OFFER_POLICY`, `utils/slot-offer-token.js`) inside their
`slot_sig`, so an offer can't be confirmed under a different
`GATE_BOOK_CAPACITY_COMMIT`/`GATE_SCHEDULING_CAPACITY` state than the one it
was minted under (a rollback or a mixed rolling deploy inside the 45-minute
offer window) — the customer gets the standard "pick your time again" 409
instead of a silently mis-ordered commit. The staff save probe
(`checkArrivalPlacement`) stays append-only too.

Public self-serve reschedule (`/api/public/reschedule/:token`,
`routes/reschedule-public.js`) joined the certified-order group for its
SINGLE-VISIT commit only (owner 2026-09-28; Codex round 1 fixes on PR #5267,
same day). Its one picker (`buildAvailabilityForService`, behind the GET
summary, the AI find-slots search, and the commit route's own anti-forgery
re-check) passes `capacityPlacement: bookInsertionOffersLive() &&
!pickerMayReanchor(svc, rangeFrom, rangeTo)` — the same reader /book's
self-booking offers use, ANDed with a check that this build's date range
can't need a series re-anchor (see the re-anchor paragraph below). Its
single-visit commit (`SmartRebooker.reschedule` → `rescheduleOnce`,
`services/rebooker.js`) opts in by passing `capacityPlacement: true`, which
is what scopes this to reschedule-public.js alone — every other
`SmartRebooker.reschedule` caller (admin dispatch, auto-dispatch, rain-out,
SMS reply) omits it and is byte-identical, even with the gate live.
`rescheduleOnce` re-reads `bookInsertionOffersLive()` itself rather than
trusting that flag or anything client-supplied — this surface verifies no
`slot_sig` at all, so there is no signed-policy-tag mechanism to replicate;
the anti-forgery re-check that guards it instead is a fresh
`buildAvailabilityForService` rebuild in the SAME request as the commit, a
few lines before `SmartRebooker.reschedule` is called, so that rebuild's
`capacityPlacement` and the commit's own gate read are microseconds apart
rather than spanning a stored offer's lifetime.

When a day, technician, OR WINDOW move would otherwise leave the stored
`route_order` wrong — a day/tech change nulls it (the existing append-only
rule); a same-day, same-tech window-only move used to silently KEEP the old
number even though the stop's place in the route had changed (Codex round 1
P1) — and the row has a technician, is ungrouped (`visit_id` null), and the
gate is live, `rescheduleOnce` runs the SAME `prepareArrivalCapacity`
(before any lock, using the row's OWN current stored state — it already
handles a row staying on its own route, nothing extra needed for a
window-only move) → `lockTechDays` (already taken at the same rung the
plain occupancy checks use) → a `SELECT ... FOR UPDATE` on the moving row
itself, immediately before verify (Codex round 1 P1: `verifyArrivalCapacity`
only locks the DESTINATION day/tech, never the row's own OLD date, and the
CAS predicate never pins duration/address/service_type — without this lock
a concurrent edit to any of those could commit a route order certified
against data that was already stale) → `verifyArrivalCapacity` (under that
lock, now reading the row fresh) → `persistArrivalOrder` (after the row's
own CAS write lands) sequence `createSelfBooking` runs. A changed route
fingerprint or an infeasible live fit refuses with the standard
`capacityError` 409 (`SLOT_UNAVAILABLE`) and writes nothing; success
persists the certified order instead of nulling it. A GROUPED visit's move
never attempts this — `moveVisitAsUnit` forwards its caller's options,
`capacityPlacement` included, unchanged into its own per-member
`rebooker.reschedule()` calls (each tagged `visitPolicy: 'single'`), and
`evaluateArrivalPlacement` refuses any row still sharing a `visit_id` with
another live stop, which would fail the whole unit move on its first
member — so this lane checks `!service.visit_id` before attempting it, a
deliberate skip rather than an oversight. The picker mirrors that skip: any
row carrying a `visit_id` (a singleton group included) is offered append-only
slots only, so it is never shown a position its commit won't certify (Codex
round 2 P1).

**Series re-anchor never offers or commits an insertion** (Codex round 1
P1, corrects the original design's assumption): a big-pull-forward re-anchor
commits through `SmartRebooker.rescheduleSeries`, which always clears
`route_order` on a move and never reads `capacityPlacement` — it does NOT
"refuse and re-validate" an inserted offer the way the commit's capacity
verify does, it would silently commit append-only under a route order that
was never certified for that position. So the offer must never be minted in
the first place: `pickerMayReanchor(svc, rangeFrom, rangeTo)` mirrors
`shouldReanchor`'s own predicate — for a SINGLE-day range (the commit's own
anti-forgery rebuild always uses one) it is the EXACT same check
`shouldReanchor` runs for that date, so the two can never disagree; for a
multi-day range (the GET picker, the find-slots search) it conservatively
disables `capacityPlacement` for the WHOLE build whenever the range's
EARLIEST candidate (the one with the largest pull-forward, under
`GATE_COLLECTIVE_SERIES_ANCHOR` effectively any date but the visit's own
current one) falls inside the re-anchor zone — under-offering insertion for
a same-build date that wouldn't individually re-anchor, never over-offering
one the commit would have to silently mis-order.

A capacity verify failure's `SLOT_UNAVAILABLE` code (Codex round 1 P2) is
rewritten into the SAME `SLOT_TAKEN` 409 response shape (message +
refreshed availability) the anti-forgery slot-miss already returns before
reaching this deep — the client (`ScheduleFlowPage.jsx`) only clears the
stale selection and refreshes the calendar on `code === 'SLOT_TAKEN'`; any
other code falls through to a bare error line with the stale slot still
selected. Detour
cap (owner 2026-09-25): self-serve callers that pass `customerFacing` (the
/book availability engine behind /api/booking/availability and the public
reschedule/re-service pickers, and the estimate slot routes) omit a feasible slot whose added round-trip drive exceeds
`SCHEDULING_MAX_DETOUR_MINUTES` (default 30; an empty day counts the whole trip
from HQ). Staff and phone booking see every fit. **Zone route days**
(`GATE_ZONE_ROUTE_DAYS`, owner 2026-09-29, default OFF): when on, that cap is
lifted per candidate for an address in a configured zone on that zone's route
weekday, so an empty route day can be offered and seeded (default: Friday for
Venice / North Port, lifted cap 150 minutes; override with the
`system_settings` key `schedule_zone_route_days`, e.g.
`{"venice":{"weekdays":[5],"max_detour_minutes":150,"technician_id":null}}`;
`{}` switches the lift off, a `technician_id` pins it to one technician). The
zone is resolved from the request's coordinates (nearest `service_zones`
center within 35 miles, so 'North Venice' / 'Northport' resolve), passed to the
finder as `zoneSlug` by `/api/booking/availability` (and everything sharing its
builder) and the estimate slot routes, and only ever raises the cap — route
feasibility (return time, overcommit, arrival window, travel gap) is still
checked. The estimate picker's south-zone funnel seeds the route day first. The phone
agent, office Find-a-Time, the Intelligence Bar and auto-dispatch are not
customer-facing and never had the cap. The finder's per-slot `return_time`
(modeled return to HQ) and result-level `rejections` tally are staff/diagnostic
fields only: /api/booking/availability builds each public slot field by field
(`routes/booking.js`) and the estimate routes build theirs through
`classifySlot`, so neither field reaches a customer response. Gate-off availability is unchanged apart from the
shared grid / day-end / lunch-gate rules above, which apply in both modes.
Commit-time capacity re-check (`GATE_BOOK_CAPACITY_COMMIT`, owner-approved
2026-09-26; needs `GATE_SCHEDULING_CAPACITY` live too): every `createSelfBooking`
commit — `/api/booking/confirm` here and the re-service commit below — prepares
the traffic-aware whole-route proof before scheduling locks, then reuses
`arrival-route.js`'s `verifyArrivalCapacity` under the transaction's existing
tech-day advisory locks. Capacity commits acquire the selected and unassigned
tech-day keys together through `lockTechDays`, in canonical order and before
row locks, because both memberships are fingerprint inputs. Verification then
locks the relevant route rows, requires the live fingerprint to match the
prepared route, and evaluates without a provider request while locks are held. This closes the gap the
overlap-only re-check (`findConflictingVisits`) leaves: another booking landing
on the tech-day between offer and confirm can push a LATER stop's promised
window past its promise, or the day over capacity, without ever overlapping
the confirmed window — that booking now refuses with the existing `SLOT_TAKEN`
409 (the same shape and client recovery as every other slot race on this
route) instead of committing a route the offer engine would no longer certify.
If the customer's exact service point changes after traffic preparation,
confirm asks for a fresh offer instead of reusing legs prepared for the old
point, even when both points share the public rounded grid.
A zone/no-tech confirm (no technician bound) has no single route to re-check
and keeps only the overlap gate, unchanged. Either gate off skips this
whole-route capacity re-check.

Tech-aware confirm conflict checks for a second field technician
(`GATE_MULTI_TECH_CONFIRM`, owner-approved 2026-09-29, ships DARK; needs
`GATE_SCHEDULING_CAPACITY` live too). The offer side (`buildBookingAvailability`'s
occupancy mirror) already keeps an occupied row only when it is unassigned or on
the offered slot's own technician; the confirm side used to be tech-blind (built
for one active technician), so a slot offered on technician B's day could be
refused at confirm because technician A had an overlapping or nearby stop. With
both gates on, `createSelfBooking` (`/api/booking/confirm`, the re-service commit
and the consultation-page commit) scopes its whole conflict check to the booked
technician: the zone/city/hold fast-path legs are AND-ed with "technician_id is
NULL or equals the booked technician", and the global backstop
(`findConflictingVisits`, which takes an opt-in `technicianId`) counts only the
same technician's rows plus unassigned ones. Unassigned rows still block every
technician, so the offer/commit predicates stay identical. The public reschedule
commit (`SmartRebooker.reschedule` with `capacityPlacement: true`, the same
offer builder) opts into the same scope for its kept technician. Either gate
off, or a booking with no technician, is byte-for-byte the tech-blind check
above. Every other caller — admin schedule/leads, rebooker series and
rain-out/SMS moves, the phone agent, the zone-engine confirm, estimate slot
reserve (which already verifies per technician in capacity mode), auto-dispatch
and follow-up seeders — never passes `technicianId` and is unchanged. The
date-wide occupancy advisory lock (rung 1) that every one of these writers takes
still serializes concurrent confirms per calendar day regardless of technician,
so two technicians' bookings and an unassigned insert cannot race past each
other's probe.

Public-confirm location freshness applies with either capacity gate on or
off. After the scheduling and customer-communications fences, the customer
row is held `FOR SHARE` through the insert. A complete live pin in another
signed-offer grid cell returns `LOCATION_CHANGED_RETRY` (409); a same-cell
exact correction drives the final overlap probe when the capacity commit gate
is off, while an already-prepared traffic proof requires a fresh offer.
Customers without a complete stored pair are geocoded from their server-owned
address before locks. The address and missing pair must still be unchanged under the fence,
and a matching staff geocode-review hold refuses the fallback. A valid
server-resolved pair must match the signed grid and is stamped with its
address on the new visit so dispatch uses the same location the commit
certified. The customer profile is not rewritten, cleared pins are not
restored, and no geocoder request runs while scheduling locks are held.
The official `/book` client sends its estimate identity, street-only line,
dedicated unit, and structured city/state/ZIP on every availability,
date-browse, and `/find-slots` request. The street stays free of a stale Places
subpremise after a unit edit while the structured locality keeps same-street
properties in different ZIPs distinct. The offer side
resolves the same location: `/api/booking/availability` and `/find-slots` build
an existing customer's offers (an estimate identifies the account and the
typed address/unit selects the matching property row, else the unique
unit-aware customer at that address) at that commit location — the
stored pin, else a staff-verified pin or the canonical geocode — over any
caller coordinates, and echo it only rounded; `/reservice/:token` builds its
offers on it too. Everyone else keeps the caller's coordinates or address.
For a bare signed-in `/book` entry, all three offer requests use the portal's
authenticated fetch path. These routes validate the optional bearer and bind
the typed property only within that server-resolved account while customers-
only mode is enabled; a body/query customer id is never identity. With that
gate off, offers and confirmation both ignore an ambient portal bearer and
keep the same public address behavior. A bearer from a different account
cannot sign offers on a pin that confirmation will refuse. An invalid or
absent bearer also keeps public behavior. An expired
access token gets the refreshable 401 only when the customers-only gate needs
that identity. An estimate-linked request keeps the estimate account instead
of inheriting an ambient portal session.
Quote-wizard handoff identity at `/api/booking/confirm` (customers-only gate
on): the wizard links its draft estimate to any existing customer matching
the unverified phone/email the anonymous quoter typed, and hands the token
back to that same caller, so a token-verified pricing handoff (`pricing_
estimate_id` + `estimate_token`) whose draft is linked to an ESTABLISHED
customer is not identity. The gate binds it exactly as before (same address
fix-it when the street matches no account property), and the refusal — 409
telling the customer to sign in with the portal code — is applied inside the
booking transaction under the customer row lock, after the address bind and
signed-slot validation and against the customer's CURRENT stage (a lead
promoted meanwhile is caught), so it is not an early "is this contact a
customer" probe and a typed phone plus a street match never books on someone
else's account. Residual: a caller who already holds the phone, the street
and a valid signed slot can still see the 409 for an established customer
versus the normal flow for a lead. Preserved: a verified portal bearer still
books (identity from the token, address-bound to the account); the
staff/system accept link (`source_estimate_id` + namespaced `accept_token`)
still books as the estimate's customer; a draft linked to a row still in a
pre-customer pipeline stage (the quoter's own freshly minted lead) or to no
customer keeps the quoter's own booking; an identical retry of a booking that
already committed (same draft, slot and customer, and the typed phone — or the
email that linked the draft — is the customer's) still reaches the idempotent
replay. No message is sent on the refusal: the refusal retires the open
abandoned-booking recovery intents carrying that HMAC-verified draft id (only the id — neither the typed nor the stored contact ever widens it), and
`/api/booking/capture-intent` writes such a handoff's row already suppressed
(and retires any staged for the draft). Every accepted capture-intent request
answers one constant `200 {"ok": true}` — no `skipped`, `created`/`updated` or
`intent_id` fields — whatever was staged, skipped, suppressed or errored (the
clients are fire-and-forget and read no body), so it is no probe for whether a
contact is a customer or has a recent booking; only the request-shape 400
(`valid phone required`) differs. "Blocked" is judged account-wide by one
shared classifier used by confirmation, capture-intent and the recovery worker:
the draft-linked customer row or any sibling property row on its account being
an established customer, ARCHIVED (archiving never re-opens the handoff), or the
draft's customer row being missing (fail closed) blocks it. The
suppression writes are best effort: the abandoned-booking recovery worker
re-checks at send time (SMS and email) and skips, marking suppressed, any intent
whose draft is so linked — a lookup error skips that tick — so a failed
suppression write can never lead to a message. All three apply only while the customers-only gate is on; with it off the flow still books and recovery is untouched.
`/book` "Can't find a time?" request (owner 2026-09-29, dark behind
`GATE_BOOK_PREFERRED_TIME`, strict opt-in read at call time via
`bookPreferredTimeLive()`; `GET /api/booking/config` reports it as
`preferred_time`): `POST /api/booking/preferred-time` is guarded by a pre-router
mount in `server/index.js` (above the global cors(), the global `/api/` limiter
and the body parsers): while the gate is off EVERY method answers the generic
unknown-route 404, and every response (404, 400, 429, success) carries
`Cache-Control: no-store`, `X-Robots-Tag: noindex` and `Referrer-Policy:
no-referrer`. Its two limiters key by the /64-collapsed client IP. On: the same IP-bound funnel token
`/availability` mints for capture-intent is required (`400 session_expired`
otherwise), a hidden honeypot field answers success and stores nothing, and
two per-IP limiters apply (5/min, 15/hour). A valid request files ONE internal
lead (`lead_type = 'book_preferred_time'`, status `new`, the preferred days /
time of day / note as plain English in `transcript_summary` and structured in
`extracted_data`) that the office answers by hand and rings one `new_lead`
admin bell (the /book first-touch attribution — click ids, UTMs, referrer — is
resolved through `resolveLeadSource` onto the lead like every other funnel's);
lookup and write run under a per-phone advisory lock, so a repeat or overlapping
submit from the same phone inside 24h refreshes that still-open lead (no second
row or bell). Recency is `extracted_data.last_requested_at`, written only by a
submit — office edits (status, notes, assignment) never extend the dedupe
window or the suppression. Filing a lead also stamps its
`ad_service_attribution` funnel row (`stampLeadFunnelRow`), like every other
public lead. A booking closes a preferred-time request on its own (owner ruling
2026-10-01, replacing the 2026-09-30 note-only rule): a completed self-booking
(`createSelfBooking`, every service type, on both the first commit and the
`txResult.existing` replay; a free re-service callback visit is skipped) moves
each of the booked customer's open preferred-time leads whose
`last_requested_at` is at or before the booking (60 s of clock slack) to the
terminal status `handled`. A lead qualifies only when its phone matches (last
10 digits), its `customer_id` is null or the booked customer, AND its identity
corroborates the booked customer (`corroboratesBookedCustomer`): it is linked
to that customer, or its email matches the customer's non-blank email, or its
first AND last name both match. A phone match alone never closes a request (a
shared household or reassigned number). The booked visit must also carry every
service line the request asked for (`inferServiceLine` per part of a composite
such as `Lawn Care + Pest Control` or `Lawn & Pest`, on both sides); a request
that named no service is answered by any booking, and one asking for a line the
visit does not carry (a lawn + pest request, then a lawn-only booking) stays
open for the office. It must also be for the same property, judged by /book's own address matcher
(`addressMatchesCustomer`: normalized street with suffix variants, unit value,
zip) against the visit's service address (its own stamp, else the customer's);
a customer with two homes on one phone who asks at A and books at B, or at
another unit of the same building, keeps the A request open (a side with no
street does not block the close). The audit row and the FYI name the visit's service and day
as read under the visit lock. A request staff attached an estimate
to (`leads.estimate_id` set) is never closed and never converted by the
booking: it stays open, as before this change, and converts the way any
estimate-linked lead does (the estimate's acceptance,
`markLinkedLeadEstimateAccepted`) or by staff. `handled` means closed, neither
won nor lost, and is set through
`closeBookedPreferredLeads`. It is NOT `markConverted` and settles no funnel stage
(`handled` has no funnel mapping, so the `ad_service_attribution` stage stays
as it is and nothing is uploaded to Google or Meta for the request); the
booking's own attribution runs exactly as for any other booking. Once the
booking has its own funnel row, the closed request's row is removed
(`dropSupersededPreferredFunnelRows`), so the journey counts as one lead; only
by the booking whose close is the request's CURRENT one (a request reopened and
closed again by a later booking is that booking's). First
touch keeps the credit (owner ruling 2026-10-01): when the request's row came
in paid (`is_paid`: a paid click, or paid UTMs whose click id was stripped)
and the booking's own row has no paid click id, the booking's
row first takes the request's touch (source, detail, lead date, click ids,
UTM campaign/term, `is_paid`; the earliest paid request by first-contact
instant wins, and the transfer is recorded on that request's close audit
(`touch_to`) so a close that runs in parts (a replay closing an older request
later) still ends on the earliest contact; when the
booking converted a genuine lead instead of writing its own row, that lead's
booked row is the target, and it keeps its own touch when its first contact
(`leads.first_contact_at`, the instant, not the row's calendar `lead_date`)
came no later than the request's; a booking row with any paid click id of its own keeps it, whatever its `is_paid`; one with paid UTMs but no click id takes the request's touch), so the booking
is credited, and reported, to that ad. Every other lead surface
treats `handled` as closed: it is out of the open set, out of every prospect
denominator (conversion, win and lost rates), and never re-attached by a later
form, call, estimate or email fan-out. The close runs inside the per-(lead,
visit) transaction that takes, in order, the booked customer `FOR SHARE`
(the visit's CURRENT owner, so a merge since the booking is judged on the
winner; re-reading their phone, name and email), the booked visit `FOR UPDATE` (still
live, not cancelled / skipped / rescheduled / no_show, and not a callback; customer before visit, the order a customer merge
uses), and the lead `FOR UPDATE` (still `book_preferred_time`, open, not
converted or deleted, no estimate attached, phone still matching the
customer's current phone, `customer_id` null or the booker's, identity still
corroborated, same service line), then writes ONE `status_change` activity row
("Closed automatically — customer booked <service> for <date> (visit <id>) on
/book"), deduped per (lead, visit) through `lead_activities.metadata`, so a
replay never closes twice; a newer request is new work and stays open. The office
gets ONE admin FYI per close (area Leads, category `lead`, linked to the lead,
deduped per (lead, visit)) and nothing else: no customer message of any kind.
`handled` is system-set only: the Leads PATCH refuses it (unless the lead already has it), and moves a lead off it only when the caller sends `seen_status: 'handled'` together with `seen_updated_at` matching the lead's current `updated_at` (so a request reopened and closed again by a later booking is not overwritten from a view of the earlier close) (the status its page showed; the Leads page sends it with every status change and mark-lost, and a caller that sends none is refused with 409) and the Intelligence Bar tools never offer it; staff can reopen a handled request to any other status. Writers that read a lead open and write later re-assert it at the write, so a close in between wins: attaching an estimate (`attachLeadToEstimate`, 409 when the lead closed since) and the Agent Ops mark-contacted / follow-up / draft actions (409). The lead's `first_contact_channel`
is `booking`, so the shared customer-originated-contact allowlist
(`collections/consent-provenance.js`) counts it as prospect-initiated contact. A
booking that committed while a submit was still in flight (its close ran before
the lead was visible) is reconciled by the submit after its commit: the lead
closes the same way (with the admin FYI) and NO `new_lead` bell rings; with no live booking since the
request began the bell rings as usual. A repeat submit inside 24h merges only that
request's own fields into `extracted_data`; the lead's first-touch UTM /
referrer / landing URL are written once at creation and kept. The service line
`address_line2` (apartment unit) is kept inline with the street line and in
`extracted_data.address_line2`. It sends NOTHING to the customer — no SMS, no email — and
retires every open abandoned-booking intent for the same phone or session, and
capture-intent skips a phone that filed a request in the last day, and the
recovery worker itself re-checks for a request filed since the intent was
captured (fail closed on a lookup error) immediately before every text and
email. The fence with the worker is the `booking_intents` ROW lock, not the
per-phone advisory lock: the submit's suppression UPDATE and the worker's final
check + dispatch (`withLockedRecoveryIntent`, which runs `SELECT ... FOR UPDATE`
on the intent row and holds it through the send) contend on the same row, so
exactly one goes first — the worker never takes the advisory lock, which only
de-duplicates concurrent SUBMITS from one phone. A submit that waited out a
send commits after it; a worker that arrives after the submit's commit reads the
row as suppressed and its re-check sees the request. Neither a failed
suppression write nor a racing capture nor a racing submit can lead to a message
after the visitor's confirmation. Success is a constant
`{"ok": true}`.
Packed offers + expected-minutes travel gap (owner ruling 2026-09-23,
`scheduling/packing-geometry.js` — `loadPackingAnchors`/`packedBounds`, the
one shared anchor set and packed-start formula `scheduling/find-time.js`
(packEnds), `services/availability.js`'s legacy zone engine, and
`routes/booking.js`'s fan-out all read instead of each keeping its own copy —
`scheduling/travel-gap.js`, `scheduling/expected-service-minutes.js`): on a
day that already has a committed stop, every customer-facing surface
(estimate picker, `/book`, public reschedule, public re-service, the
assistant's availability engine) offers only the starts packed against an
existing stop, and the estimate picker's synthetic ASAP windows are dropped
for such days. The travel gap the offer lanes and the commit gates share is
measured from the earlier stop's expected service end (catalog min/max
midpoint, clamped to its window) and the 15-minute buffer is reduced by that
stop's own window padding; rows with no catalog match keep the legacy drive +
buffer gap. This packed-start geometry is independent of the customer grid /
day-end / lunch-gate admission rule above (`customerWindowAdmits`) — a
candidate must clear both: the grid decides whether a start is offered at
all, packing decides how close it may legally sit to a real neighbouring
stop. Ranking ties on `/book` break toward the less hole-making slot
(`idle_minutes`, new per-slot field on the public availability payload).
Self-serve notice window (owner ruling 2026-09-23,
`scheduling/self-serve-notice.js`, `SELF_SERVE_NOTICE_HOURS`, default 24 h):
every SELF-SERVE offer and commit surface — the estimate slot picker and its
reserve/commit/extend gates, `/api/booking/availability`, `/find-slots`,
`/confirm` and capture-intent revalidation, public reschedule, public
re-service, and the assistant's availability engine — neither offers nor
accepts a start within that window of now (the estimate picker's minimum lead
IS this window, replacing the flat 120-minute same-day lead). The old
`max_self_books_per_day` cap is retired: its offer-time day filtering and
commit-time re-checks run only while `GATE_SELF_BOOK_DAY_CAP` is set. Staff,
admin and the voice agent's booking tools are unaffected.
Self-serve arrival grace (owner ruling 2026-09-28, "I'd rather be more
lenient than strict" — the Parrish live miss: a Tuesday 11:00 candidate hid
because the strict travel-gap buffer measured a prior lawn stop's raw window
rather than the whole-route simulation's actual ~6-minute arrival delay),
`scheduling/policy.js`'s `selfServeArrivalGraceMinutes`,
`SELF_SERVE_ARRIVAL_GRACE_MINUTES`, default 0, capped at 120, capacity-mode
only and never for a same-day pick: a self-serve (customer-picked) time
names an ARRIVAL window, not a promised start, so a candidate the strict
travel-gap buffer would reject is still offered — `find-time.js`'s
`packCapacityEnds` — when the day's own route simulation already certifies
the technician arrives within grace minutes of that slot's start (never for
a live estimate hold neighbour, which may evaporate before it is ever
committed, and never on the other side of that gap — the next customer's
promised start is not this one's to spend; Codex r2 P1 on #5314: EVERY live
hold on that tech/date is checked this way, not only the single nearest
committed-or-unassigned anchor `capacityGapNeighbours` picks per side — a
hold's stored window is a promise rather than a fixed slot, so an
earlier-starting hold can still end later than a later-starting committed
stop that the anchor scan chose instead, and grace must never overlook it),
and still accepted at commit — `arrival-route.js`'s `verifyArrivalCapacity`
— only while its certified delay stays within that same grace, tighter than
but never wider than the existing 120-minute arrival promise every capacity
booking already carries.
**ESTIMATE PICKER ONLY** (Codex r1 P1, #5314; `/book` later joined under its own
gate and opt-in — see "Online-booking arrival grace" below — narrowed from an earlier
draft that also covered `/book` and public reschedule): those two surfaces'
commit paths (`createSelfBooking`, the rebooker's single-visit move) each
run a STRICT pre-verify travel probe ahead of their capacity check, so a
grace-kept slot there would already 409 SLOT_TAKEN before `verifyArrivalCapacity`
ever ran it — the estimate picker's own commit (`slot-reservation.js`) has
no such probe under capacity, which is what makes it safe to grant grace
there in the first place. Concretely: `packCapacityEnds` only reads grace
for a caller that explicitly passes `arrivalGrace: true` — `estimate-slot-
availability.js`'s `getAvailableSlots`/`getSlotDebug` are the only two call
sites (guard-tested), even though `/book`'s `buildBookingAvailability`
shares the SAME `packEnds: true` admission and is otherwise byte-identical.
**A hold is certified ONCE, at reserve** (Codex r2 P0 on #5314): grace is
never re-applied at accept. `slot-reservation.js`'s `reserveSlot` is the
ONLY `verifyArrivalCapacity` caller that passes `arrivalGraceMinutes`
(guard-tested — `/book`'s `createSelfBooking`, the rebooker, and this same
file's own `commitReservation` never do), and it reads the EXACT grace that
justified the offer, not a fresh live env read: `arrivalGrace` rides as its
own field in the estimate surface's signed slot offer
(`utils/slot-offer-token.js`), carried in cleartext inside the slotId so
`reserveSlot` can read it back and `verifySlotOffer` still catches any
tamper. **Opt-in PER OFFER, not a blanket format bump** (Codex round 3,
#5314 — the first cut bumped the canonical string and slotId shape for
EVERY offer unconditionally, which broke every in-flight estimate offer at
deploy even with grace dark, violating "default 0 = byte-identical to
before this lane" for the wire format itself): an ungraced offer
(`arrivalGrace` 0 or omitted — every `/book` offer, and every estimate
offer while capacity/grace is off or the date is excluded) signs and
appends the EXACT `<base>.<exp>.<sig>` v2 shape this module always
produced, byte for byte identical to origin/main's minting for the same
inputs — it verifies under both the old and new code, so an offer straddling
this deploy never breaks. Only a genuinely graced offer (`arrivalGrace` > 0)
takes the new `<base>.<exp>.<arrivalGrace>.<sig>` v3 shape, since only it
needs somewhere for the extra field to ride; a graced offer in flight at
the exact deploy instant fails once, the same accepted trade the file's
original v1→v2 bump made for every offer — but that window is now only the
rare graced case. `signCustomerFacingSlots` signs a non-zero grace only for a slot
carrying `routeMode: 'arrival_windows'` (stamped by `classifySlot` from
find-time's own `route_mode`, stripped before the slot ever reaches the
client) — the one marker proving a slot actually passed through
`packCapacityEnds`' grace-aware filter; anything else (today, nothing under
capacity mode — `buildAsapCapacitySlots` self-guards to `[]` — but signing
must not depend on staying correct by accident in a different function)
signs 0, so a future non-route-mode generator's slot can never inherit a
leniency it was never checked against. `commitReservation` keeps only the
pre-existing 120-minute arrival
promise as its bound, byte-identical to before this whole lane — a hold
reserved at grace 90 with an 80-minute delay is accepted regardless of what
`SELF_SERVE_ARRIVAL_GRACE_MINUTES` reads by the time the customer taps
Accept. A grace change between the OFFER and the RESERVE tap is likewise
inert for that specific offer (its signed `arrivalGrace` is fixed at mint
time); only a FRESH availability fetch picks up a changed env value.
Redeeming a graced offer at RESERVE also re-checks the strict travel-gap
buffer against every CURRENT live hold on the same technician's route or
unassigned (excluding the estimate's own hold): a rival estimate may have
taken a nearby hold during the offer's lifetime, and a live hold never
receives the waiver, so any buffer violation refuses the reserve with the
usual 409 SLOT_UNAVAILABLE (`refuseGracedOfferOnRivalHoldConflict`; grace 0
never queries).
`extendReservation` (the 15-minute hold countdown) never re-verifies
whole-route capacity fitness at all under capacity mode — a pre-existing gap
unrelated to grace (a live hold's certified route order is trusted as-is
rather than re-simulating the whole day's route on every extend, which was
judged not cheap enough to add for this lane) — so a hold's grace
certification is fixed at reserve time and is not re-checked if grace or the
route changes before a later extend. Staff, admin, voice and the assistant's
booking tools never opt in and are unaffected. Default 0 is byte-identical
to before this lane. A slotId minted before this v3 bump fails verification
once (the same accepted trade the v1→v2 canonical-string bump already made)
— the client's existing "pick another time" 409 recovery re-signs fresh.
**Online-booking arrival grace (`GATE_BOOK_ARRIVAL_GRACE`, owner-approved
2026-09-29; ships dark).** `/book`'s offers and commit join the same grace,
and the "ESTIMATE PICKER ONLY" carve-out above is lifted for exactly the
surfaces whose commit is `createSelfBooking`: `/api/booking/availability`,
`/find-slots`, the `/capture-intent` revalidation, public re-service and
inspection booking — each passes `bookArrivalGrace: true` to
`buildBookingAvailability`, which takes effect only with mid-route insertion
(`capacityPlacement`, i.e. `bookInsertionOffersLive()`: `GATE_BOOK_CAPACITY_
COMMIT` + `GATE_SCHEDULING_CAPACITY`), the new gate, and a positive
`SELF_SERVE_ARRIVAL_GRACE_MINUTES` for the slot's date (0 on a same-day pick).
The **phone agent** (its commit stays end-of-day only), **public reschedule**
(its rebooker commit still runs the strict pre-verify travel probe), office
Find-a-Time, the Intelligence Bar and auto-dispatch never opt in and are
byte-identical. Gate off (or grace 0) is today's strict drive+15-minute
travel-gap offer and commit, byte for byte, on every surface.

*Why.* Fable's read-only production runs found find-time seeing 8 bookable
Parrish days at cap 30 while `/book` showed 3: every dropped slot failed
`/book`'s own both-neighbour travel-gap mirror, because
`find-time.js`'s `packCapacityEnds` tested each group's earliest pick against
the previous stop ONLY and its latest pick against the next stop ONLY, so a
pick that cleared its own neighbour but crowded the other survived find-time
and was then dropped by the mirror — often emptying 4-7-stop days. The commit
side had the mirror image: `findConflictingVisits`' strict travel probe ran
before `verifyArrivalCapacity` and refused any buffer shortfall, so a
grace-kept offer would have 409'd.

*The one rule* (`services/scheduling/book-arrival-grace.js`, read by find-time's
`packCapacityEnds`, `/book`'s offer mirror in `buildBookingAvailability`, and
`createSelfBooking`'s commit probe — so offer and commit cannot drift):
1. A real window overlap is never waived (the commit's own SQL overlap probe
   and the raw-window check in `travel-gap.js` keep refusing it).
2. Only the travel BUFFER against the PREVIOUS stop may be waived, and only
   when that stop is committed and assigned to THIS technician and the
   whole-route arrival simulation's own delay for this slot is within grace
   (`arrival_delay_minutes` at offer, `verifyArrivalCapacity`'s fit at commit).
   The NEXT stop's side is never waived — the next customer's promised start is
   not this customer's to spend — nor an unassigned or other-technician stop, a
   live hold (every hold on the route must clear the strict gap), or an
   interview.
3. `packCapacityEnds` (`/book` mode) checks every candidate against EVERY
   route neighbour under rule 1-2 BEFORE a group picks its earliest/latest
   endpoint, so a later candidate that clears both sides is never lost to an
   earlier one that crowds the far side. Without the gate the default
   one-neighbour-per-side pick is unchanged (the estimate picker's grace
   still opts in through `arrivalGrace: true` and keeps its own rule).
4. Independently of any gap, a graced build never offers a slot whose
   simulated arrival delay is past the grace, because the commit's
   `verifyArrivalCapacity(…, { arrivalGraceMinutes })` would refuse it:
   `createSelfBooking` now passes the OFFER's grace (the guard test
   `verify-arrival-capacity-grace-callers-guard.test.js` counts it).

*Commit.* `createSelfBooking` tolerates a strict-probe clash only when the
offer was graced, a prepared capacity proof exists, and EVERY clash is a
previous-side `travel_gap` row (a row that starts before the candidate;
`findConflictingVisits` itself is unchanged and stays tech-blind) on the same
assigned committed technician;
everything else stays `SLOT_TAKEN`. The grace it enforces is the exact value
that justified the offer: a signed `/book` offer carries it as an HMAC-bound
field (`slot_sig` = `<exp>.<grace>.<sig>`, only when grace > 0; a zero-grace
offer keeps the exact `<exp>.<sig>` shape), never a live re-read; an internal
callback booking (re-service, inspection — no signed field, offer proof is a
same-request rebuild) reads the live grace for its date.

*Zero grace is the gate off.* Grace mode applies only where the applicable
grace is positive: a build whose range has no positive-grace date (env unset/0)
is plain insertion mode, and per slot a zero-grace date (a same-day pick)
keeps the old one-neighbour packing, the strict mirror, the
`BOOK_INSERTION_OFFER_POLICY` tag and the `<exp>.<sig>` field.

*Flip safety.* Every `/book` offer for a positive-grace date carries
`BOOK_ARRIVAL_GRACE_OFFER_POLICY` (`utils/slot-offer-token.js`) instead of
`BOOK_INSERTION_OFFER_POLICY`, and `/confirm` verifies with
`bookOfferPolicyLive(date)`, so a gate flip in either direction between mint and
confirm fails the signature into the standard "pick your time again" 409
(same mechanism as `GATE_BOOK_CAPACITY_COMMIT`, #5231). Tests:
`book-arrival-grace-parity.test.js` (real whole-route simulation +
find-time + commit probe, both directions, gate on and off),
`booking-availability-arrival-grace.test.js` (offer mirror + signing),
`booking-confirm-signed-offer.test.js` (commit matrix), `slot-offer-token.test.js`.
Catalog-sized estimate offers resolve the primary appointment allowance from
`services.scheduling_duration_policy`; independent recurring companions do not
enlarge that appointment, while one-time paid add-ons contribute shared work.
Combined catalog allowances still require `GATE_VISIT_COMBINED_CAPACITY` and
`GATE_SEPARATE_COMBO_VISITS`. Version-2 combined allowances follow service
identity; version-1 members keep their 60-minute contract. Public offer/cache
responses omit catalog identifiers, route internals and allocation stamps.
Reservation and acceptance re-resolve catalog policies. Transactional catalog
reads under capacity hold a `services` table SHARE lock (taken inside the
lookup savepoint, before any catalog read) until the outer transaction ends
and take no catalog row locks: every catalog insert, update or delete — admin
edits and pre-deploy migrations alike — conflicts with that lock at the
database, so neither a matched row's allowance nor an absent match can be
overtaken by a row edited, activated or mapped after the lookup, and SHARE
readers never block each other. Commit and conversion take that lock before
any `scheduled_services` row lock, matching catalog migrations that lock
`services` first and then update visits. Existing version-2 holds
reject changed allowances with 409 `SLOT_UNAVAILABLE`, even after gate shutdown.
Reservation creation prepares bounded route traffic outside the transaction,
then takes the date occupancy lock and the selected-technician/unassigned day
fences together in canonical order before row locks. It rechecks the signed
offer, live route fingerprint, catalog allowance, eligibility and closure state
before persisting the hold, certified route order and audit. Relevant route rows
remain locked through persistence; a busy completion yields recoverable
`SLOT_UNAVAILABLE`. Unrelated assigned technicians do not invalidate the proof;
a concurrent move to unassigned is fenced. Completed stops retain their prefix.
Capacity offers preserve the enabled south-zone day funnel and omit speculative
ASAP expansion. Public acceptance and one-tap prepare route traffic before opening their write
transaction, then acquire the date, selected-technician and unassigned fences
before their first row lock. Commit verifies the prepared date/technician,
current catalog allowance, live route, eligibility and closures; changed state
returns recoverable `SLOT_UNAVAILABLE` without acceptance writes. One-tap
preparation failures retain its existing pick-a-time recovery. Version-1 holds
keep their legacy path, while version-2 holds retain certification and allowance
checks after gate shutdown. Without combined allocation, excluded recurring
companions and their follow-ups remain unassigned and without a promised window;
they cannot inherit the certified primary trip. Version-2 primary-only holds
preserve that separation even with `GATE_SEPARATE_COMBO_VISITS` off or capacity
shut down. Version-2 parent allowances take precedence during follow-up seeding.
Combined conversion stamps each member before seeding and preserves adjacent
allocation order at the certified anchor, using a nonblocking day fence for
callers already holding rows. A busy reorder aborts allocation for recovery.
Capacity stays off until the other booking/dispatch writers and parent traffic
prerequisites integrate.
Phone-booking primary and follow-up inserts (owner ruling 2026-09-11, option 1)
try the shared day fence — rung 1 date occupancy plus the tech-day or
unassigned-day rung — with a bounded non-blocking wait (`CALL_BOOKING_FENCE_WAIT_MS`,
default 1500 ms) before each insert. A granted fence makes the phone row visible
to a concurrent route certification or lands it after that certification commits.
A missed fence books exactly as before (unfenced, post-commit conflict check
flags overlaps, the card records which insert missed its fence); the booking
never fails, waits past the cap, or blocks on a lock. This stage still does
not authorize enabling capacity.
Existing request fields, token/signature guards, rate limits and privacy headers
apply. With strict opt-in `GATE_VISIT_COMBINED_CAPACITY` and prerequisite
`GATE_SEPARATE_COMBO_VISITS`, version-1 multi-service recurring selections reserve 60 minutes
per physical service program; capacity-enabled selections use version-2 catalog allowances. Termite rental and bond billing riders fold into
bait service; legacy supplements use the converter's physical-program rules.
Unsupported families/cadences, recurring foam and commercial programs return
409 `COMBINED_VISIT_UNAVAILABLE` before offering or holding combined work.

`PUT /api/estimates/:token/accept` answers 409
`{ error, reason: 'retired_lawn_cadence_selection' }` when a recurring lawn
row still resolves to a retired lawn cadence — any tier hidden via
`lawn_pricing_v2.tiers.<tier>.hidden` (6x/bi-monthly since 2026-09-24) or the
removed 4x/quarterly — by explicit cadence, visit count, or the cadence's
catalog key (`lawn_care_recurring` for 6x). The customer picks a current lawn
option or the office requotes; the accept never silently reprices at 9x.

The same accept path answers 409 `{ error, reason:
'retired_tree_shrub_cadence_selection' }` when a recurring tree & shrub row
still resolves to a retired T&S cadence — 4x/Light/quarterly (hidden via
`TREE_SHRUB.tiers.light.hidden` since 2026-09-24, catalog key
`tree_shrub_quarterly`) or the already-retired 12x/Premium — by explicit
cadence, visit count, cadence wording, catalog key, or an explicit tier field
(`tier` / `tierKey` / `serviceTier` / `selectedTier`, any spelling).
9x/Enhanced and 6x/Standard stay current. One existing customer's already-scheduled quarterly program is
grandfathered and untouched by this gate; it only blocks a NEW self-serve
accept from landing on the retired cadence.

Missing-contact capture (owner ruling 2026-09-27). GET
`/api/estimates/:token/data` carries `contactGaps: { firstName, lastName, email }` —
booleans only — while the estimate is accept-active (never on
accepted/declined/expired/off-surface estimates or the PDF render pass).
`lastName` is true when the estimate's `customer_name` has fewer than two
name tokens AND the linked customer (if any) has no real last name (blank or
the `'Customer'` placeholder); `email` is true when neither the estimate nor
the linked customer has an email. The linked customer's name/email are never
returned. The page renders "Last name" (required client-side) and "Email (for
your service reports and receipts)" (optional) above Accept for whichever is
true, and blocks Accept on a typed-but-malformed email.
`firstName` is true only when there is no name at all (blank estimate name and
no linked first name), or the estimate name is exactly the linked profile's
surname while its first name is blank; the page then also asks for "First
name" (required). Name gaps are judged from structure, not by guessing which
stored words are placeholders (owner ruling 2026-09-28): the only exceptions
are the literal `undefined` / `null` tokens of the old concatenation bug and
the `Customer` surname the accept itself used to stamp. Names are normalized
with `normalizeContactName` (proper case) and capped by whole code points.
Without a usable first name the surname is not applied, so the accept never
creates a placeholder first name. The explicitly linked profile
(`estimates.customer_id`) with a blank first name takes the collected first
name through `propagateCustomerNameChange`; phone-matched or sibling profiles
never do.
`PUT /api/estimates/:token/accept` accepts optional `contactFirstName`, `contactLastName`
(trimmed, whitespace-collapsed, ≤50 chars — the customers.last_name width) and `contactEmail` (lowercased,
≤150 chars — the customers.email width — `EMAIL_RE`). A malformed non-empty value answers 400
`{ error, code: 'CONTACT_FIRST_NAME_INVALID' | 'CONTACT_LAST_NAME_INVALID' | 'CONTACT_EMAIL_INVALID' }` before
any mutation; a blank or absent value is never an error (a tab loaded before
this shipped still accepts). Values fill GAPS only and never overwrite: the
gap verdict is recomputed and the estimate row written inside the acceptance
transaction on the locked row, after the eligibility checks, so a rejected
accept changes nothing and a failed check fails the accept (retryable) rather
than dropping the input. Customer resolution (phone match) runs on the
pre-fill identity, so a submitted email never steers which profile the accept
lands on; an authored proposal's `preparedFor` that matched the old name moves
with it (and `proposalDelivery` drops), as in the contact-fanout name sync; the
new customer is created with the supplied values; an EXISTING matched, linked
or grouped-sibling profile is filled only when the estimate's own first name
matches the profile's (an estimate addressed to a tenant under a landlord's
record keeps the values on the estimate only), and then `last_name` only when
blank or `'Customer'` and `email` only when blank (whitespace-only counts as
blank). Each existing-profile fill stamps `customers.updated_at`, and a surname
fill runs `propagateCustomerNameChange` in the same transaction. Only fields the
server's own `contactGaps` verdict flags are ever written — a value for a field
the page never offered is ignored. The customer email fill runs through the
shared email-claim guard (`backfillCustomerEmailInTrx`: row lock, then the
`customer-email:` advisory lock, then the undone-merge holder recheck) in a
savepoint, so a guard failure drops only the email fill, not the accept. An
accept-active estimate with a contact gap always gets the React view: the
`/estimate/` mount skips the legacy renderer and the GrowthBook holdback, and
the `/api/estimates` mount redirects to `/estimate/:token`. No message is sent
because of these fields.

Pay-after-first-visit flag (owner ruling 2026-09-30, `GATE_PAY_AFTER_FIRST_VISIT`,
dark). GET `/api/estimates/:token/data` carries `recurringCardPolicy.payAfterFirstVisit:
true` ONLY when the gate is exactly `'true'`, the recurring card-on-file lane is on,
and the policy the accept would resolve puts this customer on the card rail
(a card is captured at accept, or a consented method is already saved/Auto Pay is
active). It is OMITTED (never `false`) in every other case, so a gate-off response is
byte-identical to before. A plan member whose Auto Pay is already active DOES carry it
(that policy resolves to `autopay_already_active`, an on-rail state: the saved method is
charged after the visit). Plan members NOT on Auto Pay (`existing_plan_customer`),
payer-billed, invoice-mode, commercial manual billing, one-time and paused-Auto-Pay
never carry it. It is a boolean about the viewer's own estimate only: no customer, payer, or
payment-method data rides it. SCOPE: it describes the PAY-PER-APPLICATION option only.
`/data` resolves the policy before the viewer picks a payment option
(`paymentMethodPreference: null`), so it says nothing about annual prepay: a viewer who
later selects annual prepay is resolved again at accept (with `GATE_PREPAY_CARD_AND_CHARGE`
off that is the `prepay_annual` exemption and its pay-link path). A client must not show
the after-first-visit promise on the annual-prepay option on the strength of this field.
Informational only for now: no client reads it, and it moves no money and sends no
message.

Existing customers adding a service (owner ruling 2026-09-30/10-01, PR-B,
`GATE_PAF_EXISTING_CUSTOMERS`, dark). The sentence above that excludes plan members NOT on
Auto Pay (`existing_plan_customer`) and paused-Auto-Pay (`autopay_paused`) holds ONLY while
the sub-gate is off. The sub-gate is live only when BOTH `GATE_PAY_AFTER_FIRST_VISIT` and
`GATE_PAF_EXISTING_CUSTOMERS` are exactly `'true'` and the card lane is on. Then the policy
resolver (`resolveRecurringCardPolicyForEstimate`) no longer returns those two exemptions
for an ELIGIBLE customer: per-application / per-visit / one-time-lane customers and
non-member profiles whose customer row loaded, when they would otherwise have received one of
those two exemptions (a plan member not on Auto Pay, or a paused customer). An existing customer
who never had either exemption (no plan, not paused) was already on the new-customer card rail
before this gate and is unchanged by it (no `afterVisitCard` marker, base consent).
Monthly-membership-lane customers
(`billing_mode` `monthly_membership`, or NULL with a positive `monthly_rate`) and
annual-prepay-lane customers stay on `existing_plan_customer` / `autopay_paused`: their add-on
joins `monthly_rate` (billed by the monthly cron) or is covered by the prepay term. An
eligible customer follows the new-customer card rail: a saved consented card auto-satisfies
(`saved_method_consented`), otherwise `POST /:token/accept` returns `402
RECURRING_CARD_REQUIRED` until a live-verified SetupIntent is supplied. The accept's
first-application invoice is attached to the visit with NO pay link and NO invoice message
at accept, and completion charges it after the visit. Payer-billed (`payer_billed`,
`payer_check_uncertain`), `invoice_mode`, commercial manual billing, one-time and the legacy
prepay carve-out are unchanged, and a customer already on Auto Pay is still
`autopay_already_active`. The policy carries an internal `afterVisitCard: true` marker (and
`autopayPaused: true` for the paused cohort). A paused-Auto-Pay customer (owner R5) keeps a
card on file but the pause is never lifted and nothing is auto-charged: completion skips the
charge (`customerOnAutopay` is false while paused) and the normal pay link goes out in the
completion text after the visit. `GET /api/estimates/:token/data` `recurringCardPolicy` gains
up to four keys, each OMITTED (never `false`) unless it applies, so gate-off responses are
byte-identical: `afterVisitExisting: true` (an existing customer moved onto the rail by this
sub-gate, any lane state), `afterVisitConsent: true` (that customer must capture a card and is
shown the `after_visit_card` v12 authorization, which the accept then records; never set for a
paused or Auto-Pay-off customer), `afterVisitPaused: true` (the paused cohort: the page says the card is
kept and a pay link follows each service; the base consent is recorded, not `after_visit_card`),
and `afterVisitAutopayOff: true` (below).
The estimate-accepted notification for this cohort says nothing is charged today and the saved
payment method (tender-neutral: a bank capture is not "a card") is billed after the first visit (a
pay link follows the visit when Auto Pay is paused or off) instead of "our team will follow up with
the invoice details". A setup-only first invoice (no first-application amount) is still minted
unattached with its pay link at accept, as before. Owner R4 (a monthly-membership member's add-on
must not be billed before its first performed visit) is NOT part of this change.

Annual prepay is never widened: the resolver skips the sub-gate whenever the request's payment
preference is `prepay_annual`, so with `GATE_PREPAY_CARD_AND_CHARGE` on a prepay accept from a plan
member (paused or not) resolves exactly as before (`existing_plan_customer` / `autopay_paused`, never
the in-lane prepay charge-at-accept plan). `/data` resolves with no preference, so it forces
`recurringCardPolicy.prepayInLane` to `false` for the moved cohort (those customers are shown no
in-lane prepay copy or capture).

Explicit Auto Pay opt-out (held cohort). An otherwise-eligible plan member who turned Auto Pay off
on purpose (`customers.autopay_enabled` is not true AND the latest `autopay_log` toggle row, event
type `autopay_enabled` | `autopay_disabled`, is `autopay_disabled` — the same rule
`autopay-setup-link.js` uses) is treated like the paused cohort: the card is kept/captured but
NEVER enrolled (`autopay_enabled` stays false; the accept, the saved-card auto-enroll and the
`setup_intent.succeeded` recovery all skip enrollment, the last via the
`estimate_data.acceptedRecurringCardSkipEnrollment` stamp), nothing is auto-charged, no pay link at
accept, the normal pay link goes out after the visit, and the BASE consent is recorded. The policy
carries `autopayDisabled: true` (independent of the pause: a customer can be both paused and opted
out, e.g. the in-charge card was detached during a pause, and then both markers are kept and the
paused copy wins); `/data` adds `recurringCardPolicy.afterVisitAutopayOff: true`
(omitted otherwise) with neutral copy ("we send you a link to pay after your first visit", no
"paused" claim). A failed opt-out lookup fails closed to today's `existing_plan_customer`.

Commercial manual billing now clears every card-rail shape of this cohort (including the
`saved_method_consented` auto-satisfy shape, which has `required: false`) in both `/data` and the
accept, through one helper, so the two agree: `required: false`, `exemptReason:
'commercial_manual_billing'`, no saved-method auto-enroll, no after-visit markers.

`PUT /:token/accept` request fields (all optional; sent only by a tab whose `/data` carried one of
the after-visit markers above, never for annual prepay, so every other client is unchanged):
- `recurringCardConsentVariant` (`'after_visit_card'` when that text was rendered, else absent),
  `recurringCardConsentVersion` (the version of the text the tab's own bundle RENDERED for the
  captured method: `v12_2026-09-30` for `after_visit_card`, the global card / ACH version for the
  base text) and `recurringCardConsentTender` (`'card'` | `'us_bank_account'`, the tender the
  rendered text was for). The paused / Auto-Pay-off cohorts send the tender and base version too.
- `afterVisitTimingShown: true` when the page showed "billed after your first visit" payment
  timing for the selection (a first-application invoice, not one-time).

The accept decides ONE collection promise inside its transaction from the verified tender and the
real invoice outcome (an UNATTACHED first invoice, e.g. setup-only or an existing customer whose
series already exists, is paid by link at accept and is never the after-visit promise) and
answers:
- `409 { code: 'CONSENT_VARIANT_STALE', collectionPromise: { variant, tender, version, deferred } }` when the
  attested variant / tender / version differs from what it would record (a pre-transaction check
  returns the card best case the same way). Nothing is recorded or committed and the dropped
  SetupIntent is retired. The page drops the captured intent and refetches `/data`; when the
  returned version differs from the one its bundle renders it reloads the page. `deferred` (only on
  the in-transaction refusal) says whether the selection's first invoice is deferred to the visit;
  the page changes the payment timing only on `deferred: false` (a base-consent answer alone, e.g.
  Auto Pay paused since the capture, does not move the timing). The pre-transaction refusal omits it.
- `503 { code: 'RECURRING_CARD_RETIRE_FAILED' }` when an in-transaction refusal dropped a captured
  SetupIntent and Stripe could not confirm retiring it after the rollback: nothing committed, the tab
  keeps its intent and retries.
- `409 { code: 'PAYMENT_TIMING_REFRESH', afterVisitDeferred: false }` when the tab attested the
  after-visit timing but the selection's first invoice goes out payable now (unattached, one-time,
  invoice mode, or the cohort marker gone), and `afterVisitDeferred: true` when an after-visit
  cohort accept WILL defer its attached invoice but the tab attested no timing (a tab from before
  the sub-gate). The page shows the answered timing for that selection and refetches.
- `409 { code: 'ACCEPT_BILLING_CHANGED' }` when the transaction's customer lock finds the moved
  cohort drifted: `billing_mode` moved into an ineligible lane, the pause or opt-out state changed,
  Auto Pay was turned on since the policy was resolved, the saved method a `saved_method_consented`
  policy chose is no longer that customer's consented chargeable card (it is row-locked until
  commit), or the accept landed on another / no customer. Nothing is suppressed, charged or enrolled on the stale decision.

On success the accept persists `estimate_data.acceptedRecurringCardConsent` `{ variant, version,
tender, text }` (the exact authorization recorded as shown) beside the existing
`acceptedRecurringCardConsentVariant` stamp. The inline enrollment and the `setup_intent.succeeded`
recovery record that text and version verbatim (never re-derived from current copy), and the
recovery passes the committed `accepted_at` as the authorization time so an Auto Pay opt-out made
after accepting is honored.
Setup fee billed with the first visit (pay-after-first-visit PR-C,
`GATE_PAF_SETUP_FEE`, dark; needs `GATE_PAY_AFTER_FIRST_VISIT`). Three public payload
additions, each OMITTED (never `false`) unless true, so every gate-off response is
byte-identical to before. (1) GET `/api/estimates/:token/data`
`recurringCardPolicy.setupFeeAfterFirstVisit: true` only when BOTH gates are exactly
`'true'` and the policy the accept would resolve puts this customer on the card rail with a
FRESH capture (`required: true`, not the Auto Pay paused / off cohorts: a customer satisfied by a
saved or enrolled method sees no capture, so never the after-visit text, and keeps today's
payable setup invoice) AND every monthly-billed
tier row in the quoted pricing carries a positive visit count (the accept defers only
onto a priced first visit, and a tier row's per-visit price resolves only with a known
visit count; otherwise the field is omitted and the page keeps today's invoice wording)
AND the resolved customer does not keep monthly membership billing (one shared server
predicate, also used by the legacy page copy and the accept; any lookup failure omits the
field). The React page applies
its "setup fee billed with your first visit" copy and the `after_visit_card` consent text
only when this is true AND its own selection resolves to the setup-only shape (monthly
tier: a WaveGuard setup row, no first-visit amount, no bait-station setup row). A boolean
about the viewer's own estimate: no customer, payer or payment-method data. (2) PUT
`/api/estimates/:token/accept` request body `setupFeeAfterFirstVisitShown: true` ATTESTS the
tab rendered that promise (render-bound, omitted otherwise); the accept recomputes the
promise inside its transaction from the same inputs and, on ANY difference between the
attestation and what it would apply, refuses with `409 { code: 'SETUP_FEE_TERMS_REFRESH' }`
(whole accept rolls back; the page refetches). The deferred fee joins the accept's ONE
collection promise (`resolveCollectionPromise`, see PR-B above): for a card tender the promise is
`after_visit_card`, so the tab attests it with `recurringCardConsentVariant` / `Version` /
`Tender` like the PR-B cohort and any difference is refused `409 CONSENT_VARIANT_STALE`; the
accept persists `estimate_data.acceptedRecurringCardConsent` (exact text) and
`acceptedRecurringCardConsentVariant`, which the `setup_intent.succeeded` recovery records
verbatim. A bank tender records the base ACH consent. Success payload
`setupFeeAfterFirstVisit: true` when this
accept actually STAMPED the setup fee on the first visit's series parent
(`scheduled_services.pending_setup_fee`) instead of minting a payable unattached invoice:
the payload then carries `invoiceId: null`, `invoiceMode: false`, no `invoicePayUrl` and
`nextStep: 'confirmed'`. An accept that is not eligible to defer (not on the card rail, a
bait-station setup or first-application line in the quote, a monthly tier whose visit
count is unknown, or a converted customer whose billing lane is not `per_application`)
keeps today's payload and pay link, omits the field and records the BASE consent. An
accept the page DID promise first-visit billing for (card rail, setup-only shape, known
visit counts, `per_application` lane) whose stamp cannot land (no series parent, no
billable first visit, a different claim already on the series, or a MULTI-PROGRAM accept —
the claim lives on one program's series and could not follow whichever program is performed
first, so a multi-program accept never defers the fee) is REFUSED with
`409 { code: 'SETUP_FEE_TERMS_REFRESH', setupFeePromise: false }` and the whole accept rolls
back, never a payable setup invoice recorded under the after-first-visit consent; the
retry, without the attestation, takes today's payable setup invoice. (3) Durable retry: the accept
persists `estimates.estimate_data.setupFeeDeferredToFirstVisit: true` in the same
transaction as the lane stamp (`recurringCardLaneAccepted`), and a retry of that
already-accepted estimate (`alreadyAccepted: true`) rebuilds the same
`setupFeeAfterFirstVisit: true`, never a pay link. The setup fee is billed on the first
PERFORMED visit's own invoice and charged once to the saved method; a no-show or
cancelled series bills nothing. A fee the first performed visit cannot bill on its own
completion invoice (the visit billed nothing, a grouped closeout handed to the office, a
dues-covered billing lane) is PARKED FOR THE OFFICE, never turned into a free-standing
invoice: the stamp is cleared and one internal `setup_fee_office_billing` dispatch alert
(amount, series, estimate, customer) is the durable owed-fee record the office bills by
hand, once. No draft invoice is created outside the normal completion mint, and nothing is
sent to the customer. The accept notification (customer account feed) says
nothing is charged today and the fee bills with the first visit. No message is sent
because of these fields.

GET `/api/estimates/:token/data` narrows to match (2026-09-24): a saved
estimate's `pricing.frequencies` tree & shrub ladder omits any 4x/Light (and
12x/Premium) entry, so only Standard 6x / Enhanced 9x cards render. What the
response does next depends on what is left:
- **Mixed ladder** (the saved ladder still has a 6x or 9x entry): self-service
  stays on and no quote requirement is added, even when the stored recurring
  T&S row is itself 4x. The customer must pick a current card: the selection
  restamps the row to that tier (cadence, visit count, catalog key and tier
  fields) before accept. A PUT `/accept` that still carries the retired row
  (no current T&S selection) gets the 409 `retired_tree_shrub_cadence_selection`
  above.
- **All-retired ladder** (only Light and/or Premium entries), or no tier ladder
  at all with a stored recurring T&S row at a retired cadence: the response's
  quote requirement is `{ quoteRequired: true, reason:
  'retired_tree_shrub_cadence_requote' }` with the friendly "call Waves to
  refresh your tree & shrub plan" copy, so the page shows the requote state
  instead of an acceptable card.

The same retired-cadence gate applies to staff-side manual acceptance (Mark
Won / phone accept) and to booking from a linked not-yet-accepted estimate
(409 before any appointment is written). Estimates accepted before the
retirement are unaffected.

Termite annual plan sign-before-pay (dark behind `GATE_TERMITE_ANNUAL_PLAN`,
or an annual-plan offer already delivered before the gate turned off): a
`prepay_annual` accept of the Subterranean Termite Protection annual plan
PARKS — the estimate is stamped `annual_plan_activation_status =
'awaiting_signature'` with the accept-time opts and the frozen accepted
price (annual fee net of discount, setup lines, tax, total) and nothing is
billed, booked or charged. The in-lane prepay charge quote never applies to
it (no `402 PREPAY_CHARGE_QUOTE` round-trip, no card capture, no due-today);
a selected slot hold is released, not committed, and an existing
appointment is not adopted — the pick is kept only as a staff scheduling
preference. The success payload carries `invoiceKind:
'annual_prepay_deferred'`, `invoiceId`/`invoicePayUrl` null,
`invoiceAmount`/`prepayInvoiceAmount` = the frozen accepted total (setup
lines and tax included — the figure the signature-time invoice bills, never
a re-derived display amount), `billingTerm: 'prepay_annual'` and `nextStep:
'sign_agreement'`; the success card and accept notifications tell the
customer to sign — signing starts the plan and its billing, and the 12-month
coverage begins on the installation date — never "approved, invoice to
follow". The
already-accepted retry returns the same shape while the agreement is
unsigned, and `invoiceKind: 'annual_prepay_activation_pending'` with
`nextStep: 'activation_pending'` once it is signed but the plan has not
finished activating (the signing link is burned by then). If the customer
never signs, the daily reconcile sweep closes the offer out automatically
`ANNUAL_SIGNATURE_ABANDON_DAYS` (45) days after the park (measured from
`annual_plan_deferred_invoice.parkedAt`, falling back to `accepted_at`):
`estimates.annual_plan_activation_status` becomes `'signature_expired'`,
every unsigned v3 annual agreement for that estimate is cancelled (share
link burned) so it can never be signed into activation, and a single staff
bell rings — nothing is billed or booked either way. A concurrent signature
always wins the race (the estimate row is locked the same way activation
locks it, and a signed contract already on file blocks the close-out). Any
retry of that estimate — the already-accepted rebuild above, or a stray
re-run of `convertEstimate` (webhook replay, an operator re-triggering
acceptance) — reports `invoiceKind: 'annual_prepay_signature_expired'` with
`nextStep: 'offer_closed'`, never `'sign_agreement'`: the signing window is
closed and re-parking the SAME estimate is not offered as a path (re-quote
with a new estimate instead). A signing link that lapses before that 45-day
close rings its own one-time staff nudge (dedup'd per contract and its
current expiry, so a staff resend that later lapses again re-rings once) —
purely informational; it changes nothing about the estimate or agreement.
Signing the
annual agreement at `/api/contracts/:token/sign` activates the plan after
the sign transaction commits (`termite-annual-activation.js`, retried by the
daily reconcile sweep): it bills exactly the frozen price, charges the
customer's enrolled payment method once (capped at the frozen total; owner
ruling 2026-09-25, behind `GATE_PREPAY_CARD_AND_CHARGE`), and sends the pay
link only when there is no enrolled method, charging is off, or the charge
definitively failed. The sign response itself is unchanged.
`durationMinutes` and `windowEnd` describe the whole work block; arrival copy
remains start plus 120 minutes. One assignable technician must have no selected
service capability explicitly disabled. The allocation stamp is server-owned
and excluded from public slot metadata. `/api/estimates/:token/accept` rechecks
the selection, technician and full occupancy under existing locks, then converts
the hold into independent programs: version-1 members use sequential 60-minute
windows, and version-2 members use their catalog allowance at one arrival anchor. Missing or unmatched members abort the transaction. A stamped hold
retains its capacity policy when the creation gate turns off. Shared-arrival
reminder consumers use the persisted allocation, including with grouping off
or Auto Pay enabled; invoice and Auto Pay policies remain unchanged), `/api/reports/:token/*` (the
service-report V1 payload — `/data`, the PDF at `/:token`, `/map.svg`, and
the queued PDF / report-email renders that share `buildReportV1Data` —
renders the report's IDENTITY facts from the completion-time snapshot on
`service_records.service_data.reportIdentitySnapshot` when the record
carries one: `customerName`, `serviceAddress` / `propertyAddress` /
`cityState` and the `mapCenter` those resolved to, `technicianName`, the
`serviceDisplayName` title, and each application's approved product facts
(EPA number, precaution / re-entry / summary copy, approval). The payload
also carries `applicatorFdacsId` (F.S. 482.2265(1)(b) — the applying
technician's FDACS identification card number, `technicians.fl_applicator_license`):
`null` when blank on file, when `technicians.license_expiry` had already
passed as of the service date (a missing expiry is active), or when the
frozen `technicianName` above disagrees with the technician currently
joined (report-identity-snapshot.js withholds the id rather than print it
beside a name it may not match). The project report's GET
`/api/reports/project/:token/data` carries the same field, judged against
the report's own `projectDate` (the WDO last-filing date when one exists),
PLUS `applicatorName` (the resolved technician's name) and `poisonControl`
(boolean). Both `applicatorFdacsId` and `applicatorName` on the project
payload resolve from the technician who actually PERFORMED the linked
service — the project's own `service_record_id` → `scheduled_service_id` →
its `created_by_tech_id` only when genuinely unlinked
(`resolveProjectApplicatorTechnician`, report-data.js) — never simply the
project's creator, which the separate `technicianName` field still reflects
unchanged. `poisonControl` is the canonical typed-application verdict
(`activity-indicators.js`'s `projectPoisonControl`) over the project's raw
`findings` + `followup_findings`, OR'd, plus `rodent_bait_station` visits
(always true — the stations hold rodenticide though servicing one records no
typed application); never true for WDO/certificate/inspection-only project
types. The admin detail endpoint `GET /api/admin/projects/:id` mirrors both
fields on the returned `project` object as `applicator_fdacs_id` /
`applicator_name` / `poison_control` (same shared resolver, judged against
`project_date || created_at`), so the staff customer-report preview can never
show a different applicator or Poison Control verdict than the sent report.
Records
completed before the snapshot shipped carry none and keep the live
customers / scheduled_services / technicians / products_catalog joins; a
snapshot leg that could not be frozen (missing customer or technician row)
is omitted and that leg stays live. The PDF filename and the canonical lawn
pin read the same overlaid row. Presentation (technician photo URL, copy
config) and the deliberately live sections (next visit, review CTA,
cross-sell) are unchanged. `services/service-report/report-identity-snapshot.js`.

"Your upcoming visits" card (owner-approved 2026-09-27): on the same
`/api/reports/:token/*` payload, `GATE_REPORT_UPCOMING_VISITS` (dark, off
unless exactly `true`, read at call time) adds an optional
`upcomingVisitsCard: { visits: [{ serviceType, scheduledDate, windowStart }] }`
— LIVE VIEW ONLY (`opts.mode === 'live'`; absent from the PDF, `/map.svg`,
static, and sms_preview renders, and stripped by the shared
`stripLiveOnlyScheduleFields` the same way `nextAppointment` already is, so a
reschedule after a cached PDF render never fossilizes into the download),
AND only for a caller that opts in with `upcomingVisitsCard: true` (codex
round-5 P2, the same `composeOffers`/`planSummary` shape): `/api/reports/:token/data`
is the only caller that opts in; the `/ask` Q&A build (which still needs
`mode: 'live'` for its own `nextAppointment` context) neither reads nor pays
for the card's paged scheduled_services scan.
Lists every one of the customer's upcoming scheduled visits across ANY
program (pest, lawn, tree & shrub, mosquito, termite, rodent, …), not just
the report's own service line (`nextAppointment` above is unchanged and
stays same-line-first with a cross-line fallback), for the next 90 days,
capped at 6, excluding cancelled/completed/rescheduled rows (same
disclosable-status allow-list as `nextAppointment`: pending/confirmed/
en_route/on_site). Scoped to THIS report's property only, resolved through
the shared `server/services/service-report/visit-property-scope.js`
module (the SAME resolver `cross-sell.js`'s report-identity proof uses —
codex round-4 P1: a parallel per-caller reimplementation of this chain had
missed a case in each of three earlier rounds): the linked visit's own
stamped `service_address_*` is authoritative when present; else its
`scheduled_services.property_id`'s resolved `customer_properties` address;
else its `scheduled_services.source_estimate_id`'s resolved
`estimates.address` — `customer_properties.js` deliberately leaves an
estimate-backed row unanchored (no `property_id`), so this third leg is
the only way such a row resolves to its actual (possibly secondary)
premises; an unlinked/legacy report, or a linked visit carrying NONE of
the three, falls back to the already-COALESCEd customer-mirror address
ONLY once this account is PROVEN to have a single premises, the primary
one (`customerHasOnlyPrimaryPremises`, also moved into
`visit-property-scope.js` — codex round-5 P1: a multi-property account's
own legacy no-evidence row is exactly as likely to be the OTHER property,
and the mirror alone cannot tell the two apart). That proof fails CLOSED
on any unreadable witness — a second premises the account has ever had
(active or since deactivated), a query failure, or (this card's own
strict option, `{ unresolvedFails: true }`, codex round-6 P1) an
UNRESOLVED witness elsewhere on the account: an unstamped
`scheduled_services` row whose `property_id` names no `customer_properties`
row, or whose `source_estimate_id` names no `estimates` row or one with no
address, fails the proof outright rather than being skipped as "not
evidence either way" — it might just as easily BE the second premises this
card would then wrongly disclose. Any of these refuses the mirror
outright, and the one unscoped row is excluded rather than shown.
`cross-sell.js` calls the same proof WITHOUT this strict option (its
unchanged, pre-existing behavior): there, an unresolved witness is treated
as not being evidence of a second premises and the proof continues past it.
Every address key folds in `address_line2` (the unit — a normalized
"Apt 4"/"#4"/"Unit 4" all key identically), so a condo/apartment
building's units never compare equal (a unit on one side and none on the
other is a NON-match, not a fallback match), and a key with neither city
nor zip at all is rejected as unprovable rather than compared. PRIVACY
(P1 2026-09-28, extended round-4 and round-5): a report whose visit IS
property/estimate-linked but whose `property_id` or `source_estimate_id`
cannot be RESOLVED (row deleted, bad link, or the address it names has no
locality) fails CLOSED — the card is omitted entirely, never falling back
to the customer mirror (which would name a DIFFERENT property on a
multi-property account). Only a report carrying NONE of stamp/
`property_id`/`source_estimate_id`, on an account PROVEN single-premises,
may use the mirror fallback. Each candidate row is resolved through the
SAME shared module before being compared to the report's property, so a
multi-property account's report can never list another property's visits.
Gate off (default): the field is absent and the payload is byte-identical
to today.

Four-section report (owner "ok go" 2026-10-01, `GATE_REPORT_WRITER_RULES`,
dark): on the same `/api/reports/:token/*` payload, a report whose summary is
the technician-reviewed four-section report (`summarySource:
'technician_report'`) also carries `reportSections: [{ key, title,
paragraphs[] }]` — keys `whatWeFound` / `whatWeDid` / `whatToExpect` /
`whatsNext` — the server's screened parse of that same text
(`technician-report-copy.js`; the raw notes column never egresses), which the
report page and PDF render with its titles wherever they would print exactly
that text. Live view only, the same payload adds `nextSameServiceAppointment:
{ serviceType, scheduledDate, windowStart }`, the next booked visit on the
report's own service line (same statuses as `nextAppointment`, no cross-line
fallback), for the "What's next" line; `stripLiveOnlyScheduleFields` removes it
from the PDF, static and sms_preview renders like `nextAppointment`. Both keys
are absent for every other report.

Report cross-sell ladder (owner-approved 2026-08-13, `GATE_REPORT_CROSS_SELL`;
`services/service-report/cross-sell.js`'s `buildReportCrossSell`): the
report payload's `crossSell` object offers the ONE next family the
customer doesn't have, walking `OFFER_LADDER` =
`pest_control → lawn_care → tree_shrub` (owner ruling 2026-09-28: report
offers push the three pillars only — termite left the ladder). A customer
owning pest, lawn, AND tree & shrub gets no card at all. The SAME owner
ruling applies to EVERY offer surface, not only the report ("three
pillars is fine for now, yes applies there too"): the portal offer card
and the photo-triage lane (`buildPortalOffer` / `buildPortalPurchaseBasis`
/ `resolvePortalOfferTarget`, and `buildOfferForFamily`) share the
identical `OFFER_LADDER` and `pickOfferTarget` — a customer owning all
three pillars gets no ladder-picked offer on any surface, and the
portal's one-tap termite purchase path is gone with it. `termite`/
`termite_bait` ownership still counts as "has a plan, not the anchor" via
the ownership vocabulary's mapping — it is simply never the offered rung.
An explicit `requestedTargetKey: 'termite'` (e.g. a photo-triage
identification of termite activity) is a DIFFERENT, deliberate code path
— never the ladder's own pick — and is unaffected: `OFFER_PROMPTS`/
`OFFER_LABELS`/`PREFERRED_OPTION_IDS` still carry `termite` so that
request still prices normally. Never offers a family the customer already
owns — the ladder's own property-scoped ownership + plan-rate evidence
decide it (this also covers a typed rodent/termite report's OWN identity —
a `rodent_trapping` visit's own family is already counted owned by the
ladder's existing report-identity corroboration). A recent, uncorroborated
report identity for any family in `GUARDED_OWNERSHIP_FAMILIES`
(`OFFER_LADDER` plus `termite`, kept there for exactly this ambiguity even
though termite left the ladder itself) fails the WHOLE report card closed
— the unseeded-next-visit gap and a just-cancelled plan are
indistinguishable, so offering the family and advancing past it are each
wrong in one of those worlds.

The payload's `protocol.structuredObservations` contains only the saved
completion-form observation snapshot, and a nonempty snapshot carries
`structuredObservationsProvenance: "completion_form_snapshot"`. Live reports
may render those frozen labels even after a catalog rename or deletion.
Merged protocol observations and tagged technician notes never receive that
marker and remain excluded from customer-facing observation lists.
For tree/shrub assessments, a technician-hidden photo metric and its influenced
overall score are `null` in reports and historical trends. Stored review decisions
also mask legacy healthy substitutions on read; original AI scores remain in the
internal audit record. Partial assessments retain their scored categories without
whole-landscape reassurance. Public and queued PDFs share the tree-only `tsreview2`
cache revision so older PDFs cannot retain the substituted scores. Token, access,
privacy, and rate-limit guards are unchanged.
Under `GATE_LAWN_PROPERTY_HISTORY`, lawn trends, initial scores and before/after comparisons use the visit property’s confirmed assessments, one installed result per visit, bounded by the report visit date and applicable baseline-reset window. Mowing and water-gap histories use the same proven visit eligibility. Payload keys stay unchanged; `assessmentDate` and trend dates use visit dates, including the seasonal calculation and water-gap history cutoff. Frozen weather remains keyed to the assessment run date. The PDF signature includes the resolved history identity. The existing opaque `asig` may carry a signed `h1.<history fingerprint>.<HMAC>` envelope: the data route verifies it and refuses a changed history or a disabled gate with the existing generic 409 pin refusal. Legacy signatures remain accepted; token, eligibility, privacy and rate-limit guards remain in force.
Lawn report payload cleanup (lawn report rebuild P6): the `/api/reports/:token/data` lawn `reportV2` no longer carries `snapshot.mainWatch` or the top-level `seasonalNote` (the web hero and PDF never rendered either; `snapshot.seasonalNote`, which the hero renders, and `trends.seasonalNote` are unchanged), and `reportV2.photoSummary` is `null` instead of the stock “No additional observations from the photo review.” placeholder so no empty-evidence sentence prints under the photos or in the PDF. The lawn narrative model no longer writes `mainWatch` or `treatmentSummary`; older frozen payloads and cached narratives that still carry those keys are tolerated (extra keys are ignored). No token, eligibility, privacy or rate-limit change; `LAWN_RENDER_STRATEGY` and `SERVICE_REPORT_PDF_STORAGE_VERSION` bumped so cached renders re-key.
Confirmed assessment property stamps remain eligible after another property is added, subject to ownership and conflicting visit/address checks; unstamped assessment and ancillary histories still require the live sole-property/no-move fallback. Unresolved property scope retains only the report visit’s installed assessment (or its valid signed pin), without prior-property comparisons. An empty same-day baseline reset excludes confirmations preceding the reset from the active window; reports for those earlier confirmations retain their historical window.
The lawn assessment payload also carries `droughtStress` (`none`, `minor`,
`moderate`, `severe`, or `null`) from the linked, tech-confirmed assessment's
stored `composite_scores.drought_stress`. Missing or invalid historical
values yield `null`; raw model responses and the full composite are never
projected. The existing customer/visit linkage and signed assessment pin
requirements apply to this field too. Localized watering advice uses this
structured severity, overridden by an explicit boolean
`scores.stressFlags.drought_stress` from the same confirmed assessment.
The resolved boolean-or-null state travels as `reportV2.water.droughtSignal`
through the final public/PDF reconciliation; only `true` permits a drought
hypothesis to be rewritten into a coverage finding. Localized-drought cards
label an explicit technician finding `tech_confirmed`; automated coverage
advice retains its `area_estimated` label.
Without either signal, observation/summary wording cannot trigger sprinkler
advice or an unqualified "no action needed" reassurance. Measured water
deficits/surpluses and eligible stored water snapshots
retain their existing behavior.
Lawn `reportV2.aftercare` permits a watering-in credit only when
`creditableWaterIn` is exactly `true`, `evidenceSource` is
`product_instruction`, and neither `wateringHold` nor `needsReview` is true.
That same rule governs the live plan, insight actions, report assistant,
narrative overlay, and PDF. A historical non-neutral watering object without
evidence provenance is normalized to review-required: its recorded note remains
visible beside confirmation guidance, while the former inferred “normal watering
within 24 hours” instruction is removed. Historical neutral fallbacks retain
their existing shape and wording.
`GATE_LAWN_WATERING_RULE` (dark; gate off leaves this payload unchanged, key for
key) expands the lawn payload with the visit's one watering instruction, built
from the per-product rules frozen with the visit, the completion time and the
customer's own irrigation entries (withheld after a move). When it resolves to
hold, water-in or hold-then-water-in: `reportV2.banner`
`{ state, lines, holdUntil, waterInBy, expiresAt, ruleSource }` (`state` is
`hold`, `water_in`, `hold_then_water_in` or `none`; `lines` are at most three
finished customer sentences with absolute Eastern clock times; `holdUntil`,
`waterInBy` and `expiresAt` are ISO instants or `null`; an "until the treatment
has dried" hold has no printed duration and `expiresAt: null` (dryness is a
condition, so no instruction that waits for drying, including one followed by a
water-in, ever ends by the clock; the plan-week scope bounds it), and an until-dry-only hold also has
`holdUntil: null`; `expiresAt` is read only by the live banner, which shows an
"ended" note past it; the key is absent when there is no claim).
`reportV2.aftercare` is a record of the visit and never changes by the clock
(owner ruling 2026-09-30): it gains `evidenceSource: 'product_instruction'`,
`wateringHold` (hold states), `creditableWaterIn` (water-in only; a mixed visit
is a hold), `holdTask` (the banner's first line verbatim, or its first two lines
for hold-then-water-in), `waterInTask` (the banner's first line verbatim, for a
water-in that earns no plan credit; it stays the customer's task in the hero,
the follow-up card and the assistant within the visit's plan week), `ruleSource`,
`holdUntil` and `waterInBy`; and
`reportV2.water.weekPlan` / `waterContext.weekPlan` gains `afterHold`
`{ title, detail }`, the week's plan with a "not before" sentence naming the hold's
end time (the `{holdUntil}` placeholder is always filled or the key dropped; it
never reaches the payload). Provenance: `ruleSource` is `label`, `owner` or
`default`, the weakest source among the rules that drive the instruction; state
`none` is asserted only when every applied product resolved to a rule and at
least one is label- or owner-sourced; any applied product with no rule makes
the whole visit no claim (no banner, no product_instruction aftercare, the
existing fail-closed aftercare stays), whatever the other products say. The rule itself
(`wateringRule` / `post_application_watering`) never appears on
`applications[].product` or anywhere else in the public payload. The complete
instruction is frozen at completion under `structured_notes.lawnWateringFreeze`
(first writer wins, atomically) and later reads replay it, so an edit to the customer's
sprinkler entries after the visit never changes the minutes or times an existing
report showed; a record with no frozen instruction regenerates it. Only the treatment-specific sentences are frozen; the one
sentence that depends on the weekly plan ("follow this week's plan", or "that
counts toward this week's watering" for a water-in shallower than the plan's
run) is composed on each render from the plan present on that render.
Label mow hold (P2b, same gate): when an applied product's frozen facts carry a
label-sourced `mowHoldDays` (from `products_catalog.mow_hold_days`, 1..14; no
default, no derivation), the banner gains `mowHold`
`{ days, untilAt, untilDate, untilLabel, line }` for the longest hold: a label
day is 24 elapsed hours, so `untilAt` is the completion instant plus `days` x 24
hours rounded UP to the hour (ISO), `untilDate` its Eastern calendar date
(YYYY-MM-DD), `untilLabel` its Eastern weekday and clock time ("Fri 4 PM";
"Wed, Jan 6 at 12 PM" six or more days out), `line` one finished sentence
("Mowing: hold off until Fri 4 PM, 1 day after today's treatment."). The key is
absent when no product has a value. A visit with a mow hold but no watering
claim gets a banner `{ state: null, lines: [], holdUntil: null, waterInBy: null,
expiresAt: null, ruleSource, mowHold }`; that is the only case `state` is
`null`, and the client then titles the card "Mowing after today's visit".
`mowHold.line` is never in `lines` (so the lawn watering text and the PDF's one
watering line are unchanged), it is frozen with a frozen instruction and
otherwise rebuilt from the frozen product facts (a state-null instruction is
never frozen), it never changes by the clock (the live banner's "ended" note
replaces only the watering lines), and `mowHoldDays` never appears on
`applications[].product`. Facts frozen before the column existed make no mow
claim. The value is part of the lawn render cache signature.
`reportV2.aftercare.watering` carries every treatment sentence. A render whose
watering inputs could not be read (customer preferences or the catalog) omits
the direction and adds the boolean marker `lawnAssessment.wateringInputsUnavailable`;
such a render is served but never cached, and a pinned delivery defers. The gate is
part of the lawn PDF cache signature.
`GATE_LAWN_WATERING_SMS` (dark, strict `true`; also requires
`GATE_LAWN_WATERING_RULE`) adds no public payload field: it sends the frozen
instruction (`state` hold, water_in or hold_then_water_in, never none) as one
separate customer text right after the lawn completion text, rendered from the
`lawn_watering_instruction` SMS template with the instruction's `lines` joined
by single spaces, at most once per visit
(`structured_notes.lawnWateringSmsStatus`).
`GATE_LAWN_REPORT_LEAD` (dark; gate off leaves the lawn payload unchanged, key for
key) adds `reportV2.lead` `{ headline, why, applied, yourPart, next }` to
LAWN reports only (never tree & shrub): `headline` is `snapshot.statusHeadline`
(null falls back to the status label), `why` the root cause or score
explanation, `applied` the treatment summary (never filtered), `yourPart` at most two
homeowner tasks (may be empty; never the stock "No action is needed" line) and
`next` the follow-up reason when a follow-up is planned (never replaced by a
different plan), otherwise the top finding's next-visit plan, else null. It is derived at the tail of
`applyLawnReportReconciliation` from the final reconciled strings, so it carries
the same wording as the rest of the report. When `reportV2.banner` carries
watering lines the banner owns the watering task: `yourPart` is the top
finding's own step (dropped when it restates the aftercare task), and
`headline`, `why`, `yourPart` and `next` carry no watering or
moisture wording (water, irrigation, sprinkler, moisture, dry, drought, damp,
rain, coverage); such a field falls to its next source or null. That wording
test is the whole rule: a non-watering string from a water or coverage finding
(e.g. "Stable — watching thin areas") may lead. The lead region (banner lines, lead fields and the joined next-visit
date) is held to 250 visible words at derive time: a field over its own word cap
(headline 12, why 40, applied 60, each `yourPart` task 30, next 30) is left
out, then `why` and `applied` are nulled in that order
until it fits. The web report mounts the lead card right under the watering
banner (above the plan, nearby and review cards); the lawn section then drops
the snapshot hero and opens with the photo strip; the follow-up card shows
(without its "Your part" line) only when a planned follow-up's reason could
not be carried as `lead.next`. While the gate is on the lawn payload also
drops stock copy (lawn only; every field keeps its key): the unverifiable
past-tense `insights[].wavesAction` lines and four stock `whyItMatters` lines
become null (product-grounded `wavesAction` and every watering
`customerAction` / `nextVisitPlan` are unchanged), and `mowing.recommendation`
is null for a too-short / too-tall reading when the mowing finding is among the
three findings the web card shows. The sprinkler-coverage water finding
carries `kind: 'coverage_watch'` (lead mode only) so the water card knows the
finding owns that guidance even after a narrative headline rewrite. The web report folds secondary finding,
water and photo-note detail into expanders that print open. The lawn PDF, when
`lead` is present, prints `lead.why` as the status detail, finding bullets as
headline + what we saw (+ why it matters only for needs_attention) with no
"What Waves did" line, and skips the follow-up's stock "No action is needed"
line; tree & shrub ignores `lead`. The lawn PDF cache signature carries a lead
stamp while the gate is on, so gate-off PDFs are never served after the flip
(or the reverse on rollback).
`GATE_LAWN_EXPECTATIONS` (dark; gate off leaves the lawn payload unchanged, key
for key) changes the content of the existing `reportV2.snapshot.seasonalNote`
(lawn only, never tree & shrub; no new route, token, privacy or rate-limit
surface): instead of the peak / shoulder / dormant note it is one calendar-based,
tier-neutral sentence for the visit's month and grass (St. Augustine,
Bermuda, Zoysia, Bahia; any other or missing grass takes a generic line) that
says what the program focuses on that time of year, never what the visit
applied. It is written from `server/config/protocols.json` months, and any step
the protocol makes conditional (skipped, soil-test or weather gated, optional,
or on request) is only stated with a qualifier such as "where the
lawn needs it" or "when conditions allow". It is at most about 30 words, and
never naming a product, an ordinance, a county, a blackout, a law, a clock time,
plan tiers, or watering, rain or mowing guidance, and never ordinal or sequence
wording (first, final, again, re-check) since a customer may join mid-year. While the line is in use the snapshot also
carries `seasonalNoteSource: "program"` (the key is absent otherwise). The line
is null, and the old note stays, for a visit that is not a recurring lawn plan
visit (the visit's catalog service identity must be a recurring lawn plan:
one-time lawn jobs, callbacks and unresolved identities get no line; the
WaveGuard tier is never the signal), for a visit with no assessment date, and
for a June to September visit that may have applied nitrogen (the program
applies none then): a catalog `analysis_n` above zero, a fertilizer-type row
with no `analysis_n`, or any applied product the catalog cannot resolve.
The legacy lawn layout still renders `seasonalNote` in the snapshot hero. The
lead layout (`GATE_LAWN_REPORT_LEAD`), which never rendered `seasonalNote`,
renders a program line once as a small "This time of year" card above the
trends, and only when `seasonalNoteSource` is `"program"`. The PDF does not
print `seasonalNote`, so its content and cache signature are unchanged.
`GATE_LAWN_VISIT_MEMORY` (dark; gate off leaves the lawn payload unchanged, key
for key, and makes no read or write) adds an optional `reportV2.sinceLast` to the
`/api/reports/:token/data` lawn payload (lawn only, never tree & shrub; no new
route, token, privacy or rate-limit surface; nothing renders it yet, the web
report and PDF are unchanged and keep their cache signature). It is DATA for the
progress engine and the copy writer: `{ v: 1, priorAssessmentId, priorDate,
applied: [{ name, activeIngredient, kind, tag, targets (at most 3) }], checks:
[{ key, status }] }`, read from the PRIOR visit's frozen treatment memory: what
that visit applied and which of water, weeds, damage, coverage and mowing it said
it would keep watching (at most 3; the customer's own concern is not carried).
No state words ("clear", "still watching") are decided here. The prior visit is
the previous confirmed assessment at the SAME property with a strictly earlier
date (needs `GATE_LAWN_PROPERTY_HISTORY`; a later-dated or same-day row is never
the prior, and a customer who moved gets no prior). The key is absent when there
is no prior or the prior has no frozen memory. Each visit's own entry is frozen
into `service_records.structured_notes.lawnVisitMemory[<assessment id>]` at its
first render (first writer wins per assessment, no migration) together with the
`sinceLast` block it carried, and replayed byte for byte after, so a permanent
token never changes when later visits are added. A render whose entry could not
be frozen is marked uncacheable (`weekWeatherUncacheable`); delivery is not held.
The same gate also builds the lawn progress engine's block
(`server/services/service-report/lawn-progress.js`, P13: a state per prior applied
row and prior check, and an overall direction, from `sinceLast` plus both visits'
scores and this render's photo confidence). It adds NO public key: it rides the
in-process report object as a non-enumerable `reportV2.progress`, so JSON, spread
and `Object.keys` never see it and the `/api/reports/:token/data` payload is what
it was (a test pins that), until P14 writes guarded copy from it and this section
is updated with the key it then exposes. Pure, no read, no write, and a failure
cannot break a render.
A current watering snapshot can originate from
Monday app publication independently of email delivery; `sent_at` remains an
email outcome. Signed `plan` render pins bind to the stable publication time
(or the original email timestamp on older snapshots), with the same policy,
plan-week and service-premise checks. Unpublished drafts remain unavailable.
The optional whole-report AI narrative runs
only when `droughtSignal` is `true`; otherwise all deterministic report copy
is retained before narrative cache/model access. Review-required or restricted
aftercare also keeps the deterministic report before cache/model access. Lawn
PDF render strategy `p7-watering-instruction-20260929` regenerates older cached PDFs
to match these evidence rules),
the legacy SPA `/recap/:token` link (token-shaped and rate-limited; redirects
to `/report/:token#visit-recap`, where the report embeds the approved "Your
Visit, in Motion" recap and consumes `/api/reports/:token/recap` +
`/recap/video`, with the tokenized noindex/no-referrer/no-store headers),
`/api/stripe/webhook`, `/api/webhooks/twilio` (all Twilio inbound;
recruiting replies (classification is NOT gated — `GATE_RECRUITING_COMMS`
is the send / public-link kill switch only; applicants texted before it
was turned off keep classifying from stored evidence for the window; a
database with no recruiting tables at all (42P01) answers "not a
recruiting reply"; any other lookup error fails closed — 503, claim
released, nothing persisted — ONLY for a phone that is plausibly an
applicant (a 60-second snapshot of open applications' phones, or no
snapshot available at all); every other phone continues on the ordinary
path so a recruiting-store hiccup never stalls the inbound pipeline): an inbound
from a phone that
(a) belongs to an OPEN job application (new/reviewed/interview/offer)
AND (b) has a `job_*` SMS `handoff`/`sent`/`uncertain` entry — a queued `deferred`
entry is NOT evidence (nothing reached the applicant) — (the `handoff`
entry is written BEFORE the provider call, stamped with the outbound
`from_number`, and reconciled in place after — DURABLE evidence that
always precedes the text; the post-acceptance sms_log row is never the
basis) in that application's
`comms_history` within 45 days — the reply is tied to the application
that received the text, never phone recency — AND (c) arrived on the
number that text went out from, with NO newer DELIVERED customer-facing
(non-`job_*`, non-internal) outbound text to that phone FROM THAT SAME
Waves line in sms_log after the effective handoff (queue time, replay
attempt time, or finalized send time — whichever is latest)
(that advisory read only ever hands a reply BACK to the customer path; a
missing sms_log row leaves the durable evidence standing) — is classified by
`services/recruiting-inbound.js` BEFORE the unified inbox persist — the
inbox row is born typed `job_applicant_reply` (a classification lookup
failure releases the claim and answers 503 with nothing persisted) — and
then, after STOP/HELP/START handling and before the reaction / customer
paths, recorded on the application (`comms_history` + an `sms_log` row
typed `job_applicant_reply`, one transaction, idempotent on the SID; a
persistence failure also releases + 503s), raised ONLY as the admin-only
`job_applicant_reply` bell, and answered with empty TwiML; it never
reaches the tech-visible `sms_reply` bell, lead intake, the estimator or
any customer automation, even when the phone also belongs to a customer
(owner-only recruiting boundary, `utils/recruiting-thread-scope.js`);
`GATE_SMS_SPAM_CLASSIFIER=shadow` enables a bounded solicitation screen for
unknown-sender SMS; `true` enables enforcement at confidence >= 0.85.
Unset or any other value disables screening.
Known primary/secondary/service-contact numbers, reactions, empty bodies,
standalone carrier commands, and the AI assistant line bypass the classifier.
The unified inbox message is durably saved before screening. Failed unified
saves or relationship lookups bypass screening. Model failures record a failed
non-solicitation verdict. Sender relationship (compliance eligibility) is
resolved once, up front, before any consent handling or screening — a
compliance-eligible sender's consent (keyword or natural-language, on the
full untouched text) is honored before the classifier and never waits on the
model; a non-eligible sender's opt-out-shaped phrasing is not treated as
consent at all and reaches the classifier like any other message (only a
standalone carrier command such as a bare STOP bypasses the model for them
too — natural-language phrasing and a footer never do). Shadow can still
record deterministic pitch evidence via the regex fast path for any
solicitation-shaped text, consent-related or not. The 3.5-second model
budget uses the shared dispatcher.
Verdicts (`solicitation`, `confidence`, `method`, `version`, `mode`, `enforced`)
are stored under `metadata.spam_verdict` on unified messages and ordinary or
natural-language opt-out `sms_log` rows. Read state, opt-out suppression,
TwiML replies, notifications and estimator routing retain their existing
behavior in shadow mode. Enforced pitches remain in both message stores,
are marked read when the verdict is attached, and return empty TwiML before
lead creation, quoting, alerts or
auto-replies. A compliance-eligible sender's genuine consent command
(including a natural-language opt-out or a wrong-number report) bypasses
enforcement — decided before the classifier ever runs — and retains
suppression and its existing responses. A non-eligible sender's opt-out-
shaped phrasing, including a vendor's own reply-instruction footer such as
`Reply NO if you need me to stop texting`, is never treated as the sender's
own opt-out: only the classifier's model verdict governs enforcement for
them, and an enforced verdict never creates a suppression row. The
unanswered digest omits a thread only when its latest eligible inbound has
an enforced verdict, so a later genuine message resurfaces.
Verdict attachment merges metadata without replacing unrelated fields. Failed
verdict attachment bypasses enforcement. Provider request/auth contracts are unchanged. The SMS operational extension
runs after acknowledgment under
`GATE_SMS_OPERATIONAL_ACTIONS` plus an explicit activation timestamp;
it reuses persisted SMS evidence for private profile updates and admin
notifications, with no additional response fields or customer sends;
the photo-text triage (`services/photo-text-triage.js`) likewise runs after
acknowledgment under `GATE_PHOTO_TRIAGE` (default off) for an ordinary
inbound carrying an image: the admin photo assessment (paid vision, one run
per message, capped per ET day by `PHOTO_TRIAGE_DAILY_CAP`, default 20; its
caption classifier by `PHOTO_TRIAGE_CLASSIFIER_DAILY_CAP`) and one pending
owner-approval reply draft, which replaces the legacy AI draft for that
message — never a send, no response change;
unknown domain/van-tracking SMS stays unlinked in the inbox and does not
create customer/account rows or guess a customer name from message prose.
Substantive messages ring a per-message `new_lead` bell/push linking to the
inbox; reactions, empty messages and courtesy-only replies do not;
ordinary inbound SMS is persisted before reschedule or lead-intake consumption,
including replies that return early. STOP/HELP/START handling (opt-out
suppression + the `<Message>` confirmation TwiML) applies only to a sender
Waves has messaged: a matched customer, the AI assistant line, a
provider-accepted outbound `sms_log`/unified `messages` row (excluding
operator alerts — by current phone AND by a durable `to_owner_phone_at_send`
send-time stamp, so a later ADAM_PHONE change can't un-exclude a historical
alert — the AI assistant's own auto-replies, and push-only touchpoints;
unified fallback requires a Twilio message SID and phone identities preserve
country codes), or an active
`messaging_suppression` row; any other sender's text is ordinary inbound
(empty TwiML, no reply, no suppression). The eligibility lookup fails open. Failure to persist that source returns
503 with empty TwiML before either consumer runs; the owned SID claim is
released before that response. Twilio's configured retry/fallback policy
governs redelivery),
Accepted inbound SMS also requires a saved unified inbox message before a
successful acknowledgment or ordinary downstream processing. A missing message
returns 503 and releases only this delivery's owned inbound claim. Eligible
STOP requests still persist suppression, recipient decline, and preference
updates before that error; non-idempotent logs and alerts wait for redelivery.
Those STOP effects and a permanent MessageSid application receipt commit
atomically under the canonical phone lock. A failed consent transaction also
returns 503. A retry of an applied STOP saves the inbox and completes deferred
handling without changing consent again or sending an unsubscribe confirmation;
it cannot undo a newer START. Receipts must remain for the lifetime of retries.
Inbound media uses stable account/message/index storage keys across retries.
Stale contact-correction reservations require a saved unified inbox message
before promotion; failed route cancellation cannot replay an unrecorded source.
Provider retry/fallback remains governed by the configured Twilio policy.
The shared SMS-alert delivery protocol uses a two-minute owned sender lease,
confirmed to four hours only after actual bell/push delivery evidence and a
durable legacy receipt. Committed bells keep immutable message keys so lost
receipts can be repaired without dispatching again; repair preserves original
delivery time. Deliberate suppression is terminal. Push-only retries reuse the
message tag without renotification; provider acceptance followed by a crash
before receipt persistence remains ambiguous and can repeat a provider handoff.

`/api/webhooks/twilio/outbound-amd` +
`/api/webhooks/twilio/outbound-dial-complete` (POST; machine-to-machine
callbacks under the existing Twilio-signature-validated mount. The shared
press-1 `/outbound-connect` bridge adds `<Number machineDetection="Enable">`
with `GATE_OUTBOUND_VOICEMAIL_SMS=true`, excluding technician caller-ID lines.
The `<Dial action>` is also added only for an actual callback attempt: the
persisted bridge row links a callback commitment or was placed under the card
policy (`metadata.callback_policy = card`, stamped on the existing Call Log
callback action too), read whatever the gate says, so ordinary admin bridges
keep the pre-lane shape and a card bridge keeps its evidence after rollback
before staff press 1. Both lanes use this one completion
route. Signed terminal child-leg results with a valid duration and SID record
the first `metadata.customer_leg` on an outbound row matching the call-log UUID,
parent CallSid and a validated callback link (the card's commitment link, or
the existing call-log callback's source-call link). If its parent SID backfill
failed, the signed completion atomically adopts the missing SID on that
server-linked outbound row. An existing different SID cannot be replaced.
Retries cannot replace that
evidence; a failed write returns 503 for provider retry. In-flight results
remain accepted after gate rollback. This records evidence without closing a
commitment; fulfillment requires a valid non-voicemail extraction as well. Query context is `callLogId`, `customerNumber`,
and `callerIdNumber`, generated by the bridge and covered by the signature.
AMD accepts the child `CallSid`, `AnsweredBy`, and `MachineDetectionDuration`.
It records the verdict and responds 200; only a `machine_*` verdict can
send a voicemail follow-up text. The send fails closed on the gate, quiet
hours (8am–8pm ET), staff/owned recipient numbers, technician caller-ID
lines, a current/recent visit, non-service inbound callers, and a per-phone
24-hour `sms_send_claims` claim; template, consent and suppression checks
also apply through the existing SMS pipeline. The dialed customer number
comes from the signed query, never the bridge row's admin `to_phone`.
Only a real provider send stamps success and permits a REST hangup of the
child leg. A blocked or failed send leaves the call connected. Dial-complete
announces that a text was sent only when the success stamp exists, then
hangs up; otherwise it silently hangs up. Gate off leaves the originating
TwiML unchanged and prevents text/hangup actions on an in-flight AMD callback),
`/api/webhooks/twilio/collections-vestibule[-key|-noinput]` +
`/api/webhooks/twilio/collections-relay-complete` +
`/api/webhooks/twilio/collections-transfer-complete` +
`/api/webhooks/twilio/collections-call-status` (POST; machine-to-machine
TwiML webhooks for the OUTBOUND collections voice lane — Twilio-signature
validated at the mount like every Twilio inbound route, and additionally
fail-closed to a bare `<Hangup/>` unless `GATE_VOICE_LATE_PAYMENT` is exactly
'true' AND the `callLogId` query param resolves to a call_log row this lane
itself originated (direction 'outbound', source 'collections_voice', a linked
collection case) whose CallSid matches the request. The vestibule is a FIXED
DTMF consent stage: deterministic script, `<Gather input="dtmf">` only, no
ConversationRelay/recording before press-1 — no call audio ever reaches
Waves systems pre-consent — and metadata-only logging before consent. The
ONE documented exception: Twilio's carrier-side AMD classification
(`machineDetection: DetectMessageEnd`) runs before the vestibule and
returns only a label (human/machine), never audio — a deliberate,
counsel-review-before-flip item (DECISIONS-PRB #13), required so machine
answers route to the capped generic-callback voicemail instead of playing
the consent script to an answering machine. Press-1 renders `<Connect><ConversationRelay>` to the
existing `/ws/voice-agent` endpoint with a per-call minted token and a
`session_mode=collections` Parameter — which the ws server treats as an
UNVERIFIED hint and re-proves against the same call_log row before any
account data exists in the session. Treat the gate, the call_log linkage
check, and the no-audio-before-consent contract as security-critical.
Dials originate from exactly two surfaces (PR C), both funneling through
`originateCollectionCall` — the single authorization boundary that
re-runs the full contact policy at dial time: the admin-only
`POST /api/admin/communications/collections-cases/:id/dial` (supervised
single dial, requireAdmin, master-gated) and the auto-dial cron sweep
behind `GATE_VOICE_LATE_PAYMENT_AUTODIAL` (which requires the master AND
`GATE_COLLECTIONS_POLICY` gates; autodial gate off = zero reads from the
SWEEP, pinned — the scheduler tick then runs only the master-gated
expired-approval reclamation, and a fully dark master = zero touches;
bounded
by `COLLECTIONS_AUTODIAL_MAX_PER_RUN`, default 2, hard ceiling 10). A
diff adding any OTHER path to `originateCollectionCall`, weakening the
guarded promote fences (state + case_version), or letting the sweep make
its own eligibility judgments is a P0),
`/api/bouncie` + `/api/webhooks/bouncie`, `/api/webhooks/sendgrid`,
`/api/webhooks/resend` (Svix-signed), `/api/webhooks/lead`
(+ `POST /api/leads`, an alias accepting the same pair with identical
semantics; both also accept an OPTIONAL `timeline` — the visitor's own
"when do you want this handled?" answer, `now` | `this_week` |
`this_month` | `browsing` plus the form aliases in
`server/services/lead-timeline.js`; stored verbatim in
`extracted_data.timeline`, mapped onto `leads.urgency`, and it WINS over
the AI triage's urgency guess; unknown values are ignored, never guessed;
and both accept an OPTIONAL `sign_host` — the Astro `/neighbor/` page's
"Which home had the sign?" answer, read from that exact key only,
normalized to printable text with whitespace collapsed and capped at 120
characters, stored in `extracted_data.sign_host` (kept through the AI
triage's extracted_data replace) and as a "Saw our yard sign at: …" line on
the new-lead / existing-customer Customer 360 note so the office can give
the sign host the $25 thank-you credit. STAFF-ONLY: it never joins
`message`, the AI triage prose or the Lead Response Agent's message, and
the agent's `get_lead_details` tool strips it; a missing, blank or
non-string value is a no-op; and both accept an OPTIONAL `heard_about` —
the quote form's self-reported "How did you hear about us?" answer,
validated against a FIXED allowlist (`server/routes/lead-webhook.js`
`sanitizeHeardAbout`): `google_search`, `google_maps`, `chatgpt`,
`other_ai`, `facebook_instagram`, `nextdoor`, `yelp`, `friend_neighbor`,
`truck_yard_sign`, `other`. Any other value — including free text — is
SILENTLY DROPPED (never stored; the request still succeeds as if the field
were absent). A valid value is stored verbatim in `leads.heard_about`
(nullable column, migration `20260928020000_leads_heard_about.js`) and
surfaced on the admin lead detail. Both endpoints also accept an OPTIONAL
`heard_about_prompt` — the quote form's "What did you ask it?" follow-up,
shown only when the visitor picked `chatgpt` or `other_ai`. It is read from
that exact key, must be a string, and is kept ONLY when `heard_about`
resolves to `chatgpt` or `other_ai`; control characters and whitespace runs
collapse to single spaces, the result is trimmed and capped at 500
characters (`sanitizeHeardAboutPrompt`), and a non-string, blank, or
non-AI-`heard_about` value is SILENTLY DROPPED (request still succeeds).
Stored as typed — no redaction — in `leads.heard_about_prompt` (nullable
varchar(500), migration `20260930220000_leads_heard_about_prompt.js`) and
shown on the admin lead card as `Asked: "…"`; STAFF-ONLY, it never joins
`message`, the AI triage prose or any customer-facing text. Safe in either
deploy order: a portal without this change ignores the unknown key, and an
Astro form without it simply omits the key. `heard_about` itself is
DELIBERATELY SEPARATE from
`leads.lead_source_id` / the classified `lead_source` — self-reported, never
merged into technically-observed attribution, and "unknown" (the field
omitted or invalid) stores NULL rather than a guess. Separately and
independently of `heard_about`, the SAME technically-observed attribution
pipeline both endpoints already run (UTM/click-id/referrer →
`server/services/lead-source-classify.js`) now also classifies an
AI-assistant referral: a visitor who asked ChatGPT, Perplexity, Gemini,
Copilot, Claude, or another AI answer engine and followed its citation
link — matched by EITHER `utm_source` (`chatgpt.com` / `chatgpt` / `openai`
for ChatGPT, and the analogous values per assistant) OR the raw
`document.referrer` host (`chatgpt.com`, `chat.openai.com`,
`perplexity.ai`, `gemini.google.com`, `bard.google.com`,
`copilot.microsoft.com`, `claude.ai`, `you.com`, …; the shared table is
`server/services/ai-referral-sources.js`) — checked after every paid/GBP/
Meta UTM or click-id branch (those still win) and before the domain/hub
fallback. A match resolves `lead_source = 'ai_assistant'`
(`server/services/source-names.js` label: "AI Assistant") and, via the
seeded `lead_sources` row (migration
`20260928030000_ai_assistant_lead_source.js`), a real `lead_source_id`.
The identical detection table is shared with `resolveLeadSource`
(`server/services/lead-source-resolver.js`), the classifier
`/api/public/estimator/property-lookup` and `/api/public/quote/calculate`
use — see those entries below — so an AI-referred visitor is classified
the same way regardless of which endpoint their lead lands on),
`/api/public/newsletter/*` (subscribe, confirm, unsubscribe, posts,
posts/by-slug/:slug, rss, quiz/:token/:quizId/:answer,
feedback/:token/:reaction, e/:token/:eventId (event click-through:
records one deduped analytics row then 302s to the DB-locked event
URL; unknown token = untracked redirect, never blocks the reader)
— rate-limited, read-only for posts/rss,
double-opt-in for subscribe (the response is unchanged and uniform; `source` is free text,
and ONLY `source: "out_of_area_waitlist"` also reads the optional body `zip` / `city`
strings (newer sites; they win) and the optional `tags` array (older sites send only
`["out_of_area_waitlist", "zip:NNNNN", "city:slug"]`), keeping at most one `zip:` tag that is exactly 5 digits and one `city:` tag normalized to a
lowercase hyphen slug capped at 40 chars, plus the fixed `out_of_area_waitlist` tag; every
other posted tag is dropped, and every other source ignores `tags`/`zip`/`city` entirely. The write goes
to the existing `newsletter_subscribers.tags` jsonb, replaces that row's earlier `zip:`/`city:`
tags, and only touches the signup's own `pending` row (a new or re-armed double-opt-in), so an
anonymous post cannot retag an already-confirmed subscriber. It is best-effort: a failure
never fails the signup, and the zip/city values are never logged); the quiz and feedback tokens are the same
per-recipient uuid `engagement_token` (newsletter_send_deliveries) — GET
renders a confirm page only and the delivery-row write happens on a
deliberate POST form submission (scanner-safe, mirrors confirm), answer/
reaction keys validated against the server-side config allowlists
(newsletter-quiz.js / newsletter-feedback.js), 30 req/min per IP, always
returns 200 so it can't probe which tokens/answers are real),
`/api/public/prep/:token` (32-hex token format gate,
60 req/min rate limit, privacy headers `no-store`/`noindex`/`no-referrer`,
filters email-only blocks, server-side interpolation, generic 404; the
ONLY writes are its own view analytics, all after a successful render —
for a scheduled-service token the visit's `prep_view_count` /
`prep_first_viewed_at` stamp is fenced on the rendered template key (a
miss = the key moved, so the page re-resolves and renders the new guide),
which pairs with the manual prep sender's re-key / release fence on those
view columns so an opened page never changes guide or 404s behind the
customer; the `prep_guide_views` log row follows. Response blocks (#4790):
in addition to `paragraph` / `heading` / `details` / `callout`, the
anonymous payload may carry `{ type: 'list', items: string[] }` check-list
blocks, and prose in paragraph / callout `content`, list `items[]` and
details `label` / `value` (NOT heading content, which both surfaces print
verbatim) may contain author-written inline markdown links
`[label](https://…)` that the page and PDF render with an
http/https/mailto/tel allowlist. Server-side interpolation now also
substitutes `items[]` and details `label`, and breaks any `](` inside a
substituted VALUE (`neutralizeLinkSyntax`) so a customer-influenced field
can never complete link syntax — only template-authored markdown becomes
an anchor),
`/api/public/prep/:token/pdf` (downloadable PDF twin of the prep page —
action-bar Download parity with service reports; same 32-hex token format
gate, same 60 req/min limiter, same privacy headers, generic 404; payload
is the SAME interpolated guide blocks plus customer name + service
address + technician first name/name — never email or phone (owner PII
ruling 2026-07-13); filename sanitized server-side before
Content-Disposition; no view-analytics writes on this route),
`/api/public/price-change/:token` (price-change notice page data;
32-hex token format gate, 60 req/min rate limit, privacy headers
`no-store`/`noindex`/`no-referrer`, generic 404; payload is first name +
the price change only — no address/email/PII; view counted for the
delivery record),
`/api/public/products` (read-only export; returns only active +
customer_visibility=public + content_status=approved_for_public products;
excludes pricing, vendor, SKU, dilution, MOA, inventory fields),
`/api/service-outlines/:token` (approved/sent/viewed packets only,
43-char base64url token format gate, 60 req/min read limit, 120 req/min
CTA telemetry limit, privacy headers `no-store`/`noindex`/`no-referrer`,
generic 404 for missing, draft, revoked, or malformed tokens),
`/api/public/estimates/:token/deposit-intent` (RETIRED VERDICT STUB —
owner ruling 2026-08-10: acceptance deposits are permanently
not-enforced. Token format gate + deposit rate limit, then an
unconditional 409 `{ exemptReason: 'deposits_retired' }` — the accept
client consults this after a non-superseding card/hold 409 and reads a
409-with-exemptReason as "nothing owed"; no PaymentIntent, no Stripe
call, no DB write. `/deposit-quote`, `/deposit-finalize`, and
`/deposit-reset` carry the SAME verdict stub — a 409 with exemptReason
is exactly what their kill-switch check returned while the flag was
off, so the retirement preserves the live contract for any stale open
page. The
deposit LEDGER — credit roll-forward, void-restore, refunds, webhook
recording — stays for the 2026-06/07 historical rows; the 2026-07-13
surcharge ruling and 2026-07-05 commercial-prepay exemption remain the
ledger's interpretation rules for those rows.)
`/api/public/estimates/:token/card-hold-intent` (one-time card-on-file
hold; estimate token format gate, generic 404, 10 req/min limit,
terminal/expired rejection, mirrors the accept-time quote + one-time
availability gates, 409 for exempt policies, customerless SetupIntent
with metadata-pinned purpose/estimate id, NO money captured at booking —
the saved card is charged on completion and a flat no-show fee only;
dark behind ONE_TIME_CARD_HOLD).
`/api/public/estimates/:token/recurring-card-intent` (recurring-accept
Auto Pay card per docs/card-on-file-booking-build-spec.md — card to book,
deposit retired, charge on completion only; estimate token format gate,
generic 404, 10 req/min limit, terminal/expired rejection, mirrors the
accept-time quote gate, 409 for exempt policies — one-time / invoice-mode
/ prepay-annual / existing plan member / payer-billed / already-on-Auto-
Pay / saved consented card (auto-satisfy: existing customers are never
re-asked) — customerless SetupIntent with metadata-pinned purpose
`estimate_recurring_card`, NO money captured at booking; accept-time
enrollment (consent row + enrollConsentedMethod) turns on Auto Pay so
completed applications auto-charge, capped at the accepted per-visit
amount (above-quote invoices route to office review instead of
auto-charging); dark behind RECURRING_CARD_ON_FILE, and
ESTIMATE_DEPOSIT_REQUIRED is unset only AFTER this lights.
Response carries `paymentMethodTypes` (`['card']`, or
`['card','us_bank_account']` behind GATE_ACCEPT_ACH_CAPTURE — bank with
INSTANT verification only, never micro-deposits; card-only for an existing
customer whose `customers.ach_status` is set and not `active`, and on any
ach_status lookup failure). The accept-time verify re-resolves the same
tender policy and refuses a captured bank method (402
RECURRING_CARD_REQUIRED → the client re-mints card-only) once the gate is
off or the customer's ACH state is unhealthy, so a previously minted
bank-capable intent cannot outlive the kill switch. Optional body
`replaceSetupIntentId` ("use a different payment method" after a capture
already succeeded): the named intent must be THIS estimate's own
`estimate_recurring_card` capture (foreign or unknown id → 400; a Stripe
read failure → 503). The replacement is minted
FIRST (idempotency key salted by the retired id — unbounded, no
generation consumed), then the succeeded intent is stamped
`metadata.retired='true'` + `replaced_by=<new id>` in Stripe; a mint
failure leaves the saved method untouched (503). From then on the
accept-time verify refuses the retired id (402 RECURRING_CARD_REQUIRED)
and the deterministic mint follows `replaced_by` to the live capture, so
a refresh lands on the replacement. Replacement and acceptance serialize
on the estimate ROW LOCK: the replacement runs in a transaction that
locks the row (`FOR UPDATE`, read-only — no `updated_at` move, so the
accept's freshness CAS is untouched) and the accept re-reads its verified
intent live under the same lock before committing, so a retirement that
landed after the pre-transaction verify aborts the accept (402 → re-mint)
and a replacement that finds the estimate already accepted retires
nothing (409 "Estimate already accepted") — every replacement outcome
takes that lock, including a stale retry with an already-retired or
unfinished intent, and the locked read re-judges the full accept-active
gate (declined / expired / archived / off-surface → 409 "Estimate is no
longer active"), so no fresh capture is minted (and no checkout step
recorded) for an estimate that turned terminal after the route's read.
The `setup_intent.succeeded` webhook backstop re-reads an UNSTAMPED
(legacy / flag-off) capture live from Stripe before enrolling and never
enrolls a retired one. A chain head is judged by what it captured, like the accept
gate: a saved card stays valid after GATE_ACCEPT_ACH_CAPTURE closes, a
captured bank under a card-only policy is skipped like a dead replay
(unfinished heads must match the tender family exactly) so the
generation walk mints a compatible card-only intent. Every minted/replayed intent is
re-read live before it is judged (an idempotent replay returns the
original create body). A succeeded replay's response carries
`capturedMethodType`, and the capture UIs render it as a saved-method
panel with a continue/replace choice instead of a Payment Element. The
one-time card-hold-intent route above stays card-only regardless).
`/api/estimates/:token/service-details/:serviceKey/pdf` (read-only
per-service details-packet PDF for the estimate view's "full details"
buttons; live by default, kill switch GATE_SERVICE_DETAILS_PDF=false —
404 when off; estimate
token format gate, generic 404, isEstimateCustomerViewable gate identical
to `/:token/data` (drafts/expired/send_failed 404 — even for staff, so a
draft can never produce a customer-facing document), serviceKey must be
BOTH a known guide key and a recurring service actually on this estimate —
one exception: `lawn_care` is also served when the estimate's only lawn work
is a one-time lawn row (`one_time_lawn`, `plugging`, `dethatching`,
`top_dressing`), read from the same replayed pricing bundle `/data` sends
(`pricingBundle.oneTimeBreakdown`, stored breakdown as fallback; malformed
data fails closed), and that estimate gets the ONE-TIME variant of the guide
(no visit count, re-service, or recurring-program content). An estimate with
BOTH a recurring lawn line and a one-time lawn row serves the recurring guide
unless the request carries the one-time card's hint (`?scope=one_time` on the
GET, `scope: 'one_time'` in the send body; the texted link keeps it) — the
hint only picks the variant when a one-time lawn row is present and never
widens membership; no other guide
widens for one-time rows, and the Bermuda-removal sections render only when
the estimate carries the bermudaSuppression add-on with
GATE_BERMUDA_SUPPRESSION on. The same membership rule gates
`POST /api/estimates/:token/service-details/send`;
60 req/min limit, `no-store`/`no-referrer` headers; the PDF contains the
service guide plus PUBLIC product-registry fields only — active
ingredient, EPA reg no., label/SDS links — never pricing, vendor, SKU,
dilution, or inventory data).
`/api/estimates/:token/warranty-comparison/pdf` (read-only termite
buy-vs-rent options sheet; dark behind GATE_TERMITE_COMPARISON_SHEET —
404 when off; same token format gate + generic 404 +
isEstimateCustomerViewable contract as the service-details PDF above;
content is two deterministic pricing-engine replays of the estimate's own
saved inputs (ownership toggled) plus the bond-term snapshot — the
builder is fail-closed, so a config where the rental cannot actually
price 404s instead of rendering a one-column comparison; 60 req/min
limit, `no-store`/`no-referrer` headers; no product-registry, vendor, or
cost data — customer-priced figures only).
`/api/estimates/:token/map/satellite` and `/api/estimates/:token/map/overlay`
(read-only token-scoped satellite image proxy, B12; the ONLY way a customer
surface gets a map image — /data, the SSR page, the PDF render pass and the
show-your-work payload carry these paths and never a maps.googleapis.com URL,
because that URL carried the server's Google Maps key, the same key Geocoding
and Routes use, which cannot be referrer-restricted; `/data` and the SSR HTML
also run a last-line scrub that strips any maps.googleapis.com `key=` (raw or
HTML/JSON-escaped separators: `&amp;`, `&#38;`, `&#x26;`, `\u0026`), any
`key=AIza...` token or bare Google-key shape (so a rotated or staff-pasted key
that differs from the configured one is caught too) and blanks the literal key
— the SSR path scrubs its SOURCE values before renderPage escapes them, then
scrubs the finished HTML as a backstop, and stored `estimates.satellite_url` rows that already
hold a keyed URL are redacted on output — no migration). A small guard (`mapImagePreGuard`) is mounted in
`server/index.js` on `/api/estimates` BEFORE the global `/api/` limiter,
scoped to exactly what Express routes to these two handlers (GET and HEAD,
case-insensitive path, optional trailing slash): it stamps `Cache-Control: no-store`,
`Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy:
cross-origin` first — so the router.param malformed-token 404 and the global
and route limiters' 429s inherit them, and a successful image overwrites
Cache-Control — and answers the dark overlay's generic 404 there, before the
global limiter can turn it into a 429. Token format gate
(router.param) + ONE generic 404 body (`Estimate not found`, `no-store`) for
every refusal — malformed/unknown token, callSideBlock, a row that is not
`isEstimateCustomerViewable` (drafts, expired, archived, send_failed 404; the
group-link view bypass matches `/:token/data`; there is NO staff-preview or
signed-pdf-pin bypass because an <img> carries neither), no usable stored map,
and upstream failure — so the route is not an existence oracle. The route
reads NOTHING from the caller's query string: `/map/satellite` rebuilds a
keyless Static Maps URL from the estimate's OWN stored `satellite_url`
(`estimate_data.satelliteUrl` fallback), keeping only allow-listed,
range-checked params (center, zoom 1-22, size <=640x640, maptype
satellite|hybrid, format, scale 1|2; markers/path/signature dropped) and
refusing any non-`https://maps.googleapis.com/maps/api/staticmap` value, so it
cannot become an open proxy or an SSRF vector; `/map/overlay` rebuilds the
parcel-outline URL from the cached property_lookups row (dark while
`estimateShowYourWork` is off: the gate check runs BEFORE the limiter and any
DB work, so a dark route answers the generic 404, never 429). The server key
is appended only inside the fetch (8 s timeout, image/* content-type and 4 MB
cap enforced, nothing logged but a URL-free warn); a bounded in-memory cache
(64 entries, 10 min) keeps one token from fanning out into unlimited Google
fetches, and a 30 req/min per-IP limiter fronts it. Success streams the bytes
with `Cache-Control: private, max-age=3600`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, and `Cross-Origin-Resource-Policy:
cross-origin` (helmet defaults to same-origin, which would block the <img>
when the SPA is built against a separate API origin via VITE_API_URL).
Admin-only surfaces keep their direct URLs).
`/api/estimates/:token/service-details/send` (write; emails or texts that
same packet to the contact info ALREADY ON the estimate — the destination
is NEVER caller-supplied (body carries only `service` + `channel`, plus
the optional one-time lawn hint `scope: 'one_time'`, which only picks the
lawn guide's one-time variant as described on the GET above), so
the token cannot be used to spray documents at arbitrary addresses; same
gate-404 + token format gate + customer-viewable + service-on-estimate
checks as the GET, 6 req/hour limit, email sends idempotent per
estimate+service+day (the lawn guide's one-time variant is its own packet:
its idempotency key and SMS dedup claim carry a `:one_time` suffix and its
texted link keeps `?scope=one_time`; every other guide keeps one key), suppression-blocked addresses return 409 with no
send, generic errors — no PII in responses or logs; while
GATE_SEND_REQUIRES_SERVER_PRICING is on, a row or group link that fails
the engine-pricing-authority verdict (#3750) answers the same generic 404
before either provider path — and, with the gate on or off, so does a row
whose stored estimate-tool price the 2026-09-26 lookup guards refuse
(legacy autofill hold, #4941: `rowHeldForLegacyAutofillPrice`; gate off it
judges the row alone, read-free — its group siblings are judged only while
the gate is on); both provider paths re-read the row and repeat
the customer-viewable + call-side-hold check as the LAST step before the
SendGrid/Twilio handoff, so a clarify hold or archive that lands during the
PDF render withholds the packet with the same generic 404 and releases the
SMS dedup claim so a later legitimate retap can send; every success or
deduplicated response on either channel rechecks the annual guard
(server/services/estimate-annual-guard.js) through one shared helper
(withheldOr) before answering — the fresh-dispatch success, the in-process
and cross-restart SMS dedup hits, the cross-process claim-loser's dedup
hit, and the email per-day idempotency dedup all funnel through it, so a
changed or never-delivered annual offer can never surface through a
shortcut that skips the check — mapping a blocked verdict to the same
generic 404, with the SMS dedup claim stamped/released exactly like the
customer-viewable/call-side-hold case; the only request-shape addition
is the optional `scope` hint above).
`/api/estimates/:token/bond` (PUT; customer bond-term switcher on the
estimate page — same contract family as the service-preferences toggles.
Token IS the auth: slug-or-64-hex format gate rejects malformed probes
before any DB read, and the 404 is generic — unknown token, malformed
token, and non-active rows (draft/archived/expired/locked) are
indistinguishable, so a leaked inactive token never confirms a row
exists. Dark behind GATE_TERMITE_BOND_OPTION (off → uniform 403
`bond_option_disabled` before any DB read, and the 30/hr per-IP limiter
— shared /64-collapsing `rateLimitKey` — `skip`s while dark so probes
never see a revealing 429). Mutates ONLY the termite-bond selection:
the requested term must exist in the estimate's own QUOTE-TIME
`bondOptions` snapshot (never live constants — invalid/absent fails
closed 400), the rewrite adjusts rows + totals by the exact snapshot
deltas, and the update is TOCTOU-guarded exactly like /preferences
(accept-active pre-check re-asserted in the UPDATE's whereNotIn +
`price_locked_at IS NULL`, 409 on a lost race) so a concurrent accept's
frozen price can never be overwritten. Rollback = unset the gate (route
dead-ends; already-selected bonds are sold state and keep billing as
quoted).)
`/api/estimates/:token/extension-request` (POST; one-click "my link
expired, I still want this" from the React estimate page's expired/
not-found screen. Estimate token format gate (same slug-or-64-hex regex as
the slots router), generic 404 — unknown token, malformed token, ineligible
row, gate-off, (while GATE_SEND_REQUIRES_SERVER_PRICING is on) a row or
group link that fails the engine-pricing-authority verdict (#3750; judged
before the auto-grant claim, nothing burned), and — gate on or off — a row
under the legacy autofill hold (#4941; gate off the row alone, its revivable
siblings only while the gate is on) are indistinguishable — 5
req/hr per-IP limit, dark
behind GATE_ESTIMATE_EXTENSION_REQUEST (the rate limiter `skip`s while the
gate is off so a dark probe sees only generic 404s, never a revealing 429,
and keys via the shared /64-collapsing `rateLimitKey`). Eligibility
requires a PUBLISHED estimate (sent_at/viewed_at set — the expiration
sweep flips never-sent drafts to 'expired' too, and those must never
qualify) that is past expires_at or sweep-expired, not
accepted/declined/archived. Fixed-validity bids and groups containing any live
fixed-validity sibling (draft, scheduled, mid-send, published or expired —
not only the rows an extension would revive) are ineligible before
any claim: both the POST and the expired `/data` response use generic 404
without the extension-offer bit. Admin extensions refuse the whole group
before changing any expiry. Concurrency: the 24h dedupe stamp and the
lifetime auto-grant burn live in DEDICATED estimates columns
(`extension_requested_at` / `extension_auto_granted_at`, migration
20260711000001 — never estimate_data, whose full-blob writers could erase
jsonb stamps and un-burn the cap), claimed by one atomic conditional
UPDATE so concurrent POSTs can't fan out duplicates. First request per
estimate AUTO-GRANTS a 7-day extension via the shared
services/estimate-extension.js core (same expiry anchoring, status
revival, `estimate_extended` SMS, and `estimate.extended` email as the
admin extend route — consent/opt-out/Twilio-gate enforcement inside
sendCustomerMessage, suppression/dedupe inside the email template
library; post-write SMS/email plumbing never throws; the write is guarded on the
snapshot's status/archived_at and never moves an expiry backwards, 409 on
conflict; LIVE 'sending' claims are refused — only date-expired stale
ones extend), burned ATOMICALLY in the same claim UPDATE before any
mutation. Failure handling is fail-closed: provably pre-write errors
(400/409) release both stamps; ambiguous errors keep the BURN but release
the dedupe stamp so a retry reaches the notify-office path instead of a
false alreadyRequested. Repeat requests fall back to notify-office-only.
Every path raises an in-app admin notification (the auto-grant alert
retries once and error-logs on double failure; the notify-only path
treats the notification as the deliverable and releases its claim + 500s
when it can't persist); response carries only
success/autoExtended/expiresAt/smsSent/emailSent — no PII),
`/api/public/lawn-diagnostic/:token` (read-only prospect lawn report;
32-hex token format gate, 60 req/min rate limit, privacy headers
`no-store`/`noindex`/`no-referrer`, only `status='sent'` and unexpired
diagnostics, strictly whitelisted customer-safe payload — no internal
scores, raw AI, product names, label constraints, reconciliation/QA
internals, or tech notes — generic 404 for missing/draft/expired/malformed),
`/api/public/lawn-diagnostic/:token/quote-request` (write; same token gate
+ sent/unexpired requirement + generic 404, 10 req/min limit, strict body
validation before coercion — name plus a valid email or phone — links one
lead per diagnostic via an atomic `whereNull('lead_id')` guard returning 409
on repeat, no raw PII logging, never mutates diagnostic scoring or any
customer/assessment table).
`/api/public/lawn-assessment/analyze` (write; prospect lawn-photo upload for
the wavespestcontrol.com lead-magnet funnel — no auth, no token. Paid
dual-model vision per accepted request, so it carries the full abuse triad:
entire surface 404s unless GATE_LAWN_ASSESSMENT is on, honeypot drop,
Turnstile verified and enforced with GATE_LEAD_TURNSTILE, 5 req/hour per-IP
in-route limit plus the shared 40/day photoAssessmentDailyLimiter at mount,
≤5 photos with per-photo size cap. Persists a `lawn_diagnostics` row
(mode=prospect, source=public_funnel) via the SAME shared analysis ladder as
the tech flow; the response is a TEASER ONLY — a strict subset of the public
report egress allowlist (status label, one gated finding, counts) plus a
32-hex claim token. The full report payload never leaves the server before
claim. Prospect free-text note is stored for admin view only — never fed to
models or customer copy. Privacy headers on all responses.)
`/api/card/:token` (read-only digital business card payload; 64-hex
`customer_cards.share_token` format gate, generic 404 for unknown/malformed
tokens and archived/merged customers, 60 req/min per-IP read limit on top of
the global /api limiter, `Cache-Control: private, no-store`; payload is a
strict whitelist — customer FIRST NAME + member-since year +
has_left_google_review flag only, tech name + presigned photo, the
office phone — or, with GATE_TECH_LINES on and the card's tech holding a
registry tech line (`technicians.twilio_number`), that tech line —, the
tracked /l review short-link, and the customer's referral link
(share never exposes the card token) — no address, email, or phone PII;
the SPA shell `/card/:token` carries the same noindex/no-referrer/no-store
headers via sensitive-spa-headers.js),
`/api/card/:token/contact.vcf` (read-only Save-contact vCard; same 64-hex
token gate + archived-customer 404 + rate limit + `no-store`; contents are
COMPANY-ONLY — tech name/title, office line (or the tech's own line under
the same GATE_TECH_LINES condition as the JSON payload), company
email/site/address, license line — never customer data),
`/api/card/:token/wallet.pkpass` (read-only signed Apple Wallet pass; same
64-hex token gate + archived-customer 404 + per-route rate limit +
`no-store`; 404s whenever the PASS_* signing env vars are unset (config
self-gate — the card payload's walletAvailable mirrors it so the button
never renders a dead tap); pass carries customer FIRST NAME + member-since
year only — NO home coordinates, NO next-visit date (static pass, no
update plumbing), review QR falls back to the card link for
has_left_google_review customers).
`/api/public/lawn-assessment/:id/claim` (write; contact capture that unlocks
the full report — same gate-404 + honeypot + privacy headers, 10 req/min
limit, UUID + 32-hex claim-token format gates with generic 404 so tokens
can't be probed, strict body validation before coercion — name plus a valid
email or phone. Creates ONE lead per assessment inside a transaction with an
atomic status+`whereNull('lead_id')` guard (409 on replay), mints the
30-day report token served by `/api/public/lawn-diagnostic/:token`, and
stores a server-computed pricing snapshot from the pricing engine (size-band
basis, engine-authoritative — pricing failure never blocks the claim). After
the claim commits it best-effort inserts ONE ad_service_attribution funnel
row (lead_source=lawn_assessment, is_paid=false, idempotent on the unique
lead_id index) so the magnet reports in funnel-by-source like every other
channel. Optional `attribution` body is sanitized/allowlisted
(sanitizeAttribution) into leads.extracted_data + the row's click-id/utm
columns — first-touch evidence only, never a channel/is_paid reassignment.)
`/api/public/pest-identifier/analyze` (write; prospect pest-photo upload —
exact mirror of `/api/public/lawn-assessment/analyze` behind
GATE_PEST_IDENTIFIER, writing `pest_identifications`. Customer-visible copy
comes ONLY from the fixed PEST_LIBRARY allowlist in
services/pest-identification.js — model output never reaches a prospect, and
low-confidence/conflicting IDs degrade to generic category labels.)
`/api/public/pest-identifier/:id/claim` (write; mirror of the lawn claim —
same one-shot lead+token transaction, 409 on replay, same best-effort
ad_service_attribution row (lead_source=pest_identifier), typical-home
pricing snapshot only for engine-priceable service lines; termite/rodent/
bed-bug style IDs stay inspection-first with fixed suggestive-only copy that
must never read like a WDO/confirmed finding.)
`/api/public/pest-identifier/:token` (read-only tokenized pest report;
same contract as `/api/public/lawn-diagnostic/:token` — 32-hex format gate,
60 req/min, privacy headers, only sent/unexpired rows, strictly allowlisted
payload via buildPublicPestReport, generic 404, plus a set-once
`report_first_viewed_at` funnel stamp. Deliberately NOT behind
GATE_PEST_IDENTIFIER: sent reports are owner-initiated communications
(admin manual send works pre-launch), and an invalid token 404s exactly
like the dark surface — only analyze/claim are gated.)
`/api/public/pest-forecast` (+ `/pest-forecast/locations`, `/pest-forecast/nearest`) (read-only,
no auth, no DB writes, no PII — returns a deterministic Florida
pest-pressure model keyed only on a curated city slug / FL ZIP plus
public NWS weather and NOAA MRMS radar rainfall (via the Iowa
Environmental Mesonet); no request body. Intentionally CORS-open
(`Access-Control-Allow-Origin: *`) so the free embeddable forecast
widget can run on third-party domains; inherits the global `/api/` IP
rate limit. Caching: the per-location server cache and the forecast
response's `Cache-Control: public, max-age=<≤3600>, s-maxage=<≤10800>`
share one freshness instant — 3h after the forecast's weather was
fetched, 15 minutes while a SWFL city's radar rain for yesterday is not
available yet (IEM backfills late), and never past the next ET midnight
(the rain signal is yesterday's measured total). Both HTTP lifetimes are
the seconds left until that instant, measured when the response is sent,
so a result computed before ET midnight and sent after it carries
`max-age=0, s-maxage=0`; `/locations` stays `public, max-age=86400`.
`/nearest` returns only `{ location: <curated slug> | null }`, derived
from Cloudflare's visitor-location request headers (`cf-ipcountry`,
`cf-region-code`, `cf-iplatitude`, `cf-iplongitude`; zone Managed
Transform "Add visitor location headers"): a visitor geolocated in
Florida gets the nearest curated city, anyone else `null`. The location
values are never logged or stored, and it carries
`Cache-Control: private, no-store` (per visitor).
Note: unlike the token-gated read routes, the forecast and `/locations`
responses are deliberately cacheable and indexable — they expose only
modeled, non-sensitive forecast data, so `no-store`/`noindex` privacy
headers do NOT apply to them. `/nearest` is the exception: its answer is
per visitor, so it stays `private, no-store`).
`/api/public/yard-calendar` (read-only, no auth, no token, no DB access,
no LLM call, no PII, no request body — the SWFL yard pressure calendar: a
monthly lawn / shrubs & trees / weeds guide derived at request time from the
owner-approved species catalog (`server/data/species-catalog-v1`, via
`server/services/pest-forecast/landscape-calendar.js`). Query: `month` (1-12,
default the current ET month) and `grass` (`all|sta|bah|zoy|ber`, default
`all`); anything else is a 400 (`invalid_month` / `invalid_grass`). The
payload is items with name, host text, level (0-3) for the month plus the
12-month `levels`, a trend flag, the homeowner sign and look-alike copy, the
catalog service line and site link, and the month's plan-ahead notes; no
customer, pricing or account data. Level comes only from the catalog's
`active_months` / `peak_months`; a slug that is missing or not
owner-approved is left out with a warning (never a boot crash), and the
overlay test fails CI, so a thinner calendar never ships unnoticed. Intentionally CORS-open
(`Access-Control-Allow-Origin: *`, same app-level preflight handler as
`/pest-forecast`) so the guide can be embedded on other sites; inherits the
global `/api/` IP rate limit. Cacheable and indexable: an explicit month is
`public, max-age=3600, s-maxage=86400`, a defaulted month
`public, max-age=300, s-maxage=900` (it flips at ET midnight on the 1st).
No feature gate: it is read-only reference content.)
`/api/public/ui-flags` (read-only, no auth, no token, no params, no DB
access, no PII — compatibility shim that always returns
`{ portalGlass: true }`. The glass release gate is retired and current
client bundles no longer fetch this endpoint; cached app bundles can still
use it. Carries `Cache-Control: no-store` and inherits the global `/api/`
IP rate limit. Invariant: this
surface must never grow beyond boolean/enum release flags — anything
per-customer, secret, or configurable belongs on an authenticated payload).
`/api/public/social-feed` (read-only aggregate of already-public social
posts for the marketing /social page — Instagram + Facebook Graph API,
Google Business Profile localPosts, YouTube channel RSS; no tokens, no
PII, returns only public post metadata
(caption/thumbnail/permalink/timestamp), 60 req/min rate limit, 15-min
in-memory cache + 5-min public Cache-Control, per-source graceful failure,
never 500s — returns an empty payload on total upstream failure).
`/api/public/estimator/property-lookup` (write; unauthenticated lead-capture +
parcel lookup for the estimator — no auth, no token, 5 req/hour rate limit.
REQUIRES and stores customer PII — first name, last name, email, phone, and
address — into `leads`, and returns county parcel facts. Treat as a
PII-accepting public endpoint: scope any change to what it stores or logs.
Also accepts an OPTIONAL `prefill_lead_id` + `prefill_token` pair — the
lead-prefill HMAC below — which, when valid, makes the lead capture UPDATE
that existing open call-pipeline lead instead of inserting a new row; the
same pair is accepted by `/api/webhooks/lead` and its `/api/leads` alias
with identical semantics. Also accepts the OPTIONAL `timeline` described
under `/api/webhooks/lead` above, with the same storage and urgency
semantics; it survives the later `/api/public/quote/calculate` snapshot).
Attribution (referrer/UTM/click-ids) resolves through
`server/services/lead-source-resolver.js`, which shares its AI-assistant
referral detection table with `/api/webhooks/lead`'s classifier (see that
entry above) — a ChatGPT/Perplexity/Gemini/Copilot/Claude referral
classifies `ai_assistant` here identically. `heard_about` (also described
under `/api/webhooks/lead` above) is NOT currently read by this endpoint —
only `/api/webhooks/lead` / `/api/leads` persist it.
The returned and lead-stored `enriched` profile is the admin lookup's profile
MINUS the staff-only `subdivisionMedian` block (the plat name, county, and
assessed-neighbor sample/range that back the admin estimator's home-size
estimate for an unassessed vacant parcel) — `publicEnrichedProfile` strips it
on both paths; the response otherwise describes only the requested parcel).
Operational `meta.providerStatus` (credential configuration and attempted-provider
health) is staff-only; `publicLookupMeta` removes it from every public response.
The public `errors` array includes only the known outside-service-area verdict;
`publicLookupErrors` removes provider failures and internal diagnostic messages.
The response's `satellite.closeUrl` / `microCloseUrl` / `wideUrl` are ABSOLUTE
short-lived signed proxy URLs (`https://<portal>/api/public/map-image/<token>`),
never Google Static Maps URLs: the lookup builds keyed URLs internally (the
server Maps key, which also serves Geocoding/Routes and so cannot be
referrer-restricted), `publicSatellitePayload` re-signs only their
center/zoom/size, and the whole success body also runs the shared Maps-key
scrub (`scrubMapsKeysDeep`) as a last line. The marketing site's quote form
renders `closeUrl` as a plain `<img src>`, which is why the URL is absolute.
`/api/public/map-image/:token` (GET/HEAD, read-only signed satellite image
proxy; the ONLY way the public lookup, the customer service report
(`treatmentMap.satellite.live.url`, `stationMap.image.url`) and the customer
portal `/api/property/station-map` get a map image — none of those payloads
carries a maps.googleapis.com URL or a key any more; staff-only surfaces such
as admin dispatch keep direct URLs). The token is
`v1.<base64url(lat|lng|zoom|WxH|scale|maptype|exp)>.<base64url(HMAC-SHA256)>`,
keyed on `REPORT_PIN_SECRET` (falls back to `JWT_SECRET`) through a
purpose-derived key, 2 h expiry for report/portal links (24 h for the lead-form lookup, whose marketing-site form cannot re-request; never more than 24 h), constant-time compare,
fail-closed when no secret is configured (the map is omitted, never sent
keyed). The route reads NOTHING but the path token — no query param — and
rebuilds a keyless Static Maps URL only from the signed, range-checked values
(lat +-90, lng +-180, zoom 1-22, size <=640x640, scale 1|2, maptype
satellite|hybrid), appends the key inside the fetch (8 s timeout, image/*
content-type, 4 MB cap; a dedicated `GOOGLE_STATIC_MAPS_API_KEY` is preferred,
matching the basemap provider), and streams the bytes, so it cannot become an
open proxy or SSRF vector. Every refusal (malformed/forged/expired token, no
key, upstream failure) is ONE generic 404 body — including the empty token,
`//x`, extra path segments and every non-GET/HEAD method, which a terminal
catch-all in the router answers with the same 404 (the header stamp and the
route limiter run router-wide, ahead of the route, so no request under the
mount falls through to the global limiter or the app notFound; the mount is
case-insensitive and ignores a trailing slash; a last error handler in the router answers any error raised under the mount, such as a malformed percent-encoding like `/%E0%A4%A`, with the same 404 instead of the global 500); every response including the
404 and the 429 carries `Cache-Control: no-store` (success: `private,
max-age=900`), `Referrer-Policy: no-referrer`, `X-Content-Type-Options:
nosniff`, `X-Robots-Tag: noindex` and `Cross-Origin-Resource-Policy:
cross-origin` (helmet defaults to same-origin, which would block the <img> on
the marketing site or a separate API origin). No server-side image cache
(provider terms are display-only); a 60 req/min per-IP limiter (IPv6 /64
collapsed) fronts the whole mount, which sits in `server/index.js` ABOVE the global `cors()` (it would otherwise answer an OPTIONS preflight with a bare 204 ahead of the router), the global `/api/` limiter and the body parsers.
Regression guard: `server/tests/customer-map-no-key.test.js` fails if any
server module outside an explicit server-only/staff-only allowlist references
the Static Maps endpoint, and asserts the touched customer payloads carry no
key).
`/api/public/estimator/lead-prefill` (POST exchange, read-only semantics;
swaps the voicemail text-back link's `lead_id` + HMAC token for that ONE
lead's own contact fields — first/last name, email, phone, address, city,
zip, service_interest — so the /estimate quote wizard arrives prefilled.
Token is minted ONLY by the voicemail-lead SMS
(`utils/lead-prefill-token.js`):
`<expEpochSec>.<base64url(HMAC-SHA256("lead-prefill:<leadId>:<exp>"))>`,
14-day TTL, keyed on `LEAD_PREFILL_SECRET` (falls back to `JWT_SECRET`),
constant-time compare, fail-closed when no secret is configured. The token
is a bearer credential and stays OUT of URLs end-to-end: the SMS link
carries it in the /estimate URL FRAGMENT (never sent to the server, never
in Referer), the client scrubs it from the address bar at mount and strips
it from attribution landing_url, and the exchange is a POST body — never a
query string — so it can't land in morgan/Railway request logs. UUID
format gate on lead_id, 30 req/hour rate limit, privacy headers
`no-store`/`noindex`/`no-referrer`, and a generic 404 for invalid, expired,
mismatched, or unknown ids — indistinguishable on purpose (no oracle).
PREFILL/attach authority ONLY: it returns the contact data we already
texted the link-holder about, and is never accepted as identity or pricing
authority on any money path).
`/api/public/quote/calculate` (+ `/api/public/quote/upsell`) (write; public
instant estimate via the pricing engine — no auth, no token, 10 req/hour rate
limit. Persists a quote/lead and may text the quote via a Twilio short-link;
returns pricing and eligible booking handoffs. Optional `websiteFlow: true`
opts website estimate pages into `GATE_WEBSITE_QUOTE_BOOKING` (default off).
Only this run's self-bookable, server-priced `quote_wizard` draft may become
customer-viewable: estimate then customer row locks, unchanged lead/input/
totals, new-customer eligibility (including no appointment/service history), existing sendability guards, no uncertain
engine lines, and cent-exact frozen pricing plus membership-fee agreement.
No staff approval is required. Successful publication returns the additive
`website_estimate_url` and uses it for `booking_url` and the existing quote
invite; no new delivery mechanism is added. Published website quotes carry
`noEngagementAutomation: true` to exclude automatic follow-up campaigns;
the quote invitation and booking confirmations retain their existing paths.
A refused website publication
withholds the booking handoff. Legacy callers keep their current `/book`
handoff. Ordinary website lead forms do not opt into this route.
`services.treeShrub.tier` is validated (2026-09-24, codex P1 round 2): a
present tier must be a currently-sold one (`standard`/`enhanced`) or the
route answers 400 before pricing — `light` (4x/quarterly, retired for new
sales) and any unrecognized value are refused rather than silently priced
or forwarded unchanged. Absent stays absent (the engine's own `standard`
default runs, via `TREE_SHRUB.defaultTier` — the mandated 6x program, not
`enhanced`). A narrowing of the existing payload contract, not a new
field.
Address-verification guard (2026-09-23): when the SERVER-trusted property
profile (the cache-only `performPropertyLookup` re-read, or the lookup
stage's own server-written `extracted_data.address_unverified` on the
visitor's ownership-matched lead row — never the client's `enriched`
payload) carries a HIGH `address` verify flag from the county-roll
house-number audit, the run withholds the self-book handoff entirely: no
`/book` link, no estimate handoff token, no website publication
(`booking_url` null). The price still returns and the lead / estimate
still persist; the lead's `extracted_data.address_unverified` records the
audit (reason, county, typed number, nearest roll numbers, the judged
street/city/state/ZIP) for the callback, and a later run over a clean
address clears it (the key is always written, null when clean). The draft
estimate carries the same verdict as `estimate_data.addressUnverified`
(always written), which `wizardDraftSelfServeBookable` refuses — so a
booking link minted by an EARLIER clean run over the same draft dies on
its live recheck at `/api/booking/confirm` once the address is flagged,
and a staff revision of the draft preserves the marker. A website estimate
an earlier run already PUBLISHED for the same lead — or, since a repeat
lookup mints a new lead row, for the same typed email AND phone AND the
complete judged premise (street with any unit stripped, and a city and ZIP
present on both sides and equal) — is archived on the flagged run
(expired rows included when they were delivered or viewed, since the
public extension could otherwise revive them; a never-delivered expired
legacy row is left alone, having no revival path; the block on an
expired row is lifted by a later clean county answer, otherwise the
office re-quotes; and the withdrawal refuses with a retryable 503 while
any matched row carries a live delivery claim, checked again on each
write), with
the sent/viewed, unarchived, not-price-locked predicates re-applied on
the archive write itself (`website_quote_withdrawn_address_unverified`
audit event), so its old token neither renders nor accepts — and the row's
`estimate_data.addressUnverified` marker is itself an off-customer-surface
verdict (`estimateOffCustomerSurface`: view, server page, accept, asks;
`/decline`'s guard answers the same generic 404 for it, never the
re-price hold's 409),
so a generic unarchive or a withdrawal that failed to land still cannot
revive the link; the archived row keeps the verdict
(`estimate_data.addressUnverified` + `addressUnverifiedFlag`), and a later
run for the same email, phone and complete premise recovers it when the
roll does not answer. Each stage also records a server-owned
`extracted_data.address_verdict` (clean / flagged / unanswered, stamped
with the judged premise): a CLEAN verdict from the lookup stage stands in
for a roll answer at `/calculate` (record-less clean lookups are never
cached) and supersedes older lead, draft and withdrawn-publication
warnings for that premise — including the verdict on withdrawn
publications for the same email, phone and premise, which a clean run
marks superseded (`addressUnverifiedSupersededAt`) so no later outage run
can recover it. A bare `/book?lead=<id>` link (a run that minted no draft
carries no handoff token) is enforced at `/api/booking/confirm` too: when
the lead named by `lead` carries a server-written `address_unverified`
flag that covers the submitted premise, the booking is refused with 409
`code: "ADDRESS_UNVERIFIED"` — the lead id stays untrusted for identity (a forged
id can only block a booking at a flagged premise, never enable one). A
token-verified pricing handoff (`pricing_estimate_id` + `estimate_token`)
whose draft carries `addressUnverified: true` is refused the same way,
unconditionally — before any booking write, whatever the customers-only
gate or the bearer's authentication; both verdicts are rechecked under row
locks inside the booking transaction itself, so a flag committed between
the early read and the insert still refuses (409, code
`ADDRESS_UNVERIFIED`), and the in-transaction recheck also consults every
lead for the typed email AND phone whose flag covers the submitted premise
(a repeat lookup's newer lead). If the flagged run's publication
withdrawal transaction fails, `/calculate` answers 503 (retry) rather than
leaving an earlier publication live. The public lookup response never carries the profile's
internal `addressVerdict` trust marker (stripped with `subdivisionMedian`);
the lead-level verdict is derived server-side. `/calculate` publishes the
lead's verdict under a contact-pair advisory lock (`address-verdict`,
email + last-ten-digit phone) that `/api/booking/confirm` takes before its
recheck, so no flag lands as a phantom row between that recheck and the
insert. Staff clear the draft's marker by
revising the estimate with a changed PREMISE (house number / street /
locality — a unit-only edit is not a correction) or an explicit
`confirmAddress: true` on the revise request (the builder's "I confirmed
this address" control; edit-source reports the standing flag as
`addressUnverified`); the admin send guard refuses a still-flagged
estimate with 409 `ADDRESS_UNVERIFIED` since the customer link would not
render. A staff confirmation stamps a clean verdict on the linked lead
that outranks the CACHED county audit it answered (a cache-only re-read on
the next `/calculate` obtains no new evidence); only a profile cached after
the confirmation may flag the premise again (the lookup stage applies the
same rule to a cache-hit audit; the audit's own `auditedAt` stamp is the
evidence time, so a live backfill on a cache hit is fresh), and a cached
clean answer is evidence from its cache time, so a flag committed after that
stamp outranks it. A flag on the visitor's own lookup-stage lead is recovered by lead id
alone (a negative verdict, so a corrected email does not drop it); a
premise correction on the estimate moves the lead's address columns with
it; every send claim and the final pre-provider check reassert the block.
The locked reconciliation runs both ways: a newer
clean verdict (a staff confirmation, a clean lookup) supersedes a recovered
flag and a newer flag supersedes a recovered clean verdict, judged by
timestamps under the contact-pair lock; the visitor's own lead's clean
verdict is judged on the unit-insensitive premise alone (its locality may
be incomplete), other leads' need the complete locality. Withdrawn-publication
verdicts are superseded only after the locked reconciliation, and a flagged rerun withdraws website publications in
every non-terminal delivery state (sent, viewed, scheduled, sending,
send_failed) and stamps the block on matching legacy quote-wizard rows
(any of those states or draft) without archiving them; a clean verdict that
supersedes the warning also lifts the block on those unarchived legacy
rows; `/calculate` re-reconciles under the
contact-pair lock again right before it persists a draft verdict (a flag
committed meanwhile is carried onto the draft, never overwritten by a
stale clean marker); a lookup whose verdict/quarantine transaction rolls
back answers 503, never a successful lookup; the lookup stage
re-reconciles the contact pair under the lock before publishing (a newer
clean verdict outranks a cached audit) and takes the advisory lock before
any estimate row lock, the same order the booking confirm uses; it
applies the same quarantine when it persists a flagged verdict
(`services/website-quote-withdrawal.js`). A premise correction on the
estimate moves the linked customer through the established address-change
path (coordinates cleared, primary property synced, snapshots fanned out,
guarded re-geocode after commit) when that customer still lived at the
rejected premise. A roll that never answered (GIS
outage) is not a fresh flag — but it does not clear one either: the prior
server-written flag for the same address carries forward until the roll
answers clean, and an existing draft's own `addressUnverified` marker is
carried over under its row lock (handoff withheld) when the run got no
roll answer and the draft's address is unchanged.
Request shape: either `services` keyed by the engine
keys in `PUBLIC_QUOTE_SERVICE_KEYS` (`routes/public-quote.js`) or a catalog
`serviceKey` / `service_key` from the `/api/public/services/menu` payload,
which expands SERVER-SIDE via `quoteServicesForKey` — the posted body can
only add the site-collected options `mergeKeyedRequestOptions` allows
(today: the lawn grass `track`, forwarded into `lawn` AND
`lawnPestControl`). Service-menu phase 2 (2026-09-03) widened the instant
set by two keys: `oneTimeMosquito` (menu `mosquito_one_time`; priced by
treatable lot area; station / dunk add-ons are staff-scoped and never
site-selectable) and menu `lawn_pest_knockdown` → `lawnPestControl`
(turf-priced on the forwarded track; a lot-only lookup routes it to manual
review like the lawn programs). Catalog `cockroach_control` → `pestInitialRoach`
(owner ruling 2026-09-03: the two-treatment package priced as one
regular_standalone knockdown on the home footprint; species / severity /
price override stay staff-scoped, the site prices the native scale; the
included second visit is booked at completion at no charge). It prices
instantly but never mints a self-book slot (`bookingUrl` null, like bed
bug): the self-book funnel collapses it to the generic pest visit with no
catalog `service_id`, which the included second visit's scheduling needs —
the owner books the first visit. Instant eligibility also requires the live
`regular_standalone.treatments` display count to still read 2 — read from the persisted `pricing_config`
row itself (never process-local engine constants), on the menu build, on
the first eligibility read, and again immediately before the engine. The engine input freezes `packageTreatments: 2` and
`catalogServiceKey: cockroach_control` on the request, so the stored draft
regenerates the two-visit promise on every send / view and the accepted
visit resolves `service_id` by that exact key. All three are
additive — no existing key or response field changed. **Menu `flea_tick` changed product on 2026-09-03**
(owner ruling "flea is two visits"; PR #3845): the keyed request now
expands to the two-visit Flea Elimination Package (`flea_package`, 2
visits, conditional retreat guarantee) — previously the single-visit
knockdown. The retired `services.flea.offerKey = flea_knockdown_single`
is still accepted on the direct-`services` shape, but the engine prices
the package and routes the line to manual review
(`flea_single_visit_offer_retired`), so a stale caller gets a review
response, never an instant two-visit price it did not ask for. A
site-collected `services.flea.fleaComplexity` (`light` / `moderate` /
`heavy`) is forwarded on both shapes; absent, the package prices at the
base (light) rate. Lot-priced keys (`mosquito`, `oneTimeMosquito`,
`treeShrub`) park as `lot_size_requires_verification` when the lookup
flagged the lot verify-first; the response is then a manual quote, never a
price built from the synthetic sqft×4 fallback. Every mosquito line
(`mosquito`, `oneTimeMosquito`, commercial) goes one step further: the
engine line itself routes to review whenever the route passes
`lotSizeMeasured:false` (lookup miss, or a direct-API lot posted without
`lotSizeConfirmed`) — a mosquito price is only ever built from a
lookup-measured or customer-confirmed lot (owner ruling 2026-09-03; the
recurring program joined this contract then, so a direct-API caller that
posts an unconfirmed `lotSqFt` with `mosquito` now receives a manual
quote where it previously received a price)).

Keyed quote-on-request (a catalog `serviceKey`/`service_key` whose row is
`public_quote_selectable=true` but carries NO `PUBLIC_QUOTE_REQUESTS` entry,
`services/public-services-menu.js`): the route skips the pricing engine
entirely and calls `quoteOnRequestEstimate` (`routes/public-quote.js`) —
the lead is captured with `leads.service_key` + `service_interest` set to
the catalog name verbatim, zero totals, no self-book handoff — and the
response is `202 { quote_required: true, service, reason:
'quote_on_request', service_interest, message }`. `message` is a generic
"{catalog name} is priced by our team, not the calculator — we'll send
your estimate shortly." UNLESS the key carries its own service-specific
copy. `mosquito_misting_system` (Mosquito Misting System Service, catalog
row `20260924000020_mosquito_misting_catalog_row`; no engine pricer —
misting is quoted after an on-site design visit) is the one keyed
exception today: its `message` is "Mosquito misting systems are designed
and priced on site — we'll call to schedule your free design visit."
instead of the generic copy. No pricing, no self-book slot, no new auth
surface — additive response-copy branching only.

Repeat-run dedupe (#3834 split, PR A′; DARK behind `GATE_WIZARD_LEAD_DEDUPE`,
read at call time, default off in every environment — off, every run
files as `new` exactly as before): a tokenless `/calculate` whose typed
email AND phone AND quoted address AND service (catalog `serviceKey`, or
the normalized service-mix label for the direct `services` shape) equal an
OPEN `quote_wizard` lead's (`OPEN_LEAD_STATUSES`) created inside 30 days,
with no additional properties on either side and a live courtship (no
FK-linked estimate that is declined, expired or archived, and the LATEST
mirrored `estimate_data.lead_id` estimate, if any, is open), is filed as `status = 'duplicate'` carrying
`extracted_data.duplicate_of_lead_id` = that original's id, instead of a
second `new` lead. The token path (`leadId` + email) re-runs the exact
predicate against its OWN row, excluding itself and looking only back
(older rows), so the label lands, moves or clears on THIS row — scoped to
the status and typed identity the request read; a relabel that hits 0
rows follows the row as it now is. A row that just filed as a repeat
drops its own lead-stage `ad_service_attribution` row and the root's row
is rebuilt when missing. Label ONLY: the route never selects, updates or
reads the original for anything but re-validating the chosen target; the
marker grants no access (a typed contact is not ownership evidence), the
draft estimate stays mirrored to the run's own row, and `/upsell` reaches
only the authenticated lead's draft. Resolving a repeat to its root at
estimate acceptance / self-booking is PR B′ (services, not this route).
Kill switch: unset the gate — rows already labelled keep their marker.
`/api/public/ai-intake` (`GET /status` + `POST /message`) (the Ask Waves
marketing-site chat brain — no auth, no token, **gated behind GATE_ASK_WAVES**
(503 when off; fails closed in prod). Rate limits: 30 req/15min in-route on
/message + a 120 req/day per-IP cap at the mount scoped to plausible POST
/message bodies only (paid-LLM surface, same rationale as
paidEstimatorDailyLimiter; GET /status, non-POST probes, gate-off probes,
and empty/oversized bodies are all LLM-free — they 503/400 without spending
the cap, so shared-IP noise can't lock out real chat turns). PII contract:
requires NO PII and
asks for none — visitor free-text + client-echoed history (both length- and
turn-clamped, roles allowlisted) is sent to the LLM and logged best-effort to
agent_sessions/agent_messages (channel `ask_waves`); treat message content as
untrusted input, never as identity. HARD INVARIANT: this surface can never
emit a price — prompt rule + PRICE_TALK_RE post-scrub + no pricing endpoint;
the chat's quote step posts to the existing `/api/public/quote/calculate`
above, which owns the four-field contact gate, lead minting, and attribution.
All deterministic guards (price scrub, emergency + account-support fallback
when both LLM providers miss) read English AND Spanish — the prompt answers
Spanish visitors in Spanish. Each turn has a wall-clock budget across both
providers (`ASK_WAVES_TURN_BUDGET_MS`, default 22000) after which the
deterministic fallback is returned; the conversation log never delays the
reply. Any reply — from either provider, on any intent — that carries
safety wording, an EPA-approval claim, or a fixed re-entry/drying time
(duration or clock time) is replaced wholesale with a reviewed "follow the
product label" answer, in English or Spanish matching the reply's own language
(a reply with emergency direction keeps the 911 / veterinary script instead;
a non-emergency reply that carries both a claim and price talk gets the
reviewed price redirect, which is also claim-free). The safety/emergency check
reads the model's original reply before the price scrub, so a price mention
never erases emergency direction.
The check is the intake-local topic chokepoint in `ask-waves-intake.js`
(`intakeSafetyClaimSupplement`), run on typography-folded text; the shared
`reentrySafetyClaimFinding` is deliberately NOT called on this per-turn path
(its worst case blocks the event loop, #4905). Safety wording is judged by
topic, not grammatical subject, so it over-blocks by design.
With `GATE_ASK_WAVES_TOPIC_ROUTING` on (dark; read at call time through
`askWavesTopicRoutingLive()`), the model also returns a `topic`
(`medical_emergency` / `product_safety` / `reentry_timing` / `none`; the field
and its rules are sent only while the gate is on), and routing on that topic
runs before the claim chokepoint:
- `medical_emergency` → the emergency script (no quote CTA). Poison Control /
  veterinary lines follow the visitor's words as in `emergencyGuidance`, and
  any `PET_WORD` animal in the conversation or a vet / animal-hospital question
  adds the veterinary line.
- `product_safety` / `reentry_timing` → the reviewed "follow the product label"
  copy (EN/ES), keeping the model's validated quote fields (restored when the
  model also labeled the turn "emergency"); it becomes the emergency script
  instead only on qualified evidence in the conversation (`qualifiedEmergencyIn`
  — a product exposure, a symptom after a treatment, or trouble breathing),
  never on the broad detector's other phrases (#4899).
- `none`, or a missing / unknown topic, keeps the model's answer, which still
  goes through the claim chokepoint and the price scrub. The broad emergency
  detector is not consulted on this path: a flagged claim, a reassurance or
  price talk becomes the emergency script only on qualified evidence
  (`qualifiedEmergencyIn`) or when the model's own reply directs to emergency
  care; otherwise a claim gets the reviewed label copy and price talk the
  price redirect. There is no regex floor on the visitor's words: routing
  follows the model's classification only.
The model also returns `language` (`en` / `es`, the language of its reply,
sent only while the gate is on); the reviewed copy follows it, and a missing
value falls back to the Spanish-word detector on the visitor's active message,
then the reply.
The provider-failure fallback is unchanged (there is no model topic). Gate off:
prompt, schema and replies are unchanged.
With `GATE_ASK_WAVES_EMERGENCY_CHECK` on (dark; `askWavesEmergencyCheckLive()`,
#4899), every turn also runs a second opinion on `TEXT_POLICIES.fastStructured`,
started alongside the answer (the answer waits for it at most 1.5 s after it is
ready, and not at all when it is already the emergency script): one question, "is anyone in medical danger?",
over the whole visitor side of the conversation (`{ in_danger: boolean }`).
A yes turns any answer whose intent is not `emergency` (including the
provider-failure fallback) into the emergency script (`topicEmergencyScript`
over the visitor side: Poison Control / veterinary lines as above; no quote
CTA). It only ever adds the emergency script; a no, a failed or late check,
or a malformed verdict leaves the answer unchanged (fails open to the
answer, which keeps every guard above). Its accuracy is the classifier's —
there is no regex on this path. NOT CORS-open — credentialed allowlist
origins only (hub site)).
`/api/public/experiments` (`GET /status` + `POST /exposure`) (client-side
GrowthBook experimentation surface — no auth, anonymous visitors are the
unit. **POST /exposure is gated behind GATE_GROWTHBOOK** (404 when off) with
a 30 req/min per-route rate limit on top of the global limiter. Invariants:
strict shape validation (experiment/unit/variation regexes, scalar-only
value clamped to 100 chars); the experiment key must be a currently-live
tracking key in the cached GrowthBook feature payload; SERVER-owned
experiment keys (`estimate-view`, `booking-abandon-recovery`) are ALWAYS
refused — server-side sticky replay trusts `experiment_exposures`, so a
public post must never be able to pre-assign a real unit's arm;
`unit_type='anon'` + `metadata.source='client'` are forced server-side; the
response is 204 for stored AND dropped posts (no experiment-enumeration
oracle); the first-exposure-wins unique constraint dedups repeats. No PII —
anonymous visitor id only. The rate limit is scoped to gate-ON /exposure
posts — gate-off probes always see the 404 without spending it, and
`GET /status` is limiter-free (kill-switch probe must never starve).
`GET /status` returns only `{enabled}` (boolean, never 404s) = master gate
AND server feature-cache warm — the client SDK fetches feature definitions
only after it says enabled, which is what makes unsetting GATE_GROWTHBOOK a
real rollback for client experiments too (and keeps clients dark while the
server can't validate exposure keys)).
`/ingest/*` (first-party PostHog ingest proxy — no auth, no token; the
browser SDK on the hub and on `/book` posts here instead of `*.posthog.com`
so ad blockers stop dropping funnel events. **Gated behind
GATE_POSTHOG_INGEST_PROXY** (generic 404 when off, no upstream call; read at
REQUEST time via `gateEnvValue` — `1`/`true`/`on` — so a flip needs no code
deploy; Railway restarts the process on the variable change, which is what
makes it take effect — never set it with `--skip-deploys`).
Mounted in `server/index.js` ABOVE helmet, the CORS allowlist and the body
parsers → `routes/posthog-ingest.js`. Invariants: the upstream origins are
FIXED constants (`https://us.i.posthog.com`; `/static/*` and `/array/*` →
`https://us-assets.i.posthog.com`, PostHog's own proxy split) and the resolved URL's origin is asserted
against them (400 otherwise) — leading `/` and `\` runs are collapsed to one
`/` first, so a protocol-relative (`//evil.com/e/`) or backslash tail can
never resolve off-host (SSRF, Codex r1 on #4027); GET/POST/OPTIONS only
(405); a per-IP limiter (`POSTHOG_INGEST_RATE_MAX`/min, default 300; 429;
keyed by the shared `unauthenticatedAuthLimitKey`, so IPv6 collapses to /64)
sits AFTER the gate so gate-off probes stay an unobservable 404 and never
spend budget; a process-wide in-flight cap (`POSTHOG_INGEST_MAX_IN_FLIGHT`,
default 32; fast 503 + `Retry-After`) with a per-IP share of it
(`POSTHOG_INGEST_MAX_IN_FLIGHT_PER_IP`, default 4, same /64 key as the
limiter) is checked BEFORE the body is buffered so concurrent bytes are
bounded (32 × 2 MB) and one caller cannot park on every slot —
a client disconnect aborts the upstream call and the slot is held until
that call settles, so upload-and-hang-up loops cannot exceed the cap, and an
upload deadline (`POSTHOG_INGEST_UPLOAD_TIMEOUT_MS`, default 15 s) tears down
a body that has not fully arrived so stalled uploads cannot sit on the slots;
2 MB raw body cap (413); 10 s upstream timeout (502); the upstream response
is STREAMED to the client with backpressure — never buffered — under a size
cap (`POSTHOG_INGEST_MAX_RESPONSE_BYTES`, default 8 MB; over it the response
is cut off and upstream cancelled) and a downstream write deadline
(`POSTHOG_INGEST_RESPONSE_TIMEOUT_MS`, default 15 s), and the in-flight slot
is held until the downstream write has finished or the connection closed.
Inbound request headers are ALLOWLISTED — only `content-type`, `accept`,
`accept-language`, `origin`, `user-agent` and the preflight
`access-control-request-*` pair cross — so cookies, authorization, referer,
content-encoding (the raw body parser has already inflated the bytes) and
every proxy-chain / client-IP header of any spelling (RFC 7239 `Forwarded`,
`X-Forwarded-*`, `X-Real-IP`, mesh / CDN variants) never reach PostHog;
`X-Forwarded-For` is set to `req.ip` (trust-proxy aware) so PostHog GeoIP
survives, and `origin` passing through lets PostHog's own CORS reflection
answer the browser (spoke origins never touch the portal allowlist). Outbound `set-cookie`,
`content-encoding`, `content-length` and HSTS are dropped and
`Cross-Origin-Resource-Policy: cross-origin` is set so the hub can load
`array.js` cross-origin. Nothing from the request is logged — not the body
and not the path (caller-controlled free text; an upstream failure logs the
method, a fixed `static`/`ingest` category and the error kind only). The
global `/api/` limiter does not apply (different prefix, mounted above it),
hence the route limiter; abuse is bounded to forwarding to PostHog's public
ingest, which the public project key already permits directly. Kill = unset the gate AND
revert the caller's host env (hub `PUBLIC_POSTHOG_HOST`, portal
`VITE_POSTHOG_HOST`) — an SDK pointed at a 404 just drops events.)
`/api/public/services/menu` (read-only catalog-derived product menu the
website quote form renders from — no auth, no token, no params, no PII.
Mounted at `server/index.js` → `routes/public-services-menu.js`; payload is
`{ generated_at, items }` from `services/public-services-menu.js`, served
with `Cache-Control: public, max-age=300` on success and `no-store` on
error; inherits the global `/api/` IP rate limit. Consumed by the Astro
quote form, so its item shape is a spoke-fleet contract per CLAUDE.md
rule 18 — additive changes only, with ONE documented exception: a catalog
row the menu previously advertised can be RETIRED from it via
`services.public_quote_selectable=false` (owner directive, mirrors a
retired cadence tier — e.g. `lawn_care_recurring` 2026-09-24,
`tree_shrub_quarterly` 2026-09-24) — the item disappears from `items` on
the NEXT menu fetch, but never breaks a caller that already has the old
payload cached: `services/public-services-menu.js`'s `FORMERLY_PUBLIC_KEYS`
denylist keeps posting that key to `/api/public/quote/calculate` resolving
(never a 404/500) as a quote-on-request lead — never instant-priced,
never silently repriced at a different tier. `is_active` stays true either
way (historic/scheduled visits still reference the row); `customer_visible`
is a separate, per-row decision independent of this menu removal —
`tree_shrub_quarterly` keeps `customer_visible=true` (20260924020010,
superseding 20260924020000's flip of that one flag) specifically so an
existing customer's tracking-page visit summary is unaffected, while
`lawn_care_recurring` set it false too since it has no such grandfathered
dependency).
`/api/public/service-areas` (read-only canonical SWFL city list — no auth, no
token, public `Cache-Control`. Consumed by the Astro build and the admin blog
UI; no PII).
`/api/public/pricing-ranges` (read-only engine-derived per-service price
ranges — no auth, no token, public `Cache-Control`, no side effects, no PII.
Ranges are computed from the live pricing engine (DB-authoritative
pricing_config) so the published numbers cannot drift from admin-edited
pricing; owner ruling 2026-08-06 approved publishing ranges for all
residential services. Owner ruling 2026-09-27 narrowed what each range
means: every row is now a TYPICAL residential job at LIST price (standard
scheduling, before WaveGuard bundle discounts, recurring-customer perks,
and advertised waivers), not an envelope of every possible quote — a
larger or more complex property, a heavier infestation, a bigger scope, or
emergency/after-hours service can quote above the published high, and the
payload's `disclaimer` says so. "Typical" is sized from the estimator's own
property lookups: the middle 80% (10th-90th percentile) of the residential
homes in `property_lookups` for house, lot, and turf size, with the
landscaping, pool-cage, and water-proximity mix those homes show. Consumed by the Astro build for the
agent-readable /pricing.md surface and directly by AI agents (both
surfaces read this same computed payload — neither carries its own copy
of the sweep). Exact per-property pricing stays on POST
/api/public/quote/calculate.
The `tree_shrub_care` row contracted with the Light tier's retirement
(2026-09-24): the sweep is now `standard`/`enhanced` only (`light` dropped
from the tier sweep the same way the lawn row above dropped its retired
6x column), and `notes` reads "6 or 9 applications per year by tier"
instead of the old 4/6/9 wording; since the 2026-09-27 typical-job
narrowing above, the published low is Standard's list-price floor on a
typical lot (`low` ≈ $36), not a bundle-discounted value.
`/api/public/credentials` (+ `/api/public/credentials/:slug`) (read-only
canonical FDACS / license / insurance numbers — no auth, no token, public
`Cache-Control`. Consumed by the Astro content build; intentionally public
business credentials).
`/api/public/automation-preview/:stepId/:token` (read-only; renders an
automation step's HTML body with SAMPLE merge values only — no real customer
data — for operator preview/share. Token in path, `noindex`).
`/l/:code` (short-link resolver for every customer-facing short URL — 302 to
target / 410 on expired / generic 404 with no enumeration leak; `noindex`;
mounts OUTSIDE the global `/api/` limiter so it carries its own 120/min
per-key limiter; new codes are 10 chars ≈ 49.5 bits since 2026-08-07,
legacy 5-char codes still resolve).
`/go/:code` (outside-link click redirect for prep-guide links to third-party
sites — 302 to the registered destination / generic 404 with no enumeration
leak; `noindex`, `no-store`, `Referrer-Policy: no-referrer` on EVERY status
(302/404/429/500 — set before the limiter); mounts OUTSIDE
the global `/api/` limiter so it carries its own 120/min per-key limiter (the
`/l` budget). **Not an open redirect**: the destination is ONLY a
pre-registered `outbound_links` row looked up by a 20-hex code that is the
sha256 of the target URL (row must hash back to its code, http(s) only);
nothing in the request names or changes the target. The query carries only an
HMAC-signed attribution context (template key, customer id, visit or project
id, surface — row ids only, NEVER the bearer prep token, which would land in
the request log; it is resolved to ids at render time) — an invalid signature is ignored, never trusted. Human clicks log
to `outbound_link_clicks` (sha256 ip hash; bot/preview UAs and staff — the
`waves_admin` marker cookie or `WAVES_ADMIN_IPS`, the same `shouldRecord`
filter `/l` uses — still redirect but log nothing). Codes are minted at render time only while `GATE_OUTLINK_TRACKING`
is on, but the route stays live regardless of the gate so links already sent
keep working. Destinations are never tagged or altered.)
`/og/report/:token.jpg`, `/og/<kind>.jpg`, `/og/default.jpg`
(`server/routes/og-preview.js`, link-preview images, owner 2026-09-27: the
picture iMessage/SMS/email crawlers show under a texted or emailed customer
link; `server/index.js` renderHTML writes the matching `og:image` into each
customer page's `<head>`, and `og:title`/`twitter:title` read just "Waves").
Mounted OUTSIDE the `/api/` limiter with its own 120/min per-key limiter
(the `/l` budget), and BEFORE the global body parsers (it reads no body).
Fixed cards change only the preview tags, never the page's own `<title>`.
**Only the service report card looks its token up**
(owner 2026-09-28): `/og/report/:token.jpg` (and the `/report/` and
`/recap/` pages' head tags, both already behind the report limiter) resolve
through report-page-metadata's lookup with its `typedReportDelivery`
suppression — 32-hex format gate before any DB read, read-only, never
URL-decoded, a failure logs only the error code (knex messages embed the
token). Its privacy headers precede the limiter. **Deliberate exception to
"generic 404":** an unknown, malformed or suppressed link returns the
default card, 200, byte-identical to `/og/default.jpg` with the same
headers — still no existence oracle, and the crawler shows a branded card.
**Every other kind is a fixed card** (`/og/<kind>.jpg`, `FIXED_CARDS`:
project report, appointment, reschedule, prep, invoice, receipt, statement,
estimate, tracking, assessment, …): it reads nothing from the database,
carries no token, and is served `public, max-age=3600` without privacy
headers. A fixed card whose surface is dark (`GATE_APPOINTMENT_PAGE`,
`payerStatements`, re-service self-serve, `leadInspectionLinkLive`,
`recruitingComms`) resolves to the default card, matching that surface's
uniform 404; an unregistered or inherited name gets the default too.
Payload is a 1200x630 JPEG of an eyebrow, headline and subline: never a
price, amount, name, address, phone, email, tech name or note, and
estimates stay generic (no services or prices). Routes match the raw path
(regex captures that can't hold `%`), so no parameter is URL-decoded and a
malformed encoding can't reach the JSON error handler; any other `/og` path
(another kind with a token, a bad token, no `.jpg`) is the default card.
The file segment two levels under `/og` is always redacted from request
logs (`redact-request-url.js`). No query parameters are read. The render cache is keyed by card content, never by
token.
`/r/:code` (referral click-track + redirect to the marketing site; also
OUTSIDE the `/api/` limiter — carries its own 30/min limiter and a
url-safe 4-32 code format gate before any DB read; every hit below the
gate writes a `referral_clicks` row, malformed/unknown codes redirect
home without touching the DB).
The estimate `/data` response includes `verifiedStaffPreview: true` only
when `adminPreview=1` is accompanied by a valid staff bearer token. The
customer SPA uses that verified field (or the existing verified
`adminDraftPreview` flag) to disable customer actions in previews; a copied
query marker alone does not change a published customer's actions. The
field is absent from ordinary customer responses.

`/api/estimates/:token` core family (GET view + `/data`, PUT `/accept`,
`/decline`, `/select-tier`, `/preferences`, POST `/bundle-inquiry`, GET
`/pdf` — the customer estimate surface behind every estimate link.
Router-wide url-safe 15-64 token param gate (generic 404, prod-verified
against all live tokens 2026-08-07); accept/decline carry a 10/hr
limiter — the two heaviest public money-adjacent writes; select-tier/
preferences ride estimateToggleLimiter, data rides dataLimiter, pdf rides
its own estimatePdfLimiter (10 per 5 min)).
Guarantee rule for the estimate page, its proposal document and Ask Waves
(owner 2026-09-26/27): a guarantee line that covers the whole estimate
appears only when every service carries it. The recurring plan terms
(callbacks, money-back, no contract) are carried by residential pest, lawn,
mosquito, tree & shrub and palm; "satisfaction guaranteed" is also the
rodent and commercial lanes' own term, so it may cover any estimate without
termite or unclassifiable work. An estimate with termite work
states no callback, money-back, satisfaction or no-contract terms for any
service; its termite work states "no guarantee" except the terms of a
termite bond, trenching warranty or pre-slab warranty option the customer
selected. Where no estimate-wide terms apply, Ask Waves answers every
guarantee question with one per-service list under these rules, never infers
from a question's wording which service is meant, and never serves a model
answer that makes a plan-terms claim. A service that carries the plan terms
itself lists them under its own name, as the page shows them on its own card;
the route passes the page's `noEstimateWideGuarantee` and commercial scope so
Ask Waves never states more than the page.
`/data`'s optional `estimate.noEstimateWideGuarantee: true` (and the same
field on a document `proposal`) is set when not every service carries the
recurring residential terms: a rodent, commercial, termite or unclassifiable
service anywhere, or an authored (commercial) proposal
(`estimateCarriesPlanTerms` / `proposalCarriesPlanTerms`). Absent otherwise.
Lines that cover the whole estimate follow it through the shared
`guaranteeScope` ('none' under `noGuaranteeClaims` below, 'satisfaction'
here, else 'all'): the shell footer's "Backed by the Waves Guarantee", the
legacy plan-terms card, perks and one-time callback note, the hero, the plan
CTA line, the one-time price card and the document's terms line. Row-level
copy states each service's own terms instead: `/data` stamps `termsScope`
('all' | 'satisfaction' | 'none') on every `pricing.services[]` section,
`pricing.oneTimeBreakdown.items[]` row and document
`proposal.buildings[].lineItems[]` line (`serviceRowTermsScope` /
`proposalRowTermsScope`). It is 'all' for residential pest, lawn, mosquito,
tree & shrub or palm work, 'satisfaction' for rodent or commercial work
(every row of an estimate with a commercial row or an authored proposal),
and 'none' under `noGuaranteeClaims`. A row's inclusions, one-time copy and
detail follow it (`serviceGuaranteeScope`); a row without the field follows
the estimate, and the legacy page applies the same per-row rule. So a pest
section beside a rodent one keeps its own plan terms while the footer stays
neutral.
`/data`'s optional `estimate.noGuaranteeClaims: true` (copy-audit follow-up
to #4874, 2026-09-26; termite gets no generic estimate-wide guarantee)
is the page's guarantee decision, `serviceMixMakesNoGuaranteeClaim` in this
route, read from the SAME normalized rows the page's category and
regulated-surface decisions use (`recurringServicesWithSupplements` plus the
`normalizeOneTimeBreakdown` rows unioned with the pricing bundle's). Present
only when true, absent otherwise so every other response stays
byte-identical. True when any recurring or one-time service row is termite
work (the page's own category, or termite wording on the row), when a service
row can't be classified, or when nothing on the estimate classifies at all.
Setup, discount and credit rows never count (`isNonServiceOneTimeItem`), and
a positive "other one-time services" residual counts as unclassified work.
The React page's one-time hero and the proposal document's terms line drop
their guarantee wording when it is set; per-service CTA lines follow their
own services (`glassCtaMicroForKeys`: termite work or an unclassifiable
service makes no guarantee). Derived read-only; no write. The legacy
server-rendered page applies the same rule to its plan-terms card.
The annual rate review disclosure (owner ruling 2026-09-30; shared
`RATE_REVIEW_TERMS_LINE`, "Rate reviewed yearly after 12 months, 30 days’
notice") follows the plan-terms scope the same way: the proposal document's
terms line (browser and pdfkit renderers) and the legacy plan-terms card
("Rate reviewed once a year") print it only when every row carries the
recurring residential plan terms ('all') and at least one line recurs —
never on a termite-only, rodent, commercial, authored-terms, programs or
one-time-only estimate. The document's decision is the server's alone:
`/data` projects the explicit boolean `proposal.rateReviewTermsEligible`
(`proposalRateReviewTermsEligible`, the pdfkit fallback's own decision)
beside `proposal.noGuaranteeClaims`, and the browser document prints by it
rather than re-classifying row descriptions with its own narrower service
taxonomy (a row the server classifies as lawn or tree & shrub work may carry
no "lawn"/"tree" word). Frozen documents keep their original terms: on an
accepted or declined estimate (`estimateIsPriceLocked`) the disclosure prints
only on persisted evidence that the customer saw it — the recorded
acceptance's verbatim snapshot carried the sentence (the 'plan' drawer
below), or the accept stamped `estimate_data.rateReviewDisclosedAtAccept` —
written atomically with a recurring-residential-plan acceptance — the public
accept and the admin's manual mark-accepted alike — ONLY on
persisted evidence that the customer was served the line while the estimate
was open: that same recorded 'plan' drawer snapshot, or
`estimate_data.rateReviewTermsServed` at the current shared
`RATE_REVIEW_TERMS_VERSION`, which the `/pdf` download (either renderer) and
the legacy page's plan-terms card write when they print the disclosure to the
CUSTOMER — only a request the view counter treats as the customer's own
(`shouldCountView`: never a bot or link unfurler, an admin-marked or admin-IP
request, a staff or draft preview, an internal refresh or the pinned headless
pass) records it; any other request gets the page or document as it stands,
unrecorded
(idempotent; never on a frozen estimate; never fatal to the download or the
page; made durable BEFORE either renderer runs, and before the legacy page
is sent). The marker never moves `updated_at`, so an accept racing from
another tab merges the row's current marker through its own `estimate_data`
write and decides the stamp from the row under its lock, not from its
pre-transaction snapshot — evidence persisted after that read is still
honored. The other order — the accept lands first — turns the marker write
into a zero-row no-op (the row is frozen): the `/pdf` download then renders
the row as it is now (frozen, no line unless that accept stamped it) and the
legacy page answers one `303` to its own URL (query preserved; cache headers
set) and re-renders from the current row instead of sending HTML that shows
a term the accept never recorded — bounded to one hop, because a frozen row
never enters that branch: an accepted page has no plan-terms card and a
declined page prints no rate review item at all (it keeps its cancel/refund
card; "declined never acquires it" holds on the legacy page too). Persistence
unproven — a write that FAILS, an eligibility check that errors, or a
zero-row write that cannot be shown to have hit a frozen row (re-read failed,
row missing or still open) — withholds the line rather than showing it
without evidence: the `/pdf` download serves the pdfkit document without the
line (the browser renderer reads the row itself and cannot be told), the
legacy page re-renders without the item, and a `/data?mode=pdf` document pass
(the headless capture, or a customer's bare `?mode=pdf` view) runs the same
pre-render step and projects `rateReviewTermsEligible: false`. That pass
records evidence only while GATE_ESTIMATE_DOC_PDF is on — the condition under
which the document is actually rendered; with the gate off, `?mode=pdf` falls
through to the normal page, shows no document, and records nothing. Plan eligibility alone never stamps: an accept from a tab that rendered
no rate copy (a bundle that predates the line with the gate off, the
terms-neutral annual prepay lane with nothing downloaded) leaves the frozen
document without the line rather than claiming a disclosure that was never
shown. A document accepted before this disclosure existed, accepted under the
'base' drawer, or declined never acquires it; an open estimate is sold under
the current terms and prints it.
The acceptance terms (`acceptanceTerms`, GATE_ESTIMATE_ACCEPTANCE_TERMS)
carry the same rule as a SCOPE on one version: `scope: 'plan'` — the
Services drawer line ends with the rate review sentence ("Rates are reviewed
once a year after your first 12 months, with at least 30 days’ written
notice before any change.") — is served only when the estimate is a
recurring residential plan (every service carries the plan terms, the
`noEstimateWideGuarantee` decision above, and the estimate is not
one-time-only); every other cancel-anytime estimate (rodent, one-time-only)
is served `scope: 'base'`, whose drawer is byte-identical to v2026-09. A
'plan' payload also carries `oneTimeTerms` (the 'base' lines) for the
customer's one-time toggle, which has no rate to review. The page attests
the scope it rendered (`termsScope` beside `termsVersion`) and the accept
route re-derives the scope from the estimate and the accept's own one-time
mode, recording the verbatim snapshot for that scope or refusing a
mismatch — or a current version with no scope — with the same reloadable
409 `TERMS_VERSION_STALE` as a stale version, so no acceptance is ever
recorded under a Services line the tab did not render.
The accept's saved-payment-method consent is attested the same way
(codex #5434 r1 P1): an accept that carries a verified Auto Pay capture
(`recurringCardSetupIntentId` under a required recurring-card policy — the
inline capture / capture modal rendered the card, ACH or prepay variant of
the bundle's consent text) or acknowledges the prepay exact-total quote
(`prepayChargeConsentAccepted`, whose checkbox rendered the prepay variant)
sends `consentTextVersion`, the client's `CONSENT_VERSION`; the route
refuses any other value, or none, with
`409 { error, code: 'CONSENT_VERSION_STALE' }` before any mutation, so the
post-commit consent snapshot (recorded from the server's current text) is
never written for a tab that rendered older copy. An accept that captures no
consent ignores the field.
When `/data` includes a `proposal` for document rendering or an enabled
public proposal, its explicit boolean `proposal.noGuaranteeClaims` classifies
the normalized rows that the document actually prints. React document mode
uses that flag before the page-level fallback; PDFKit uses the same decision.
Thus disabled itemization retained for document rendering can suppress
guarantees in the document without changing the current page's policy or
prices. Generic promise suppression does not remove a row's explicitly
purchased warranty scope, which still requires that row's sold-tier metadata.
Projected one-time-choice rows retain reconciled `warrantyTier` and
`warrantyAdder` from the same evidence used to resolve their copy, including
when a mapped `result` omits evidence that remains in the matching raw
`engineResult`. A current engine replay (including its cache) governs older
saved rows; a sent snapshot's `snapshotHit` keeps its historical source from
being mistaken for that replay. In unversioned projections, an explicit
priced or current saved `none`/`null` decision blocks older purchased proof,
including key-alias and zero-price clearing rows. Removal metadata survives
the public response so assistant fallback cannot restore rejected coverage.
Warranty evidence is audited
before price filtering or deduplication across `oneTime.items`, nested one-time
items, supported `specItems`, and `lineItems`; ambiguous repeated service rows
cannot borrow another row's warranty. Ask Waves coalesces renamed fallback
display rows against the current canonical service identity, while retaining
all raw rows for warranty evidence. Distinct current jobs remain distinct.
The server, browser, and Ask Waves use the shared purchased-warranty evidence
rule and the existing authored copy pack. Ask Waves normalizes legacy termite
bond aliases, names, and `bondYears` through the acceptance converter's
canonical identity rule; every guarantee question, named or generic, returns
the one per-service list described above, and the question's wording never
narrows it to a single service. A current top-level bond selector governs historical snapshots.
Without that selector, the unversioned saved rows and frozen pricing must
agree on the purchased bond term; explicit removal, contradictory terms, or
zero-price decisions suppress coverage regardless of snapshot order. A raw
termite-bait row's `selectedBondTerm` also participates in this check.
Ask Waves also requires separate recurring-terms eligibility: rodent,
commercial, bundle, and unknown scope never inherit residential callbacks,
money-back, or no-contract terms merely because the page permits a
category-specific satisfaction statement.
`/data`'s optional `consultationOffer: { url }` (consultation-first lane,
owner ruling 2026-09-23; dark behind BOTH `GATE_ESTIMATE_CONSULTATION_OFFER`
and `GATE_LEAD_INSPECTION_LINK` — `server/services/estimate-consultation-offer.js`)
is the "Want us to come look first?" section's link to the SAME
`/inspection/:token` self-booking page the recurring-lead new_lead email
offers (`lead-consultation-email-block.js`). This entry covers the page
field only; the gone-quiet follow-up email's own link
(`estimate-email-consultation-offer.js`) reuses the same eligibility and is
not part of this route's payload.
Present only when: both gates are live; the estimate
is in an open, customer-actionable state (never accepted/declined/expired/
send_failed/unpublished/past-expiry, and never a staff draft or verified
staff preview — the same `isEstimateAcceptActive` verdict `returnVisit`/
`softExit` use); exactly one linked lead — a live lead whose
`leads.estimate_id` names this estimate (the link the admin estimate tool
writes) and/or a stamped `estimate_data.lead_id` with a STRONG `lead_linkage`
(`sid` or `stamp`); two pointing leads, or a pointer and a stamp that
disagree, offer nothing; the linked lead is still the estimate's contact
(`leadMatchesEstimateContact`, `lead-estimate-link.js` — the same customer
when both are linked to one, otherwise a matching phone or email; the
pointer is editable on its own, so a lead that no longer matches offers
nothing); the linked lead passes `leadLinkRefusal` (open lead, US phone, and — if a
customer is linked — that customer live and still on the lead's phone) and
`leadWantsRecurringPlan`; and the `/inspection/:token` page's own lead-wide
probe (`inspection-public.js` `_internals.computeConsultationSlotsForLead`,
the same one the email block uses) finds at least one open slot AT THIS
ESTIMATE'S PROPERTY — the address the page resolved matches the estimate's
(same street key, unit and zip); an out-of-area, unresolved, no-address,
retired-catalog, no-open-times or other-property result omits the field.
The probe is bounded, and either bound omits the field for that load: it
is time-boxed at 3 s (`PROBE_BUDGET_MS` — a slower probe is abandoned, left
to finish in the background, and nothing it resolves is used), and at most
3 probes run at once per server process (`MAX_PROBES_IN_FLIGHT`, abandoned
ones counted until their work settles — past the cap no probe starts).
After the probe the estimate and the lead are re-read and every row-level
rule above is re-judged on the fresh rows (`finalEligibility`, all from one
read-only REPEATABLE READ snapshot so every check sees the same instant), so
a status change, hold, re-link or contact edit that lands during the probe
omits the field — and so does a change to what the page's booking address
resolves from (the lead's own address, its trusted customer's stored address
or coordinates, or which customer that is: `inspection-public.js`
`bookingAddressInputs`, compared, never re-geocoded), or a booking that
leaves the page's own lead-wide state no longer bookable (an assessment or
visit booked meanwhile: `currentBookingState`, the same `readEligibility`
the probe ran).
Quote-first only: never on an estimate drafted from a visit
(`estimate_data.scheduled_service_id`) or on a grouped estimate
(`estimate_group_id`). Composed on the page's own first `/data` load only —
never on an internal `?refresh=1` of a viewed estimate (the client carries
the first load's offer forward) and never for a caller that does not opt in
(`includeConsultationOffer`). The Intelligence Bar's `get_estimate_detail` projection drops
`consultationOffer` (the URL is a booking bearer). The URL is
`consultationUrlForLead(leadId)` with NO channel (unverified delivery — this
is neither an SMS send, which asserts phone delivery, nor an email send);
the endpoint makes NO write of any kind to mint it (no `createShortCode`, no
DB insert) — a public GET stays read-only. Any lookup error, or any other
ineligibility, omits the field entirely (never `null`); absent, the page
renders byte-identical to before this field existed.
Authored commercial proposals expose reviewed four-decimal quantities and unit
rates, explicit unit labels, cent-rounded line amounts, and the fixed
`validThrough` date in their normalized proposal and document output. Internal
`estimate_data.proposalCosting` stays outside that public allowlist. A fixed
price hold governs expiry even after resends and cannot be changed by the
generic extension or auto-renew paths; these additions do not widen draft access.
A delivered group anchor may remain navigable through its stored
`estimate_data.groupLinkViewableThrough` after its own offer expires, in both
the HTML and `/data` views, so valid siblings remain reachable. Expired legacy
anchors with this navigation window route to the React property-group view
(the API HTML mount redirects to `/estimate/:token`). This window
never changes offer deadlines, acceptance, CTA eligibility or reminder copy.
Archived, unpublished, send-failed and off-surface rows remain withheld, and
the call-side block still overrides navigation access. During an admitted group
navigation window, eligible published expired members remain in `propertyGroup`
with `status: expired`; a member whose own link is no longer viewable omits
`token` and renders as a nonclickable expired summary.
An active anchor's own unexpired deadline also permits these summaries; receipt
visibility alone after acceptance or decline does not extend this window. Expired
navigation-only pages hide the unavailable PDF download. Legacy token redirects
retain no-store privacy headers. An expired anchor without a live window can
recover a missed grant on HTML or `/data` access after a temporary call block
clears: the shared transaction pins its id, token and group, requires current
published/call-clear eligibility, and updates only navigation metadata from
eligible actual offer deadlines.
The `/estimate/:token?website=1` SPA uses the website's compact pricing →
scheduling → Auto Pay presentation over these same APIs. `embed=1` permits
framing only while `GATE_WEBSITE_QUOTE_BOOKING` is on and only from the
existing first-party CORS origin allowlist (`server/index.js` CSP); other
estimate documents retain the strict framing policy. Query markers do not
grant draft access or change token, payment, consent, or booking eligibility.
The iframe exchanges only height/step messages with its parent, which checks
the sender window and exact origin; no customer details or tokens are posted.
`pricing.frequencies[].perServiceTreatments[].palmCount` (palm-care bullet
lane, owner 2026-09-24; restructured to a single evidence + stamping
chokepoint in Codex round 4 on #4789 after three earlier rounds each found
a different per-builder carry that leaked a raw or stale value — NO
pricing-bundle builder attaches this field itself any more): a positive
integer riding a Tree & Shrub treatment row ONLY when the quote actually
PRICED those palms. The v4.7 routine palm-care reserve (armed in prod
2026-09-24 ~23:53Z) prices a SERVICE-LINE palm count either way (folded
into the legacy per-tree term while unarmed), but a PROPERTY-sourced count
prices NOTHING until the reserve is armed — every quote saved before the
arm time is unarmed. `pricedTreeShrubPalmCount`
(`server/services/pricing-engine/tree-shrub-palm-priced.js`) is the one
evidence predicate: priced when `palmCountSource === 'service_line'`, OR
the reserve's `perPalmAnnual`/`minutesPerPalmVisit` knob is armed;
evidence-less legacy rows (no source, no knob) fail closed — no bullet.
`treeShrubPalmCountForEstData` (estimate-public.js) resolves the one
authoritative count per request: a FRESH engine result (this request just
re-ran pricing) is checked first and is final for T&S once present,
outranking anything stored; otherwise the MAPPED envelope
(`result.results.tsMeta`, gated through the predicate — then the mapped
`result.recurring.services[]` tree_shrub row, ALSO gated through the
predicate rather than trusted, since a raw engine line can land in that
exact slot too, e.g. one-tap-purchase.js) is authoritative and exclusive
whenever it exists — a revision can leave an older raw `engineResult`
behind, so raw line items are read only when no mapped envelope exists at
all. `stampTreeShrubPalmCount` then applies that ONE resolved count to
the FINAL pricing bundle, on every `buildPricingBundle` return path
(a fresh build, the `sendSnapshot` fast path, and the pricing-cache fast
path all funnel through it) — it sets the field on every tree_shrub
`perServiceTreatments` row and unconditionally DELETES it otherwise, so a
stale or raw value from an older cached/snapshotted bundle, or from any
future producer, can never survive to the client. Validated
positive-integer, clamped ≤200 by the pricing engine; omitted entirely (not
`0`, not `null`) whenever the estimate has no palms OR the palms it has
weren't priced, so existing clients that don't know the field see no
change. A ROWLESS single-service T&S card (an engine-backed multi-service
split, no `perServiceTreatments` on that card) instead carries the count
directly on the frequency. The full set of paths the stamper writes, all
under the same priced-only validation, omission, and chokepoint rule:
`pricing.frequencies[].perServiceTreatments[].palmCount`,
`pricing.frequencies[].palmCount` (rowless solo-T&S ladder),
`pricing.services[].frequencies[].perServiceTreatments[].palmCount`,
`pricing.services[].frequencies[].palmCount` (rowless split T&S card), and
`pricing.serviceCadenceCombos[].perServiceTreatments[].palmCount`. On the
`sendSnapshot` and pricing-cache fast paths, when stored evidence alone
cannot resolve a count (an engine-inputs-only estimate, whose build stamped
from the fresh engine run), the count already stamped in the frozen/cached
bundle is reused — only the stamper writes this field, so a stamped value
is trusted. Display-only:
drives one extra customer-facing inclusion bullet ("Includes care for your
N palms — seasonal palm nutrition and root-zone treatment when needed", singular
for 1) and has no effect on any price, fee, line item, or booking/acceptance
math anywhere in the contract. The legacy server-rendered estimate page
(`use_v2_view=false` / the GrowthBook control arm) shows the identical
sentence on its own Tree & Shrub service-price card, resolved through the
same `treeShrubPalmCountForEstData` evidence function (stored evidence
only — this render path never re-runs the engine).
`/accept` fails CLOSED when the accepted plan's money cannot be resolved
(#3751): 409 `{ error, code }` with nothing booked and call-the-office copy
— `PER_APPLICATION_ADD_ON_UNPRICED` (an established per-application
customer adding a unit whose per-application price cannot be derived),
`LEGACY_MONTHLY_TERMITE_UNCONVERTIBLE` (an in-flight count-less termite
quote whose card discloses monthly installments — re-issued by the
office, never converted against its card), and
`INVOICE_MODE_PER_APPLICATION_UNRESOLVED` (an invoice-mode recurring
accept with no resolved per-application amount — never the monthly
display rate). Same contract via the admin manual-acceptance path, which
preserves these 4xx verbatim.
Overlapping annual coverage on public `/accept` returns 409
`{ error, code: 'ANNUAL_PREPAY_OVERLAP' }` with the existing call-the-office
explanation and no acceptance committed. Clients preserve the appointment
selection and display that billing conflict instead of a slot-taken message.
A clarify RE-PRICE HOLD (`estimate_data.estimatorEngine.reprice_pending_at`
non-empty — stamped by `estimate-clarify-asks` when a customer's unit or
bedroom reply proves the row's address or dollars stale; lifted only by the
operator's revision / proposal save or by the replacement draft's supersede
archive) takes the row out of the customer surface for as long as the
marker is on the row, whatever the row's status becomes afterwards. The
marker is stamped on UNSENT rows only (draft / scheduled / send_failed /
sending — a delivery that has not published yet); a building-level quote
staff already SENT before the customer's reply is NOT retracted by this
mechanism (the office is belled and the unit lands on the CRM record; an
automatic retract-and-replace is the C2b follow-up). While the marker is on:
the GET view (React `/data`, the legacy SSR page, `/pdf`, the slots
routes, every `isEstimateCustomerViewable` consumer) answers the same
generic 404 as an unknown token, and the two writes refuse with 409
`{ error: 'This estimate is being re-priced — please try again in a few
minutes' }` — `/accept` inside its locked read, `/decline` at the
guard AND on the UPDATE's own predicate (a hold landing between the two
parks the decline on that 409, never a stale 'declined' terminal); the
pricing mutations (`/select-tier`, `/bond`, `/interior-service`,
`/service-opt-out`, `/preferences`) and the ask endpoint treat a held
row as not accept-active / not answerable at the pre-read, and the five
mutations predicate their whole-blob writes on the marker's absence, so
none of them can overwrite the hold off the row; `/extension-request`
treats a held row as ineligible (the generic 404), and the auto-grant
claim, the notify-only claim, the guarded expiry write, and the sibling
revive all carry the marker predicate — a hold that lands after the
eligibility read never burns the grant, texts a link the renderer
refuses, or pages the office with a 201 (the zero-row claim re-reads and
answers the generic 404); `/bundle-inquiry` judges the locked row with
the same verdict (409 "no longer active", the route's existing shape for
an inactive row); the slots `/reserve` write re-judges the LOCKED row
with the same verdict before minting a hold (generic 404, no
reservation). A
group's held siblings are skipped at preflight, claim and publication;
a held ANCHOR parks as `send_failed`. No enumeration signal: the hold
is unobservable from outside beyond the accept/decline 409, which a held
row can only reach through a link that went out before the hold.
`/select-tier` refuses any tier above the tier the ENGINE wrote for the
estimate's qualifying services (400 `tier_not_available_for_current_services`
+ `maxTier`; downgrades stay allowed): the ceiling is the last opt-out
commit's `serviceOptOut.engineTier` stamp, else the stored `result` /
`engineResult` tier (every carrier shape the portal's readers accept), else
Bronze — fail closed, never a re-count of the stored rows under today's
qualifying policy, and never the row's own `waveguard_tier`, which holds the
customer's last selection once the route writes it back (validation audit
SEC-001, 2026-09-02; before it the ceiling applied only to opted-out
estimates). A membership reconcile that reprices the mix refreshes the
opt-out stamp with the row tier.
Slot-hold lifetime (owner case 2026-09-11 — a customer confirmed 34 seconds
after her 15-minute hold lapsed, was refused, and believed she had paid).
`POST /reserve/:scheduledServiceId/extend` pushes an EXISTING hold's expiry
out by the standard hold window: same `reserveLimiter` budget and token-format
gate as `/reserve`, same call-side-blocked and ineligible-estimate refusals,
and the same generic 404 for an unknown token, an unknown hold, a hold
belonging to ANOTHER estimate, an already-committed row, or a hold past the
grace — the route is not an enumeration oracle for hold ids. It never creates
a hold, never changes the slot, and never touches price, customer or estimate
state. A hold may not live past `MAX_HOLD_MINUTES` (60) from its own
`created_at` however many times it is extended (409 `HOLD_LIMIT_REACHED` with
the unchanged `expiresAt`); the same ceiling binds `/reserve`'s same-slot
refresh, so re-POSTing `/reserve` is not a way around it. An extension whose
window a COMMITTED visit has since taken supersedes the hold and answers 409
`SLOT_UNAVAILABLE` rather than keeping a hold the accept is guaranteed to
refuse — and the supersede is committed, never rolled back with the refusal.
Reviving a hold that has ALREADY LAPSED (inside the grace) arbitrates against
live HOLDS as well as committed visits — a lapsed row stopped occupying its
window, so another customer may hold it — and is refused outright under
`GATE_SCHEDULING_CAPACITY`, where arrival allocation has no equivalent probe. Commit-time grace:
`/accept` graduates a hold expired by less than `RESERVATION_COMMIT_GRACE_MINUTES`
(default 10, clamped 0-30, 0 disables) — every conflict re-check still runs
under the date lock, so an in-grace commit cannot double-book, and the expiry
sweep holds the same row for the same window. The grace widens adoption ONLY
for the estimate's own unclaimed hold, never another customer's row, and the
VIEW path never OFFERS a lapsed hold. Every hold-expiry refusal on `/accept`
carries `code: RESERVATION_EXPIRED` so the client names the real cause instead
of reporting a taken slot.

Appointment reminders registered by `/accept` derive their date and arrival
from the committed service row. A server-owned `reservation_service_mix`
allocation can preserve one booked arrival across sequential member work
windows, including when grouping is disabled. The existing reminder dedupe,
reschedule sync, sibling promotion, and send-time hold checks use that arrival;
a member moved away from its allocated date/start returns to its own arrival.
Registration still suppresses immediate confirmation delivery. This metadata
is internal and adds no request field or public payload field.
`/accept` existing-appointment adoption (`existingAppointmentId` in the
body, offered by the view contract instead of the slot picker): the row
must belong to this customer, be unclaimed or claimed by THIS estimate,
never a callback visit, dated today or later, and in an adoptable status.
The estimate's OWN uncommitted reservation hold IS offered through this
shape (a customer who picked a slot and then reloaded), and the payload
says so: `isHold` is true and `reservationExpiresAt` carries the hold's
expiry as an ISO instant. Both fields are ABSENT for a genuinely
committed visit — not `false`/`null`, so a client that distinguishes an
absent property keeps the exact pre-2026-09 payload — including one carrying a stray
`reservation_expires_at`, which `releaseExpiredReservations` exists to
rescue — so a countdown never starts on a real appointment. Another
estimate's hold is still never offered. The page uses the two fields to
run the hold timer and the extend action described below; a client that
ignores them sees the previous committed-appointment shape. Adoptable statuses are `pending`/`confirmed`;
behind `GATE_ESTIMATE_ADOPT_IN_PROGRESS_VISIT` (fail-closed in every
environment — off unless the var is a `gateEnvValue` true: `true`, `1`
or `on`, case-insensitive; re-read per accept request, so a flip is a
live kill) `en_route`/`on_site` rows are adoptable too, so an on-site accept prices and claims the visit in
progress instead of minting a duplicate. The status set is snapshotted
ONCE per accept request and feeds both the preflight offer and the
under-lock UPDATE (a gate flip mid-request cannot 409 an offered row);
a row that stops qualifying between them answers 409 `existing appointment is no longer available`.
Adoption stamps `source_estimate_id`, the customer, the accepted plan's
per-visit price (or clears a stale one), and the catalog identity — it
never changes the row's status or date. The customer-wide fallback that
OFFERS an unlinked same-family row stays behind
`GATE_ESTIMATE_EXISTING_APPT_CUSTOMER_WIDE`.
`/data` carries an optional `lawnCalendar` block behind
`GATE_ESTIMATE_LAWN_CALENDAR` (dev-open, prod dark): `{ programs: {
[frequencyKey]: { visitsPerYear } } }` for each of the recurring lawn
section's frequencies whose count matches a catalog lawn plan
(`resolveLawnCareRecurringPlanByCount`, self-booking-plan-sync.js); no
customer data, no dates. A frequency with no catalog plan is omitted; the
key is ABSENT when the gate is off or nothing resolves (it was boolean
`true` from 2026-08 until #3755). The page renders the count and fixed
season copy from it and never derives an interval itself. The `cadence`
interval line and projected `months` the entry carried from #3755 were
dropped on 2026-09-06 once the page stopped reading them (owner
2026-09-05: education, not a schedule).
`/data` breakdown rows (`pricing.oneTimeBreakdown.items[]`) may carry a
`copy` object — `{ key, outcome, includes[], assurance|null, terms }` —
and rodent-trapping rows may carry the sold allowance used to render that
copy: `includedFollowUps` / `includedCallbacks` (number, `'unlimited'`, or
null), `unlimitedCallbacks` (boolean or null), and `includedScope` (string or
null). These are terms from the saved pricing snapshot, not live job counts.
A one-time-ONLY estimate whose billable rows all resolve to one copy
pack may carry `pricing.oneTimeServiceCopy` — `{ key, hero: { eyebrow, h1,
sub }, aiTitle?, aiBody?, askChips[] }` (hero strings keep `{first}`/`{city}`
tokens for the page; `aiTitle`/`aiBody` are present only for packs that
carry Waves AI copy) — both resolved server-side from the static pack in
`server/services/estimate-one-time-copy.json` (owner-approved customer
copy: what the visit includes + guarantee terms per service; no customer
or pricing data). A row with no pack entry omits `copy` (rows keep it on
mixed and recurring estimates — a recurring pest plan with a roach cleanout
add-on still describes the cleanout); `oneTimeServiceCopy` is omitted on
mixed one-time quotes and on any estimate with a recurring service; a
regulated certificate surface (WDO in the aligned OR raw rows) never
carries either key. When `oneTimeServiceCopy` is present its
`askChips` ARE `pricing.askChips` — a pack with its own chips supplies
them, a hero-only pack echoes the category chips the page renders — and the
server-rendered page reads the same pack, so the two paths cannot drift.
`/api/documents/shared/:token` (read-only shared-document fetch incl.
on-the-fly service-report PDFs — customer PII by design; 64-hex format
gate, 24h expiry with 410, access-count audit, 30/15min limiter,
`no-store`).
`POST /api/stripe/terminal/validate-handoff` (machine-to-machine burn of
the 60s single-use handoff JWT — the token IS the auth; see the atomic
terminal-handoff burn rule in AGENTS.md. THIRD-PARTY BILL-TO WITHDRAWAL
(2026-09-12): a combined-visit invoice whose Bill-To moved to a payer after
the handoff was minted keeps a collectible status and a NULL `payer_id` —
the move is recorded only in its withdrawal stamp — so this route treats a
withdrawn invoice exactly like a terminal status change and refuses with the
existing `invoice_changed` outcome after the burn, rather than handing the
technician a card-present session for debt now owed by AP. `/handoff` refuses
to mint one for the same reason, and `/payment-intent` refuses with
`409 { code: 'invoice_withdrawn_from_customer' }` — including a re-read under
the invoice row lock at the final bind, so a Bill-To change committing during
the mint is caught).
`/api/admin/push/vapid-key` (GET; deliberate — the VAPID public key is
public by protocol).
`/api/health` (GET; liveness probe, no data).
`/api/integrations/backlink-worker/claim` (GET) accepts `mode=draft|acquire`:
`outreach` defaults to drafting and `signup` to acquisition. Drafting requires
`GATE_OUTREACH_DRAFTER`; acquisition requests return an empty claim because
execution is restricted to the in-process signup runner. That runner requires
both authority/runner gates, a current executable free-path authority and a
reserved daily slot; its citation executor claims signup lanes only. `/report` (POST) binds new leases
to that authenticated provider and mode; a draft lease cannot report placement.
The in-process browser must atomically begin the reserved submission before a
placement report is accepted. Existing unstamped leases retain their report
contract during rollout. Reports never establish `live` or `indexed` truth.
`/api/integrations/*-worker` mounts (hermes workers; each authenticates
via its own HMAC-signed header check inside the router — an
unauthenticated internal route here is P0). `watchdog-worker` (GET
`/status`, key `hermes_watchdog`, gate `GATE_HERMES_WATCHDOG`) serves the
external agent watchdog a counts-only health snapshot — no customer data,
no item titles, no error text (job_health.last_error is only digit-masked),
no sub-read error messages; adding any free-text field is P0. `reasons` are
count-free stable keys — a count inside a key re-pages one incident.
`commitments-worker` (GET `/open`, key `hermes_commitments`, capability
`commitments_read`, gate `GATE_HERMES_COMMITMENTS`) reads existing open Waves
call commitments. HMAC only; backlink/watchdog keys and legacy bearer cannot
read it. Dark gate precedes the 30/minute IP limiter and auth/audit. Privacy
headers cover every response. Strict offset/limit-only query, max 100 rows
plus a has-more probe. Response includes obligation description, bounded
verbatim evidence with source anchors, identifiers, deadlines, record version,
and selected fulfillment hints; no contact fields, raw transcript, recording
URL, full customer row, or unrestricted JSON. Quotes may themselves contain
customer information: private case evidence only, never a shared wiki/log.
Reads never refresh/extract/fulfill or send; existing HMAC nonce/audit writes
remain. Failed audit finalization returns 503, not data. Coverage is stored
open call commitments, not SMS/email completeness or freshly verified state.
Offset pages are not a snapshot; absence cannot establish completion.
Customer authentication (`server/routes/auth.js`, mounted at `/api/auth`):
`POST /send-code`, `/verify-code`, `/refresh`, `/logout` are unauthenticated
by definition. send-code and verify-code sit behind the `server/index.js`
`authLimiter` (10 per 15 min keyed by `unauthenticatedAuthLimitKey` — JWT-
blind, IPv6 /64-collapsed) plus per-route `ip:phone` limiters (5 and 8 per
15 min); send-code returns ONE uniform response whether or not the number
matches a customer, verify-code returns one uniform error for a bad code OR
an unknown customer, logout is non-enumerating and idempotent, refresh and
logout share a 30 per 15 min limiter. The enforced anti-enumeration
contract is the uniform BODY: response timing is not equalized (the Twilio
send runs only when the number matches an active customer), so a timing
observer can still distinguish known numbers — do not widen the claim
beyond the body, and do not add a second observable difference. `/me`, `/properties`, `/select-property`
require the customer JWT.
Staff authentication (`server/routes/admin-auth.js`, mounted at
`/api/admin/auth`): `POST /login` sits behind the same `authLimiter` (10 per
15 min) and answers every failure with a generic 401 `Invalid credentials`;
`/forgot-password` (5 per 15 min) and `/reset-password` (10 per 15 min) key
on `unauthenticatedAuthLimitKey` with production-only limiters;
`/change-password`, `/register` (requireAdmin), and `/me` require the staff
bearer. OAuth callbacks validate a one-time `state` nonce, never bearer (see
the AGENTS.md admin OAuth rule).
`/.well-known/apple-app-site-association` + `/.well-known/assetlinks.json`
(static universal-link association JSON for the native app shell — no auth,
no PII, no request-derived content. **Both 404 behind GATE_UNIVERSAL_LINKS**;
AASA also requires a team ID (`APPLE_TEAM_ID`/`APNS_TEAM_ID`), assetlinks
also requires `ANDROID_ASSETLINKS_SHA256`. The AASA path list MUST keep
`/admin/*`, `/tech/*`, `/api/*` excluded — the shell is customer-only and
API/PDF responses must never be claimed by the app).
`/.well-known/security.txt` (RFC 9116 vulnerability-disclosure contact — static
plain text, no auth, no PII, not gated; `Expires` is computed per request 180
days ahead so it never goes stale; cached 1 day).
`/api/public/track/:token` (read-only live service tracker; the
`track_view_token` is the ONLY gate (`TOKEN_RE` format) plus a 120 req/min
rate limit. In ANY state it returns the customer property block — first name,
service address (line1/line2), lat/lng — and a top-level `prepToken`,
independent of tracker state. It uses the newest linked project's token
among projects with both `prep_token` and `prep_sent_at`; otherwise it uses
the visit's `prep_token` only when the visit has `prep_sent_at`, or null.
A non-null token fans out to `/prep/:token`. `en_route` additionally returns live tech coords + ETA
from Bouncie. The `complete` summary additionally hands out secondary bearer
tokens — `serviceReportToken` (`report_view_token`), `invoiceToken`, a
`/rate/:token` review URL, and TTL-presigned service-photo URLs — fanning out
to the report / receipt / rate surfaces. Treat the track token and any change
to its payload, in any state, as security-critical. The GET stays strictly
read-only; it has exactly TWO write companions, both bounded.
`POST /api/public/track/:token/stops-ahead` — same token gate + rate limit,
ignores its body, and only persists the stops-ahead display-clamp floor
(monotone LEAST, skip-unchanged) via `computeStopsAhead` before returning the
displayable count. `POST /api/public/track/:token/view` — same token format
gate, expiry fence (unknown / malformed / expired = the same generic 404, no
write), privacy headers and router rate limit; ignores its body; records ONE
`customer_page_views` row (`page: 'track'`, subject = the visit, bots / staff
skipped, 10-minute dedupe) fire-and-forget and answers 204 with no body. The
page calls it once per token on its first successful load, never on the 30 s
poll. A lookup failure on `/view` is logged code-only (`logViewFailure`,
never `err.message`, which can carry the bound token) and still answers 204;
it is never forwarded to the global error handler. The privacy headers are
also stamped by the `trackPublicPreparser` mount
(`server/middleware/track-public-preparser.js`) in `server/index.js` AHEAD of
the global `/api/` limiter and the shared body parsers, so a limiter 429 on the
bearer URL carries them too. The same guard answers `/view`'s malformed-token
404 before any body parsing and drops the request Content-Type so the ignored
body is never parsed (a malformed / oversized body cannot become a 400/413). Neither companion may grow beyond its single
bounded write).
`/api/public/appointment/:token` (GET summary + `GET /:token/calendar.ics`
+ `POST /:token/confirm`; the destination the 24h reminder and booking
confirmation texts link to. Gated by `scheduled_services.reschedule_token`
— the SAME secret /reschedule uses, deliberately reused rather than
minting a second one — plus a 60 req/min router limit and 10 req/min on
the confirm. **Anonymous application GET/POST requests return 404 unless
`GATE_APPOINTMENT_PAGE` is exactly `true`.** A prefix-scoped noStore + gate
runs before the global API limiter and body parsers; the router retains
its gate before its local limits. Earlier shared controls keep precedence:
CORS can finish OPTIONS requests, and signed Staff requests receive 503
while Staff maintenance is enabled.
GET returns the visit summary (service type, date + window_start, the
server-derived arrival range, plan/one-time flag, confirmed flag, and
`vanScene` — a boolean that is exactly `GATE_VAN_SCENE` in production
(feature-gates `vanScene`: prod dark, unset = false; every other NODE_ENV
— local, preview, test — returns true regardless of the variable, so the
unset kill switch is a PRODUCTION statement) telling the page to render
the "look for this van" scene under the header card; it carries no visit
data and no other field changes with it) plus
decorations that are each individually fail-open: assigned tech first name
+ TTL-presigned photo, a same-tech-as-last-visit flag, and the day's NWS
rain chance. **NO customer name, and the page greets nobody** —
`loadByToken` deliberately does not select `c.first_name`. The token is
per-VISIT, not per-recipient: appointment notifications fan out to a
spouse, tenant, buyer or other service contact, each text personalized to
THAT contact, so serving the account holder's name both mis-greets the
reader and hands a third party an identity they were never told. Do not
reintroduce it. window_end is never returned — customer surfaces quote
start + 2h only, and the range is derived server-side with
`arrivalWindowRange()` so the page cannot drift from the reminders.
`rescheduleToken` (the "See open times" CTA's destination, `/reschedule/
:token`) is null — suppressing the card — for a grouped/frozen visit, a
dispatch-owned unreviewed booking, or an inactive/cancelled account.
`canMoveOnline` (dead-link guard, C3/C6, 2026-09-28) is an additional
boolean, false when the visit itself already starts inside the self-serve
MOVE notice window (`SELF_SERVE_MOVE_NOTICE_HOURS`, `visitInsideMoveNoticeWindow`)
— the CTA's own destination would refuse the move — and the client hides
the card when either is falsy. The separate missed-visit "pick a new time"
recovery link (a different, `state: 'past'` branch of this same GET) is
unaffected; it is not gated on either field.
The confirm write is a status-only `pending -> confirmed`
transition guarded on the status AND the date/window that were read, plus
a `job_status_history` row. The client posts the slot it rendered and the
server confirms ONLY that slot — the office bulk reschedule moves
date/window while LEAVING the row pending, so a status-only guard would
bless a replacement slot the customer never saw. It never touches
date/window/tech and sends NOTHING to the customer. calendar.ics is a read-only RFC 5545 file for
the same visit, UID-stable per visit so re-downloading updates rather
than duplicates.
`POST /:token/photos` (dark server foundation, `GATE_VISIT_PREP_PHOTOS`,
layered on `GATE_APPOINTMENT_PAGE` — this route rides the same router, so
BOTH must be on): lets the customer attach up to 3 photos + a short note to
THIS specific upcoming visit before the tech arrives (`server/services/
visit-prep.js` owns storage). Guard order: the router-level gate/noStore/
60-per-min limiter, then `visitPrepPreParserGuard` — ONE function mounted
twice: by `server/index.js` on the `/api/public/appointment` prefix AHEAD
of the shared `express.json`/`urlencoded` parsers (so a dark or malformed
photos request 404s before a parser can answer an oversized or malformed
`application/json` body with its own 413/400), and again as the route's
own first step. It applies the SAME `TOKEN_RE` format check the GET uses,
the sub-gate, and a multipart-only body rule (the route accepts nothing
else, so a JSON / urlencoded / other body never reaches the shared parsers
even for a well-formed token it cannot yet know is unknown — Codex r4 P0);
any of them failing answers the identical generic 404, BEFORE
this route's own limiter runs (the house dark-`GATE_*` contract: a probe
never sees a revealing 429). THEN a dedicated 6-per-min limiter keyed by
the shared `/64`-collapsing `unauthenticatedAuthLimitKey` (never the raw
IP), THEN `loadByToken` (additionally selects `s.property_id`) with the
same missing-row/deleted-customer 404, THEN eligibility — the SAME generic
404 again (an ineligible valid token is deliberately indistinguishable from
an unknown one: this route has no 409 for a past, inactive, one-time, or
office-owned visit; the GET already tells a legitimate holder whether
photos can be added) unless the SAME
grouped/ungrouped state the GET computes is `'upcoming'`, the token's
membership is known (not `visitUnknown`), `customers.active === true`, the
visit is recurring-lineage (a one-time visit is out of scope for this lane),
and the visit is not `dispatchOwnedUnreviewed` (the office hasn't reviewed
it yet — same invariant the confirm write enforces; the eligibility RULE
is one function, `visitPrepEligibility`, that both this pre-check and the
late recheck below feed — only the way `state` is READ differs, see below).
The photo CAP is deliberately NOT pre-checked before the body is parsed: it
is decided only under the lock, after dedupe (below), so a retry of an
already-stored submission on a visit that is now full still answers the
idempotent 200 rather than a misleading "limit reached". ONLY THEN does `multer`
(memory storage; 5 MB/file, 3 files, 6 fields, 2 KB field size, 10 parts)
parse the body — a multer size limit is 413, every other multer limit is
400, both customer-safe and generic. Each file's declared mimetype AND its
magic bytes (JPEG/PNG/WebP/HEIC-HEIF `ftyp` box) must agree on
JPEG/PNG/WebP/HEIC/HEIF; HEIC/HEIF goes through `convertHeicToJpeg` first
(converter saturation is a retryable 503 `PREP_CONVERTER_BUSY`, a genuine
conversion failure a 400 `PREP_INVALID_PHOTO`); then EVERY accepted image
is fully decoded and re-encoded as JPEG through `sharp` (25 MP input
ceiling, longest edge bounded to 2560 px, EXIF orientation applied,
metadata dropped) — a payload sharp cannot decode end to end (a truncated
file, header-only bytes) is refused 400 `PREP_INVALID_PHOTO` rather than
stored as something the technician cannot render; an unrecognized `topic`/`locationOnProperty`
is its own code, `PREP_INVALID_FIELD`. Within-request duplicates (the same
photo attached twice in one submission) fold to one candidate before upload.

The write is NEVER trusted to the pre-check alone. `uploadFunnelPhotoToS3`
runs first — storage must succeed for the request to succeed (a failure is
503 `PREP_STORAGE_UNAVAILABLE`, no rows written, any already-uploaded
objects for that request deleted) — and ONLY THEN does the write take the
CANONICAL stop lock (`visit-groups.js`'s `lockStopForRow`, the same
advisory lock every other stop writer takes, retried up to twice on a
concurrent stop move before answering the generic 404) and re-run,
under that lock, on FRESH state: (1) a late recheck, run ENTIRELY on the
write's own transaction connection (never the global pool — a locked
writer already holds a connection plus the stop's advisory lock, and a
second pool checkout from inside that hold is how concurrent uploads
exhaust the pool), and holding ROW locks as well as the advisory lock:
the token row is taken `FOR UPDATE` first, then reloaded with
`loadByToken(token, trx)`, and a grouped visit's live members are read
with `visit-groups.js`'s `openMembers(trx, visit_id, { forUpdate: true })`
(the confirm path's own locked-membership read) — status writers such as
`transitionJobStatus` update `scheduled_services` WITHOUT the advisory
lock, so only the row locks make an en-route tap or a cancellation wait
for this transaction instead of landing between the recheck and the
insert — and judged by the SAME pure rules the page applies
(`membersOneStop`, `groupedState`, `pageState` precedence) — NOT via
`visitServicesFor`, which resolves member labels through other
global-pool services the recheck needs none of — and the result feeds the
same `visitPrepEligibility` rule; refused (the generic 404, nothing
written) if the row is gone, its
customer deleted, it is no longer the row the pre-check saw, or it is no
longer eligible (a status change — en route, cancelled, a grouped sibling
moving the stop's state — landing between the two reads); (2) the dedupe
check itself, by `sha256` of the STORED bytes per `scheduled_service_id` —
run HERE, not before upload, so two concurrent identical submissions can
both upload and the loser is recognized under the lock rather than racing
the unique index; a photo found to already exist is dropped and its
just-uploaded object deleted — an all-duplicate resubmit stores no photo and
answers 200 (idempotent), but any non-empty `note`/`topic`/`locationOnProperty`
it carries is written onto the submission that owns the first duplicate
photo (there is no separate note endpoint, so a corrected note must not be
silently dropped); (3) the real cap re-count (`capReached()` again,
with the actual number of new photos), which a GROUPED visit computes
across every `scheduled_services` row CURRENTLY sharing the stop's
`visit_id` — membership is resolved fresh from `scheduled_services` at
count time, never from the `visit_id` stored on a submission (visit-groups
attaches, detaches and regroups rows without rewriting old submissions, so
that column is a point-in-time record only) — so two members racing to
add photos to the same stop can never together exceed the cap, photos added
before a visit was grouped still count against the stop, and a member moved
out of a stop takes its photos with it — the loser
gets 409 `PREP_CAP_REACHED` (the visit already has 3 submissions, or the new
photos would push it past 6) and its uploaded object is deleted. `property_id`,
`customer_id`, and `visit_id` on the inserted rows come from the RECHECKED
row, never the pre-lock read and never the request body. The response is
`{ ok: true, prepPhotos: { eligible, photoCount, photosRemaining, photosAdded } }`
— 201 when a submission was created, 200 on the idempotent duplicate-only
case (`photosAdded` is the number of NEW photos this request stored, 0 on
that case; the other two counts are stop-wide) —
and NEVER carries a photo URL, an S3 key, the note, or any customer
identity: the token is shared with whoever received the visit text, so
nothing submitted through it is ever shown back. The counts in the
response are computed INSIDE the write transaction — no post-commit read
can turn a durably stored submission into a 500 that invites a retry.
Only the route's OWN
errors (visit-prep.js's `prepError`, marked internally so the route can
tell them apart) are ever echoed to the caller; any other error — a library
error that happens to carry a `statusCode` included — goes to the generic
error handler, never its raw message. On a NEW submission only (never a
duplicate-only resubmit), the route writes ONE admin in-app notification —
a detached, best-effort `NotificationService.notifyAdmin` call written after
the response is sent (never awaited, so a slow or stalled insert cannot hold
the customer's request open), category
`visit_prep_photos`, direct (never through the `notification-triggers.js`
registry, so it never pushes), linking to the customer; the category is on
`notification-bell-policy.js`'s `DEFAULT_ON_CATEGORIES` (rings by default,
owner-silenceable from Settings → Notifications) and a failed insert is
caught and logged, never surfaced to the caller. This is STILL nothing to
the customer or the technician — no SMS, email, native push, or socket
event, to either, ever — and the route still never touches
`scheduled_services.status`, date, window, or technician. Additive on the
existing GET: gate on adds a
top-level `prepPhotos: { eligible, photoCount, photosRemaining }` (the same
shape, computed whether or not the visit is currently eligible, so the
client can render the right empty/full state); gate off, the key is absent
and the GET payload is byte-identical to before this lane. A prepPhotos
lookup failure on GET fails soft — the key is omitted and a warning is
logged, never a 500).
`GET /api/booking/config` (the /book page's public config payload, no token)
gains `van_scene` — the same `GATE_VAN_SCENE` boolean, read by booking step 4
to show the van scene above the secure-card block. Unset gate = `false`
in production (non-production envs return true, as above); no other field
changes. `day_end` carries the stored `booking_config.day_end` (18:00 since
the 2026-09-23 migration; the code fallback is 18:00 too), and the offered
start grid is the shared 09:00–17:00 customer grid with 12:00 present unless
`GATE_BOOKING_LUNCH_BLOCK` is set.
`/api/public/reschedule/:token` (GET + POST, plus `POST /:token/find-slots`;
customer self-serve reschedule linked from appointment
confirmation/72h/24h texts + reminder emails.
`scheduled_services.reschedule_token` (64-hex, `TOKEN_RE` format gate)
is the ONLY gate, plus 60 req/min router limit and 10 req/min on the POST.
GET returns the appointment summary (customer first name, service type,
current date/window, recurring flag, `missed` flag, and — series visits
only — the `reanchorPullForwardDays` threshold) + live open slots from the
/book availability engine (`availability.days[].slots[]` — every slot
carries its own `nearby` boolean, true when its detour is within
`NEARBY_DETOUR_MINUTES`; `days[].nearby` and `availability.nearby` are the
roll-ups. The per-slot flag is shared by every consumer of that engine:
`/api/booking/availability`, this GET, re-service, and the find-slots
searches — added in #3888 so the picker labels each time from its own
route-fit, not the day's). Day lists contain the packed feasible starts (owner ruling 2026-09-23:
on a day with a committed stop, each route gap offers only the hour packed
against its neighbouring stop(s) — the latest start before the next stop and/or
the earliest after the previous one — never a mid-gap hour; an empty day still
lists every grid hour); only the separate recommendations are curated. Moving an existing self-booked visit
excludes that booking from its own day-cap count (the per-day cap runs only
while `GATE_SELF_BOOK_DAY_CAP` is set — retired 2026-09-23). Self-serve notice
windows (owner ruling 2026-09-23, `scheduling/self-serve-notice.js`; split
into a book window and a move window 2026-09-28, `SELF_SERVE_MOVE_NOTICE_HOURS`,
default 24, independent of `SELF_SERVE_NOTICE_HOURS` — no fallback to it):
GET answers `not_reschedulable` with reason `self_serve_notice` for a visit
that itself currently starts within the MOVE window (a MISSED visit is being
rebooked and is exempt); no offered target/destination starts within the
BOOK window (`SELF_SERVE_NOTICE_HOURS`, default 24); and POST refuses such a
visit with 409 code
`SELF_SERVE_NOTICE`. POST is a WRITE with two owner-authorized
scopes (ruling 2026-07-13; single-visit-only before #2725), both limited
to the token's own customer/visit and never live/terminal visits (409),
and only to a slot the availability engine still offers for that day
(route feasibility, the lunch reserve only while `GATE_BOOKING_LUNCH_BLOCK`
is set, the self-serve notice window, and — only while `GATE_SELF_BOOK_DAY_CAP`
is set — self-book day caps re-checked server-side):
  - default: moves the single visit via `SmartRebooker.reschedule`
    (advisory lock + tech-route overlap conflict check + `reschedule_log`
    audit as `customer_self_serve` + escalation flagging);
  - series re-anchor: a genuinely recurring visit (`is_recurring` only —
    booster extras never qualify or move) pulled forward by
    `RESCHEDULE_REANCHOR_PULLFORWARD_DAYS`+ (env, default 14) commits via
    `SmartRebooker.rescheduleSeries` — every later cadence occurrence
    re-anchors to the new date. Consent is explicit: the page swaps the
    "only this visit moves" note for the series-shift warning before
    Confirm (the GET's threshold drives it; the POST decides
    authoritatively). The anchor keeps the offered tech under the same
    advisory-lock overlap guard. With `GATE_CUSTOMER_RECURRING_DISPATCH`
    and the existing `cronJobs`/`autoDispatch` scheduler gates active plus
    effective `AUTO_DISPATCH_MODE=apply` (`AUTO_DISPATCH_ALLOW_APPLY=true`)
    with `AUTO_DISPATCH_MAX_CHANGES_PER_RUN > 0` and
    `AUTO_DISPATCH_REQUIRE_PORTAL_PREFERENCES=false`,
    only the selected appointment must fit: later cadence visits keep their
    projected due dates with NULL time/display windows and a durable
    `recurring_dispatch_due_date`. Future overlap, blackout, and same-plan
    date collisions cannot reject that selection. Auto-dispatch places these
    visits within ±3 calendar days of the due date, honoring preferences;
    initial placement bypasses improvement thresholds, with unresolved
    visits escalated through `schedule_conflict`. Future staff-locked,
    customer-confirmed, reschedule-held, reminder-frozen or committed/grouped visits stay
    unchanged and are flagged for staff review instead of blocking the
    selected appointment. GET/POST add optional `futurePlacementDays: 3`
    for disclosure. Web POST echoes `disclosed_future_placement_days`
    (`3` or `null`); a mismatch with the effective mode returns 409
    `SCOPE_CHANGED` before writing, including a rebooker recheck. Older
    pages omitting it retain legacy behavior only while deferral is off;
    otherwise they refresh and re-disclose. SMS retains its existing
    series policy until it has a placement disclosure. Success copy keeps
    the unchanged-commitment caveat. The confirmation SMS uses the separate
    `appointment_recurring_placement_confirmed` template when the recorded
    operation has deferred placement, including on retries; it states the
    ±3-day placement and unchanged-commitment caveat. Authentication is unchanged. Untimed
    reminder windows are preclosed atomically until placement. Gate off
    preserves legacy conflict checks; already-recorded due dates remain
    dispatchable and bounded. Treat any widening of this
    scope (other customers' rows, live visits, non-cadence rows) as P0.
A pending/confirmed visit whose time already passed is MISSED (rebookable
via the same link — eligibility `missed:true`); terminal/live/no_show
still 409. Generic 404 for bad/unknown tokens.
`POST /:token/find-slots` is the Waves AI date/time search for this page:
model-backed (free-text "when" → date window via `parseWhen`, the same
parser the /book and estimate searches use) and READ-ONLY — it returns
availability in the same shape as the GET and never books or mutates. Same
64-hex token format gate + generic 404, same eligibility guards as the
commit POST (409 for non-reschedulable visits), its own 15 req/min limiter
(mirrors the estimate find-slots budget), and no raw query logging (the
route logs only service id + error message; parse-when logs only failure
messages). The parse window is clamped on BOTH ends to the booking_config
reschedule range (`advance_days_min..advance_days_max`) with no
expandOpenDays, so it can never offer a date or synthetic slot the GET list
and the POST commit revalidation would not themselves offer.
Treat the reschedule token and any change to this route family's payload
or commit path as security-critical).
`/api/public/reservice/:token` (GET + POST, plus `POST /:token/find-slots`;
customer self-serve FREE re-service (callback) scheduler — the standing
customer link texted by the office/comms composer and surfaced on the
portal Visits tab. Whole surface is dark behind GATE_RESERVICE_SELF_SERVE
(fail-closed `==='true'` in every env — anonymous application GET/POST
requests return 404 while off). Prefix-scoped noStore + gate precedes the
global API limiter and body parsers; the router also gates before its local
limits and retains its handler checks. Earlier CORS handling of OPTIONS
and the Staff maintenance interlock (503 for signed Staff requests while
enabled) keep precedence.
`customers.reservice_token` (64-hex, `TOKEN_RE` format gate; standing for
the life of the customer like the /card token) is the ONLY gate, plus
60 req/min router limit, 10 req/min on the commit POST, 15 req/min on
find-slots, and noStore privacy headers (the `/reservice/<token>` SPA
shell carries noindex/no-referrer/no-store via sensitive-spa-headers).
GET returns lane eligibility from LIVE plan state (pest and/or lawn —
active recurring coverage / WaveGuard membership only; rodent-, termite-,
mosquito-, tree-shrub-only and one-time customers get no lane), the
per-lane open-callback dedupe (an existing open re-service answers with
that visit's /reschedule link instead of a second booking), and open
slots from the /book availability engine around the token row's address.
GET accepts optional `lane=pest|lawn`; find-slots accepts the same optional
`lane` body field. Both validate it against currently bookable lanes and
use that lane's duration and technician capability. A single bookable lane
is implicit. With route capacity enabled, multiple bookable lanes require
selection: GET returns eligibility with null availability until selected,
and find-slots returns 400. The page refreshes times and clears the previous
slot when the selected lane changes. With capacity off, requests omitting
lane retain the shared longest-duration browse behavior. A recognized selected
lane that becomes unavailable refreshes eligibility with null availability,
allowing the page to select the remaining lane; malformed lanes still return 400.
POST is a WRITE limited to the token's own customer: lane re-validated,
slot re-validated against a fresh single-day availability build (route
feasibility, the lunch reserve only while `GATE_BOOKING_LUNCH_BLOCK` is set,
the self-serve notice window, day caps only while `GATE_SELF_BOOK_DAY_CAP`
is set — the anti-forgery model
reschedule-public uses in place of the funnel's signed-offer HMAC), then
committed through `createSelfBooking`'s transaction with the
internal-only `callbackVisit` option (is_callback=true — completion
never bills the monthly rate; re-service catalog service_id; card-capture
step + ad attribution skipped; `/booking/confirm` pins the option null
after the body spread). The lane dedupe is re-checked INSIDE the commit
transaction under a customer+lane advisory lock, so parallel commits
cannot double-book a lane's free visit. Because the commit runs through the
SAME `createSelfBooking` transaction, it gets the SAME commit-time capacity
re-check under `GATE_BOOK_CAPACITY_COMMIT` (see the `GATE_SCHEDULING_CAPACITY`
paragraph above) — a tech-bound re-service slot that a later booking made
infeasible refuses with `SLOT_TAKEN` and this route's existing refresh (fresh
availability in the 409 body) instead of committing an infeasible route.
For a customer missing a complete stored latitude/longitude pair, the route
also reads the canonical address-bound staff review under `GATE_GEOCODE_REVIEW`.
A matching permanent `address_review_required` result blocks online scheduling;
the full stored address, including line 2, must match that review. Once a
bookable lane is selected (or implicit), GET keeps its eligibility payload but
returns `availability: null` and `location_review_required: true` instead of
offering times. Search and confirm return HTTP 409
`{ error, code: 'LOCATION_REVIEW_REQUIRED' }` before building availability or
committing. A complete stored pair, a stale/nonblocking review, or the review
gate being off retains the existing pre-check behavior. If the booking
transaction later returns `LOCATION_CHANGED_RETRY` or
`CUSTOMER_CHANGED_RETRY` (including an address or review change after the
pre-check), confirm reloads the token row and maps it to that same 409 recovery
without stale refreshed slots. The page clears its selected slot and availability,
hides time search, and asks the customer to text or call Waves to confirm the
service address. Ordinary `SLOT_TAKEN`/`DAY_FULL` races still refresh times.
find-slots mirrors the
reschedule search: model-backed parseWhen clamped on BOTH ends to the
booking window, READ-ONLY, no raw query logging. Generic 404 for
bad/unknown tokens and while the gate is off. Treat the reservice token,
the lane-eligibility gates, and the $0/is_callback commit contract as
security-critical). Ranking (owner ruling 2026-09-24, GATE_RESERVICE_RANK_AFTER_NEW,
nested inside GATE_RESERVICE_SELF_SERVE): this route's browse/search/commit-
revalidation calls opt `buildBookingAvailability` into `rankProfile:'reservice'`.
With the gate live, a dedicated pure builder (`curateReserviceStrip`, never
the shared funnel's curator) assembles the suggested strip (top-level
`slots`, at most 3 — the picker only ever shows 3) and each day's
`is_best_fit` flag: packed (non-empty-day) candidates fill seats first,
ranked by an adjusted score that favors a tightly packed placement (lower
idle/detour) over one that opens a hole; an empty-tech-day candidate only
fills a seat still open once every packed date is exhausted — it can never
displace one — because an empty day is exactly the room a new customer at
an unproven address needs, so it is never the default re-service
recommendation. A latency guard still guarantees the strip includes the
best-adjusted slot starting within 5 business days when one is feasible (no
re-service SLA is enforced anywhere in code; this is a ranking guard only).
Neither the strip nor `is_best_fit` ever mutates a candidate's underlying
rank or score — both are computed fresh from each candidate's adjusted
score. The FULL per-day slot list (`days[].slots`) is never filtered or
reordered by this — every feasible slot the engine found is still there,
and the commit-time single-day revalidation still accepts exactly what that
list offers. Gate off (default): buildBookingAvailability ignores the
profile and this route's payload is byte-for-byte identical to before this
gate existed. One-tap pest chips (owner-approved, GATE_RESERVICE_PEST_CHIPS,
nested inside GATE_RESERVICE_SELF_SERVE): with the gate live, GET's `base`
payload carries `pestChoices` — `server/services/reservice-request.js`'s
RESERVICE_PEST_CHOICES map, keyed to only the customer's currently bookable
lanes. POST accepts an optional `pests` array (chip keys for the CHOSEN
lane only); `normalizeRequestPests` drops anything invalid or from the
other lane, de-dupes, and caps at that lane's own choice count — an empty
result is treated as no pests. The chosen pests fold into the same
customer-visible `customer_notes` line the details box already produced
(`Re-service request (Ants, Roaches): <details>`, or `Re-service request:
Ants, Roaches` with no details) and are passed into `createSelfBooking`'s
internal-only `callbackVisit.customerRequest = { text, source: 'picker',
pests }` (`scheduled_services.customer_request` / `_source` / `_pests`,
migration `20260927100000`, hasColumn-guarded). Gate off: GET omits
`pestChoices` entirely, POST ignores any posted `pests`, and both the
payload and the existing no-pests `customer_notes` fallbacks are
byte-identical to before this gate existed. The columns themselves are
additive and stamped from the details box regardless of this gate — only
the pest-chip normalization is gated.
`/api/public/inspection/:token` (GET + POST, plus `POST /:token/find-slots`,
`POST /:token/availability`, `POST /:token/waitlist`; the lead-scoped "Book
with Adam" consultation link — booking.js's free Waves Assessment (owner
ruling 2026-09-08: an assessment is NOT a win, `services/assessment-
booking.js`) for a lead, modeled directly on reservice-public's shell and
anti-forgery model but scoped to a LEAD rather than a standing customer
token. Whole surface is dark behind GATE_LEAD_INSPECTION_LINK
(`leadInspectionLinkLive()`, fail-closed `==='true'` in every env — every
route 404s while off). Token: `mintLeadConsultationToken` /
`verifyLeadConsultationToken` (`utils/lead-consultation-token.js`) — a
14-day HMAC namespaced `lead-consultation:` (never interchangeable with the
lead-prefill token) carrying the lead id IN the token
(`<leadId>.<exp>.<sig>`, or `<leadId>.<exp>.<channel>.<sig>` when minted
with an optional signed `channel` claim — the only claim
`leadContactVerified` trusts is the phone-bound `smsChannelFor(lead.phone)`
value (`sms-<digest of the phone's last ten digits>`), which
`buildLeadConsultationLink(id, { channel: 'sms' })` signs from the freshly
loaded lead phone; a bare `'sms'` claim is rejected, and a claim for any
other phone stops counting once the lead's phone changes. Omitted by
default, which is UNVERIFIED delivery), so no DB lookup is needed to resolve
identity. A
well-formed but past-TTL token answers 200 `{ state: 'expired' }` (re-
verified with the TTL check isolated to nowSec=0, which never trips since
`exp` is always minted positive); a malformed/mis-signed token 404s. 60
req/min router limit, 10 req/min on the commit POST, 15 req/min on
find-slots/availability/waitlist, noStore privacy headers, and the SPA
shell (`/inspection/<token>`) carries noindex/no-referrer/no-store via
sensitive-spa-headers. GET returns `{ state, lead: { first_name,
phone_masked, has_address, address_display }, visit?, availability?,
rescheduleUrl?, county?, service_area_unavailable? }`. States: `ok`;
`already_booked` (the lead's linked customer already has an open,
non-terminal Waves Assessment visit — hands back that visit's
`/reschedule/:token` URL via `services/reschedule-link.js`); `converted`
(the lead converted, or already has a future booked NON-assessment visit —
same shape as already_booked); `gone` (lead deleted/missing); `out_of_area`
(a resolved address — commonly the linked customer's own stored one — sits
outside the service area; 200, not an error, since the page still has to
render the out-of-area stop card with the waitlist prompt: `{ state:
'out_of_area', county, lead, waitlist_ticket }`, no `availability` key at
all). Availability
needs coordinates (the linked customer's stored coords, else a geocode of
whichever address is on file); with none resolvable, `availability: null`
and `needs_address: true` — the page asks for an address via `POST
/:token/availability { address }` (not persisted by the availability
call; the commit persists the validated, in-area address onto the customer
in its phase 1 and KEEPS it even if the booking attempt then fails — owner
ruling 2026-09-24, since undoing it raced concurrent bookings that had
already adopted it; a retry with a different address writes that one)
before showing times. GET is routed through the SAME
`finalizeBookingLocation` every other producer of a booking location in
this file uses (resolveServiceAddress wrapped by checkServiceArea) — a
stored address that resolves is never taken as "covered" without also
clearing the area check (Codex pre-push P1, 2026-09-24: GET previously
called resolveServiceAddress directly and could answer `needs_address:
false` with an empty calendar for an out-of-area stored address instead of
stopping the page). When the area check itself can't run (Google key
configured, county lookup returns null/throws), GET stays at `state: 'ok'`
with `lead`, `needs_address: false`, `availability: null`, and
`service_area_unavailable: true` — recoverable, not a verdict either way,
so the page shows a retry message where the calendar would be rather than
an empty one. `POST /:token/find-slots` is the same natural-language search
reservice uses, READ-ONLY, same booking-window clamp on both ends, and
(same P1) is likewise routed through `finalizeBookingLocation` rather than
a raw `resolveServiceAddress` — a directly supplied out-of-area address
422s `{ error: 'out_of_area', county, waitlist_ticket }` or 503s
`{ error: 'service_area_unavailable' }` instead of returning slot
availability for a location that could never survive the commit handler's
own area check. A linked customer's durable `needs_details`, `needs_pin`, or
`outside_area` review quarantines that saved address from automatic geocoding:
GET reports `needs_address: true`, and a commit that tries to reuse the same
saved address answers 422 `{ error: 'address_unresolved' }`. A supplied address
that is affirmatively a different property can still proceed through the usual
validation and area checks. `resolveServiceAddress` has no callers anywhere in this file outside
`finalizeBookingLocation`'s own body, and `checkServiceArea` has none outside
`serviceAreaFailure` — reached from `finalizeBookingLocation` and from the
commit route's own recheck of a verified lead's adopted property (the one
location not produced by `finalizeBookingLocation`), never a bare
`checkServiceArea` call. A structural test on the route file's source
enforces both. `POST
/:token` commit:
body `{ date, time, address?, notes? }`; idempotent — a lead whose customer
already holds an open assessment short-circuits to the SAME `already_booked`
shape (200, before geocoding or creating anything) instead of a second
visit. Address required only when neither the lead nor its (existing)
customer has one on file (`resolveServiceAddress`: stored address wins only
when it actually geocodes — never merely by being present — else a
supplied one is tried), parsed with `parseRawAddress` and geocoded with
street-level quality filtering but `requireInServiceArea:false` (the box
alone is never grounds to discard a geocode as unresolvable); checked
against the service area via `checkServiceArea`, applied uniformly to every
resolved location including a customer's stored coordinates: county via
`services/address-validation`'s `reverseGeocodeCounty` when a Google key is
configured (a null county is NOT permission — 503
`{ error: 'service_area_unavailable' }`, recoverable; a DeSoto county is out,
DeSoto is not served per the 2026-09-30 owner ruling), else the explicit
no-key fallback: outside the coarse box is out; inside the DeSoto exclusion
rectangle (`DESOTO_EXCLUSION`) the point is out unless the address's own ZIP
is a served ZIP (`isInServiceAreaBox(lat, lng, { zip })`, which holds no
DeSoto ZIP); elsewhere in the box is in. Out of area 422s
`{ error: 'out_of_area', county, waitlist_ticket }` and books nothing; an unresolvable
address 422s `{ error: 'address_unresolved' }`, distinct and recoverable.
The slot is re-validated against a fresh single-day
availability build (same anti-forgery model as reservice-public) before
committing through `createSelfBooking`'s `callbackVisit` option with
`isCallback: false` and `dedupeLane` left at its default (on). booking.js
skips the funnel's signed-offer/card-capture/ad-attribution/customer-promotion
machinery like a re-service callback, without setting `is_callback`. The lane
dedupe runs on a dedicated `assessment` lane (`laneForCallbackRow` in
`services/reservice-scheduler.js` classifies `lawn_inspection` before the
pest/lawn cases): the check and the insert share one transaction under
`pg_advisory_xact_lock(['reservice-lane', customerId:assessment])`, so two
concurrent commits at different slots can never both book, and an unrelated
open pest/lawn re-service never false-hits. A duplicate returns the same
`already_booked` shape GET does. The lead gets
(or keeps) a customer row and is linked (`leads.customer_id`) but nothing
else on the lead changes — status/pipeline_stage/converted_at/member_since
all stay untouched (`promoteCustomerOnBooking`'s own
`isAssessmentServiceType` guard, matching `admin-leads.js`'s identical
assessment posture). A lead that is ALREADY linked to a customer
(`leads.customer_id`) is trusted only when the link is proven
(`loadTrustedCustomer`): the lead's contact is verified (below) AND the
linked customer's phone is the lead's own — `customer_id` alone is never
proof, since public-quote.js links quote leads to existing customers from
unverified submitted contact info. An unproven link is treated as no link:
none of that customer's address, visits or reschedule links are returned,
and a booking goes onto a separate prospect while the existing link is left
untouched. An unlinked lead whose phone matches an existing
customer (`leadContactVerified`) only reuses that customer when the phone
is independently corroborated and still the lead's CURRENT phone — an
inbound-call lead whose phone equals its originating `call_log.from_phone`,
or an SMS-delivered token whose signed `channel` claim is `smsChannelFor`
of this exact phone — never a bare public-form
submission; otherwise it always gets its own separate prospect profile and
never sees another customer's visit data, reschedule URL, or booking
(Codex pre-push P1, 2026-09-24). The free-text note rides
`scheduled_services.internal_notes` (never `notes`, which is customer/tech
visible) via a best-effort post-commit update. `SLOT_TAKEN` 409 mirrors
reservice-public's shape (fresh `availability` attached). Office alert:
`createSelfBooking`'s internal Twilio alert with `alertLabel` swapped to
"🔁 Free consultation self-booked:" — no customer comms beyond
`createSelfBooking`'s own standard confirmation. `POST /:token/waitlist`
(the out-of-area stop's one-field ask): body `{ email, waitlist_ticket }`.
`waitlist_ticket` is the short-lived (1h) HMAC ticket minted ONLY with a
server-verified out-of-area answer (GET `out_of_area`, or the
`/availability`, `/find-slots` and commit 422s above), binding this lead
and the region the server found; a caller-supplied `county` is ignored.
No/invalid/expired ticket, another lead's ticket, or a lead no longer
eligible (closed, converted, already booked) → the generic 404 and nothing
is written. With a valid ticket it inserts
(idempotent on email, `onConflict('email').ignore()`) a
`newsletter_subscribers` row tagged `expansion_waitlist:<county>` at status
`waitlist` (deliberately not `active` — buildSubscriberQuery selects
status='active' with no source exclusion, so an active row would enrol in
ordinary newsletter sends and this token never proved ownership of the
typed email; deliberately not `pending` either — that status has its own
live double-opt-in meaning elsewhere, incl. a future admin CSV import
queuing it a real confirmation email); no email sent. Generic 404 for
bad/unknown tokens and while the gate is off. Treat the lead-consultation
token, the assessment-not-a-win invariant, and the out-of-area/no-booking
contract as security-critical).
`/api/reviews/featured` (read-only public featured Google reviews for the
marketing site — no auth, no token, location filter + limit; reads
`google_reviews` only).
`/api/review/:token` (GET + POST; token-gated customer review flow — GET
returns the review-request context by token. POST is RETIRED (owner ruling
2026-09-29, the 1-10 rating is gone): it answers 410 Gone with no DB access
(it used to be an unauthenticated rating write that stamped the click fields and
fired a referral invite). No auth beyond the review-request token. Baseline guards
(`server/routes/review-public.js`): `REVIEW_TOKEN_RE` format gate (the
shape `services/review-request.js` mints — 32-64 url-safe chars) via
`router.param` before any DB read, one generic 404 body for malformed,
unknown, and expired tokens on GET, a router-wide 30 req/min limiter
on the shared IPv6-safe `rateLimitKey`, and the shared `noStore` privacy
headers (`no-store`, `noindex`, `no-referrer`) on every response. The GET
stamps open state and returns customer name data, so those guards are the
whole defense.)
`/api/rate/:token` (+ `/:token/go`) (review-gate; token-scoped thank-you
page from a review-request link. The 1-10 rating, its feedback form and the AI
review writer are retired (owner ruling 2026-09-29): the page GET returns
`reviewUrl` — ALWAYS the tracked `/api/rate/:token/go` link (whatever
GATE_REVIEW_DIRECT_LINK says), null for a customer already
marked as a reviewer — and the page shows one "Open Google" button; going to
Google is always the customer's own click. `POST /:token/score`, `/:token/submit`
and `/:token/generate-review` no longer exist (404). Finalized (legacy-rated)
requests answer `alreadySubmitted` with no button. Router-wide url-safe
32-64 token param gate (generic 404; malformed tokens on `/go` degrade to
the /rate page per its every-failure-lands-somewhere contract); the page
GET carries a 30/min limiter. `/:token/go` is the
tracked redirect (ALWAYS live, not gate-dependent; GATE_REVIEW_DIRECT_LINK now only decides whether ask texts and emails link here or to the /rate thank-you page): the same 32–64 URL-safe token format gate, 30
req/min per-IP limit, stamps open/click on the review_requests row, stops
EVERY later review-ask path for the customer in one click (`ReviewService.stopFutureAsks`: the clicked request's cadence and any active/deferred cadence, a cadence parked for visit-summary recovery, queued one-off asks, due Day-3 follow-ups; run best-effort under the per-customer `review-send:<customerId>` lock with a bounded ~2 s wait; the stamp/claim lands first and every review sender re-checks `redirected_at` at SEND time (`services/review-click-guard.js`), so the customer is never kept from Google: `/go` always 302s once the click is recorded. A send already past its guard when the click lands may still deliver that one in-flight text), fire-and-forgets the referral invite
email on the FIRST tracked click only (`sendReferralInviteEmail`, trigger
`google_review_click`, once per customer; owner ruling 2026-09-29; never
delays or breaks the redirect; bot fetches, expired, finalized and
already-reviewed requests send nothing), and 302s to the location's GBP review
URL — every failure path degrades to the /rate page, and the ONLY redirect
targets are config/locations.js googleReviewUrl values (never
request-derived). ONE deliberate non-failure carve-out (owner ruling,
2026-08-07 review audit): an EXPIRED but otherwise-valid, non-finalized
token still 302s to the GBP review URL while recording NOTHING — a willing
reviewer tapping an old text is not a failure case; finalized asks and
already-reviewed customers still degrade to /rate. No auth beyond the review-request token; picks nearest GBP
by geocoded address. The bare `/api/rate` mount is not itself a route — only
the token-scoped family is public).
`/api/reports/project/:token/fdacs-pdf` (read-only; streams the filled, signed
FDACS-13645 PDF for a WDO report so the public report page can show the official
form instead of a blank template. Same long-lived report token + format gate as
the sibling `/api/reports/project/:token/data` viewer
(`extractProjectReportTokenLookup`), inherits the router-level 20 req/min
`reportLimiter`, `no-store`/`noindex`/`no-referrer` privacy headers. Serves ONLY
the already-emailed archived filing streamed from private S3 — never
live/unsigned content — and returns a generic 404 for non-WDO projects, reports
with no archived filing, or malformed tokens).
`/api/reports/project/:token/ask` (POST; Waves AI on project reports — owner
ruling 2026-07-16. Deterministic keyword-routed template answers built ONLY
from the project's own findings/recommendations/follow-up — data the sibling
`/data` viewer already serves this token; internal finding keys
(`inspection_fee` class) are excluded server-side; no LLM, so nothing new can
leak or be injected. Same long-lived report token + format gate as the
`/data` viewer (`extractProjectReportTokenLookup`), inherits the router-level
20 req/min `reportLimiter`, question length capped at 500 chars. The WDO
payment hold 402s BEFORE any content-derived answer; the paper compliance
documents (wdo_inspection, pre_treatment_termite_certificate) return a
generic 404 — their pages never mount the ask bar. Only write: an
`activity_log` analytics row recording question length, never answer
content. Optional body field `intent` — one of `findings` / `treatment` /
`recommendations` / `next_visit`, sent by the shipped prompt chips — selects
that answer directly; any other value is ignored and the question is
keyword-routed as before, so older clients are unaffected. The service-report
`/api/reports/:token/ask` (deterministic `report-assistant.js` answers, no
LLM) writes one `service_report_events` row, `report_question_asked`, with
metadata `{ question_length, topic }` — never the question text or the answer
(owner ruling 2026-09-28: topic only). `topic` is the answer family the
question was routed to, one of `REPORT_QUESTION_TOPICS` (`reentry`, `watering`,
`findings`, `next_steps`, `next_visit`, `applied`, `results`, `summary`,
`unrouted`); the response body is unchanged. Only this route writes that
event: the public `POST /api/reports/:token/events` refuses
`report_question_asked` with the same 400 as an unknown event, so a token
holder cannot add question rows the engagement tools would count. A staff
reader's question (the report page sends the portal JWT, verified exactly like
the `/data` staff read) is answered the same way but writes no row. This route and the
service-report `/api/reports/:token/ask` both answer with
`Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow` on every
response, including CORS preflights, the global `/api` limiter's 429 and
body-parser errors — the middleware is mounted app-level ahead of all
response-producing middleware (`server/index.js`) and again inside the router
ahead of the `:token` param gate and limiter).
`/api/webhooks/voice-agent/lead` (POST; machine-to-machine webhook — the
bilingual AI voice agent (ElevenLabs) posts a captured lead when an AI-handled
call ends. NOT browser-facing. Fail-closed shared-secret auth in the route
(`voiceAgentAuth`): 403 unless `GATE_VOICE_AI_AGENT` is on, 503 unless
`VOICE_AGENT_WEBHOOK_SECRET` is set, 401 on a constant-time token mismatch —
so the endpoint is inert until the feature is explicitly enabled. Accepts PII
(caller name/phone/address); rejects non-E.164 caller IDs before any lead
create/merge and writes via `createLeadFromExtraction` into the existing lead
pipeline. Any change to this route or its payload is security-critical).
`/ws/voice-agent` (WebSocket upgrade; machine-to-machine — Twilio
ConversationRelay connects here for an AI-handled call and exchanges JSON
text frames with the Claude tool-use loop, which can spend Anthropic tokens
and write leads. NOT browser-facing. Fail-closed in two layers: (1) the ws
server only ATTACHES when `VOICE_RELAY_ENABLED=true` AND `ANTHROPIC_API_KEY`
AND `VOICE_RELAY_WS_SECRET` are all set — otherwise the endpoint does not
exist; (2) every upgrade is rejected (socket destroyed before handshake)
unless it carries a PER-CALL TOKEN — `?callSid=<sid>&t=v1.<exp>.<hmac>`, an
HMAC-SHA256 over that CallSid keyed by `VOICE_RELAY_WS_SECRET`, verified with a
constant-time compare, valid ~5 minutes, and accepted ONCE — the burn is an
`INSERT … ON CONFLICT DO NOTHING` on `voice_relay_token_burns` (hashed token),
i.e. SHARED storage, because a per-process claim is no claim at all here: a
second instance or a restart would take the replay. It fails closed, and the
CallSid the token authenticated is carried onto the socket — the setup frame
that follows is unverified input and may not rename the session (a mismatch
terminates it), or a token for call A would authenticate a session claiming
call B. **The raw secret is never put in a URL and is never accepted as a
credential** — it stays server-side (Railway env, and the Twilio Function env
that renders the sandbox TwiML), because a URL param is exactly what leaks:
Twilio logs request URLs, and a reusable key in one would let anyone who saw it
open unlimited synthetic sessions, spend Anthropic tokens and write leads with
no call behind them. Anything that renders this TwiML MUST mint the token
(`relay-protocol.mintCallToken` / `buildRelayTwiML({ callSid })`); a render
without a CallSid produces a URL the server refuses.
Caller PII is masked in logs; lead writes require a valid E.164
caller number (`capture_lead` tool + the capture-floor on session close).
The live `/voice` backstop only routes a call here when the relay actually
attached (`isRelayAttached`) AND the configured endpoint's scheme/host/path are
trusted (`wss://` + this portal's own origin from `PUBLIC_PORTAL_URL` + the
exact `/ws/voice-agent` path; `ws://localhost` for dev) — so the WS secret is
never appended to a foreign host. Caller RECOGNITION on this endpoint is a
third, independent layer: the WS setup frame's `from` is unverified input and
is cross-checked against the signature-verified `/voice` webhook's `call_log`
row before any account read, and `VOICE_RELAY_REQUIRE_ATTESTATION=true`
additionally demands STIR/SHAKEN attestation A — the carrier vouching that the
caller owns the number — before the caller is recognised at all. That switch
ships OFF: most genuine calls carry no attestation, so turning it on trades
spoofing resistance for treating real customers as strangers, and the
attestation is logged on every call so the distribution can be measured first.
**The SPLIT TIER (owner ruling 2026-08-12) is the default that does not wait
for that measurement**: an ANI match alone still recognises the caller and
answers the receptionist questions (who they are, appointments, today's ETA,
open estimates, visit dates and service names), but the reads a spoofed caller
ID would pay for — `get_invoice_history` (amounts), `get_message_history` and
`get_call_history` (the bodies of texts and calls), `get_service_report`
(what a technician found inside the home) — require attestation A, as do the
balance FIGURE (in the KNOWN CALLER block AND `get_account_overview` — the
amount is not even FETCHED unattested), the visit SUMMARY lines in
`get_service_history` (report detail through another door), and the session's
recent-texts block (not fetched at all without it). Enforced in
`relay-tools.ATTESTATION_ONLY_TOOLS` BEFORE the tool runs, so a new sensitive
tool cannot be added without deciding which side of the line it is on; fails
closed on a missing flag. When gating a read, gate EVERY reader of the same
loader — the balance figure and the report summaries each turned out to have a
second door.
Recognition is additionally bound to a freshness window on that call_log row
and to ONE session per CallSid — burned atomically as a metadata key on the
row itself (`relay_session_claimed_at`), so the claim holds across instances
and restarts and a historical (CallSid, from) pair cannot be replayed by
anyone holding the key. WRITES for a caller the ANI did
not fully authenticate — a looked-up account, or a number that matched only a
service-contact slot — are gated separately again by
`VOICE_RELAY_ALLOW_THIRD_PARTY_WRITES` (default OFF: full ANI match or no
booking and no re-service ticket).
Any change to this endpoint, its auth, or its frame handling is
security-critical).
`/api/webhooks/twilio/relay-sandbox` + `/api/webhooks/twilio/relay-sandbox/cell`
(POST; machine-to-machine TwiML webhooks — the voice URL and the in-call
`<Gather>` action of the dead GA# SANDBOX number, the only test path for the
AI receptionist. Twilio-signature validated at the `/api/webhooks/twilio`
mount like every Twilio inbound route, and additionally fail-closed to a 403
`<Hangup/>` unless the posted `To` is exactly `VOICE_RELAY_SANDBOX_NUMBER`
(unset ⇒ every request refused) and a `CallSid` is present; relay not
attached ⇒ a spoken notice and hangup. The first hit inserts a `call_log`
row for the CallSid (`direction` inbound, `source` 'voice_relay_sandbox')
under the same per-CallSid advisory lock `/voice` and `/call-status` take;
a generic `/call-status` fallback row that won the race (`source` NULL) is
adopted — sandbox source, customer link cleared — and any row with a foreign
non-null source is refused (403 hangup). `/call-status` itself writes the
sandbox-sourced row, with no customer link or touchpoint, when it sees the
sandbox number first. The handler then renders a 3-second two-digit DTMF
`<Gather>` (a relay-profile cell code, `relay-profiles.SANDBOX_CELLS`;
'99' = the raw env attributes; no digits ⇒ the production profile) followed
by the same `<Connect><ConversationRelay>` + per-call minted token that
`/voice` renders — the WS secret never leaves the server. Payload: standard
Twilio voice-webhook form fields (`CallSid`, `From`, `To`, `CallStatus`,
`Digits` on the cell action). The session that answers is a DRY RUN: the ws
upgrade proves the sandbox source from the call_log row and the relay answers
`capture_lead` / `request_reservice` / `request_booking` without running them,
its hangup capture floor stays down, and every call reader (Calls tab,
unified inbox, dashboard KPIs, corpus/research/insights miners, self-audit,
the relay's own call history) drops the source through
`relay-protocol.whereNotSandboxCall` — so a test call, or a stranger dialling
the test number, can neither create dispatch work nor move a metric. The
transcript, latency summary and version stamps land on the sandbox row
exactly as in production; that record is the bake-off. Any change to the
number gate or the dry-run invariant is security-critical).
`/api/webhooks/twilio/relay-complete` (POST; machine-to-machine TwiML
webhook — the `<Connect><ConversationRelay>` action Twilio calls when the
AI receptionist's relay leg ends. Twilio-signature validated at the
`/api/webhooks/twilio` mount like every Twilio inbound route. Payload:
standard Twilio voice-webhook form fields (`CallSid`, `SessionStatus`,
`ErrorCode`) plus `HandoffData` — the JSON string the relay's OWN end frame
set (absent on a caller hang-up or a session failure), which the handler
parses tolerantly and trusts for nothing beyond `reason`. Pre-PR-2A
behaviour is unchanged: a failed session ⇒ voicemail (sandbox: a
`relay_failed` stamp + hangup), otherwise a bare `<Response/>`. **Sandy PR
2A adds `reason: 'transfer'`** (`GATE_VOICE_RELAY_TRANSFER` exactly 'true'
— the gate lives at the `transfer_to_office` tool that emits the frame; the
frame itself only exists when the tool ran, and only the server's own
socket can send one): the handler claims ONE staff ring per CallSid
atomically on the call_log row (`metadata.relay_transfer_ring_at`, stamped
with `call_outcome = 'ai_transferred'` when the row is not already
terminal) under a 1.5s deadline, OWNER-BOUND to the frame's
`owner` (the socket's `relay_session_claim_owner` nonce; a superseded
socket's frame matches 0 rows), and renders the same staff simul-ring
`<Dial>` the live `/voice` backstop renders — identical screen / accept
URLs, no summary, no id and no query string on any URL: the ≤20-word staff
whisper is read from the persisted packet (`metadata.relay_handoff`) after
press-1 only. A Twilio retry (ring already claimed ⇒ 0 rows) gets a bare
response, never a second ring; an unconfirmed claim (timeout / error) and
a call with no staff forward numbers are stamped `voicemail` (bounded,
best-effort) and get the voicemail recorder; `?sandbox=1` (the signed
query the sandbox route rendered) hangs up — a test call never rings
staff. The caller's own text is never in the URL or the TwiML. **Sandy PR
2B adds session recovery** (`GATE_VOICE_RELAY_RECOVERY` exactly 'true',
read at call time; off ⇒ the failed branch is byte-identical to the above):
a FAILED session (`ErrorCode` / failed status) is reconnected ONCE — one
bounded, fenced UPDATE claims the reconnect on the call_log row
(`metadata.relay_reconnects` 0 → 1 + `relay_reconnect_ms`, outcome back to
NULL / status in-progress; a voicemail / transferred / relay_failed row is
never resumed; an unconfirmed claim never re-renders, a late-landing one is
put back) and the handler renders the same `<Connect><ConversationRelay>`
the call started with (an explicit untuned stamp stays untuned); production
reconnect rendering rechecks `voiceAiAgent` and the recovery gate after async
lookups. It retains the same action incl. `?lang=es` / `?sandbox=1`, plus
`gen=<the row's relay_reconnect_ms>` so the resumed leg's own failure is
told apart from a Twilio retry of the first leg's — a retry on a row that
already reconnected gets a bare `<Response/>` and never ends the healthy
session; a resumed welcome greeting, `<Parameter resumed="1">`, a token
minted AFTER the stamp so the new socket's generation is ≥ the fence. The session
treats `resumed` as a hint and re-proves it from the row before seeding the
earlier turns or skipping its capture floor. Close-time segment storage may
also use the server-verified, burned call token to retain that socket's own
text on an unclaimed row or after reconnect; this proof never grants account
access or prior-dialogue hydration. Captured lead ids persist in the segment
as a fallback when the call linkage stamp did not land. A second failure: office open
AND `GATE_VOICE_RELAY_TRANSFER` ⇒ the staff ring above (owner-bound to the
row's current claim owner, generic whisper); otherwise today's voicemail.
With recovery enabled, an unconfirmed reconnect claim/state read returns
503 with no fallback instructions. Voicemail, sandbox failure, and staff-ring
claims are fenced to the proven reconnect generation; voicemail/failure
writes also atomically refuse rows with a claimed staff ring or transferred
outcome, even if the replacement socket never acquired a session claim.
The ring claim stamps a server-generated `relay_transfer_ring_claim` id;
compensation matches that id plus the generation and owner fences, so its
own late claim can fall back to voicemail without changing another ring; a predicate that loses
to a newer reconnect returns a bare response instead of stale fallback TwiML.
Any change to the claim, the owner fence, the reconnect fence, the sandbox
branch or what the whisper may speak is security-critical).
`/api/public/secure-card/:token` (+ `/:token/complete`, `/:token/select-plan`, `/:token/replace-intent`) (GET + POST;
"secure your appointment" card-on-file capture page for the
appointment-card-request funnel — ALSO serves the standalone "set up
Auto Pay" link (`appointment_card_requests.kind='customer'`, dark behind
`GATE_AUTOPAY_SETUP_LINK`, operator-minted only from the Customers page):
same token/format/header/limiter contract; the GET payload carries
`kind:'customer'`, no visit/fee/plan fields, `paymentMethodTypes`
(card_or_bank with INSTANT bank verification only, card-only under an
unhealthy `customers.ach_status`), and renders `closed` once
`expires_at` (30 days) passes, the customer is archived or becomes
payer-billed, or Auto Pay is already active (the pending row is RETIRED to
`expired` so every later GET stays closed — never healed to satisfied); a
`completed` row renders `secured` only while the enrollment is still live
and chargeable; the POST runs the same
live-verify (purpose `autopay_setup_link` + request id) and the same
save → consent → enroll tail under the same claim/lease; `select-plan`
is not applicable to these rows. RENDERED CONSENT VERSION (2026-09-30, codex
#5434 r1 P1, both kinds): the GET mints the SetupIntent for the page it
serves, so the GET carries `?consentTextVersion=` — the `CONSENT_VERSION`
the bundle renders beside the capture checkbox — and is refused with
`409 { error, code: 'CONSENT_VERSION_STALE' }` before any mint when that is
not the server's current version or is absent (an older bundle refetching
after a copy change); the mint stamps that attested value into the intent
(`metadata.consent_text_version`) and salts the deterministic idempotency
key with it, so a page load after a copy change mints a fresh intent under
the new text instead of replaying one stamped with the old, and a stored
intent stamped with an older version is never replayed. `/replace-intent`
("use a different payment method", a fresh mint) carries the same
attestation in its body under the same refusal. `/complete` carries
`consentTextVersion` too and is refused the same way before the capture
service runs; and the shared completion tail — page POST and the
`setup_intent.succeeded` backstop alike — re-reads the intent under its
claim and refuses an intent whose stamp is stale or absent
(`consent_version_stale`: nothing saved, recorded or enrolled, the claim
reverts so the row stays pending, one Billing bell per intent for the office
to re-collect; the route answers the same 409, the webhook acks). The page
prompts a refresh, which re-mints under the current text. The visit lane below is unchanged — dark until `APPOINTMENT_CARD_REQUEST`
AND the `secure_appointment_card` SMS template are both enabled, and
unreachable until the funnel mints links. Bearer token
(`appointment_card_requests.token` — 22-char base64url / 128-bit since
2026-08-12 so the SMS link fits 2 GSM segments; legacy 64-hex rows stay
accepted) with format gate + generic 404 (no existence oracle); its own 60 req/min limiter on top of the global /api
limiter; `private, no-store` / `Referrer-Policy: no-referrer` /
`X-Robots-Tag: noindex` on EVERY outcome including 404s (the SPA shell
for `/secure/:token` carries the same headers via
`sensitive-spa-headers.js`). NO money moves on this surface — the GET
mints/replays a card-only off-session SetupIntent (request-pinned
metadata, deterministic idempotency key) after re-checking visit
liveness AND payer exemption; the POST live-verifies the SetupIntent
against Stripe (status + purpose + request id — never the client's
word), re-checks visit/payer again, and runs the idempotent
save → consent → enroll sequence under a pending → completing claim
with a 10-min stale-claim lease (page POST and the
`setup_intent.succeeded` webhook backstop are mutually exclusive;
failures revert and stay retryable). `/:token/select-plan` (POST, dark
behind `GATE_SECURE_PLAN_CHOICE` — 404 while off) records the pay-per-
application vs. annual-prepay choice: the client sends ONLY `{ plan }`
and every amount is re-derived server-side from the booked series. A
prepay selection MINTS a payable draft annual-prepay invoice +
payment_pending term (still no charge on this surface — payment happens
on the invoice's own `/pay/:token` page) inside one transaction with the
per-customer advisory overlap lock, an in-transaction FOR UPDATE
visit+customer revalidation and trx-scoped payer re-resolve, and the
request row as the idempotency anchor (double-submit returns the same
pay link; terminal invoices release the anchor). A recurring
plan-bearing request REFUSES `/complete` until a durable
`per_application` selection exists, and the completion claim is
plan-value-guarded so a selection switch cannot cross a capture
mid-flight. `/:token/replace-intent` (POST `{ setupIntentId }`, both row
kinds; "use a different payment method" after a capture already
SUCCEEDED, 2026-09-08 — same design as the estimate accept's
`replaceSetupIntentId`): the deterministic mint replays a succeeded
SetupIntent on every reopen and Stripe will not cancel it, so the GET
renders a succeeded replay as a saved-method panel (`capturedMethodType`
set from the live payment method; `paymentMethodTypes` alongside) with
"Use a different payment method". The named intent must be THIS
request's own capture (purpose + request id; foreign or unknown id →
400). The replacement is minted FIRST (key salted by the retired id —
no generation consumed; the standalone lane mints under the CURRENT
tender policy), then the succeeded intent is stamped
`metadata.retired='true'` + `replaced_by=<new id>` in Stripe, then the
row is re-pointed; a mint or stamp failure leaves the saved method
untouched (503). Everything runs under the request ROW LOCK (`FOR
UPDATE`), which is how it serializes with completion: the completion
claim (pending → completing) waits behind it and the tail re-reads the
intent LIVE under its claim — a retired capture is refused there (claim
reverted, nothing saved or enrolled; an unreadable one stays
retryable), on the page POST AND on the `setup_intent.succeeded` webhook
backstop (which trusts its event payload — the intent as it succeeded).
A non-pending / expired row under the lock retires nothing (409
`request_closed`), and neither does a link the GET would render closed —
the visit lane re-runs the completion predicate (visit live, not past,
priced > 0, no third-party payer) and the plan gate (a plan-bearing
recurring request needs a durable `per_application` selection — the plan
mode is derived before the lock through the THROWING derivation (an
unknown mode is 503, never "not recurring"), the selection read from the
locked row; 409 `plan_required`, the client re-renders the choice) and the standalone lane the GET's
closure checks (archived customer, payer-billed, unsupported billing
lane, Auto Pay paused, Auto Pay already active — which retires the row as
the GET does),
all under the lock BEFORE any Stripe state changes (409
`no_longer_needed`; a lookup failure — the Auto-Pay-active probe runs
fail-closed on the locked handle — is 503, never a retirement on an
unknown answer). The client refetches on either 409. The GET's row
repoint is a compare-and-set on the pointer that load observed: a
replacement committing mid-load cannot be overwritten with the retired
id — the load follows the row to the replacement instead, adopts the
intent when a concurrent first load stored the same one, or renders
`unavailable` if the row moved on; the standalone lane's generation
mint uses the same observed-pointer CAS and follows a replacement
pointer on a miss. Every nested read under the
replacement lock (visit, payer, tender, customer, Auto Pay probe, and
the Stripe-customer link-up inside the mint) rides the transaction
handle — one pool connection per request. An unfinished or already-
retired id has nothing to retire and returns the ordinary mint under the
same lock. Every minted/replayed intent is re-read LIVE before it is
judged (an idempotent replay returns the ORIGINAL create body, never a
later success or retirement stamp); a retired replay follows
`replaced_by` to the live head, refusing a chain that leaves the
request's own capture family, and a broken/canceled chain walks the
generation salt as before. Treat the token, the verification
gates, the selection/mint transaction, the replacement lock, and the
claim mechanics as security-critical.
**Appointment-card enforcement rails (2026-08-01, both dark, fail-closed
`feature-gates.js` money gates):** the /secure page RENDER stamps the
disclosed terms onto the pending request row (`no_show_fee_amount` /
`cancel_window_hours` + `accepted_amount`, the completion-charge cap —
last disclosure shown wins, fee-off renders clear the stamp), and the
completion tail only records consent (`fee_agreed_at`) against those
stamped values — it NEVER re-reads live config, so a config/price change
between render and consent cannot move an agreed fee or widen the cap
(Codex #3153 r1). The stamp is LOAD-BEARING: a failed/zero-row stamp
renders `unavailable` instead of the card form (an earlier render's
higher terms must never sit chargeable behind a lower disclosure), and
the fee rail refuses any row without a recorded `fee_agreed_at` +
positive frozen window (`no_fee_consent`). `accepted_amount` stamps
ONLY when the page DISPLAYED the price (planContext present — r2): with
`GATE_SECURE_PLAN_CHOICE` off no number renders, so page-secured rows
stay uncharged (completion routes to review) until that gate is on —
flip order matters. The stamp is MONOTONIC-DOWN with sticky sentinels
(r3): completion cannot know which open tab's render was consented
from, so a re-render may LOWER the frozen fee/cap (SQL LEAST, atomic)
but never raise it, and a render that disclosed no fee
(`cancel_window_hours = 0` sentinel) or no price (`accepted_amount = 0`
sentinel) pins the row unchargeable permanently — enforced terms are ≤
every disclosure ever shown on the link. The /secure page and the
enrollment email state the EXACT window hours being frozen (a fee under
an undisclosed cutoff is not consented); the SMS keeps the short
"last-minute" clause (segment budget — the page is the consent
surface). Fee-state machine is terminal-everything: a timely
free cancel persists `fee_status='released'` BEFORE reporting release
(cancellation retries re-run side effects — an unpersisted free cancel
must never become chargeable later), and BOTH races (lost charge claim,
lost free-release stamp) report the canonical NON-released
`charge_review`, never a clean outcome. Fee terms live on COMPLETED rows only; a `satisfied`
auto-secured row never saw the disclosure and is NEVER fee-charged (it
does get `accepted_amount`, frozen at auto-secure time); rows from
before the fee-terms migrations stay unchargeable. (1)
`GATE_APPT_CARD_NO_SHOW_FEE` — `chargeAppointmentNoShowFee` /
`handleAppointmentCardCancellation` in `appointment-card-request.js`
mirror the card-hold fee rail posture-for-posture (staleness guards +
shared exported constants, `fee_status` NULL→charging atomic claim,
ambiguous-outcome parking to `charge_review`, face-value
surcharge-exempt `chargeSavedPaymentMethodOffSession`, PI purpose
`appointment_card_no_show_fee`, webhook-settled as a paid refundable
taxRate-0 self-pay invoice via `settleAppointmentNoShowFee` + the shared
`sendNoShowFeeReceipt`). Runs ONLY as the no-hold fallback at the
existing card-hold call sites (dispatch no_show/cancel, schedule bulk/V2
cancel, cancellation-processor, offboarding waive — which gates the
deposit refund on a clean waive) — an `estimate_card_holds` row of ANY
status makes the rail skip (`card_hold_lane`), and that lookup FAILS
CLOSED: a lookup error or an in-flight `charging`/`charge_review`
fee_status returns a NON-released canonical `charge_review` from the
cancellation handler (never "released", never treated as absence). The
rail also RE-RESOLVES the payer both in eligibility AND at the claim
boundary (r6+r8): a third-party payer assigned after the card was
secured exempts the homeowner (`payer_billed` — a post-claim payer hit
closes the fee event terminally as 'released'), a payer lookup error is
unresolved / reverts the claim (fail closed), and unresolved fee states
are checked BEFORE the payer exemption so an in-flight charge can never
be reported as a clean payer release. The completion charge's frozen
cap (`maxAuthorizedSubtotal`) is enforced inside
`chargeInvoiceWithSavedCard` against the LOCKED invoice and BEFORE any
account-credit application — the fully-covered-by-credit early return
must never consume credit above consent — and the dispatch route's OWN
credit auto-apply is fenced off over-cap appointment-lane invoices AND
off UNVERIFIABLE lanes (lookup error — r9/r10: review must see the bill
exactly as minted, full coverage must not flip it prepaid past a
never-evaluated cap, and an error must not bypass the fence). The
cancel preview surfaces an unverifiable lane as fee-may-apply
(`unresolved: true`, never a silent "no fee"); the secured page repeats
the FROZEN row terms (EVERY satisfied transition carries none —
including the page's own auto-secure branch); and a card the customer
removed is honored as revoked — the fee closes 'released' with an
office alert, the local payment_methods row must still exist before any
fee charge, and the fee path performs NO attach self-heal at all (a
method detached by a racing removal fails the charge instead of being
resurrected). Every satisfied heal (auto-secure update, autopay heal, prepay
heal) applies the SAME monotonic-down accepted_amount stamp as the
render — a heal can never overwrite the sticky 0 sentinel or widen a
lower disclosed cap. The
`GET /:serviceId/card-hold` cancel preview merges both lanes so the
client waive prompts work unchanged. (2)
`GATE_APPT_CARD_COMPLETION_CHARGE` — the dispatch completion
auto-charge guard widens from `perApplicationBilling` to
`(perApplicationBilling || apptCardOneTimeCharge)`: a ONE-TIME visit
(`is_recurring !== true`, not per-app/prepay/membership lane, no hold
row) with a completed-or-satisfied `appointment_card_requests` row and
active Auto Pay auto-charges its completion invoice through the same
rail, hard-capped at the lane row's FROZEN `accepted_amount` ONLY —
never the live `estimated_price`, no acceptance-fee fallback, no
setup-fee allowance (those stay per-application concepts); NULL
accepted_amount routes to office review instead of charging. Autopay-log
source `appointment_card_completion`. The recap closeout path
(`pest-recap.js`, which completes without invoicing) runs
`chargeAppointmentCardForRecapCompletion` as the no-hold fallback after
the card-hold recap rail — same exclusions and frozen cap, invoice
minted through the SHARED `resolveOrMintRecapCompletionInvoice` helper,
which serializes on the CANONICAL `['schedule.invoice.mint', svc.id]`
advisory lock (the same lock every scheduled-service invoice writer
takes — a recap overlapping the dispatch /complete mint must contend on
it or both paths mint and auto-charge separate invoices; r4),
autopay-log source
`appointment_card_recap_completion`, every non-charge outcome alerts the
office (recap has no pay-link fallback). Source contracts pin the guard
strings — `admin-dispatch-backfill-completion.test.js` and
`appointment-card-fees.test.js` must move with any change here.)
`/api/mcp` (POST; machine-to-machine JSON-RPC — a minimal read-only MCP
server exposing the knowledge index (hybrid search, catalog service +
static protocol lookups, corpus stats) to MCP clients such as Claude Code
sessions and agents. Fail-closed in three ordered layers: 403 unless
`GATE_MCP_READ_TOOLS=true`, 503 unless `MCP_SERVICE_TOKEN` is configured,
401 unless the `Authorization: Bearer` / `X-MCP-Token` credential matches
via constant-time compare — the endpoint is unusable until deliberately
armed in an environment. Tools are READ-ONLY and free of generative LLM
calls by construction (the only model call is the query embedding, which
degrades to FTS-only when unavailable); no customer-PII tools and no write
tools may be added here — the write surface stays IB-only behind
write-gates. JSON-RPC batches are capped at 20; GET returns 405 (stateless
server, no SSE). Treat the auth ordering and the read-only tool surface as
security-critical).
`/api/ops/digest` and `/api/ops/digest/resolve` (POST; machine-to-machine
— the external Waves ops crons on the owner's Mac post their FIX:/ACT:
findings so they land as `ops_digest` admin bell rows (the Waves Ops lane
in Agents → Activity) instead of emails to contact@, and retire a finding's
standing rows once its check has run clean N times (fall-off rule, owner
2026-09-11). Token-only auth: `OPS_DIGEST_INGEST_TOKEN` via
`Authorization: Bearer`, constant-time compare. Privacy baseline on every
outcome (`Cache-Control: no-store`, `X-Robots-Tag: noindex`,
`Referrer-Policy: no-referrer` via middleware/no-store.js). Fail-closed in
ordered layers, the dark check FIRST — a pre-router `app.use('/api/ops/digest')`
gate in server/index.js mounted ahead of the global `cors()` (so even an
OPTIONS preflight reads 404 while dark), the global `/api/` limiter, and a
pre-parser chain (`ingestPreParsers`: dark gate → own limiter → bearer auth
→ 1 MB JSON parse → JSON body-error handler) mounted ahead of the global
JSON parser, same pattern as `/api/mcp`. While the token is unset every
request reads the SAME generic 404 an unknown route gets (`Route not
found: METHOD path`), never a revealing 429, 400 or 413; with the token set
a malformed or oversized body is parsed only AFTER auth, so an
unauthenticated caller sees 401, never 400/413. Layers: 404 while the token
is unset (that IS the kill switch), then 120/15-min per-IP limiter
(/64-collapsed), 401 on mismatch,
409 while `GATE_OPS_DIGESTS_IN_APP` / `GATE_AGENT_ACTIVITY` are off, 400 on
a rejected payload (kinds other than FIX/ACT are refused — routine/FYI
reporting stays on email), 503 when no row landed; the caller emails on
any non-2xx so nothing is lost. A failure observed at or before this key's
latest clean observation returns 200 `{ ok: true, stale: true }` without a
bell or email fallback. `/resolve` shares the 404 → limiter → 401
→ 400 layers but deliberately has NO 409: retiring history must never
depend on the ingest lane being on. Under the same per-key advisory lock
as ingest, it atomically retires rows by observation time (using created_at
only when no observation stamp exists) and advances a durable clean watermark
even when no rows stand; success answers 200 `{ resolved: N }` (N may be 0),
and a DB failure answers retryable 503, never false success. Writes exactly
one admin `ops_digest` row
(bell:true, dedupe on the check+key pair inside a rolling day; links must
be `/admin`-relative; subject/body/metadata size-capped) or marks rows
read + `metadata.resolved` — never deletes, never touches customer rows.
No customer PII may be posted here (the ops-cron contract is id prefixes
and masked phones). Treat the auth ordering and the exceptions-only kind
allowlist as security/ruling-critical.
Admin-alerts-brevity scope (owner ruling 2026-09-28): the payload also
accepts optional `headline` (string, ≤60 chars), `summary` (string, ≤110
chars), and `audience` (`'owner'`|`'engineering'`|`'fyi'`), each validated
and trimmed the same way as `subject`/`body` (blank → `null`, oversized or
wrong-typed → 400). The submitted `body` no longer becomes the bell's
displayed body: it persists verbatim to `notifications.detail` (the
Activity feed's expander and the destination page read `detail || body`;
the bell itself never reads `detail`) and the bell title never carries the
`KIND: ` prefix any more (kind rides in `metadata.kind` only). The stored
title is the caller's own `headline`, else `${area} — ${subject}` (or that
check's own parsed headline, e.g. the data-hygiene sweep's fixed subject
shape) from the server-side check → destination map
(`server/config/ops-alert-routes.js`, keyed on the check id — `key` up to
its first `:`, regex-matchable), cut to 60 chars at a word boundary; the
bell body is the caller's `summary`, else null (never the whole report).
`link` substitution: the caller's own `/admin`-relative link is kept
verbatim UNLESS it is absent or is literally the Activity feed
(`/admin/agents?tab=activity`), in which case the map's own page for that
check is used instead (falling back to the Activity feed itself for an
unmapped check). `audience` resolves from the caller's own value, else the
map's audience for that check, else FIX→`engineering`/ACT→`owner` for an
unmapped one; a non-`owner` audience stamps `metadata.feed = 'activity'`
and that row is excluded from the admin bell's list, unread count, and
mark-all-read (it still lists in the Activity feed). `audience` and `feed`
join the reserved metadata keys the caller's own `metadata` object cannot
override (alongside the existing `opsKey`/`subject`/`kind`/`source`/
`dedupeKey`/`dedupeVersion`/`resolved`/`resolvedAt`/`resolvedBy`/
`observedAt`). None of this changes the auth ordering, the FIX/ACT-only
kind allowlist, the 404/401/409/400/503 status layering, or `/resolve`,
which are unchanged from the paragraph above).
Admin-alerts-ring scope (owner ruling 2026-09-28, "ring only when something
changed"): the payload also accepts optional `count` and `newCount`, each a
non-negative integer no larger than `Number.MAX_SAFE_INTEGER` (any other
type, an explicit `null`, or a negative/oversized value → 400); both are optional and resolve
INDEPENDENTLY — a caller-supplied value always wins for that field alone,
and only a field the caller left out falls back. `count` falls back to the
check-map's own `counts(subject)` for that check (data-hygiene: its parsed
"N fixed, M exceptions (K new)" subject), then to the first LEADING integer
in the subject; `newCount` falls back to the check-map's own `counts()`
only — never to a bare number in the subject, whose meaning isn't safely
guessable for an unconverted check. Effect: for an `owner`-audience row
only, these feed the same ring-only-on-change test the in-process digests
use — the bell rings again when `newCount` is greater than zero, when
`count` is higher than the most recent matching row's own count (by alert
class, ops-crons scoped, within its last 7-day ring), or when that row has
no recorded count at all. An equal `count` also rings when the finding
is about a different set of items: for a fresh row, the two ops-cron keys
with their run dates removed differ (the key names the items — a mapped
check with a stable class such as data-hygiene is compared by its counts
only, since its key carries run counters); for any row, a stored
`metadata.itemKeys` list (in-process senders) that gains an id. Otherwise
an equal or lower `count` keeps the refresh quiet. A quiet NEW row is written to the
Activity feed only (`metadata.quiet = true`, `metadata.feed = 'activity'`)
— never the bell (unread count, list, mark-all-read) until something
actually grows. A quiet REFRESH of a standing row updates its
title/body/detail but keeps that row's current visibility and read state:
a row already in the bell stays there (an unread alert the owner has not
opened must not vanish because the list shrank), and a row already
Activity-only stays there. Only a ring re-surfaces a row as unread. A non-`owner` audience is never gated by
this test (`metadata.feed` is already `'activity'` unconditionally for
those rows). Every ring also stamps `metadata.rungAt` (an ISO timestamp) —
the 7-day comparison window is measured from a row's own last ring, not
its `created_at`. `count`, `newCount`, `rungAt`, `itemKeys`, and
`itemSetHash` join the reserved metadata keys above.
Date-only key follow-up (2026-09-28, codex r8 P1): the date-stripped-key
comparison above only counts as proof of "the same set" when that key
still carries something BEYOND the alert class itself — a check whose key
is shaped exactly `<check-id>:<finding>-<date>`, nothing else variable
(e22's "N overlapping visits" is the production example), collapses to the
alert class once its date is stripped and proves nothing about which items
the finding names. Such a key's identity is UNKNOWN: the ring decision
falls back to `count`/`newCount` (an equal or absent count with no item
evidence on either side still RINGS — the pre-admin-alerts-ring behavior
for these checks — rather than silently reading a different day's finding
as the same one). A check that wants a quiet re-run for a genuinely
repeated finding despite a date-only key sends the new `itemIds` field
instead: an array of strings, at most 2000 entries, each 1-200 chars after
trim (any other shape, or an explicit `null`, → 400; omitted leaves any
previously stored identity alone, same convention as `count`/`newCount`).
It carries the finding's own item identity — deduped, sorted, and capped
at 500 for the stored `metadata.itemKeys` list exactly like an in-process
sender's own `itemKeys` above; the full-set SHA-256 (`metadata.itemSetHash`)
is kept regardless of size, so a set past the cap still proves a swap at an
equal count. It feeds the SAME ring test as `metadata.itemKeys`, on both
the fresh-insert and the refresh path — a current id absent from the prior
list rings even at an equal or smaller `count`; the same set at an equal
count stays quiet. `itemIds` itself is never stored; only its derived
`metadata.itemKeys`/`metadata.itemSetHash` are (already reserved keys,
above).
`/api/client-errors` (POST; unauthenticated client error telemetry. An
anonymous surface — /admin/login, a public token route, or any page — can
crash in the browser, so the reporter cannot require auth. Error reports
retain a per-IP limit (30/min) followed by a global error ceiling (60/min).
The same limiters reserve separate keys for routine native diagnostics:
10/min per IP, then 20/min globally; normal app activity cannot debit the
error budgets. IP keys use the shared unauthenticated /64-collapsing helper.
Legacy reports accept
`name/context/route`: error names and contexts are allowlisted; the server
reduces routes to known roots and allowlisted admin/tech page segments before
forwarding to Sentry, tagged `source=client`. Optional native-link diagnostics
use `{ context: 'native-links', nativeLink: { platform, source, outcome,
route, target } }`. Every native field is an exact allowlisted label; route
and target are only `home/shortlink/estimate/other/none`, never a URL, token,
query, error message, stack or device identifier. Invalid native reports are
discarded with 204; extra fields are ignored. Native failures report at error
severity under the error budgets and normal handoff stages at info severity
under the routine budgets. Existing reporters remain compatible. No reads, no PII persistence,
no writes to app data — it only forwards to Sentry).
`/api/public/mcp` (POST; ANONYMOUS read-only MCP JSON-RPC server for
third-party AI agents — the surface the hub's /.well-known agent-readiness
cards point at. No token BY DESIGN (the audience is anonymous agents);
guarded instead by GATE_MCP_PUBLIC (404 dark until flipped), a per-IP rate
limit (60/15min), a 64kb body cap ahead of the global parsers, and the
/api/mcp batch caps, sharing the same JSON-RPC plumbing
(services/mcp-rpc.js). Tools are READ-ONLY, side-effect-free, LLM-free, and
expose only already-public data: customer-visible catalog rows (price
columns excluded AND `description` excluded — tighter than /api/mcp
get_service, because catalog descriptions are admin-editable free text
that is neither compliance-curated nor price-synced and must not reach an
anonymous surface). `list_services`/`get_service` additionally exclude
`services/pricing-engine/retired-sale-catalog.js`'s `RETIRED_SALE_SERVICE_KEYS`
denylist (currently only `tree_shrub_quarterly`) even when a row's own
`customer_visible=true` — this is deliberately narrower than
`public-services-menu.js`'s `FORMERLY_PUBLIC_KEYS` (which also carries
still-active services, e.g. foam/termite/rodent keys, that are merely off
the public quote MENU); MCP's catalog would otherwise promise a narrower
service list than it actually serves. `tree_shrub_quarterly` is the
first key excluded this way rather than by `customer_visible=false`
(2026-09-24; see the services/menu entry above for why its customer_visible
stays true), so a retired catalog row never becomes agent-discoverable
again just because its customer_visible flag serves an unrelated
customer-facing surface,
the /api/public/pricing-ranges payload via its shared fail-closed producer,
the service-areas table, and a static description of the
/api/public/quote/calculate HTTP contract (how_to_request_quote). No
customer-PII tools and no write tools may be added here — exact quotes and
lead capture stay on /api/public/quote/calculate behind its four-field
contact gate; this surface documents that endpoint, never wraps it. Treat
the gate, the rate limit, and the read-only tool surface as
security-critical).
`/api/public/a2a` (POST; ANONYMOUS informational A2A (Agent2Agent) JSON-RPC
endpoint — the service behind the hub's /.well-known/agent-card.json.
Deliberately minimal: `message/send` returns ONE static, deterministic,
compliance-reviewed informational Message pointing agents at the public
MCP server and published pricing/quote surfaces; A2A task/streaming/push
methods return UnsupportedOperationError (-32004). No tasks, no state, no
LLM calls by construction, no PII, no writes — none may be added. Guards
mirror /api/public/mcp: GATE_A2A_PUBLIC (404 dark until flipped), per-client
rate limit (60/15min via the shared /64-collapsing key), 64kb body cap
ahead of the global parsers, GET 405. Treat the gate, the rate limit, and
the static-reply-only surface as security-critical).
`/api/estimates/:token/measurement-review` (POST; the "does the lawn size
look off?" challenge on a sent estimate — parks ONE `service_requests` row
(`requested_service='lawn_area_review'`) + an admin bell; the estimate is
NEVER mutated and the customer is NEVER auto-messaged (owner sends all
comms). Guards: `GATE_ESTIMATE_MEASUREMENT_REVIEW` dark by default with a
gate-aware limiter skip so dark-gate probes see the same generic 404 as
unknown/malformed tokens; estimate token format gate; 5/hr rate limit on
the shared IPv6-safe key; full customer-viewability + accepted/declined
exclusion + priced-lawn-basis requirement, ALL re-validated on the LOCKED
estimate row inside the write transaction; the durable call-side linkage
verdict re-checked under the estimates → leads → call_log lock order and
HELD through customer resolution and the insert; open-request dedupe on
the `service_requests` partial unique index, pre-checked under the lock
(a 23505 inside the transaction is a bug, not a race); `shownSqFt`/
`shownSource` derived server-side from the authoritative measured basis —
request-body figures are ignored. Treat the gate, the lock ordering, the
generic-404 indistinguishability, and the no-comms contract as
security-critical.)
`/api/estimates/:token/referral-link` (POST; the referral card's "Send My
Referral Link" tap on an ACCEPTED estimate, GATE_ESTIMATE_SUCCESS_REFERRAL.
Same composer as the service report's tap — `services/referral-share.js`
(`buildReferralShareForCustomer`: strict live-settings read, per-customer
`enrollPromoter` with the household 23505 fallback scoped to account_id,
owner-voice share copy, exact-cents referee amount). The RENDER payloads
(/data, the accept response, the already-accepted retry) carry only the
static headline + CTA via `composeReferralCard`; enrollment happens on the
tap only, never on a read. Guards: gate with a gate-aware limiter skip
(dark = generic 404), token format gate, 5/min shared IPv6-safe key, the
durable call-side linkage verdict, full customer-viewability +
accepted-only + linked-customer, inactive program = 404, `err.code`-only
logging (PG constraint errors quote phone numbers). Treat the gate, the
no-enroll-on-read rule, and the PII-in-logs rule as security-critical.)
`/api/estimates/:token/change-request` (POST; the non-decline half of the
customer soft-exit sheet, GATE_ESTIMATE_SOFT_EXIT. `kind:'change'` parks
ONE `service_requests` row (`requested_service='estimate_change_request'`)
+ an admin bell through the measurement review's shared notify core;
`kind:'still_deciding'` writes one `activity_log` row and nothing else.
`kind:'callback'` instead gates on `GATE_WEBSITE_QUOTE_BOOKING`, requires
the server's `websiteSelfService` stamp on the locked estimate, and parks
one `estimate_callback_request` through the same office-request writer and
notification core. Its content is server-authored; no arbitrary phone number
is accepted. Each request kind dedupes under its own requested-service key.
The estimate is NEVER mutated and the customer is NEVER auto-messaged.
Guards mirror measurement-review exactly: gate with a gate-aware limiter
skip (dark = generic 404), token format gate, 5/hr shared IPv6-safe key,
full customer-viewability + accepted/declined exclusion re-validated on the
LOCKED row, the durable call-side linkage verdict re-checked under the
estimates → leads → call_log lock order and held through the insert, open-
request dedupe pre-checked under the lock. The same gate lets
`PUT /:token/decline` accept optional `reason` / `competitorName` /
`competitorPrice` / `note`, validated by `customerDispositionUpdates`
against the normalized loss codes the staff modal writes; with the gate
dark those fields are ignored so the plain decline stays byte-identical.
Treat the gate, the lock ordering, the no-comms contract, and the no-
estimate-write contract as security-critical.)
`/api/public/careers/apply` (POST; public job-application intake for the
careers funnel. Guards mirror the lead webhook: GATE_JOB_APPLICATIONS
(404 dark until flipped, unobservable-when-dark), IP limiter (6/10min)
+ per-phone limiter (3/hr), honeypot silent-200, Turnstile shadow-verify
with enforcement under the shared leadTurnstile gate, strict validation
with 400 fail-closed (malformed shapes, non-string or over-length
answers, over-length city, unknown role all reject; answer keys are an
ALLOWLIST — unknown keys are dropped by contract, and `source` is
server-sanitized attribution, not applicant content). Applicants
are NEVER customers or leads — the route never touches either table.
Post-insert side effects are fire-and-forget: an AI ranking
screen that is assist-only (it never changes status or any
applicant-facing outcome — every decision is the owner's, which also
keeps us clear of automated-employment-decision law), an owner
bell/push, and — as of the recruiting-comms lane, `GATE_RECRUITING_COMMS`
— the applicant's own submit confirmation: an email whenever one is on
file, plus SMS only when `sms_consent` was checked on the form. While
that gate is dark the confirmation is skipped entirely (byte-identical to
before the lane); it is never a blocking part of the request either way.
Treat the gate, the limiters, the no-customer/no-lead rule, and the
fire-and-forget-only comms contract as security-critical.)
`/api/public/careers/interview/:token` (GET; `/interview/:token/book` and
`/interview/:token/withdraw`, both POST — the interview self-scheduling
funnel a `job_interview_invite` text/email sends the applicant, gated
`GATE_RECRUITING_COMMS` ALONE (404 for the WHOLE `/interview/*` family
before even the limiter runs). The `jobApplications` INTAKE gate in
index.js carves `/interview/*` out: closing intake stops new applications
without killing the bearer links applicants already hold. `interview_token` is 64
lowercase hex chars, minted once (first move to `interview`, never
rotated in this PR) and format-gated via `router.param` before any
database read — malformed, unknown, and non-`interview`-status tokens all
answer the same generic `{error:'Not found'}` 404. A 30/10min per-IP
limiter (prod only, `ipFallbackKey`) sits behind both gates. GET returns
`{first_name, status:'open'|'booked', mode_options, in_person_address,
timezone, booked, slots}` — `slots` come from
`server/services/interview-slots.js` (weekly window template, 4-hour lead
time, 30-minute slots, 15-minute buffer against the owner's own route
stops, and against every other applicant's booked interview) and are
ALWAYS present, booked or not, so "Change time" needs no second fetch.
Booked interviews are ALSO occupancy for customer scheduling: the shared
conflict reader `findConflictingVisits` (scheduling/occupancy.js) appends
them as synthetic conflict rows (`conflict_reason:'interview'`, interview
±15 minutes, `interview`/`offer` rows, best-effort raw side read) for the
callers that opt in with `includeInterviews:true` — the customer booking
writers: the availability confirm probe, `routes/booking.js`, and every
`slot-reservation.js` commit path — and the availability slot builder
merges the same windows into its occupied set. Staff/automation readers
(rebooker, rain-out, renewals, admin schedule, capacity mode) do not opt
in yet: full coverage needs interviews represented as calendar rows
(owner decision, PR 2). An identical `{mode, start}`
retry of the current booking is answered with the current payload and no
side effects. POST `/book` establishes token eligibility (a non-authoritative read;
unknown/inactive ⇒ generic 404) BEFORE any body validation, so an invalid
token's response never depends on body shape; then re-validates the
client's chosen `start` against that SAME live offered set — the client's slot choice is never trusted — and
writes `interview_mode`/`interview_at`/`interview_end_at`/
`interview_booked_at` inside ONE transaction that first takes the SHARED
date-wide occupancy lock (`acquireOccupancyLock`, scheduling/occupancy.js
rung 1 — the same lock every customer scheduling writer takes for that
day), re-lists the offered slots THROUGH that transaction, and row-locks
the application (`FOR UPDATE`) — two applicants who both saw a free slot,
or an applicant and a customer confirm on the same day, are serialized;
two taps on one application cannot overwrite each other,
and the status_history entry is appended in SQL; the write is still
conditional on `status='interview' AND interview_token=?`, a 0-row result
(a race with a withdraw) is a 409, never a silent overwrite. Privacy
headers (`noStore`: no-store + noindex + no-referrer) are mounted on the
`/api/public/careers/interview` prefix in index.js AHEAD of the outer
`jobApplications` careers gate and ahead of the global `/api` limiter, so
every outcome — including a dark 404 from either gate — carries them; the
SPA document `/careers/interview/<64-hex>` gets the same headers via
`utils/sensitive-spa-headers.js`. Applicant threads are OWNER-ONLY in
every shared reader: the invite carries this bearer link and dual-writes
into the unified inbox, so `utils/recruiting-thread-scope.js` filters every
recruiting MESSAGE (`message_type LIKE 'job_%'` — the invite/confirmation
and the applicant's reply, which the webhook types `job_applicant_reply` at
birth) out of `/api/admin/communications/log`, the dashboard inbox + its
unread count + reply lookup — message-level, so a customer's own texts in
a thread shared with an applicant stay visible —
applicant rows (`audience='applicant'`) out of the compliance export, and
refuses (403) a non-admin `POST /api/admin/communications/ai-draft` for a
phone that has ever been party to a recruiting text
(`isRecruitingPhone` — durable applicant-ledger evidence first, the
provider log second) before any history for that phone is loaded; the
composer and `/schedule-sms` use `activeOnly` (ANY open application on
the phone, delivery evidence or not — an email-only applicant, one whose
consent box was unticked, or one whose first text is still queued has no
ledger evidence yet, and the owner's first text is what creates it; a
validated `customerId` is explicit customer context and bypasses the
check on the immediate send only, never with a retained recruiting
`replyToMessageId`), so a former applicant who is also a customer
receives ordinary service texts again once their application closes. An
OWNER texting an applicant from a shared surface — the dashboard inbox
reply on a `job_applicant_reply` row, or the Communications composer to
a recruiting phone — rides the recruiting rail (`sendOwnerReply`: purpose
`applicant_reply`, message_type `job_owner_reply`, sent from the line the
applicant texted, handoff evidence on the application; refused with outcome `closed` for a
rejected/withdrawn/hired application — the classifier would not protect
the reply), never a 'manual' customer text; a non-admin is refused (403)
on both, and `POST /schedule-sms` refuses a recruiting phone for everyone
(403 non-admin, 409 admin) — applicant texts are never queued as manual
customer texts. The owner reply carries the same provider-boundary
eligibility guard as every recruiting send and lands on the open
application whose ledger owns the newest SMS attempt. A technician's
read-marking scope (`markInboundSmsRead`) excludes hidden recruiting rows
exactly as the display query does. A standalone compliance command (STOP /
START / HELP) bypasses recruiting classification entirely, so a
recruiting-store outage can never delay a suppression write; the recruiting
ledger still counts as compliance ELIGIBILITY evidence (an applicant's STOP
is honored even when the provider-log writes failed), failing open. Reply evidence is scoped to the line the reply arrived on
before the newest entry is chosen (two recruiting lines = two threads).
The immediate SMS ledger entry is written `pending` (not evidence) before
the pipeline and moved to `handoff` inside the pipeline's preSendCheck —
right before Twilio, after suppression/consent/line-type — so a send
blocked by a validator never leaves delivery evidence. Applicant emails
never invite an email reply (questions go to the phone), stay off the
generic transactional retry rail, and never resolve to a customer in
bounce recovery. Every applicant send re-checks eligibility at the ACTUAL provider
boundary (a `preSendCheck` inside the SMS pipeline; a `beforeProvider`
check immediately before SendGrid — a stale one settles its ledger row
`failed` and sends nothing). Applicant texts obey the 8am–8pm ET send window; a held send is queued
on the scheduled-SMS rail (`sms_log` status `scheduled`, metadata
`audience:'applicant'` + `purpose` + `consent_basis` + the ledger entry id
and the application's interview token/time, replayed by
services/scheduler.js under the applicant policy through the
`recruiting_comms_deferred` deferred-replay registry entry — the recheck
fails closed on the gate, a missing/closed application, a changed token
or a rebooked time/mode (the ledger entry moves to `handoff` only in the
locked provider handoff — a transaction holding the application row FOR
UPDATE from the eligibility read through the provider request — after the
fresh suppression/consent checks pass and after the eligibility recheck is
run AGAIN at that boundary — a stale
application answers `RECRUITING_STALE_AT_HANDOFF` with no provider call;
never at the claim-time recheck), and on a NEWER attempt of the same stage in the
ledger (a resend supersedes a queued invite even after the worker claimed
it); the recheck marks the queued entry `handoff`
before dispatch, finalize marks it `sent`, and a terminal block never
downgrades evidence — never-attempted `deferred` → `blocked`, attempted
`handoff` → `uncertain`, `sent`/`uncertain` untouched) and
the ledger entry reads `deferred` with its `scheduled_for` (a `deferred`
entry is owner-only reply context like a sent one). Queued recruiting
rows are hidden from non-admins in `GET /api/admin/communications/scheduled`
and refused (403) on `DELETE`. A successful book fires
(fire-and-forget) the `interview_confirmation`
comms — SMS only with `sms_consent` or evidence the owner already texted
this applicant by hand — and the `job_interview_booked` admin
bell/push. POST `/withdraw` is the same atomic-update shape targeting
`status='withdrawn'` (0 rows ⇒ 404) and fires `job_application_withdrawn`.
Neither admin notification carries applicant PII (mode + a formatted time
label only), matching `new_job_application`'s contract — the recruiting
queue itself stays `requireAdmin`. No logger call anywhere in this family
ever receives a raw phone, email, name, or message body — only ids and
masked forms. Treat the gate-before-limiter ordering, the token format
gate, the atomic conditional updates, and the no-PII-in-notifications rule
as security-critical.)
`/api/estimates/:token/service-opt-out` (PUT; the customer drops ONE
recurring service line from a sent estimate. Unlike the bond and interior
switchers this route re-prices the WHOLE estimate through the canonical
engine — `serverRecomputeFromEstimateData` with `replaySavedPricingKnobs`,
never delta arithmetic — and PERSISTS the result, so it is the first public
route to write that recompute's output. `dryRun: true` runs every
precondition and the full replay and returns before/after WITHOUT writing;
the customer confirms against real numbers, because a removal can RAISE the
price of the services they keep (tier collapse, the solo setup fee, the
prepay rate) and must never do so silently. Guards:
`GATE_ESTIMATE_SERVICE_OPT_OUT` STRICT opt-in in every environment (dev
included), dark = generic 404 indistinguishable from an unknown token, with
a gate-aware limiter skip so a probe cannot spot the route by a 429;
estimate token format gate; 40/hr on the shared IPv6-safe key; the durable
call-side linkage verdict; `isEstimateAcceptActive` + an explicit
`price_locked_at` refusal; removability from ONE resolver shared with the
`/data` projection, which refuses an itemized proposal on ITEMIZATION
PRESENCE (not `proposal.enabled`) — the same refusal applies to RESTORES
and suppresses the add-back projection, because an itemization added after
a removal is the authoritative billed quote — plus the last remaining
recurring line, `tree_shrub`, every `commercial_*` key, and an annual-protection
termite line (removal would erase its priced-program replay provenance).
Quarterly termite remains removable; a pre-provenance restore recovers the
sold program and station pricing knobs from the original opt-out baseline
when present, while an annual sale or an unproven annual request remains
blocked for customer restores. `/data` keeps such keys in `removedKeys` to
suppress a duplicate add-service offer, but lists them in
`restoreBlockedKeys` so the customer page omits their unusable add-back
control. A server-initiated compensation for a preexisting staff-parked
annual line may restore its captured annual terms after a failed send;
customer restores remain refused;
a fail-CLOSED 409 when the
recompute cannot run; and a 400 refusal when the removal would turn a
bundled-free one-time item into a charge (owner ruling — that one goes to
the office; the before-state resolves through `result` OR the mapped raw
`engineResult` so engine-only estimates never blind the guard). Membership
identity is loaded EXPLICITLY — `membershipSnapshot.isExistingCustomer ===
true`, never snapshot truthiness — or an existing member reprices as a
brand-new customer and a linked NEW customer steals the perk; when member
evidence survives (snapshot flag, priors in any carrier, or a surviving
recurring flag), the handler LIVE-verifies the plan itself and fails
closed on any lookup failure — the reconciler never throws and every
other consumer only renders, but this route persists. EVERY commit
(removal AND restore) must echo its dry run's `previewBasis` — an HMAC
digest over the row version AND the computed totals/tier, re-derived from
the commit's own recompute — and is refused when the row, the pricing
config, or the membership verdict moved since the preview, so the terms
the customer confirmed are the terms that persist — restores get the same
preview-and-confirm step, never a one-tap reprice. Confirm-panel copy is per-application only:
no combined plan totals ("$X/mo"/"$X/yr") per the standing price-copy rule;
the first-visit line is the invoice-preview exempt class. The write carries the same six-predicate rails +
ms-truncated CAS as the bond/interior writes, refreshes BOTH stored result
carriers (`result` and raw `engineResult`) from the same recompute, and
stamps `serviceOptOut.engineTier` as the select-tier eligibility ceiling.
A standing /select-tier override (row tier differing from the engine tier)
REFUSES all self-serve mix changes — removals, restores, and both /data
projections — because an opt-out reprice persists the engine's tier and
totals, and honoring a hand-picked tier through that rewrite would either
discard the choice or persist totals that disagree with the stored result
rows every renderer and accept reads; that interplay is an owner ruling,
not a route default, so it routes to the office. A removal with no
trustworthy before-state (no pricing rows in `result` or the mapped raw
`engineResult`) fails closed, and per-application disclosures derive from
effective post-discount amounts (`annualAfterDiscount`/`visitsPerYear`),
never the pre-discount list `perTreatment`.
NOTHING is sent to the customer and no bell rings: one `activity_log` row,
written ATOMICALLY with the estimate update, is the whole audit surface.
The same PUT is the priced ADD rail under `GATE_ESTIMATE_SERVICE_ADD`
(STRICT opt-in, needs the opt-out gate; off = the `/data` `addable` stamp is
withheld and the write refuses 400 `service_not_addable`): `included:true`
for a key the customer never removed adds a NEVER-quoted residential line
(`SERVICE_ADD_KEYS` pest / lawn / mosquito; lawn only from a supplied turf
basis — measured, `lawnSqFt`, or `estimatedTurfSf` — because lot-only
turf prices review-only) through the identical dry-run → `previewBasis`
confirm shape and canonical recompute (mode `add`). Eligibility is ONE
resolver (`serviceOptOutAddableKeys`) shared with the `/data`
`serviceOptOut.addable` stamp: `estimates.category` RESIDENTIAL
fail-closed, no member evidence via `memberEvidenceInEstimateData`, PLUS a
strict live `isActivePlanCustomer` check that fails closed on the stamp
and the write; the write re-checks membership on a `FOR UPDATE` customer
row inside its transaction (estimate row locked first, the accept path's
order). The add branch is customer-only (`actor !== 'customer'` → 400); an
add whose recompute yields no new recurring row, or one the engine could
only price for review (`lineReviewOnly`), fails closed 409
`add_unavailable`. The rail body is `applyServiceMixChange({ estimate,
body, actor })` — the route owns gate / token / viewability, the rail owns
eligibility, recompute, digest, CAS write and audit, and every event
persists the caller's `actor`. Second caller: the send-time lead-service
park in `admin-estimates.js` (`actor:'staff'`,
`GATE_ESTIMATE_LEAD_SERVICE_SEND`, strict opt-in): a NEW residential
customer's two-recurring-line estimate is sent leading with the
estimator's first selected service (no selection order = unshaped), the
other parked as ONE staff removal that `/data` ships as
`serviceOptOut.staffOfferedKeys` and the page words as an offer; a
customer restores it only under the add gate and the same live member
check. A send that delivers on NO channel restores the park through this
rail (`revertLeadServiceForSend`, bound to its `parkId`; that staff
restore alone admits a `send_failed` row); a failed restore is a durable
`leadServiceRevertPending` marker the next send retries first.
Treat the gate, the generic-404
indistinguishability, the fail-closed reprice, the explicit membership
identity, and the no-comms contract as security-critical.)
`/api/public/blog-read-depth` (write; anonymous, cookie-free blog
scroll-depth counter — owner-approved 2026-09-27, "E2: cookie-free
read-depth counts", extending the 2026-07-16 exception that lets
Cloudflare's cookie-free counter run before cookie consent. The hub and
every spoke blog post fire `fetch(url, { method: 'POST', body, keepalive:
true, credentials: 'omit', mode: 'no-cors' })` at 25/50/75/100% scrolled and
at the post's "keep reading" row; the response is opaque to the browser by
design, so it matters only for tests/abuse posture. **Gated behind
GATE_BLOG_READ_DEPTH** — read via `isEnabled('blogReadDepth')`
(server/config/feature-gates.js); while dark, EVERY request gets the SAME
generic unknown-route 404 (`middleware/errors.js` `notFoundBody`) before the
route's own rate limiter, at any volume — the house dark-`GATE_*` contract
(AGENTS.md). Mounted in `server/index.js` ABOVE the global `cors({ origin:
allowedOrigins })` — which would otherwise answer an allowed-origin OPTIONS
preflight with 204 while the route is dark — and above the global
`app.use('/api/', limiter)` and body parsers (own 120 req/min per-IP limiter
applied AFTER the gate check, own `express.text({ type: () => true, limit:
'1kb' })` parse), so a dark probe of any method only ever sees the generic
404 and a reader's scroll beacons never spend the shared budget a customer's
quote-form or booking calls need. The router ends in a terminal generic 404,
so no request that reaches it (any method, any subpath) falls through to the
app's request logger. It sets no CORS headers: beacons are no-cors
`text/plain` POSTs whose response the page never reads.
Body: `{"p":"/{category}/{slug}/","m":"25"|"50"|"75"|"100"|"next"}`, parsed
and validated in try/catch (malformed JSON, a non-object, or a body over 1
KB → 400/413, nothing written). `p` must match one of the six live blog
categories (`lawn-care|mosquito|pest-control|seasonal|termite|tree-shrub`)
and be ≤200 chars; `m` must be one of the five milestone values — anything
else is 400. `site` is derived ONLY from the `Origin` header (never the
body) via the spoke registry's own `normalizeSpokeSites` — a
missing/`null`/unknown origin drops the beacon with 204 and writes nothing.
The Origin is attribution, not authentication: a non-browser caller can claim
any fleet origin, and an anonymous, cookie-free beacon cannot be
authenticated without the identifier the owner's E2 scope rules out (no
cookies, no IDs), so no per-source state is kept beyond the one-minute
per-IP limiter every public route carries. What bounds a forged beacon
instead: it counts only for a path the claimed site's OWN sitemap lists
(`https://{site}/sitemap-index.xml` — what @astrojs/sitemap writes on every
fleet site — falling back to `/sitemap.xml`, which only the hub serves, as a
redirect to that index; read with content-registry-live-status's
`fetchSitemapPaths` and compared with `normalizeContentUrl`, cached 6 h per
site; a failed refresh keeps the last good list and retries after 5 min; no
list yet means the beacon is dropped; each sitemap outage is warn-logged once
and its recovery once, with the fleet site key only), so invented slugs never create rows —
today every blog post is hub-only, so spoke beacons find no blog paths and
drop; and each `(day, site, path, milestone)` bucket stops at 2,000 a day
(the upsert's `WHERE count < 2000`), so a forged flood can skew one post by
at most that much. The 204 is the same whether a beacon counts or drops and
is sent before any sitemap read, so the response never says which paths
are live.
Storage is the ONLY thing this route does: `blog_read_depth_daily`, one row
per `(day, site, path, milestone)` with an `INSERT ... ON CONFLICT DO UPDATE
SET count = count + 1` capped at 2,000, `day` computed in SQL as the America/New_York
calendar day. The 204 is returned before the write settles (fire-and-forget;
a write failure is warn-logged by error kind ONLY). No cookie, user agent
or referrer is ever read; the network address is used only by the
one-minute per-IP limiter; nothing per-visitor is ever stored or logged. This is a pure aggregate count, never
a session/visitor record.)
The route-WIDE invariants — every public route must be listed here, the
baseline token-route guards, the `/api/reports/:token/*` write rules,
contract-token burn, and the estimate ask / find-slots gates — live in the
AGENTS.md P0 rule "Public route surface", not in this document. This
document holds the per-route entries only.
