import { useEffect, useMemo, useRef, useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';
import WdoIntelligenceBar from './WdoIntelligenceBar';
import { applyProfileToWdoFindings, applyHistoryToWdoFindings } from '../../lib/wdoProfileToFindings';
import { computePretreatChemistry } from '../../lib/termitePretreatRates';
import ProjectFindingFieldInput, { hasCatalogBackedProjectFields } from './ProjectFindingFieldInput';
import DictationButton from './DictationButton';

const ESTIMATE_BG = '#FFFFFF';
const ESTIMATE_BORDER = '#E4E4E7';
const ESTIMATE_INPUT_BORDER = '#D4D4D8';
const ESTIMATE_INPUT_BG = '#FFFFFF';
const ESTIMATE_TEXT = '#09090B';
const ESTIMATE_MUTED = '#71717A';
const ESTIMATE_BUTTON_BG = '#09090B';

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

function hasMeaningfulValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
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

// Populate the WDO contact/address fields from the selected customer. With
// overwrite=false (on selection) only blank fields are filled so typed values
// are preserved; the explicit "Fill from customer" button passes overwrite=true.
function applyCustomerToWdoFindings(prev, customer, overwrite = false) {
  const address = formatCustomerAddress(customer);
  const contact = formatCustomerContact(customer);
  const structures = formatStructuresInspected(customer);
  const next = { ...prev };
  if (address && (overwrite || !hasMeaningfulValue(next.property_address))) next.property_address = address;
  if (contact && (overwrite || !hasMeaningfulValue(next.requested_by))) next.requested_by = contact;
  if (contact && (overwrite || !hasMeaningfulValue(next.report_sent_to))) next.report_sent_to = contact;
  if (structures && (overwrite || !hasMeaningfulValue(next.structures_inspected))) next.structures_inspected = structures;
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
  defaultProjectType = '',
  allowedProjectTypes = null,
  allowAiDraft = false,
  theme = 'dark',
}) {
  const P = PALETTES[theme] || PALETTES.dark;
  const isEstimateStyle = theme === 'light';
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
    fontWeight: 800,
    color: P.muted,
    textTransform: 'uppercase',
    letterSpacing: isEstimateStyle ? '0.12em' : 1,
    marginBottom: 8,
  };

  const [typesRegistry, setTypesRegistry] = useState(null);
  const [productCatalog, setProductCatalog] = useState([]);
  const [projectType, setProjectType] = useState(defaultProjectType || '');
  const [customerId, setCustomerId] = useState(defaultCustomerId || '');
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
  const [projectDate, setProjectDate] = useState(
    defaultProjectDate || (defaultServiceRecordId || defaultScheduledServiceId ? '' : todayDateInput())
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
  useEffect(() => {
    // Stop once the project exists on the server — the server draft is then
    // the source of truth and a local draft would risk a duplicate on restore.
    if (!draftReadyRef.current || showDraftPrompt || createdProject) return;
    const hasContent = Boolean(
      projectType
      || customerId
      || (title && title.trim())
      || (recommendations && recommendations.trim())
      || Object.values(findings).some((v) => String(v || '').trim()),
    );
    if (!hasContent) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({
          savedAt: new Date().toISOString(),
          projectType, customerId, customerLabel, projectDate, title, findings, recommendations,
        }));
      } catch { /* quota / serialization — non-blocking */ }
    }, 700);
    return () => clearTimeout(timer);
  }, [draftKey, showDraftPrompt, createdProject, projectType, customerId, customerLabel, projectDate, title, findings, recommendations]);

  function restoreDraft() {
    const d = savedDraft;
    if (!d) return;
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
  // now — they're not creatable as projects (server 422s them too). An
  // explicit allowedProjectTypes prop (the special-project dispatch path)
  // still wins so WDO/pre-treat routing keeps working.
  const visibleTypes = typesRegistry
    ? Object.entries(typesRegistry).filter(([key, cfg]) => (
      allowedProjectTypes ? allowedProjectTypes.includes(key) : !cfg?.appointmentManaged
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
    setFindings(prev => ({ ...prev, [key]: value }));
  }

  function handleApplicatorChange(value) {
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
    setFindings(prev => mergeSuggestionsIntoFindings(prev, suggestions, options.overwrite));
  }

  function applyWdoProfile(profile) {
    setFindings(prev => applyProfileToWdoFindings(prev, profile, { overwrite: true }));
  }

  function applyWdoHistory(history) {
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
      if (data.report) setRecommendations(data.report.trim());
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
      if (svc.scheduledDate) setProjectDate(String(svc.scheduledDate).slice(0, 10));
    } catch { /* non-blocking: tech can still fill these in manually */ }
  }

  function queuePhoto(file, category) {
    setPhotoQueue(prev => [...prev, { file, category, caption: '', id: `q_${Date.now()}_${prev.length}` }]);
  }

  async function handleSave() {
    if (!projectType) return setError('Pick a project type');
    if (!customerId) return setError('Pick a customer');
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
      if (onCreated) onCreated(data.project);
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 200, background: isEstimateStyle ? 'rgba(9, 9, 11, 0.42)' : 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        overflowY: 'auto', padding: isEstimateStyle ? '24px 0' : '12px 0',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose?.(); }}
    >
      <div style={{
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
              fontWeight: 800,
              color: P.heading,
              fontFamily: P.bodyFont,
              letterSpacing: 0,
              textTransform: 'none',
            }}>
              Create Project Report
            </div>
            <div style={{
              fontSize: isEstimateStyle ? 12 : 11,
              color: P.muted,
              marginTop: 3,
              fontFamily: P.bodyFont,
              fontWeight: 500,
              lineHeight: 1.35,
            }}>
              {projectType === 'wdo_inspection'
                ? 'Wood Destroying Organism (WDO) Inspection Report'
                : 'Inspection or documentation-heavy job'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => !saving && onClose?.()}
            aria-label="Close"
            style={{
              background: 'transparent', border: 'none', color: P.muted,
              fontSize: 24, cursor: 'pointer', padding: '4px 10px',
            }}
          >×</button>
        </div>

        {/* Body */}
        <div style={{ padding: isEstimateStyle ? 22 : 16, display: 'flex', flexDirection: 'column', gap: isEstimateStyle ? 16 : 16 }}>
          {/* Restore saved draft */}
          {showDraftPrompt && (
            <div style={{
              background: theme === 'light' ? P.card : P.bg,
              border: `1px solid ${P.accent}`,
              borderRadius: 10, padding: 12,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: P.heading }}>
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
                    padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 800,
                    background: P.accent, color: P.accentText, border: 'none', cursor: 'pointer',
                  }}
                >Restore</button>
                <button
                  type="button"
                  onClick={discardDraft}
                  style={{
                    padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                    background: 'transparent', color: P.text, border: `1px solid ${P.border}`, cursor: 'pointer',
                  }}
                >Discard</button>
              </div>
            </div>
          )}

          {/* Project type */}
          <div>
            <label style={labelStyle}>Project type *</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {visibleTypes.map(([key, cfg]) => {
                const active = projectType === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => { setProjectType(key); setFindings({}); setRecommendations(''); }}
                    style={{
                      padding: '10px 10px', borderRadius: 8, cursor: 'pointer',
                      background: active ? P.accent : (theme === 'light' ? P.bg : P.bg),
                      color: active ? P.accentText : P.text,
                      border: `1px solid ${active ? P.accent : P.border}`,
                      fontSize: 12, fontWeight: 700, textAlign: 'left',
                    }}
                  >
                    {cfg.short || cfg.label}
                  </button>
                );
              })}
            </div>
              {typeCfg?.description && (
                <div style={{ fontSize: 11, color: P.muted, marginTop: 6 }}>{typeCfg.description}</div>
              )}
              {projectType === 'wdo_inspection' && (
                <a
                  href="/forms/fdacs-13645-wdo-inspection-report.pdf"
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'inline-block', marginTop: 8, fontSize: 12, fontWeight: 800, color: P.accent }}
                >
                  Open FDACS-13645 form
                </a>
              )}
            </div>

          {/* Customer */}
          <div>
            <label style={labelStyle}>Customer *</label>
            {customerId ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', background: theme === 'light' ? P.bg : P.bg, borderRadius: 8,
                border: `1px solid ${P.border}`,
              }}>
                <span style={{ fontSize: 13, color: P.text }}>{customerLabel || customerId}</span>
                <button
                  type="button"
                  onClick={() => { setCustomerId(''); setCustomerLabel(''); setCustomerQuery(''); setSelectedCustomer(null); prefillCustomerRef.current = null; clearWdoFindingsFromCustomer(); }}
                  style={{ background: 'transparent', border: 'none', color: P.muted, fontSize: 12, cursor: 'pointer' }}
                >Change</button>
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
                        <div style={{ fontWeight: 700 }}>
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
              <div>
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
                        <div style={{ fontSize: 13, fontWeight: 800 }}>{s.name}</div>
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
                  style={inputStyle}
                />
              </div>

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

              {typeCfg.findingsFields.map(field => {
                // The applicator must be one of our licensed techs — swap the
                // free-text field for a dropdown of active technicians once
                // the list loads (free text remains the offline fallback).
                const isApplicatorPicker = field.key === 'applicator_name' && applicators.length > 0;
                const renderField = isApplicatorPicker
                  ? { ...field, type: 'select', options: applicatorOptions }
                  : field;
                return (
                <div key={field.key}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                    <label style={{ ...labelStyle, marginBottom: 0 }}>{field.label}</label>
                    {projectType === 'wdo_inspection' && field.key === 'property_address' && formatCustomerAddress(selectedCustomer) && (
                      <button
                        type="button"
                        onClick={fillWdoAddressFromCustomer}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: P.accent,
                          fontSize: 11,
                          fontWeight: 800,
                          cursor: 'pointer',
                          padding: 0,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Fill from customer
                      </button>
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
                          fontWeight: 800,
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
                  />
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
                        padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: 800,
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
                      onAppend={(text) => setRecommendations(prev => prev.trim() ? `${prev.replace(/\s+$/, '')} ${text}` : text)}
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

        {/* Footer */}
        <div style={{
          padding: isEstimateStyle ? '16px 24px 20px' : '12px 16px',
          borderTop: `1px solid ${P.border}`,
          background: P.card,
          display: 'flex', gap: 10, justifyContent: 'flex-end',
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
              fontWeight: 700,
              background: isEstimateStyle ? P.card : 'transparent',
              border: `1px solid ${P.border}`,
              color: P.text, cursor: saving ? 'default' : 'pointer',
            }}
          >Cancel</button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !projectType || !customerId}
            style={{
              minHeight: isEstimateStyle ? 48 : undefined,
              padding: isEstimateStyle ? '0 18px' : '10px 18px',
              borderRadius: isEstimateStyle ? 10 : 8,
              fontSize: isEstimateStyle ? 14 : 13,
              fontWeight: 800,
              background: (!projectType || !customerId) ? P.muted : P.accent,
              color: P.accentText, border: 'none',
              cursor: (saving || !projectType || !customerId) ? 'default' : 'pointer',
            }}
          >{saving ? 'Saving…' : 'Save Draft'}</button>
        </div>
      </div>
    </div>
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

  const addButtonStyle = {
    flex: 1,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '10px 12px', borderRadius: 8, background: P.accent, color: P.accentText,
    fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
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
