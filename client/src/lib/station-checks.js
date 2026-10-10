// client/src/lib/station-checks.js
//
// Bait station checks, shared by the full completion form
// (pages/admin/SchedulePage.jsx, the station map) and the one-screen Fast
// Complete sheet (components/tech/FastCompleteStations.jsx,
// GATE_STATION_FAST_COMPLETE). One copy of each rule, so the two surfaces
// cannot drift:
//  - the status labels (the rodent program reads "Consumption");
//  - the typed station counts the visit's findings carry, derived from the
//    stations' statuses (stationAutoCounts);
//  - the entries the completion posts as `termiteStations`.
// The program of a visit is STATION_TYPE_PROGRAM (typed-findings-rules.js),
// which must match the server's stationProgramForProfile.
import { STATION_TYPE_PROGRAM } from "./typed-findings-rules";

// The two station forms whose checks ride the one-screen sheet. A rodent trap
// check (rodent_trapping, program "trapping") keeps the full form: its setup
// and serviced rules differ (a declared initial setup refuses serviced pins,
// captures rather than consumption). Must match STATION_SHEET_PROGRAMS in
// server/services/visit-station-facts.js.
export const STATION_SHEET_TYPES = Object.freeze(["termite_bait_station", "rodent_bait_station"]);

// The station program a visit's primary form puts on the sheet, or null:
// STATION_TYPE_PROGRAM of the two forms above (equal to what the server's
// stationProgramForProfile gives a visit with no companion form).
export function stationSheetProgram(findingsType) {
  return STATION_SHEET_TYPES.includes(findingsType) ? STATION_TYPE_PROGRAM[findingsType] : null;
}

// Status VALUES are shared across programs (one DB CHECK); only the labels
// differ — 'activity' reads "Activity" for termite, "Consumption" for rodent
// (owner rodent-wording rules: exterior bait consumption, never
// interior-infestation language).
export const STATION_STATUS_UI = {
  ok: { color: "#10b981", label: "OK" },
  activity: { color: "#ef4444", label: "Activity" },
  serviced: { color: "#f59e0b", label: "Serviced" },
  inaccessible: { color: "#94a3b8", label: "No access" },
};
export const STATION_PROGRAM_UI = {
  termite: {
    title: "Bait station map",
    hint: "Every station starts as OK — tap a pin to flag activity, service, or no access.",
    activityLabel: "Activity",
    activityCounter: "with activity",
  },
  rodent: {
    title: "Rodent bait station map",
    hint: "Every station starts as OK — tap a pin to flag consumption, service, or no access.",
    activityLabel: "Consumption",
    activityCounter: "with consumption",
  },
  trapping: {
    title: "Rodent trap map",
    hint: "Every trap starts as OK — tap a pin to record a capture, service, or no access.",
    activityLabel: "Capture",
    activityCounter: "with captures",
  },
};
export function stationStatusLabel(status, program) {
  if (status === "activity") return STATION_PROGRAM_UI[program]?.activityLabel || "Activity";
  return STATION_STATUS_UI[status]?.label || status;
}

// The order a tap on a station's chip cycles through on the sheet: ok,
// activity, serviced, no access, and back to ok.
export const STATION_STATUS_CYCLE = Object.freeze(["ok", "activity", "serviced", "inaccessible"]);
export function nextStationStatus(status) {
  const at = STATION_STATUS_CYCLE.indexOf(status || "ok");
  return STATION_STATUS_CYCLE[(at + 1) % STATION_STATUS_CYCLE.length];
}

