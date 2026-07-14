/**
 * Public self-serve reschedule page — /reschedule/:token.
 *
 * Linked from the appointment confirmation / 72h / 24h reminder texts and
 * reminder emails. Token-gated (no login), mirroring TrackPage's model:
 * fetch GET /api/public/reschedule/:token, render by state, and commit the
 * chosen slot with POST. Single visit only — a recurring plan's other
 * visits never move from here (the page says so when the visit is part of
 * a recurring plan).
 *
 * Styling follows the customer-facing brand idiom used by TrackPage
 * (WavesShell customer variant + warm surface palette + inline styles).
 * The page mounts the glass scene (now the unconditional theme) and its
 * native data-glass markup restyles the cards — the inline styles below
 * remain the base non-glass rendering.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { COLORS, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { WavesShell } from '../components/brand';
import BrandFooter from '../components/BrandFooter';
import { useGlassSurface } from '../glass/glass-engine';
import WavesAIScheduleSearch from '../components/booking/WavesAIScheduleSearch';
import {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_TEL,
  WAVES_SUPPORT_SMS_TEL,
} from '../constants/business';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const FONT_BODY = "'Inter', system-ui, sans-serif";
const S = {
  surface: '#FFFFFF',
  page: '#FAF8F3',
  border: '#E7E2D7',
  soft: '#F8FCFE',
  softBorder: '#CFE7F5',
  text: '#04395E',
  body: '#3F4A65',
  muted: CUSTOMER_SURFACE.muted,
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
  borderRadius: 8,
  fontFamily: FONTS.ui,
  fontWeight: 800,
  fontSize: 15,
  cursor: 'pointer',
  textDecoration: 'none',
};

function Page({ children }) {
  return (
    <WavesShell variant="customer" topBar="solid">
      <div style={{ flex: 1, padding: '24px 16px 40px', maxWidth: 640, width: '100%', margin: '0 auto', fontFamily: FONT_BODY, color: S.text }}>
        {children}
        <BrandFooter />
      </div>
    </WavesShell>
  );
}

function Card({ children, style, ...rest }) {
  return (
    <div data-glass="card" {...rest} style={{ background: S.surface, border: `1px solid ${S.border}`, borderRadius: 12, padding: 24, marginBottom: 16, ...style }}>
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

// current.date is 'YYYY-MM-DD'; windows are 'HH:MM'. Format in place so the
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

function ReanchorNote() {
  return (
    <div data-glass="soft" style={{
      background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8,
      padding: '10px 12px', fontSize: 14, color: '#9A3412', lineHeight: 1.5,
    }}>
      Heads up — moving this far up shifts your whole plan: your following
      visits will move to match the new date, keeping your regular schedule.
    </div>
  );
}

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

function NotFoundCard() {
  return (
    <Card>
      <div data-gt="h3x" style={{ fontSize: 20, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
        We couldn't find that appointment
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
        This link may have expired. Text or call us and we'll get you scheduled.
      </div>
      <ContactRow />
    </Card>
  );
}

const INELIGIBLE_COPY = {
  completed: 'This visit is already complete, so there is nothing to reschedule.',
  cancelled: 'This appointment was cancelled. Text or call us and we\'ll get you back on the calendar.',
  in_progress: 'Your technician is already on the way for this visit, so it can\'t be moved online.',
  past: 'This visit\'s scheduled time has passed, so it can\'t be moved online.',
  not_available: 'This appointment can\'t be rescheduled online.',
};

function IneligibleCard({ data }) {
  const reasonCopy = INELIGIBLE_COPY[data?.reason] || INELIGIBLE_COPY.not_available;
  return (
    <Card>
      <div data-gt="h3x" style={{ fontSize: 20, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
        {data?.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}we can't move this one online
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
        {reasonCopy} Need a hand? Text or call and our team will help.
      </div>
      <ContactRow />
    </Card>
  );
}

function SlotButton({ slot, selected, onSelect }) {
  return (
    <button
      type="button"
      {...(selected ? { 'data-glass-accent': '' } : { 'data-glass': 'chip' })}
      onClick={() => onSelect(slot)}
      style={{
        textAlign: 'left',
        background: selected ? COLORS.glassNavy : S.surface,
        color: selected ? COLORS.white : S.text,
        border: `2px solid ${selected ? COLORS.glassNavy : S.border}`,
        borderRadius: 10,
        padding: '10px 14px',
        cursor: 'pointer',
        fontFamily: FONT_BODY,
        fontSize: 15,
        fontWeight: 700,
      }}
    >
      {slot.start_label}
    </button>
  );
}

function DayGroup({ day, selectedSlot, onSelect }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: FONTS.heading }}>{day.fullDate}</div>
        {day.nearby ? (
          <span data-glass="chip" style={{
            fontSize: 12, fontWeight: 700, color: COLORS.green,
            background: '#DCFCE7', padding: '2px 8px', borderRadius: 999,
          }}>
            Tech nearby
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
        {day.slots.map((slot) => (
          <SlotButton
            key={`${day.date}|${slot.start_time}`}
            slot={slot}
            selected={selectedSlot && selectedSlot.date === day.date && selectedSlot.start_time === slot.start_time}
            onSelect={(s) => onSelect({ ...s, date: day.date, fullDate: day.fullDate })}
          />
        ))}
      </div>
    </div>
  );
}

function SuccessCard({ result, service }) {
  return (
    <Card>
      <div data-glass="chip" style={{
        display: 'inline-block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
        color: COLORS.green, background: '#DCFCE7', padding: '6px 12px', borderRadius: 9999, marginBottom: 12,
      }}>
        Rescheduled
      </div>
      <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
        You're all set
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.6 }}>
        Your {service?.type || 'service'} visit is now scheduled for{' '}
        <strong style={{ color: S.text }}>{formatDateLabel(result.newDate)}</strong>, arrival window{' '}
        <strong style={{ color: S.text }}>{arrivalWindowLabel(result.window?.start) || result.startLabel}</strong>.
        {result.seriesShifted ? ' We also shifted your upcoming visits to follow the new date — your regular schedule now runs from this one.' : ''}
        {' '}We'll text you a confirmation shortly.
      </div>
    </Card>
  );
}

// ───────────────────────────── V2 layout (dark: ?v2=1) ─────────────────────────────
// Owner-approved redesign 2026-07-13 (interactive mock review): calendar-first
// day grid, route-ranked "Best times" strip, tap-time → inline Confirm (the
// bottom CTA is gone), and the report page's floating Waves AI bar in place of
// the embedded search card. Header/footer (WavesShell + BrandFooter) and every
// endpoint/behavior are unchanged from the legacy layout above, which stays
// the default until the owner flips the gate.

const V2_PROMPTS = ['Tomorrow morning', 'This weekend', 'Next week', 'Saturday', 'Late afternoon'];

function parseYMD(dateStr) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, 12));
}

// Monday-start column index (0 = Mon … 6 = Sun) so the grid's weekday
// columns line up regardless of which day the window opens on.
function mondayIndex(dateStr) {
  const dt = parseYMD(dateStr);
  return dt ? (dt.getUTCDay() + 6) % 7 : 0;
}

function listRangeDates(from, to) {
  const start = parseYMD(from);
  const end = parseYMD(to);
  if (!start || !end || end < start) return [];
  const out = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 24 * 3600 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function shortMonthDay(dateStr, { withMonth = true } = {}) {
  const dt = parseYMD(dateStr);
  if (!dt) return '';
  return dt.toLocaleDateString('en-US', withMonth ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { day: 'numeric', timeZone: 'UTC' });
}

function v2RangeLabel(from, to) {
  const a = parseYMD(from);
  const b = parseYMD(to);
  if (!a || !b) return '';
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  return `${shortMonthDay(from)} – ${shortMonthDay(to, { withMonth: !sameMonth })}`;
}

// Report-style floating Waves AI bar (FloatingAskWaves in ReportViewPage is
// the visual source of truth — owner ask 2026-07-13: "look like what we have
// on the post service reports"). Same sticky slim bar, star label, marquee
// prompt pills, pill input + gold button, and absolute answer dropdown; the
// answer here is the search's summary line instead of a report Q&A answer.
function V2FloatingAsk({ onSearch, aiFiltered, onShowAll }) {
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
    <div className="rsv2-ask-wrap">
      <section data-glass="card" className="rsv2-ask-bar" aria-label="Waves AI — search for a day or time">
        <span className="rsv2-ask-title">Waves AI</span>
        <div className="rsv2-ask-pills" aria-label="Example searches">
          <div className="rsv2-ask-track">
            {[...V2_PROMPTS, ...V2_PROMPTS].map((prompt, i) => (
              <button
                data-glass="chip"
                type="button"
                key={`${prompt}-${i}`}
                className="rsv2-ask-pill"
                onClick={() => ask(prompt)}
                disabled={asking}
                tabIndex={i < V2_PROMPTS.length ? 0 : -1}
                aria-hidden={i >= V2_PROMPTS.length}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
        <div className="rsv2-ask-form">
          <input
            id="rsv2-ask-input"
            name="rsv2_ask_input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                ask();
              }
            }}
            placeholder="Ask Waves"
            aria-label="Search for a service date or time"
          />
          <button data-glass-accent="" type="button" onClick={() => ask()} disabled={asking || !question.trim()}>
            {asking ? 'Checking…' : 'Search'}
          </button>
        </div>
        {(notice || aiFiltered) ? (
          <div className="rsv2-ask-answer" role="status" data-glass="soft">
            <span>{notice ? notice.text : 'Showing the times that match your search.'}</span>
            <span className="rsv2-ask-answer-actions">
              {aiFiltered ? (
                <button type="button" className="rsv2-ask-reset" onClick={onShowAll}>Show all open times</button>
              ) : null}
              <button type="button" className="rsv2-ask-dismiss" onClick={() => setNotice(null)} aria-label="Dismiss">{'\u2715'}</button>
            </span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// Route-ranked top picks. availability.slots is already sorted by the slot
// engine's score (detour minutes + days-out) — surfacing it is the whole
// point (owner ask 2026-07-13: the ranking existed but the layout buried it).
// Copy stays privacy-safe: never another customer's name or address, same
// rule as the estimate surface's nearby label.
function V2BestTimes({ slots, days, onPick }) {
  const byDate = new Map((days || []).map((d) => [d.date, d]));
  // Only recommend slots the day panel actually renders — the ranked
  // top-level list and days[].slots are built separately server-side, and a
  // pick with no matching panel row would select a slot whose Confirm never
  // appears. Resolving to the day's own slot object keeps the confirm
  // payload identical to a manual tap. Nearby days lead (that steer is the
  // strip's whole job); the engine's rank order is preserved within each
  // group via a stable sort.
  const picks = (slots || [])
    .map((s, i) => {
      const day = s.date ? byDate.get(s.date) : null;
      const panelSlot = day?.slots?.find((x) => x.start_time === s.start_time);
      return panelSlot ? { s: panelSlot, day, i, nearby: !!day.nearby } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (Number(b.nearby) - Number(a.nearby)) || (a.i - b.i))
    .slice(0, 3);
  if (!picks.length) return null;
  return (
    <Card>
      <div data-gt="h3x" style={{ fontSize: 17, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 2 }}>
        Our best times for you
      </div>
      <div style={{ fontSize: 14, color: S.muted, marginBottom: 12, lineHeight: 1.45 }}>
        These fit our route near you best — easiest for everyone.
      </div>
      <div className="rsv2-best-row">
        {picks.map(({ s: slot, day, nearby }) => (
          <button
            type="button"
            data-glass="chip"
            key={`${day.date}|${slot.start_time}`}
            className="rsv2-best-chip"
            onClick={() => onPick(slot, day)}
          >
            <span>
              <span className="rsv2-best-when">{day.fullDate} {'·'} {slot.start_label}</span>
              <span className="rsv2-best-why">
                {nearby ? "We're servicing a property close to you that day" : 'Our soonest opening'}
              </span>
            </span>
            <span className="rsv2-best-go">Pick {'→'}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function V2DayGrid({ availability, selectedDate, onSelectDay }) {
  const days = availability?.days || [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const from = availability?.rangeFrom || days[0]?.date;
  const to = availability?.rangeTo || days[days.length - 1]?.date;
  const dates = listRangeDates(from, to);
  if (!dates.length) return null;
  const leading = mondayIndex(dates[0]);
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div data-gt="h3x" style={{ fontSize: 17, fontWeight: 800, fontFamily: FONTS.heading }}>Pick a day</div>
        <div style={{ fontSize: 14, color: S.muted }}>{v2RangeLabel(from, to)}</div>
      </div>
      <div className="rsv2-dow" aria-hidden="true">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((letter, i) => <span key={`${letter}-${i}`}>{letter}</span>)}
      </div>
      <div className="rsv2-grid" role="listbox" aria-label="Days with open times">
        {Array.from({ length: leading }, (_, i) => <span key={`pad-${i}`} className="rsv2-day-pad" />)}
        {dates.map((date) => {
          const day = byDate.get(date);
          const open = !!day?.slots?.length;
          const label = day?.fullDate || formatDateLabel(date);
          return (
            <button
              type="button"
              key={date}
              role="option"
              aria-selected={date === selectedDate}
              className={`rsv2-day${date === selectedDate ? ' rsv2-day-selected' : ''}`}
              disabled={!open}
              aria-label={open
                ? `${label}${day.nearby ? ' — tech in your neighborhood' : ''}, ${day.slots.length} ${day.slots.length === 1 ? 'opening' : 'openings'}`
                : `${label}, no open times`}
              onClick={() => open && onSelectDay(date)}
            >
              <span className="rsv2-day-num">{shortMonthDay(date, { withMonth: false })}</span>
              {open ? (
                <span className="rsv2-day-dots">
                  {day.slots.slice(0, 3).map((slot, i) => (
                    <i key={i} className={day.nearby ? 'rsv2-dot-nearby' : ''} />
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="rsv2-legend">
        <span><i className="rsv2-legend-open" />Openings</span>
        <span><i className="rsv2-legend-nearby" />Tech in your neighborhood</span>
      </div>
    </Card>
  );
}

function V2TimesPanel({ day, selectedSlot, onSelect, onConfirm, submitting, submitError, reanchorNote }) {
  return (
    <Card>
      <div data-gt="h3x" style={{ fontSize: 17, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 2 }}>
        {day ? day.fullDate : 'Open times'}
      </div>
      <div style={{ fontSize: 14, color: S.muted, marginBottom: 14, lineHeight: 1.45 }}>
        Tap a time, then confirm. Your technician arrives within a two-hour window of the start time.
      </div>
      {submitError ? (
        <div style={{
          background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8,
          padding: '10px 12px', fontSize: 14, color: '#9A3412', marginBottom: 14, lineHeight: 1.45,
        }}>
          {submitError}
        </div>
      ) : null}
      {!day || !day.slots?.length ? (
        <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
          No open times this day {'—'} pick another day above, or text Waves and we'll fit you in.
        </div>
      ) : (
        <div className="rsv2-slot-col">
          {day.slots.map((slot) => {
            const picked = selectedSlot && selectedSlot.date === day.date && selectedSlot.start_time === slot.start_time;
            return (
              <div key={`${day.date}|${slot.start_time}`} className={`rsv2-slot${picked ? ' rsv2-slot-picked' : ''}`}>
                <button
                  type="button"
                  {...(picked ? { 'data-glass-accent': '' } : { 'data-glass': 'chip' })}
                  className="rsv2-time-btn"
                  aria-label={`Choose ${slot.start_label} on ${day.fullDate}${day.nearby ? ', technician already in your neighborhood' : ''}`}
                  onClick={() => onSelect(picked ? null : { ...slot, date: day.date, fullDate: day.fullDate })}
                >
                  {slot.start_label}
                  {day.nearby ? <span className="rsv2-nearby-pill">Tech nearby</span> : null}
                </button>
                {picked ? (
                  <button
                    type="button"
                    data-glass-accent=""
                    className="rsv2-confirm-btn"
                    onClick={onConfirm}
                    disabled={submitting}
                  >
                    {submitting ? 'Moving…' : `Confirm ${'→'}`}
                  </button>
                ) : null}
                {picked && reanchorNote ? (
                  // Inside the picked row (full-width grid item) so the
                  // heads-up sits directly under the Confirm it applies to —
                  // never below the fold behind later slots.
                  <div style={{ gridColumn: '1 / -1' }}><ReanchorNote /></div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// Page-scoped styles for the V2 layout. Class-prefixed (rsv2-) so nothing
// leaks; the star before the Waves AI label is the CSS-escaped \2726 glyph
// (raw decorative glyphs fail check:portal-brand — same trick ReportViewPage
// uses for its floating bar).
function V2Styles() {
  return (
    <style>{`
      .rsv2-ask-wrap { position: sticky; top: 57px; z-index: 8; margin-bottom: 16px; }
      .rsv2-ask-bar {
        position: relative;
        display: grid;
        grid-template-areas: 'title pills form';
        grid-template-columns: auto minmax(0, 1fr) minmax(240px, 40%);
        align-items: center;
        gap: 10px;
        border: 1px solid ${S.border};
        border-radius: 18px;
        background: ${S.surface};
        padding: 10px 14px;
      }
      .rsv2-ask-title {
        grid-area: title;
        color: ${S.text};
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .rsv2-ask-title::before { content: '\\2726  '; color: ${COLORS.yellow}; }
      .rsv2-ask-pills {
        grid-area: pills;
        min-width: 0;
        overflow: hidden;
        -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent);
        mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent);
      }
      .rsv2-ask-track { display: flex; gap: 8px; width: max-content; animation: rsv2PillMarquee 48s linear infinite; }
      .rsv2-ask-pills:hover .rsv2-ask-track,
      .rsv2-ask-track:focus-within { animation-play-state: paused; }
      @keyframes rsv2PillMarquee {
        from { transform: translateX(0); }
        to { transform: translateX(calc(-50% - 4px)); }
      }
      @media (prefers-reduced-motion: reduce) { .rsv2-ask-track { animation: none; } }
      .rsv2-ask-pill {
        flex: 0 0 auto;
        border: 1px solid ${S.border};
        border-radius: 999px;
        background: #fff;
        color: ${S.text};
        font: inherit;
        font-size: 14px;
        line-height: 1;
        font-weight: 700;
        padding: 9px 12px;
        cursor: pointer;
        white-space: nowrap;
      }
      .rsv2-ask-form { grid-area: form; display: flex; gap: 8px; min-width: 0; }
      .rsv2-ask-form input {
        flex: 1;
        min-width: 0;
        border: 1px solid ${S.border};
        border-radius: 999px;
        padding: 9px 14px;
        color: ${S.text};
        font: inherit;
        font-size: 14px;
        outline: none;
        background: #fff;
      }
      .rsv2-ask-form button {
        border: 1px solid ${COLORS.glassNavy};
        border-radius: 999px;
        background: ${COLORS.yellow};
        color: ${COLORS.glassNavy};
        font: inherit;
        font-size: 14px;
        font-weight: 800;
        padding: 9px 16px;
        cursor: pointer;
        white-space: nowrap;
      }
      .rsv2-ask-form button:disabled, .rsv2-ask-pill:disabled { opacity: .5; cursor: default; }
      .rsv2-ask-answer {
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        right: 0;
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        border: 1px solid ${S.border};
        border-radius: 14px;
        background: ${S.surface};
        padding: 12px 14px;
        color: ${S.text};
        font-size: 14px;
        line-height: 1.5;
        box-shadow: 0 18px 50px rgba(4, 57, 94, 0.18);
      }
      .rsv2-ask-answer-actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
      .rsv2-ask-reset {
        border: 0;
        background: transparent;
        color: ${COLORS.glassNavy};
        font: inherit;
        font-size: 14px;
        font-weight: 700;
        text-decoration: underline;
        cursor: pointer;
        white-space: nowrap;
        padding: 0;
      }
      .rsv2-ask-dismiss { border: 0; background: transparent; color: ${S.muted}; font-size: 14px; line-height: 1; padding: 2px 4px; cursor: pointer; }
      @media (max-width: 700px) {
        .rsv2-ask-bar {
          grid-template-areas: 'title form' 'pills pills';
          grid-template-columns: auto minmax(0, 1fr);
          border-radius: 16px;
        }
      }

      .rsv2-best-row { display: flex; flex-direction: column; gap: 8px; }
      .rsv2-best-chip {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        text-align: left;
        font: inherit;
        cursor: pointer;
        background: #FFFBEA;
        border: 1px solid #F5D76E;
        border-radius: 12px;
        padding: 12px 14px;
        color: ${S.text};
      }
      .rsv2-best-when { display: block; font-size: 15px; font-weight: 800; }
      .rsv2-best-why { display: block; font-size: 14px; font-weight: 500; color: ${S.muted}; margin-top: 2px; }
      .rsv2-best-go {
        flex: 0 0 auto;
        font-size: 14px;
        font-weight: 800;
        color: ${COLORS.glassNavy};
        background: ${COLORS.yellow};
        border-radius: 999px;
        padding: 7px 13px;
        white-space: nowrap;
      }

      .rsv2-dow, .rsv2-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
      .rsv2-dow { margin-bottom: 6px; }
      .rsv2-dow span { font-size: 14px; font-weight: 700; text-align: center; color: ${S.muted}; }
      .rsv2-day {
        position: relative;
        font: inherit;
        border: 1px solid ${S.border};
        background: ${S.surface};
        border-radius: 12px;
        padding: 10px 0 14px;
        cursor: pointer;
        color: ${S.text};
        text-align: center;
        min-height: 48px;
      }
      .rsv2-day:disabled { opacity: .35; cursor: default; }
      .rsv2-day-selected { background: ${COLORS.glassNavy}; color: ${COLORS.white}; border-color: ${COLORS.glassNavy}; }
      .rsv2-day-num { font-size: 16px; font-weight: 800; font-variant-numeric: tabular-nums; }
      .rsv2-day-dots { position: absolute; left: 0; right: 0; bottom: 5px; display: flex; justify-content: center; gap: 3px; }
      .rsv2-day-dots i { width: 5px; height: 5px; border-radius: 999px; background: ${COLORS.yellow}; border: .5px solid rgba(4,57,94,.3); }
      .rsv2-day-dots i.rsv2-dot-nearby { background: ${COLORS.green}; border-color: transparent; }
      .rsv2-day-pad { min-height: 48px; }
      .rsv2-legend { display: flex; gap: 16px; margin-top: 12px; font-size: 14px; color: ${S.muted}; flex-wrap: wrap; }
      .rsv2-legend i { display: inline-block; width: 7px; height: 7px; border-radius: 999px; margin-right: 6px; }
      .rsv2-legend .rsv2-legend-open { background: ${COLORS.yellow}; border: .5px solid rgba(4,57,94,.3); }
      .rsv2-legend .rsv2-legend-nearby { background: ${COLORS.green}; }

      .rsv2-slot-col { display: flex; flex-direction: column; gap: 8px; }
      .rsv2-slot { display: grid; grid-template-columns: 1fr; gap: 8px; }
      .rsv2-slot-picked { grid-template-columns: 1fr 1.2fr; }
      .rsv2-time-btn {
        font: inherit;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: ${S.surface};
        border: 2px solid ${S.border};
        border-radius: 12px;
        padding: 12px 14px;
        font-size: 15px;
        font-weight: 700;
        color: ${S.text};
        cursor: pointer;
        font-variant-numeric: tabular-nums;
      }
      .rsv2-slot-picked .rsv2-time-btn { border-color: ${COLORS.glassNavy}; }
      .rsv2-nearby-pill {
        font-size: 12px;
        font-weight: 700;
        color: ${COLORS.green};
        background: ${COLORS.greenLight};
        padding: 2px 8px;
        border-radius: 999px;
        letter-spacing: .02em;
      }
      .rsv2-confirm-btn {
        font: inherit;
        border: 1px solid ${COLORS.glassNavy};
        border-radius: 12px;
        background: ${COLORS.yellow};
        color: ${COLORS.glassNavy};
        font-size: 15px;
        font-weight: 800;
        padding: 12px 14px;
        cursor: pointer;
      }
      .rsv2-confirm-btn:disabled { opacity: .6; cursor: default; }

    `}</style>
  );
}

export default function ReschedulePage() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  // Dark-ship gate for the approved 2026-07-13 redesign — exactly ?v2=1
  // renders the new layout (a false-valued or empty v2 param must NOT flip
  // the kill switch); the legacy layout stays the default until the owner
  // flips.
  const isV2 = searchParams.get('v2') === '1';
  useGlassSurface(true, 'full');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);
  // V2 only: which day's times are showing. Kept valid against the current
  // availability by the effect below (initial load, AI filter, SLOT_TAKEN
  // refresh) — always falls back to the first day with openings.
  const [selectedDate, setSelectedDate] = useState(null);
  // True while the day list shows an AI search's results instead of the full
  // window — gates the "Show all open times" reset.
  const [aiFiltered, setAiFiltered] = useState(false);
  // Bumped on a successful reset; keys the search bar so its internal
  // query/summary recap clears with the filter — a stale "Two openings
  // Tuesday afternoon" line must not sit above the unfiltered day list.
  const [aiSession, setAiSession] = useState(0);

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
    try {
      const res = await fetch(`${API_BASE}/public/reschedule/${token}`, { signal: controller.signal });
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
      setNotFound(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    return () => loadAbortRef.current?.abort();
  }, [load]);

  // Keep the V2 selected day valid whenever availability changes (first load,
  // AI filter/reset, SLOT_TAKEN refresh). Runs harmlessly on the legacy path.
  useEffect(() => {
    const days = data?.availability?.days || [];
    if (!days.length) {
      setSelectedDate(null);
      return;
    }
    setSelectedDate((prev) => (days.some((d) => d.date === prev) ? prev : days[0].date));
  }, [data]);

  // Waves AI date/time search — replaces the day list with the matching
  // window's slots (same availability shape the GET returns) and hands the
  // summary line back to the bar. Throwing lets the bar show its own
  // call-us fallback line.
  const runAiSearch = async (query) => {
    const res = await fetch(`${API_BASE}/public/reschedule/${token}/find-slots`, {
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
  // flash) so the list is fresh. aiFiltered only clears once the full-window
  // response is applied: on failure the filtered list is still what's on
  // screen, so the reset link must survive for another try.
  const showAllTimes = async () => {
    setSelectedSlot(null);
    try {
      const res = await fetch(`${API_BASE}/public/reschedule/${token}`);
      if (!res.ok) return;
      setData(await res.json());
      setAiFiltered(false);
      setAiSession((n) => n + 1); // remount the bar → clears its recap/query
    } catch { /* keep the filtered list + reset link */ }
  };

  const confirm = async () => {
    if (!selectedSlot || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`${API_BASE}/public/reschedule/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: selectedSlot.date,
          start_time: selectedSlot.start_time,
          end_time: selectedSlot.end_time,
          technician_id: selectedSlot.technician_id || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) {
        setResult(body);
        return;
      }
      if (body.code === 'SLOT_TAKEN') {
        setSelectedSlot(null);
        setAiFiltered(false); // refreshed availability spans the full window
        setAiSession((n) => n + 1); // remount the bar — its recap is stale too
        if (body.availability) {
          setData((prev) => (prev ? { ...prev, availability: body.availability } : prev));
        } else {
          await load();
        }
        setSubmitError('That time was just taken — here are the latest open times.');
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
  if (notFound) return <Page><NotFoundCard /></Page>;
  if (result) return <Page><SuccessCard result={result} service={data?.service} /></Page>;
  if (data?.state !== 'reschedulable') return <Page><IneligibleCard data={data} /></Page>;

  const days = data?.availability?.days || [];
  const current = data?.current || {};

  if (isV2) {
    const byDate = new Map(days.map((d) => [d.date, d]));
    const selectedDay = byDate.get(selectedDate) || days[0] || null;
    return (
      // Single column at every width (owner ask 2026-07-14) — the page keeps
      // the standard 640px reading measure on desktop instead of a two-pane
      // split, so the flow reads identically on phone and desktop.
      <Page>
        <V2Styles />
        <V2FloatingAsk key={aiSession} onSearch={runAiSearch} aiFiltered={aiFiltered} onShowAll={showAllTimes} />
        <div className="rsv2-layout">
          <div className="rsv2-col-left">
            <Card>
              <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 6 }}>
                {data.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}pick a new time
              </div>
              <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
                {data.missed ? (
                  <>
                    Your <strong style={{ color: S.text }}>{data.service?.type || 'service'}</strong> visit was set
                    for <strong style={{ color: S.text }}>{formatDateLabel(current.date)}</strong>, but it looks like
                    we missed each other — pick a new time below and we'll get you taken care of.
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
                <div data-glass="soft" style={{
                  marginTop: 12, background: S.soft, border: `1px solid ${S.softBorder}`,
                  borderRadius: 8, padding: '10px 12px', fontSize: 14, color: S.body, lineHeight: 1.5,
                }}>
                  {selectedSlot && slotReanchors(data, selectedSlot.date)
                    ? 'This time is far enough ahead of your current date that your following visits will shift to match it — your regular schedule follows the new date.'
                    : 'Only this visit will move — the rest of your regular service schedule stays the same.'}
                </div>
              ) : null}
            </Card>
            {aiFiltered ? null : (
              <V2BestTimes
                slots={data?.availability?.slots}
                days={days}
                onPick={(slot, day) => {
                  // slot is the day panel's own row (no date/fullDate fields
                  // of its own) — stamp them from the day so confirm and the
                  // picked-state comparison see the same shape a manual tap
                  // produces.
                  setSelectedDate(day.date);
                  setSelectedSlot({ ...slot, date: day.date, fullDate: day.fullDate });
                  setSubmitError(null);
                }}
              />
            )}
            {days.length > 0 ? (
              <V2DayGrid
                availability={data?.availability}
                selectedDate={selectedDay?.date || null}
                onSelectDay={(date) => {
                  setSelectedDate(date);
                  setSelectedSlot(null);
                  setSubmitError(null);
                }}
              />
            ) : null}
          </div>
          <div className="rsv2-col-right">
            {days.length === 0 ? (
              <Card>
                <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
                  {aiFiltered
                    ? 'No open times match that search — try another day, or show all open times above.'
                    : "We don't have open times to offer online right now. Text or call us and we'll find a time that works."}
                </div>
                {aiFiltered ? null : <ContactRow />}
              </Card>
            ) : (
              <V2TimesPanel
                day={selectedDay}
                selectedSlot={selectedSlot}
                onSelect={setSelectedSlot}
                onConfirm={confirm}
                submitting={submitting}
                submitError={submitError}
                reanchorNote={!!(selectedSlot && slotReanchors(data, selectedSlot.date))}
              />
            )}
            <Card data-glass="soft" style={{ background: S.page }}>
              <div style={{ fontSize: 14, color: S.body, lineHeight: 1.55 }}>
                Don't see a time that works? Text or call {WAVES_SUPPORT_PHONE_DISPLAY} and our team will fit you in.
              </div>
              <ContactRow />
            </Card>
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <Card>
        <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 6 }}>
          {data.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}pick a new time
        </div>
        <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
          {data.missed ? (
            <>
              Your <strong style={{ color: S.text }}>{data.service?.type || 'service'}</strong> visit was set
              for <strong style={{ color: S.text }}>{formatDateLabel(current.date)}</strong>, but it looks like
              we missed each other — pick a new time below and we'll get you taken care of.
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
          <div data-glass="soft" style={{
            marginTop: 12, background: S.soft, border: `1px solid ${S.softBorder}`,
            borderRadius: 8, padding: '10px 12px', fontSize: 14, color: S.body, lineHeight: 1.5,
          }}>
            {selectedSlot && slotReanchors(data, selectedSlot.date)
              ? 'This time is far enough ahead of your current date that your following visits will shift to match it — your regular schedule follows the new date.'
              : 'Only this visit will move — the rest of your regular service schedule stays the same.'}
          </div>
        ) : null}
      </Card>

      <Card>
        <div style={{ fontSize: 17, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 4 }}>
          Open times
        </div>
        <div style={{ fontSize: 14, color: S.muted, marginBottom: 16 }}>
          Tap a time, then confirm. Your technician arrives within the window shown.
        </div>

        <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
          <WavesAIScheduleSearch
            key={aiSession}
            theme={{ accent: COLORS.glassNavy, accentText: COLORS.white, text: S.text, muted: S.muted, border: S.softBorder, surface: S.surface, inputBg: S.soft }}
            onSearch={runAiSearch}
          />
          {aiFiltered ? (
            <button
              type="button"
              onClick={showAllTimes}
              style={{
                justifySelf: 'start', background: 'transparent', border: 'none', padding: 0,
                color: COLORS.glassNavy, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Show all open times
            </button>
          ) : null}
        </div>

        {submitError ? (
          <div style={{
            background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8,
            padding: '10px 12px', fontSize: 14, color: '#9A3412', marginBottom: 14, lineHeight: 1.45,
          }}>
            {submitError}
          </div>
        ) : null}

        {days.length === 0 ? (
          <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
            {aiFiltered
              ? 'No open times match that search — try another day, or show all open times above.'
              : "We don't have open times to offer online right now. Text or call us and we'll find a time that works."}
            {aiFiltered ? null : <ContactRow />}
          </div>
        ) : (
          <>
            {days.map((day) => (
              <DayGroup key={day.date} day={day} selectedSlot={selectedSlot} onSelect={setSelectedSlot} />
            ))}
            {selectedSlot && slotReanchors(data, selectedSlot.date) ? (
              <div style={{ marginBottom: 10 }}><ReanchorNote /></div>
            ) : null}
            <button
              type="button"
              data-glass-accent=""
              onClick={confirm}
              disabled={!selectedSlot || submitting}
              style={{
                ...PRIMARY_CTA,
                marginTop: 6,
                opacity: !selectedSlot || submitting ? 0.5 : 1,
                cursor: !selectedSlot || submitting ? 'default' : 'pointer',
              }}
            >
              {submitting
                ? 'Moving your visit…'
                : selectedSlot
                  ? `Move to ${selectedSlot.fullDate}, ${selectedSlot.start_label}`
                  : 'Pick a time above'}
            </button>
          </>
        )}
      </Card>

      <Card data-glass="soft" style={{ background: S.page }}>
        <div style={{ fontSize: 14, color: S.body, lineHeight: 1.55 }}>
          Don't see a time that works? Text or call {WAVES_SUPPORT_PHONE_DISPLAY} and our team will fit you in.
        </div>
        <ContactRow />
      </Card>
    </Page>
  );
}
