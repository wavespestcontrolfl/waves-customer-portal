/**
 * SchedulePicker — the ONE customer-facing date/time picker (owner ruling
 * 2026-09-03, "consistent brand representation"): the reschedule page's
 * calendar-first layout (owner-approved 2026-07-13) lifted out so the
 * estimate, /book, re-service and reschedule surfaces all pick a time the
 * same way — route-ranked "Our best times", a Monday-start day grid, then
 * the chosen day's times with an inline slot for whatever the page does
 * next (Confirm, an arrival window, nothing).
 *
 * Presentational only. Every page keeps its own fetch, search and submit;
 * this component takes the reschedule availability shape
 *   { days: [{ date, fullDate, nearby, rainChance, slots: [{ start_time, start_label, nearby?, slotId?, … }] }],
 *     slots?: [ranked { date, start_time, slotId? }], rangeFrom?, rangeTo? }
 * `nearby` on a slot is that slot's own route-fit; the day's flag is the
 * roll-up the calendar dots and legend use.
 * and hands back the day's own slot object stamped with { date, fullDate },
 * so a page's confirm payload is identical to what its old list produced.
 *
 * Slot identity: slotId when both sides carry one (estimate), else
 * date + start_time (booking / reschedule / re-service).
 */
import Icon from '../Icon';
import { COLORS, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE as S } from '../../theme-customer';
import { etDateString } from '../../lib/timezone';

const FONT_BODY = FONTS.body;

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

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Grid bounds when the payload carries none: at least the two-week window
// from today (ET) that every availability builder offers by default,
// widened to reach the last open day. A list that starts past that window
// (a searched or picked date further out) collapses to the days themselves
// rather than drawing weeks of empty cells before the first opening.
export function pickerRange(days) {
  const today = etDateString();
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  let from = first && first < today ? first : today;
  if (first && first > addDays(from, 13)) from = first;
  const twoWeeks = addDays(from, 13);
  return { rangeFrom: from, rangeTo: last && last > twoWeeks ? last : twoWeeks };
}

function shortMonthDay(dateStr, { withMonth = true } = {}) {
  const dt = parseYMD(dateStr);
  if (!dt) return '';
  return dt.toLocaleDateString('en-US', withMonth ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { day: 'numeric', timeZone: 'UTC' });
}

function rangeLabel(from, to) {
  const a = parseYMD(from);
  const b = parseYMD(to);
  if (!a || !b) return '';
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  return `${shortMonthDay(from)} – ${shortMonthDay(to, { withMonth: !sameMonth })}`;
}

