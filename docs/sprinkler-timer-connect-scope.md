# Sprinkler timer connect — scope

Concept scope · Waves Lawn Care · 2026-11-19. **Nothing here is built.** The
only code is a screen prototype in the dev preview harness (see "Screens").
The build waits on the owner decisions at the bottom and on Hunter granting
API access. Hunter's own API terms, read on its site 2026-11-19, say it is
not accepting new commercial API connections, so steps 2 to 4 wait on
Hunter's reply to the request sent that day (see "Outside the code").

The idea: a lawn customer connects the sprinkler timer on their wall to the
Waves app. After a treatment whose instruction is to skip watering for a
time, Waves pauses the lawn zones on its own. When the weekly plan says
water, the customer starts it with one tap, or has the timer run it at a
day and time they set.

## What the owner said (2026-11-19)

- Can homeowners control irrigation from the Waves app through Hunter or
  Rain Bird, and are there partnerships worth pursuing.
- About 90% of lawn customers have a Hunter or a Rain Bird timer.
- The common Hunter in Lakewood Ranch is the **X2** (identified from the
  Home Depot listing for the 6-station model).
- Most of the customers he talks to already have the Wi-Fi module and use
  the timer's app. This is a read from the field, not a count, and it is
  not split by brand: a Hunter on Hydrawise can be reached, a Rain Bird on
  Rain Bird's app cannot.
- Scope the build and show the screens in the app.
- Can the weekly watering email drive the timer: when it says water 20
  minutes this week, the timer runs 20 minutes at a set time, with no tap.
  This is step 4.
- He authorized contacting Hunter and Rain Bird about access, from
  contact@. The Hunter request went out 2026-11-19. Rain Bird publishes no
  email address or form, so nothing went to Rain Bird.

## Verdict

Worth building for Hunter, in four steps, once Hunter allows it. Today
Hunter does not: step 1 can ship now, and steps 2 to 4 need Hunter's
permission first. Rain Bird stays on the hand-run guides until Rain Bird
offers a way in.

- The portal already decides what each lawn needs: the Monday watering plan
  and the per-product "keep it dry" or "water it in" instruction after each
  visit. The only missing piece is the last step to the timer.
- Hunter is the one brand of the two with an official API (Hydrawise). It
  reaches a Hunter only once that timer is on Hydrawise, which for the X2
  means a plug-in Wi-Fi module.
- Hunter's API for commercial apps is closed to newcomers. Its API terms
  say "Hydrawise is not currently accepting any new commercial API
  connections." Its other API, a key the homeowner generates, is "for
  personal use only", and the terms bar sharing that key with a third
  party without Hunter's written permission. So nothing automatic can be
  built within Hunter's terms today.
- One route works today with no API: a Hydrawise contractor account, free
  up to 25 controllers. The customer approves an emailed request, and
  Waves staff can then pause or run that timer by hand in Hunter's app.
  That can test the idea on a few homes. It is not the product, because
  every pause is office work (decision 9).
- Rain Bird has no public API for home timers. Nothing in this scope can
  reach one.
- Step 1 (record which timer each customer has) needs no vendor and ships
  on its own. It also gives the number that decides how much the later
  steps are worth: nothing on file today says how many homes are on
  Hydrawise. The owner's read is that most customers already have a Wi-Fi
  module and the app; step 1 confirms that and splits it by brand.
- Step 4 is the one that makes the weekly plan run itself. It is also the
  only step where Waves starts water with nobody watching, so it comes
  last and carries the most conditions.

## What the app would do

| | What happens | Who starts it |
|---|---|---|
| Record the timer | Customer or staff picks the brand and model. The card then shows the one matching guide. | Customer or staff |
| Connect | Customer links their Hydrawise account and marks which zones water grass. The link is a sign-in on Hunter's page, or an emailed request the customer approves; Hunter decides which. | Customer |
| Pause after a treatment | When a lawn visit's instruction is "keep it dry until a set time", the turf zones are paused until that time. The pause ends on the timer itself. | Waves, automatically |
| Run this week's plan | Starts the turf zones for the plan's minutes. | Customer, one tap |
| Follow the weekly plan | At the day and time the customer set, starts the turf zones for that week's minutes. No run in a week the plan says skip, or after enough rain. | Waves, at the customer's set time |

