/**
 * Public "pick a time" flow — ONE page behind two token routes:
 *
 *   /reschedule/:token  (flow="reschedule")  move a scheduled visit
 *   /reservice/:token   (flow="reservice")   book the FREE between-visit callback
 *
 * The two pages this replaces (ReschedulePage / ReservicePage) were the same
 * shape — load a token, render by state, pick a slot in the shared
 * SchedulePicker, POST it, show success — with a duplicated shell and two
 * different Waves AI search surfaces. They now share the shell, the
 * loader, the picker wiring, the SLOT_TAKEN / state-changed recovery and
 * the estimate's Ask Waves card; only the hero, the eligibility states, the
 * success card and the POST body differ per flow (owner ask 2026-09-04:
 * merge the two as their own PR). Endpoints, payload shapes and error codes
 * are unchanged — the public /:token contracts are untouched.
 *
 * Reschedule: linked from the appointment confirmation / 72h / 24h reminder
 * texts and emails. Single visit only — a recurring plan's other visits
 * never move from here (the page says so). The pre-V2 layout that lived
 * behind ?classic=1 is gone (owner 2026-09-04).
 *
 * Re-service: the standing customer link (customers.reservice_token) an
 * active recurring / WaveGuard customer uses to book their free callback.
 * A lane that already has an open callback renders that visit's
 * /reschedule link instead of double-booking; the success card hands back
 * the NEW visit's /reschedule link.
 *
 * Styling: the estimate grammar (owner 2026-09-03) — WavesShell customer
 * variant, the FLOW column, estimate cards, DOC_EYEBROW. The
 * page mounts the glass scene unconditionally; the inline styles are the
 * base render the glass layer restyles.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { COLORS, FONTS } from '../theme-brand';
import { DOC_EYEBROW, FLOW_COLUMN_MAX } from '../theme-doc';
import { estimateCard } from '../components/estimate/cardStyles';
import { WavesShell } from '../components/brand';
import Icon from '../components/Icon';
import { useGlassSurface } from '../glass/glass-engine';
import SchedulePicker from '../components/booking/SchedulePicker';
import {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_TEL,
  WAVES_SUPPORT_SMS_TEL,
} from '../constants/business';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const FONT_BODY = "'Inter', system-ui, sans-serif";
const S = {
  page: '#FAF8F3',
  soft: '#F8FCFE',
  softBorder: '#CFE7F5',
  text: '#04395E',
  body: '#3F4A65',
};

const PRIMARY_CTA = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  minHeight: 48,
  padding: '0 20px',
  background: COLORS.glassNavy,
  color: COLORS.white,
  border: `1px solid ${COLORS.glassNavy}`,
  borderRadius: 10,
  fontFamily: FONTS.ui,
  fontWeight: 700,
  fontSize: 16,
  cursor: 'pointer',
  textDecoration: 'none',
};

const SOFT_NOTE = {
  background: S.soft, border: `1px solid ${S.softBorder}`, borderRadius: 10,
  padding: '10px 12px', fontSize: 14, color: S.body, lineHeight: 1.5,
};

// ───────────────────────────── shared shell ─────────────────────────────

function Page({ children }) {
  return (
    <WavesShell variant="customer" topBar="solid">
      <div style={{ flex: 1, padding: '24px 16px 40px', maxWidth: FLOW_COLUMN_MAX, width: '100%', margin: '0 auto', fontFamily: FONT_BODY, color: S.text }}>
        {children}
      </div>
    </WavesShell>
  );
}

function Card({ children, style, ...rest }) {
  return (
    <div data-glass="card" {...rest} style={estimateCard(style)}>
      {children}
    </div>
  );
}

function CardTitle({ children }) {
  return (
    <div data-gt="h3x" style={{ fontSize: 20, fontWeight: 700, fontFamily: FONTS.heading, marginBottom: 8 }}>
      {children}
    </div>
  );
}

function ContactRow() {
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
      <a href={WAVES_SUPPORT_SMS_TEL} data-glass-accent="" style={{ ...PRIMARY_CTA, flex: 1 }}>Text Waves</a>
      <a href={WAVES_SUPPORT_PHONE_TEL} data-glass-accent="" style={{ ...PRIMARY_CTA, flex: 1 }}>Call Waves</a>
    </div>
  );
}

// Dates are 'YYYY-MM-DD'; windows are 'HH:MM'. Format in place so the
// customer sees the appointment exactly as scheduled (ET wall-clock values).
function formatDateLabel(dateStr) {
  if (!dateStr) return '';
  try {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return dateStr;
  }
}

function formatTimeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

// The arrival window promised to the customer is 2 HOURS from the visit's
// window start (owner directive; matches the estimate SlotPicker and the
// window_start + 2h promise the late detector enforces). The API's
// windowStart/windowEnd echo the job-duration block that sizes scheduling —
// never show windowEnd as the arrival window.
const ARRIVAL_WINDOW_MINUTES = 120;

function arrivalEndHHMM(start) {
  const [h, m] = String(start || '').split(':').map(Number);
  if (Number.isNaN(h)) return null;
  const total = (h * 60 + (m || 0) + ARRIVAL_WINDOW_MINUTES) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function arrivalWindowLabel(start) {
  const s = formatTimeLabel(start);
  if (!s) return '';
  const e = formatTimeLabel(arrivalEndHHMM(start));
  return e ? `${s}–${e}` : s;
}

function SkeletonCard() {
  return (
    <Card>
      <div style={{ height: 18, width: '55%', background: S.page, borderRadius: 6, marginBottom: 12 }} />
      <div style={{ height: 14, width: '80%', background: S.page, borderRadius: 6, marginBottom: 8 }} />
      <div style={{ height: 14, width: '65%', background: S.page, borderRadius: 6 }} />
    </Card>
  );
}

function NotFoundCard({ title, body }) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div style={{ fontSize: 16, color: S.body, lineHeight: 1.55 }}>{body}</div>
      <ContactRow />
    </Card>
  );
}

function LoadErrorCard({ title, onRetry }) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div style={{ fontSize: 16, color: S.body, lineHeight: 1.55 }}>
        This looks temporary. Your link is still valid—try again in a moment.
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{ marginTop: 16, border: 0, borderRadius: 10, padding: '11px 16px', background: COLORS.glassNavy, color: '#fff', font: 'inherit', fontWeight: 700, cursor: 'pointer' }}
      >
        Try again
      </button>
    </Card>
  );
}

function HelpCard({ children }) {
  return (
    <Card data-glass="soft" style={{ background: S.page }}>
      <div style={{ fontSize: 14, color: S.body, lineHeight: 1.55 }}>{children}</div>
      <ContactRow />
    </Card>
  );
}

function EmptyTimesCard({ aiFiltered }) {
  return (
    <Card>
      <div style={{ fontSize: 16, color: S.body, lineHeight: 1.55 }}>
        {aiFiltered
          ? 'No open times match that search — try another day, or show all open times above.'
          : "We don't have open times to offer online right now. Text or call us and we'll find a time that works."}
      </div>
      {aiFiltered ? null : <ContactRow />}
    </Card>
  );
}

// ───────────────────────────── Ask Waves card ─────────────────────────────
// The estimate's Ask Waves card (owner 2026-09-03: the estimate is the
// template; 2026-09-04: the reschedule marquee becomes this card). Same
// anatomy and `waves-ask-*` classes as the service report's card: eyebrow,
// heading, intro, input + button, stacked example rows. The answer here is
// the search's summary line, and while a search filters the calendar the
// status row carries the "Show all open times" reset — it is the state
// indicator, so it can't be dismissed away.

const ASK_PROMPTS = ['Tomorrow morning', 'This weekend', 'Next week', 'Saturday', 'Late afternoon'];

function AskCard({ onSearch, aiFiltered, onShowAll }) {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState(null); // { text, isError }

  const ask = async (text) => {
    const q = String((text ?? question) || '').trim();
    if (!q || asking) return;
    setAsking(true);
    setNotice(null);
    try {
      const res = await onSearch(q);
      setNotice(res?.summary ? { text: res.summary, isError: false } : null);
    } catch {
      setNotice({ text: `I couldn't search right now. Text or call ${WAVES_SUPPORT_PHONE_DISPLAY} and we'll find a time.`, isError: true });
    } finally {
      setAsking(false);
    }
  };

  return (
    <section data-glass="card" className="waves-ask-card" aria-label="Waves AI — search for a day or time" style={estimateCard({ display: 'grid', gap: 12 })}>
      <div data-gt="eyebrow" className="waves-ask-eyebrow" style={{ ...DOC_EYEBROW, marginBottom: 0 }}>Waves AI</div>
      <h2 className="waves-ask-title" style={{ fontFamily: FONTS.serif, fontSize: 24, fontWeight: 500, lineHeight: 1.2, color: S.text, margin: 0 }}>
        Search for a day or time
      </h2>
      <p className="waves-ask-intro" style={{ margin: 0, fontSize: 16, color: S.body, lineHeight: 1.5 }}>
        Tell us when works — a day, a time of day, or both — and we&apos;ll show the openings that match.
      </p>
      <div className="waves-ask-form" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'center' }}>
        <input
          id="schedule-ask-input"
          name="schedule_ask_input"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              ask();
            }
          }}
          placeholder="Anything next Tuesday afternoon"
          maxLength={500}
          aria-label="Search for a service date or time"
          style={{ minHeight: 48, padding: '12px 16px', fontSize: 16, border: `1px solid ${S.softBorder}`, borderRadius: 10, background: '#fff', color: S.text, font: 'inherit', boxSizing: 'border-box', width: '100%' }}
        />
        <button
          data-glass-accent=""
          type="button"
          onClick={() => ask()}
          disabled={asking || !question.trim()}
          style={{ minHeight: 48, padding: '0 20px', border: 0, borderRadius: 10, background: COLORS.yellow, color: S.text, font: 'inherit', fontSize: 16, fontWeight: 700, cursor: 'pointer' }}
        >
          {asking ? 'Checking…' : 'Search'}
        </button>
      </div>
      <div data-glass="soft" role="list" className="waves-ask-list" aria-label="Example searches" style={{ display: 'grid', padding: '0 14px', borderRadius: 10, background: S.soft, border: `1px solid ${S.softBorder}` }}>
        {ASK_PROMPTS.map((prompt, i) => (
          <div key={prompt} role="listitem">
            <button
              type="button"
              className="waves-ask-row"
              data-first={i === 0 ? '' : undefined}
              onClick={() => ask(prompt)}
              disabled={asking}
              style={{
                display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 12,
                width: '100%', minHeight: 44, padding: '10px 0', border: 0,
                borderTop: i === 0 ? 0 : '1px solid rgba(4, 57, 94, 0.12)', borderRadius: 0,
                background: 'transparent', color: S.text, font: 'inherit', fontSize: 14, fontWeight: 500,
                lineHeight: 1.35, textAlign: 'left', cursor: asking ? 'not-allowed' : 'pointer', opacity: asking ? 0.65 : 1,
              }}
            >
              <span>{prompt}</span>
              <span aria-hidden="true" className="waves-ask-go" style={{ fontSize: 14, fontWeight: 600, color: S.body }}>Search ›</span>
            </button>
          </div>
        ))}
      </div>
      {(notice || aiFiltered) ? (
        <div role="status" data-glass="soft" style={{ ...SOFT_NOTE, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <span>{notice ? notice.text : 'Showing the times that match your search.'}</span>
          {aiFiltered ? (
            <button
              type="button"
              onClick={onShowAll}
              style={{ border: 0, background: 'transparent', color: COLORS.glassNavy, font: 'inherit', fontSize: 14, fontWeight: 700, textDecoration: 'underline', cursor: 'pointer', whiteSpace: 'nowrap', padding: 0 }}
            >
              Show all open times
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              style={{ border: 0, background: 'transparent', color: S.body, fontSize: 14, lineHeight: 1, padding: '2px 4px', cursor: 'pointer' }}
            >
              <Icon name="close" size={14} strokeWidth={2} />
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

// ───────────────────────────── reschedule flow ─────────────────────────────

// Days `target` sits EARLIER than `current` (YYYY-MM-DD strings; UTC-noon
// parse). Mirrors the server's pullForwardDays — the server is authoritative,
// this only drives the pre-confirm warning copy.
function pullForwardDaysBetween(currentDate, targetDate) {
  const cur = new Date(`${String(currentDate || '').split('T')[0]}T12:00:00Z`).getTime();
  const tgt = new Date(`${String(targetDate || '').split('T')[0]}T12:00:00Z`).getTime();
  if (!Number.isFinite(cur) || !Number.isFinite(tgt)) return 0;
  return Math.round((cur - tgt) / 86400000);
}

// True when confirming this slot will re-anchor the whole recurring series
// (big pull-forward). Threshold comes from the server payload.
function slotReanchors(data, slotDate) {
  const threshold = data?.reanchorPullForwardDays;
  if (!threshold || !slotDate) return false;
  return pullForwardDaysBetween(data?.current?.date, slotDate) >= threshold;
}

// The recurring-plan note under the hero. Collective anchoring (server gate
// GATE_COLLECTIVE_SERIES_ANCHOR via payload.collectiveAnchor — owner ruling
// 2026-07-30): every date move shifts the series, so one steady sentence
// replaces the legacy conditional pull-forward warning.
function recurringNoteCopy(data, selectedSlot) {
  const changesSeries = data?.collectiveAnchor
    ? !selectedSlot || String(selectedSlot.date) !== String(data?.current?.date || '')
    : selectedSlot && slotReanchors(data, selectedSlot.date);
  if (data?.futurePlacementDays === 3 && changesSeries) {
    return 'Your selected appointment will be confirmed. Later visits will follow the new schedule, with each day and time arranged within 3 days of its due date. Existing appointment commitments will be reviewed separately.';
  }
  if (data?.collectiveAnchor) {
    // A same-date selection is a time-only move — the server's
    // shouldReanchor never shifts the series for it, so the note must not
    // promise a shift the commit won't perform (codex P1).
    if (selectedSlot && String(selectedSlot.date) === String(data?.current?.date || '')) {
      return "Only this visit will move — a same-day time change doesn't shift the rest of your plan.";
    }
    // "Re-anchors around the new date", not "shifts by the same amount":
    // month-based patterns re-derive the ordinal/weekday from the new
    // anchor (first-Thursday → first-Sunday), so sibling deltas differ from
    // the anchor's (codex P1) — the promise must describe re-anchoring.
    return 'This visit is part of your regular plan — moving it to a different day re-anchors your later visits around the new date, so your schedule always follows your last treatment.';
  }
  return selectedSlot && slotReanchors(data, selectedSlot.date)
    ? 'This time is far enough ahead of your current date that your following visits will shift to match it — your regular schedule follows the new date.'
    : 'Only this visit will move — the rest of your regular service schedule stays the same.';
}

function ReanchorNote({ futurePlacementDays }) {
  return (
    <div data-glass="soft" style={{
      background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10,
      padding: '10px 12px', fontSize: 14, color: '#9A3412', lineHeight: 1.5,
    }}>
      {futurePlacementDays === 3
        ? 'Your selected appointment will be confirmed. We’ll arrange later visits within 3 days of their new due dates.'
        : 'Heads up — moving this far up shifts your whole plan: your following visits will move to match the new date, keeping your regular schedule.'}
    </div>
  );
}

// ── "Moved for weather" banner ──────────────────────────────────────────
// Renders only when the GET payload carries `weatherMove` (server gate
// GATE_RAINOUT_MOVE_BANNER + the visit still sits on a recent rain-out
// move). Status badge, heading, then matched Was/Now rows — the design spec
// is the owner-approved mock from the 2026-07-30 session. Weather chips are
// the rain blue on BOTH rows (owner call: one weather color, sun icon only
// signals the dry side). The non-weather Quick Move reasons (running late,
// equipment trouble, emergency, no-show) reuse the same banner with a
// "Schedule update" badge, an operational heading, and no chips (the server
// never fetches chances for them).

const WEATHER_MOVE_BLUE = '#0369A1';

const WEATHER_MOVE_LEADS = {
  weather_rain: 'rain moved your',
  weather_lightning: 'lightning moved your',
  weather_wind: 'wind moved your',
  weather_heat: 'extreme heat moved your',
};

// The bonding explainer is a RAIN story about exterior liquid PEST sprays —
// the one service family whose products the owner-approved copy (liquid,
// microencapsulated) actually describes. FAIL CLOSED (codex r5): a positive
// allowlist, because a denylist kept letting non-spray work through (rodent
// exclusion, bed-bug heat/steam, lawn fertilizers). Interior/granular/
// termite/WDO/inspection/bait still carve out overlaps like "Interior Pest"
// — same exemption set as the SMS efficacy clause in services/rain-out.js.
// Mosquito is deliberately NOT listed: those visits can be Bti tablets,
// stations, or IGR/larval work (protocols.json), not barrier sprays.
// Cleanouts pass the \bpest\b allowlist by name but run on gel bait,
// vacuuming, and point-source IGR (roach cleanout protocol) — exempted.
// Widening the allowlist to another service family is an owner call.
const WHY_MOVE_LIQUID_SPRAY_SERVICE = /\bpest\b|waveguard/i;
const WHY_MOVE_EXEMPT_SERVICE = /interior|granular|termite|wdo|inspection|bait|cleanout|roach|setup|rodent|appointment/i;

function showsWhyMove(move, serviceType) {
  const st = String(serviceType || '');
  return move?.reasonCode === 'weather_rain'
    && WHY_MOVE_LIQUID_SPRAY_SERVICE.test(st)
    && !WHY_MOVE_EXEMPT_SERVICE.test(st);
}

function WeatherMoveChip({ chance }) {
  if (chance == null || !Number.isFinite(Number(chance))) return null;
  // Icon follows the FORECAST, not which row it sits on — the rain-out
  // chooser doesn't guarantee a dry destination, so a sun beside "90% rain"
  // must be impossible (codex r3 P2). Same ≤40% bar as the dry-heading rule.
  const sunny = Number(chance) <= 40;
  return (
    <span data-glass="chip" data-glass-pill="" style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
      fontSize: 14, fontWeight: 700, color: WEATHER_MOVE_BLUE,
      background: `${WEATHER_MOVE_BLUE}1A`, padding: '4px 10px', borderRadius: 9999,
      whiteSpace: 'nowrap',
    }}>
      <Icon name={sunny ? 'sun' : 'cloudRain'} size={12} style={{ verticalAlign: '-2px' }} />
      {' '}{Math.round(Number(chance))}% rain
    </span>
  );
}

function WeatherMoveRow({ label, date, windowStart, chance, isNow }) {
  return (
    <div data-glass="soft" style={{
      display: 'flex', alignItems: 'center', gap: 12,
      background: isNow ? S.soft : S.page,
      border: `1px solid ${isNow ? S.softBorder : '#E7E2D7'}`,
      borderRadius: 10, padding: 14, marginTop: isNow ? 8 : 16,
    }}>
      <span style={{
        fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em',
        width: 44, flexShrink: 0, color: isNow ? '#0E7490' : S.body,
      }}>
        {label}
      </span>
      <span style={{
        flex: 1, fontSize: 16, fontWeight: 600, lineHeight: 1.3,
        color: isNow ? S.text : S.body,
        ...(isNow ? {} : { textDecoration: 'line-through', textDecorationColor: '#E7E2D7' }),
      }}>
        {formatDateLabel(date)}
        {windowStart ? (
          <small style={{ display: 'block', fontSize: 14, fontWeight: 500, color: S.body }}>
            Arrival {arrivalWindowLabel(windowStart)}
          </small>
        ) : null}
      </span>
      <WeatherMoveChip chance={chance} />
    </div>
  );
}

// Non-weather Quick Move reasons: no "dry/better window" claim, just the
// honest operational story ahead of the was/now rows. Date-neutral on
// purpose — this banner can be opened up to 14 days after the move
// (WEATHER_MOVE_MAX_AGE_DAYS), so "today" would misdate the story; the
// SMS keeps "today" because it goes out in the moment. The was/now rows
// right below carry the actual dates.
const SCHEDULE_MOVE_LEADS = {
  running_late: 'our schedule ran behind',
  equipment_issue: 'equipment trouble slowed us down',
  tech_emergency: 'an emergency came up on our end',
  customer_noshow: 'we missed you',
  gate_locked: "we couldn't get through the gate",
  // Custom Quick Move: the dispatcher's specific reason lives only in the
  // SMS itself — the banner keeps a generic honest lead (the was/now rows
  // below carry the facts).
  custom: 'our schedule changed',
};

function weatherMoveHeading({ move, firstName, serviceType }) {
  const hi = firstName ? `Hi ${firstName} — ` : '';
  const svc = (serviceType || 'service').toLowerCase();
  if (SCHEDULE_MOVE_LEADS[move.reasonCode]) {
    return `${hi}${SCHEDULE_MOVE_LEADS[move.reasonCode]}, so we moved your ${svc} to a new window.`;
  }
  const lead = WEATHER_MOVE_LEADS[move.reasonCode] || 'weather moved your';
  // "Dry" only when the forecast actually supports it — same ≤40% bar the
  // SMS better-day clause uses; no forecast coverage means no dry claim
  // (the rain-out chooser doesn't enforce a dry target, so reasonCode alone
  // can't promise one).
  const dry = (move.reasonCode === 'weather_rain' || move.reasonCode === 'weather_lightning')
    && move.toChance != null && Number(move.toChance) <= 40;
  return `${hi}${lead} ${svc} to a ${dry ? 'dry' : 'better'} window.`;
}

function WeatherMoveBanner({ move, serviceType }) {
  if (!move) return null;
  return (
    <Card style={{ borderTop: `3px solid ${WEATHER_MOVE_BLUE}` }}>
      <WeatherMoveRow label="Was" date={move.from?.date} windowStart={move.from?.windowStart} chance={move.fromChance} isNow={false} />
      <WeatherMoveRow label="Now" date={move.to?.date} windowStart={move.to?.windowStart} chance={move.toChance} isNow />

      {showsWhyMove(move, serviceType) ? (
        <details data-glass="soft" style={{
          marginTop: 12, background: S.soft, border: `1px solid ${S.softBorder}`, borderRadius: 10,
        }}>
          <summary style={{
            listStyle: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
            padding: 14, fontSize: 16, fontWeight: 600, color: S.text,
          }}>
            Why the move?
            <Icon name="chevronDown" size={16} style={{ marginLeft: 'auto', color: S.body }} />
          </summary>
          <div style={{ padding: '0 14px 14px', fontSize: 14, color: S.body, lineHeight: 1.5 }}>
            Our liquid treatments need a dry surface and a few hours to bond after
            application. Rain during or right after a visit can wash product away before it
            binds — which means weaker protection for your home. Once a treatment has dried
            and bonded, rain matters much less: select formulations we use are
            microencapsulated — the active ingredient rides in microscopic capsules that
            lock onto treated surfaces and release gradually — adding residual staying power
            against everyday Southwest Florida rain. No application is weatherproof, though,
            which is exactly why we re-time visits around heavy rain — always at no charge
            to you.
          </div>
        </details>
      ) : null}
    </Card>
  );
}

const INELIGIBLE_COPY = {
  completed: 'This visit is already complete, so there is nothing to reschedule.',
  cancelled: 'This appointment was cancelled. Text or call us and we\'ll get you back on the calendar.',
  in_progress: 'Your technician is already on the way for this visit, so it can\'t be moved online.',
  past: 'This visit\'s scheduled time has passed, so it can\'t be moved online.',
  not_available: 'This appointment can\'t be rescheduled online.',
  // C4: the account behind this token is no longer active — a cancelled
  // customer's surviving visits are handled by the office, not self-serve.
  account_inactive: 'This account isn\'t active anymore, so this visit can\'t be moved online.',
  // Grouped visit (two or more services at one stop): the office moves the
  // whole visit together; self-serve is staff-only for now (#3609).
  grouped: 'This appointment includes more than one service, so it can\'t be moved online yet. We\'ll move the whole visit together for you.',
};

function IneligibleCard({ data }) {
  const reasonCopy = INELIGIBLE_COPY[data?.reason] || INELIGIBLE_COPY.not_available;
  return (
    <Card>
      <CardTitle>{data?.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}we can&apos;t move this one online</CardTitle>
      <div style={{ fontSize: 16, color: S.body, lineHeight: 1.55 }}>
        {reasonCopy} Need a hand? Text or call and our team will help.
      </div>
      <ContactRow />
    </Card>
  );
}

// Hero: badge → eyebrow → serif title → meta line (the estimate / contract /
// prep header order), floating on the scene. When the payload carries a
// weather move the banner story IS the greeting (owner ask 2026-07-30): the
// badge + move heading lead, the was/now card follows, and the hero below
// reframes as the optional "different time?" ask — the moved-to slot is
// already confirmed.
function RescheduleHero({ data, selectedSlot }) {
  const current = data?.current || {};
  const move = data.weatherMove;
  return (
    <>
      {move ? (
        <div style={{ margin: '8px 2px 20px' }}>
          {/* The move's classification stays, as the eyebrow (no chip —
              owner 2026-09-04): a schedule move must never read as weather. */}
          <div data-gt="eyebrow" style={DOC_EYEBROW}>
            {SCHEDULE_MOVE_LEADS[move.reasonCode] ? 'Schedule update' : 'Moved for weather'}
          </div>
          {/* h2, not h1: the glass type ramp sizes headings by tag, and the
              owner sized the weather flow one step down (2026-07-30). */}
          <h2 style={{ margin: 0, fontFamily: FONTS.serif, fontSize: 26, fontWeight: 500, lineHeight: 1.15, color: S.text }}>
            {weatherMoveHeading({ move, firstName: data.customerFirstName, serviceType: data.service?.type })}
          </h2>
        </div>
      ) : null}
      <WeatherMoveBanner move={move} serviceType={data.service?.type} />
      <div style={{ margin: '8px 2px 20px' }}>
        {move ? (
          <h2 style={{ margin: 0, fontFamily: FONTS.serif, fontSize: 26, fontWeight: 500, lineHeight: 1.15, color: S.text }}>
            Want a different time instead?
          </h2>
        ) : (
          <>
            <div data-gt="eyebrow" style={DOC_EYEBROW}>Reschedule</div>
            <h1 style={{ margin: 0, fontFamily: FONTS.serif, fontSize: 'clamp(30px, 5vw, 40px)', fontWeight: 500, lineHeight: 1.1, color: S.text }}>
              Hey {data.customerFirstName || 'there'}, {data.missed ? 'looks like we missed each other' : "let's pick a new time"}
            </h1>
          </>
        )}
        <div style={{ marginTop: 12, color: S.body, fontSize: 16, lineHeight: 1.55 }}>
          {move ? (
            <>
              Your new time is confirmed — nothing else to do. Or pick any
              open time below and we&apos;ll move it again.
            </>
          ) : data.missed ? (
            <>
              Your <strong style={{ color: S.text }}>{data.service?.type || 'service'}</strong> visit was set
              for <strong style={{ color: S.text }}>{formatDateLabel(current.date)}</strong> — pick a new time below
              and we&apos;ll get you taken care of.
            </>
          ) : (
            <>
              Your <strong style={{ color: S.text }}>{data.service?.type || 'service'}</strong> visit is currently
              scheduled for <strong style={{ color: S.text }}>{formatDateLabel(current.date)}</strong>
              {current.windowStart ? <>, arrival window <strong style={{ color: S.text }}>{arrivalWindowLabel(current.windowStart)}</strong></> : null}.
            </>
          )}
        </div>
        {data.isRecurring ? (
          <div data-glass="soft" style={{ ...SOFT_NOTE, marginTop: 14 }}>
            {recurringNoteCopy(data, selectedSlot)}
          </div>
        ) : null}
      </div>
    </>
  );
}

