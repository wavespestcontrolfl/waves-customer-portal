// Dispatch-side "Quick Move Appointment" sheet — the admin equivalent of the
// tech app's QuickMoveSheet (pages/tech/TechHomePage.jsx). Moves this visit
// (or the rest of the assigned tech's route) for weather or a schedule delay
// and texts the customer a self-serve reschedule link, optionally with a
// dispatcher-typed note appended (≤200 chars, no link shorteners — server
// enforces). The gated Custom reason flips the note into the FRONT of the
// text (required, 2-segment cap) with the move line + link appended after.
// All logic lives in
// server/services/rain-out.js; this calls the admin endpoints:
//   GET  /admin/dispatch/:id/rain-out-options
//   POST /admin/dispatch/:id/rain-out
// Opened from MobileAppointmentDetailSheet's action section.
//
// Styling matches the light/zinc detail sheet it opens over (not the tech
// app's dark palette) — neutral chrome only, per the admin design spec.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import useIsMobile from '../../hooks/useIsMobile';
import psl from 'psl';
import { TIMEZONE } from '../../lib/timezone';
import { useBestTimes } from './useBestTimes';
import BestTimeHint from './BestTimeHint';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Same reasons the tech sheet offers; rain-out.js maps each to a
// customer-facing lead in the SMS. The non-weather reasons render only when
// the options payload says the server gate (GATE_QUICKMOVE_EXTRA_REASONS)
// is on — the server rejects the codes otherwise. "No-show" here is the
// SOFT path (visit rebooked + texted); the terminal Mark-as-no-show action
// on the detail sheet keeps the fee/notice machinery.
const RAIN_REASONS = [
  { code: 'weather_rain', label: 'Rain' },
  { code: 'weather_lightning', label: 'Lightning' },
  { code: 'weather_wind', label: 'Wind' },
  { code: 'weather_heat', label: 'Heat' },
];
const EXTRA_REASONS = [
  { code: 'running_late', label: 'Running late' },
  { code: 'equipment_issue', label: 'Equipment trouble' },
  { code: 'tech_emergency', label: 'Emergency' },
  { code: 'customer_noshow', label: 'No-show' },
  // Single stop only, like No-show (server enforces gate_route_scope);
  // the SMS adds a portal nudge so the customer can put gate access on
  // file, then the reschedule link.
  { code: 'gate_locked', label: "Can't access gate" },
];
const EXTRA_REASON_CODES = new Set(EXTRA_REASONS.map((r) => r.code));
// Custom reason (rendered only when the options payload says
// GATE_QUICKMOVE_CUSTOM_REASON is on AND the template row is live): the
// dispatcher's message opens the SMS and the templated move line +
// reschedule link close it. Single stop only; the assembled text is capped
// at 2 SMS segments — the live counter is SERVER-rendered via the
// custom-preview endpoint (no client render mirrors), and commit()
// re-renders and enforces fail-closed.
const CUSTOM_REASON = 'custom';

// Friendly copy for the server's structured rejections.
const ERROR_COPY = {
  noshow_route_scope: 'No-show moves apply to this stop only.',
  gate_route_scope: 'Gate-access moves apply to this stop only.',
  target_not_later: 'Running late needs a time after the current window — pick a later slot.',
  note_too_long: 'Note is too long — keep it under 200 characters.',
  note_link_blocked: "Links can't go in the note — the text already includes the reschedule link.",
  note_emoji_blocked: "Emoji can't go in customer texts — remove them.",
  note_guard_blocked: 'That note would trip the SMS safety guard — avoid {braces} and the words null, undefined, or 1970.',
  note_compliance_blocked: 'That wording isn’t allowed in customer texts — no "safe" claims (say "safe once dry — your technician confirms timing"), no EPA-approved, no fixed re-entry times.',
  note_invalid: 'That note could not be sent — plain text only.',
  custom_route_scope: 'Custom messages apply to this stop only.',
  custom_requires_note: 'Write the message — it becomes the front of the text.',
  note_too_many_segments: 'That message would send as 3+ SMS segments — shorten it to fit 2.',
  custom_message_unavailable: 'The custom-message text template is turned off — use a preset reason.',
};