Not in this scope: editing the customer's schedule, Rain Bird, confirming a
water-in on the service report, and any change to the texts and emails
customers receive. See "Later".

## Screens

A prototype of the card sits in the dev preview harness, rendered inside the
real customer portal under "This week's watering plan" on My Property. Run
the client dev server and open
`/preview-sprinkler-timer.html?tab=property&timer=<state>`:

| `timer=` | Screen |
|---|---|
| `pick` | No timer on file: brand and model picker |
| `x2` | Hunter X2 still on the dial: what connecting takes |
| `ready`, `consent` | On Hydrawise, not connected; the connect sheet (sign-in shape) |
| `request`, `approve` | The connect sheet in its request shape; waiting for the customer to approve the Hydrawise email |
| `zones` | Just connected: mark the turf zones |
| `connected`, `confirm` | Normal week; the run sheet |
| `running` | A run in progress, with Stop |
| `paused` | Turf zones paused after a treatment |
| `offline` | Timer unreachable |
| `rainbird`, `xcore` | Timers that cannot connect: guide only |
| `autosetup` | Step 4: the sheet that turns on automatic runs (day and start time) |
| `auto` | Step 4: automatic runs on, with the next run |
| `rainskip` | Step 4: a run skipped for rain |
| `missed` | Step 4: a run that did not start, with Run |

Files: `client/preview-sprinkler-timer.html`,
`client/src/dev-preview/sprinkler-timer-preview-main.jsx`,
`client/src/dev-preview/sprinkler-timer/SprinklerTimerPrototype.jsx`. Nothing
in the app imports them, so they are not in the production bundle. Every
string is draft copy for owner review. The harness places the card with a
second React root because `PropertyTab` has no slot for it; the real build
renders it from `PropertyTab` the way `WeeklyWateringPlanCard` is rendered.

## Facts checked against the code

| Fact | Where |
|---|---|
| The weekly decision exists: `run`, `hold` or `unavailable`, with minutes per run. | `buildWeekPlan`, `packages/irrigation-runtime/index.js:290`; stored in `irrigation_week_plans.week_plan`; read for the app by `loadCustomerWateringPlan`, `server/services/irrigation-app-plan.js:23`, served at `GET /api/property/watering-plan`, `server/routes/property.js:46`. |
| The after-treatment instruction exists per visit, with a state (`hold`, `water_in`, `hold_then_water_in`, `none`) and a `holdUntil` timestamp. `holdUntil` is null for a hold that lasts "until dry". | `buildWateringInstruction`, `server/services/service-report/lawn-watering-instruction.js:796`; shape at `:377`. |
| That instruction is saved once per visit at completion. | `finalizeLawnReportSynthesis`, `server/services/service-report/lawn-report-write-gate.js:177` (write at `:309`, key `structured_notes.lawnWateringFreeze`), called from `completeScheduledService`, `server/services/complete-scheduled-service.js:14863`. The customer text goes out beside it (`sendLawnWateringSmsOnce`, `:14917`). |
| A visit closed a day late gets no instruction, so it would get no pause. | `lawnVisitClosedLate`, `server/services/service-report/lawn-watering-late-close.js:47`. |
| The app plan was shipped as advice only: it "does not send 'water now' reminders or control sprinklers". | `docs/irrigation-email-and-app-notifications-scope.md:33`. |
| The typical customer's sprinklers run on an automatic schedule, even in weeks the plan says skip (owner 2026-10-22). This is why a pause is worth automating. | `docs/irrigation-email-water-savings-scope.md:3`. |
| No timer brand or model is stored. The earlier guide scope left "brand capture" unbuilt. | `ALLOWED_FIELDS`, `server/services/property-preferences-schema.js:158`; `docs/irrigation-controller-guide-scope.md:86`. |
| The customer's watering days are already on file, and the customer edits them in the Irrigation section of My Property. Step 4 starts from them; only the start time is new. | `watering_days`, `server/services/property-preferences-schema.js:166`. |
| Staff can already edit a customer's irrigation details with the same validator the portal uses. | `PUT /api/admin/customers/:id/property-preferences`, `server/routes/admin-customers.js:5257`; `client/src/components/admin/Customer360ProfileV2.jsx:7593`. |
| No customer has ever linked an outside account. Outside tokens today belong to the company (Bouncie, Plaid, Google). | Closest pattern: encrypted at rest, refuses to store with no key, `server/services/plaid-sync.js:43`. |
| The sign-in "state" helper is tied to staff. A customer version is new. | `server/services/staff-oauth-state.js:52`. |
| Watering restrictions are resolved per county and return nothing when they cannot be established. | `currentRestrictionPolicy`, `server/config/irrigation-restrictions.js:200`. A weekday-by-house-number helper exists (`:238`) but only the pre-visit line uses it. |
| The phone app is a shell around the hosted portal. A link to another site opens in Safari. | `client/capacitor.config.json`; `docs/mobile/capacitor-ios-spike.md:131`. |
| Deleting an account is a soft delete. Anything that must be destroyed has to be destroyed explicitly. | `server/routes/auth.js:857`. |
| The published position is that Waves does not touch timers. | Hub guides (astro repo): "Waves doesn't install, set up Wi-Fi on, configure or repair irrigation controllers", `src/content/blog/lawn-care/hunter-sprinkler-timer-guide.mdx:147` and `rain-bird-sprinkler-timer-guide.mdx:156`; "You do not need to ... buy the Wi-Fi module", `rain-bird-sprinkler-timer-guide.mdx:94`. |