function RescheduleSuccessCard({ result, service }) {
  return (
    <Card>
      <CardTitle>You&apos;re all set</CardTitle>
      <div style={{ fontSize: 16, color: S.body, lineHeight: 1.6 }}>
        Your {service?.type || 'service'} visit is now scheduled for{' '}
        <strong style={{ color: S.text }}>{formatDateLabel(result.newDate)}</strong>, arrival window{' '}
        <strong style={{ color: S.text }}>{arrivalWindowLabel(result.window?.start) || result.startLabel}</strong>.
        {result.seriesShifted ? (result.futurePlacementDays === 3
          ? ' We’ll arrange later visits within 3 days of their new due dates. Existing appointment commitments stay unchanged until our team reviews them with you.'
          : ' We also shifted your upcoming visits to follow the new date — your regular schedule now runs from this one.') : ''}
        {' '}We&apos;ll text you a confirmation shortly.
      </div>
    </Card>
  );
}

// ───────────────────────────── re-service flow ─────────────────────────────

function NotEligibleCard({ data }) {
  return (
    <Card>
      <CardTitle>{data?.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}let&apos;s get you taken care of</CardTitle>
      <div style={{ fontSize: 16, color: S.body, lineHeight: 1.55 }}>
        Free re-service visits come with an active recurring plan, and we don&apos;t
        show one on your account right now. Text or call us and we&apos;ll figure
        out the fastest way to help.
      </div>
      <ContactRow />
    </Card>
  );
}

