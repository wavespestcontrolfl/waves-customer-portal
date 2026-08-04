import React, { useEffect, useState } from 'react';
import { WAVES_FL_LICENSE_LINE, WAVES_SUPPORT_PHONE_DISPLAY } from '../constants/business';
import { cleanVisitSummary } from './ReportViewPage';

// Work-order style service report document (owner direction 2026-08-03,
// modeled on the TruGreen WO / All U Need service-notification formats):
// this is what renders whenever the report is captured as a PDF — the
// download, the share sheet, and the post-service email attachment all
// serve this document. The glass web report (mode 'live') is untouched.
//
// SCOPE — "record of service" (owner ruling 2026-08-03, option A).
// This document is the permanent RECORD of the visit, not a reproduction of
// the interactive report. It carries everything needed to answer "what was
// done here, with what, where, and what do I do now": identity, conditions,
// findings, re-entry, recommendations, products with their EPA facts, areas
// serviced, treatment/placement maps, photos and visit history.
//
// It deliberately does NOT reproduce the V2 dashboards' richer analysis —
// the lawn water-balance breakdown, before/after progression sliders, the
// mosquito seasonal outlook, the animated visit timeline. Those live in the
// interactive report, which every copy of this document links to by URL.
// That boundary is a decision, not an omission: reviewers have raised each
// of those fields, and the answer is that they belong online.
//
// The bar for adding something here: would its ABSENCE make the record
// wrong, incomplete as a service record, or a broken promise? If yes it
// belongs (that is why the reconciled result, the promised follow-up, the
// coverage statuses and the label safety copy are all here). If it is
// additional analysis of data already summarised here, it stays online.
//
// Content rules: strictly the data the interactive report already shows —
// no pricing (this is a service record, not an invoice) and product safety
// copy comes only from the approved per-product label facts.

const NAVY = '#04395E';
const INK = '#17242F';
const MUTED = '#5B6A77';
const LINE = '#C9CED4';
const HAIR = '#E2E6EA';
const TZ = 'America/New_York';
// Link precedence for the permanent document:
//   1. data.publicOrigin — the server's canonical PUBLIC portal origin. The
//      headless renderer opens the page through CLIENT_URL /
//      SERVICE_REPORT_PDF_BASE_URL, which on prod is the RAW RAILWAY
//      HOSTNAME, so window.location.origin would bake an internal host into
//      a customer's document.
//   2. window.location.origin — preview/dev renders, whose tokens only
//      resolve on that deployment, so their artifacts must link to it.
//   3. the production portal.
const PORTAL_FALLBACK = 'https://portal.wavespestcontrol.com';
function portalBase(publicOrigin) {
  const canonical = String(publicOrigin || '').trim().replace(/\/+$/, '');
  if (canonical) return canonical;
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return PORTAL_FALLBACK;
}

const FONT = "'Inter', 'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

// Mirrors STATION_CARD_PROGRAM_META in StationMapCard: "activity" means bait
// consumption on a bait program and a recorded capture on a trapping program —
// a generic word would misstate the outcome in the permanent record.
// Mirrors STATION_STATUS_META / stationStatusMeta in StationMapCard. 'ok'
// means CHECKED AND CLEAR (green) — falling through to the navy on-file pin
// labelled a clear, inspected station as uninspected while the summary
// counted it as checked.
const STATION_STATUS_META = {
  ok: { cls: 'is-ok', label: 'Checked — no activity' },
  activity: { cls: 'is-activity', label: 'Activity observed' },
  serviced: { cls: 'is-serviced', label: 'Serviced this visit' },
  inaccessible: { cls: 'is-inaccessible', label: 'Not accessible this visit' },
};
const STATION_ON_FILE_META = { cls: '', label: 'On file (not checked this visit)' };
const STATION_OK_LEGEND = {
  rodent: 'Checked — no consumption',
  trapping: 'Checked — no capture',
};

function stationStatusMeta(status, program) {
  const base = STATION_STATUS_META[status] || STATION_ON_FILE_META;
  if (status === 'activity') return { ...base, label: STATION_ACTIVITY_LEGEND[program] || base.label };
  if (status === 'ok' && STATION_OK_LEGEND[program]) return { ...base, label: STATION_OK_LEGEND[program] };
  return base;
}

const STATION_ACTIVITY_LEGEND = {
  termite: 'Termite activity observed',
  rodent: 'Bait consumption observed',
  trapping: 'Capture recorded',
};

const STATION_ACTIVITY_SUMMARY = {
  termite: 'with termite activity',
  rodent: 'with bait consumption',
  trapping: 'with captures recorded',
};

// serviceDate is a DATE serialized at UTC midnight — format in UTC so the
// calendar day never rolls back. Timestamps format in ET like every other
// customer surface.
function fmtServiceDate(value, opts = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric', ...opts,
  });
}

function fmtTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

// "10.000" -> "10", "0.49" -> "0.49"; units come through as snake_case
// ("fl_oz") from the application record.
// Catalog rows for unregistered products (fertilizers, wetting agents,
// mechanical devices) store the literal "N/A" — printing it under EPA Reg.
// No. reads like missing paperwork. Mirrors applicationEpaReg.
function epaReg(app) {
  const raw = String(app.product?.epa_reg || app.epaReg || '').trim();
  if (/^n\/?a$/i.test(raw) || /^none$/i.test(raw)) return '';
  return raw;
}

function fmtAmount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value || '').trim();
  return String(parseFloat(num.toFixed(3)));
}

function fmtUnit(unit) {
  return String(unit || '').replace(/_/g, ' ').trim();
}

// Mirrors the web report's coverageReasonText so a skipped area reads the
// same way in the printed record as it does online.
function coverageReasonText(item, serviceType) {
  const reason = String(item.skippedReason || item.blockedReason || '').trim();
  if (!reason) return '';
  if (item.status === 'blocked') return `Blocked because: ${reason}`;
  if (serviceType === 'pest_control' && (item.status === 'skipped' || item.status === 'inaccessible')) {
    return `Could not access: ${reason}`;
  }
  if (item.status === 'skipped' || item.status === 'inaccessible') return `Skipped because: ${reason}`;
  return reason;
}

function fmtDayLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' });
}

function fmtPhone(phone) {
  const raw = String(phone || '').replace(/\D/g, '');
  const digits = raw.length === 11 && raw.startsWith('1') ? raw.slice(1) : raw;
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return String(phone || '').trim();
}

// Canonical completion choices (completion-defaults-resolver.js
// CUSTOMER_INTERACTION_CHOICES) plus the legacy values still on older records.
const INTERACTION_LABELS = {
  tech_home_spoke_with_them: 'Spoke with someone at the home',
  not_home_full_access: 'Not home — full access to the service areas',
  not_home_partial_access: 'Not home — partial access to the service areas',
  customer_specific_concern: 'Spoke with someone about a specific concern',
  tech_home_no_answer: 'Home — no answer at the door',
  customer_home_spoke_with_them: 'Spoke with someone at the home',
  customer_home_no_answer: 'Home — no answer at the door',
  spoke: 'Spoke with someone at the home',
  customer_not_home: 'No one was home during the visit',
  no_customer_contact: 'No customer interaction recorded',
  gate_access_used: 'Used the recorded access instructions',
  tech_not_home: 'Customer not home during service',
  left_note: 'Left a note for the customer',
};

// Normalize like customerInteractionCopy so historical spellings still resolve.
function interactionLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (INTERACTION_LABELS[key]) return INTERACTION_LABELS[key];
  // An unlisted historical value (documents.js still recognises 'interior')
  // must not drop the Contact row from the record — humanize it, the way
  // customerInteractionCopy falls back to formatEnumLabel.
  const words = key.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

// ONE compliance sanitizer for EVERY channel that can carry re-entry copy:
// the dynamic context, the V2 aftercare, and the product catalog's
// label-derived precaution/re-entry text (unconstrained free text — the repo
// has fixtures like "...about 1 hour"). This rule has now needed four
// channels closed, so it is enforced at the render site rather than per
// field: any string asserting a clock time or a duration is replaced with
// the approved once-dry idiom instead of being printed.
// What the rule bans is a fixed figure attached to a RE-ENTRY or DRYING
// claim — not every number and not every duration. "Irrigate within 14 days"
// and "water in with 0.25 inches" are label-required agronomic directions
// that must survive, and they carry time units too. So the test is BOTH: a
// time figure AND a re-entry/drying claim in the same sentence.
const REENTRY_NUMBER_WORDS = 'a|an|one|two|three|four|five|six|seven|eight|nine|ten'
  + '|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen'
  + '|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|half|several';
