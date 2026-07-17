import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { adminFetch } from '../../lib/adminFetch';
import WdoIntelligenceBar from './WdoIntelligenceBar';
import WdoSignaturePad from './WdoSignaturePad';
import { applyProfileToWdoFindings, applyHistoryToWdoFindings } from '../../lib/wdoProfileToFindings';
import { computePretreatChemistry } from '../../lib/termitePretreatRates';
import ProjectFindingFieldInput, { hasCatalogBackedProjectFields } from './ProjectFindingFieldInput';
import DictationButton from './DictationButton';
import {
  useCustomerCards,
  chargeableCardOnFile,
  cardOnFileTitle,
  isCardExpired,
} from '../../hooks/useCustomerCards';

const ESTIMATE_BG = '#FFFFFF';
const ESTIMATE_BORDER = '#E4E4E7';
const ESTIMATE_INPUT_BORDER = '#D4D4D8';
const ESTIMATE_INPUT_BG = '#FFFFFF';
const ESTIMATE_TEXT = '#09090B';
const ESTIMATE_MUTED = '#71717A';
const ESTIMATE_BUTTON_BG = '#09090B';
const WDO_PROJECT_TYPE = 'wdo_inspection';
const PRE_TREATMENT_CERTIFICATE_TYPE = 'pre_treatment_termite_certificate';
const OFFICIAL_DOCUMENT_TYPES = new Set([WDO_PROJECT_TYPE, PRE_TREATMENT_CERTIFICATE_TYPE]);
const BANK_PAYMENT_METHOD_TYPES = new Set(['ach', 'us_bank_account', 'bank', 'bank_account']);
// project_photos.caption is varchar(200) — a longer description (typed or
// seeded by the prior-treatment extractor) fails the INSERT after the image
// is already in S3, so the queue clamps everywhere a caption enters.
const PHOTO_CAPTION_MAX = 200;
const ROBOTO_FONT = "'Roboto', Arial, sans-serif";

/**
 * CreateProjectModal — form for creating a Project (inspection or
 * documentation-heavy job). Mobile-first.
 *
 * Flow: pick type → pick customer → fill type-specific findings → optionally
 * attach photos → save as draft. Admin reviews + sends from the admin portal.
 *
 * Props:
 *   theme                      'dark' (default, tech portal) | 'light' (admin portal)
 *   onClose, onCreated         modal callbacks
 *   defaultCustomerId          pre-fill customer (e.g. from a scheduled service)
 *   defaultServiceRecordId     link back to the visit being documented
 *   defaultScheduledServiceId  link back to the scheduled visit
 *   allowAiDraft               admin-only report writer helper
 *
 * Audit focus:
 * - Photo upload pipeline: photos are attached client-side before save.
 *   Confirm "save as draft" only succeeds AFTER all photos are uploaded
 *   and registered against the project — silent photo failure here
 *   loses field data the tech can't easily re-capture.
 * - Submit while photos are uploading: the submit button must be
 *   disabled / queued until the upload promise(s) resolve, otherwise
 *   we save a project with broken photo references.
 * - Type-specific findings: each project type has its own field set.
 *   Confirm switching type mid-flow doesn't leak findings from the
 *   previous type into the saved payload.
 * - defaultServiceRecordId / defaultScheduledServiceId linking:
 *   verify these get persisted on the server side so the project can
 *   later be tied back to the originating visit.
 * - Theme prop: the dual dark/light theme uses a PALETTES dispatch.
 *   Confirm an unknown theme value falls back gracefully (don't crash
 *   on a typo).
 */

const PALETTES = {
  dark: {
    bg: '#0f1923', card: '#1e293b', border: '#334155',
    accent: '#0ea5e9', text: '#e2e8f0', muted: '#94a3b8',
    red: '#ef4444',
    accentText: '#fff',
    heading: '#e2e8f0',
    headingFont: "'Montserrat', sans-serif",
    bodyFont: "'Nunito Sans', sans-serif",
  },
  light: {
    bg: ESTIMATE_BG, card: '#FFFFFF', border: ESTIMATE_BORDER,
    accent: ESTIMATE_BUTTON_BG, text: ESTIMATE_TEXT, muted: ESTIMATE_MUTED,
    red: '#991B1B',
    accentText: '#fff',
    heading: ESTIMATE_TEXT,
    headingFont: "'Roboto', 'Inter', system-ui, sans-serif",
    bodyFont: "'Roboto', 'Inter', system-ui, sans-serif",
  },
};

function todayDateInput() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// A date input only accepts 'YYYY-MM-DD'. Schedule payloads have carried the
// visit date as either that string or a full ISO timestamp (a Postgres DATE
// serialized at UTC midnight) — a timestamp silently blanks the input and
// then saves the raw string. Take the date part positionally; never re-parse
// through `new Date`, which shifts the calendar day for ET viewers.
function dateInputValueFrom(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
}

function hasMeaningfulValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

const PRETREAT_APPLICATION_KEYS = [
  'treatment_method',
  'product_name',
  'epa_registration',
  'active_ingredient',
  'concentration_pct',
  'square_footage',
  'linear_feet',
  'trench_depth_ft',
  'gallons_applied',
];

function normalizeScheduledPretreatApplication(application = {}) {
  const normalized = { ...application };
  const chemistry = computePretreatChemistry({ productName: normalized.product_name });
  if (chemistry.status === 'ok' && !hasMeaningfulValue(normalized.concentration_pct)) {
    normalized.concentration_pct = chemistry.concentrationPct;
  }
  return normalized;
}

function hasPretreatApplicationContent(findings = {}) {
  if (PRETREAT_APPLICATION_KEYS.some((key) => hasMeaningfulValue(findings[key]))) return true;
  return Array.isArray(findings.additional_applications)
    && findings.additional_applications.some((row) => (
      row && PRETREAT_APPLICATION_KEYS.some((key) => hasMeaningfulValue(row[key]))
    ));
}