## What each timer allows

Models and prices: checked 2026-11-19 by web search, from search summaries
of the vendors' pages and retailer listings. Prices are retail on that
date. Hunter's API page, API terms, REST guide and contractor pages were
then read directly on Hunter's site the same day; quotes below are from
those pages.

| Timer | Reachable by the Waves app | What it takes |
|---|---|---|
| Hunter HC, Pro-HC, HPC | Yes | Nothing; already on Hydrawise |
| Hunter X2 | Yes, once on Hydrawise | WAND plug-in module, about $100 to $110. Installing it disables the dial and erases the stored schedule. Hunter's install guide pairs date codes: an X2 from June 2022 or earlier takes any WAND, a later X2 needs a WAND made December 2022 or later. A WAND bought new today should fit every X2 (from a search summary of the guide; asked of Hunter). |
| Hunter Pro-C, 2023 on (P2C) | Yes, once on Hydrawise | PC-WIFI plug-in module, about $190 |
| Hunter Pro-C, 2014 to 2023 (blue buttons) | Yes, once on Hydrawise | HPC face panel, about $180 to $270 |
| Hunter Pro-C before 2014 (green buttons) | No | A new timer |
| Hunter X-Core | No | No upgrade found; a new timer |
| Rain Bird ESP-TM2, ESP-Me3, ESP-Me after Nov 2016 | No | The LNK2 module (about $90 to $145) puts it on Rain Bird's app, but there is no API for Waves to call |

Hunter's API, from Hunter's own pages (2026-11-19):

- **The REST API (v1.6)** uses a key the homeowner generates in their
  Hydrawise account. It can list zones, run a zone for a number of
  seconds, stop it, and suspend a zone or all zones until a set time. The
  guide says: "This API is not suitable for commercial applications and is
  for personal use only. Customers wishing to use an API for commercial
  use should enquire about access to our oAuth API."
- **The API terms** say: "Hydrawise is not currently accepting any new
  commercial API connections." They also say the key must be kept
  confidential and may not be shared with a third party, and that API
  access may not be shared "without Hunter Industries prior, express,
  written permission". The APIs are free today; Hunter reserves the right
  to charge. Any use of the "Hunter Hydrawise" name needs Hunter's written
  approval.