// The typed counts a visit's station form carries, derived from the stations'
// statuses (the full form writes them while the map is on; the sheet sends
// them as the typed values the server validates).
//  - activeKeys: the stations counted (a drift-hidden pin that was never
//    re-placed is left out by the caller);
//  - statuses: { key → status }, an absent key is 'ok';
//  - visitOutcome / isExplicit: on inspection_only, the VISIT-SPECIFIC counts
//    (checked / inaccessible / activity) also need an explicit tap or move —
//    the zero-tap default is not itself an inspection (codex round-8 P1);
//    total_stations stays the full roster regardless of outcome (the map's
//    roster size, not a visit result; codex round-9 P1). A "Customer
//    declined" visit inspected NOTHING: its visit-specific counts are zero
//    (codex round-2 P1).
// Each program maps to ITS schema's count keys — never write a key the schema
// doesn't own, or submit validation rejects the unknown field. Trapping owns
// traps_checked only: captures is a tech-judgment count (one trap can hold
// multiple captures), and the schema has no total/inaccessible keys.
export function stationAutoCounts({ program, activeKeys, statuses = {}, visitOutcome = "completed", isExplicit = () => false }) {
  const isInspectionOnly = visitOutcome === "inspection_only";
  const isCustomerDeclined = visitOutcome === "customer_declined";
  const checkedKeys = isCustomerDeclined
    ? []
    : isInspectionOnly
      ? activeKeys.filter((key) => isExplicit(key))
      : activeKeys;
  const statusOf = (key) => statuses[key] || "ok";
  const inaccessible = checkedKeys.filter((key) => statusOf(key) === "inaccessible").length;
  return program === "trapping"
    ? { traps_checked: String(checkedKeys.length - inaccessible) }
    : {
      // total_stations is termite-only since 2026-07-23: the rodent
      // schema retired it (the map's pins ARE the roster), and writing it
      // there would trip the unknown-field rejection at submit
      // (codex P1 on #2963).
      ...(program === "termite"
        ? { total_stations: String(activeKeys.length) }
        : {}),
      stations_checked: String(checkedKeys.length - inaccessible),
      stations_inaccessible: String(inaccessible),
      // Only the termite schema carries a per-station activity COUNT; the
      // rodent flow records consumption as a select (tech judgment).
      ...(program === "termite"
        ? { stations_with_activity: String(checkedKeys.filter((key) => statusOf(key) === "activity").length) }
        : {}),
    };
}

// The entry a station that is neither moved nor retired contributes to the
// completion's `termiteStations`, as the full form sends it: `touched` marks an
// explicit tap, distinguishing it from the zero-tap 'ok' default.
export function stationCheckEntry(id, statuses = {}) {
  const tapped = Object.prototype.hasOwnProperty.call(statuses, id);
  return { id, status: statuses[id] || "ok", ...(tapped ? { touched: true } : {}) };
}

// Mirrors the server's rodentConsumptionConflict (termite-stations.js): a
// station recording bait consumption must not ship beside an explicit "None"
// bait consumption level, or the customer report would contradict itself.
// Returns the message or null.
export function rodentConsumptionHold({ program, statuses = {}, values = {} }) {
  if (program !== "rodent") return null;
  if (!Object.values(statuses).includes("activity")) return null;
  if (String(values?.bait_consumption ?? "").trim().toLowerCase() !== "none") return null;
  return 'A station is marked with bait consumption this visit, but the Bait consumption level reads "None". Change one of them.';
}

// The exception statuses the note can name, as the server's reader returns
// them (visit-station-facts.js EXCEPTION_STATUSES): 'ok' is the default and
// never named.
const HEARD_STATUSES = ["activity", "serviced", "inaccessible"];

// The sheet's station marks: { statuses: { id → status }, picked: { id → true },
// quotes: { id → words } }. A station is absent from `statuses` while it reads
// OK. `picked` holds every station the tech tapped (a tap, even back to OK, is
// the tech's word over the note); `quotes` holds the words an exception was
// heard from. A note's read replaces what an earlier read heard and never
// touches a station the tech tapped. Only ids the sheet shows can be marked.
export const EMPTY_STATION_MARKS = Object.freeze({ statuses: {}, picked: {}, quotes: {} });

export function mergeHeardStationExceptions(marks, exceptions, validIds) {
  if (!Array.isArray(exceptions)) return marks;
  const valid = new Set(validIds.map(String));
  const statuses = { ...marks.statuses };
  const quotes = { ...marks.quotes };
  // What an earlier read heard goes first (the note may have changed).
  for (const id of Object.keys(quotes)) {
    if (!marks.picked[id]) {
      delete statuses[id];
      delete quotes[id];
    }
  }
  for (const item of exceptions) {
    const id = String(item?.id);
    if (!valid.has(id) || marks.picked[id] || !HEARD_STATUSES.includes(item?.status) || typeof item?.quote !== "string") continue;
    statuses[id] = item.status;
    quotes[id] = item.quote;
  }
  return { ...marks, statuses, quotes };
}

// The tech's tap on a station's chip: the next status in the cycle. Back to OK
// leaves the station unmarked, and the tap stays the tech's word.
export function tapStationMark(marks, id) {
  const key = String(id);
  const next = nextStationStatus(marks.statuses[key]);
  const statuses = { ...marks.statuses };
  const quotes = { ...marks.quotes };
  delete quotes[key];
  if (next === "ok") delete statuses[key];
  else statuses[key] = next;
  return { statuses, quotes, picked: { ...marks.picked, [key]: true } };
}

// The tech flags a station the note did not name: activity (consumption for
// the rodent program), the first step of the cycle.
export function flagStationMark(marks, id) {
  const key = String(id);
  if (marks.statuses[key]) return marks;
  return tapStationMark(marks, key);
}