// a clock time (7 PM / 7:03 PM) or a quantity attached to a time unit
const REENTRY_TIME_RX = new RegExp(
  '\\b\\d{1,2}(:\\d{2})?\\s*(a\\.?m\\.?|p\\.?m\\.?)\\b'
  + `|\\b(\\d+(\\.\\d+)?|(${REENTRY_NUMBER_WORDS})([\\s-](${REENTRY_NUMBER_WORDS}))?)`
  + '[\\s-]*(second|sec|minute|min|hour|hr|day|week)s?\\b',
  'i',
);
// ...and the sentence must actually make a re-entry / drying claim. This
// vocabulary is exhaustive on purpose: two earlier attempts failed at the
// extremes (a phrasing blocklist kept missing wordings; an any-quantity
// allowlist erased agronomic instructions).
const REENTRY_CLAIM_RX = new RegExp(
  '\\b(re-?enter|re-?entry|reentry|entry|ready|dry|dries|dried|drying|safe'
  + '|keep\\s+(\\w+\\s+){0,3}(off|out|away|clear)'
  + '|stay\\s+(off|out|away)'
  // "avoid the treated area for five hours" is a re-entry claim too
  // (codex P1 #3176 r18) — scoped to the treated-surface nouns so "avoid
  // watering for 24 hours" stays agronomic.
  + '|avoid\\w*\\s+(the\\s+)?(treated|lawn|grass|yard|area)'
  // "Return after 7 PM" is the clock-time phrasing of the same claim
  // (codex P1 #3176 r20). Mirrors the server context regex's two return
  // forms — person-subject or sentence-leading — NOT a bare "return",
  // which would erase agronomic prose like "results return within two
  // weeks".
  + '|(you|your\\s+family|residents?|occupants?|everyone)\\s+(\\w+\\s+){0,3}return\\w*'
  + '|^\\s*return(ing)?\\b'
  + '|off\\s+(the\\s+)?treated)\\b',
  'i',
);
const REENTRY_SAFE_COPY = 'Ready once dry — your technician confirms timing.';

// DEFENCE IN DEPTH ONLY. Compliance is now enforced server-side at the
// payload boundary (reports-public.js) with stripFixedReentryTiming — the
// same clause-level rule and regression matrix validateContent uses for
// social copy. Five rounds of tuning a second, weaker rule here is what made
// that consolidation necessary; this local pass stays as a backstop for any
// path that reaches the document without going through that boundary, and
// must never become the primary enforcement point again.
function sanitizeReentryCopy(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let replaced = false;
  const kept = sentences.filter((sentence) => {
    if (REENTRY_TIME_RX.test(sentence) && REENTRY_CLAIM_RX.test(sentence)) {
      replaced = true;
      return false;
    }
    return true;
  });
  if (!replaced) return text;
  return [REENTRY_SAFE_COPY, ...kept].join(' ').trim();
}

// COMPLIANCE (AGENTS.md): never publish a fixed re-entry/drying figure on a
// customer surface — not as a duration ("keep clear for 2 hours") and not as
// the clock time computed from it ("ready after 7:03 PM"), which asserts the
// same thing. The approved idiom is once-dry with the technician confirming
// timing. This document is a NEW surface, so printing readyAt here would ADD
// such copy (AGENTS.md flags diffs that add or extend it) even though the
// live report still renders ready-at chips — that's a remediation item for
// the interactive report, not a licence to repeat it in the record.
function reentryTargetLine(target) {
  return `${target.label}: ready once dry — your technician confirms timing`;
}

function zoneNames(app, zones, serviceLine = 'pest') {
  const byId = new Map((zones || []).map((zone) => [String(zone.id), zone]));
  const ids = Array.isArray(app.zone_ids) ? app.zone_ids : [];
  const names = ids.map((id) => byId.get(String(id))?.label).filter(Boolean);
  // A legacy/manual application can carry only applicationArea — it's then the
  // ONLY record of where the product went, so it beats a generic phrase.
  if (!names.length) return app.applicationArea || 'Treated area recorded';
  // "Whole property" would broaden a turf treatment to structures and paving
  // where it was never applied — applicationZoneText keeps lawn scoped.
  if (zones && zones.length > 1 && names.length === zones.length) {
    return serviceLine === 'lawn' ? 'Your whole lawn' : 'Whole property';
  }
  return names.join(', ');
}