- **The API page** no longer mentions a GraphQL API or a support form with
  "GraphQL" in the subject. An earlier draft of this doc took both from
  search summaries; neither is on the page today.
- **What the commercial API can do** is not published. The schema of the
  API the Hydrawise app itself uses is public in the open-source
  `pydrawise` library (the one Home Assistant uses). It has: start
  selected zones with a run time for each and a "stack runs" option, stop
  a zone, suspend a zone until a time, create suspensions with a start and
  an end, change a program's start times and each zone's run time, and
  read past runs. This shows what the platform supports. It does not show
  what Hunter would grant a commercial client, and that library signs in
  with the customer's password, which Waves must never do.

Hunter's contractor route, from Hunter's support pages:

- A contractor account can "directly access any of your customers'
  controllers" and change schedules remotely. "Contractor Plans start with
  25 free controllers."
- For a customer who already has a Hydrawise account, the contractor
  enters their email and taps Request Access: "This will send the customer
  an email asking for access to manage their controller."
- The access is the whole controller, not only pause and run. The customer
  can remove the contractor.
- Hunter built this for irrigation contractors. See the licensing item
  under "Outside the code".

Rain Bird, checked 2026-11-19:

- No API, developer or partner page for home Wi-Fi timers was found.
- Rain Bird's contact page lists phone and text lines only: 1-800-RAINBIRD
  for general questions, and 1-866-544-1406 for professional programming
  support. There is no email address or form.
- Rain Bird's commercial platform, IQ4, has a third-party API sold as a
  subscription through Rain Bird distributors (a 2021 Rain Bird deck; not
  re-confirmed). Whether it covers a home timer on the LNK2 module is the
  question for Rain Bird. A community Home Assistant integration reaches
  home timers through the IQ4 cloud unofficially, which suggests they are
  on that platform.
- A homeowner can share a timer with another account in the Rain Bird app,
  with or without an end date. What the second account may do is not
  documented.

Other routes checked and ruled out:

- Amazon Alexa and Google Assistant work with both brands, and Alarm.com
  works with Rain Bird. These are consumer or dealer products with no API
  for an outside company.
- Google's Home APIs list a sprinkler device type, but they run inside an
  Android phone app, not on a server.
- Rachio (owned by Rain Bird since late 2025) keeps a public API with a
  personal key. It reaches Rachio timers only, which are a small share of
  Waves customers.

## Recommended shape

### Step 1 · Record the timer

Ships live, no vendor, no gate. About 1.5 days. All estimates here are rough.

- Two columns on `property_preferences`, beside
  `irrigation_controller_location`: `irrigation_controller_brand` and
  `irrigation_controller_model`, each a key from one fixed list. Validated
  in `property-preferences-schema.js`, so the portal route and the staff
  route accept them with no second validator.
- They are not watering inputs. They stay out of the irrigation revision
  trigger and out of the confirmed-fields ledger, so recording a timer
  never invalidates a week's plan.
- Customer side: the card's picker (`timer=pick`), then the guide-only
  states. Staff side: two inputs in the Customer 360 irrigation block, so
  the model can be set from the truck.
- A read-only count by model for the owner.
- Why no gate: it cannot text, charge, delete, spend, or add a public page
  (`waves-ship` §6).

### Step 2 · Connect, and Run this week's plan

Dark behind a gate. Blocked today: it starts only after Hunter grants
access in writing and the bench test passes. About 8 working days across
four PRs. The design below assumes Hunter's sign-in (OAuth). If Hunter
instead approves the contractor route, the customer approves an emailed
request, Waves holds one company credential and no per-customer tokens,
and the link table stores the Hydrawise customer and controller ids only.

- **Link table** `irrigation_controller_links`, one active row per
  customer: provider, the timer's id, name and model, the tokens encrypted
  at rest (the `plaid-sync.js` pattern, a new key with the vault key as
  fallback, refuses to store with no key), the turf zone ids, the pause
  setting, the consent text version and time, and the home address at the
  time of linking. A change of address ends the link, as it already ends a
  watering plan.
