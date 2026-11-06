/**
 * Slot look-ahead for the estimate SlotPicker.
 *
 * The page asks for 14 days. A big first visit (a 4-service estimate holds
 * 60 minutes per service back to back = one 240-minute block) can have no
 * block that soon, and the customer used to hit a dead end: an empty list,
 * and a date search / date pick that answered empty too. When a normal,
 * bookable answer comes back with no slots, this module reads further
 * ahead (the 90-day booking horizon the server and the reserve route
 * accept) with plain GETs, caches the result for the current param set, and
 * works out what to show. The slots it returns are ordinary API slots, so
 * picking one goes through the same selection path as any other slot.
 *
 * It never calls find-slots (that endpoint is an LLM parse, a paid call).
 */
import { useEffect, useRef, useState } from 'react';

export const LOOKAHEAD_DAYS = 90;
const LIST_SLOT_COUNT = 3;

// Bodies the slot reads answer with INSTEAD of slots (200 with empty lists):
// an estimate parked for the office or sent to review, a commercial estimate
// the office schedules, an invoice-only renewal. Looking further ahead for
// them would offer times the page must not book.
const NO_BOOKING_FLAGS = ['reviewBeforeBooking', 'commercialManualScheduling', 'invoiceOnlyAcceptance'];

export const bodySlots = (body) => (body ? [...(body.primary || []), ...(body.expander || [])] : []);

const isBrowsable = (body) => !!body && !NO_BOOKING_FLAGS.some((flag) => body[flag]);

// A normal, bookable answer that simply has no open slot in its window.
export const isEmptyBrowsable = (body) => isBrowsable(body) && bodySlots(body).length === 0;

// Date, then start time; one entry per slotId.
export function sortSlots(slots) {
  const seen = new Set();
  return slots
    .filter((slot) => {
      if (!slot?.date || seen.has(slot.slotId)) return false;
      seen.add(slot.slotId);
      return true;
    })
    .sort((a, b) => (a.date === b.date
      ? String(a.windowStart || '').localeCompare(String(b.windowStart || ''))
      : (a.date < b.date ? -1 : 1)));
}

// Same query the list fetch and the date browse build (cadence axes included).
export function slotQueryParams({ serviceMode, selectedFrequency, serviceCadences }) {
  const p = new URLSearchParams();
  p.set('serviceMode', serviceMode === 'one_time' ? 'one_time' : 'recurring');
  if (serviceMode !== 'one_time' && selectedFrequency) p.set('selectedFrequency', selectedFrequency);
  if (serviceMode !== 'one_time' && serviceCadences) p.set('serviceCadences', JSON.stringify(serviceCadences));
  return p;
}

async function getBody(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('lookahead fetch failed');
  return res.json();
}

// One 90-day read. The list the API returns is capped and route-ordered, so
// the earliest opening can be missing from it; metadata.firstDayAvailability
// names the true first open day, and one ?date= read adds that day's slots.
export async function fetchLookaheadSlots({ apiBase, token, params }) {
  const base = `${apiBase}/public/estimates/${token}/available-slots`;
  const wide = slotQueryParams(params);
  wide.set('windowDays', String(LOOKAHEAD_DAYS));
  const body = await getBody(`${base}?${wide.toString()}`);
  if (!isBrowsable(body)) return [];
  let slots = bodySlots(body);
  const firstDay = body.metadata?.firstDayAvailability?.date;
  const earliest = sortSlots(slots)[0]?.date;
  if (firstDay && (!earliest || firstDay < earliest)) {
    const day = slotQueryParams(params);
    day.set('date', firstDay);
    try {
      const dayBody = await getBody(`${base}?${day.toString()}`);
      if (isBrowsable(dayBody)) slots = [...slots, ...bodySlots(dayBody)];
    } catch { /* the 90-day list alone still gives the customer times */ }
  }
  return sortSlots(slots);
}

const IDLE = { key: null, status: 'idle', slots: [] };

