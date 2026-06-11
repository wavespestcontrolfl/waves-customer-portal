import { useEffect, useRef, useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';
import WdoIntelligenceBar from './WdoIntelligenceBar';
import { applyProfileToWdoFindings, applyHistoryToWdoFindings } from '../../lib/wdoProfileToFindings';
import ProjectFindingFieldInput, { hasCatalogBackedProjectFields } from './ProjectFindingFieldInput';
import DictationButton from './DictationButton';

const ESTIMATE_BG = '#FAF8F3';
const ESTIMATE_BORDER = '#E7E2D7';
const ESTIMATE_INPUT_BORDER = '#CFE7F5';
const ESTIMATE_INPUT_BG = '#F8FCFE';
const ESTIMATE_TEXT = '#1B2C5B';
const ESTIMATE_MUTED = '#6B7280';
const ESTIMATE_BUTTON_BG = '#1B2C5B';

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
    headingFont: "'Source Serif 4', Georgia, serif",
    bodyFont: "'Inter', system-ui, sans-serif",
  },
};

const QUICK_ACTIONS = {
  wdo_inspection: [
    {
      label: 'Clean WDO',
      title: 'FDACS WDO Inspection Report',
      findings: {
        inspection_scope: 'Visible and readily accessible interior areas, attic access, garage, exterior perimeter, and accessible structural components.',
        wdo_finding: 'No visible signs of WDO observed',
        previous_treatment_evidence: 'No',
        treated_at_inspection: 'No',
        treatment_method: 'Not applicable',
      },
      prefix: 'Finding',
      note: 'No visible evidence of active wood-destroying organisms was observed at the time of inspection.',
    },
    {
      label: 'Inaccessible area',
      findings: { inaccessible_areas: 'Specific area: \nReason: Obstructed or inaccessible at the time of inspection.' },
      prefix: 'Limitation',
      note: 'The listed area was obstructed or inaccessible, so no information on WDO status or WDO damage is provided for that area.',
    },
    {
      label: 'Evidence found',
      findings: {
        wdo_finding: 'Visible evidence of WDO observed',
        wdo_evidence: 'Evidence observed. Add common name, description, and exact location.',
      },
      prefix: 'Finding',
      note: 'Visible evidence of wood-destroying organisms was observed and should be reviewed with the specific organism, description, and location notes.',
    },
    {
      label: 'Treatment noted',
      findings: {
        previous_treatment_evidence: 'Yes',
        previous_treatment_notes: 'Evidence of previous treatment was observed. Add visible treatment indicators and location.',
      },
      prefix: 'Treatment',
      note: 'Evidence of previous treatment was observed. The company that performed that treatment should be contacted for treatment history and warranty information.',
    },
  ],
  termite_inspection: [
    {
      label: 'No activity',
      findings: { termite_type: 'None observed', activity_status: 'No activity' },
      prefix: 'Finding',
      note: 'No visible termite activity was observed in the accessible areas inspected today.',
    },
    {
      label: 'Active activity',
      findings: { activity_status: 'Active infestation' },
      prefix: 'Finding',
      note: 'Active termite activity was observed. Treatment should be quoted based on species, location, and extent.',
    },
    {
      label: 'Monitor',
      prefix: 'Next',
      note: 'Monitor the noted areas and schedule follow-up if new tubes, frass, wings, or damaged wood appear.',
    },
  ],
  pest_inspection: [
    {
      label: 'Light activity',
      findings: { severity: 'Low' },
      prefix: 'Finding',
      note: 'Light pest activity was noted in limited areas. A targeted treatment plan should be sufficient based on today\'s findings.',
    },
    {
      label: 'Sanitation',
      prefix: 'Condition',
      note: 'Improve sanitation, storage, or moisture conditions in the noted areas to reduce pest pressure.',
    },
    {
      label: 'Treat entry points',
      prefix: 'Next',
      note: 'Focus treatment around entry points, harborage areas, and activity zones identified during the inspection.',
    },
  ],
  flea: [
    {
      label: 'Light activity',
      findings: { evidence_level: 'Low' },
      prefix: 'Finding',
      note: 'Light flea activity was documented. Treatment performance depends on treating active areas and keeping vacuuming and pet flea control consistent.',
    },
    {
      label: 'Prep needed',
      prefix: 'Next',
      note: 'Customer prep is needed: vacuum floors and furniture edges, wash pet bedding on high heat, and coordinate pet flea prevention with a veterinarian.',
    },
    {
      label: 'Follow-up',
      prefix: 'Next',
      note: 'A follow-up may be needed because flea eggs and pupae can continue emerging after the initial treatment cycle.',
    },
  ],
  rodent_exclusion: [
    {
      label: 'Entry points',
      prefix: 'Finding',
      note: 'Potential rodent entry points were identified and should be sealed after activity is reduced.',
    },
    {
      label: 'Traps set',
      prefix: 'Action',
      note: 'Traps were placed in activity zones. Follow-up is needed to check activity and adjust placement.',
    },
    {
      label: 'Exclusion done',
      prefix: 'Action',
      note: 'Exclusion work was completed in the accessible areas noted in the report.',
    },
  ],
  bed_bug: [
    {
      label: 'Low evidence',
      findings: { evidence_level: 'Low (few bugs)' },
      prefix: 'Finding',
      note: 'Low-level bed bug evidence was observed in the inspected areas.',
    },
    {
      label: 'Prep needed',
      prefix: 'Next',
      note: 'Customer prep is needed before the follow-up visit: reduce clutter, launder bedding on high heat, and keep treated rooms accessible.',
    },
    {
      label: '14-day follow-up',
      prefix: 'Next',
      note: 'A follow-up visit should be completed in approximately 14 days to reassess activity and treat remaining harborage areas if needed.',
    },
  ],
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
  return [formatCustomerName(customer), customer.phone || '', customer.email || '']
    .filter(Boolean)
    .join(' · ');
}