- **Command ledger** `irrigation_controller_actions`: one row per pause,
  run or stop, with its source (treatment, customer), the visit it came
  from, the zones, the window, the outcome and the attempt count. A unique
  key per visit makes a repeated completion harmless. Each applied or
  failed action also writes an `activity_log` row, so staff see it where
  they already look.
- **Customer sign-in state**: a customer-bound copy of the staff helper
  (one-time claim, 15-minute life).
- **Routes** under `/api/property/sprinkler-timer`, behind the existing
  `authenticate`: read the card's state, save zones, save the pause
  setting, start a connect, run, stop, disconnect. Each read carries
  `available`, as the watering plan does, so the card disappears when the
  gate is off.
- **One public route**, the return from Hunter's sign-in. It trusts only
  the one-time state, finishes the link, and shows a small "You're
  connected, go back to the Waves app" page. It needs an entry in
  `server/config/public-route-allowlist.json` and in
  `docs/public-route-contracts.md`, and owner review of the allowlist
  entry.
- **Phone app**: Hunter's sign-in opens in Safari. The link completes on
  the server, and the card refreshes when the app regains focus, as the
  plan card does, so no app-store release is needed for this step.
- **Run** reads the published plan for the week. It refuses unless the
  plan's action is `run`, refuses during a pause, refuses when no
  restriction policy can be established for the home, and refuses more
  runs in a plan week than the plan prescribes. It starts only turf zones.
- **Disconnect and account deletion** destroy the tokens. Deletion today is
  a soft delete, so this is explicit code, not something inherited.
- **Gate** `GATE_IRRIGATION_CONTROLLER_CONNECT`, with a customer pilot list
  modelled on `PEST_FREQUENCY_CHANGE_CUSTOMER_ALLOWLIST`
  (`server/config/feature-gates.js:9547`). The named risk is acting on a
  customer's hardware.

### Step 3 · Pause after treatments

Its own gate. About 3 days.

- **Trigger**: in `completeScheduledService`, right after the instruction
  is saved and beside the watering text. When the saved state is `hold` or
  `hold_then_water_in`, `holdUntil` is a timestamp, the customer has an
  active link and the pause setting is on, write one ledger row.
- **No pause** for an "until dry" hold (there is no end time), a visit
  closed late, or a visit with no instruction. The customer's text and
  report still say what to do, exactly as today.
- **Never blocks a completion.** The row is written inside the existing
  best-effort block. A worker applies it straight away and a sweep cron
  retries, under `runExclusive` like every other cron.
- **Ends on the timer.** The pause is sent with its end time, so a Waves
  outage cannot leave a lawn paused.
- **When it fails**: retry for a short window, then one `raiseAdminAlert`
  with a dedupe key. The customer has already been told to keep the lawn
  dry, so a failure degrades to today's behavior.
- **Gate** `GATE_IRRIGATION_CONTROLLER_AUTO_PAUSE`, which needs the connect
  gate. The named risk is acting without a tap.

### Step 4 · Follow the weekly plan automatically

Its own gate and its own customer opt-in. About 5 days on top of steps 2
and 3.

- **What it does.** At the day and start time on file, Waves starts the
  turf zones for the week's minutes. A week whose plan is `hold` gets no
  run, so a skip week is real with nothing to pause. A plan with two runs
  uses two slots.
- **Who sets the time.** The customer picks their watering day and a start
  time once, the same statement they make today when they program a timer.
  The watering days are already on file (`watering_days`), so the sheet
  starts from them and only the start time is new.
  Where the restriction policy can establish the home's day or hours (the
  house-number weekday under a one-day order,
  `server/config/irrigation-restrictions.js:238`; `allowedHours` when the
  policy carries them), the app offers only those. Where it cannot, the
  customer confirms the day is their permitted one. Waves never picks a day
  it was not given and cannot establish.
- **Rain check, automatic.** The plan's own rule is that half an inch of
  rain before a run skips that run. Before each run the worker reads the
  rain at the home from the ladder Monday's plan already uses
  (`fetchServiceWeekWeather`, called in
  `server/services/irrigation-weekly-email.js`): NOAA radar rainfall at the
  home's coordinates first, Open-Meteo second (owner ruling 2026-07-30,
  `server/services/mrms-qpe.js`). It skips at half an inch or more.