// A lane that already has an open callback: show the visit and hand over its
// reschedule link — the tie-in that replaces double-booking.
function AlreadyBookedCard({ lane }) {
  const booked = lane.alreadyBooked || {};
  return (
    <Card>
      <div style={{ fontSize: 16, color: S.body, lineHeight: 1.6 }}>
        Your <strong style={{ color: S.text }}>{booked.serviceType || lane.label}</strong> visit is
        set for <strong style={{ color: S.text }}>{formatDateLabel(booked.date)}</strong>
        {booked.windowStart ? <>, arrival window <strong style={{ color: S.text }}>{arrivalWindowLabel(booked.windowStart)}</strong></> : null}.
        {' '}No need to book another — one free re-service at a time keeps your tech focused on fixing it.
      </div>
      {booked.rescheduleUrl ? (
        <a href={booked.rescheduleUrl} data-glass-accent="" style={{ ...PRIMARY_CTA, marginTop: 14 }}>
          Need a different time? Move that visit
        </a>
      ) : null}
    </Card>
  );
}

function ReserviceSuccessCard({ result }) {
  return (
    <Card>
      <CardTitle>You&apos;re all set</CardTitle>
      <div style={{ fontSize: 16, color: S.body, lineHeight: 1.6 }}>
        Your free <strong style={{ color: S.text }}>{result.serviceType || 're-service'}</strong> visit is
        scheduled for <strong style={{ color: S.text }}>{formatDateLabel(result.date)}</strong>, arrival window{' '}
        <strong style={{ color: S.text }}>{arrivalWindowLabel(result.window?.start) || result.startLabel}</strong>.
        {' '}We&apos;ll text you a confirmation shortly.
      </div>
      {result.rescheduleUrl ? (
        <a href={result.rescheduleUrl} data-glass-accent="" style={{ ...PRIMARY_CTA, marginTop: 16 }}>
          Need a different time? Reschedule it
        </a>
      ) : null}
    </Card>
  );
}