// One look-ahead read per param set (and refresh), held in component state.
// A result for an older param set is ignored. A failed or empty read is not
// retried for the same params. `answer` is the body on screen (list, date
// search or picked date); the read starts when it is a bookable answer with
// no slots and the page is not `blocked` (loading, failed, staff preview).
function useLookaheadRead({
  apiBase, token, serviceMode, selectedFrequency, serviceCadences, refreshSignal, answer, blocked,
}) {
  const key = JSON.stringify([token, serviceMode, selectedFrequency, serviceCadences, refreshSignal]);
  const needed = !blocked && isEmptyBrowsable(answer);
  const [state, setState] = useState(IDLE);
  const startedRef = useRef(null);
  useEffect(() => {
    if (!needed || startedRef.current === key) return;
    startedRef.current = key;
    setState({ key, status: 'loading', slots: [] });
    fetchLookaheadSlots({ apiBase, token, params: { serviceMode, selectedFrequency, serviceCadences } })
      .then((slots) => ({ status: slots.length ? 'done' : 'empty', slots }), () => ({ status: 'failed', slots: [] }))
      .then((result) => {
        if (startedRef.current === key) setState({ key, ...result });
      });
  }, [needed, key, apiBase, token, serviceMode, selectedFrequency, serviceCadences]);
  return state.key === key ? state : IDLE;
}

const shortDay = (ymd) => new Date(`${ymd}T12:00:00Z`)
  .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

const firstAfter = (slots, ymd) => (ymd ? slots.find((slot) => slot.date > ymd) : null) || null;

// What the look-ahead adds to the screen:
//   loading  true while the read runs ("Looking further ahead…")
//   slots    the slots to show in place of the empty answer (null = none)
//   ordered  true when `slots` must keep date order (not the engine's rank)
//   notice   the line above them
//   stripProps  SchedulePicker props for the best-times strip ({} = its defaults)
// `slots` here are the usable look-ahead slots (stale ones already dropped).
function lookaheadView({ data, searchData, pickedData, pickedDate, status, slots, formatTime }) {
  const none = { loading: false, slots: null, ordered: false, notice: null, stripProps: {} };
  const body = searchData || pickedData || data;
  if (!isEmptyBrowsable(body)) return none;
  // 'idle' is the render before the read starts: the page is already past its own load.
  if (status === 'loading' || status === 'idle') return { ...none, loading: true };
  if (status !== 'done') return none;
  const at = (slot) => `${shortDay(slot.date)} at ${formatTime(slot)}`;
  if (!searchData && !pickedData) {
    return {
      ...none,
      slots: slots.slice(0, LIST_SLOT_COUNT),
      ordered: true,
      notice: 'The next 2 weeks are full. Here are the first open times:',
      // The soonest times, not route picks: drop the strip's route-fit copy.
      stripProps: { bestTitle: null, bestIntro: null },
    };
  }
  if (searchData) {
    const after = firstAfter(slots, searchData.window?.date_to);
    const slot = after || slots[0];
    if (!slot) return none;
    // "after that" only when the slot really is after the searched window.
    const lead = after ? 'The first open time after that is' : 'The first open time is';
    return { ...none, slots: [slot], notice: `Nothing is open then. ${lead} ${at(slot)}.` };
  }
  const slot = firstAfter(slots, pickedDate);
  return slot
    ? { ...none, slots: [slot], notice: `Nothing is open on ${shortDay(pickedDate)}. The next open time is ${at(slot)}.` }
    : none;
}

// The look-ahead for the SlotPicker: reads on demand and returns what to show
// (see lookaheadView) plus `all`, every slot read, so a pick made from them
// stays a visible selection. `isStale` drops slots already inside the lead.
export function useSlotLookahead({ data, searchData, pickedData, pickedDate, isStale, formatTime, ...read }) {
  const state = useLookaheadRead({ ...read, answer: searchData || pickedData || data });
  const view = lookaheadView({
    data,
    searchData,
    pickedData,
    pickedDate,
    status: state.status,
    slots: state.slots.filter((slot) => !isStale(slot)),
    formatTime,
  });
  return { ...view, all: state.slots };
}