- **A reading can be missing.** Both rungs are outside services, and the
  radar rung is a free university relay with no uptime promise. On
  2026-11-02 both failed for one home in 45.
  - Missing on Monday: there is no plan for that home that week, as today,
    so nothing runs. The office already gets a bell for it
    (`server/services/irrigation-rain-unknown-alert.js`). For a home on
    automatic runs that bell has to say the lawn will not be watered until
    someone decides.
  - Missing at run time: open, decision 8.
- **After a treatment.** A run that falls inside a pause waits for the
  pause to end and still has to land in a permitted slot. Otherwise it is
  dropped, the rule the report already applies (`renderWeekPlanNotBefore`,
  `server/services/irrigation-week-plan.js:539`).
- **The timer's own lawn schedule has to be empty.** Otherwise the lawn is
  watered twice. The opt-in says so, and the card warns while the timer
  still shows lawn runs of its own. Beds and drip keep their schedule.
- **Minutes.** The plan gives minutes only when the turf has one head type
  (`packages/irrigation-runtime/index.js:238`). A yard with spray and rotor
  zones needs each zone's head type marked on the zone screen. Until then
  it stays on the tap.
- **When a run cannot happen** (timer offline, Hunter unreachable, Waves
  down) the lawn is not watered. This is the reverse of today, where the
  timer waters no matter what the plan says. The card shows the missed run
  and offers Run; repeated misses raise one admin alert.
- **Plumbing.** The ledger and sweep cron from step 3. A week's runs are
  written when Monday's plan is published (the transaction that sets
  `published_at` in `server/services/irrigation-weekly-email.js`) and
  applied by the worker at their time.
- **The connect sheet changes** for a customer who switches this on: "never
  starts watering on its own" becomes "starts watering only at the day and
  time you set".
- **Gate** `GATE_IRRIGATION_CONTROLLER_AUTO_RUN`, which needs the connect
  gate. The named risk is starting water with nobody watching.

A safer form to ask Hunter about: carry the plan in the timer's own
schedule, by setting its run time each week, so the lawn is still watered
when Waves cannot reach it. The Hydrawise app's own API can change a
program's start times and zone run times (see "What each timer allows").
Whether Hunter would grant that to a commercial client is not established.

### Later, not scoped

- A skip week for a customer who keeps their own lawn schedule: Monday's
  `hold` would pause the turf zones for the week.
- Reading back what the timer did: confirming a water-in on the service
  report, and feeding measured watering into the next week's plan, which
  today assumes last week's prescription was followed.
- Text and email copy that mentions the pause.
- Rain Bird, if a partner route opens.

## Rules it sits under

- Watering restrictions are a hard limit above the model (owner
  2026-08-28). So steps 2 and 3 only remove water on their own, and a run
  needs the customer's tap and a plan that says run. Step 4 starts water
  without a tap, only at a day and time the customer set and the policy
  does not contradict.
- Never test on a real customer's record. Testing uses a bench timer (an X2
  with a WAND needs no valves to answer the API) and the owner's own
  account.
- Hands-off by default: a pause applies with a ledger row and no bell; only
  a failure surfaces. Each lane has its env kill switch, and the customer
  can disconnect in one tap.
- No change to customer texts or emails in these steps.
- Wording for a pause repeats the visit's own instruction ("Skip your turf
  watering until <time>",
  `server/services/service-report/lawn-watering-instruction.js:644`). Never
  a fixed drying or re-entry figure, and no product is ever called safe
  (AGENTS.md, compliance language on customer surfaces).
- This is the first outside credential stored per customer: encrypted,
  never logged, destroyed on disconnect and on account deletion.
- New public route: allowlist and contract entry in the same PR. New
  tables and the model list are contracts.
- Admin alerts go through `raiseAdminAlert`.
- Customer surface rules: glass theme, 16px prose, `npm run
  check:portal-brand`.