function formatCustomerAddress(customer) {
  if (!customer) return '';
  if (typeof customer.address === 'string') return customer.address.replace(/^,\s*/, '').trim();
  const address = customer.address && typeof customer.address === 'object' ? customer.address : null;
  const line1 = address?.line1 || customer.addressLine1 || customer.address_line1 || '';
  const city = address?.city || customer.city || '';
  const state = address?.state || customer.state || '';
  const zip = address?.zip || customer.zip || '';
  return [line1, [city, state].filter(Boolean).join(', '), zip]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Which finding field holds the service/treatment address for a project type.
// WDO inspections use `property_address` (handled by its own richer effect); the
// pre-treatment certificate uses a `treatment_address` autocomplete. Any future
// `type: 'address'` field is picked up automatically so the generic customer-
// address prefill stays type-agnostic.
function getProjectAddressFieldKey(fields) {
  if (!Array.isArray(fields)) return null;
  const match = fields.find((f) => f?.type === 'address' || f?.key === 'property_address');
  return match ? match.key : null;
}

// Loose address equality. The same address arrives punctuated differently by
// source: a customer search row carries the server `formatAddress` string
// ("123 Main St, Bradenton, FL 34205") while the estimates-summary refetch
// (used after a draft restore) is assembled client-side into "123 Main St
// Bradenton, FL 34205". Comparing on a case/punctuation/whitespace-normalized
// form lets the effect still recognize a customer-derived address it wrote.
function addressesMatch(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const na = norm(a);
  return na !== '' && na === norm(b);
}

function formatCustomerName(customer) {
  if (!customer) return '';
  const first = customer.firstName || customer.first_name || '';
  const last = customer.lastName || customer.last_name || '';
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name || customer.companyName || customer.company_name || '';
}

// "Jane Doe · (941) 555-0101 · jane@example.com" for the FDACS contact fields.
function formatCustomerContact(customer) {
  if (!customer) return '';
  return [
    formatCustomerName(customer),
    customer.phone || customer.phone_number || customer.mobile || '',
    customer.email || customer.email_address || '',
  ]
    .filter(Boolean)
    .join(' · ');
}

// Default structure list for the FDACS "Structures on Property Inspected" field.
function formatStructuresInspected(customer) {
  const type = String(customer?.property_type || customer?.propertyType || '').toLowerCase();
  if (type.includes('commercial') || type.includes('business')) return 'Commercial structure';
  if (type.includes('manufactured') || type.includes('mobile')) return 'Manufactured / mobile home';
  return 'Single-family residential structure';
}

// Construction type is only derivable from the customer record for
// manufactured/mobile homes (property_type says so, and it's a
// WDO_CONSTRUCTION_OPTIONS entry). CBS vs wood frame is never guessed here —
// that stays with the WDO Intelligence property lookup / the tech on site.
function formatStructureType(customer) {
  const type = String(customer?.property_type || customer?.propertyType || '').toLowerCase();
  if (type.includes('manufactured') || type.includes('mobile')) return 'Manufactured / Mobile Home';
  return '';
}

// The WDO fee seed for a schedule row — the inspection line's OWN net price,
// or nothing. estimatedPrice is the visit's final total: on a single-line
// visit that IS the inspection's net, but with billable add-ons it includes
// their dollars too, and the auto-invoice bills findings.inspection_fee as a
// single WDO line — a group total would fold add-on dollars into the fee
// (Codex P1 r2). The primary line's own net isn't on the schedule payloads
// (primaryLinePrice is the pre-discount base, and an appointment-level
// discount's allocation isn't visible client-side), so with billable add-ons
// we seed nothing and the tech enters the fee.
export function wdoFeeSeedFromVisit(service) {
  const addons = Array.isArray(service?.serviceAddons) ? service.serviceAddons : [];
  const hasBillableAddon = addons.some((a) => Number(a?.estimatedPrice ?? a?.basePrice ?? a?.price ?? 0) > 0);
  if (hasBillableAddon) return '';
  return service?.estimatedPrice ?? '';
}

function wdoFeeIsExplicitZero(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  return match != null && Number(match[1]) === 0;
}

// Populate the WDO contact/address fields from the selected customer. With
// overwrite=false (on selection) only blank fields are filled so typed values
// are preserved; the explicit "Fill from customer" button passes overwrite=true.
function applyCustomerToWdoFindings(prev, customer, overwrite = false) {
  const address = formatCustomerAddress(customer);
  const contact = formatCustomerContact(customer);
  const structures = formatStructuresInspected(customer);
  const structureType = formatStructureType(customer);
  const next = { ...prev };
  if (address && (overwrite || !hasMeaningfulValue(next.property_address))) next.property_address = address;
  if (contact && (overwrite || !hasMeaningfulValue(next.requested_by))) next.requested_by = contact;
  if (contact && (overwrite || !hasMeaningfulValue(next.report_sent_to))) next.report_sent_to = contact;
  if (structures && (overwrite || !hasMeaningfulValue(next.structures_inspected))) next.structures_inspected = structures;
  if (structureType && (overwrite || !hasMeaningfulValue(next.structure_type))) next.structure_type = structureType;
  return next;
}

// The exact field values applyCustomerToWdoFindings derives from a customer.
// Recorded when a customer is applied so a later customer switch can tell
// auto-filled values apart from hand-typed ones and clear only the former.
function customerWdoAutoFillValues(customer) {
  return {
    property_address: formatCustomerAddress(customer),
    requested_by: formatCustomerContact(customer),
    report_sent_to: formatCustomerContact(customer),
    structures_inspected: formatStructuresInspected(customer),
    structure_type: formatStructureType(customer),
  };
}

// Which customer-derived values did an apply ACTUALLY write? Only fields the
// apply changed count as auto-filled — a hand-typed value the blank-only
// apply preserved (even one that coincidentally matches the customer) must
// stay owned by the tech, or "Change" would clear it. After an explicit
// overwrite, any field holding the customer's value is customer-sourced.
function recordAppliedAutoFill(prev, next, customer, { overwrite = false } = {}) {
  const applied = {};
  for (const [key, value] of Object.entries(customerWdoAutoFillValues(customer))) {
    if (!hasMeaningfulValue(value) || next[key] !== value) continue;
    if (overwrite || prev[key] !== next[key]) applied[key] = value;
  }
  return applied;
}

function mergeSuggestionsIntoFindings(current, suggestions, overwrite = false) {
  const allowed = [
    'property_address',
    'structures_inspected',
    'structure_type',
    'inspection_scope',
    'previous_treatment_evidence',
    'previous_treatment_notes',
  ];
  const next = { ...current };
  for (const key of allowed) {
    const value = suggestions?.[key];
    if (!hasMeaningfulValue(value)) continue;
    if (overwrite || !hasMeaningfulValue(next[key])) next[key] = value;
  }
  return next;
}

export default function CreateProjectModal({
  onClose, onCreated,
  defaultCustomerId, defaultServiceRecordId, defaultScheduledServiceId,
  defaultCustomerLabel,
  defaultProjectDate,
  // The linked visit's NET price (estimated_price = final price after line
  // and appointment discounts) — seeds the WDO inspection-fee field
  // (blank-only) since the fee charged IS what the office booked the visit
  // at. Never the pre-discount primary_line_price: findings.inspection_fee
  // drives the WDO auto-invoice, so a base-price seed would un-discount it
  // (Codex P1 on this PR).
  defaultInspectionFee = '',
  defaultProjectType = '',
  allowedProjectTypes = null,
  allowAiDraft = false,
  // Invoice delivery + project close endpoints are admin-only. Dispatch sets
  // this true; the technician portal keeps the signed draft for office review
  // instead of exposing an action that would inevitably 403.
  allowInvoiceCompletion = false,
  theme = 'dark',
  // 'modal' = the floating ad-hoc dialog. 'sheet' = the Complete Service
  // frame (owner ask 2026-07-13): full-height edge-docked sheet, visit
  // context locked (no type/customer pickers, no title field) — the exact
  // same fields and save behavior, presented like the pest completion.
  presentation = 'modal',
  // Sheet-mode parity with the pest CompletionPanel's top-right Details
  // pill (owner ask 2026-07-13): opens the appointment detail sheet
  // (cancel / no-show / reschedule / rain-out / price edit) for the linked
  // visit. Caller-owned, rendered only when provided.
  onViewDetails = null,
}) {
  const P = PALETTES[theme] || PALETTES.dark;
  const isEstimateStyle = theme === 'light';
  const isSheet = presentation === 'sheet';
  // V2 zinc restricts admin type to weights 400/500; the tech-portal dark
  // theme keeps its heavier Montserrat-era weights.
  const wStrong = isEstimateStyle ? 500 : 800;
  const wMed = isEstimateStyle ? 500 : 700;
  const inputStyle = {
    width: '100%',
    background: isEstimateStyle ? ESTIMATE_INPUT_BG : P.bg,
    color: P.text,
    border: `1px solid ${isEstimateStyle ? ESTIMATE_INPUT_BORDER : P.border}`,
    borderRadius: isEstimateStyle ? 10 : 8,
    padding: isEstimateStyle ? '12px 14px' : '10px 12px',
    minHeight: isEstimateStyle ? 48 : undefined,
    fontSize: isEstimateStyle ? 15 : 14,
    fontWeight: isEstimateStyle ? 500 : undefined,
    boxSizing: 'border-box',
    fontFamily: P.bodyFont,
    outline: 'none',
  };
  const labelStyle = {
    display: 'block',
    fontSize: 12,
    fontWeight: wStrong,
    color: P.muted,
    textTransform: 'uppercase',
    letterSpacing: isEstimateStyle ? '0.12em' : 1,
    marginBottom: 8,
  };
  // Sectioned findings schemas (WDO, pre-treat cert) render an inline header
  // above the first field of each section — same scan-in-groups pattern as
  // the typed CompletionPanel's sectioned findings.
  const sectionHeaderStyle = {
    fontSize: 12,
    fontWeight: wStrong,
    letterSpacing: isEstimateStyle ? '0.12em' : 1,
    textTransform: 'uppercase',
    color: P.text,
    margin: '20px 0 10px',
    paddingBottom: 6,
    borderBottom: `1px solid ${P.border}`,
  };

  const [typesRegistry, setTypesRegistry] = useState(null);
  const [productCatalog, setProductCatalog] = useState([]);
  const [scheduledApplicationPrefill, setScheduledApplicationPrefill] = useState(null);
  const [projectType, setProjectType] = useState(defaultProjectType || '');
  const isOfficialDocument = OFFICIAL_DOCUMENT_TYPES.has(projectType);
  const [customerId, setCustomerId] = useState(defaultCustomerId || '');
  const { cards: customerCards } = useCustomerCards(customerId);
  const savedCardCandidate = chargeableCardOnFile(
    Array.isArray(customerCards)
      ? customerCards.filter((method) => !BANK_PAYMENT_METHOD_TYPES.has(
        String(method?.method_type || '').toLowerCase(),
      ))
      : customerCards,
  );
  // chargeableCardOnFile deliberately returns an expired fallback so read-only
  // card surfaces can label it. Completion is a mutation, so fail closed and
  // offer invoice delivery instead of attempting an expired payment method.
  const savedCard = savedCardCandidate && !isCardExpired(savedCardCandidate)
    ? savedCardCandidate
    : null;
  const savedCardLabel = savedCard
    ? `${cardOnFileTitle(savedCard).replace(/\s+\d{4}$/, '')} •••• ${savedCard.last_four}`
    : '';
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [customerLabel, setCustomerLabel] = useState(defaultCustomerLabel || '');
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  // Tracks the most recently requested prefill client so a slow, stale
  // latest-scheduled-service response can't clobber a newer selection.
  const prefillCustomerRef = useRef(null);
  const autoTitleRef = useRef('');
  // What was last auto-filled into the WDO findings from the selected
  // customer — on a customer change, values still matching this map are
  // cleared so the previous customer's address/contacts never carry over
  // onto the new customer's FDACS-13645 form.
  const wdoAutoFillRef = useRef(null);
  // For non-WDO types with a single address field (e.g. the pre-treatment
  // certificate's `treatment_address`): the last customer-derived address we
  // auto-filled, so a customer switch re-syncs it and un-picking clears it,
  // while a hand-typed/autocompleted address the tech chose is never clobbered.
  const projectAddressAutoFillRef = useRef({ key: null, value: '' });
  // Licensed-applicator picker for the pre-treatment certificate (any type
  // whose fields include applicator_name + applicator_fdacs_id).
  const [applicators, setApplicators] = useState([]);
  const [defaultApplicatorTechId, setDefaultApplicatorTechId] = useState(null);
  // The chemistry values this form last auto-calculated. A field is only
  // rewritten while blank or still holding what we wrote, so a hand-typed
  // concentration/gallons override always survives recalculation.
  const chemAutoFillRef = useRef({ concentration_pct: null, gallons_applied: null });
  // Exact application values seeded from the linked appointment. If the tech
  // changes customers, remove only values that still match our seed; anything
  // they edited is their field record and survives (without the old schedule tag).
  const scheduledApplicationAutoFillRef = useRef(null);
  const [projectDate, setProjectDate] = useState(
    dateInputValueFrom(defaultProjectDate)
    || (defaultServiceRecordId || defaultScheduledServiceId ? '' : todayDateInput())
  );
  const [title, setTitle] = useState('');
  const [serviceSearch, setServiceSearch] = useState('');
  const [serviceResults, setServiceResults] = useState([]);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [findings, setFindings] = useState({});
  const [recommendations, setRecommendations] = useState('');
  const [saving, setSaving] = useState(false);
  const [aiWriting, setAiWriting] = useState(false);
  const [aiUseComms, setAiUseComms] = useState(true);
  const [error, setError] = useState(null);
  const [createdProject, setCreatedProject] = useState(null);
  // One-page official-document completion: after a successful save, the sheet
  // stays open for the remaining delivery action instead of detouring to the
  // legacy project editor. WDO adds its canvas signature here; pre-treatment
  // already carries its typed applicator attestation in the saved certificate.
  // Shape: { project, requiresSignature, applicator, signature,
  //          reportHoldAvailable, billingReason, invoiceStatus, noCharge }.
  // onCreated/onClose are DEFERRED to finishSignStep so parents (which
  // unmount the modal from onCreated) don't tear the step down.
  const [signStep, setSignStep] = useState(null);
  const reportOnlyCompletion = Boolean(
    signStep?.noCharge
    || ['prepaid_covered', 'not_billable'].includes(signStep?.billingReason)
    // An existing invoice that already settled ('paid', or credit-covered
    // 'prepaid' — the same statuses the hold release treats as settled money)
    // has nothing left to collect: offer the send-report path instead of
    // charge/invoice actions that /send-with-invoice would 409.
    || (signStep?.billingReason === 'invoice_exists'
      && ['paid', 'prepaid'].includes(String(signStep?.invoiceStatus || '').toLowerCase())),
  );
  // True while the pad's signature POST/DELETE is in flight — every sign-step
  // exit holds until it settles, or the modal could unmount mid-mutation and
  // hand the parent stale signed/unsigned state (Codex P2).
  const [signBusy, setSignBusy] = useState(false);
  // Invoice-first official-document completion is two durable server actions:
  // deliver the invoice/arm the customer-side hold, then close the service.
  // Keep its own lock so no sign-step exit can unmount either request.
  const [completionBusy, setCompletionBusy] = useState(false);
  const [completionAction, setCompletionAction] = useState(null);

  // Previous-treatment photo extraction (WDO Section 3): AI reads a prior
  // company's treatment sticker/notice (or visible evidence) into the
  // previous-treatment fields. Seq + customer refs guard a slow extraction
  // against a mid-flight customer switch — like the intelligence bar, another
  // property's treatment details must never land on this FDACS filing.
  const [treatmentExtract, setTreatmentExtract] = useState({ status: 'idle', message: '' });
  const treatmentExtractSeqRef = useRef(0);
  const customerIdRef = useRef(customerId);
  customerIdRef.current = customerId;
  // Mirrors projectType for the same in-flight guard: switching the modal to
  // another project type clears the findings, and a late WDO extraction must
  // not write previous_treatment_* keys into the new type's report.
  const projectTypeRef = useRef(projectType);
  projectTypeRef.current = projectType;
  // Mirrors the WDO address context (typed property address, else the
  // customer's) the same way WdoIntelligenceBar keys its lookups on the
  // address: an extraction result must not land after the tech re-points
  // the report at a different property mid-request.
  const wdoAddressContext = String(findings.property_address || formatCustomerAddress(selectedCustomer) || '').trim();
  const wdoAddressRef = useRef(wdoAddressContext);
  wdoAddressRef.current = wdoAddressContext;
  // Invalidate the extraction the moment the report type changes — waiting
  // for the in-flight request to resolve would leave the switched-to type's
  // Save button stuck disabled at "Reading photo…" until the old request
  // returned (Codex r3 on #2748). The seq bump makes the eventual response a
  // silent no-op; a type round-trip back to WDO also invalidates, which is
  // right because the switch cleared the findings the result was meant for.
  // What the photo extraction actually WROTE into the Section-3 fields —
  // per field, the pre-extraction value and the value we left behind. Same
  // ownership rule as wdoAutoFillRef: on a customer switch, a field still
  // holding exactly what we wrote is restored to its pre-extraction value
  // (customer A's sticker details must never file on customer B's report);
  // a field the tech edited since is theirs and survives.
  const treatmentExtractAppliedRef = useRef(null);
  useEffect(() => {
    treatmentExtractSeqRef.current += 1;
    treatmentExtractAppliedRef.current = null;
    setTreatmentExtract({ status: 'idle', message: '' });
    // Queued prior-treatment evidence photos are WDO-specific: handleSave
    // uploads the whole queue to whatever project it creates, so leaving
    // them behind would attach a treatment-sticker image to the switched-to
    // non-WDO report. Same purge the customer-change path already does.
    setPhotoQueue(prev => prev.filter(p => p.category !== 'previous_treatment'));
  }, [projectType]);

  // Photo buffer — queued locally, uploaded after project is created.
  const [photoQueue, setPhotoQueue] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0 });

  // --- Draft auto-save (localStorage) ---
  // Mirrors the completion-form draft pattern: debounced save of the typed
  // fields so a half-written report survives navigating away. Photos are File
  // objects and can't be serialized, so they're not part of the draft.
  // Scope unscheduled drafts by the modal's allowed types so a general-project
  // draft can't bleed into a restricted (e.g. WDO-only) create flow.
  const allowedTypesScope = allowedProjectTypes && allowedProjectTypes.length
    ? allowedProjectTypes.slice().sort().join('-')
    : 'all';
  const draftScope = defaultScheduledServiceId
    ? `sched_${defaultScheduledServiceId}`
    : defaultServiceRecordId
      ? `rec_${defaultServiceRecordId}`
      : `new_${allowedTypesScope}`;
  const draftKey = `waves_project_draft_${draftScope}`;
  const draftReadyRef = useRef(false);
  const [savedDraft, setSavedDraft] = useState(null);
  const [showDraftPrompt, setShowDraftPrompt] = useState(false);

  // Load any saved draft on open and offer to restore it.
  useEffect(() => {
    draftReadyRef.current = false;
    setSavedDraft(null);
    setShowDraftPrompt(false);
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft && typeof draft === 'object') {
          setSavedDraft(draft);
          setShowDraftPrompt(true);
        }
      }
    } catch {
      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
    } finally {
      draftReadyRef.current = true;
    }
  }, [draftKey]);

  // Debounced auto-save of the typed fields. Held off while the restore
  // prompt is showing so we don't clobber the saved draft before the tech
  // chooses, and skipped entirely when the form is still empty.
  // draftFlushRef mirrors the CURRENT eligible payload so the unmount flush
  // below can write it synchronously — the Details handoff (and any other
  // unmount) inside the 700ms window was silently dropping the last edits
  // (Codex P2 on #2717).
  const draftFlushRef = useRef(null);
  // True only after the tech actually contributed content: typing anywhere
  // in the body (container onInput), an AI fill/append, a library pick, or
  // restoring a saved draft. Autofill EFFECTS (type defaults → title/
  // findings, customer autofill) deliberately do not set it — counting
  // effect output as content re-armed the flush on untouched sheets and
  // rewrote just-discarded drafts (Codex r12 P2).
  const userDirtyRef = useRef(false);
  useEffect(() => {
    // Stop once the project exists on the server — the server draft is then
    // the source of truth and a local draft would risk a duplicate on restore.
    if (!draftReadyRef.current || showDraftPrompt || createdProject) {
      draftFlushRef.current = null;
      return;
    }
    // Prefill alone must NOT arm a draft write (house review on #2717):
    // sheet mode always seeds projectType/customerId from props, and a
    // defaults-only draft made the unmount flush rewrite what the tech had
    // just discarded — a deterministic discard → close → restore-prompt
    // loop. Only content the tech actually entered counts.
    const hasContent = Boolean(
      (title && title.trim())
      || (recommendations && recommendations.trim())
      || Object.values(findings).some((v) => String(v || '').trim())
      || (projectType && projectType !== (defaultProjectType || ''))
      || (customerId && String(customerId) !== String(defaultCustomerId || '')),
    );
    if (!hasContent || !userDirtyRef.current) {
      draftFlushRef.current = null;
      return;
    }
    const payload = {
      savedAt: new Date().toISOString(),
      projectType, customerId, customerLabel, projectDate, title, findings, recommendations,
    };
    draftFlushRef.current = { key: draftKey, payload };
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify(payload));
      } catch { /* quota / serialization — non-blocking */ }
    }, 700);
    return () => clearTimeout(timer);
  }, [draftKey, showDraftPrompt, createdProject, projectType, customerId, customerLabel, projectDate, title, findings, recommendations, defaultProjectType, defaultCustomerId]);

  // Unmount-only flush of a pending draft write. The debounce cleanup above
  // cancels the timer on EVERY dep change, which is correct while mounted —
  // but on unmount the cancelled write must still land or the newest
  // keystrokes vanish. The ref is nulled whenever a write would be
  // ineligible (empty form, restore prompt showing, project created), so
  // this can never resurrect a cleared draft.
  useEffect(() => () => {
    const pending = draftFlushRef.current;
    if (!pending) return;
    try {
      localStorage.setItem(pending.key, JSON.stringify(pending.payload));
    } catch { /* quota / serialization — non-blocking */ }
  }, []);

  function restoreDraft() {
    const d = savedDraft;
    if (!d) return;
    // Restored content is user content — keep the draft armed so further
    // edits stay protected.
    userDirtyRef.current = true;
    // Only restore the type (and its findings) if it's permitted in this modal;
    // findings are type-specific, so drop them when the type isn't restored.
    const typeAllowed = d.projectType && (!allowedProjectTypes || allowedProjectTypes.includes(d.projectType));
    if (typeAllowed) {
      setProjectType(d.projectType);
      setFindings(d.findings && typeof d.findings === 'object' ? d.findings : {});
    }
    if (d.customerId) setCustomerId(d.customerId);
    if (d.customerLabel) setCustomerLabel(d.customerLabel);
    if (d.projectDate) setProjectDate(d.projectDate);
    setTitle(d.title || '');
    setRecommendations(d.recommendations || '');
    setShowDraftPrompt(false);
  }

  function discardDraft() {
    try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
    setSavedDraft(null);
    setShowDraftPrompt(false);
  }

  useEffect(() => {
    adminFetch('/admin/projects/types')
      .then(r => r.json())
      .then(d => setTypesRegistry(d.types))
      .catch(() => setError('Could not load project types'));
  }, []);

  useEffect(() => {
    if (!customerId) {
      setSelectedCustomer(null);
      return;
    }
    if (selectedCustomer?.id === customerId) return;
    let cancelled = false;
    adminFetch(`/admin/customers/${customerId}/estimates-summary`)
      .then(r => r.json())
      .then(d => {
        if (!cancelled && d.customer) setSelectedCustomer(d.customer);
      })
      .catch(() => { /* non-blocking: search result may already have enough */ });
    return () => { cancelled = true; };
  }, [customerId, selectedCustomer?.id]);

  // Debounced customer search
  useEffect(() => {
    if (!customerQuery || customerQuery.length < 2) { setCustomerResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await adminFetch(`/admin/customers?search=${encodeURIComponent(customerQuery)}&limit=8`);
        const d = await r.json();
        const list = (d.customers || d || []).slice(0, 8);
        setCustomerResults(list);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [customerQuery]);

  // Debounced Service Library search for the report title. This mirrors the
  // appointment booking service picker so report names can match real services.
  useEffect(() => {
    const q = serviceSearch.trim();
    if (q.length < 2) { setServiceResults([]); setServiceLoading(false); return; }
    setServiceLoading(true);
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        params.set('search', q);
        params.set('is_active', 'true');
        params.set('limit', '10');
        const r = await adminFetch(`/admin/projects/service-search?${params}`);
        const d = await r.json();
        const list = (d.services || []).slice(0, 10);
        setServiceResults(list);
      } catch {
        setServiceResults([]);
      } finally {
        setServiceLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [serviceSearch]);

  const typeCfg = typesRegistry && projectType ? typesRegistry[projectType] : null;
  const addressFieldKey = getProjectAddressFieldKey(typeCfg?.findingsFields);
  const typeFieldKeys = useMemo(
    () => new Set((typeCfg?.findingsFields || []).map((f) => f.key)),
    [typeCfg],
  );
  const hasApplicatorFields = typeFieldKeys.has('applicator_name') && typeFieldKeys.has('applicator_fdacs_id');
  // Picker options carry the technician id as the value so two techs who
  // share a display name stay distinct picks (the label gets the license #
  // appended only in that duplicate case, so the human can tell them apart).
  const applicatorOptions = useMemo(() => {
    const nameCounts = new Map();
    applicators.forEach((a) => nameCounts.set(a.name, (nameCounts.get(a.name) || 0) + 1));
    return applicators.map((a) => ({
      value: a.id,
      label: nameCounts.get(a.name) > 1 ? `${a.name} (${a.fdacsId || 'no license # on file'})` : a.name,
    }));
  }, [applicators]);
  // The stored findings are the printed name + FDACS ID pair, so the select's
  // current value is recovered by matching that pair back to a technician.
  // Drafts saved before the printed-name column carry the tech's old display
  // name — legacyName keeps them matched (an unmatched pair — restored
  // free-text draft or hand-edited ID — falls back to showing the raw name).
  const selectedApplicator = useMemo(() => {
    const storedName = String(findings.applicator_name || '').trim();
    const storedId = String(findings.applicator_fdacs_id || '').trim();
    return applicators.find((a) => (
      (a.name === storedName || (a.legacyName && a.legacyName === storedName))
      && String(a.fdacsId || '') === storedId
    )) || null;
  }, [applicators, findings.applicator_name, findings.applicator_fdacs_id]);
  // Upgrade a stored legacy display name to the printed name once the list
  // loads, so a draft saved as "Adam" re-sends as "Adam Benetti" instead of
  // silently keeping the casual name on a compliance certificate.
  useEffect(() => {
    if (!applicators.length) return;
    setFindings(prev => {
      const storedName = String(prev.applicator_name || '').trim();
      if (!storedName) return prev;
      const match = applicators.find((a) => (
        a.legacyName && a.legacyName === storedName && a.name !== storedName
        && String(a.fdacsId || '') === String(prev.applicator_fdacs_id || '').trim()
      ));
      if (!match) return prev;
      return { ...prev, applicator_name: match.name };
    });
  }, [applicators]);
  const hasChemistryFields = typeFieldKeys.has('product_name')
    && typeFieldKeys.has('concentration_pct')
    && typeFieldKeys.has('gallons_applied');
  // Pure function of the treatment inputs — recomputed on every keystroke so
  // the sync effect below and the inline hints always agree.
  const chemAuto = useMemo(() => (
    hasChemistryFields
      ? computePretreatChemistry({
        productName: findings.product_name,
        squareFootage: findings.square_footage,
        linearFeet: findings.linear_feet,
        trenchDepthFt: findings.trench_depth_ft,
      })
      : null
  ), [hasChemistryFields, findings.product_name, findings.square_footage, findings.linear_feet, findings.trench_depth_ft]);
  // appointmentManaged types complete through the standard appointment flow
  // now — they're not creatable as projects (server 422s them too).
  // linkedCreationOnly types (WDO, pre-treat cert — owner ruling 2026-07-13)
  // create only from their scheduled visit, so the AD-HOC picker hides them
  // — but a visit-linked open (defaultScheduledServiceId set) IS the allowed
  // door, and a legacy visit's profile may resolve no pointer to build an
  // explicit allowedProjectTypes from (Codex r3): keep the compliance types
  // selectable whenever a linked visit is present; the server still rejects
  // a mismatched visit (project_type_link_mismatch). An explicit
  // allowedProjectTypes prop (the special-project dispatch path) still wins.
  const linkedVisitContext = !!defaultScheduledServiceId;
  const visibleTypes = typesRegistry
    ? Object.entries(typesRegistry).filter(([key, cfg]) => (
      allowedProjectTypes
        ? allowedProjectTypes.includes(key)
        : !cfg?.appointmentManaged && (!cfg?.linkedCreationOnly || linkedVisitContext)
    ))
    : [];

  useEffect(() => {
    if (!typeCfg?.findingsFields || !hasCatalogBackedProjectFields(typeCfg.findingsFields) || productCatalog.length) return;
    adminFetch('/admin/dispatch/products/catalog')
      .then(r => r.json())
      .then(d => setProductCatalog(d.products || []))
      .catch(() => { /* product search can still accept free text */ });
  }, [typeCfg, productCatalog.length]);

  useEffect(() => {
    const linkedCustomerIsActive = projectType === PRE_TREATMENT_CERTIFICATE_TYPE
      && defaultScheduledServiceId
      && defaultCustomerId
      && String(customerId) === String(defaultCustomerId);
    if (linkedCustomerIsActive) return;
    setScheduledApplicationPrefill(null);
    const applied = scheduledApplicationAutoFillRef.current;
    if (!applied) return;
    scheduledApplicationAutoFillRef.current = null;
    setFindings((previous) => {
      const next = { ...previous };
      Object.entries(applied.primary).forEach(([key, value]) => {
        if (next[key] === value) delete next[key];
      });
      const currentAdditional = Array.isArray(next.additional_applications)
        ? next.additional_applications
        : [];
      if (JSON.stringify(currentAdditional) === JSON.stringify(applied.additional)) {
        delete next.additional_applications;
      } else if (currentAdditional.length) {
        next.additional_applications = currentAdditional.map((row) => {
          if (!row || typeof row !== 'object') return row;
          const { _scheduled_service_label: _scheduleLabel, ...fieldValues } = row;
          return fieldValues;
        });
      }
      return next;
    });
  }, [projectType, customerId, defaultCustomerId, defaultScheduledServiceId]);

  useEffect(() => {
    setScheduledApplicationPrefill(null);
    if (projectType !== PRE_TREATMENT_CERTIFICATE_TYPE
      || !defaultScheduledServiceId
      || !defaultCustomerId
      || String(customerId) !== String(defaultCustomerId)
      || showDraftPrompt) return undefined;
    // A saved field draft owns these values. Wait for Restore/Discard rather
    // than racing a schedule prefill into the same application fields.
    try {
      if (localStorage.getItem(draftKey)) return undefined;
    } catch { /* localStorage unavailable — continue with server prefill */ }

    let cancelled = false;
    adminFetch(`/admin/projects/scheduled-service/${defaultScheduledServiceId}/application-prefill`)
      .then((response) => response.json().then((body) => ({ response, body })))
      .then(({ response, body }) => {
        if (cancelled || !response.ok) return;
        const applications = Array.isArray(body.applications)
          ? body.applications.map(normalizeScheduledPretreatApplication)
          : [];
        if (!applications.length) return;
        setFindings((previous) => {
          if (hasPretreatApplicationContent(previous)) return previous;
          const [primary, ...additional] = applications;
          const primaryFields = Object.fromEntries(
            PRETREAT_APPLICATION_KEYS
              .filter((key) => primary[key] !== undefined)
              .map((key) => [key, primary[key]]),
          );
          scheduledApplicationAutoFillRef.current = { primary: primaryFields, additional };
          return {
            ...previous,
            ...primaryFields,
            additional_applications: additional,
          };
        });
        setScheduledApplicationPrefill({ count: applications.length });
      })
      .catch(() => { /* optional convenience — manual fields remain available */ });
    return () => { cancelled = true; };
  }, [projectType, customerId, defaultCustomerId, defaultScheduledServiceId, showDraftPrompt, draftKey]);

  useEffect(() => {
    if (!typeCfg?.findingsFields?.length) return;
    setFindings(prev => {
      const next = { ...prev };
      let changed = false;
      typeCfg.findingsFields.forEach((field) => {
        if (!hasMeaningfulValue(field.defaultValue) || hasMeaningfulValue(next[field.key])) return;
        next[field.key] = field.defaultValue;
        changed = true;
      });
      return changed ? next : prev;
    });
  }, [typeCfg]);

  useEffect(() => {
    const defaultTitle = hasMeaningfulValue(typeCfg?.defaultTitle) ? typeCfg.defaultTitle : '';
    setTitle(prev => {
      if (defaultTitle) {
        if (!hasMeaningfulValue(prev) || prev === autoTitleRef.current) {
          autoTitleRef.current = defaultTitle;
          return defaultTitle;
        }
        return prev;
      }
      if (autoTitleRef.current && prev === autoTitleRef.current) {
        autoTitleRef.current = '';
        return '';
      }
      autoTitleRef.current = '';
      return prev;
    });
  }, [typeCfg?.defaultTitle]);

  useEffect(() => {
    if (projectType !== 'wdo_inspection') return;
    if (!selectedCustomer) return;
    // Seamlessly fill address + requested-by + report-sent-to from the picked
    // customer, without clobbering anything the tech already typed. Record
    // only what the apply actually changed (recordAppliedAutoFill) so a
    // preserved hand-typed value is never tagged auto-filled. The updater
    // stays idempotent, so a StrictMode double invocation is harmless.
    setFindings(prev => {
      const next = applyCustomerToWdoFindings(prev, selectedCustomer, false);
      wdoAutoFillRef.current = recordAppliedAutoFill(prev, next, selectedCustomer);
      return next;
    });
  }, [projectType, selectedCustomer]);

  // Seed the WDO inspection fee from the linked visit's quoted price.
  // Blank-only, like the customer autofill above: a hand-typed fee or a
  // restored draft always wins, and (per the #2717 rule) an autofill effect
  // never arms the draft writer.
  useEffect(() => {
    if (projectType !== 'wdo_inspection') return;
    // '' means "no price known" — seed nothing. A numeric 0 is different: an
    // explicitly $0-booked visit seeds "0", which the server reads as
    // no-charge (send-with-invoice refuses to bill it; the report sends by
    // itself) instead of falling through to the $250 blank-fee default.
    if (defaultInspectionFee === '' || defaultInspectionFee == null) return;
    const fee = Number(defaultInspectionFee);
    if (!Number.isFinite(fee) || fee < 0) return;
    const feeStr = Number.isInteger(fee) ? String(fee) : fee.toFixed(2);
    setFindings(prev => (hasMeaningfulValue(prev.inspection_fee) ? prev : { ...prev, inspection_fee: feeStr }));
  }, [projectType, defaultInspectionFee]);

  // Prefill the address field from the selected customer for every OTHER project
  // type that has one (the pre-treatment certificate's `treatment_address`, and
  // any future `type: 'address'` field). WDO keeps its dedicated multi-field
  // effect above. Blank-fills, re-syncs when the customer changes, and clears on
  // un-pick — but only ever touches the value it auto-filled, so an address the
  // tech typed or picked from the autocomplete is preserved.
  useEffect(() => {
    if (projectType === 'wdo_inspection' || !addressFieldKey) return;
    const address = formatCustomerAddress(selectedCustomer);
    setFindings(prev => {
      const current = prev[addressFieldKey] || '';
      const auto = projectAddressAutoFillRef.current;
      // A field already holding the selected customer's address counts as
      // auto-filled even if the ref was reset (e.g. a restored draft, whose
      // findings repopulate but leave the ref empty) — so re-adopt it and keep
      // it in sync on a later customer switch. A hand-entered pre-construction
      // lot address that DIFFERS from the customer's is left tech-owned.
      const isAutoFilled = (auto.key === addressFieldKey && addressesMatch(current, auto.value))
        || addressesMatch(current, address);
      if (hasMeaningfulValue(current) && !isAutoFilled) return prev;
      if (!address) {
        // Customer un-picked: drop only what we auto-filled.
        if (!isAutoFilled) return prev;
        projectAddressAutoFillRef.current = { key: null, value: '' };
        return { ...prev, [addressFieldKey]: '' };
      }
      // Re-establish the marker whenever the field matches the customer (covers
      // the restored-draft case, where the saved value may be punctuated
      // differently) so a subsequent switch re-syncs or clears it. Leave a
      // loosely-matching value in place — no need to rewrite just punctuation.
      projectAddressAutoFillRef.current = { key: addressFieldKey, value: address };
      if (addressesMatch(current, address)) return prev;
      return { ...prev, [addressFieldKey]: address };
    });
  }, [projectType, selectedCustomer, addressFieldKey]);

  // Load the licensed-applicator list once a type with applicator fields is
  // picked. The tech timetracking endpoints sanitize license numbers away,
  // so the certificate form has its own projects-scoped source.
  useEffect(() => {
    if (!hasApplicatorFields || applicators.length) return;
    adminFetch('/admin/projects/applicators')
      .then((r) => r.json())
      .then((d) => {
        setApplicators(Array.isArray(d.applicators) ? d.applicators : []);
        setDefaultApplicatorTechId(d.defaultTechnicianId || null);
      })
      .catch(() => { /* applicator fields still accept free text */ });
  }, [hasApplicatorFields, applicators.length]);

  // Default the applicator to the logged-in tech (the server sends
  // defaultTechnicianId only for a tech's own session, not admins). Fills
  // only while BOTH fields are untouched, so a restored draft or a picked
  // applicator is never overridden.
  useEffect(() => {
    if (!hasApplicatorFields || !applicators.length || !defaultApplicatorTechId) return;
    const me = applicators.find((a) => a.id === defaultApplicatorTechId);
    if (!me) return;
    setFindings(prev => {
      if (hasMeaningfulValue(prev.applicator_name) || hasMeaningfulValue(prev.applicator_fdacs_id)) return prev;
      return {
        ...prev,
        applicator_name: me.name,
        ...(me.fdacsId ? { applicator_fdacs_id: me.fdacsId } : {}),
      };
    });
  }, [hasApplicatorFields, applicators, defaultApplicatorTechId]);

  // Keep concentration_pct / gallons_applied in sync with the label-rate
  // calculation. Ownership rule: a field is written only while blank, still
  // holding our last auto-value, or already equal to the new computation (a
  // restored draft re-adopts) — a hand-typed labeled rate survives. Two
  // exceptions on product change: a KNOWN bait/wood product force-clears
  // both fields even over a hand-typed value (no finished-solution chemistry
  // exists, so anything here would print wrong on the certificate), while an
  // unrecognized product name only reclaims values the form itself wrote (a
  // free-text product's hand-entered chemistry is the tech's to keep).
  useEffect(() => {
    if (!chemAuto) return;
    setFindings(prev => {
      const auto = chemAutoFillRef.current;
      const next = { ...prev };
      let changed = false;
      const ownsField = (key, newValue) => {
        const current = String(prev[key] || '').trim();
        return current === ''
          || current === String(auto[key] ?? '')
          || (newValue != null && current === String(newValue));
      };
      const writeField = (key, value, { force = false } = {}) => {
        if (!force && !ownsField(key, value)) return;
        auto[key] = value || null;
        if (String(prev[key] || '') !== value) {
          next[key] = value;
          changed = true;
        }
      };
      if (chemAuto.status === 'ok') {
        writeField('concentration_pct', chemAuto.concentrationPct);
        writeField('gallons_applied', chemAuto.gallonsText || '');
      } else if (chemAuto.status === 'not_applicable') {
        writeField('concentration_pct', '', { force: true });
        writeField('gallons_applied', '', { force: true });
      } else {
        writeField('concentration_pct', '');
        writeField('gallons_applied', '');
      }
      return changed ? next : prev;
    });
    // The two output fields are deliberately in the deps: clearing an
    // auto-filled value re-runs the effect, which owns the now-blank field
    // and refills it (the effect converges — a re-run after its own write
    // changes nothing).
  }, [chemAuto, findings.concentration_pct, findings.gallons_applied]);

  function handleFindingChange(key, value) {
    // Every field control routes here — including chips, steppers, and
    // selects, which don't bubble an input event to the container
    // listener (Codex r13 P2).
    userDirtyRef.current = true;
    setFindings(prev => ({ ...prev, [key]: value }));
  }

  function handleApplicatorChange(value) {
    userDirtyRef.current = true;
    // Option values are technician ids. No match means the injected
    // current-value option (a restored draft's free-text name) — keep it as
    // the name and leave the ID alone.
    const match = applicators.find((a) => String(a.id) === String(value));
    setFindings(prev => ({
      ...prev,
      applicator_name: match ? match.name : value,
      // The FDACS ID prints beside the name on the certificate — re-bind it
      // on every pick (blank when none is on file) so a previous applicator's
      // number can never carry over to the new name.
      ...(match ? { applicator_fdacs_id: match.fdacsId || '' } : {}),
    }));
  }

  function handleProductSelect(fieldKey, product) {
    userDirtyRef.current = true;
    const productName = product?.name || product?.product_name || '';
    const epaRegistration = product?.epa_reg_number || product?.epaRegNumber || '';
    const activeIngredient = product?.active_ingredient || product?.activeIngredient || '';
    const hasEpaField = typeCfg?.findingsFields?.some(field => field.key === 'epa_registration');
    const hasActiveIngredientField = typeCfg?.findingsFields?.some(field => field.key === 'active_ingredient');
    setFindings(prev => ({
      ...prev,
      [fieldKey]: productName || prev[fieldKey] || '',
      ...(hasEpaField && epaRegistration ? { epa_registration: epaRegistration } : {}),
      ...(hasActiveIngredientField && activeIngredient ? { active_ingredient: activeIngredient } : {}),
    }));
  }

  function fillWdoAddressFromCustomer() {
    if (!selectedCustomer) return;
    userDirtyRef.current = true;
    // Explicit action — overwrite address + contact fields from the customer.
    // After an explicit replace, every field holding the customer's value IS
    // customer-sourced, so record them all for the Change-clears map.
    setFindings(prev => {
      const next = applyCustomerToWdoFindings(prev, selectedCustomer, true);
      wdoAutoFillRef.current = recordAppliedAutoFill(prev, next, selectedCustomer, { overwrite: true });
      return next;
    });
  }

  // Explicit "Fill from customer" for a non-WDO address field — overwrites and
  // marks the value as auto-filled so a later customer switch still re-syncs it.
  function fillAddressFromCustomer() {
    if (!addressFieldKey) return;
    const address = formatCustomerAddress(selectedCustomer);
    if (!address) return;
    userDirtyRef.current = true;
    projectAddressAutoFillRef.current = { key: addressFieldKey, value: address };
    setFindings(prev => ({ ...prev, [addressFieldKey]: address }));
  }

  // Called when the tech un-picks the customer ("Change"): drop the WDO fields
  // that still hold the previous customer's auto-filled values, keeping
  // anything hand-typed that differs, so re-selecting blank-fills from the new
  // customer instead of keeping the old property's address/contacts.
  function clearWdoFindingsFromCustomer() {
    const lastApplied = wdoAutoFillRef.current;
    wdoAutoFillRef.current = null;
    // The intelligence bar remounts on customer change, hiding its
    // selected-photo chip — but a queued prior-treatment evidence photo
    // (category 'previous_treatment') would still upload on save. It shows
    // the PREVIOUS customer's property; never carry it to the next one.
    setPhotoQueue(prev => prev.filter(p => p.category !== 'previous_treatment'));
    // Same reasoning for the field-level photo extraction: invalidate any
    // in-flight request and clear its status line.
    treatmentExtractSeqRef.current += 1;
    setTreatmentExtract({ status: 'idle', message: '' });
    // And unwind what a COMPLETED extraction wrote: the Section-3 values came
    // from the previous customer's photo, so any field still holding exactly
    // what the extraction left is restored to its pre-extraction value —
    // another property's sticker details must never file on the next
    // customer's FDACS report. A field the tech edited since stays theirs.
    const extractApplied = treatmentExtractAppliedRef.current;
    treatmentExtractAppliedRef.current = null;
    if (extractApplied) {
      setFindings(prev => {
        const next = { ...prev };
        if (extractApplied.notes && (prev.previous_treatment_notes || '') === extractApplied.notes.after) {
          next.previous_treatment_notes = extractApplied.notes.before;
        }
        if (extractApplied.evidence && (prev.previous_treatment_evidence || '') === extractApplied.evidence.after) {
          next.previous_treatment_evidence = extractApplied.evidence.before;
        }
        return next;
      });
    }
    if (!lastApplied) return;
    setFindings(prev => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(lastApplied)) {
        if (hasMeaningfulValue(value) && next[key] === value) next[key] = '';
      }
      return next;
    });
  }

  function applyWdoSuggestions(suggestions, options = {}) {
    userDirtyRef.current = true;
    setFindings(prev => mergeSuggestionsIntoFindings(prev, suggestions, options.overwrite));
  }

  function applyWdoProfile(profile) {
    userDirtyRef.current = true;
    setFindings(prev => applyProfileToWdoFindings(prev, profile, { overwrite: true }));
  }

  function applyWdoHistory(history) {
    userDirtyRef.current = true;
    setFindings(prev => applyHistoryToWdoFindings(prev, history, { overwrite: true }));
  }

  async function handleAiDraft() {
    if (!projectType) return setError('Pick a project type first');
    const hasFindings = Object.values(findings).some(v => String(v || '').trim());
    if (!hasFindings && !recommendations.trim()) return setError('Add at least one finding or quick note before drafting');
    if (recommendations.trim() && recommendations.includes('WHAT WE INSPECTED') && !confirm('Replace the current AI draft?')) return;
    setAiWriting(true);
    setError(null);
    try {
      const d = await adminFetch('/admin/projects/ai-write-preview', {
        method: 'POST',
        body: {
          customer_id: customerId || null,
          project_type: projectType,
          project_date: projectDate || null,
          findings,
          recommendations,
          include_communications: aiUseComms,
        },
      });
      const data = await d.json();
      if (!d.ok) throw new Error(data?.error || 'AI draft failed');
      if (data.report) {
        userDirtyRef.current = true;
        setRecommendations(data.report.trim());
      }
    } catch (e) {
      setError(e.message || 'AI draft failed');
    } finally {
      setAiWriting(false);
    }
  }

  // When a tech looks up and picks a client, pull their most recent scheduled
  // service and pre-fill the report's service title + date so they don't
  // re-type what's already on the schedule. Title only fills when still blank
  // (don't clobber something the tech typed); the date follows the matched
  // visit since the form otherwise defaults to today.
  async function prefillFromScheduledService(custId) {
    if (!custId) return;
    prefillCustomerRef.current = custId;
    try {
      const r = await adminFetch(`/admin/customers/${custId}/latest-scheduled-service`);
      const d = await r.json();
      // Ignore a stale response: if the tech has since picked a different
      // client, don't overwrite the now-active client's title/date.
      if (prefillCustomerRef.current !== custId) return;
      const svc = d?.service;
      if (!svc) return;
      if (svc.serviceType) setTitle(prev => (prev && prev.trim()) ? prev : svc.serviceType);
      const svcDate = dateInputValueFrom(svc.scheduledDate);
      if (svcDate) setProjectDate(svcDate);
    } catch { /* non-blocking: tech can still fill these in manually */ }
  }

  function queuePhoto(file, category) {
    setPhotoQueue(prev => [...prev, { file, category, caption: '', id: `q_${Date.now()}_${prev.length}` }]);
  }

  // "Extract from photo" on the Previous Treatment observations field: send
  // the photo to AI transcription and write the result into the Section-3
  // fields. The photo also joins the upload queue as prior-treatment evidence
  // (same category the intelligence bar uses), so it attaches to the report
  // on save regardless of how the extraction goes.
  // Stale-response check shared by the success and error paths below. A
  // superseded request (newer extraction owns the state) just drops out; a
  // context switch (customer, project type, or property address changed
  // mid-flight) additionally clears the pending state — leaving it at
  // 'working' would wedge the Save gate shut on the new context — and drops
  // the request's own queued evidence photo: the first-customer-selection
  // and address-edit paths have no queue purge of their own (unlike the
  // Change / type-switch paths), so a stale sticker photo would otherwise
  // upload onto the new context's report (Codex P1/P2s on #2748).
  function treatmentExtractWentStale(seq, started) {
    // An empty starting address ADOPTING a value (the async customer record
    // finishing its load) is not a property switch — only a change away
    // from a known address invalidates.
    const addressChanged = started.address !== '' && wdoAddressRef.current !== started.address;
    const contextChanged = customerIdRef.current !== started.customer
      || projectTypeRef.current !== started.type
      || addressChanged;
    if (contextChanged) {
      // The photo cleanup must run even for a SUPERSEDED request — checking
      // seq first let a request that was both superseded and context-stale
      // (extract → edit address → extract again) leave its photo queued for
      // the new property's report (Codex r7 P1). Only the LATEST request
      // owns the pending state, though: resetting it here while a newer
      // extraction is mid-flight would un-wedge its Save gate early.
      setPhotoQueue(prev => prev.filter(p => p.id !== started.photoId));
      if (treatmentExtractSeqRef.current === seq) setTreatmentExtract({ status: 'idle', message: '' });
      return true;
    }
    return treatmentExtractSeqRef.current !== seq;
  }

  async function handleTreatmentPhotoExtract(file) {
    if (!file || saving || aiWriting) return;
    const seq = ++treatmentExtractSeqRef.current;
    const started = {
      customer: customerIdRef.current,
      type: projectTypeRef.current,
      address: wdoAddressRef.current,
      photoId: `q_extract_${Date.now()}_${seq}`,
    };
    // Queued with a known id (not via queuePhoto) so the stale guard can
    // remove exactly this photo if the context changes mid-request.
    setPhotoQueue(prev => [...prev, { file, category: 'previous_treatment', caption: '', id: started.photoId }]);
    setTreatmentExtract({ status: 'working', message: '' });
    try {
      const fd = new FormData();
      if (customerId) fd.append('customer_id', customerId);
      if (createdProject?.id) fd.append('project_id', createdProject.id);
      if (defaultServiceRecordId) fd.append('service_record_id', defaultServiceRecordId);
      if (defaultScheduledServiceId) fd.append('scheduled_service_id', defaultScheduledServiceId);
      if (started.address) fd.append('property_address', started.address);
      fd.append('previous_treatment_photo', file);
      const res = await adminFetch('/admin/projects/wdo-treatment-photo', { method: 'POST', body: fd, headers: {} });
      const data = await res.json();
      if (treatmentExtractWentStale(seq, started)) return;
      if (!res.ok) throw new Error(data?.error || 'Photo extraction failed');
      const suggested = data?.suggestedFindings || {};
      const notes = String(suggested.previous_treatment_notes || '').trim();
      const evidence = String(suggested.previous_treatment_evidence || '').trim();
      if (!notes && !evidence) {
        setTreatmentExtract({ status: 'done', message: 'No treatment details could be read from that photo — verify on site.' });
        return;
      }
      // The tech explicitly asked to read THIS photo, so a readable sticker
      // may upgrade an earlier "No" to "Yes" — filing "No" beside observations
      // describing prior treatment is the inconsistency to prevent. The
      // reverse never overwrites: one photo of a clean area can't prove
      // property-wide absence, so "No" only fills a blank select.
      const evidenceUpgraded = evidence === 'Yes'
        && hasMeaningfulValue(findings.previous_treatment_evidence)
        && findings.previous_treatment_evidence !== 'Yes';
      userDirtyRef.current = true;
      setFindings(prev => {
        const next = { ...prev };
        // Record before/after per written field so the customer-switch path
        // can restore them. `before` is kept from the FIRST extraction since
        // the record was last cleared — a second extraction stacks on the
        // first, and a restore must unwind both. (Idempotent under a
        // StrictMode double-invoke: the second run sees the same prev and an
        // already-populated record.)
        const record = treatmentExtractAppliedRef.current || {};
        if (notes) {
          // Append below anything the tech already wrote — never clobber it.
          const existing = String(prev.previous_treatment_notes || '').trim();
          const applied = existing ? `${existing}\n${notes}` : notes;
          record.notes = { before: record.notes ? record.notes.before : (prev.previous_treatment_notes || ''), after: applied };
          next.previous_treatment_notes = applied;
        }
        if (evidence === 'Yes' || (evidence && !hasMeaningfulValue(prev.previous_treatment_evidence))) {
          record.evidence = { before: record.evidence ? record.evidence.before : (prev.previous_treatment_evidence || ''), after: evidence };
          next.previous_treatment_evidence = evidence;
        }
        treatmentExtractAppliedRef.current = record;
        return next;
      });
      // The same photo is included in the statutory addendum. Carry the
      // reviewed extraction into its caption so the PDF does not show a bare
      // "Photo N -" line or force the tech to type the same details twice.
      if (notes) {
        const generatedCaption = `Previous treatment evidence: ${notes}`.slice(0, PHOTO_CAPTION_MAX);
        setPhotoQueue(prev => prev.map(item => (
          item.id === started.photoId
            ? {
              ...item,
              caption: !item.caption || item.caption === item.generatedCaption
                ? generatedCaption
                : item.caption,
              generatedCaption,
            }
            : item
        )));
      }
      // Pass the AI's own caveats through (e.g. a smudged handwritten year)
      // so the tech sees WHICH detail needs confirming, not just a generic
      // verify reminder.
      const reviewNotes = Array.isArray(data?.reviewNotes) ? data.reviewNotes.filter(Boolean) : [];
      setTreatmentExtract({
        status: 'done',
        message: [
          evidenceUpgraded ? 'Evidence of previous treatment changed to "Yes" based on the photo.' : '',
          'Extracted from photo — verify before filing.',
          ...reviewNotes,
        ].filter(Boolean).join(' '),
      });
    } catch (e) {
      if (treatmentExtractWentStale(seq, started)) return;
      setTreatmentExtract({ status: 'error', message: e.message || 'Photo extraction failed' });
    }
  }

  async function handleSave() {
    if (!projectType) return setError('Pick a project type');
    if (!customerId) return setError('Pick a customer');
    // Saving mid-extraction would persist the pre-extraction findings and
    // close the modal, silently discarding the AI-read treatment details
    // (Codex P2 on #2748) — the save is a moment behind the photo anyway.
    if (treatmentExtract.status === 'working') {
      return setError('Photo extraction is still running — it fills the Previous Treatment fields when it finishes.');
    }
    setSaving(true);
    setError(null);
    try {
      const usingDefaultCustomerLink = defaultCustomerId && customerId === defaultCustomerId;
      const serviceRecordId = usingDefaultCustomerLink ? defaultServiceRecordId || null : null;
      const scheduledServiceId = usingDefaultCustomerLink ? defaultScheduledServiceId || null : null;
      let data = createdProject ? { project: createdProject } : null;
      if (!data) {
        const r = await adminFetch('/admin/projects', {
          method: 'POST',
          body: {
            customer_id: customerId,
            project_type: projectType,
            project_date: projectDate || null,
            title: title || null,
            findings,
            recommendations: recommendations || null,
            service_record_id: serviceRecordId,
            scheduled_service_id: scheduledServiceId,
          },
        });
        data = await r.json();
        if (!r.ok) throw new Error(data?.error || 'Save failed');
        setCreatedProject(data.project);
        // The project now lives server-side as a draft — it's the source of
        // truth. Drop the local draft so a later restore can't re-POST a
        // duplicate (e.g. if photo uploads below fail and the tech reopens).
        // Null the flush ref imperatively too: if the parent unmounts this
        // modal in the same render batch as onCreated, the effect that
        // normally nulls it never re-runs, and the unmount flush would
        // resurrect the draft we just deleted.
        draftFlushRef.current = null;
        try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      } else {
        const r = await adminFetch(`/admin/projects/${data.project.id}`, {
          method: 'PUT',
          body: {
            project_date: projectDate || null,
            title: title || null,
            findings,
            recommendations: recommendations || null,
          },
        });
        const updated = await r.json();
        if (!r.ok) throw new Error(updated?.error || 'Save failed');
        if (updated.project) {
          data = { project: updated.project };
          setCreatedProject(updated.project);
        }
      }
      const projectId = data.project.id;

      // Upload queued photos one by one. Kept serial so a mid-upload failure
      // reports accurate progress; volume is typically small (5–30 photos).
      if (photoQueue.length) {
        setUploadProgress({ done: 0, total: photoQueue.length });
        const failedUploads = [];
        const failedIds = new Set();
        for (let i = 0; i < photoQueue.length; i++) {
          const ph = photoQueue[i];
          const fd = new FormData();
          fd.append('photo', ph.file);
          if (ph.category) fd.append('category', ph.category);
          if (ph.caption) fd.append('caption', ph.caption);
          try {
            const uploadRes = await adminFetch(`/admin/projects/${projectId}/photos`, { method: 'POST', body: fd, headers: {} });
            if (!uploadRes.ok) {
              let message = 'upload failed';
              try {
                const body = await uploadRes.json();
                message = body?.error || message;
              } catch { /* keep fallback */ }
              throw new Error(message);
            }
          } catch (err) {
            failedUploads.push(`${ph.file.name}: ${err.message || 'upload failed'}`);
            failedIds.add(ph.id);
          }
          setUploadProgress({ done: i + 1, total: photoQueue.length });
        }
        if (failedUploads.length) {
          setPhotoQueue(prev => prev.filter(item => failedIds.has(item.id)));
          setError(`Project draft was saved, but some photos did not upload. Retry Save Draft to upload the remaining photo${failedUploads.length === 1 ? '' : 's'}. ${failedUploads.join('; ')}`);
          return;
        }
      }

      try { localStorage.removeItem(draftKey); } catch { /* ignore */ }
      if ([WDO_PROJECT_TYPE, PRE_TREATMENT_CERTIFICATE_TYPE].includes(projectType) && !signStep) {
        // Fetch the detail payload for the same signer prefill the report
        // page uses (findings applicator → creating tech's name + FDACS
        // license) plus the stripped signature metadata. Prefill-only: if
        // the fetch fails, the pad still works with blank fields.
        let detailPayload = null;
        if (projectType === WDO_PROJECT_TYPE || allowInvoiceCompletion) {
          try {
            const dr = await adminFetch(`/admin/projects/${data.project.id}`);
            const dd = await dr.json().catch(() => null);
            if (dr.ok) detailPayload = dd || null;
          } catch { /* prefill only */ }
        }
        const detail = detailPayload?.project || null;
        setSignStep({
          project: data.project,
          requiresSignature: projectType === WDO_PROJECT_TYPE,
          applicator: detail?.wdo_applicator || { name: '', idCardNo: '' },
          signature: detail?.wdo_signature || null,
          reportHoldAvailable: detail?.report_payment_hold_available === true,
          billingReason: detailPayload?.closeoutPreview?.billing?.reason || null,
          invoiceStatus: detailPayload?.closeoutPreview?.billing?.invoiceStatus || null,
          noCharge: projectType === WDO_PROJECT_TYPE && wdoFeeIsExplicitZero(findings.inspection_fee),
        });
        return;
      }
      if (onCreated) onCreated(data.project);
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  // The pad reports the authoritative outcome of its own mutation (signed
  // metadata from the POST response, or null after a clear) — applied
  // directly, no refetch: a slow or failed detail GET must never leave the
  // step claiming unsigned after a successful save (Codex P2). The pad
  // AWAITS this inside its busy window, so exits can't race it either.
  function applySignatureOutcome(meta) {
    setSignStep(prev => (prev ? { ...prev, signature: meta } : prev));
  }

  async function readProjectAction(response, fallbackMessage) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error || fallbackMessage);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function sendInvoiceAndFinish(forceNoHold = false) {
    const requiresSignature = signStep?.requiresSignature !== false;
    if (!allowInvoiceCompletion
      || !signStep?.project?.id
      || (requiresSignature && !signStep.signature?.signed && !signStep.invoiceDelivery)) return;
    const isCertificate = signStep.project.project_type === PRE_TREATMENT_CERTIFICATE_TYPE;
    const documentLabel = isCertificate ? 'pre-treatment certificate' : 'WDO report';
    const holdRequested = !forceNoHold && signStep.reportHoldAvailable === true;
    setCompletionBusy(true);
    setCompletionAction('invoice');
    setError(null);
    let invoiceDelivery = signStep.invoiceDelivery || null;
    try {
      if (!invoiceDelivery) {
        const previewResponse = await adminFetch(
          `/admin/projects/${signStep.project.id}/send-with-invoice`,
          {
            method: 'POST',
            body: { dry_run: true, ...(holdRequested ? { hold_report_until_paid: true } : {}) },
          },
        );
        const preview = await readProjectAction(previewResponse, `Could not prepare the ${documentLabel} invoice`);
        const amount = Number(preview?.invoice?.total || 0).toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
        });
        const deliveryExplanation = holdRequested
          ? `The customer receives the invoice and payment link now. Their ${documentLabel} stays locked until payment, then emails and unlocks automatically.`
          : `The customer receives the invoice, payment link, and ${documentLabel} now.`;
        if (!confirm(`Send the ${amount} invoice now and finish this service?\n\n${deliveryExplanation}`)) return;

        const sendResponse = await adminFetch(
          `/admin/projects/${signStep.project.id}/send-with-invoice`,
          {
            method: 'POST',
            body: {
              ...(preview?.invoice?.id ? { invoice_id: preview.invoice.id } : {}),
              ...(holdRequested ? { hold_report_until_paid: true } : {}),
            },
          },
        );
        const sent = await readProjectAction(sendResponse, `Could not send the ${documentLabel} invoice`);
        if (!sent.sent) {
          throw new Error(`The invoice and ${documentLabel} were not delivered. Please retry.`);
        }
        invoiceDelivery = sent;
        // Persist this boundary in local UI state before attempting close. If
        // closeout fails, Retry finishes the service without emailing a second
        // invoice.
        setSignStep(prev => (prev ? { ...prev, invoiceDelivery: sent } : prev));
      }

      const closeResponse = await adminFetch(`/admin/projects/${signStep.project.id}/close`, {
        method: 'POST',
        body: {},
      });
      const closed = await readProjectAction(
        closeResponse,
        invoiceDelivery
          ? `The invoice was sent and the ${documentLabel} was ${invoiceDelivery.report_held ? 'held' : 'delivered'}, but the service could not be closed. Tap Finish service to retry.`
          : `Could not finish the ${isCertificate ? 'pre-treatment' : 'WDO'} service`,
      );
      finishSignStep({
        project: closed.project || signStep.project,
        completed: true,
        invoice: invoiceDelivery.invoice || null,
      });
    } catch (e) {
      if (holdRequested && e.payload?.code === 'hold_statement_accrued') {
        // NET-terms payer invoices accrue to a consolidated statement, so
        // there is no individual pay-before-report lifecycle to wait on. The
        // server refuses the hold before creating an invoice; retry the same
        // combined delivery without the hold and keep that mode in the UI if
        // closeout itself needs a retry.
        setSignStep(prev => (prev ? { ...prev, reportHoldAvailable: false } : prev));
        await sendInvoiceAndFinish(true);
        return;
      }
      setError(e.message || `Could not finish the ${isCertificate ? 'pre-treatment' : 'WDO'} service`);
    } finally {
      setCompletionBusy(false);
      setCompletionAction(null);
    }
  }

  async function sendReportAndFinish() {
    const requiresSignature = signStep?.requiresSignature !== false;
    if (!allowInvoiceCompletion
      || !signStep?.project?.id
      || (requiresSignature && !signStep.signature?.signed && !signStep.reportOnlyDelivery)) return;
    const isCertificate = signStep.project.project_type === PRE_TREATMENT_CERTIFICATE_TYPE;
    const documentLabel = isCertificate ? 'pre-treatment certificate' : 'WDO report';
    setCompletionBusy(true);
    setCompletionAction('report');
    setError(null);
    let reportOnlyDelivery = signStep.reportOnlyDelivery || null;
    try {
      if (!reportOnlyDelivery) {
        const sendResponse = await adminFetch(`/admin/projects/${signStep.project.id}/send`, {
          method: 'POST',
          body: {},
        });
        const sent = await readProjectAction(sendResponse, `Could not send the ${documentLabel}`);
        if (!sent.sent) throw new Error(`The ${documentLabel} was not delivered. Please retry.`);
        reportOnlyDelivery = sent;
        setSignStep(prev => (prev ? { ...prev, reportOnlyDelivery: sent } : prev));
      }

      const closeResponse = await adminFetch(`/admin/projects/${signStep.project.id}/close`, {
        method: 'POST',
        body: {},
      });
      const closed = await readProjectAction(
        closeResponse,
        `The ${documentLabel} was delivered, but the service could not be closed. Tap Finish service to retry.`,
      );
      finishSignStep({ project: closed.project || signStep.project, completed: true });
    } catch (e) {
      setError(e.message || `Could not deliver the ${documentLabel} and finish the service`);
    } finally {
      setCompletionBusy(false);
      setCompletionAction(null);
    }
  }

  async function chargeCardAndFinish() {
    const requiresSignature = signStep?.requiresSignature !== false;
    if (!allowInvoiceCompletion
      || !savedCard
      || !signStep?.project?.id
      || (requiresSignature && !signStep.signature?.signed && !signStep.cardCompletion)) return;
    const isCertificate = signStep.project.project_type === PRE_TREATMENT_CERTIFICATE_TYPE;
    const documentLabel = isCertificate ? 'pre-treatment certificate' : 'WDO report';
    setCompletionBusy(true);
    setCompletionAction('card');
    setError(null);
    let cardCompletion = signStep.cardCompletion || null;
    try {
      if (cardCompletion?.blocked) {
        throw new Error('The previous payment result is uncertain. Do not retry the charge; verify the invoice in Stripe first.');
      }

      if (!cardCompletion?.charged) {
        const prepareResponse = await adminFetch(
          `/admin/projects/${signStep.project.id}/send-with-invoice`,
          { method: 'POST', body: { prepare_invoice: true } },
        );
        const prepared = await readProjectAction(prepareResponse, `Could not create the ${documentLabel} invoice`);
        if (!prepared?.invoice?.id) throw new Error('The invoice could not be prepared for payment.');
        if (prepared.invoice.payer_billed) {
          throw new Error('This invoice is billed to a third-party payer. Send the invoice instead of charging the customer’s saved card.');
        }

        const quoteResponse = await adminFetch(`/admin/invoices/${prepared.invoice.id}/charge-card-quote`, {
          method: 'POST',
          body: { paymentMethodId: savedCard.id },
        });
        const quoted = await readProjectAction(quoteResponse, `Could not price the ${savedCardLabel} charge`);
        const quote = quoted?.quote || {};
        const total = Number(quote.total || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
        const base = Number(quote.base || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
        const surcharge = Number(quote.surcharge || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
        const pricingDetail = Number(quote.surcharge || 0) > 0
          ? `Invoice after account credit: ${base}\nCard fee: ${surcharge}\nTotal charge: ${total}`
          : quote.coveredByCredit
            ? `Account credit covers the invoice. Card charge: ${total}`
            : `Total charge: ${total}`;
        if (!confirm(
          `Charge ${savedCardLabel} and finish this service?\n\n${pricingDetail}\n\n` +
          `After payment succeeds, the customer receives the ${documentLabel} immediately.`,
        )) return;

        try {
          const chargeResponse = await adminFetch(`/admin/invoices/${prepared.invoice.id}/charge-card`, {
            method: 'POST',
            body: { paymentMethodId: savedCard.id, expectedTotal: quote.total },
          });
          await readProjectAction(chargeResponse, `Could not charge ${savedCardLabel}`);
        } catch (chargeError) {
          const uncertain = chargeError?.payload?.orphan === true
            || chargeError?.payload?.ambiguous === true
            || chargeError?.payload?.in_progress === true;
          if (uncertain) {
            setSignStep((previous) => previous ? {
              ...previous,
              cardCompletion: { invoice: prepared.invoice, blocked: true, charged: false },
            } : previous);
            throw new Error(`${chargeError.message} Do not retry this charge; verify the invoice payment first.`);
          }
          throw chargeError;
        }

        cardCompletion = { invoice: prepared.invoice, charged: true, reportSent: false };
        setSignStep((previous) => previous ? { ...previous, cardCompletion } : previous);
      }

      if (!cardCompletion.reportSent) {
        const sendResponse = await adminFetch(`/admin/projects/${signStep.project.id}/send`, {
          method: 'POST',
          body: {},
        });
        const delivered = await readProjectAction(
          sendResponse,
          `Payment succeeded, but the ${documentLabel} could not be delivered. Tap Deliver & finish to retry; the card will not be charged again.`,
        );
        if (!delivered.sent) {
          throw new Error(`Payment succeeded, but the ${documentLabel} was not delivered. Tap Deliver & finish to retry; the card will not be charged again.`);
        }
        cardCompletion = { ...cardCompletion, reportSent: true };
        setSignStep((previous) => previous ? { ...previous, cardCompletion } : previous);
      }

      const closeResponse = await adminFetch(`/admin/projects/${signStep.project.id}/close`, {
        method: 'POST',
        body: {},
      });
      const closed = await readProjectAction(
        closeResponse,
        `Payment and delivery succeeded, but the service could not be closed. Tap Finish service to retry; the card will not be charged again.`,
      );
      finishSignStep({
        project: closed.project || signStep.project,
        completed: true,
        invoice: cardCompletion.invoice || null,
      });
    } catch (e) {
      setError(e.message || `Could not finish the ${isCertificate ? 'pre-treatment' : 'WDO'} service`);
    } finally {
      setCompletionBusy(false);
      setCompletionAction(null);
    }
  }

  // The only exit from the sign step — signed or not, the draft is already
  // saved, so leaving always reports the created project to the parent
  // (which refreshes its lists and may open the report) and closes. Held
  // while the pad's mutation is in flight.
  function finishSignStep(options = {}) {
    // The invoice workflow calls this from inside its own busy window after
    // both server actions have succeeded; user-driven exits remain locked.
    if (signBusy || (completionBusy && !options?.completed)) return;
    const project = options?.project || signStep?.project;
    setSignStep(null);
    if (onCreated && project) {
      if (options?.completed) {
        onCreated(project, { completed: true, invoice: options.invoice || null });
      } else {
        onCreated(project);
      }
    }
    onClose?.();
  }

  // Portaled to <body>: rendered inline the overlay is trapped in the page's
  // stacking context, so the admin header/tab bar (and tech chrome) paint over
  // it — the dialog's title bar and Save Draft/Cancel row were cut off on
  // phones. The overlay's own env() padding keeps the card clear of the iOS
  // status bar and home indicator now that it truly covers the screen. Fonts
  // are unaffected: the card sets P.bodyFont per theme.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-project-modal-title"
      data-official-document-flow={isOfficialDocument ? projectType : undefined}
      style={isSheet ? {
        // Complete Service frame: scrim + full-height sheet docked right
        // (100% width on phones via maxWidth), body scrolls inside.
        position: 'fixed', inset: 0, zIndex: 200,
        background: isEstimateStyle ? 'rgba(9, 9, 11, 0.42)' : 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
        fontFamily: isOfficialDocument ? ROBOTO_FONT : P.bodyFont,
      } : {
        position: 'fixed', inset: 0, zIndex: 200, background: isEstimateStyle ? 'rgba(9, 9, 11, 0.42)' : 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        overflowY: 'auto',
        padding: isEstimateStyle ? '24px 0' : '12px 0',
        paddingTop: `calc(${isEstimateStyle ? 24 : 12}px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${isEstimateStyle ? 24 : 12}px + env(safe-area-inset-bottom, 0px))`,
        fontFamily: isOfficialDocument ? ROBOTO_FONT : P.bodyFont,
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget || saving) return;
        // On the sign step the scrim is an exit like any other: it must go
        // through finishSignStep so the parent still learns about the saved
        // project (onCreated drives list refreshes / opening the report).
        if (signStep) { finishSignStep(); return; }
        onClose?.();
      }}
    >
      {isOfficialDocument && (
        <style>{`[data-official-document-flow] *, [data-official-document-flow] input, [data-official-document-flow] select, [data-official-document-flow] textarea, [data-official-document-flow] button { font-family: ${ROBOTO_FONT} !important; }`}</style>
      )}
      <div style={isSheet ? {
        width: '100%', maxWidth: 640, height: '100dvh', maxHeight: '100dvh', margin: 0,
        background: isEstimateStyle ? P.bg : P.card,
        borderLeft: `1px solid ${P.border}`,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        paddingTop: 'env(safe-area-inset-top, 0px)',
        boxSizing: 'border-box',
      } : {
        width: '100%', maxWidth: isEstimateStyle ? 720 : 520, margin: '0 12px',
        background: isEstimateStyle ? P.bg : P.card,
        border: `1px solid ${P.border}`,
        borderRadius: isEstimateStyle ? 12 : 14,
        display: 'flex', flexDirection: 'column',
        boxShadow: isEstimateStyle ? '0 24px 60px rgba(9, 9, 11, 0.18)' : undefined,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: isEstimateStyle ? '18px 22px' : '14px 16px',
          borderBottom: `1px solid ${P.border}`,
          background: P.card,
        }}>
          <div>
            <div style={{
              fontSize: isEstimateStyle ? 18 : 16,
              fontWeight: wStrong,
              color: P.heading,
              fontFamily: P.bodyFont,
              letterSpacing: 0,
              textTransform: 'none',
            }}>
              <span id="create-project-modal-title">
                {isSheet ? 'Complete Service Report' : 'Create Project Report'}
              </span>
            </div>
            <div style={{
              fontSize: isEstimateStyle ? 12 : 11,
              color: P.muted,
              marginTop: 3,
              fontFamily: P.bodyFont,
              fontWeight: 500,
              lineHeight: 1.35,
            }}>
              {signStep
                ? signStep.requiresSignature === false
                  ? 'Certificate saved — invoice delivery'
                  : 'Draft saved — licensee signature'
                : projectType === WDO_PROJECT_TYPE
                  ? 'Wood Destroying Organism (WDO) Inspection Report'
                  : projectType === PRE_TREATMENT_CERTIFICATE_TYPE
                    ? 'Pre-Treatment Certificate of Compliance'
                  : 'Inspection or documentation-heavy job'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {isSheet && onViewDetails && !signStep && (
              <button
                type="button"
                onClick={() => {
                  if (saving) return;
                  // Queued photos are File objects — they can't ride the
                  // localStorage draft that survives this handoff, so make
                  // the tech choose instead of silently dropping evidence
                  // shots (Codex r3 P2).
                  if (photoQueue.length
                    && !confirm(`${photoQueue.length} queued photo${photoQueue.length === 1 ? '' : 's'} will be discarded if you open appointment details before saving. Continue?`)) {
                    return;
                  }
                  onViewDetails();
                }}
                style={{
                  height: 36, minWidth: 72, borderRadius: 999,
                  background: P.card, border: `1px solid ${P.border}`,
                  color: P.text, fontSize: 13, fontWeight: wMed,
                  cursor: 'pointer', padding: '0 14px',
                }}
              >Details</button>
            )}
            <button
              type="button"
              onClick={() => !saving && !completionBusy && (signStep ? finishSignStep() : onClose?.())}
              aria-label="Close"
              style={{
                background: 'transparent', border: 'none', color: P.muted,
                fontSize: 24, cursor: 'pointer', padding: '4px 10px',
              }}
            >×</button>
          </div>
        </div>

        {/* Official-document completion: WDO captures its saved-content
            signature here; a pre-treatment certificate already contains the
            typed applicator attestation and proceeds directly to delivery. */}
        {signStep ? (
          <>
          <div style={{
            padding: isEstimateStyle ? 22 : 16,
            display: 'flex', flexDirection: 'column', gap: 12,
            ...(isSheet ? { flex: 1, overflowY: 'auto' } : {}),
          }}>
            <div style={{ fontSize: 14, fontWeight: wStrong, color: P.heading, fontFamily: P.bodyFont }}>
              {signStep.requiresSignature === false ? '✓ Certificate saved' : '✓ Report draft saved'}
            </div>
            <div style={{ fontSize: 13, color: P.muted, lineHeight: 1.45, fontFamily: P.bodyFont }}>
              {signStep.invoiceDelivery
                ? signStep.invoiceDelivery.report_held
                  ? `Invoice ${signStep.invoiceDelivery.invoice?.invoice_number || ''} sent. The customer’s ${signStep.requiresSignature === false ? 'certificate' : 'report'} is locked until payment; finish the service without sending anything again.`
                  : `Invoice ${signStep.invoiceDelivery.invoice?.invoice_number || ''} and the customer’s ${signStep.requiresSignature === false ? 'certificate' : 'report'} were delivered; finish the service without sending anything again.`
                : signStep.reportOnlyDelivery
                  ? `The customer’s ${signStep.requiresSignature === false ? 'certificate' : 'report'} was delivered; finish the service without sending anything again.`
                : signStep.cardCompletion?.charged
                  ? signStep.cardCompletion.reportSent
                    ? `Card payment received and the customer’s ${signStep.requiresSignature === false ? 'certificate' : 'report'} delivered. Finish the service without charging or sending again.`
                    : `Card payment received. Deliver the customer’s ${signStep.requiresSignature === false ? 'certificate' : 'report'} and finish—this retry will not charge the card again.`
                : reportOnlyCompletion
                  ? `This visit is already paid or has no invoice balance. Send the ${signStep.requiresSignature === false ? 'certificate' : 'report'} and finish the service.`
                : signStep.requiresSignature === false
                  ? allowInvoiceCompletion
                    ? savedCard
                      ? signStep.reportHoldAvailable
                        ? `Applicator attestation saved — charge ${savedCardLabel} now, or send the invoice and keep the certificate locked until payment.`
                        : `Applicator attestation saved — charge ${savedCardLabel} now, or send the invoice and certificate together.`
                      : signStep.reportHoldAvailable
                        ? 'Applicator attestation saved — send the invoice now. The customer’s certificate stays locked until payment, then emails and unlocks automatically.'
                        : 'Applicator attestation saved — send the invoice and certificate now.'
                    : 'Applicator attestation saved — ready for office invoice delivery.'
                  : signStep.signature?.signed
                    ? allowInvoiceCompletion
                      ? savedCard
                        ? signStep.reportHoldAvailable
                          ? `Signed — charge ${savedCardLabel} now, or send the invoice and keep the report locked until payment.`
                          : `Signed — charge ${savedCardLabel} now, or send the invoice and report together.`
                        : signStep.reportHoldAvailable
                          ? 'Signed — send the invoice now. The customer’s report stays locked until payment, then emails and unlocks automatically.'
                          : 'Signed — send the invoice and report now.'
                      : 'Signed — saved for office review and invoice delivery.'
                    : 'Sign now to finish in one step — the FDACS-13645 report can’t be sent until the licensee signs. You can also sign later from the saved report.'}
            </div>
            {error && (
              <div style={{
                padding: '9px 12px',
                background: `${P.red}12`,
                border: `1px solid ${P.red}`,
                borderRadius: 8,
                color: P.red,
                fontSize: 13,
                lineHeight: 1.4,
              }}>
                {error}
              </div>
            )}
            {signStep.requiresSignature !== false && !signStep.invoiceDelivery && !signStep.reportOnlyDelivery && !signStep.cardCompletion?.charged && (
              <WdoSignaturePad
                projectId={signStep.project.id}
                signature={signStep.signature}
                defaultSignerName={signStep.applicator?.name || ''}
                defaultSignerIdCard={signStep.applicator?.idCardNo || ''}
                onChanged={applySignatureOutcome}
                onBusyChange={setSignBusy}
              />
            )}
          </div>
          <div style={{
            padding: isEstimateStyle ? '16px 24px 20px' : '12px 16px',
            borderTop: `1px solid ${P.border}`,
            background: P.card,
            display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'stretch',
            ...(isSheet ? { paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' } : {}),
          }}>
            {signStep.requiresSignature !== false && !signStep.signature?.signed && (
              <span style={{ fontSize: 12, color: P.muted, fontFamily: P.bodyFont }}>
                Unsigned reports can’t be sent yet.
              </span>
            )}
            {allowInvoiceCompletion
              && reportOnlyCompletion
              && (signStep.requiresSignature === false || signStep.signature?.signed || signStep.reportOnlyDelivery) && (
              <button
                type="button"
                onClick={sendReportAndFinish}
                disabled={signBusy || completionBusy}
                style={{
                  minHeight: 52,
                  width: '100%',
                  padding: '0 18px',
                  borderRadius: 10,
                  fontSize: 14,
                  fontWeight: wStrong,
                  background: P.accent,
                  color: P.accentText,
                  border: 'none',
                  cursor: signBusy || completionBusy ? 'default' : 'pointer',
                  opacity: signBusy || completionBusy ? 0.6 : 1,
                }}
              >
                {completionBusy && completionAction === 'report'
                  ? signStep.reportOnlyDelivery ? 'Finishing service…' : `Sending ${signStep.requiresSignature === false ? 'certificate' : 'report'}…`
                  : signStep.reportOnlyDelivery ? 'Finish service' : `Send ${signStep.requiresSignature === false ? 'certificate' : 'report'} & finish service`}
              </button>
            )}
            {allowInvoiceCompletion
              && !reportOnlyCompletion
              && (savedCard || signStep.cardCompletion)
              && !signStep.invoiceDelivery
              && (signStep.requiresSignature === false || signStep.signature?.signed || signStep.cardCompletion) && (
              <button
                type="button"
                onClick={chargeCardAndFinish}
                disabled={signBusy || completionBusy || signStep.cardCompletion?.blocked}
                style={{
                  minHeight: 52,
                  width: '100%',
                  padding: '0 18px',
                  borderRadius: 10,
                  fontSize: 14,
                  fontWeight: wStrong,
                  background: P.accent,
                  color: P.accentText,
                  border: 'none',
                  cursor: signBusy || completionBusy || signStep.cardCompletion?.blocked ? 'default' : 'pointer',
                  opacity: signBusy || completionBusy || signStep.cardCompletion?.blocked ? 0.6 : 1,
                }}
              >
                {signStep.cardCompletion?.blocked
                  ? 'Payment needs verification — do not retry'
                  : completionBusy && completionAction === 'card'
                    ? signStep.cardCompletion?.reportSent ? 'Finishing service…' : signStep.cardCompletion?.charged ? 'Delivering report…' : 'Charging card…'
                    : signStep.cardCompletion?.reportSent
                      ? 'Finish service'
                      : signStep.cardCompletion?.charged
                        ? 'Deliver & finish'
                        : `Charge ${savedCardLabel} & finish service`}
              </button>
            )}
            {allowInvoiceCompletion
              && !reportOnlyCompletion
              && !signStep.cardCompletion?.charged
              && !signStep.cardCompletion?.blocked
              && (signStep.requiresSignature === false || signStep.signature?.signed || signStep.invoiceDelivery) && (
              <button
                type="button"
                onClick={() => sendInvoiceAndFinish()}
                disabled={signBusy || completionBusy}
                style={{
                  minHeight: 52,
                  width: '100%',
                  padding: '0 18px',
                  borderRadius: 10,
                  fontSize: 14,
                  fontWeight: wStrong,
                  background: savedCard && !signStep.invoiceDelivery ? 'transparent' : P.accent,
                  color: savedCard && !signStep.invoiceDelivery ? P.text : P.accentText,
                  border: savedCard && !signStep.invoiceDelivery ? `1px solid ${P.border}` : 'none',
                  cursor: signBusy || completionBusy ? 'default' : 'pointer',
                  opacity: signBusy || completionBusy ? 0.6 : 1,
                }}
              >
                {completionBusy && completionAction === 'invoice'
                  ? signStep.invoiceDelivery ? 'Finishing service…' : 'Sending invoice…'
                  : signStep.invoiceDelivery
                    ? 'Finish service'
                    : signStep.reportHoldAvailable
                      ? `Send invoice & hold ${signStep.requiresSignature === false ? 'certificate' : 'report'}`
                      : `Send invoice & ${signStep.requiresSignature === false ? 'certificate' : 'report'}`}
              </button>
            )}
            <button
              type="button"
              onClick={finishSignStep}
              disabled={signBusy || completionBusy}
              style={{
                minHeight: isEstimateStyle || isSheet ? 48 : undefined,
                width: '100%',
                padding: isEstimateStyle ? '0 18px' : '10px 18px',
                borderRadius: isEstimateStyle ? 10 : 8,
                fontSize: isEstimateStyle ? 14 : 13,
                fontWeight: wStrong,
                background: 'transparent',
                color: P.text,
                border: `1px solid ${P.border}`,
                cursor: signBusy || completionBusy ? 'default' : 'pointer',
                opacity: signBusy || completionBusy ? 0.5 : 1,
              }}
            >{signBusy ? 'Saving…' : signStep.requiresSignature === false || signStep.signature?.signed ? 'Save for later' : 'Sign later'}</button>
          </div>
          </>
        ) : (
        <>
        {/* Body — in sheet mode this is the scroll region (header/footer pinned).
            onInput marks the draft user-dirty: every keystroke in any field
            bubbles here, while autofill EFFECTS don't fire input events —
            the cheap way to tell typed content from effect output. */}
        <div
          onInput={() => { userDirtyRef.current = true; }}
          style={{
            padding: isEstimateStyle ? 22 : 16,
            display: 'flex', flexDirection: 'column', gap: isEstimateStyle ? 16 : 16,
            ...(isSheet ? { flex: 1, overflowY: 'auto' } : {}),
          }}
        >
          {/* Restore saved draft */}
          {showDraftPrompt && (
            <div style={{
              background: theme === 'light' ? P.card : P.bg,
              border: `1px solid ${P.accent}`,
              borderRadius: 10, padding: 12,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ fontSize: 13, fontWeight: wStrong, color: P.heading }}>
                Restore saved draft?
              </div>
              <div style={{ fontSize: 11, color: P.muted }}>
                Saved {savedDraft?.savedAt ? new Date(savedDraft.savedAt).toLocaleString() : 'recently'}
                {' '}· photos aren’t saved and will need to be re-added.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={restoreDraft}
                  style={{
                    padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: wStrong,
                    background: P.accent, color: P.accentText, border: 'none', cursor: 'pointer',
                  }}
                >Restore</button>
                <button
                  type="button"
                  onClick={discardDraft}
                  style={{
                    padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: wMed,
                    background: 'transparent', color: P.text, border: `1px solid ${P.border}`, cursor: 'pointer',
                  }}
                >Discard</button>
              </div>
            </div>
          )}

          {/* Project type — in sheet mode with the visit-locked single type
              the picker is redundant chrome (the header names the report);
              the description + FDACS link stay. A legacy visit that offers
              both compliance types keeps the picker. */}
          <div>
            {!(isSheet && visibleTypes.length <= 1 && projectType) && (
            <>
            <label style={labelStyle}>Project type *</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {visibleTypes.map(([key, cfg]) => {
                const active = projectType === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      // Click-driven content selection — no input event
                      // fires, so mark the draft dirty here (Codex r14 P3).
                      userDirtyRef.current = true;
                      setProjectType(key); setFindings({}); setRecommendations('');
                    }}
                    style={{
                      padding: '10px 10px', borderRadius: 8, cursor: 'pointer',
                      background: active ? P.accent : (theme === 'light' ? P.bg : P.bg),
                      color: active ? P.accentText : P.text,
                      border: `1px solid ${active ? P.accent : P.border}`,
                      fontSize: 12, fontWeight: wMed, textAlign: 'left',
                    }}
                  >
                    {cfg.short || cfg.label}
                  </button>
                );
              })}
            </div>
            </>
            )}
              {typeCfg?.description && (
                <div style={{ fontSize: 11, color: P.muted, marginTop: 6 }}>{typeCfg.description}</div>
              )}
              {projectType === 'wdo_inspection' && (
                <a
                  href="/forms/fdacs-13645-wdo-inspection-report.pdf"
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-block', marginTop: 8, fontSize: 12, fontWeight: wStrong, color: P.accent }}
                >
                  Open FDACS-13645 form
                </a>
              )}
            </div>

          {/* Customer — the sheet is opened FROM the visit, so the customer
              is fixed context (like the pest completion header), not a
              picker: no Change button in sheet mode. */}
          <div>
            <label style={labelStyle}>Customer *</label>
            {customerId ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', background: theme === 'light' ? P.bg : P.bg, borderRadius: 8,
                border: `1px solid ${P.border}`,
              }}>
                <span style={{ fontSize: 13, color: P.text }}>{customerLabel || customerId}</span>
                {!(isSheet && defaultCustomerId) && (
                  <button
                    type="button"
                    onClick={() => { setCustomerId(''); setCustomerLabel(''); setCustomerQuery(''); setSelectedCustomer(null); prefillCustomerRef.current = null; clearWdoFindingsFromCustomer(); }}
                    style={{ background: 'transparent', border: 'none', color: P.muted, fontSize: 12, cursor: 'pointer' }}
                  >Change</button>
                )}
              </div>
            ) : (
              <>
                <input
                  type="text"
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  placeholder="Search by name, phone, or email"
                  style={inputStyle}
                />
                {customerResults.length > 0 && (
                  <div style={{
                    marginTop: 6, background: theme === 'light' ? P.card : P.bg, borderRadius: 8,
                    border: `1px solid ${P.border}`, overflow: 'hidden',
                  }}>
                    {customerResults.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          // Same click-driven-selection class as the type
                          // picker (Codex r14 P3).
                          userDirtyRef.current = true;
                          setCustomerId(c.id);
                          setSelectedCustomer(c);
                          const name = `${c.firstName || c.first_name || ''} ${c.lastName || c.last_name || ''}`.trim();
                          const phone = c.phone || '';
                          setCustomerLabel([name, phone].filter(Boolean).join(' · ') || c.id);
                          // WDO auto-fill happens ONLY in the
                          // [projectType, selectedCustomer] effect — applying
                          // here too would make the effect's prev/next diff
                          // see no change, so recordAppliedAutoFill would
                          // record nothing and "Change" couldn't clear it.
                          prefillFromScheduledService(c.id);
                        }}
                        style={{
                          width: '100%', textAlign: 'left', background: 'transparent',
                          border: 'none', borderBottom: `1px solid ${P.border}`,
                          padding: '10px 12px', cursor: 'pointer', color: P.text,
                          fontSize: 13,
                        }}
                      >
                        <div style={{ fontWeight: wMed }}>
                          {c.firstName || c.first_name || ''} {c.lastName || c.last_name || ''}
                          {!(c.firstName || c.first_name || c.lastName || c.last_name) && (c.phone || 'Unnamed customer')}
                        </div>
                        <div style={{ fontSize: 11, color: P.muted }}>
                          {(c.firstName || c.first_name || c.lastName || c.last_name) ? c.phone : ''}
                          {c.city ? ` · ${c.city}` : ''}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Type-specific fields */}
          {typeCfg && (
            <>
              {/* Title is auto-derived context in sheet mode (the visit +
                  type name it) — the state/default still rides the save. */}
              <div style={isSheet ? { display: 'none' } : undefined}>
                <label style={labelStyle}>Title / service performed (optional)</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => { setTitle(e.target.value); setServiceSearch(e.target.value); }}
                  placeholder="Search services, e.g. Rodent Trapping"
                  style={inputStyle}
                />
                {(serviceLoading || serviceResults.length > 0) && (
                  <div style={{
                    marginTop: 6, background: theme === 'light' ? P.card : P.bg, borderRadius: 8,
                    border: `1px solid ${P.border}`, overflow: 'hidden',
                  }}>
                    {serviceLoading && (
                      <div style={{ padding: '9px 12px', fontSize: 12, color: P.muted }}>Searching services...</div>
                    )}
                    {!serviceLoading && serviceResults.map(s => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          userDirtyRef.current = true;
                          setTitle(s.name || '');
                          setServiceSearch('');
                          setServiceResults([]);
                        }}
                        style={{
                          width: '100%', textAlign: 'left', background: 'transparent',
                          border: 'none', borderBottom: `1px solid ${P.border}`,
                          padding: '10px 12px', cursor: 'pointer', color: P.text,
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: wStrong }}>{s.name}</div>
                        <div style={{ fontSize: 11, color: P.muted }}>
                          {[s.category, s.billing_type, s.default_duration_minutes ? `${s.default_duration_minutes} min` : ''].filter(Boolean).join(' · ')}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                {/* The certificate has no separate findings-level date — this
                    project date IS the date of treatment it prints. */}
                <label style={labelStyle}>
                  {projectType === 'pre_treatment_termite_certificate' ? 'Date of treatment' : 'Inspection / project date'}
                </label>
                <input
                  type="date"
                  value={projectDate}
                  onChange={(e) => setProjectDate(e.target.value)}
                  // iOS WebKit gives date inputs an intrinsic shadow-DOM width
                  // that can exceed width:100% — clamp it and drop the native
                  // appearance so the field tracks the container like the
                  // sibling text inputs.
                  style={{
                    ...inputStyle,
                    WebkitAppearance: 'none',
                    appearance: 'none',
                    minWidth: 0,
                    maxWidth: '100%',
                  }}
                />
              </div>

              {projectType === PRE_TREATMENT_CERTIFICATE_TYPE && scheduledApplicationPrefill?.count > 0 && (
                <div style={{
                  border: `1px solid ${P.border}`,
                  borderRadius: 10,
                  background: isEstimateStyle ? '#FAFAFA' : P.bg,
                  color: P.text,
                  padding: '11px 13px',
                  fontSize: 12,
                  lineHeight: 1.45,
                }}>
                  <strong>{scheduledApplicationPrefill.count} planned application{scheduledApplicationPrefill.count === 1 ? '' : 's'} found on the scheduled service.</strong>{' '}
                  Confirm the product and actual coverage before saving the certificate.
                </div>
              )}

              {projectType === 'wdo_inspection' && (
                /* Keyed by customer so switching customers remounts the bar —
                   a finished lookup for the previous customer's property can
                   never be applied to the new one (legal FDACS filing). */
                <WdoIntelligenceBar
                  key={customerId || 'none'}
                  customerId={customerId}
                  serviceRecordId={defaultServiceRecordId}
                  scheduledServiceId={defaultScheduledServiceId}
                  propertyAddress={findings.property_address || formatCustomerAddress(selectedCustomer)}
                  findings={findings}
                  onApplySuggestions={applyWdoSuggestions}
                  onApplyProfile={applyWdoProfile}
                  onApplyHistory={applyWdoHistory}
                  onEvidencePhotoSelected={(file) => queuePhoto(file, 'previous_treatment')}
                  disabled={saving || aiWriting}
                  palette={P}
                />
              )}

              {typeCfg.findingsFields.map((field, fieldIndex) => {
                // The applicator must be one of our licensed techs — swap the
                // free-text field for a dropdown of active technicians once
                // the list loads (free text remains the offline fallback).
                const isApplicatorPicker = field.key === 'applicator_name' && applicators.length > 0;
                const renderField = isApplicatorPicker
                  ? { ...field, type: 'select', options: applicatorOptions }
                  : field;
                return (
                <div key={field.key}>
                  {field.section && field.section !== typeCfg.findingsFields[fieldIndex - 1]?.section && (
                    <div style={sectionHeaderStyle}>{field.section}</div>
                  )}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 6,
                    ...(field.key === 'previous_treatment_notes' ? { flexWrap: 'wrap' } : {}),
                  }}>
                    {/* A field whose label IS its section name (the applications
                        repeater) would stutter under the section header. */}
                    {field.label !== field.section && (
                      <label style={{ ...labelStyle, marginBottom: 0 }}>{field.label}</label>
                    )}
                    {projectType === 'wdo_inspection' && field.key === 'property_address' && formatCustomerAddress(selectedCustomer) && (
                      <button
                        type="button"
                        onClick={fillWdoAddressFromCustomer}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: P.accent,
                          fontSize: 11,
                          fontWeight: wStrong,
                          cursor: 'pointer',
                          padding: 0,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Fill from customer
                      </button>
                    )}
                    {projectType === 'wdo_inspection' && field.key === 'previous_treatment_notes' && (
                      /* Both sources feed the exact same extraction + evidence
                         queue. `capture` belongs only on Camera; applying it to
                         the sole input forced iOS to skip the photo library. */
                      <div style={{ display: 'flex', gap: 10, marginLeft: 'auto' }}>
                        {[
                          { label: 'Camera', source: 'camera', capture: 'environment' },
                          { label: 'Library', source: 'library' },
                        ].map((option) => (
                        <label
                          key={option.source}
                          style={{
                          background: 'transparent',
                          border: 'none',
                          color: P.accent,
                          fontSize: 11,
                          fontWeight: wStrong,
                          cursor: (saving || aiWriting || treatmentExtract.status === 'working') ? 'default' : 'pointer',
                          opacity: (saving || aiWriting || treatmentExtract.status === 'working') ? 0.55 : 1,
                          padding: 0,
                          whiteSpace: 'nowrap',
                          }}
                        >
                          {treatmentExtract.status === 'working' ? 'Reading…' : option.label}
                          <input
                            type="file"
                            accept="image/*"
                            {...(option.capture ? { capture: option.capture } : {})}
                            data-wdo-prior-treatment-source={option.source}
                            disabled={saving || aiWriting || treatmentExtract.status === 'working'}
                            onChange={(e) => {
                              const f = e.target.files?.[0] || null;
                              e.target.value = '';
                              if (f) handleTreatmentPhotoExtract(f);
                            }}
                            style={{ display: 'none' }}
                          />
                        </label>
                        ))}
                      </div>
                    )}
                    {projectType !== 'wdo_inspection' && field.key === addressFieldKey && formatCustomerAddress(selectedCustomer) && (
                      <button
                        type="button"
                        onClick={fillAddressFromCustomer}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: P.accent,
                          fontSize: 11,
                          fontWeight: wStrong,
                          cursor: 'pointer',
                          padding: 0,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Fill from customer
                      </button>
                    )}
                  </div>
                  <ProjectFindingFieldInput
                    field={renderField}
                    id={`create-project-${projectType}-${field.key}`}
                    name={`findings.${field.key}`}
                    value={isApplicatorPicker
                      // The picker's value is the matched technician id; an
                      // unmatched name+ID pair shows as the raw name via the
                      // select's injected current-value option.
                      ? (selectedApplicator ? selectedApplicator.id : (findings.applicator_name || ''))
                      : (findings[field.key] || '')}
                    onChange={(value) => (
                      isApplicatorPicker ? handleApplicatorChange(value) : handleFindingChange(field.key, value)
                    )}
                    inputStyle={inputStyle}
                    products={productCatalog}
                    onProductSelect={(product) => handleProductSelect(field.key, product)}
                    palette={P}
                    appearance={theme}
                  />
                  {field.key === 'previous_treatment_notes' && treatmentExtract.message && (
                    <div style={{ fontSize: 11, color: treatmentExtract.status === 'error' ? P.red : P.muted, marginTop: 6 }}>
                      {treatmentExtract.message}
                    </div>
                  )}
                  {field.key === 'product_name' && chemAuto?.status === 'not_applicable' && chemAuto.note && (
                    <div style={{ fontSize: 11, color: P.muted, marginTop: 6 }}>{chemAuto.note}</div>
                  )}
                  {field.key === 'concentration_pct' && chemAuto?.status === 'ok' && (
                    <div style={{ fontSize: 11, color: P.muted, marginTop: 6 }}>
                      Auto-filled with the label&apos;s standard pre-construction dilution — overtype to record a different labeled rate.
                    </div>
                  )}
                  {field.key === 'gallons_applied' && chemAuto?.status === 'ok' && chemAuto.note && (
                    <div style={{ fontSize: 11, color: P.muted, marginTop: 6 }}>
                      Auto-calculated: {chemAuto.note}.
                    </div>
                  )}
                  {(field.key === 'concentration_pct' || field.key === 'gallons_applied') && chemAuto?.status === 'not_applicable' && (
                    <div style={{ fontSize: 11, color: P.muted, marginTop: 6 }}>
                      Not applicable for this product — kept blank on the certificate.
                    </div>
                  )}
                </div>
                );
              })}

              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>Recommendations / notes</label>
                  {allowAiDraft && (
                    <button
                      type="button"
                      onClick={handleAiDraft}
                      disabled={aiWriting || saving || !projectType}
                      style={{
                        padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: wStrong,
                        background: theme === 'light' ? P.card : P.bg,
                        color: P.text, border: `1px solid ${P.border}`,
                        cursor: (aiWriting || saving || !projectType) ? 'default' : 'pointer',
                        opacity: (aiWriting || saving || !projectType) ? 0.55 : 1,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {aiWriting ? 'Drafting...' : 'AI draft'}
                    </button>
                  )}
                </div>
                {allowAiDraft && (
                  <label style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    margin: '0 0 8px',
                    fontSize: 11,
                    color: P.muted,
                  }}>
                    <input
                      name="ai_include_communications"
                      type="checkbox"
                      checked={aiUseComms}
                      onChange={(e) => setAiUseComms(e.target.checked)}
                    />
                    Include recent customer calls/texts/emails in AI draft
                  </label>
                )}
                <div style={{ position: 'relative' }}>
                  <textarea
                    value={recommendations}
                    onChange={(e) => setRecommendations(e.target.value)}
                    rows={6}
                    placeholder="Write raw notes, or use AI draft to create the client-facing report sections."
                    style={{ ...inputStyle, resize: 'vertical', minHeight: 132, paddingRight: 44 }}
                  />
                  <div style={{ position: 'absolute', right: 8, bottom: 8 }}>
                    <DictationButton
                      palette={P}
                      onAppend={(text) => {
                        userDirtyRef.current = true;
                        setRecommendations(prev => prev.trim() ? `${prev.replace(/\s+$/, '')} ${text}` : text);
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* Photos */}
              <div>
                <label style={labelStyle}>Photos (optional)</label>
                <PhotoQueue
                  queue={photoQueue}
                  setQueue={setPhotoQueue}
                  categories={typeCfg.photoCategories}
                  onAdd={queuePhoto}
                  palette={P}
                  inputStyle={inputStyle}
                  theme={theme}
                />
              </div>
            </>
          )}

          {error && (
            <div style={{ padding: '8px 12px', background: `${P.red}22`, border: `1px solid ${P.red}`, borderRadius: 8, color: P.red, fontSize: 13 }}>
              {error}
            </div>
          )}

          {saving && uploadProgress.total > 0 && (
            <div style={{ fontSize: 12, color: P.muted }}>
              Uploading photos… {uploadProgress.done} / {uploadProgress.total}
            </div>
          )}
        </div>

        {/* Footer — pinned action bar in sheet mode, like the completion */}
        <div style={{
          padding: isEstimateStyle ? '16px 24px 20px' : '12px 16px',
          borderTop: `1px solid ${P.border}`,
          background: P.card,
          display: 'flex', gap: 10, justifyContent: 'flex-end',
          ...(isSheet ? { paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' } : {}),
        }}>
          <button
            type="button"
            onClick={() => !saving && onClose?.()}
            disabled={saving}
            style={{
              minHeight: isEstimateStyle ? 48 : undefined,
              padding: isEstimateStyle ? '0 18px' : '10px 16px',
              borderRadius: isEstimateStyle ? 10 : 8,
              fontSize: isEstimateStyle ? 14 : 13,
              fontWeight: wMed,
              background: isEstimateStyle ? P.card : 'transparent',
              border: `1px solid ${P.border}`,
              color: P.text, cursor: saving ? 'default' : 'pointer',
            }}
          >Cancel</button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !projectType || !customerId || treatmentExtract.status === 'working'}
            style={{
              minHeight: isEstimateStyle || isSheet ? 48 : undefined,
              padding: isEstimateStyle ? '0 18px' : '10px 18px',
              borderRadius: isEstimateStyle ? 10 : 8,
              fontSize: isEstimateStyle ? 14 : 13,
              fontWeight: wStrong,
              background: (!projectType || !customerId || treatmentExtract.status === 'working') ? P.muted : P.accent,
              color: P.accentText, border: 'none',
              cursor: (saving || !projectType || !customerId || treatmentExtract.status === 'working') ? 'default' : 'pointer',
              ...(isSheet ? { flex: 1 } : {}),
            }}
          >{saving
            ? 'Saving…'
            : treatmentExtract.status === 'working'
              ? 'Reading photo…'
              : isSheet
                ? projectType === PRE_TREATMENT_CERTIFICATE_TYPE ? 'Save Certificate' : 'Save Report'
                : 'Save Draft'}</button>
        </div>
        </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function PhotoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

function PhotoQueue({ queue, setQueue, categories, onAdd, palette: P, inputStyle, theme }) {
  const [selectedCategory, setSelectedCategory] = useState(categories?.[0] || '');

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    files.forEach(f => onAdd(f, selectedCategory));
    e.target.value = '';
  }

  function removeItem(id) {
    setQueue(q => q.filter(item => item.id !== id));
  }

  function updateCaption(id, caption) {
    const bounded = String(caption || '').slice(0, PHOTO_CAPTION_MAX);
    setQueue(q => q.map(item => (
      item.id === id ? { ...item, caption: bounded, generatedCaption: undefined } : item
    )));
  }

  const addButtonStyle = {
    flex: 1,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '10px 12px', borderRadius: 8, background: P.accent, color: P.accentText,
    fontSize: 12, fontWeight: theme === 'light' ? 500 : 700, cursor: 'pointer', whiteSpace: 'nowrap',
  };
  const libraryButtonStyle = {
    ...addButtonStyle,
    background: theme === 'light' ? P.card : P.bg,
    color: P.text,
    border: `1px solid ${P.border}`,
  };

  return (
    <div>
      <select
        value={selectedCategory}
        onChange={(e) => setSelectedCategory(e.target.value)}
        style={{ ...inputStyle, width: '100%', padding: '8px 10px', fontSize: 12, marginBottom: 8 }}
      >
        {categories.map(cat => (
          <option key={cat} value={cat}>{cat.replace(/_/g, ' ')}</option>
        ))}
      </select>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {/* Take a photo — opens the camera directly on mobile */}
        <label style={addButtonStyle}>
          <PhotoIcon /> Camera
          <input
            type="file"
            accept="image/*"
            multiple
            capture="environment"
            onChange={handleFiles}
            style={{ display: 'none' }}
          />
        </label>
        {/* Choose from photo library — no capture attribute so the gallery opens */}
        <label style={libraryButtonStyle}>
          <LibraryIcon /> Library
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={handleFiles}
            style={{ display: 'none' }}
          />
        </label>
      </div>

      {queue.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {queue.map(item => (
            <div key={item.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', borderRadius: 6,
              background: P.bg, border: `1px solid ${P.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: P.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.file.name}
                </div>
                <div style={{ fontSize: 10, color: P.muted }}>
                  {item.category.replace(/_/g, ' ')} · {(item.file.size / 1024).toFixed(0)} KB
                </div>
                <input
                  type="text"
                  value={item.caption || ''}
                  maxLength={PHOTO_CAPTION_MAX}
                  onChange={(e) => updateCaption(item.id, e.target.value)}
                  placeholder="Describe what this shows and where"
                  aria-label={`Photo description for ${item.file.name}`}
                  style={{
                    ...inputStyle,
                    width: '100%',
                    marginTop: 6,
                    padding: '7px 9px',
                    fontSize: 11,
                  }}
                />
              </div>
              <button
                type="button"
                onClick={() => removeItem(item.id)}
                style={{
                  background: 'transparent', border: 'none', color: P.muted,
                  cursor: 'pointer', fontSize: 16, padding: '0 6px',
                }}
                aria-label="Remove"
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