// Mirrors of the server's note guards (rain-out.js sanitizeCustomerNote) —
// advisory here so the dispatcher sees the problem before tapping Move;
// the server is the enforcer.
const NOTE_MAX_CHARS = 200;
const NOTE_SHORTENER_RE = /(?:^|[^a-z0-9-])(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rb\.gy|tiny\.cc|cutt\.ly|shorturl\.at|rebrand\.ly)(?:$|[^a-z0-9-])/i;
// No URL of ANY kind in a note (shortener blocklists can't be complete) —
// the moved SMS already carries the tokenized reschedule link. Mirrors the
// server: scheme://, www., host.tld+path, IPv4; bare hosts are validated
// against the SAME public-suffix list the server uses (psl) below.
const NOTE_URL_RE = new RegExp([
  '\\b[a-z][a-z0-9+.-]*://\\S+',
  '(?:^|[^a-z0-9.-])www\\.\\S+',
  '(?:^|[^a-z0-9.-])[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}[/?#]\\S',
  '(?:^|[^0-9.])(?:\\d{1,3}\\.){3}\\d{1,3}(?:[:/?#]\\S*)?(?=$|[^0-9])',
].join('|'), 'i');
// Same bare-host detection as the server's containsBareHost (rain-out.js):
// dot-joined candidates confirmed against the public-suffix list; unicode
// hosts punycoded via the browser's URL parser first.
const NOTE_HOST_TOKEN_RE = /(?:^|[^a-z0-9.-])([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)(?=$|[^a-z0-9-])/gi;
const NOTE_UNICODE_HOST_TOKEN_RE = /([\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)+)/gu;
function noteContainsBareHost(text) {
  for (const m of String(text).matchAll(NOTE_HOST_TOKEN_RE)) {
    if (psl.isValid(m[1].toLowerCase())) return true;
  }
  for (const m of String(text).matchAll(NOTE_UNICODE_HOST_TOKEN_RE)) {
    if (/^[\x20-\x7F]+$/.test(m[1])) continue;
    try {
      const ascii = new URL(`http://${m[1]}`).hostname;
      if (ascii && psl.isValid(ascii)) return true;
    } catch { /* not a parseable host — prose */ }
  }
  return false;
}
// Customer-facing SMS are emoji-free (messaging validator EMOJI_FOR_CUSTOMER)
// — catching it here keeps the move from committing with a text that the
// send layer would then block. Same three families the server detects:
// pictographic, regional-indicator flags, keycap sequences.
const NOTE_EMOJI_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[0-9#*]\uFE0F?\u20E3/u;
// Mirror of the outbound sms-guard (server/services/sms-guard.js): bodies
// containing unsubstituted {vars} or broken-render markers are rejected at
// send time, AFTER the move would have committed.
const NOTE_UNSUBBED_VAR_RE = /\{\s*[a-z][a-z0-9_]{0,40}\s*\}/;
const NOTE_BROKEN_SUBSTRINGS = ['undefined', '[object object]', 'nan/nan', 'invalid date', '1970'];
function noteGuardTrips(note) {
  if (NOTE_UNSUBBED_VAR_RE.test(note)) return true;
  const lower = note.toLowerCase();
  if (NOTE_BROKEN_SUBSTRINGS.some((s) => lower.includes(s))) return true;
  return /\bnull\b/i.test(note);
}
// Mirror of the compliance hard rules (customer-copy-compliance.js): no
// "safe" claims outside the drying/protective idioms, EPA-registered/
// -exempt only, no fixed re-entry timing.
// The dry idiom ("safe once dry") is only allowed when the copy ALSO says
// the technician confirms timing — same rule the canonical server checker
// (social-media.js complianceLanguageIssues) enforces, so the mirror never
// green-lights wording the server then rejects.
// Mirror of the canonical exemption: the confirmation's OBJECT must be
// drying/re-entry timing ("confirms the gate code" does not exempt;
// "when"/"ready" only count tied to drying/safety so "gate code is
// ready" doesn't either — keep in sync with TECH_CONFIRM_CONTEXT_RE).
const NOTE_TECH_CONFIRM_RE = /\btech(?:nician)?s?\b(?:(?!\s(?:and|but|or|nor|so|yet|while|then)\s)[^.!?,;\n]){0,40}\b(?:will\s+let\s+you\s+know(?=\s*(?:$|[.!?,;\n])|\s+when\b)|(?:confirm\w*|advise\w*|tells?\b|will\s+tell\b)(?:\s+(?:you|us|the|a|an|your|our|it['’]s|its|it|is|are|exact|precise|estimated))*\s+(?:dr(?:y|ies|ying)(?:[\s-]+tim(?:e|es|ing))?|re-?ent\w*(?:[\s-]+tim(?:e|es|ing))?|tim(?:e|es|ing)|when\s+(?:it\s+is\s+|it['’]s\s+)?(?:dry|safe)\b|when(?=\s*(?:$|[.!?,;\n]))|ready\s+for\s+re-?ent\w*)\b)|(?:^|[.!?\n,;:—–-]\s*|\b(?:the|your|our|exact|drying|dry|re-?entry)[\s-]+)timing\b(?:(?!\s(?:and|but|or|nor|so|yet|while|then)\s)[^.!?,;\n]){0,30}\bconfirm\w*\s+by\s+(?:your\s+|our\s+|the\s+)?tech(?:nician)?s?\b/i;
// A confirmation about appointment logistics ("confirms arrival timing")
// is not a drying confirmation — stripped before the confirm test. Gap is
// tempered so "confirms DRYING time at the appointment" survives. Both
// orders stripped: verb-first and passive noun-first ("appointment
// timing will be confirmed").
const NOTE_UNRELATED_CONFIRM_RE = /\b(?:confirm\w*|advise\w*|tells?|will\s+(?:tell|let\s+you\s+know))(?:(?!\b(?:dr(?:y|ies|ying)|re-?ent))[^.!?\n]){0,25}\b(?:arrival|appointment|visit|schedule|scheduling|start|eta)\b(?:[^.!?\n]{0,15}\btim(?:es?|ing)?\b)?|\b(?:arrival|appointment|visit|schedule|scheduling|start|eta)\b[^.!?\n]{0,15}\btim(?:es?|ing)?\b(?:(?!\b(?:dr(?:y|ies|ying)|re-?ent))[^.!?\n]){0,30}\b(?:confirm\w*|advise\w*)/gi;
// Verbatim mirrors of the canonical strips (social-media.js
// SAFE_DRY_IDIOM_RE / SAFE_FROM_PEST_RE / WORKER_SAFETY_RE /
// WELL_WISH_SAFE_RE — keep in sync). The server checks the note with
// impliedTreatmentContext (the note always rides a treatment SMS), so any
// remaining "safe"/"safety" blocks WITHOUT needing a product word in the
// same sentence — the strips are what keep well-wishes ("stay safe out
// there!") and protective idioms from tripping it.
const NOTE_SAFE_DRY_IDIOM_RE = /\bsafe\s*[—–,-]?\s*(?:once|when)\s+(?:completely\s+|fully\s+)?dry\b/gi;
const NOTE_SAFE_FROM_RE = /\bsafe(?:ly|ty)?\s+from\s+[\w'-]+(?:\s+(?:and|or)\s+[\w'-]+)?/gi;
const NOTE_WORKER_SAFETY_RE = /\b(?:technicians?|applicators?|staff|crew|team)\b[^.!?\n]*\b(?:stay(?:ing)?|keep(?:ing)?|remain(?:ing)?|be)\s+safe(?:ly)?\b/gi;
const NOTE_WELL_WISH_SAFE_RE = /\b(?:stay|be|drive|travel|get\s+home)\s+safe(?:ly)?\b/gi;
const NOTE_SAFETY_WORD_RE = /\bsafe(?:ly|ty)?\b/i;
// Verbatim mirror of the canonical SAFETY_OVERCLAIMS (social-media.js —
// keep in sync): guarantees, 100%, pet/kid-safe, EPA-approved (incl.
// dotted "E.P.A."). Only APPROVED-status EPA claims block — "Following
// EPA label directions" is compliant and must stay enabled.
const NOTE_SAFETY_OVERCLAIMS_RE = /\b(?:guarante(?:e[ds]?|ing)|100\s*%\s*(?:effective|safe|eliminat)|completely\s+safe|risk[\s-]*free|no\s+side\s+effects|(?:pet|kid|child|family)[\s-]*(?:and[\s-]*(?:pet|kid|child|family)[\s-]*)?safe|safe\s+(?:for|around)\s+(?:your\s+|the\s+|our\s+)?(?:pets?|kids?|children|famil(?:y|ies))|E\.?\s*P\.?\s*A\b\.?[\s-]*approved|approved\s+by\s+(?:the\s+)?E\.?\s*P\.?\s*A\b)\b/i;
// Verbatim copies of the canonical clause-level timing rules
// (social-media.js TIMING_DURATION_RE / REENTRY_CONTEXT_RE /
// AGRONOMIC_EXEMPT_RE — keep in sync) so the inline advisor recognizes
// everything the server rejects: spelled-out durations ("two hours"),
// clock times, and the full re-entry phrasing set.
const NOTE_TIMING_DURATION_RE = /\b(?:\d+(?:\.\d+)?\s*(?:[-–]\s*(?:\d+(?:\.\d+)?\s*)?)?(?:minutes?|mins?|seconds?|secs?|hours?|hrs?|m|h|s)\b|(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|ten|eleven|twelve|an?|one|two|three|four|five|six|seven|eight|nine|several|a[\s-]+few|(?:a[\s-]+)?couple(?:[\s-]+of)?)[\s-]+(?:minutes?|mins?|seconds?|secs?|hours?|hrs?)|half[\s-]+(?:an[\s-]+)?hour|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\d{1,2}:\d{2}\b)/i;
// Mirror of TIMING_STRICT_DURATION_RE (durations only, no clock times).
const NOTE_TIMING_STRICT_RE = /\b(?:\d+(?:\.\d+)?\s*(?:[-–]\s*(?:\d+(?:\.\d+)?\s*)?)?(?:minutes?|mins?|seconds?|secs?|hours?|hrs?|m|h|s)\b|(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|ten|eleven|twelve|an?|one|two|three|four|five|six|seven|eight|nine|several|a[\s-]+few|(?:a[\s-]+)?couple(?:[\s-]+of)?)[\s-]+(?:minutes?|mins?|seconds?|secs?|hours?|hrs?)|half[\s-]+(?:an[\s-]+)?hour)/i;
const NOTE_REENTRY_CONTEXT_RE = /\bre-?ent\w*|\b(?:dry(?:ing|s)?|dries)\b|\bsafe(?:ly|ty)?\b|\benter(?:ing)?\b[^.!?\n]{0,30}\b(?:treated|areas?|lawn|yard|home|house)\b|\b(?:treated|areas?|lawn|yard|home|house)\b[^.!?\n]{0,30}\benter(?:ing)?\b|\b(?:off|inside|indoors|away|out\s+of)\b[^.!?\n]*\b(?:treated|lawn|grass|yard|areas?|surfaces?)\b|\b(?:treated|lawn|grass|yard)\b[^.!?\n]*\b(?:off|inside|indoors|away|avoid\w*|back)\b|\b(?:pets?|kids?|children|famil\w+)\b[^.!?\n]*\b(?:off|inside|indoors|away|back|out(?:side)?)\b|\b(?:avoid\w*|no\s+entry)\b[^.!?\n]*\b(?:treated|areas?|lawn|yard)\b|\bwalk\w*\b[^.!?\n]{0,30}\b(?:treated|lawn|grass|yard)\b|\b(?:you|your\s+family|residents?|occupants?|everyone)\b[^.!?\n]{0,20}\breturn\w*\b|^\s*return(?:ing)?\b/i;
const NOTE_AGRONOMIC_RE = /\b(?:mow\w*|water\w*|irrigat\w*|fertiliz\w*|seed\w*|overseed\w*|aerat\w*|rain)\b/i;
// Mirror of the server's IMPLIED_REENTRY_DIRECTIVE_RE: a keep-away
// directive whose object may be implicit ("Stay off for 30 minutes" after
// "We treated the lawn.") — the treated-area noun can live in another
// sentence, so the directive alone counts under implied context.
const NOTE_IMPLIED_DIRECTIVE_RE = /\b(?:stay|keep|remain|wait)\b[^.!?\n]{0,30}\b(?:off|out|inside|indoors|away)\b|\bavoid\w*\b|\bout\s+of\b|\baway\s+from\b|\bno\s+entry\b|\bre-?ent\w*\b|\bbefore\s+(?:re-?)?enter\w*\b|\b(?:don['’]t|do\s+not|cannot|can['’]t|never|no)\s+(?:re-?)?enter\w*\b|\benter\w*\s+(?:for|in|until|after)\b|\b(?:go(?:ing)?|head(?:ing)?)\s+back\b/i;
// Mirror of IMPLIED_NONTREATMENT_RE: weather/premises clauses are advice
// about the weather, not implicit re-entry — implied route only.
const NOTE_IMPLIED_NONTREATMENT_RE = /\b(?:lightning|storms?|rain\w*|wind\w*|hail|thunder\w*|flood\w*|weather|heat|traffic|entrance|driveway|road|street|parking|office|gate)\b/i;
// Explicit treatment context overrides the premises exemption (r22).
const NOTE_TREATMENT_WORD_RE = /\btreat\w*\b/i;
// Protective ADVICE ("keep your pets safe indoors during the storm") is
// not a product claim — stripped only when the sentence carries no
// product word, same guard as the server (PRODUCT_CONTEXT_RE mirror).
const NOTE_PROTECTIVE_ADVICE_RE = /\b(?:keep(?:s|ing)?|stay(?:s|ing)?|remain(?:s|ing)?|be)\b[^.!?\n]{0,25}\bsafe(?:ly)?\b/gi;
const NOTE_PRODUCT_CTX_RE = /\b(?:pesticides?|products?|treatments?|sprays?(?:ing)?|chemicals?|applications?|pest\s+control|exterminat\w*)\b/i;
// Same sentence split as the server: decimals masked first so "1.5
// hours" stays one sentence — no lookbehind (fatal parse on Safari
// <16.4).
function noteSentences(note) {
  return note
    .replace(/(\d)\.(?=\d)/g, '$1\u0001')
    .split(/[.!?\n]+/)
    .map((s) => s.replace(/\u0001/g, '.'));
}
// Same clause walk as the canonical checker (sentence → clause on
// commas/semicolons/conjunctions; agronomic clauses exempt). A split
// instruction ("Stay off. Wait 30 minutes.") is one instruction: a
// qualifying directive in the ADJACENT clause governs a bare duration
// (directive-only — never the standalone dry/safe REENTRY words, so
// "Stay dry! See you at 2:30." stays sendable).
function noteTimingTrips(note) {
  const clauses = noteSentences(note)
    .flatMap((s) => s.split(/[,;]+|\s+(?:and|but|while|then)\s+/i))
    .filter((c) => c.trim());
  // Treatment context in an adjacent clause carries into the premises
  // exemption; adjacency propagation needs a DURATION figure, never an
  // arrival clock ("Please wait inside. We will arrive at 2:30." passes).
  const treatmentNear = (i) => [clauses[i], clauses[i - 1], clauses[i + 1]]
    .some((c) => c && (NOTE_TREATMENT_WORD_RE.test(c) || NOTE_PRODUCT_CTX_RE.test(c)));
  const qualifies = (i) => NOTE_IMPLIED_DIRECTIVE_RE.test(clauses[i])
    && (!NOTE_IMPLIED_NONTREATMENT_RE.test(clauses[i]) || treatmentNear(i));
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    if (!NOTE_TIMING_DURATION_RE.test(clause)) continue;
    const governed = NOTE_REENTRY_CONTEXT_RE.test(clause)
      || qualifies(i)
      || (NOTE_TIMING_STRICT_RE.test(clause)
        && ((i > 0 && qualifies(i - 1))
          || (i + 1 < clauses.length && qualifies(i + 1))));
    if (governed && !NOTE_AGRONOMIC_RE.test(clause)) return true;
  }
  return false;
}
function noteComplianceTrips(note) {
  const idiomAllowed = NOTE_TECH_CONFIRM_RE.test(note.replace(NOTE_UNRELATED_CONFIRM_RE, '.'));
  // Per-sentence walk, same order of strips as the server: the
  // protective-advice strip is sentence-scoped (guarded on that
  // sentence's product context), so the whole-note shortcut no longer
  // holds.
  for (const sentence of noteSentences(note)) {
    if (!sentence.trim()) continue;
    let scope = (idiomAllowed ? sentence.replace(NOTE_SAFE_DRY_IDIOM_RE, '') : sentence)
      .replace(NOTE_SAFE_FROM_RE, '')
      .replace(NOTE_WORKER_SAFETY_RE, '');
    // Well-wish/advice strips only apply when the sentence names no
    // product — "Treatment will be safe" keeps its claim (r17).
    if (!NOTE_PRODUCT_CTX_RE.test(sentence)) {
      scope = scope
        .replace(NOTE_WELL_WISH_SAFE_RE, '')
        .replace(NOTE_PROTECTIVE_ADVICE_RE, '');
    }
    if (NOTE_SAFETY_WORD_RE.test(scope)) return true;
  }
  if (NOTE_SAFETY_OVERCLAIMS_RE.test(note)) return true;
  return noteTimingTrips(note);
}
// Mirror of the server's foldForCompliance (rain-out.js — keep in sync):
// NFKC + default-ignorable characters stripped, so invisible joiners
// can't hide "1970"/"safe" from the guard and compliance mirrors — the
// server folds before ITS checks, and the advisor must see the same text.
const NOTE_FOLD_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/g;
function foldNote(raw) {
  return String(raw).normalize('NFKC').replace(NOTE_FOLD_RE, '');
}
// Same canonicalization the server runs before the shortener test —
// encoded/unicode-dot hosts (`bit%2ely`, `bit。ly`) resolve to real links.
function normalizeForLinkCheck(raw) {
  let out = String(raw).normalize('NFKC');
  out = out.replace(/[\u3002\uFF0E\uFF61]/g, '.');
  out = out.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  for (let i = 0; i < 3; i++) {
    let decoded;
    try { decoded = decodeURIComponent(out); } catch { break; }
    if (decoded === out) break;
    out = decoded;
  }
  return out;
}