- Review tier is Full for steps 2 to 4 (schema, a public route, a
  credential store, unattended watering).

## Outside the code

1. **Hunter: asked 2026-11-19.** Sent through Hunter's Contact Sales form
   (the only written channel on its site; the old support form now
   redirects to the contact page), from contact@, in the owner's name. Hunter's
   page answered: "Thank you, our Sales Team will contact you soon." The
   request names the terms' notice and asks five things: whether Waves can
   apply or join a waiting list for the commercial (OAuth) API; whether
   there is an approved way meanwhile, such as a contractor account using
   its own API key for linked customers, or written permission for a
   customer to share their key; whether a customer can limit a contractor
   to suspending and running zones; whether a WAND bought today fits every
   X2; and what fees or branding rules apply.
2. **A bench timer**: an X2-600 (about $88) and a WAND (about $109). A
   purchase, so it needs the owner's yes.
3. **Licensing and insurance. Not settled, and the state rule is not
   friendly.** Florida's rule for the irrigation specialty contractor
   (Fla. Admin. Code R. 61G4-15.100(1)(q), read on Cornell LII) lists the
   work as "install, maintain, repair, alter, extend, manage, monitor,
   audit" irrigation systems, and says a system includes "irrigation
   controllers". "Manage" and "monitor" are the words that could reach
   pausing or running a customer's timer. The text does not mention a
   schedule, a pause or software, and no agency statement on timer
   settings was found. The minor-work exemption (s. 489.103(9), under
   $2,500) does not cover a person who advertises as a contractor. A 2026
   bill (SB 508) would have limited maintaining or servicing a system to a
   licensed irrigation contractor or the property owner; it died in
   committee on 2026-03-13 and could return. County rules for Manatee,
   Sarasota and Charlotte were not read. This needs an answer from a
   Florida construction-licensing attorney or DBPR, and from the insurer,
   before Waves pauses or runs any customer's timer, by API or by hand. A
   button the customer taps is the customer acting; that is the part least
   exposed.
4. **Rain Bird: not asked.** It has no written channel. The questions are
   ready: whether any API or partner program covers home Wi-Fi timers,
   whether the IQ4 third-party API covers a timer on the LNK2 module, and
   what a shared account in the Rain Bird app may do. Two ways to ask: the
   phone line (1-800-RAINBIRD), or the SiteOne branch, since the IQ4 API
   is sold through Rain Bird distributors.

## Decisions needed before build

1. **The published position.** Both hub guides say Waves does not configure
   timers. A pause the customer opted into changes a timer's setting. Does
   the position change, and how should the guides say it?
2. **Step 1 now?** It needs none of the other answers.
3. **Is the pause on from the moment a customer connects**, with the
   connect sheet as the consent, or off until they switch it on?
4. **How strict is Run?** Recommended: refuse unless the plan says run, and
   limit runs to the plan's count for the week, with the watering-day
   reminder on the sheet. The stricter option also refuses outside the
   home's day and hours wherever those can be established.
5. **The X2 screen.** May the app tell an X2 owner that a WAND module would
   let them connect? The Rain Bird guide currently tells plan customers
   they do not need a Wi-Fi module.
6. **Who installs a module** when a customer wants one: the customer, or an
   irrigation contractor Waves refers.
7. **The pilot list** after the bench test.
8. **Step 4.** Decided by the owner 2026-11-19: Waves may start watering
   on a schedule once the customer has switched that on, and the customer
   sets the day and time. Still open: what a run does when no rain reading
   can be had at run time. Recommended: retry through the allowed window,
   then run, because Monday's plan already found the lawn needs water and
   skipping on missing data leaves it dry.
9. **A hand pilot while Hunter's API is closed?** Open a free Hydrawise
   contractor account, link the owner's own timer and a few willing
   customers, and pause by hand after their treatments. No code. It shows
   whether customers want this and gives Hunter a reason to say yes. It
   waits on the licensing answer (item 3 above), because a contractor
   account acts on the customer's timer in Waves' name.