function ReserviceCoveredView({ data }) {
  return (
    <>
      <Card>
        <CardTitle>{data.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}you&apos;re covered</CardTitle>
        <div style={{ fontSize: 16, color: S.body, lineHeight: 1.55 }}>
          We already have your free re-service on the calendar.
        </div>
      </Card>
      {(data.lanes || []).filter((l) => l.alreadyBooked).map((lane) => (
        <AlreadyBookedCard key={lane.key} lane={lane} />
      ))}
      <HelpCard>Something new going on? Text or call {WAVES_SUPPORT_PHONE_DISPLAY} and our team will help.</HelpCard>
    </>
  );
}

// Hero (eyebrow → title → intro) plus the "what needs another look"
// card: the lane choice when more than one plan family is bookable, and the
// optional details line the tech preps from.
function ReserviceHero({ data, bookableLanes, selectedLane, onSelectLane, details, onDetails }) {
  return (
    <>
      <div style={{ margin: '8px 2px 20px' }}>
        {/* No status badge here (owner 2026-09-04: drop "Free with your plan") —
            the intro line already carries the no-charge promise. */}
        <div data-gt="eyebrow" style={DOC_EYEBROW}>Re-service</div>
        <h1 style={{ margin: 0, fontFamily: FONTS.serif, fontSize: 'clamp(30px, 5vw, 40px)', fontWeight: 500, lineHeight: 1.1, color: S.text }}>
          {data?.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}pests back between visits?
        </h1>
        <div style={{ marginTop: 12, color: S.body, fontSize: 16, lineHeight: 1.55 }}>
          Breakthrough activity between regular visits is covered — pick a time
          below and we&apos;ll send a tech back out at <strong style={{ color: S.text }}>no charge</strong>.
        </div>
      </div>
      <Card>
        {bookableLanes.length > 1 ? (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>What needs another look?</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {bookableLanes.map((lane) => {
                const active = selectedLane === lane.key;
                return (
                  <button
                    key={lane.key}
                    type="button"
                    {...(active ? { 'data-glass-accent': '' } : { 'data-glass': 'chip' })}
                    onClick={() => onSelectLane(lane.key)}
                    style={{
                      background: active ? COLORS.glassNavy : '#fff',
                      color: active ? COLORS.white : S.text,
                      border: `2px solid ${active ? COLORS.glassNavy : '#E7E2D7'}`,
                      borderRadius: 999,
                      padding: '9px 16px',
                      cursor: 'pointer',
                      fontFamily: FONT_BODY,
                      fontSize: 14,
                      fontWeight: 700,
                    }}
                  >
                    {lane.key === 'lawn' ? 'My lawn' : 'Pests inside or out'}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <label htmlFor="reservice-details" style={{ display: 'block', fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
          What are you seeing? <span style={{ fontWeight: 500, color: S.body }}>(optional — helps your tech prep)</span>
        </label>
        <textarea
          id="reservice-details"
          name="reservice_details"
          value={details}
          onChange={(e) => onDetails(e.target.value)}
          maxLength={400}
          rows={2}
          placeholder="Ants are back along the kitchen window"
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'vertical',
            border: '1px solid #E7E2D7', borderRadius: 10, padding: '10px 12px',
            font: 'inherit', fontSize: 16, color: S.text, background: '#fff',
          }}
        />
      </Card>
    </>
  );
}

// ───────────────────────────── the page ─────────────────────────────

// Everything that differs between the two flows lives here, as data — the
// page body below makes no per-flow decisions of its own.
const FLOWS = {
  reschedule: {
    endpoint: 'reschedule',
    notFound: { title: "We couldn't find that appointment", body: "This link may have expired. Text or call us and we'll get you scheduled." },
    loadErrorTitle: "We couldn't load that appointment",
    // A card when the loaded state cannot proceed to the picker, else null.
    blocked: (data) => (data?.state !== 'reschedulable' ? <IneligibleCard data={data} /> : null),
    Hero: RescheduleHero,
    Success: ({ result, data }) => <RescheduleSuccessCard result={result} service={data?.service} />,
    canConfirm: () => true,
    actionLabel: ({ submitting }) => (submitting ? 'Moving…' : `Confirm ${'→'}`),
    payload: ({ slot, data }) => ({
      date: slot.date,
      start_time: slot.start_time,
      end_time: slot.end_time,
      technician_id: slot.technician_id || null,
      // Scope pin: the series behavior this page DISCLOSED, and the anchor
      // date that promise was framed against. A gate flip or a dispatch
      // race between render and commit 409s (SCOPE_CHANGED) instead of
      // silently doing something the customer wasn't told.
      disclosed_collective: !!data?.collectiveAnchor,
      disclosed_future_placement_days: data?.futurePlacementDays ?? null,
      disclosed_current_date: data?.current?.date || null,
    }),
    // SCOPE_CHANGED: gate flip / dispatch race on the disclosed series scope.
    stateChangedCodes: ['SCOPE_CHANGED'],
    stateChangedMessage: 'The scheduling details for your plan just updated — here is the latest.',
    // Inside the picked row so the heads-up sits directly under the Confirm
    // it applies to — never below the fold.
    pickedNote: (data, slot) => (!data.collectiveAnchor && slotReanchors(data, slot.date)
      ? <div className="wpk-picked-note"><ReanchorNote futurePlacementDays={data.futurePlacementDays} /></div>
      : null),
  },
  reservice: {
    endpoint: 'reservice',
    notFound: { title: "We couldn't find that link", body: "This link may have expired. Text or call us and we'll get your re-service scheduled." },
    loadErrorTitle: "We couldn't load your re-service options",
    blocked: (data) => {
      if (data?.state === 'not_eligible') return <NotEligibleCard data={data} />;
      if (data?.state === 'already_booked') return <ReserviceCoveredView data={data} />;
      return null;
    },
    Hero: ReserviceHero,
    Success: ({ result }) => <ReserviceSuccessCard result={result} />,
    canConfirm: ({ lane }) => !!lane,
    actionLabel: ({ submitting, lane }) => (submitting ? 'Booking…' : !lane ? 'Pick what needs another look above' : `Book ${'→'} free`),
    payload: ({ slot, lane, details }) => ({
      lane,
      date: slot.date,
      start_time: slot.start_time,
      details: details.trim() || undefined,
    }),
    // ALREADY_BOOKED / NOT_ELIGIBLE: office booked one, plan lapsed.
    stateChangedCodes: ['ALREADY_BOOKED', 'NOT_ELIGIBLE'],
    stateChangedMessage: 'Your re-service options just updated — here is the latest.',
    pickedNote: () => null,
  },
};

export default function ScheduleFlowPage({ flow }) {
  const cfg = FLOWS[flow];
  const { token } = useParams();
  useGlassSurface(true);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(null);
  // Which day's times the picker shows. Kept valid against the current
  // availability by the effect below (initial load, AI filter, SLOT_TAKEN
  // refresh) — always falls back to the first day with openings.
  const [selectedDate, setSelectedDate] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);
  // True while the calendar shows an AI search's results instead of the full
  // window — gates the "Show all open times" reset.
  const [aiFiltered, setAiFiltered] = useState(false);
  // Bumped on a successful reset; keys the Ask card so its recap clears with
  // the filter — a stale "Two openings Tuesday afternoon" line must not sit
  // above the unfiltered calendar.
  const [aiSession, setAiSession] = useState(0);
  // Re-service only: which plan family and the optional details line.
  const [selectedLane, setSelectedLane] = useState(null);
  const [details, setDetails] = useState('');

  // Abort the in-flight load on unmount/token change — a late response must
  // not setState against an unmounted page (or land under a different token);
  // superseding a still-running load also keeps responses in issue order.
  const loadAbortRef = useRef(null);

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setNotFound(false);
    setLoadError(false);
    try {
      const res = await fetch(`${API_BASE}/public/${cfg.endpoint}/${token}`, { signal: controller.signal });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error('load failed');
      const body = await res.json();
      if (controller.signal.aborted) return;
      setData(body);
    } catch {
      if (controller.signal.aborted) return;
      setLoadError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [cfg.endpoint, token]);

  useEffect(() => {
    load();
    return () => loadAbortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    const days = data?.availability?.days || [];
    if (!days.length) {
      setSelectedDate(null);
      return;
    }
    setSelectedDate((prev) => (days.some((d) => d.date === prev) ? prev : days[0].date));
  }, [data]);

  // Re-service: keep the lane selection valid whenever eligibility changes —
  // a single bookable lane auto-selects (most customers hold one plan family).
  useEffect(() => {
    const bookable = (data?.lanes || []).filter((l) => !l.alreadyBooked);
    setSelectedLane((prev) => {
      if (bookable.some((l) => l.key === prev)) return prev;
      return bookable.length === 1 ? bookable[0].key : null;
    });
  }, [data]);

  // Waves AI date/time search — swaps in the matching window's availability
  // (same shape the GET returns) and hands the summary line back to the
  // card. Throwing lets the card show its own call-us fallback line.
  const runAiSearch = async (query) => {
    const res = await fetch(`${API_BASE}/public/${cfg.endpoint}/${token}/find-slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'search failed');
    if (body.availability) {
      setData((prev) => (prev ? { ...prev, availability: body.availability } : prev));
      setSelectedSlot(null);
      setSubmitError(null);
      setAiFiltered(true);
    }
    return { summary: body.summary };
  };

  // Back to the full window after a search — quiet refetch (no skeleton
  // flash) so the calendar is fresh. aiFiltered only clears once the
  // full-window response is applied: on failure the filtered calendar is
  // still what's on screen, so the reset link must survive for another try.
  const showAllTimes = async () => {
    setSelectedSlot(null);
    try {
      const res = await fetch(`${API_BASE}/public/${cfg.endpoint}/${token}`);
      if (!res.ok) return;
      setData(await res.json());
      setAiFiltered(false);
      setAiSession((n) => n + 1); // remount the card → clears its recap/query
    } catch { /* keep the filtered calendar + reset link */ }
  };

  const confirm = async () => {
    if (!selectedSlot || submitting || !cfg.canConfirm({ lane: selectedLane })) return;
    setSubmitting(true);
    setSubmitError(null);
    const payload = cfg.payload({ slot: selectedSlot, data, lane: selectedLane, details });
    try {
      const res = await fetch(`${API_BASE}/public/${cfg.endpoint}/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) {
        setResult(body);
        return;
      }
      if (body.code === 'SLOT_TAKEN') {
        setSelectedSlot(null);
        setAiFiltered(false); // refreshed availability spans the full window
        setAiSession((n) => n + 1); // remount the card — its recap is stale too
        if (body.availability) {
          setData((prev) => (prev ? { ...prev, availability: body.availability } : prev));
        } else {
          await load();
        }
        // SERIES_PROJECTION (reschedule): the chosen WINDOW conflicts with
        // this plan's upcoming visits (a shifted future occurrence at that
        // time would double-book), so "time just taken — try again" would
        // loop the customer through the same refusal. The clash is
        // window-specific — another time on the same day can clear it — so
        // steer to another time or day, never "this day is out".
        setSubmitError(body.subcode === 'SERIES_PROJECTION'
          ? 'That time doesn\'t work with your plan\'s upcoming visits — please try another time or day, or text us and we\'ll sort it out.'
          : 'That time was just taken — here are the latest open times.');
        return;
      }
      // The plan's state changed under us (see each flow's
      // stateChangedCodes) — reload so the page re-renders the truthful state.
      if (cfg.stateChangedCodes.includes(body.code)) {
        setSelectedSlot(null);
        await load();
        setSubmitError(body.error || cfg.stateChangedMessage);
        return;
      }
      setSubmitError(body.error || 'Something went wrong. Please try again, or text us and we\'ll help.');
    } catch {
      setSubmitError('Something went wrong. Please try again, or text us and we\'ll help.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Page><SkeletonCard /></Page>;
  if (notFound) return <Page><NotFoundCard title={cfg.notFound.title} body={cfg.notFound.body} /></Page>;
  if (loadError) return <Page><LoadErrorCard title={cfg.loadErrorTitle} onRetry={load} /></Page>;
  if (result) return <Page><cfg.Success result={result} data={data} /></Page>;
  const blocked = cfg.blocked(data);
  if (blocked) return <Page>{blocked}</Page>;

  const lanes = data?.lanes || [];
  const bookableLanes = lanes.filter((l) => !l.alreadyBooked);
  const blockedLanes = lanes.filter((l) => l.alreadyBooked);
  const days = data?.availability?.days || [];
  const selectedDay = days.find((d) => d.date === selectedDate) || days[0] || null;

  const actionLabel = cfg.actionLabel({ submitting, lane: selectedLane });

  return (
    // Single column at every width (owner ask 2026-07-14) — the page keeps
    // the standard flow reading measure on desktop instead of a two-pane
    // split, so the flow reads identically on phone and desktop.
    <Page>
      <cfg.Hero
        data={data}
        selectedSlot={selectedSlot}
        bookableLanes={bookableLanes}
        selectedLane={selectedLane}
        onSelectLane={setSelectedLane}
        details={details}
        onDetails={setDetails}
      />
      {blockedLanes.map((lane) => (
        <AlreadyBookedCard key={lane.key} lane={lane} />
      ))}
      <AskCard key={aiSession} onSearch={runAiSearch} aiFiltered={aiFiltered} onShowAll={showAllTimes} />
      <SchedulePicker
        availability={data?.availability}
        rankedSlots={aiFiltered ? null : data?.availability?.slots}
        selectedDate={selectedDay?.date || null}
        onSelectDay={(date) => {
          setSelectedDate(date);
          setSelectedSlot(null);
          setSubmitError(null);
        }}
        selectedSlot={selectedSlot}
        onSelectSlot={(slot) => { setSelectedSlot(slot); setSubmitError(null); }}
        submitError={submitError}
        pickedAction
        pickedExtra={(slot) => (
          <>
            <button
              type="button"
              data-glass-accent=""
              className="wpk-action-btn"
              onClick={confirm}
              disabled={submitting || !cfg.canConfirm({ lane: selectedLane })}
            >
              {actionLabel}
            </button>
            {cfg.pickedNote(data, slot)}
          </>
        )}
        empty={<EmptyTimesCard aiFiltered={aiFiltered} />}
      />
      <HelpCard>Don&apos;t see a time that works? Text or call {WAVES_SUPPORT_PHONE_DISPLAY} and our team will fit you in.</HelpCard>
    </Page>
  );
}