// Sentinel selection key for the custom-time option (distinct from the preset
// keys, which are `${kind}:${date}:${start}`).
const CUSTOM_KEY = 'custom';

function hhmmToMin(v) {
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function minToHHMM(total) {
  const c = Math.max(0, Math.min(23 * 60 + 59, total));
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
}

// A custom start snapped to an on-the-hour 1-hour block — matches the server's
// oneHourWindow so what the dispatcher picks is exactly what gets booked.
function hourWindow(startHHMM) {
  const m = hhmmToMin(startHHMM);
  if (m == null) return null;
  const onHour = Math.floor(m / 60) * 60;
  return { start: minToHHMM(onHour), end: minToHHMM(onHour + 60) };
}

function fmtTime(hhmm) {
  const m = hhmmToMin(hhmm);
  if (m == null) return hhmm;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h % 12 || 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtDateLabel(dateStr, todayStr) {
  if (!dateStr) return '';
  if (dateStr === todayStr) return 'Today';
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TIMEZONE });
}

function authHeaders() {
  return {
    Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
    'Content-Type': 'application/json',
  };
}

export default function RainOutSheet({ service, onClose, onDone }) {
  const isMobile = useIsMobile();
  const [options, setOptions] = useState(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('weather_rain');
  const [selectedKey, setSelectedKey] = useState(null);
  const [scope, setScope] = useState('job');
  const [notify, setNotify] = useState(true);
  // Optional dispatcher note appended to the end of the customer text.
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Custom on-the-hour time — dispatcher-typed instead of a preset pill.
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const [customDate, setCustomDate] = useState(todayStr);
  const [customStart, setCustomStart] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/dispatch/${service.id}/rain-out-options`, {
          headers: authHeaders(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setOptions(data);
          const first = data.sameDay?.[0] || data.days?.[0];
          setSelectedKey(first ? `${first.kind}:${first.date}:${first.window.start}` : null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load options');
      }
    })();
    return () => { cancelled = true; };
  }, [service.id]);

  const allOptions = options ? [...(options.sameDay || []), ...(options.days || [])] : [];
  const keyOf = (opt) => `${opt.kind}:${opt.date}:${opt.window.start}`;
  // "Running behind" can only push a same-day visit LATER — hide same-day
  // presets that start at/before the current window (the server rejects
  // them with target_not_later; this keeps them unpickable). Day moves are
  // unaffected.
  const currentStartMin = hhmmToMin(options?.service?.window?.start);
  const optionVisibleFor = (opt, reasonCode) => {
    if (reasonCode !== 'running_late' || opt.kind !== 'same_day' || currentStartMin == null) return true;
    const startMin = hhmmToMin(opt.window?.start);
    return startMin != null && startMin > currentStartMin;
  };
  const visibleOptions = allOptions.filter((opt) => optionVisibleFor(opt, reason));
  const isCustom = selectedKey === CUSTOM_KEY;
  const customWindow = isCustom ? hourWindow(customStart) : null;
  // A same-day custom start must be a FUTURE hour. Only the date field carries a
  // min, so without this a dispatcher could pick an already-started hour; on a
  // route move the rebooker then rejects the elapsed anchor while its siblings
  // still shift, stranding the selected visit. Earliest allowed = next top of
  // the hour after now (ET).
  const nowEtMin = hhmmToMin(new Date().toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour12: false }));
  // Running late raises the same-day floor to the hour AFTER the current
  // window start (server enforces via target_not_later).
  const runningLateFloorMin = (reason === 'running_late' && currentStartMin != null)
    ? (Math.floor(currentStartMin / 60) + 1) * 60
    : 0;
  const minTodayStartMin = Math.max((Math.floor((nowEtMin ?? 0) / 60) + 1) * 60, runningLateFloorMin);
  const minTodayStart = minToHHMM(Math.min(minTodayStartMin, 23 * 60));
  const customElapsed = !!(isCustom && customWindow && customDate === todayStr
    && hhmmToMin(customWindow.start) < minTodayStartMin);
  const customOption = (isCustom && customWindow && customDate && !customElapsed)
    ? {
        kind: 'custom',
        date: customDate,
        window: customWindow,
        display: `${fmtDateLabel(customDate, todayStr)}, ${fmtTime(customWindow.start)}-${fmtTime(customWindow.end)}`,
      }
    : null;
  const selected = isCustom
    ? customOption
    : (visibleOptions.find((opt) => keyOf(opt) === selectedKey) || null);
  const routeCount = options?.remainingRouteCount || 0;

  // Reason side effects: no-show is single-stop only (server rejects route
  // scope), and running late may hide the currently highlighted same-day
  // preset — reseat the selection on the first still-visible option.
  const pickReason = (code) => {
    setReason(code);
    if (code === 'customer_noshow' || code === 'gate_locked' || code === CUSTOM_REASON) setScope('job');
    if (selectedKey && selectedKey !== CUSTOM_KEY) {
      const stillVisible = allOptions.some((opt) => keyOf(opt) === selectedKey && optionVisibleFor(opt, code));
      if (!stillVisible) {
        const first = allOptions.find((opt) => optionVisibleFor(opt, code));
        setSelectedKey(first ? keyOf(first) : null);
      }
    }
  };

  // Seed the custom date AND start from whatever preset was highlighted (or the
  // first slot) so switching to Custom lands on a sensible hour on the RIGHT
  // day — seeding only the time would leave a future preset's hour paired with
  // today's date and book the wrong day (or fail as an elapsed same-day window).
  const pickCustom = () => {
    setSelectedKey(CUSTOM_KEY);
    if (!customStart) {
      const seedOpt = allOptions.find((opt) => keyOf(opt) === selectedKey) || allOptions[0] || null;
      const snapped = hourWindow(seedOpt?.window?.start || '15:00');
      setCustomStart(snapped ? snapped.start : '15:00');
      if (seedOpt?.date) setCustomDate(seedOpt.date);
    }
  };

  const noteCanonical = normalizeForLinkCheck(note);
  const noteLink = NOTE_SHORTENER_RE.test(note) || NOTE_SHORTENER_RE.test(noteCanonical)
    || NOTE_URL_RE.test(note) || NOTE_URL_RE.test(noteCanonical)
    || noteContainsBareHost(note) || noteContainsBareHost(noteCanonical);
  const noteFolded = foldNote(note);
  const noteEmoji = NOTE_EMOJI_RE.test(note);
  const noteGuard = noteGuardTrips(noteFolded);
  const noteCompliance = noteComplianceTrips(noteFolded);
  const noteBlocked = notify && (noteLink || noteEmoji || noteGuard || noteCompliance);
  const noteBlockedCopy = noteLink ? ERROR_COPY.note_link_blocked
    : noteEmoji ? ERROR_COPY.note_emoji_blocked
      : noteGuard ? ERROR_COPY.note_guard_blocked
        : ERROR_COPY.note_compliance_blocked;

  // Custom-reason state: the message is OPTIONAL (owner ruling 2026-08-24
  // — a blank box sends the server's standard opener instead of blocking
  // the move), and the assembled body must fit 2 segments. The count comes
  // from the SERVER's own render
  // (POST rain-out/custom-preview → previewCustomSms), debounced — the
  // client keeps no render mirrors (codex r9 P1: mirroring
  // gsm-normalize/segment-counter/sms-time-format/substitution meant any
  // server-side change could desync the counter at the boundary). The
  // preview is advisory; commit() re-renders and enforces fail-closed, so
  // a preview fetch failure just hides the counter, never blocks Move.
  const isCustomReason = reason === CUSTOM_REASON;
  const customAvailable = !!options?.customCompose;
  const [customSeg, setCustomSeg] = useState(null);
  const selectedDate = selected?.date || null;
  const selectedStart = selected?.window?.start || null;
  const selectedEnd = selected?.window?.end || null;
  useEffect(() => {
    if (!(isCustomReason && notify && customAvailable && selectedDate && selectedStart)) {
      setCustomSeg(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/dispatch/${service.id}/rain-out/custom-preview`, {
          method: 'POST',
          headers: authHeaders(),
          signal: controller.signal,
          body: JSON.stringify({
            message: note,
            target: { date: selectedDate, window: { start: selectedStart, end: selectedEnd } },
          }),
        });
        const data = await res.json().catch(() => null);
        if (!controller.signal.aborted) setCustomSeg(res.ok && data?.ok ? data : null);
      } catch { /* advisory only — the server enforces at commit */ }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [isCustomReason, notify, customAvailable, note, selectedDate, selectedStart, selectedEnd, service.id]);
  const customOverBudget = !!(customSeg && !customSeg.withinCap);

  // Overlap advisory (owner ask 2026-08-12): every selection change —
  // preset OR custom time — re-checks the target against the schedule
  // (POST rain-out/target-check → checkTarget: the same tech-blind
  // occupancy predicate commit enforces) so the dispatcher sees the
  // overlapped stop's customer + window BEFORE tapping Move instead of
  // discovering it as commit's SLOT_TAKEN rejection. Warn-only: Move
  // stays enabled (this data can be seconds stale in either direction —
  // the rebooker's locked probe at commit is the enforcer), and a fetch
  // failure just hides the warning. While the live check is in flight
  // the options payload's same-day preset annotation (opt.conflicts)
  // fills in.
  const [liveCheck, setLiveCheck] = useState(null);
  useEffect(() => {
    setLiveCheck(null);
    if (!(selectedDate && selectedStart && selectedEnd)) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/admin/dispatch/${service.id}/rain-out/target-check`, {
          method: 'POST',
          headers: authHeaders(),
          signal: controller.signal,
          body: JSON.stringify({
            target: { date: selectedDate, window: { start: selectedStart, end: selectedEnd } },
          }),
        });
        const data = await res.json().catch(() => null);
        if (!controller.signal.aborted && res.ok && Array.isArray(data?.conflicts)) {
          setLiveCheck(data);
        }
      } catch { /* advisory only — commit still rejects real overlaps */ }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [selectedDate, selectedStart, selectedEnd, service.id]);
  // Advisory best-times chips for the landing day in play — the custom
  // picker's date when it's active, otherwise the highlighted preset's day.
  // On a rest-of-route move the hint advises the tapped visit only; that's
  // fine, it's advisory (commit still shifts siblings by the window delta).
  const landingDate = isCustom ? customDate : (selected?.date || null);
  const { bestTimes } = useBestTimes({
    date: landingDate,
    serviceId: service.id,
    customerId: service.customerId || service.customer_id,
    // The sheet always books a fixed one-hour block (hourWindow / the
    // preset options' server windows) — mirror THAT, not the service's own
    // duration, so a recommended gap is one the move actually fits.
    durationMinutes: 60,
    // Quick Move keeps the visit on its own tech's route.
    technicianId: service.technicianId || service.technician_id || undefined,
    excludeServiceIds: [service.id],
    // Quick Move can't reassign, so an unassigned visit's all-tech
    // detours would be unactionable — no tech, no hint.
    enabled: !!landingDate && !!(service.technicianId || service.technician_id),
  });
  // A same-day landing is floored at the next top-of-hour — raised further
  // by running_late (server enforces target_not_later). Never advertise an
  // hour that goes customElapsed the moment it's tapped.
  const floorBestTimes = landingDate === todayStr
    ? bestTimes.filter((s) => (hhmmToMin(s.start) ?? 0) >= minTodayStartMin)
    : bestTimes;

  // Two lists, one scope toggle (codex #3375 P2 ×2):
  //   conflicts      — what the ANCHOR's window hits. A route-scope push
  //                    shifts the remaining stops by the same delta
  //                    (commit moves tail-first), so an overlap with a
  //                    stop that's moving too is not a definite failure:
  //                    drop flagged siblings while scope=route.
  //   routeConflicts — what those SHIFTED stops would land on. Only real
  //                    while scope=route, and the reason a route Move can
  //                    fail halfway with the earlier stops already booked
  //                    and already texted.
  const conflictsFor = (src) => [
    ...(src?.conflicts || []).filter((c) => !(scope === 'route' && c.isRouteSibling)),
    ...(scope === 'route' ? (src?.routeConflicts || []) : []),
  ];
  const activeConflicts = conflictsFor(liveCheck ?? selected);
  const conflictLabel = (c) => {
    // A self-collision is two of THIS route's own stops projected onto one
    // window — naming a customer would be wrong, the fix is a different time.
    const who = c.isRouteSelfCollision
      ? 'another stop on this route landing at the same time'
      : (c.customerName || (c.isHold ? 'an estimate-slot hold' : 'another appointment'));
    const when = c.windowStart
      ? `, ${fmtTime(c.windowStart)}${c.windowEnd ? `-${fmtTime(c.windowEnd)}` : ''}`
      : '';
    const what = c.serviceType ? ` (${c.serviceType.toLowerCase()})` : '';
    return `${who}${when}${what}`;
  };

  const handleCommit = async () => {
    if (!selected || busy || noteBlocked || customOverBudget) return;
    setBusy(true);
    setError('');
    try {
      // Server books THIS stop into exactly this window (what's displayed);
      // a route-wide same-day push shifts the other stops by this stop's
      // window delta to preserve running order.
      const res = await fetch(`${API_BASE}/admin/dispatch/${service.id}/rain-out`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          reasonCode: reason,
          scope,
          target: { date: selected.date, window: selected.window },
          notifyCustomer: notify,
          // Note only rides when a text is actually going out.
          customerNote: notify && note.trim() ? note.trim() : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(ERROR_COPY[data.error] || data.error || `HTTP ${res.status}`);
      const failedCount = data.failedCount || 0;
      const movedCount = data.movedCount || 0;
      // "customer texted" must come from what actually HAPPENED, not the
      // request flag — a disabled template or missing phone moves the visit
      // without an SMS (smsSent:false on that result row), and telling the
      // dispatcher it was texted buries the manual follow-up.
      const texted = (data.results || []).filter((r) => r.ok && r.smsSent).length;
      const notTexted = notify && texted < movedCount;
      // Stops that moved onto an occupied slot: the move COMMITS (schedule
      // overlaps are advisory on every staff surface) — say so and keep the
      // sheet open so the dispatcher eyeballs the day's route.
      const overlapWarnings = Array.isArray(data.overlapWarnings)
        ? data.overlapWarnings
        : (data.results || []).flatMap((r) => (r.ok && Array.isArray(r.warnings) ? r.warnings : []));
      const overlapCount = overlapWarnings.length;
      const notifyClause = !notify ? ''
        : texted === movedCount ? (movedCount === 1 ? ', customer texted' : ', customers texted')
          : texted === 0 ? ', customer NOT texted'
            : `, ${texted}/${movedCount} texted`;
      const summary =
        `Moved ${movedCount} ${movedCount === 1 ? 'stop' : 'stops'} to ${selected.display}${notifyClause}`;
      if (failedCount > 0 || notTexted || overlapCount > 0) {
        // Partial success (a stop raced to terminal or slot-conflicted) or a
        // silent non-send. The server still returns 200 when at least one
        // moved, so keep the sheet open with the warning instead of silently
        // closing; the parent still refreshes the board for the moved stops.
        const failClause = failedCount > 0
          ? ` ${failedCount} stop${failedCount === 1 ? '' : 's'} could not be moved — review dispatch.`
          : '';
        const smsClause = notTexted
          ? ' Some customers were NOT texted (no phone or template disabled) — follow up manually.'
          : '';
        // The dated warnings themselves (one per clashing occurrence — a
        // series shift can report several future dates), never a bare count.
        const overlapClause = overlapCount > 0
          ? ` ${overlapWarnings.join(' ')} Check the route on ${overlapCount === 1 ? 'that day' : 'those days'}.`
          : '';
        setError(`${summary}.${failClause}${smsClause}${overlapClause}`);
        setBusy(false);
      }
      onDone?.({ summary, movedCount, failedCount, notTexted, overlapCount, overlapWarnings });
    } catch (err) {
      setError(err.message || 'Quick Move failed');
      setBusy(false);
    }
  };

  const chipStyle = (active) => ({
    padding: '7px 14px', borderRadius: 16, fontSize: 13, fontWeight: 500,
    border: `1px solid ${active ? '#18181B' : '#D4D4D8'}`,
    background: active ? '#18181B' : '#FFFFFF',
    color: active ? '#FFFFFF' : '#18181B', cursor: 'pointer',
  });

  const sectionLabel = { fontSize: 12, fontWeight: 500, color: '#71717A', letterSpacing: '0.04em', marginBottom: 8 };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick Move Appointment"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 110,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        fontFamily: 'Roboto, system-ui, sans-serif',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFFFFF', borderRadius: '16px 16px 0 0', width: '100%',
          maxWidth: 560, maxHeight: '88vh', overflowY: 'auto', padding: 20,
          border: '1px solid #E4E4E7', borderBottom: 'none',
          ...(isMobile
            ? {
                width: '100%', maxWidth: 'none', height: '100%', maxHeight: 'none',
                borderRadius: 0, boxSizing: 'border-box', overflowY: 'auto',
                paddingTop: 'calc(20px + env(safe-area-inset-top, 0px))',
                paddingBottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
                paddingLeft: 'calc(20px + env(safe-area-inset-left, 0px))',
                paddingRight: 'calc(20px + env(safe-area-inset-right, 0px))',
              }
            : {}),
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
          <div style={{ fontSize: 18, fontWeight: 500, color: '#18181B' }}>Quick Move Appointment</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: '#71717A', fontSize: 24, cursor: 'pointer', padding: '0 6px' }}
          >
            ×
          </button>
        </div>
        <div style={{ fontSize: 13, color: '#71717A', marginBottom: 16 }}>
          {service.customerName || 'Customer'}
          {options?.today?.rainChance != null && ` · today ${options.today.rainChance}% rain`}
        </div>

        {error && (
          <div style={{
            marginBottom: 12, fontSize: 13, padding: '8px 10px', borderRadius: 8,
            background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C',
          }}>
            {error}
          </div>
        )}

        {!options && !error && (
          <div style={{ color: '#71717A', fontSize: 13, padding: 20, textAlign: 'center' }}>Loading options…</div>
        )}

        {options && (
          <>
            <div style={sectionLabel}>REASON</div>
            {/* Native select (owner request 2026-08-08): one tap opens the
                platform picker instead of a 2-3 row chip wrap. Same codes,
                same pickReason side effects, same gate on the extra
                reasons — presentation only. */}
            <select
              value={reason}
              onChange={(e) => pickReason(e.target.value)}
              aria-label="Reason"
              style={{
                width: '100%', padding: '11px 40px 11px 13px', borderRadius: 10, fontSize: 14,
                fontWeight: 500, border: '1px solid #D4D4D8', background: '#FFFFFF',
                color: '#18181B', fontFamily: 'inherit', cursor: 'pointer', marginBottom: 18,
                appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
                backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2371717A' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`,
                backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', backgroundSize: '16px',
              }}
            >
              {[
                ...RAIN_REASONS,
                ...(options.extraReasonsEnabled ? EXTRA_REASONS : []),
                // Custom needs BOTH the gate and a live template row — the
                // payload omits customCompose when the row is missing or
                // disabled, and offering the option then would only reach
                // commit()'s custom_message_unavailable rejection.
                ...(options.customReasonEnabled && options.customCompose
                  ? [{ code: CUSTOM_REASON, label: 'Custom message' }] : []),
              ].map((r) => (
                <option key={r.code} value={r.code}>{r.label}</option>
              ))}
            </select>

            <div style={sectionLabel}>MOVE TO</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
              {visibleOptions.length === 0 && (
                <div style={{ fontSize: 13, color: '#71717A' }}>No preset slots — pick a custom time below.</div>
              )}
              {visibleOptions.map((opt) => {
                const key = keyOf(opt);
                const active = key === selectedKey;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSelectedKey(key)}
                    style={{
                      textAlign: 'left', padding: '11px 13px', borderRadius: 10, fontSize: 14, fontWeight: 500,
                      border: `1px solid ${active ? '#18181B' : '#D4D4D8'}`,
                      background: active ? '#F4F4F5' : '#FFFFFF', color: '#18181B',
                      cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}
                  >
                    <span>
                      {opt.display}
                      {opt.kind === 'same_day' && !EXTRA_REASON_CODES.has(reason) && reason !== CUSTOM_REASON && (
                        <span style={{ color: '#71717A', fontWeight: 400 }}> — storm may pass</span>
                      )}
                    </span>
                    {(conflictsFor(opt).length > 0 || opt.rainChance != null) && (
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                        {conflictsFor(opt).length > 0 && (
                          <span style={{ fontSize: 12, fontWeight: 500, color: '#B45309' }}>overlaps</span>
                        )}
                        {opt.rainChance != null && (
                          <span style={{ fontSize: 12, fontWeight: 500, color: opt.rainChance >= 50 ? '#B45309' : '#15803D' }}>
                            {opt.rainChance}% rain
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                );
              })}

              {/* Custom on-the-hour time — for when none of the presets is the
                  time the dispatcher agreed on with the customer ("let's do
                  3 PM today"). */}
              <button
                type="button"
                onClick={pickCustom}
                style={{
                  textAlign: 'left', padding: '11px 13px', borderRadius: 10, fontSize: 14, fontWeight: 500,
                  border: `1px solid ${isCustom ? '#18181B' : '#D4D4D8'}`,
                  background: isCustom ? '#F4F4F5' : '#FFFFFF', color: '#18181B',
                  cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <span>Custom time</span>
                {customOption && (
                  <span style={{ fontSize: 12, fontWeight: 500, color: '#18181B' }}>
                    {fmtDateLabel(customDate, todayStr)} · {fmtTime(customOption.window.start)}
                  </span>
                )}
              </button>
            </div>

            {isCustom && (
              <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
                <div style={{ flex: 1 }}>
                  <div style={sectionLabel}>DATE</div>
                  <input
                    type="date"
                    value={customDate}
                    min={todayStr}
                    onChange={(e) => setCustomDate(e.target.value)}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 10, fontSize: 14, fontWeight: 500,
                      border: '1px solid #D4D4D8', background: '#FFFFFF', color: '#18181B', fontFamily: 'inherit',
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={sectionLabel}>START (ON THE HOUR)</div>
                  <input
                    type="time"
                    step="3600"
                    value={customStart}
                    min={customDate === todayStr ? minTodayStart : undefined}
                    onChange={(e) => {
                      // Snap to the hour on input (a manually-typed off-hour value
                      // like 15:59 would otherwise floor to 15:00 only at book
                      // time, leaving the field showing a time that isn't what
                      // gets scheduled). Snapping here keeps shown == booked.
                      const snapped = hourWindow(e.target.value);
                      setCustomStart(snapped ? snapped.start : '');
                    }}
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 10, fontSize: 14, fontWeight: 500,
                      border: `1px solid ${customElapsed ? '#DC2626' : '#D4D4D8'}`, background: '#FFFFFF', color: '#18181B', fontFamily: 'inherit',
                    }}
                  />
                </div>
              </div>
            )}

            {/* Best-times chips: tappable only while the custom picker is
                active (they set the custom start); a preset target is fixed,
                so the chips go display-only. */}
            <BestTimeHint
              bestTimes={floorBestTimes}
              currentStart={isCustom ? customStart : selected?.window?.start}
              currentTechnicianId={service.technicianId || service.technician_id}
              onPick={isCustom ? (slot) => setCustomStart(slot.start) : undefined}
              style={{ marginTop: -8, marginBottom: 18 }}
            />

            {customElapsed && (
              <div style={{ fontSize: 12, color: '#B91C1C', marginTop: -8, marginBottom: 18 }}>
                {runningLateFloorMin > 0 && hhmmToMin(customWindow?.start) < runningLateFloorMin
                  ? `Running late needs a time after the current window — pick ${fmtTime(minTodayStart)} or later.`
                  : `That hour has already started today — pick ${fmtTime(minTodayStart)} or later.`}
              </div>
            )}

            {/* Overlap disclaimer — warn-only (owner call 2026-08-12): the
                Move button stays enabled; the server's locked occupancy
                check at commit is the enforcer and rejects real overlaps. */}
            {activeConflicts.length > 0 && selected && (
              <div style={{
                fontSize: 13, padding: '8px 10px', borderRadius: 8, marginTop: -8, marginBottom: 18,
                background: '#FFFBEB', border: '1px solid #FDE68A', color: '#B45309',
              }}>
                {`⚠️ This time overlaps ${conflictLabel(activeConflicts[0])}`}
                {activeConflicts.length > 1 && ` and ${activeConflicts.length - 1} more`}
                {' — the schedule will block this move. Pick a different time.'}
              </div>
            )}

            {routeCount > 0 && reason !== 'customer_noshow' && reason !== 'gate_locked' && !isCustomReason && (
              <>
                <div style={sectionLabel}>SCOPE</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
                  <button type="button" onClick={() => setScope('job')} style={chipStyle(scope === 'job')}>
                    This stop
                  </button>
                  <button type="button" onClick={() => setScope('route')} style={chipStyle(scope === 'route')}>
                    This + rest of route ({routeCount})
                  </button>
                </div>
              </>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: notify ? 10 : 18, cursor: 'pointer', fontSize: 14, color: '#18181B' }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} style={{ width: 18, height: 18 }} />
              Text the customer a reply-to-adjust message
            </label>

            {notify && (
              <div style={{ marginBottom: 18 }}>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={NOTE_MAX_CHARS}
                  rows={isCustomReason ? 3 : 2}
                  aria-label={isCustomReason ? 'Your message (optional)' : 'Add a note to the text (optional)'}
                  placeholder={isCustomReason
                    ? 'Your message (optional) — it opens the text; left blank, a standard update line is used'
                    : 'Add a note to the text (optional) — added to the end of the message'}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10,
                    fontSize: 14, border: `1px solid ${(noteBlocked || customOverBudget) ? '#DC2626' : '#D4D4D8'}`,
                    background: '#FFFFFF', color: '#18181B', fontFamily: 'inherit', resize: 'vertical',
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 4, fontSize: 12, color: '#71717A' }}>
                  <span>
                    {noteBlocked
                      ? <span style={{ color: '#B91C1C' }}>{noteBlockedCopy}</span>
                      : customOverBudget
                        ? <span style={{ color: '#B91C1C' }}>{ERROR_COPY.note_too_many_segments}</span>
                        : isCustomReason
                          ? 'Sent as: your message, then the new time + reschedule link.'
                          : (scope === 'route' && routeCount > 0 && note.trim()
                            ? "Note goes to this stop's customer only — the rest of the route gets the standard text."
                            : '')}
                  </span>
                  {customSeg
                    ? (
                      <span style={{ flexShrink: 0, color: customOverBudget ? '#B91C1C' : '#71717A' }}>
                        {customSeg.remaining >= 0 ? `${customSeg.remaining} left` : `${-customSeg.remaining} over`} · 2-segment limit
                      </span>
                    )
                    : note.length > 0 && <span style={{ flexShrink: 0 }}>{note.length}/{NOTE_MAX_CHARS}</span>}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1, padding: '13px 20px', borderRadius: 9999, fontSize: 15, fontWeight: 500,
                  border: '1px solid #E4E4E7', background: '#FFFFFF', color: '#18181B', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCommit}
                disabled={!selected || busy || noteBlocked || customOverBudget}
                style={{
                  flex: 2, padding: '13px 20px', borderRadius: 9999, fontSize: 15, fontWeight: 500,
                  border: '1px solid #18181B', background: '#18181B', color: '#FFFFFF',
                  cursor: !selected || busy || noteBlocked || customOverBudget ? 'default' : 'pointer',
                  opacity: !selected || busy || noteBlocked || customOverBudget ? 0.5 : 1,
                }}
              >
                {busy ? 'Moving…' : 'Move appointment'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