## Risks and unknowns

- Hunter's terms say it is not accepting new commercial API connections.
  Hunter may decline, not answer, or offer only the contractor route. The
  connect sheet's wording depends on the answer. Waves never asks a
  customer for their Hydrawise password.
- Reach rests on the owner's field read (most customers already on a
  Wi-Fi module and app) until step 1 has run for a few weeks. It covers
  only the Hunter share of those homes.
- A zone marked wrong pauses a bed, or leaves a turf zone running.
- A timer that has lost Wi-Fi cannot be paused. The card says so, and the
  customer's text still carries the instruction.
- Whether starting several zones queues them or replaces the running one
  is unknown until the bench test. The Hydrawise app's own API has a
  "stack runs" option and takes a run time per zone, which suggests they
  queue. If they do not, the run needs a small sequencer.
- Liability for a dry lawn, a watering-rule fine, or water from a broken
  head after Waves acted on a timer. Step 4 raises all three. Belongs with
  decisions 1 and 8 and the insurance question.
- Whether a run started through the API obeys the timer's rain sensor is
  unknown until the bench test. Step 4's own rain check does not depend on
  it.

## Sources

Read directly, 2026-11-19:
[Hydrawise API information](https://www.hunterirrigation.com/support/hydrawise-api-information),
[Hydrawise API terms](https://www.hunterirrigation.com/support/hydrawise-api-terms-use),
[Hydrawise REST API v1.6](https://www.hunterirrigation.com/sites/default/files/2026-05/Hydrawise%20REST%20API%20Ver%201.6_0.pdf),
[Hydrawise contractor plans](https://www.hunterirrigation.com/en-metric/support/hydrawise-managing-plans),
[Hydrawise: add a customer](https://www.hunterirrigation.com/support/hydrawise-app-add-customer),
[Hunter: contact sales](https://www.hunterirrigation.com/get-hunter/contact-sales),
[pydrawise schema](https://github.com/dknowles2/pydrawise/blob/main/pydrawise/hydrawise.graphql),
[Rain Bird contact page](https://www.rainbird.com/corporate/contact-us),
[Fla. Admin. Code R. 61G4-15.100](https://www.law.cornell.edu/regulations/florida/Fla-Admin-Code-Ann-R-61G4-15-100),
[s. 489.103, Fla. Stat.](http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0400-0499/0489/Sections/0489.103.html),
[SB 508 (2026)](https://flsenate.gov/Session/Bill/2026/508),
[Rain Bird app sharing](https://wifi.rainbird.com/articles/how-to-share-controller-access-in-rain-bird-2-0-app/),
[Google Home APIs device types](https://developers.home.google.com/apis/supported-devices).

Web search summaries, 2026-11-19:
[Hunter WAND](https://www.hunterirrigation.com/en-metric/irrigation-product/wand),
[Hunter HPC panel compatibility](https://www.hunterindustries.com/support/hydrawise-hpc-panel-compatible),
[Pro-C generations](https://hunterirrigation.com/support/pro-c-module-compatibility),
[PC-WIFI module](https://cheapsprinklers.com/products/hunter-pc-wifi-pro-c-wifi-module-p2c-model-only),
[Home Depot X2-600](https://www.homedepot.com/p/Hunter-Industries-6-Station-Outdoor-Irrigation-Controller-X2-600/326937264),
[Home Depot WAND](https://www.homedepot.com/p/Hunter-Industries-Wi-Fi-Module-for-X2-Outdoor-Irrigation-Controller-WAND/326937618),
[WAND review with the December 2022 claim](https://www.trimjim.org/hunter-industries-wand-wifi-module-review-the-smart-upgrade-your-x2-controller-is-missing/),
[Rain Bird LNK2](https://store.rainbird.com/lnk-wifi-module-1.html),
[Rain Bird local integration](https://www.home-assistant.io/integrations/rainbird/),
[Rain Bird acquires Rachio](https://www.rainbird.com/corporate/press-releases/rain-bird-acquires-rachio-inc-expanding-leadership-smart-sustainable).