// 'YYYY-MM-DD' → "Monday, June 1" (UTC-noon parse: slot dates are ET
// calendar dates and must not drift in a west-coast browser).
export function pickerDayLabel(dateStr) {
  const dt = parseYMD(dateStr);
  if (!dt) return String(dateStr || '');
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function sameSlot(a, b) {
  if (!a || !b) return false;
  if (a.slotId && b.slotId) return a.slotId === b.slotId;
  return a.date === b.date && a.start_time === b.start_time;
}

function Section({ frame, children, ...rest }) {
  if (frame === 'inner') {
    return (
      <div
        {...rest}
        className={['wpk-section', 'wpk-section-inner', rest.className].filter(Boolean).join(' ')}
      >
        {children}
      </div>
    );
  }
  return (
    <div data-glass="card" {...rest} className={['wpk-section', rest.className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}

function SectionTitle({ children, aside }) {
  return (
    <div className="wpk-head">
      <div data-gt="h3x" className="wpk-title">{children}</div>
      {aside ? <div className="wpk-aside">{aside}</div> : null}
    </div>
  );
}

// Route-ranked top picks. The ranked list is already sorted by the slot
// engine's score (detour minutes + days-out) — surfacing it is the whole
// point. Copy stays privacy-safe: never another customer's name or address.
export function PickerBestTimes({ slots, days, onPick, frame }) {
  const byDate = new Map((days || []).map((d) => [d.date, d]));
  // Only recommend slots the day panel actually renders — the ranked list
  // and days[].slots are built separately server-side, and a pick with no
  // matching panel row would select a slot the times panel never shows.
  // Nearby slots lead; within a group the engine's `rank` (lower = better;
  // /book's curated list arrives chronological, so list order is NOT the
  // ranking) decides, and list order only breaks ties or stands in when no
  // rank rides along (estimate slots are engine-ordered).
  const rankOf = (panelSlot, s) => [panelSlot.rank, s.rank].find(Number.isFinite) ?? null;
  const picks = (slots || [])
    .map((s, i) => {
      const day = s.date ? byDate.get(s.date) : null;
      // slotId first (two technicians can share a date + start), else time.
      const panelSlot = day?.slots?.find((x) => (s.slotId ? x.slotId === s.slotId : x.start_time === s.start_time));
      return panelSlot ? { s: panelSlot, day, i, nearby: !!panelSlot.nearby, rank: rankOf(panelSlot, s) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (Number(b.nearby) - Number(a.nearby))
      || ((a.rank != null && b.rank != null) ? a.rank - b.rank : 0)
      || (a.i - b.i))
    .slice(0, 3);
  if (!picks.length) return null;
  return (
    <Section frame={frame}>
      <SectionTitle>Our best times for you</SectionTitle>
      <div className="wpk-intro">These fit our route near you best — easiest for everyone.</div>
      <div className="wpk-best-row">
        {picks.map(({ s: slot, day, nearby }) => (
          <button
            type="button"
            data-glass="chip"
            key={slot.slotId || `${day.date}|${slot.start_time}`}
            className="wpk-best-chip"
            onClick={() => onPick(slot, day)}
          >
            <span>
              <span className="wpk-best-when">{day.fullDate} {'·'} {slot.start_label}</span>
              <span className="wpk-best-why">
                {nearby ? "We're servicing a property close to you that day" : 'Available appointment'}
                {/* Rain marker (GATE_BOOKING_RAIN_CHIPS): appended only ≥40% */}
                {Number.isFinite(day.rainChance ?? slot.rainChance) && (day.rainChance ?? slot.rainChance) >= 40
                  ? ` · ${Math.round(day.rainChance ?? slot.rainChance)}% rain`
                  : ''}
              </span>
            </span>
            <span className="wpk-best-go">Pick {'→'}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

export function PickerDayGrid({ availability, selectedDate, onSelectDay, frame }) {
  const days = availability?.days || [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const fallback = availability?.rangeFrom && availability?.rangeTo ? null : pickerRange(days);
  const from = availability?.rangeFrom || fallback.rangeFrom;
  const to = availability?.rangeTo || fallback.rangeTo;
  const dates = listRangeDates(from, to);
  if (!dates.length) return null;
  const leading = mondayIndex(dates[0]);
  return (
    <Section frame={frame}>
      <SectionTitle aside={rangeLabel(from, to)}>Pick a day</SectionTitle>
      <div className="wpk-dow" aria-hidden="true">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((letter, i) => <span key={`${letter}-${i}`}>{letter}</span>)}
      </div>
      <div className="wpk-grid" role="listbox" aria-label="Days with open times">
        {Array.from({ length: leading }, (_, i) => <span key={`pad-${i}`} className="wpk-day-pad" />)}
        {dates.map((date) => {
          const day = byDate.get(date);
          const open = !!day?.slots?.length;
          const label = day?.fullDate || pickerDayLabel(date);
          // Rain marker (GATE_BOOKING_RAIN_CHIPS): tiny corner umbrella on
          // ≥40% days. Field absent → nothing.
          const rainy = open && Number.isFinite(day.rainChance) && day.rainChance >= 40;
          return (
            <button
              type="button"
              key={date}
              role="option"
              aria-selected={date === selectedDate}
              className={`wpk-day${date === selectedDate ? ' wpk-day-selected' : ''}`}
              disabled={!open}
              aria-label={open
                ? `${label}${day.nearby ? ' — tech in your neighborhood' : ''}${rainy ? ` — ${Math.round(day.rainChance)}% chance of rain` : ''}, ${day.slots.length} ${day.slots.length === 1 ? 'opening' : 'openings'}`
                : `${label}, no open times`}
              onClick={() => open && onSelectDay(date)}
            >
              {rainy ? <span className="wpk-day-rain" aria-hidden="true"><Icon name="cloudRain" size={10} /></span> : null}
              <span className="wpk-day-num">{shortMonthDay(date, { withMonth: false })}</span>
              {open ? (
                <span className="wpk-day-dots">
                  {day.slots.slice(0, 3).map((slot, i) => (
                    <i key={i} className={slot.nearby ? 'wpk-dot-nearby' : ''} />
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="wpk-legend">
        <span><i className="wpk-legend-open" />Openings</span>
        <span><i className="wpk-legend-nearby" />Tech in your neighborhood</span>
      </div>
    </Section>
  );
}

export function PickerTimesPanel({
  day,
  selectedSlot,
  onSelect,
  submitError = null,
  intro = 'Tap a time, then confirm. Your technician arrives within a two-hour window of the start time.',
  emptyDay = "No open times this day — pick another day above, or text Waves and we'll fit you in.",
  pickedExtra = null,
  slotDetail = null,
  frame,
}) {
  return (
    <Section frame={frame}>
      <SectionTitle>{day ? day.fullDate : 'Open times'}</SectionTitle>
      {intro ? <div className="wpk-intro wpk-intro-times">{intro}</div> : null}
      {submitError ? <div className="wpk-error" role="alert">{submitError}</div> : null}
      {!day || !day.slots?.length ? (
        <div className="wpk-empty-day">{emptyDay}</div>
      ) : (
        <div className="wpk-slot-col">
          {day.slots.map((slot) => {
            const stamped = { ...slot, date: day.date, fullDate: day.fullDate };
            const picked = sameSlot(selectedSlot, stamped);
            const detail = slotDetail ? slotDetail(stamped, day) : null;
            return (
              <div key={slot.slotId || `${day.date}|${slot.start_time}`} className={`wpk-slot${picked ? ' wpk-slot-picked' : ''}`}>
                <button
                  type="button"
                  {...(picked ? { 'data-glass-accent': '' } : { 'data-glass': 'chip' })}
                  className="wpk-time-btn"
                  data-schedule-slot=""
                  aria-pressed={picked}
                  aria-label={`Choose ${slot.start_label} on ${day.fullDate}${slot.nearby ? ', technician already in your neighborhood' : ''}`}
                  onClick={() => onSelect(picked ? null : stamped)}
                >
                  <span className="wpk-time-main">
                    {slot.start_label}
                    {slot.nearby ? <span className="wpk-nearby-pill">Tech nearby</span> : null}
                  </span>
                  {detail ? <span className="wpk-time-detail">{detail}</span> : null}
                </button>
                {picked && pickedExtra ? pickedExtra(stamped, day) : null}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// Class-prefixed (wpk-) so nothing leaks into the page around it.
export function SchedulePickerStyles() {
  return (
    <style>{`
      .wpk-section {
        background: ${S.surface};
        border: 1px solid ${S.border};
        border-radius: 12px;
        padding: 24px;
        margin-bottom: 16px;
        font-family: ${FONT_BODY};
        color: ${S.text};
      }
      .wpk-section-inner { border-radius: 10px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 2px rgba(4, 57, 94, 0.06); }
      .wpk-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 2px; }
      .wpk-title { font-size: 17px; font-weight: 700; font-family: ${FONTS.heading}; color: ${S.text}; }
      .wpk-aside { font-size: 14px; color: ${S.muted}; white-space: nowrap; }
      .wpk-intro { font-size: 14px; color: ${S.muted}; line-height: 1.45; margin-bottom: 12px; }
      .wpk-intro-times { margin-bottom: 14px; }
      .wpk-error {
        background: #FFF7ED; border: 1px solid #FED7AA; border-radius: 8px;
        padding: 10px 12px; font-size: 14px; color: #9A3412; margin-bottom: 14px; line-height: 1.45;
      }
      .wpk-empty-day { font-size: 15px; color: ${S.body}; line-height: 1.55; }

      .wpk-best-row { display: flex; flex-direction: column; gap: 8px; }
      .wpk-best-chip {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        text-align: left; font: inherit; cursor: pointer;
        background: #FFFBEA; border: 1px solid #F5D76E; border-radius: 12px;
        padding: 12px 14px; color: ${S.text};
      }
      .wpk-best-when { display: block; font-size: 15px; font-weight: 700; }
      .wpk-best-why { display: block; font-size: 14px; font-weight: 500; color: ${S.muted}; margin-top: 2px; }
      .wpk-best-go {
        flex: 0 0 auto; font-size: 14px; font-weight: 700; color: ${COLORS.glassNavy};
        background: ${COLORS.yellow}; border-radius: 999px; padding: 7px 13px; white-space: nowrap;
      }

      .wpk-dow, .wpk-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
      .wpk-head + .wpk-dow { margin-top: 10px; }
      .wpk-dow { margin-bottom: 6px; }
      .wpk-dow span { font-size: 14px; font-weight: 700; text-align: center; color: ${S.muted}; }
      .wpk-day {
        position: relative; font: inherit; border: 1px solid ${S.border}; background: ${S.surface};
        border-radius: 12px; padding: 10px 0 14px; cursor: pointer; color: ${S.text};
        text-align: center; min-height: 48px;
      }
      .wpk-day:disabled { opacity: .35; cursor: default; }
      .wpk-day-selected { background: ${COLORS.glassNavy}; color: ${COLORS.white}; border-color: ${COLORS.glassNavy}; }
      .wpk-day-num { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .wpk-day-rain { position: absolute; top: 2px; right: 4px; line-height: 1; opacity: .85; }
      .wpk-day-dots { position: absolute; left: 0; right: 0; bottom: 5px; display: flex; justify-content: center; gap: 3px; }
      .wpk-day-dots i { width: 5px; height: 5px; border-radius: 999px; background: ${COLORS.yellow}; border: .5px solid rgba(4,57,94,.3); }
      .wpk-day-dots i.wpk-dot-nearby { background: ${COLORS.green}; border-color: transparent; }
      .wpk-day-pad { min-height: 48px; }
      .wpk-legend { display: flex; gap: 16px; margin-top: 12px; font-size: 14px; color: ${S.muted}; flex-wrap: wrap; }
      .wpk-legend i { display: inline-block; width: 7px; height: 7px; border-radius: 999px; margin-right: 6px; }
      .wpk-legend .wpk-legend-open { background: ${COLORS.yellow}; border: .5px solid rgba(4,57,94,.3); }
      .wpk-legend .wpk-legend-nearby { background: ${COLORS.green}; }

      .wpk-slot-col { display: flex; flex-direction: column; gap: 8px; }
      .wpk-slot { display: grid; grid-template-columns: 1fr; gap: 8px; }
      .wpk-has-action .wpk-slot-picked { grid-template-columns: 1fr 1.2fr; }
      .wpk-time-btn {
        font: inherit; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
        background: ${S.surface}; border: 2px solid ${S.border}; border-radius: 12px;
        padding: 12px 14px; font-size: 15px; font-weight: 700; color: ${S.text};
        cursor: pointer; font-variant-numeric: tabular-nums;
      }
      .wpk-time-main { display: inline-flex; align-items: center; gap: 8px; }
      .wpk-time-detail { font-size: 14px; font-weight: 500; color: ${S.muted}; }
      .wpk-slot-picked .wpk-time-btn { border-color: ${COLORS.glassNavy}; }
      .wpk-slot-picked .wpk-time-detail { color: inherit; opacity: .85; }
      .wpk-nearby-pill {
        font-size: 14px; font-weight: 700; color: ${COLORS.green}; background: ${COLORS.greenLight};
        padding: 2px 8px; border-radius: 999px; letter-spacing: .02em;
      }
      .wpk-action-btn {
        font: inherit; border: 1px solid ${COLORS.glassNavy}; border-radius: 12px;
        background: ${COLORS.yellow}; color: ${COLORS.glassNavy};
        font-size: 15px; font-weight: 700; padding: 12px 14px; cursor: pointer;
      }
      .wpk-action-btn:disabled { opacity: .6; cursor: default; }
      .wpk-picked-note { grid-column: 1 / -1; font-size: 14px; color: ${S.body}; line-height: 1.45; }
    `}</style>
  );
}

/**
 * The composed picker: best times → day grid → the chosen day's times.
 *
 * - `rankedSlots`  the engine-ranked list (availability.slots); null hides the strip
 * - `selectedDate` / `onSelectDay`   which day's times show (page-owned so a
 *   refetch can keep it valid)
 * - `selectedSlot` / `onSelectSlot`  stamped slot or null
 * - `pickedExtra(slot, day)`  node rendered beside the picked time (a
 *   Confirm button, an arrival-window line, …); `action` marks it as a
 *   button-sized column so the row splits 1fr / 1.2fr
 * - `empty`  node rendered instead of the times panel when there are no days
 * - `frame`  'card' (glass card sections) | 'inner' (white inner boxes — the
 *   estimate's own card grammar)
 */
export default function SchedulePicker({
  availability,
  rankedSlots = null,
  selectedDate,
  onSelectDay,
  selectedSlot,
  onSelectSlot,
  submitError = null,
  intro,
  emptyDay,
  pickedExtra = null,
  pickedAction = false,
  slotDetail = null,
  empty = null,
  frame = 'card',
}) {
  const days = availability?.days || [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const selectedDay = byDate.get(selectedDate) || days[0] || null;
  return (
    <>
      <SchedulePickerStyles />
      {rankedSlots ? (
        <PickerBestTimes
          frame={frame}
          slots={rankedSlots}
          days={days}
          onPick={(slot, day) => {
            // slot is the day panel's own row (no date/fullDate fields of
            // its own) — stamp them from the day so the page's confirm and
            // the picked-state comparison see the same shape a manual tap
            // produces.
            onSelectDay(day.date);
            onSelectSlot({ ...slot, date: day.date, fullDate: day.fullDate });
          }}
        />
      ) : null}
      {days.length > 0 ? (
        <PickerDayGrid frame={frame} availability={availability} selectedDate={selectedDay?.date || null} onSelectDay={onSelectDay} />
      ) : null}
      {days.length === 0 ? (
        <>
          {/* A SLOT_TAKEN refresh can come back empty — the reason must
              outlive the list it emptied. */}
          {submitError ? <div className="wpk-error" role="alert">{submitError}</div> : null}
          {empty}
        </>
      ) : (
        <div className={pickedAction ? 'wpk-has-action' : undefined}>
          <PickerTimesPanel
            frame={frame}
            day={selectedDay}
            selectedSlot={selectedSlot}
            onSelect={onSelectSlot}
            submitError={submitError}
            intro={intro}
            emptyDay={emptyDay}
            pickedExtra={pickedExtra}
            slotDetail={slotDetail}
          />
        </div>
      )}
    </>
  );
}