function Label({ children }) {
  return (
    <span style={{
      display: 'inline-block', minWidth: 86, color: MUTED, fontSize: 9.5,
      fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{children}</span>
  );
}

function InfoRow({ label, children }) {
  if (children == null || children === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '1.5px 0', minWidth: 0 }}>
      <Label>{label}</Label>
      <span style={{ color: INK, fontSize: 11.5, lineHeight: 1.35, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  );
}

function SectionHeader({ children }) {
  return (
    <div className="doc-keep-with-next" style={{
      borderBottom: `1.5px solid ${NAVY}`, margin: '14px 0 6px', paddingBottom: 3,
      color: NAVY, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>{children}</div>
  );
}

function Bullet({ children }) {
  return (
    <div style={{ display: 'flex', gap: 7, padding: '1.5px 0', fontSize: 11.5, lineHeight: 1.45, color: INK }}>
      <span aria-hidden="true" style={{ color: MUTED }}>•</span>
      <span>{children}</span>
    </div>
  );
}

export default function ServiceReportDocument({ data, token }) {
  // Remote images (the traced S3 snapshot, photos) can fail during the
  // headless capture. A heading with no image under it is a broken-looking
  // claim in a permanent record, so a failed image drops itself and its
  // section — same defensive pattern as RecapVideoCard on the live report.
  // The schematic is a data URI and cannot fail.
  const [failedImages, setFailedImages] = useState(() => new Set());
  const markImageFailed = (url) => setFailedImages((prev) => {
    if (!url || prev.has(url)) return prev;
    const next = new Set(prev);
    next.add(url);
    return next;
  });
  // The headless renderer reads this after page.pdf() (codex P2 #3176 r20):
  // the browser fetches its own /data, so the server's probe of a payload IT
  // built can miss a divergent URL that failed here — this counter is the
  // page's own load outcome, the only signal that describes what the
  // artifact actually shows. It also folds in images the PAYLOAD build
  // dropped before any <img> could mount (codex P2 r21): the server's own
  // resolution-failure count plus V2 photos arriving without a URL, which
  // the gallery filter below silently omits. Harmless on the live report.
  const payloadDroppedImages = (data.imageResolutionFailures || 0)
    + (Array.isArray(data.reportV2?.photos) ? data.reportV2.photos : [])
      .filter((photo) => photo && !(photo.url || photo.imageUrl)).length;
  useEffect(() => {
    window.__WAVES_PDF_IMAGE_FAILURES = failedImages.size + payloadDroppedImages;
  }, [failedImages, payloadDroppedImages]);
  const typed = data.typedReport || null;
  const result = typed?.todaysResult || null;
  const findings = Array.isArray(typed?.findings) ? typed.findings.filter((f) => (f.customerValueLabel ?? f.value) != null && String(f.customerValueLabel ?? f.value).trim() !== '') : [];
  const activity = data.activity || null;
  const reentry = data.dynamicContext?.reentry || null;
  // Older records store the aliases the web report's conditionRows accepts
  // (temp / humidity / wind / cloudCover) — normalize before deciding the
  // visit recorded nothing.
  const rawConditions = data.conditions || null;
  const normalizedConditions = rawConditions ? {
    temp_f: rawConditions.temp_f ?? rawConditions.temp,
    humidity_pct: rawConditions.humidity_pct ?? rawConditions.humidity,
    wind_mph: rawConditions.wind_mph ?? rawConditions.wind,
    rain_24h_in: rawConditions.rain_24h_in,
    sky: rawConditions.sky ?? rawConditions.cloudCover,
  } : null;
  // Lawn reports show the WEEK's rain — the figure the water card and the
  // assessment are built from — so every rain number on the page agrees; other
  // lines keep the trailing-24h capture (mirrors conditionRows).
  // LAWN ONLY. reportV2 also serves tree & shrub, whose landscape water
  // snapshot has rainInches too — substituting there relabelled the visit's
  // recorded 24-hour reading as weekly (regression from the r3 fix).
  // Legacy lawn reports (V2 absent or failed soft) carry the authoritative
  // seven-day figure on the assessment — the web report uses
  // `reportV2.water.rainInches ?? lawnAssessment.waterContext.rainfallInches7d`
  // for ALL lawn reports, so falling back to the 24-hour reading would print a
  // dry number beside guidance built from the week.
  const weeklyRainIn = data.serviceLine === 'lawn'
    ? (data.reportV2?.water?.rainInches ?? data.lawnAssessment?.waterContext?.rainfallInches7d)
    : null;
  const usingWeeklyRain = weeklyRainIn != null && weeklyRainIn !== '' && Number.isFinite(Number(weeklyRainIn));
  const rainLabel = usingWeeklyRain ? 'Rain this week' : 'Rain 24 hr';
  const rainValue = usingWeeklyRain ? weeklyRainIn : normalizedConditions?.rain_24h_in;
  const conditions = normalizedConditions
    && (Object.values(normalizedConditions).some((value) => value != null && value !== '') || usingWeeklyRain)
    ? normalizedConditions : null;
  const applications = Array.isArray(data.applications) ? data.applications : [];
  // A station check is a device inspection, not an application. But `method`
  // can't be trusted alone: methodFromProduct INFERS 'station_check' for any
  // termite or rodent product with a null application_method (a supported
  // state — the column was added nullable), so a historical liquid or
  // pre-treatment termiticide is classified as a device check. Filtering on
  // method alone therefore deleted the actual pesticide from the record and
  // suppressed its precautions.
  //
  // Identity decides, and the signal is PESTICIDE identity — an EPA
  // registration or a pesticide product type. Not the recorded amount: a
  // snap trap check legitimately records "1 ea" and still isn't a product
  // application, which is the case that made this filter necessary.
  const isProductApplication = (app) => {
    if ((app.method || 'perimeter_spray') !== 'station_check') return true;
    // An EXPLICIT station_check is a deliberate device inspection — never
    // re-classified by product identity (codex P1 r19): checking a station
    // baited with a registered rodenticide applies nothing. Identity may
    // only override the INFERRED case (legacy null application_method).
    // Legacy payloads without the flag (methodInferred undefined) keep the
    // identity override — their station_check can only have been inferred.
    if (app.methodInferred === false) return false;
    if (epaReg(app)) return true;
    const kind = `${app.product?.product_type || ''} ${app.product?.category || ''}`.toLowerCase();
    return /pestic|termitic|insectic|herbic|fungic|rodentic/.test(kind);
  };
  const appliedProducts = applications.filter(isProductApplication);
  // Lawn-assessment photos fall back to raw per-photo vision `observations`
  // as their caption (report-data.js). The lawn V2 path deliberately drops
  // those blurbs — they over-diagnose — in favour of ONE consolidated,
  // guarded summary, so the document must not print them either (codex P1).
  const suppressPhotoCaption = (photo) => Boolean(data.reportV2) && String(photo.id || '').startsWith('lawn-');
  const galleryPhotos = (data.photos || []).filter((photo) => photo && photo.url);
  // Tree/shrub evidence is captured in tree_shrub_assessment_photos, exposed
  // as reportV2.photos — never in data.photos — so the gallery was empty on
  // those visits (codex P1 r3). De-duped by url against the main gallery.
  const v2AssessmentPhotos = (Array.isArray(data.reportV2?.photos) ? data.reportV2.photos : [])
    .filter((photo) => photo && (photo.url || photo.imageUrl))
    .map((photo) => ({
      id: photo.id ? `v2-${photo.id}` : `v2-${photo.url || photo.imageUrl}`,
      url: photo.url || photo.imageUrl,
      caption: photo.caption || photo.label || '',
      isMoment: true,
    }));
  // Approved visual service moments live outside data.photos; the previous
  // PDF rendered them as Service Highlights, so keep them in the artifact.
  const momentPhotos = (data.proofMoments || data.visualServiceMoments || [])
    .filter((moment) => moment && moment.mediaUrl && moment.mediaType !== 'video')
    .map((moment) => ({
      id: `moment-${moment.id}`,
      url: moment.mediaUrl,
      // keep the structured context, not just the prose caption: a sealing
      // photo should still say what it documents and where.
      caption: [
        moment.tagLabel,
        moment.locationArea,
        moment.customerCaption,
      ].filter(Boolean).filter((part, i, all) => all.indexOf(part) === i).join(' · ') || 'Service highlight',
      isMoment: true,
    }));
  // The turf-height gauge shot is pulled from data.photos only when lawn V2
  // surfaced it in the mowing module — carry it back in with its own label.
  const gaugePhoto = data.mowingHeight?.photoUrl
    ? [{ id: 'mowing-gauge', url: data.mowingHeight.photoUrl, caption: 'Turf height measured at this visit', isMoment: true }]
    : [];
  // A failed image is NOT silently dropped: an omission nobody can see is the
  // worst outcome for a permanent record, and refusing the whole render (an
  // earlier attempt) risked denying the report indefinitely when an S3 object
  // is permanently gone. Instead the frame stays with an explicit
  // unavailable note pointing at the online report, so the artifact is honest
  // and always available.
  const photos = [...galleryPhotos, ...v2AssessmentPhotos, ...momentPhotos, ...gaugePhoto]
    .filter((photo, i, all) => all.findIndex((other) => other.url === photo.url) === i)
    .map((photo) => (failedImages.has(photo.url) ? { ...photo, unavailable: true } : photo));
  const tracedMapRaw = data.treatmentMap?.traced?.snapshotUrl || null;
  const tracedMapUrl = tracedMapRaw && !failedImages.has(tracedMapRaw) ? tracedMapRaw : null;
  // buildReportV1Data ALWAYS builds mapSvg, even for an inspection-only or
  // station-check-only visit where the SVG carries no treatment layer.
  // Heading it "Where we treated" would be a false treatment claim in a
  // permanent record (codex P1), so the schematic renders only when
  // something was actually applied. A traced map always implies treatment.
  // The generated map is a self-contained SVG (own <style> + xmlns), so it
  // renders identically as an <img> data URI — and an <img> cannot execute
  // script or fetch anything, so no markup from the payload is ever injected
  // into this document. Inline over the /map.svg endpoint: no network fetch
  // to race the PDF capture.
  const schematicSvg = data.treatmentMap?.schematic?.svg || data.mapSvg || null;
  const schematicSrc = schematicSvg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(schematicSvg)}`
    : null;
  const zoneLegend = (data.zones || [])
    .map((zone) => ({ letter: zone.letter, label: zone.label }))
    .filter((zone) => zone.label);
  // treatment-map.js isRenderableApplication EXCLUDES method 'station_check',
  // so a station-check-only visit produces a schematic with no treatment
  // layer — a bare applications.length check still printed the false
  // "Where we treated" claim (codex P1 r2). Mirror the renderer's predicate.
  // treatment-map.js:184 filters on isRenderableApplication(app) AND
  // zoneIds.length — a legacy/manual row carrying only applicationArea is
  // dropped from the SVG, so requiring only the method still labelled an
  // unmarked base schematic "Where we treated" (codex P1 r3).
  // TWO DIFFERENT QUESTIONS, two predicates. "Did treatment happen?" governs
  // aftercare and precautions and must NOT require zone IDs — a legacy/manual
  // application can carry only applicationArea and is still a real treatment.
  // "Can the schematic draw it?" additionally needs zone IDs, because that is
  // what treatment-map.js filters on. Reusing the map predicate for aftercare
  // silently stripped watering and re-entry instructions from those visits.
  const hasActualTreatment = applications.some(isProductApplication);

  const hasRenderableTreatment = applications.some((app) => {
    const method = app.method || 'perimeter_spray';
    const zoneIds = Array.isArray(app.zone_ids) ? app.zone_ids : (Array.isArray(app.zoneIds) ? app.zoneIds : []);
    return method !== 'station_check' && zoneIds.length > 0;
  });

  const stationMap = data.stationMap?.available && Array.isArray(data.stationMap.stations) && data.stationMap.stations.length
    ? data.stationMap : null;
  const reportUrl = `${portalBase(data.publicOrigin)}/report/${encodeURIComponent(token)}`;
  const reportNumber = String(data.serviceRecordId || token || '').replace(/-/g, '').slice(0, 10).toUpperCase();

  const summaryParagraphs = [];
  if (result?.headline) summaryParagraphs.push(String(result.headline).replace(/\.$/, '') + '.');
  // reports-public.js attaches reportV2.todaysResult (a STRING) specifically to
  // replace legacy summary copy that contradicts the watch items — without it
  // the PDF can claim nothing notable was found directly above those findings.
  const reconciledResult = typeof data.reportV2?.todaysResult === 'string'
    ? data.reportV2.todaysResult.trim() : '';
  // Stored legacy recaps carry known defects (a broken ", and - Waves" tail and
  // an over-strong "should see activity ease" promise) that cleanVisitSummary
  // exists to strip — printing data.summary raw reintroduced both.
  const summaryBody = reconciledResult
    || result?.body || cleanVisitSummary(data.summary) || data.dynamicContext?.aiSummary?.body || '';
  if (summaryBody && !summaryParagraphs.includes(summaryBody)) summaryParagraphs.push(summaryBody);

  // V2 payloads carry the PRINCIPAL result for their service lines — the
  // status/insights the live report leads with. Reading only typedReport
  // dropped them from the PDF entirely (codex P1 ×3). These are governed,
  // confidence-gated customer fields, so the document renders their text.
  const pestV2 = data.pestReportV2 || null;
  const mosquitoV2 = data.mosquitoReportV2 || null;
  // reportV2 serves BOTH lawn and tree_shrub (same snapshot/diagnosis/insights).
  const v2 = data.reportV2 || null;

  const v2StatusLine = (() => {
    if (pestV2?.status?.label) return { label: 'Protection status', value: pestV2.status.label, detail: pestV2.statusSummary };
    if (mosquitoV2?.status?.label) return { label: 'Yard usability', value: mosquitoV2.status.label, detail: mosquitoV2.statusSummary };
    if (v2?.snapshot?.statusHeadline) {
      return {
        label: 'Overall',
        value: v2.snapshot.statusHeadline,
        detail: v2.snapshot.rootCause || v2.snapshot.scoreExplanation,
        score: v2.snapshot.overallScore,
      };
    }
    return null;
  })();

  // insights are already confidence-gated by the V2 builders; diagnosis rows
  // carry the per-category customer explanation.
  const v2Insights = (Array.isArray(v2?.insights) ? v2.insights : [])
    .filter((insight) => insight && (insight.headline || insight.whatWeSaw));
  const v2Diagnosis = (Array.isArray(v2?.diagnosis) ? v2.diagnosis : [])
    .filter((row) => row && row.customerExplanation);
  // buildBugFilesContext sets confirmedByTech:false for cards that exist only
  // because a product LISTS that pest as a target — no sighting was recorded
  // (premium-experience.js:540). Printing those plain under "What we found"
  // turns a coverage target into a confirmed find in the permanent record.
  const pestBugFiles = (Array.isArray(pestV2?.bugFiles) ? pestV2.bugFiles : [])
    .filter((bug) => bug && (bug.suspectLabel || bug.whatWeDid));
  // The principal SPATIAL result for recurring pest/mosquito V2 visits —
  // what is protected, what was watched, what is clear. Shapes are
  // { summary, items:[{ key, label, status, detail }] } in both builders.
  const defenseBlock = pestV2?.defense || mosquitoV2?.habitat || null;
  const defenseItems = (Array.isArray(defenseBlock?.items) ? defenseBlock.items : [])
    .filter((item) => item && (item.label || item.detail));
  // PEST_REPORT_V2 puts the approved concern card here; non-V2 pest reports
  // use the top-level customerConcernCard. Both must survive into the PDF.
  const v2Concern = pestV2?.customerConcern || mosquitoV2?.customerConcern || null;
  // buildPrimaryMove returns { title, why, impact, dueLabel } in BOTH builders
  // (pest-report-v2.js / mosquito-report-v2.js) — an earlier customerText/text
  // lookup here silently always resolved to null (codex P1 r2).
  const primaryMove = pestV2?.primaryMove || mosquitoV2?.primaryMove || null;
  const v2NextMove = primaryMove?.title
    ? [primaryMove.title, primaryMove.why, primaryMove.impact].filter(Boolean).join(' ')
      + (primaryMove.dueLabel ? ` (${primaryMove.dueLabel})` : '')
    : null;


  const recommendations = [];
  const pushRec = (text) => {
    const t = String(text || '').trim();
    if (t && !recommendations.includes(t)) recommendations.push(t);
  };
  pushRec(result?.nextStep);
  (typed?.nextStepChips || []).forEach((chip) => {
    // chips restate nextStep in shorthand — only add ones that say something new
    if (!recommendations.some((r) => r.toLowerCase().includes(String(chip).toLowerCase()))) pushRec(chip);
  });
  // ⛔ data.recommendations / data.protocol.recommendations are NOT rendered.
  // buildProtocolPayload folds raw `[next]`-tagged technician_notes lines into
  // both (report-data.js taggedNoteLines), and AGENTS.md is explicit: raw
  // technician_notes never egress on any report path — parser-approved copy
  // only. The web report renders neither array; the PDF must not either.
  // Lawn visits carry their guidance in the assessment + V2 aftercare
  // instead of typedReport — same section, same voice.
  // Legacy assessment recommendations are the LawnAssessmentCard's content,
  // which the live report renders INSTEAD of (never alongside) LawnReportV2Section.
  // Flattening both into one list produced duplicate mowing guidance and three
  // overlapping watering instructions in the same section — same suppression
  // rule already applied to lawnAssessment.observations.
  const assessRecs = data.reportV2 ? null : data.lawnAssessment?.recommendations?.recommendations;
  (Array.isArray(assessRecs) ? [...assessRecs].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)) : [])
    .forEach((rec) => pushRec(rec?.action || rec?.text || rec));
  // buildAftercare([]) still returns "No special watering is needed because of
  // today's treatment" when there were NO applications — printing it on an
  // inspection-only lawn visit claims a treatment that didn't happen (5th
  // variant of this class: defaults read as evidence).
  if (hasActualTreatment) pushRec(data.reportV2?.aftercare?.watering);
  pushRec(v2NextMove);
  // "Your next step" — the homeowner task a V2 top issue assigns. Lives on
  // snapshot.customerAction and per-insight customerAction; omitting it drops
  // required actions (e.g. correcting irrigation) from the artifact.
  pushRec(v2?.snapshot?.customerAction);
  pushRec(v2?.followUp?.customerAction);
  // wavesNext is what WAVES will do next (future tense, never the past-tense
  // wavesAction) — a commitment, so it belongs in the permanent record.
  pushRec(v2?.snapshot?.wavesNext
    || (Array.isArray(v2?.insights) ? v2.insights : []).map((i) => i?.nextVisitPlan).find(Boolean));
  (Array.isArray(v2?.insights) ? v2.insights : []).forEach((insight) => pushRec(insight?.customerAction));
  pushRec(v2?.mowing?.recommendation);

  // "(3 of 5 — baseline recorded today)" / "(3 of 5)" / " — baseline
  // recorded today" / "" depending on what the visit actually recorded.
  const activityScored = activity && activity.score != null && activity.maxScore != null;
  const activityBaselineNote = activity?.isBaseline ? ' — baseline recorded today' : '';
  const activityDetail = activityScored
    ? ` (${activity.score} of ${activity.maxScore}${activityBaselineNote})`
    : activityBaselineNote;

  // Per-area service record: which areas were serviced, and which were
  // skipped/inaccessible and WHY. This is core work-order content the
  // document was dropping entirely.
  // ⛔ customerDescription ONLY — items also carry internalDescription,
  // which is staff copy and must never egress (same rule as technician_notes).
  const coverageItems = (data.serviceCoverage?.enabled !== false
    ? (data.serviceCoverage?.items || []) : [])
    .filter((item) => item && item.areaName);
  const coverageSummary = data.serviceCoverage?.summary || null;

  // Pest Pressure honours the admin visibility config the PDF cache key is
  // hashed on (pestPressureVisibilitySignature) — rendering it past those
  // flags would defeat that control.
  const pressure = data.pestPressure
    && data.pestPressure.enabled !== false
    && data.pestPressure.showOnCustomerReport !== false
    && data.pestPressure.label
    ? data.pestPressure : null;

  // COMPLIANCE: never let a computed ready-at clock time through, whatever
  // field carries it (see reentryTargetLine).
  const rawReentrySummary = String(reentry?.customerSummary || '').trim();
  const reentrySummary = sanitizeReentryCopy(rawReentrySummary);

  const concern = data.customerConcernCard || v2Concern || null;
  const isWaveGuard = Boolean(data.waveGuardTier || data.waveguardTier || data.plan?.isWaveGuard);

  // Untyped visits record their findings at the top level; the typed
  // snapshot only covers typed reports. Both must reach the document or the
  // PDF silently drops what the visit recorded (codex P1).
  // ⛔ EXCLUDE category 'observation'. report-data.js synthesizes those from
  // protocol.observations, which merges parser-approved structured lists with
  // taggedNoteLines(technician_notes, ['found']) — RAW notes. By the time the
  // payload reaches the client the two are indistinguishable, so rendering any
  // of them could put "[found] Gate code 4417" in a permanent customer PDF.
  // AGENTS.md: raw technician_notes never egress on any report path. Fail
  // closed — real structured findings (the findings table, which carry detail
  // and recommendation) still render. A server-side split of approved
  // observations from raw note lines would let these come back.
  // ⛔ PROVENANCE, not category. Findings synthesized from raw technician
  // notes are inserted title-only with detail/recommendation null (
  // admin-dispatch.js:5850-5857, report-data.js:2266-2274) — and their
  // category is REWRITTEN to 'conducive_condition' when the note contains
  // "concern", which slipped straight past an earlier category filter.
  // A finding that carries structured content (detail or recommendation)
  // came from the findings pipeline; a bare title did not. Fail closed on
  // the bare titles — AGENTS.md: raw technician_notes never egress.
  const recordFindings = (Array.isArray(data.findings) ? data.findings : [])
    .filter((finding) => finding && String(finding.title || '').trim())
    .filter((finding) => String(finding.detail || '').trim() || String(finding.recommendation || '').trim());
  // Combined-service visits carry companion sections. internalOnly ones are
  // STAFF-ONLY and must never print — the same rule the web report's print
  // stylesheet enforces via .companion-internal.
  const companions = (Array.isArray(data.companionReports) ? data.companionReports : [])
    .filter((companion) => companion && !companion.internalOnly);
  // Trend programs (trap checks, bait stations, roach knockdown) carry the
  // cross-visit history the old PDF rendered: buildTypedVisitTimeline returns
  // { indicatorKey, label, visits:[{serviceDate, headline, levelWord,
  // isCurrent}] } and only exists once there are 2+ visits.
  const visitHistory = (Array.isArray(data.typedVisitTimeline?.visits) ? data.typedVisitTimeline.visits : [])
    .filter((visit) => visit && (visit.serviceDate || visit.headline));

  // When reportV2 exists the live report renders LawnReportV2Section INSTEAD of
  // LawnAssessmentCard, so the raw assessment paragraph would duplicate the
  // governed diagnosis/insights above. Legacy (no V2) reports still show it.
  const lawnObservations = data.reportV2
    ? null
    : (String(data.lawnAssessment?.observations || '').trim() || null);
  // Legacy lawn reports (no reportV2 — historical payloads and the fail-soft
  // V2 build path) carry the visit's principal lawn-health result in
  // lawnAssessment.scores + its customer summary. Reducing that to the
  // observations string dropped it from the permanent record (codex P1 r2).
  const legacyLawn = !data.reportV2 && data.lawnAssessment ? data.lawnAssessment : null;
  const legacyLawnScores = legacyLawn?.scores || null;
  const legacyLawnSummary = legacyLawn?.recommendations?.summary || legacyLawn?.aiSummary || null;
  const LEGACY_LAWN_SCORE_LABELS = [
    ['turfDensity', 'Turf density'],
    ['colorHealth', 'Color & vigor'],
    ['weedSuppression', 'Weed suppression'],
    ['stressDamage', 'Stress / damage'],
    ['fungusControl', 'Fungus control'],
    ['thatchScore', 'Thatch'],
  ];
  const legacyLawnRows = legacyLawnScores
    ? LEGACY_LAWN_SCORE_LABELS
      .filter(([key]) => legacyLawnScores[key] != null)
      .map(([key, label]) => `${label} ${legacyLawnScores[key]}`)
    : [];
  const mowing = data.mowingHeight || null;
  const interaction = interactionLabel(data.customerInteraction);

  return (
    <div
      className="service-report-v1 service-report-document"
      style={{ background: '#fff', color: INK, fontFamily: FONT, minHeight: '100vh' }}
    >
      <style>{`
        .service-report-document { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .service-report-document .doc-page { max-width: 760px; margin: 0 auto; padding: 20px 16px 28px; }
        .service-report-document table { border-collapse: collapse; width: 100%; }
        @media print {
          /* The document IS the artifact — no shell chrome, no glass. */
          [data-waves-shell-header],
          footer[role="contentinfo"],
          .waves-skip-link { display: none !important; }
          html[data-glass-theme] .glass-scene-orbs,
          html[data-glass-theme] .glass-scene-grain { display: none !important; }
          .service-report-document .doc-page { padding: 0; max-width: none; }
          .service-report-document .doc-keep,
          .service-report-document .doc-product-row { break-inside: avoid; page-break-inside: avoid; }
          .service-report-document .doc-keep-with-next { break-after: avoid-page; page-break-after: avoid; }
        }
        .service-report-document .doc-map-frame svg { display: block; width: 100%; height: auto; }
        .service-report-document .doc-station-pin {
          position: absolute; transform: translate(-50%, -50%);
          width: 17px; height: 17px; border-radius: 50%;
          background: ${NAVY}; color: #fff; font-size: 9.5px; font-weight: 800;
          display: flex; align-items: center; justify-content: center;
          border: 1.5px solid #fff; box-shadow: 0 0 0 1px ${LINE};
        }
        .service-report-document .doc-station-pin.is-activity { background: #A33B2E; }
        .service-report-document .doc-station-pin.is-ok { background: #0F7B54; }
        .service-report-document .doc-station-pin.is-serviced { background: #B7791F; }
        .service-report-document .doc-station-pin.is-inaccessible { background: ${MUTED}; }
      `}</style>
      <div className="doc-page">

        {/* Letterhead */}
        <div className="doc-keep" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <img src="/waves-logo.png" alt="Waves Pest Control" style={{ height: 64, display: 'block' }} />
          <div style={{ textAlign: 'right', fontSize: 10.5, lineHeight: 1.5, color: MUTED }}>
            <div style={{ color: NAVY, fontSize: 12.5, fontWeight: 800 }}>Waves Pest Control, LLC</div>
            <div>{WAVES_SUPPORT_PHONE_DISPLAY} · wavespestcontrol.com</div>
            <div>contact@wavespestcontrol.com</div>
            <div>Licensed &amp; insured · {WAVES_FL_LICENSE_LINE}</div>
          </div>
        </div>

        {/* Title row */}
        <div className="doc-keep" style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          borderTop: `2.5px solid ${NAVY}`, marginTop: 12, paddingTop: 8,
        }}>
          <div style={{ color: NAVY, fontSize: 21, fontWeight: 800, letterSpacing: '0.02em' }}>SERVICE REPORT</div>
          <div style={{ fontSize: 11, color: MUTED }}>
            Report #{reportNumber} · {fmtServiceDate(data.serviceDate)}
          </div>
        </div>

        {/* Info grid */}
        <div className="doc-keep" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.1fr 0.9fr', gap: '4px 22px', marginTop: 10 }}>
          {/* minWidth:0 on each column: grid otherwise honours a long unbroken
              email's min-content width and squeezes the other two columns. */}
          <div style={{ minWidth: 0 }}>
            <SectionHeader>Customer</SectionHeader>
            <InfoRow label="Name">{data.customerName}</InfoRow>
            <InfoRow label="Address">{data.serviceAddress || data.propertyAddress}</InfoRow>
            <InfoRow label="Phone">{fmtPhone(data.customerPhone)}</InfoRow>
            <InfoRow label="Email">{data.customerEmail}</InfoRow>
          </div>
          <div>
            <SectionHeader>Service</SectionHeader>
            <InfoRow label="Service">{data.serviceDisplayName || data.serviceType}</InfoRow>
            <InfoRow label="Technician">{data.technicianName}</InfoRow>
            <InfoRow label="Time in">{fmtTime(data.visitTiming?.arrivedAt)}</InfoRow>
            <InfoRow label="Time out">{fmtTime(data.visitTiming?.exitedAt)}</InfoRow>
            <InfoRow label="Contact">{interaction}</InfoRow>
          </div>
          <div>
            <SectionHeader>Conditions</SectionHeader>
            {conditions ? (
              <>
                <InfoRow label="Temp">{conditions.temp_f != null ? `${conditions.temp_f} °F` : null}</InfoRow>
                <InfoRow label="Humidity">{conditions.humidity_pct != null ? `${conditions.humidity_pct}%` : null}</InfoRow>
                <InfoRow label="Wind">{conditions.wind_mph != null ? `${conditions.wind_mph} mph` : null}</InfoRow>
                <InfoRow label={rainLabel}>{rainValue != null ? `${rainValue} in` : null}</InfoRow>
                <InfoRow label="Sky">{conditions.sky}</InfoRow>
              </>
            ) : (
              <div style={{ fontSize: 11, color: MUTED, padding: '2px 0' }}>Not recorded for this visit.</div>
            )}
          </div>
        </div>

        {/* Summary */}
        {summaryParagraphs.length > 0 && (
          <div className="doc-keep">
            <SectionHeader>Summary of today&apos;s service</SectionHeader>
            {summaryParagraphs.map((paragraph) => (
              <p key={paragraph} style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>{paragraph}</p>
            ))}
          </div>
        )}

        {/* The customer's own concern + our acknowledgment — a pest V2 visit
            carries it in pestReportV2.customerConcern, other lines in the
            top-level card. Losing it makes the report read as if the
            concern was ignored. */}
        {concern && (concern.concern || concern.body) && (
          <div className="doc-keep">
            {/* buildCustomerConcernCard returns { headline, concern, body,
                nextStep } — an earlier guess at customerConcern/acknowledgement
                meant this section never mounted at all (codex P2 r6). */}
            <SectionHeader>{concern.headline || 'What you flagged'}</SectionHeader>
            {concern.concern && (
              <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>&ldquo;{concern.concern}&rdquo;</p>
            )}
            {concern.body && (
              <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>{concern.body}</p>
            )}
            {concern.nextStep && (
              <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>{concern.nextStep}</p>
            )}
          </div>
        )}

        {/* A promised revisit is a commitment — dropping it from the permanent
            artifact leaves the customer with no record of it. */}
        {v2?.followUp && (v2.followUp.headline || v2.followUp.reason) && (
          <div className="doc-keep">
            <SectionHeader>{v2.followUp.headline || 'Follow-up already planned'}</SectionHeader>
            {v2.followUp.reason && (
              <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>{v2.followUp.reason}</p>
            )}
          </div>
        )}

        {/* Findings */}
        {(findings.length > 0 || recordFindings.length > 0 || activity || lawnObservations
          || mowing?.heightIn != null || v2StatusLine || v2Insights.length > 0 || v2Diagnosis.length > 0 || pestBugFiles.length > 0
          || defenseItems.length > 0 || pressure || legacyLawnScores?.overallScore != null) && (
          <div className="doc-keep">
            <SectionHeader>What we found</SectionHeader>
            {pressure && (
              <Bullet>
                <strong>Pest Pressure:</strong> {pressure.label}
                {pressure.displayScore != null ? ` (${pressure.displayScore} of ${pressure.maxScore})` : ''}
                {pressure.summary ? ` — ${pressure.summary}` : ''}
              </Bullet>
            )}
            {v2StatusLine && (
              <Bullet>
                <strong>{v2StatusLine.label}:</strong> {v2StatusLine.value}
                {v2StatusLine.score != null ? ` (${v2StatusLine.score}/100)` : ''}
                {v2StatusLine.detail ? ` — ${v2StatusLine.detail}` : ''}
              </Bullet>
            )}
            {v2Diagnosis.map((row) => (
              <Bullet key={row.key || row.label}>
                <strong>{row.label}{row.score != null ? ` (${row.score})` : ''}:</strong> {row.customerExplanation}
              </Bullet>
            ))}
            {v2Insights.map((insight, i) => (
              <Bullet key={insight.category ? `${insight.category}-${i}` : i}>
                <strong>{insight.headline}{insight.headline ? ':' : ''}</strong> {[insight.whatWeSaw, insight.whyItMatters, insight.wavesAction].filter(Boolean).join(' ')}
              </Bullet>
            ))}
            {defenseBlock?.summary && <Bullet>{defenseBlock.summary}</Bullet>}
            {defenseItems.map((item) => (
              <Bullet key={item.key || item.label}>
                <strong>{item.label}{item.status ? ` (${item.status})` : ''}:</strong> {item.detail}
              </Bullet>
            ))}
            {pestBugFiles.map((bug, i) => (
              <Bullet key={bug.pestKey || i}>
                <strong>{bug.suspectLabel}{bug.confirmedByTech === false ? ' (covered by today\u2019s treatment \u2014 not observed on this visit)' : ''}:</strong>{' '}
                {[bug.whereSeen ? `Seen at ${bug.whereSeen}.` : '', bug.whyItMatters, bug.whatWeDid].filter(Boolean).join(' ')}
              </Bullet>
            ))}
            {legacyLawnScores?.overallScore != null && (
              <Bullet>
                <strong>Lawn health:</strong> {legacyLawnScores.overallScore}/100
                {legacyLawnRows.length ? ` — ${legacyLawnRows.join(' · ')}` : ''}
              </Bullet>
            )}
            {legacyLawnSummary && <Bullet>{legacyLawnSummary}</Bullet>}
            {lawnObservations && <Bullet>{lawnObservations}</Bullet>}
            {mowing && mowing.heightIn != null && (
              <Bullet>
                <strong>Mowing height:</strong> {mowing.heightIn} in measured
                {mowing.bandLabel ? ` · target ${mowing.bandLabel}` : ''}
                {mowing.status === 'in_range' ? ' (in range)' : ''}
              </Bullet>
            )}
            {findings.map((finding) => (
              <Bullet key={finding.fieldKey || finding.customerLabel}>
                <strong>{finding.customerLabel}:</strong> {finding.customerValueLabel || finding.value}
              </Bullet>
            ))}
            {activity && activity.levelWord && (
              <Bullet>
                <strong>{activity.label}:</strong> {activity.levelWord}{activityDetail}
              </Bullet>
            )}
            {recordFindings.map((finding) => (
              <Bullet key={finding.id || finding.title}>
                {/* A title with no detail is a flag ("Fresh droppings found"),
                    not a label — bolding it with nothing after reads as a
                    missing value. */}
                {finding.detail
                  ? <><strong>{finding.title}:</strong> {finding.detail}</>
                  : finding.title}
                {finding.recommendation ? ` ${finding.recommendation}` : ''}
              </Bullet>
            ))}
          </div>
        )}

        {/* Re-entry */}
        {/* data.advisory carries SERVICE-LINE DEFAULTS (report-data merges
            advisoryDefaults and normalization only zeros the timers), so an
            inspection-only visit still has pet_advisory set. Printing "keep
            pets off treated zones until dry" on a visit with no treatment is
            a false treatment claim (codex P1 r6) — the default advisory only
            renders when something was actually applied. A real re-entry
            context is itself evidence of treatment and always renders. */}
        {(reentry || (data.advisory?.pet_advisory && hasActualTreatment)) && (
          <div className="doc-keep">
            <SectionHeader>Re-entry &amp; precautions</SectionHeader>
            {/* buildReentrySummary emits "<area> ready at 7:03 PM" while the
                window is still open (reentry.js:39-44) — the same fixed
                re-entry claim the target rows were just sanitized of, through
                a different field. Print the summary only when it asserts no
                clock time; otherwise use the approved idiom. */}
            {reentrySummary && <Bullet>{reentrySummary}</Bullet>}
            {(reentry?.targets || []).map((target) => (
              <Bullet key={target.key || target.label}>{reentryTargetLine(target)}</Bullet>
            ))}
            {/* petAdvisory is persisted free text copied straight through by
                buildReentryContextFromRecord, so it can carry "keep pets off
                treated turf for 2 hours" and needs the same guard. */}
            {sanitizeReentryCopy(reentry?.petAdvisory || (hasActualTreatment ? data.advisory?.pet_advisory : null)) && (
              <Bullet>{sanitizeReentryCopy(reentry?.petAdvisory || data.advisory?.pet_advisory)}</Bullet>
            )}
            {reentry?.irrigationReadyAt && (
              <Bullet>Hold irrigation until {fmtTime(reentry.irrigationReadyAt)} on {fmtDayLabel(reentry.irrigationReadyAt)}.</Bullet>
            )}
            {hasActualTreatment && sanitizeReentryCopy(data.reportV2?.aftercare?.reentry) && (
              <Bullet>{sanitizeReentryCopy(data.reportV2.aftercare.reentry)}</Bullet>
            )}
          </div>
        )}

        {/* Recommendations */}
        {recommendations.length > 0 && (
          <div className="doc-keep">
            <SectionHeader>What we recommend</SectionHeader>
            {recommendations.map((rec) => <Bullet key={rec}>{rec}</Bullet>)}
          </div>
        )}

        {/* Products applied */}
        {appliedProducts.length > 0 && (
          <div>
            <SectionHeader>Products applied</SectionHeader>
            <table style={{ fontSize: 11 }}>
              <thead className="doc-keep-with-next">
                <tr>
                  {['Product', 'EPA Reg. No.', 'Rate', 'Total applied'].map((heading, i) => (
                    <th key={heading} style={{
                      textAlign: i === 0 ? 'left' : 'right', padding: '4px 6px 4px 0',
                      color: MUTED, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em',
                      textTransform: 'uppercase', borderBottom: `1px solid ${LINE}`,
                    }}>{heading}</th>
                  ))}
                </tr>
              </thead>
              {appliedProducts.map((app, index) => {
                  const product = app.product || {};
                  const name = product.name || app.productName || 'Product';
                  return (
                    <tbody className="doc-product-row" key={app.id || `${name}-${index}`}>
                      <tr>
                        <td style={{ padding: '6px 6px 1px 0', fontWeight: 700, color: INK }}>{name}</td>
                        <td style={{ padding: '6px 0 1px', textAlign: 'right', whiteSpace: 'nowrap' }}>{epaReg(app) || '—'}</td>
                        <td style={{ padding: '6px 0 1px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {/* both halves or neither: a bare "5" can't be read
                              as ounces, gallons or grams in a pesticide
                              record, which is worse than showing nothing. */}
                          {app.rate && app.rateUnit ? `${fmtAmount(app.rate)} ${fmtUnit(app.rateUnit)}` : '—'}
                        </td>
                        <td style={{ padding: '6px 0 1px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {app.totalAmount && app.amountUnit ? `${fmtAmount(app.totalAmount)} ${fmtUnit(app.amountUnit)}` : '—'}
                        </td>
                      </tr>
                      <tr>
                        <td colSpan={4} style={{ padding: `0 0 8px 0`, borderBottom: index < appliedProducts.length - 1 ? `1px solid ${HAIR}` : 'none' }}>
                          <div style={{ fontSize: 10.5, color: MUTED, lineHeight: 1.5 }}>
                            {product.active_ingredient && <div><strong style={{ color: INK, fontWeight: 600 }}>Active ingredient:</strong> {product.active_ingredient}</div>}
                            {app.methodLabel && <div><strong style={{ color: INK, fontWeight: 600 }}>Method:</strong> {app.methodLabel}</div>}
                            {Array.isArray(app.targets) && app.targets.length > 0 && (
                              <div><strong style={{ color: INK, fontWeight: 600 }}>Target:</strong> {app.targets.join(', ')}</div>
                            )}
                            <div><strong style={{ color: INK, fontWeight: 600 }}>Areas:</strong> {zoneNames(app, data.zones, data.serviceLine)}</div>
                            {(product.precaution_summary || product.reentry_summary) && (
                              <div><strong style={{ color: INK, fontWeight: 600 }}>Label safety:</strong> {[product.precaution_summary, product.reentry_summary].map(sanitizeReentryCopy).filter(Boolean).filter((part, i, all) => all.indexOf(part) === i).join(' ')}</div>
                            )}
                            {/* Legacy lawn reports (no reportV2) carry approved
                                watering-in guidance ONLY here — dropping it
                                loses a required instruction. */}
                            {product.irrigation_notes && (
                              <div><strong style={{ color: INK, fontWeight: 600 }}>Watering in:</strong> {product.irrigation_notes}</div>
                            )}
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  );
              })}
            </table>
          </div>
        )}

        {/* Where we treated — the tech-traced spray snapshot when one exists
            (Waves-stored image), else the generated zone schematic. The
            satellite basemap never prints (provider ToS — long-standing
            rule), which these two Waves-owned renderings don't involve. */}
        {coverageItems.length > 0 && (
          <div className="doc-keep">
            <SectionHeader>Areas serviced</SectionHeader>
            {coverageItems.map((item) => {
              const reason = coverageReasonText(item, data.coverageServiceType);
              return (
                <Bullet key={item.id || item.areaName}>
                  <strong>{item.markerLabel ? `${item.markerLabel} — ` : ''}{item.areaName}:</strong>{' '}
                  {[item.customerDescription, reason].filter(Boolean).join(' ')}
                </Bullet>
              );
            })}
            {coverageSummary && (
              <div style={{ marginTop: 5, fontSize: 10.5, color: MUTED }}>
                {[
                  coverageSummary.completedCount != null ? `${coverageSummary.completedCount} completed` : null,
                  coverageSummary.inaccessibleCount ? `${coverageSummary.inaccessibleCount} inaccessible` : null,
                  coverageSummary.skippedCount ? `${coverageSummary.skippedCount} skipped` : null,
                  coverageSummary.needsAttentionCount ? `${coverageSummary.needsAttentionCount} needing attention` : null,
                ].filter(Boolean).join(' · ')}
              </div>
            )}
            {data.serviceCoverage?.disclaimer && (
              <div style={{ marginTop: 4, fontSize: 9.5, color: MUTED }}>{data.serviceCoverage.disclaimer}</div>
            )}
          </div>
        )}

        {(tracedMapUrl || (schematicSrc && hasRenderableTreatment)) && (
          <div className="doc-keep">
            <SectionHeader>Where we treated</SectionHeader>
            <div className="doc-map-frame" style={{ border: `1px solid ${HAIR}`, borderRadius: 6, overflow: 'hidden' }}>
              {tracedMapUrl
                ? <img src={tracedMapUrl} alt="Technician-traced treatment map" onError={() => markImageFailed(tracedMapUrl)} style={{ display: 'block', width: '100%' }} />
                : <img src={schematicSrc} alt="Treatment map of the serviced areas" style={{ display: 'block', width: '100%' }} />}
            </div>
            {!tracedMapUrl && zoneLegend.length > 0 && (
              <div style={{ marginTop: 5, fontSize: 10.5, color: MUTED, lineHeight: 1.5 }}>
                {zoneLegend.map(({ letter, label }) => `${letter ? `${letter} — ` : ''}${label}`).join(' · ')}
              </div>
            )}
            {data.treatmentMap?.footer && (
              <div style={{ marginTop: 4, fontSize: 9.5, color: MUTED }}>{data.treatmentMap.footer}</div>
            )}
          </div>
        )}

        {/* Station / trap placement — pin geometry only, drawn on a neutral
            frame. The Google satellite image in the payload must NOT print
            (provider ToS); the online report carries the satellite view. */}
        {stationMap && (
          <div className="doc-keep">
            <SectionHeader>{stationMap.program === 'trapping' ? 'Trap placement' : 'Bait station placement'}</SectionHeader>
            <div style={{
              position: 'relative', width: '100%', aspectRatio: '32 / 17',
              background: '#F4F6F8', border: `1px solid ${HAIR}`, borderRadius: 6,
            }}>
              {stationMap.stations.map((station) => (
                <span
                  key={station.id || station.number}
                  className={`doc-station-pin ${stationStatusMeta(station.status, stationMap.program).cls}`.trim()}
                  style={{ left: `${(station.cx * 100).toFixed(2)}%`, top: `${(station.cy * 100).toFixed(2)}%` }}
                >{station.number}</span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6, fontSize: 9.5, color: MUTED }}>
              {['ok', 'serviced', 'activity', 'inaccessible', 'on_file']
                .map((status) => (status === 'on_file' ? STATION_ON_FILE_META : stationStatusMeta(status, stationMap.program)))
                .map(({ cls, label }) => (
                <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span className={`doc-station-pin ${cls}`} style={{ position: 'static', transform: 'none', width: 11, height: 11, fontSize: 0 }} aria-hidden="true" />
                  {label}
                </span>
              ))}
            </div>
            {stationMap.summary && (
              <div style={{ marginTop: 5, fontSize: 10.5, color: MUTED }}>
                {[
                  `${stationMap.summary.total} ${stationMap.program === 'trapping' ? 'traps' : 'stations'}`,
                  stationMap.summary.checked != null ? `${stationMap.summary.checked} checked` : null,
                  stationMap.summary.serviced ? `${stationMap.summary.serviced} serviced this visit` : null,
                  stationMap.summary.activity ? `${stationMap.summary.activity} ${STATION_ACTIVITY_SUMMARY[stationMap.program] || 'with activity'}` : null,
                  stationMap.summary.inaccessible ? `${stationMap.summary.inaccessible} inaccessible` : null,
                ].filter(Boolean).join(' · ')}
                {' '}· positions to scale — satellite view in your online report
              </div>
            )}
          </div>
        )}

        {/* Service photos — embedded (owner 2026-08-03, supersedes the
            portal-link-only call earlier the same day). */}
        {photos.length > 0 && (
          <div>
            <SectionHeader>Service photos</SectionHeader>
            {/* ONE consolidated, guarded summary — the V2 rule for photo copy. */}
            {(data.reportV2?.photoSummary || data.typedReport?.photoSummary) && (
              <p style={{ margin: '0 0 8px', fontSize: 11, lineHeight: 1.5, color: INK }}>
                {data.reportV2?.photoSummary || data.typedReport?.photoSummary}
              </p>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              {photos.map((photo) => (
                <figure key={photo.id || photo.url} className="doc-keep" style={{ margin: 0 }}>
                  {/* fixed-height contain thumbnails: a portrait field photo
                      at natural size ran taller than the page and split
                      across a break. Full resolution stays in the portal. */}
                  {photo.unavailable ? (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
                      width: '100%', height: 190, background: '#F7F8F9', borderRadius: 4,
                      border: `1px dashed ${LINE}`, color: MUTED, fontSize: 9.5, padding: 8, boxSizing: 'border-box',
                    }}>
                      Photo unavailable in this document — view it in your online report
                    </div>
                  ) : (
                  <img
                    src={photo.url}
                    /* alt must respect the same suppression as the visible
                       caption — otherwise the raw per-photo vision text the V2
                       path deliberately replaces is republished to screen
                       readers and the PDF accessibility layer (codex P1). */
                    alt={(!suppressPhotoCaption(photo) && photo.caption) || 'Service photo'}
                    onError={() => markImageFailed(photo.url)}
                    style={{ display: 'block', width: '100%', height: 190, objectFit: 'contain', background: '#F7F8F9', borderRadius: 4, border: `1px solid ${HAIR}` }}
                  />
                  )}
                  {!suppressPhotoCaption(photo) && (photo.caption || photo.stateBadge) && (
                    <figcaption style={{ fontSize: 9.5, color: MUTED, lineHeight: 1.45, marginTop: 3 }}>
                      {photo.caption || photo.stateBadge}
                    </figcaption>
                  )}
                </figure>
              ))}
            </div>
          </div>
        )}

        {visitHistory.length > 0 && (
          <div className="doc-keep">
            <SectionHeader>{data.typedVisitTimeline.label ? `${data.typedVisitTimeline.label} — visit history` : 'Visit history'}</SectionHeader>
            {visitHistory.map((visit) => (
              <Bullet key={visit.serviceRecordId || visit.serviceDate}>
                <strong>{fmtServiceDate(visit.serviceDate)}{visit.isCurrent ? ' (today)' : ''}:</strong>{' '}
                {visit.headline || visit.levelWord}
              </Bullet>
            ))}
          </div>
        )}

        {/* Combined-service companions — the second service on the same
            visit gets its own findings block (staff-only ones filtered out
            above, never printed). */}
        {companions.map((companion) => (
          <div key={companion.type} className="doc-keep">
            <SectionHeader>{companion.reportTypeLabel || companion.typeLabel || 'Additional service'}</SectionHeader>
            {companion.todaysResult?.headline && (
              <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>
                {String(companion.todaysResult.headline).replace(/\.$/, '')}.
                {companion.todaysResult.body ? ` ${companion.todaysResult.body}` : ''}
              </p>
            )}
            {/* Same containment rule TodaysResultCard uses: the snapshot
                builder usually folds nextStep into the body, so only print it
                when it adds something — but never drop the companion
                service's instruction entirely. */}
            {companion.todaysResult?.nextStep
              && !String(companion.todaysResult.body || '').includes(companion.todaysResult.nextStep) && (
              <p style={{ margin: '3px 0', fontSize: 11.5, lineHeight: 1.5, color: INK }}>
                {companion.todaysResult.nextStep}
              </p>
            )}
            {(companion.findings || [])
              .filter((finding) => String(finding?.customerValueLabel ?? finding?.value ?? '').trim())
              .map((finding) => (
                <Bullet key={finding.fieldKey || finding.customerLabel}>
                  <strong>{finding.customerLabel}:</strong> {finding.customerValueLabel || finding.value}
                </Bullet>
              ))}
            {companion.activity?.levelWord && (
              <Bullet><strong>{companion.activity.label}:</strong> {companion.activity.levelWord}</Bullet>
            )}
            {(companion.visitTimeline?.visits || [])
              .filter((visit) => visit && (visit.serviceDate || visit.headline))
              .map((visit) => (
                <Bullet key={visit.serviceRecordId || visit.serviceDate}>
                  <strong>{fmtServiceDate(visit.serviceDate)}{visit.isCurrent ? ' (today)' : ''}:</strong>{' '}
                  {visit.headline || visit.levelWord}
                </Bullet>
              ))}
          </div>
        ))}

        {/* Record footer */}
        <div className="doc-keep" style={{ borderTop: `1px solid ${LINE}`, marginTop: 18, paddingTop: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 10, color: MUTED, lineHeight: 1.6 }}>
            {/* No next-service line: stripLiveOnlyScheduleFields deletes
                nextAppointment (and reportV2.snapshot.nextVisit) from EVERY
                non-live render, precisely so a reschedule can't fossilize a
                stale appointment in a cached PDF. Rendering it here was dead
                code that only ever appeared in a direct component test. */}
            {isWaveGuard ? <>WaveGuard members receive free re-service when covered activity continues after the treatment window.<br /></> : null}
            Questions about today&apos;s service? Ask Waves in your online report or call {WAVES_SUPPORT_PHONE_DISPLAY}.
            <br />
            Full interactive report:{' '}
            {/* a real <a> so the PDF carries a link annotation — viewer URL
                autodetection is optional, and this is the only route to the
                analysis this record intentionally omits */}
            <a href={reportUrl} style={{ color: NAVY, textDecoration: 'underline' }}>{reportUrl}</a>
            <br />
            This report is provided for your records. This is not an invoice.
            {/* Claim tamper-evidence only when photos are actually displayed
                AND every displayed photo is in the chain — lawn turf photos
                are appended outside the service_photos chain, and a chain
                over only a hidden photo must not over-claim (the web
                report's guard; dropping half of it was a codex P1). */}
            {/* a photo that failed to load is shown as a placeholder, so its
                hash backs nothing the reader can see — the claim must fail. */}
            {data.photoChain?.valid === true && photos.length > 0
              && photos.every((photo) => photo?.hashSha256 && !photo.unavailable)
              /* moments + the gauge shot carry no hash, so displaying one
                 correctly defeats the claim rather than over-claiming */
              ? ' Photos hash-chained and tamper-evident.' : ''}
            <br />
            Waves Pest Control, LLC · Family-owned pest control and lawn care in Southwest Florida · Licensed &amp; insured · {WAVES_FL_LICENSE_LINE}
          </div>
        </div>

      </div>
    </div>
  );
}