// Default structure description from the customer's property type, falling back
// to single-family residential (the common case / sample report wording).
function formatStructuresInspected(customer) {
  const type = String(customer?.property_type || customer?.propertyType || '').toLowerCase();
  if (type.includes('commercial') || type.includes('business')) return 'Commercial structure';
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

function mergeSuggestionsIntoFindings(current, suggestions, overwrite = false) {
  const allowed = [
    'property_address',
    'structures_inspected',
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
  // What was last auto-filled into the WDO findings from the selected
  // customer — on a customer change, values still matching this map are
  // cleared so the previous customer's address/contacts never carry over
  // onto the new customer's FDACS-13645 form.
  const wdoAutoFillRef = useRef(null);
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
    if (projectType !== 'wdo_inspection') return;
    if (!selectedCustomer) return;
    // Seamlessly fill address + requested-by + report-sent-to from the picked
    // customer, without clobbering anything the tech already typed.
    setFindings(prev => applyCustomerToWdoFindings(prev, selectedCustomer, false));
    wdoAutoFillRef.current = customerWdoAutoFillValues(selectedCustomer);
  }, [projectType, selectedCustomer]);

  function handleFindingChange(key, value) {
    setFindings(prev => ({ ...prev, [key]: value }));
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

  function appendRecommendation(prefix, text) {
    const line = `[${prefix}] ${text}`;
    setRecommendations(prev => prev.trim() ? `${prev.trimEnd()}\n${line}` : line);
  }

  function applyQuickAction(action) {
    if (action.findings) {
      setFindings(prev => ({ ...prev, ...action.findings }));
    }
    if (action.note) appendRecommendation(action.prefix || 'Note', action.note);
    if (action.title && !title.trim()) setTitle(action.title);
  }

  function fillWdoAddressFromCustomer() {
    if (!selectedCustomer) return;
    // Explicit action — overwrite address + contact fields from the customer.
    setFindings(prev => applyCustomerToWdoFindings(prev, selectedCustomer, true));
  }

  // Called when the tech un-picks the customer ("Change"): drop the WDO fields
  // that still hold the previous customer's auto-filled values, keeping
  // anything hand-typed that differs, so re-selecting blank-fills from the new
  // customer instead of keeping the old property's address/contacts.
  function clearWdoFindingsFromCustomer() {
    const lastApplied = wdoAutoFillRef.current;
    wdoAutoFillRef.current = null;
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
        position: 'fixed', inset: 0, zIndex: 200, background: isEstimateStyle ? 'rgba(15, 23, 42, 0.42)' : 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        overflowY: 'auto', padding: isEstimateStyle ? '28px 0' : '12px 0',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose?.(); }}
    >
      <div style={{
        width: '100%', maxWidth: isEstimateStyle ? 720 : 520, margin: '0 12px',
        background: isEstimateStyle ? P.bg : P.card,
        border: `1px solid ${P.border}`,
        borderRadius: isEstimateStyle ? 16 : 14,
        display: 'flex', flexDirection: 'column',
        boxShadow: isEstimateStyle ? '0 24px 60px rgba(27, 44, 91, 0.22)' : undefined,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: isEstimateStyle ? '20px 24px' : '14px 16px',
          borderBottom: `1px solid ${P.border}`,
          background: P.card,
        }}>
          <div>
            <div style={{
              fontSize: isEstimateStyle ? 12 : 16,
              fontWeight: 800,
              color: isEstimateStyle ? P.muted : P.heading,
              fontFamily: P.bodyFont,
              letterSpacing: isEstimateStyle ? '0.12em' : 0,
              textTransform: isEstimateStyle ? 'uppercase' : 'none',
            }}>
              Create Project Report
            </div>
            <div style={{
              fontSize: isEstimateStyle ? 30 : 11,
              color: P.heading,
              marginTop: isEstimateStyle ? 4 : 2,
              fontFamily: isEstimateStyle ? P.headingFont : P.bodyFont,
              fontWeight: isEstimateStyle ? 500 : 400,
              lineHeight: 1.1,
            }}>
              Inspection or documentation-heavy job
            </div>
          </div>
          {isEstimateStyle && <img src="/waves-logo.png" alt="Waves" style={{ height: 28, display: 'block' }} />}
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
        <div style={{ padding: isEstimateStyle ? 24 : 16, display: 'flex', flexDirection: 'column', gap: isEstimateStyle ? 18 : 16 }}>
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
                          if (projectType === 'wdo_inspection') {
                            setFindings(prev => applyCustomerToWdoFindings(prev, c, false));
                          }
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
                <label style={labelStyle}>Inspection / project date</label>
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

              {typeCfg.findingsFields.map(field => (
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
                  </div>
                  <ProjectFindingFieldInput
                    field={field}
                    id={`create-project-${projectType}-${field.key}`}
                    name={`findings.${field.key}`}
                    value={findings[field.key] || ''}
                    onChange={(value) => handleFindingChange(field.key, value)}
                    inputStyle={inputStyle}
                    products={productCatalog}
                    onProductSelect={(product) => handleProductSelect(field.key, product)}
                    palette={P}
                  />
                </div>
              ))}

              <QuickProjectActions
                projectType={projectType}
                palette={P}
                onPick={applyQuickAction}
              />

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
                    placeholder="Tap quick actions, write raw notes, or use AI draft to create the client-facing report sections."
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
              background: isEstimateStyle ? '#fff' : 'transparent',
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

function QuickProjectActions({ projectType, palette: P, onPick }) {
  const actions = QUICK_ACTIONS[projectType] || [];
  if (!actions.length) return null;
  return (
    <div>
      <label style={{
        display: 'block',
        fontSize: 12,
        fontWeight: 700,
        color: P.muted,
        textTransform: 'uppercase',
        letterSpacing: 1,
        marginBottom: 6,
      }}>Quick actions</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {actions.map(action => (
          <button
            key={action.label}
            type="button"
            onClick={() => onPick(action)}
            style={{
              padding: '7px 10px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 800,
              background: P.bg,
              color: P.text,
              border: `1px solid ${P.border}`,
              cursor: 'pointer',
            }}
          >
            {action.label}
          </button>
        ))}
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

      {queue.length === 0 ? (
        <div style={{ fontSize: 11, color: P.muted, padding: '10px 0' }}>
          No photos yet — pick a category, then Camera or Library.
        </div>
      ) : (
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
