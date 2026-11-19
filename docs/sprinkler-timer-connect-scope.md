# Sprinkler timer connect — scope

Concept scope · Waves Lawn Care · 2026-11-19. **Nothing here is built.** The
only code is a screen prototype in the dev preview harness (see "Screens").
The build waits on the owner decisions at the bottom and on Hunter granting
API access.

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
- Scope the build and show the screens in the app.
- Can the weekly watering email drive the timer: when it says water 20
  minutes this week, the timer runs 20 minutes at a set time, with no tap.
  This is step 4.

## Verdict

Worth building for Hunter, in four steps. Rain Bird stays on the hand-run
guides until Rain Bird offers a way in.

- The portal already decides what each lawn needs: the Monday watering plan
  and the per-product "keep it dry" or "water it in" instruction after each
  visit. The only missing piece is the last step to the timer.
- Hunter is the one brand of the two with an official API (Hydrawise). It
  reaches a Hunter only once that timer is on Hydrawise, which for the X2
  means a plug-in Wi-Fi module.
- Rain Bird has no public API for home timers. Nothing in this scope can
  reach one.
- Step 1 (record which timer each customer has) needs no vendor and ships
  on its own. It also gives the number that decides how much the later
  steps are worth: nothing on file today says how many homes are on
  Hydrawise.
- Step 4 is the one that makes the weekly plan run itself. It is also the
  only step where Waves starts water with nobody watching, so it comes
  last and carries the most conditions.

## What the app would do

| | What happens | Who starts it |
|---|---|---|
| Record the timer | Customer or staff picks the brand and model. The card then shows the one matching guide. | Customer or staff |
| Connect | Customer signs in with their Hydrawise account and marks which zones water grass. | Customer |
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
| `ready`, `consent` | On Hydrawise, not connected; the connect sheet |
| `zones` | Just connected: mark the turf zones |
| `connected`, `confirm` | Normal week; the run sheet |
| `running` | A run in progress, with Stop |
| `paused` | Turf zones paused after a treatment |
| `offline` | Timer unreachable |
| `rainbird`, `xcore` | Timers that cannot connect: guide only |

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
| Staff can already edit a customer's irrigation details with the same validator the portal uses. | `PUT /api/admin/customers/:id/property-preferences`, `server/routes/admin-customers.js:5257`; `client/src/components/admin/Customer360ProfileV2.jsx:7593`. |
| No customer has ever linked an outside account. Outside tokens today belong to the company (Bouncie, Plaid, Google). | Closest pattern: encrypted at rest, refuses to store with no key, `server/services/plaid-sync.js:43`. |
| The sign-in "state" helper is tied to staff. A customer version is new. | `server/services/staff-oauth-state.js:52`. |
| Watering restrictions are resolved per county and return nothing when they cannot be established. | `currentRestrictionPolicy`, `server/config/irrigation-restrictions.js:200`. A weekday-by-house-number helper exists (`:238`) but only the pre-visit line uses it. |
| The phone app is a shell around the hosted portal. A link to another site opens in Safari. | `client/capacitor.config.json`; `docs/mobile/capacitor-ios-spike.md:131`. |
| Deleting an account is a soft delete. Anything that must be destroyed has to be destroyed explicitly. | `server/routes/auth.js:857`. |
| The published position is that Waves does not touch timers. | Hub guides (astro repo): "Waves doesn't install, set up Wi-Fi on, configure or repair irrigation controllers", `src/content/blog/lawn-care/hunter-sprinkler-timer-guide.mdx:147` and `rain-bird-sprinkler-timer-guide.mdx:156`; "You do not need to ... buy the Wi-Fi module", `rain-bird-sprinkler-timer-guide.mdx:94`. |

## What each timer allows

Checked 2026-11-19 by web search. The vendor sites could not be opened from
the session, so these come from search summaries of the vendors' own pages
and retailer listings. Prices are retail on that date.

| Timer | Reachable by the Waves app | What it takes |
|---|---|---|
| Hunter HC, Pro-HC, HPC | Yes | Nothing; already on Hydrawise |
| Hunter X2 | Yes, once on Hydrawise | WAND plug-in module, about $100 to $110. Installing it disables the dial and erases the stored schedule. |
| Hunter Pro-C, 2023 on (P2C) | Yes, once on Hydrawise | PC-WIFI plug-in module, about $190 |
| Hunter Pro-C, 2014 to 2023 (blue buttons) | Yes, once on Hydrawise | HPC face panel, about $180 to $270 |
| Hunter Pro-C before 2014 (green buttons) | No | A new timer |
| Hunter X-Core | No | No upgrade found; a new timer |
| Rain Bird ESP-TM2, ESP-Me3, ESP-Me after Nov 2016 | No | The LNK2 module (about $90 to $145) puts it on Rain Bird's app, but there is no API for Waves to call |

Hunter's API, as far as it could be established:

- Two official APIs. A simple one meant for a homeowner's own use, whose
  terms bar sharing the key with a third party. A GraphQL + OAuth one that
  Hunter positions for commercial apps and grants on request.
- The simple API documents run a zone for a set time, stop, and suspend
  zones for a set time, limited to 3 start, stop or suspend calls per 30
  seconds and 30 calls per 5 minutes per user.
- Not established: the commercial API's operations, limits, sign-in flow,
  terms, fees and any branding rules. These are the questions for Hunter.

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

Dark behind a gate. Starts after Hunter grants access and the bench test
passes. About 8 working days across four PRs.

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
when Waves cannot reach it. Whether the API can change a schedule is not
established.

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

1. **Ask Hunter for commercial API access** (their page says to use the
   support form with "GraphQL" in the subject), with six questions: what
   the sign-in flow is; whether one zone can be suspended until a set time
   and run for a set time; whether a schedule's run time can be changed;
   the call limits; the terms, fees and branding rules; and whether the
   WAND fits every X2 (one review says only those built after December
   2022).
2. **A bench timer**: an X2-600 (about $88) and a WAND (about $109).
3. **Licensing and insurance**: whether a lawn company changing a setting
   on a customer's timer counts as irrigation contracting in Florida or the
   counties served. Not settled here.
4. **Rain Bird**: ask Rain Bird, and Rachio which it owns, whether any API
   covers home timers.

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

## Risks and unknowns

- Hunter may decline or limit access, or its sign-in may have the customer
  type their Hydrawise password into a Waves page. The connect sheet's
  wording depends on the answer, and a password would never be stored.
- Reach is unknown until step 1 has run for a few weeks. It covers only
  homes on Hydrawise.
- A zone marked wrong pauses a bed, or leaves a turf zone running.
- A timer that has lost Wi-Fi cannot be paused. The card says so, and the
  customer's text still carries the instruction.
- Whether starting several zones queues them or replaces the running one
  is unknown until the bench test. If they do not queue, the run needs a
  small sequencer.
- Liability for a dry lawn, a watering-rule fine, or water from a broken
  head after Waves acted on a timer. Step 4 raises all three. Belongs with
  decisions 1 and 8 and the insurance question.
- Whether a run started through the API obeys the timer's rain sensor is
  unknown until the bench test. Step 4's own rain check does not depend on
  it.

## Sources

Web, 2026-11-19:
[Hydrawise API information](https://www.hunterirrigation.com/support/hydrawise-api-information),
[Hydrawise API terms](https://www.hunterirrigation.com/support/hydrawise-api-terms-use),
[Hydrawise REST limits](https://hydrawise.com/printpdf/api/printsupport/en-us/article/360008965753),
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
