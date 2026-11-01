import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Input, Select, Switch, Textarea, Badge, Card, CardHeader, CardTitle, CardBody } from '../../components/ui';
import {
  ArrowLeft, Plus, Trash2, Download, Building2, Loader2,
  Send as SendIcon, Link as LinkIcon, CheckCircle2, Copy,
  ClipboardList, ChevronDown, ChevronUp, Wand2,
} from 'lucide-react';
import AdminCommandHeader from '../../components/admin/AdminCommandHeader';
import ProposalBidForm from '../../components/estimates/ProposalBidForm';
import { EstimateSendProvider, useEstimateSend } from '../../components/admin/EstimateSendDialog';
import ProposalProjectCosting from '../../components/estimates/ProposalProjectCosting';
import { PROPOSAL_UNITS, proposalLineAmount, proposalRevenueIssue } from '@proposal-bid';
import { AGREEMENT_TERMS, AUTOPAY_PAYMENT_TERMS, INVOICE_PAYMENT_TERMS, NET60_PAYMENT_TERMS, normalizeTermText } from '@commercial-agreement-terms';
import { formatETDateTime } from '../../lib/timezone';
import useIsMobile from '../../hooks/useIsMobile';

// Commercial proposal builder — the full-page surface for authoring the
// multi-building, per-line-item commercial bid on an estimate (HOAs,
// property managers, offices). Same server model as the estimates-list
// modal it grew out of: GET/PUT /admin/estimates/:id/proposal is the
// single source of truth, and saving recomputes the estimate's
// authoritative totals so the manual-quote commercial estimate becomes
// sendable with the branded PDF attached.
//
// Tier 1 surface: components/ui primitives + Tailwind zinc ramp only.

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      let serverMsg = '';
      try {
        const body = await r.clone().json();
        serverMsg = body?.error || '';
      } catch {
        try { serverMsg = await r.text(); } catch { /* ignore */ }
      }
      throw new Error(serverMsg || `HTTP ${r.status}`);
    }
    return r.json();
  });
}

// Mirrors server estimate-proposal.js FREQUENCIES / OCCURRENCES_PER_YEAR.
const FREQUENCY_OPTIONS = [
  { value: 'monthly', label: 'Monthly', perYear: 12 },
  { value: 'bimonthly', label: 'Every 2 months', perYear: 6 },
  { value: 'quarterly', label: 'Quarterly', perYear: 4 },
  { value: 'annual', label: 'Annual', perYear: 1 },
  { value: 'one_time', label: 'One-time', perYear: 0 },
];
const PER_YEAR = Object.fromEntries(FREQUENCY_OPTIONS.map((f) => [f.value, f.perYear]));

const money = (n) =>
  `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// `tax`: the Taxable fields a row the operator adds starts with, from the building use (taxUnderUse in the editor).
const emptyLine = (tax = {}) => ({
  id: crypto.randomUUID(), description: '', quantity: 1, unit: '', unitPrice: 0, frequency: 'monthly', taxable: false, ...tax,
});
const emptyBuilding = (i, tax) => ({ name: `Building ${i + 1}`, note: '', lineItems: [emptyLine(tax)] });

// Building use decides Florida sales tax on pest work (Rule 12A-1.009): homes, apartments, condos and their common
// areas are residential and not taxed, whoever pays; a business building is taxed (owner 2026-10-28, proposal
// defaults check). The pick is required before saving.
const BUILDING_USE_OPTIONS = [
  { value: 'residential', label: 'Homes or residential community', note: 'Homes, apartments, condos and HOA common areas. Florida does not tax pest work here.' },
  { value: 'nonresidential', label: 'Business building', note: 'Offices, stores, restaurants and warehouses. Pest work is taxable; lawn and tree & shrub are not.' },
];
const BUILDING_USE_REQUIRED = 'Pick the building use before saving: homes or residential community, or business building. It sets which rows carry sales tax.';
// A row's Taxable rule for a business building, from the served family registry: its service family's rule, or the
// 'other' rule for a row with no service. Undefined for a service the registry does not list (a generated one-time
// line), whose switch then stays as it is.
function serviceTaxRule(registry, service) {
  const entry = registry?.[service || 'other'];
  return entry ? entry.taxable === true : undefined;
}

// Visit bills follow the customer's building use and the service, never a row's Taxable box (a proposal win makes no
// invoice since PR #7115; tax-calculator.js step 1b). The box still sets the quote and the signed agreement, so a row
// whose box differs from what the builder itself applies for the chosen use gets a staff warning (owner 2026-11-01,
// audit fix 4). Residential: not taxable. Business building: the row's rule, which is the per-row rule GET /proposal
// served for a saved row that names a service (kept only while the row's service is unchanged), else the family
// registry's rule the builder restores. Undefined when there is no basis (no pick, or a service the registry lacks).
function billedTaxableFor(buildingUse, row, registry, savedRules) {
  if (buildingUse === 'residential') return false;
  if (buildingUse !== 'nonresidential') return undefined;
  const saved = row.id ? savedRules?.[row.id] : null;
  return saved && saved.service === row.service ? saved.rule : serviceTaxRule(registry, row.service);
}
const ROW_TAX_NOTICES = {
  true: 'Visit bills follow the building use: this row will be billed with tax.',
  false: 'Visit bills follow the building use: this row will be billed without tax.',
};
function rowTaxNotice(buildingUse, row, registry, savedRules) {
  const billed = billedTaxableFor(buildingUse, row, registry, savedRules);
  return billed === undefined || billed === (row.taxable === true) ? null : ROW_TAX_NOTICES[billed];
}
// The served per-row business rules for the saved rows that name a service, with the service each was computed for.
function savedBusinessRules(proposal, businessRules) {
  const out = {};
  const add = (row) => {
    if (row?.id && row.service && typeof businessRules[row.id] === 'boolean') out[row.id] = { service: row.service, rule: businessRules[row.id] };
  };
  (proposal.correctiveWork || []).forEach(add);
  (proposal.buildings || []).forEach((b) => (b.lineItems || []).forEach(add));
  (proposal.programs || []).forEach(add);
  return out;
}
function RowTaxNotice({ text }) {
  return text ? <div className="col-span-full basis-full text-12 text-zinc-700" role="note" data-testid="row-tax-warning">{text}</div> : null;
}

const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Auto-fill rule for the tax field. The rate comes from the server's
// canonical resolver (GET /proposal -> suggestedTaxRate: verified exemption
// -> 0, county tax_rates, FL commercial default) and is only a SUGGESTION:
// it fills a zero/empty field when something taxable exists, the proposal is
// editable, and the operator has not typed in the field this session.
function taxAutofillPct({ locked, operatorEdited, currentPct, anyTaxable, suggestedRate }) {
  if (locked || operatorEdited || !anyTaxable) return null;
  if (Number(currentPct) > 0) return null;
  const rate = Number(suggestedRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return String(roundMoney(rate * 10000) / 100);
}

// Prefill for the structured terms (owner 2026-10-24). A proposal that never had terms starts with the agreement's own
// texts (shared/commercial-agreement-terms.cjs, the same constants online signing checks against), so the operator edits
// from the standard instead of typing it. Payment: Net 30 on a Bill-by-invoice proposal; on any other, Auto Pay (the
// commercial default, owner "autopay default", GATE_COMMERCIAL_AUTOPAY) or "Not set" with that gate off (the server
// rejects a Net term there). Returns null when the proposal is locked or ANY term is already authored.
const TERM_FIELDS = ['paymentTerms', 'initialTermMonths', 'renewal', 'priceAdjustment', 'cancellation', 'accessRequirements'];
function commercialTermsPrefill({ locked, saved, billByInvoice, autopayEnabled = false }) {
  if (locked) return null;
  if (TERM_FIELDS.some((key) => saved?.[key] != null && saved[key] !== '')) return null;
  return {
    paymentTerms: billByInvoice ? INVOICE_PAYMENT_TERMS : (autopayEnabled ? AUTOPAY_PAYMENT_TERMS : ''),
    initialTermMonths: String(AGREEMENT_TERMS.initialTermMonths),
    renewal: AGREEMENT_TERMS.renewal,
    priceAdjustment: AGREEMENT_TERMS.priceAdjustment,
    cancellation: AGREEMENT_TERMS.cancellation,
    accessRequirements: '',
  };
}

const lineAmount = proposalLineAmount;
const lineAnnual = (li) =>
  li.frequency === 'one_time' ? 0 : lineAmount(li) * (PER_YEAR[li.frequency] || 0);

function buildingSubtotals(b) {
  let annual = 0, oneTime = 0;
  for (const li of b.lineItems) {
    if (li.frequency === 'one_time') oneTime += lineAmount(li);
    else annual += lineAnnual(li);
  }
  return { annual, oneTime };
}

const PROGRAM_FAMILY_OPTIONS = [
  ['pest', 'Pest'], ['lawn', 'Lawn'], ['tree_shrub', 'Tree & shrub'], ['mosquito', 'Mosquito'],
  ['termite', 'Termite'], ['rodent', 'Rodent'], ['other', 'Other'],
];

// Starting points for "Add program" (owner 2026-10-29 "yes do phase 2"). The visit counts are the pricing engine's
// standard cadences (server/services/pricing-engine/constants.js: PEST.frequencies quarterly 4, RODENT.baitVisitsPerYear 4,
// TERMITE.monitoringVisitsPerYear 4, MOSQUITO.tierVisits monthly12, lawn and tree & shrub standard 6). There is no
// template price: the engine returns a manual quote for commercial programs (pricing-engine/commercial-helpers.js
// buildCommercialManualQuoteResult, price null), so the operator types the price.
const PROGRAM_TEMPLATES = [
  { service: 'pest', label: 'Pest control', frequencyPerYear: 4 },
  { service: 'rodent', label: 'Rodent control', frequencyPerYear: 4 },
  { service: 'termite', label: 'Termite monitoring', frequencyPerYear: 4 },
  { service: 'mosquito', label: 'Mosquito control', frequencyPerYear: 12 },
  { service: 'lawn', label: 'Lawn care', frequencyPerYear: 6 },
  { service: 'tree_shrub', label: 'Tree & shrub care', frequencyPerYear: 6 },
];

// A builder program row counts (totals, payload) once it is actually
// priced — same predicate everywhere so the sidebar shows what will save.
const programRowIsPriced = (p) => String(p.label || '').trim()
  && Number(p.frequencyPerYear) >= 1 && Number(p.pricePerApplication) > 0;

// The common program cadences as one pick (owner 2026-10-28 builder scope); Custom shows the 1–52 visits-per-year box.
const PROGRAM_FREQUENCY_PRESETS = [
  { perYear: 12, label: 'Monthly' },
  { perYear: 6, label: 'Every 2 months' },
  { perYear: 4, label: 'Quarterly' },
];
const programFrequencyChoice = (p) => {
  const preset = PROGRAM_FREQUENCY_PRESETS.find((f) => String(p.frequencyPerYear).trim() !== '' && Number(p.frequencyPerYear) === f.perYear);
  return p.freqCustom || !preset ? 'custom' : String(preset.perYear);
};

// Standard / Custom for each fixed agreement term (owner 2026-10-28 builder scope, plans-only follow-up). Standard is the
// agreement's own text, compared the way online signing compares it, and signs online. Custom is typed wording, which
// online signing refuses. A blank term (an older proposal) is not a choice any more: the select shows "Not stated (old
// proposal)" until the operator picks Standard or Custom. The four terms only apply to a proposal with a recurring
// service, so the picks are hidden (values kept) when annual recurring is 0.
const TERM_CHOICE_KEYS = ['initialTermMonths', 'renewal', 'priceAdjustment', 'cancellation'];
const standardTermText = (key) => String(AGREEMENT_TERMS[key]);
function termChoiceOf(key, value) {
  const text = String(value ?? '').trim();
  if (!text) return 'none';
  if (key === 'initialTermMonths') return Number(text) === AGREEMENT_TERMS.initialTermMonths ? 'standard' : 'custom';
  return normalizeTermText(text) === normalizeTermText(standardTermText(key)) ? 'standard' : 'custom';
}
const termChoicesOf = (terms) => Object.fromEntries(TERM_CHOICE_KEYS.map((key) => [key, termChoiceOf(key, terms[key])]));

const PAYMENT_TERM_LABELS = {
  [AUTOPAY_PAYMENT_TERMS]: 'Auto Pay', [INVOICE_PAYMENT_TERMS]: 'Net-30', [NET60_PAYMENT_TERMS]: 'Net-60', net15: 'Net-15',
  due_on_receipt: 'Due on receipt',
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const formatPct = (pct) => String(roundMoney(pct));


// Mirrors server computeProposalTotals so totals update live as you type.
function computeTotals(buildings, taxRate, correctiveWork = [], programs = []) {
  let annualRecurring = 0, oneTime = 0, taxableAnnual = 0, taxableOneTime = 0;
  for (const b of buildings) {
    for (const li of b.lineItems) {
      const amount = lineAmount(li);
      if (li.frequency === 'one_time') {
        oneTime += amount;
        if (li.taxable) taxableOneTime += amount;
      } else {
        const annual = amount * (PER_YEAR[li.frequency] || 0);
        annualRecurring += annual;
        if (li.taxable) taxableAnnual += annual;
      }
    }
  }
  // Structured corrective-work lines fold into the one-time side, exactly
  // like the server's computeProposalTotals — amounts cent-rounded like
  // normalizeCorrectiveWorkItem so the preview shows what will save.
  // Same nonblank-label predicate as structuredSectionsPayload: a row typed
  // amount-first is dropped by the save, so it must not inflate the sidebar
  // (codex #3297 r1).
  for (const w of correctiveWork.filter((item) => String(item.label || '').trim())) {
    const amount = roundMoney(w.amount);
    oneTime += amount;
    if (w.taxable) taxableOneTime += amount;
  }
  // Service programs (slice 1A-ii): annual = per-application × frequency,
  // derived exactly like normalizeProgram. Program tax rounds PER
  // APPLICATION × cadence, mirroring computeProposalTotals — billing
  // invoices each application and rounds its tax there, so an annual-bucket
  // preview could show cents the invoices never collect (codex 1A-ii r15b).
  const rate = Number(taxRate) || 0;
  let programTax = 0;
  for (const p of programs.filter(programRowIsPriced)) {
    const perApp = roundMoney(p.pricePerApplication);
    const freq = Math.round(Number(p.frequencyPerYear));
    annualRecurring += roundMoney(perApp * freq);
    if (p.taxable) programTax += roundMoney(perApp * rate) * freq;
  }
  // Per-bucket cent rounding, mirroring computeProposalTotals — a merged
  // bucket can drift a cent from the saved proposal/PDF (codex 1A-i r3).
  const totalTax = roundMoney(roundMoney(taxableAnnual * rate) + roundMoney(taxableOneTime * rate) + programTax);
  annualRecurring = roundMoney(annualRecurring);
  oneTime = roundMoney(oneTime);
  return {
    annualRecurring,
    monthlyEquivalent: roundMoney(annualRecurring / 12),
    oneTime,
    totalTax,
    firstYearTotal: roundMoney(annualRecurring + oneTime + totalTax),
  };
}

const STATUS_LABELS = {
  draft: 'Draft', sent: 'Sent', viewed: 'Viewed', accepted: 'Won',
  declined: 'Declined', expired: 'Expired', sending: 'Sending…',
};

// Editing is closed once the price is locked or the row has left the editable
// window — mirrors the PUT /proposal re-pricing guard so the operator learns
// this from a banner, not a 409.
function lockReason(est) {
  if (!est) return null;
  if (est.archivedAt) return 'This estimate is archived. Unarchive it from the estimates list to edit the proposal.';
  if (est.priceLockedAt) return 'This proposal is price-locked (accepted) and can no longer be re-priced.';
  if (est.status === 'sending') return 'This estimate is being sent right now. Refresh once the send finishes.';
  if (['accepted', 'declined', ...(est.fixedBidValidity ? [] : ['expired'])].includes(est.status)) {
    return `A ${STATUS_LABELS[est.status]?.toLowerCase() || est.status} estimate can no longer be re-priced.`;
  }
  return null;
}

// Mirrors the estimates-list canMarkEstimateWon rules as they apply to a
// commercial proposal: the server only manually accepts sent/viewed estimates
// and rejects any carrying the one-time option
// (estimate-manual-acceptance.js), so never render a Mark won that is
// guaranteed to fail — e.g. right after the save-draft estimator handoff.
function canMarkProposalWon(est) {
  if (!est || !['sent', 'viewed'].includes(est.status)) return false;
  return est.showOneTimeOption !== true;
}

const LABEL = 'text-11 uppercase tracking-label text-zinc-500';
// A field label shown only below md, where the desktop column headers are hidden.
const PHONE_LABEL = `${LABEL} mb-1 block md:hidden`;

// A section that folds to its title and a one-line summary (owner 2026-10-28 builder scope: less scrolling on a
// phone). Visibility only: the body stays mounted while folded, so folding never drops or resets anything.
function FoldCard({ title, summary, open, onToggle, bodyClassName, children }) {
  return (
    <Card>
      {/* Folded, the card is only this header: no divider line under it. */}
      <CardHeader style={open ? undefined : { borderBottomWidth: 0 }}>
        <button type="button" className="flex w-full items-center gap-2 text-left bg-transparent border-0 p-0 cursor-pointer u-focus-ring" aria-expanded={open} onClick={onToggle}>
          <CardTitle className="shrink-0">{title}</CardTitle>
          {/* The space keeps title and summary apart in the button's spoken name. */}
          {!open && summary && <>{' '}<span className="min-w-0 truncate text-13 text-zinc-500">{summary}</span></>}
          <span className="ml-auto shrink-0 text-zinc-400">{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
        </button>
      </CardHeader>
      <CardBody className={bodyClassName} hidden={!open}>{children}</CardBody>
    </Card>
  );
}

export default function CommercialProposalPage() {
  return <EstimateSendProvider><CommercialProposalEditor /></EstimateSendProvider>;
}

function CommercialProposalEditor() {
  const { estimateId } = useParams();
  const navigate = useNavigate();
  const openSend = useEstimateSend();
  const loadedVersionRef = React.useRef(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [sending, setSending] = useState(false);
  const [markingWon, setMarkingWon] = useState(false);
  const [error, setError] = useState(null);
  const [savedOnce, setSavedOnce] = useState(false);
  // True when the LOADED proposal was operator-authored (enabled, not the
  // synthesized fallback) — the fallback's building lines are the server's
  // own generated rows, and generation must not treat them as authored
  // content it refuses to replace (codex 1A-ii r1).
  const [loadedAuthored, setLoadedAuthored] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const [title, setTitle] = useState('Commercial Service Proposal');
  const [preparedFor, setPreparedFor] = useState('');
  const [propertyAddress, setPropertyAddress] = useState('');
  // '' (not picked yet) | 'residential' | 'nonresidential' — see BUILDING_USE_OPTIONS.
  const [buildingUse, setBuildingUse] = useState('');
  const [taxRatePct, setTaxRatePct] = useState('0');
  // Server-resolved tax suggestion (fraction, e.g. 0.07; 0 = exempt; null = no
  // lookup) and where it came from ("Sarasota County"). The rate shows as a
  // read-only chip with that source until the operator overrides it.
  const [suggestedTaxRate, setSuggestedTaxRate] = useState(null);
  const [suggestedTaxSource, setSuggestedTaxSource] = useState(null);
  const [taxOverride, setTaxOverride] = useState(false);
  const taxOperatorEditedRef = React.useRef(false);
  // The estimate whose terms prefill already ran (first load only; see applyLoaded).
  const termsPrefilledForRef = React.useRef(null);
  const [terms, setTerms] = useState('');
  const [validThrough, setValidThrough] = useState('');
  const [projectCosting, setProjectCosting] = useState({ revenueYears: 1, rows: [] });
  // The SAVED fixed date — the one the server enforces on send and Mark won.
  const [savedValidThrough, setSavedValidThrough] = useState('');
  const [bidToolsEnabled, setBidToolsEnabled] = useState(false);
  const [autopayEnabled, setAutopayEnabled] = useState(false);
  // "Bid tools" switch: shows the Required bid form and Project cost sheet
  // sections. Visibility only; the sections stay mounted and their data stays
  // in state, so hiding never drops or resets anything. Defaults ON when the
  // proposal already carries bid work; once the operator flips it, their
  // choice wins over later reloads.
  const [bidToolsOpen, setBidToolsOpen] = useState(false);
  const bidToolsChosenRef = React.useRef(false);
  const [buildings, setBuildings] = useState([emptyBuilding(0)]);
  const showUnitColumn = bidToolsEnabled || buildings.some((building) => building.lineItems.some((line) => line.unit));
  // Structured agreement sections (slice 1A-i) — all optional; leaving a
  // card empty omits its section from the saved proposal, and the customer
  // surfaces render exactly as before.
  const [scopeItems, setScopeItems] = useState([]);
  // Service programs (slice 1A-ii) — when any priced program exists it IS
  // the recurring itemization: the buildings editor collapses and the
  // payload omits buildings (the server rejects both together).
  const [programsState, setProgramsState] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [correctiveWork, setCorrectiveWork] = useState([]);
  const [responsibilitiesText, setResponsibilitiesText] = useState('');
  const [commercialTerms, setCommercialTerms] = useState({
    paymentTerms: '', initialTermMonths: '', renewal: '',
    priceAdjustment: '', cancellation: '', accessRequirements: '',
  });
  // Standard / Not stated / Custom per fixed term: derived from the texts on
  // load, then the operator's pick (a Custom pick keeps its box open even
  // while the text still reads like the standard).
  const [termChoices, setTermChoices] = useState(() => termChoicesOf({}));
  // Folded sections: the itemization starts open, optional sections folded.
  const [openSections, setOpenSections] = useState({
    scope: false, programs: true, corrective: false, responsibilities: false, terms: false, additionalTerms: false,
  });
  // The Add program chooser (template buttons) is open.
  const [programChooserOpen, setProgramChooserOpen] = useState(false);
  const toggleSection = (key) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  // Below lg the sidebar drops under the form, so a bottom bar keeps the
  // totals and Save in reach.
  const isPhone = useIsMobile(1024);
  // Engine-composed prospect research (commercial proposal lane). Read-only
  // context for pricing the walkthrough — never sent to the customer.
  const [prospectBrief, setProspectBrief] = useState(null);
  // GATE_COMMERCIAL_PROPOSAL_SIGN: { state: 'none' | 'awaiting' | 'signed', since?, signedAt?, signingBlocked? }; null with the gate off.
  const [commercialAgreement, setCommercialAgreement] = useState(null);
  const [briefOpen, setBriefOpen] = useState(true);

  const locked = lockReason(estimate);
  // A fixed bid past its SAVED validity date stays editable (so the date can
  // be revised) but cannot be sent or marked won — the server refuses both
  // (assertBidSendDate / fixedBidDeadlinePassed), so neither action is
  // offered until a later date is saved (GH codex P2 r5 on #4309). Eastern
  // calendar-day comparison, the same day the server's proposalExpiry ends.
  const fixedDeadlinePassed = !!savedValidThrough
    && new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) > savedValidThrough;

  // Monotonic edit generation: every field edit bumps it, and save() applies
  // the normalized reload ONLY if no edit landed while the save round-trip
  // was in flight — otherwise a slow connection would silently discard
  // keystrokes made after clicking Save (codex #3297 r5).
  const editGenRef = React.useRef(0);
  const markEdit = () => { editGenRef.current += 1; setDirty(true); };
  // Building-ITEMIZATION edits specifically — generation's authored-lines
  // guard keys on this, never on the global dirty flag (an unrelated
  // title/scope edit must not block program generation — codex 1A-ii r2).
  const buildingsEditedRef = React.useRef(false);
  const markBuildingsEdit = () => { buildingsEditedRef.current = true; markEdit(); };
  // Building lines this PAGE has successfully persisted — a first save of
  // the synthesized fallback makes those lines authored server-side even if
  // a concurrent edit skipped applyLoaded (loadedAuthored still false), so
  // a save retry must not treat them as discardable (codex 1A-ii r2f).
  const persistedBuildingsRef = React.useRef(false);
  // Family → generated responsibility lines THIS proposal's generation
  // actually installed (codex 1A-ii r12), persisted with the proposal as
  // `generatedResponsibilities` so a reopened proposal prunes exactly what
  // its generation wrote — never static-catalog membership, which would
  // eat a hand-authored line that matches a stock sentence (codex 1A-ii
  // r15). Null until generation fills responsibilities.
  const generatedRespByFamilyRef = React.useRef(null);
  // Served per-row business tax rules of the saved rows (savedBusinessRules): the warning's basis for a Business building.
  const savedBizRulesRef = React.useRef({});
  // Family → generated inclusions/exclusions/taxability registry, served on
  // load like responsibilityRegistry — the family-change resync prunes the
  // old family's generated lines and installs the new family's stack by
  // exact match (codex 1A-ii r14). Reload-safe for the same reason.
  const familyRegistryRef = React.useRef(null);

  const applyLoaded = useCallback((data) => {
    const p = data.proposal || {};
    const est = data.estimate || null;
    loadedVersionRef.current = est?.editVersion;
    setEstimate(est);
    setTitle(p.title || 'Commercial Service Proposal');
    setPreparedFor(p.preparedFor || est?.customerName || '');
    setPropertyAddress(p.propertyAddress || est?.address || '');
    const loadedUse = p.buildingUse === 'residential' || p.buildingUse === 'nonresidential' ? p.buildingUse : '';
    setBuildingUse(loadedUse);
    // A proposal saved as residential has its rows off; keep each row's business rule so a later Business pick
    // can turn the right ones back on: the server's rule for a row that names a service (its own key, so a
    // canonical one-time service keeps its own rule), else the family registry's.
    const registry = data.familyRegistry || familyRegistryRef.current;
    const businessRules = data.businessTaxRules || {};
    savedBizRulesRef.current = savedBusinessRules(p, businessRules);
    const keptRule = (row) => (loadedUse === 'residential'
      ? { bizTaxable: (row.id && typeof businessRules[row.id] === 'boolean') ? businessRules[row.id] : serviceTaxRule(registry, row.service) }
      : {});
    // The empty starter line follows the pick like any new row.
    const starterTax = loadedUse === 'nonresidential'
      ? { taxable: serviceTaxRule(registry, 'other') === true }
      : { taxable: false, bizTaxable: serviceTaxRule(registry, 'other') };
    // Percent to 4 places: 0.07 * 100 is 7.000000000000001 in floating point.
    setTaxRatePct(String(roundMoney((Number(p.taxRate) || 0) * 10000) / 100));
    // 0 is a real answer (exempt) and stays apart from null (no lookup).
    const suggested = data.suggestedTaxRate == null ? NaN : Number(data.suggestedTaxRate);
    const hasSuggestion = Number.isFinite(suggested) && suggested >= 0;
    setSuggestedTaxRate(hasSuggestion ? suggested : null);
    setSuggestedTaxSource(hasSuggestion ? (data.suggestedTaxSource || null) : null);
    setTerms(p.terms || '');
    setValidThrough(p.validThrough || '');
    setProjectCosting(data.projectCosting || { revenueYears: 1, rows: [] });
    setSavedValidThrough(p.validThrough || '');
    setBidToolsEnabled(data.bidToolsEnabled === true);
    setAutopayEnabled(data.commercialAutopayEnabled === true);
    if (!bidToolsChosenRef.current) {
      setBidToolsOpen(
        (data.projectCosting?.rows?.length || 0) > 0
        || !!p.validThrough
        || (p.buildings || []).some((b) => (b.lineItems || []).some((li) => li.unit)),
      );
    }
    setBuildings(
      Array.isArray(p.buildings) && p.buildings.length
        ? p.buildings.map((b) => ({
            name: b.name || '',
            note: b.note || '',
            lineItems: (b.lineItems || []).map((li) => ({
              id: li.id || crypto.randomUUID(),
              description: li.description || '',
              quantity: li.quantity ?? 1,
              unit: li.unit || '',
              unitPrice: li.unitPrice ?? 0,
              frequency: li.frequency || 'monthly',
              taxable: li.taxable === true,
              ...keptRule(li),
              // Server-owned identity of the mosquito misting system: kept through the editor so a save cannot drop it.
              ...(li.service ? { service: li.service } : {}),
              ...(li.originalRequestedService ? { originalRequestedService: li.originalRequestedService } : {}),
              ...(li.quoteRequired === true ? { quoteRequired: true } : {}),
            })),
          }))
        : [emptyBuilding(0, starterTax)],
    );
    setScopeItems((p.propertyScope?.items || []).map((item) => ({
      label: item.label || '', value: item.value || '',
    })));
    setProgramsState((p.programs || []).map((program) => ({
      id: program.id || crypto.randomUUID(),
      service: program.service || 'other',
      ...(program.identity ? { identity: program.identity } : {}),
      label: program.label || '',
      frequencyPerYear: program.frequencyPerYear ?? 4,
      pricePerApplication: program.pricePerApplication ?? 0,
      visitMinutes: program.visitMinutes ?? '',
      taxable: program.taxable === true,
      ...keptRule(program),
      note: program.note || '',
      inclusionsText: (program.inclusions || []).join('\n'),
      exclusionsText: (program.exclusions || []).join('\n'),
      coversText: (program.buildings || []).map((b) => (b.note ? `${b.name} | ${b.note}` : b.name)).join(', '),
      // Persisted per-program provenance (codex 1A-ii r17): only lines THIS
      // program's generation installed are prunable on a family switch.
      genInclusions: program.generatedInclusions || [],
      genExclusions: program.generatedExclusions || [],
    })));
    // Pruning provenance is the proposal's OWN persisted record of what
    // generation installed (codex 1A-ii r15) — never the static catalog,
    // which would misclassify a hand-authored line that happens to match a
    // stock sentence. Legacy proposals without it simply never prune.
    generatedRespByFamilyRef.current = p.generatedResponsibilities || null;
    if (data.familyRegistry) familyRegistryRef.current = data.familyRegistry;
    setCorrectiveWork((p.correctiveWork || []).map((w) => ({
      id: w.id || crypto.randomUUID(),
      ...(w.service ? { service: w.service } : {}),
      ...(w.originalRequestedService ? { originalRequestedService: w.originalRequestedService } : {}),
      label: w.label || '',
      amount: w.amount ?? 0,
      taxable: w.taxable === true,
      ...keptRule(w),
      includesText: (w.includes || []).join('\n'),
    })));
    setResponsibilitiesText((p.customerResponsibilities || []).join('\n'));
    // Prefill only on the first load of an estimate: a reload after Save must not put back terms the operator cleared.
    const prefill = est && termsPrefilledForRef.current !== est.id
      ? commercialTermsPrefill({ locked: lockReason(est), saved: p.commercialTerms, billByInvoice: !!est.billByInvoice, autopayEnabled: data.commercialAutopayEnabled === true })
      : null;
    if (est) termsPrefilledForRef.current = est.id;
    const loadedTerms = prefill || {
      paymentTerms: p.commercialTerms?.paymentTerms || '',
      initialTermMonths: p.commercialTerms?.initialTermMonths != null ? String(p.commercialTerms.initialTermMonths) : '',
      renewal: p.commercialTerms?.renewal || '',
      priceAdjustment: p.commercialTerms?.priceAdjustment || '',
      cancellation: p.commercialTerms?.cancellation || '',
      accessRequirements: p.commercialTerms?.accessRequirements || '',
    };
    setCommercialTerms(loadedTerms);
    setTermChoices(termChoicesOf(loadedTerms));
    setProspectBrief(data.prospectBrief || null);
    setCommercialAgreement(data.commercialAgreement || null);
    // An already-authored proposal means download/send are meaningful now.
    setSavedOnce(p.enabled === true);
    setLoadedAuthored(p.enabled === true && p.synthesized !== true);
    buildingsEditedRef.current = false;
    persistedBuildingsRef.current = p.enabled === true && p.synthesized !== true
      && (p.buildings || []).some((b) => (b.lineItems || []).length > 0);
    // Dirty only when the prefill actually filled: the terms are not saved until the operator saves.
    setDirty(prefill !== null);
  }, []);

  const reload = useCallback(() => {
    // adminFetch resolves 2xx to parsed JSON and throws with the server's
    // error message otherwise.
    return adminFetch(`/admin/estimates/${estimateId}/proposal`)
      .then(applyLoaded)
      .catch((e) => setLoadError(e.message));
  }, [estimateId, applyLoaded]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    adminFetch(`/admin/estimates/${estimateId}/proposal`)
      .then((data) => alive && applyLoaded(data))
      .catch((e) => alive && setLoadError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [estimateId, applyLoaded]);

  const taxRate = (Number(taxRatePct) || 0) / 100;
  const programsMode = programsState.some(programRowIsPriced);
  // Staff warning on a row whose Taxable box differs from what visit bills do (billedTaxableFor); none on a locked proposal.
  const rowNotice = (row) => (locked ? null : rowTaxNotice(buildingUse, row, familyRegistryRef.current, savedBizRulesRef.current));
  const differingTaxRows = [
    ...programsState,
    ...(programsMode ? [] : buildings.flatMap((b) => b.lineItems || [])),
    ...correctiveWork,
  ].filter((row) => rowNotice(row)).length;
  // Any taxable item that would SAVE (buildings are omitted in programs mode,
  // like computeTotals) — on-screen rows with no description/price count too,
  // so the rate is already there the moment the toggle flips.
  const anyTaxable = (programsMode ? [] : buildings).some((b) => (b.lineItems || []).some((li) => li.taxable))
    || programsState.some((pr) => pr.taxable)
    || correctiveWork.some((w) => w.taxable);
  useEffect(() => {
    const fill = taxAutofillPct({
      locked, operatorEdited: taxOperatorEditedRef.current, currentPct: taxRatePct,
      anyTaxable, suggestedRate: suggestedTaxRate,
    });
    if (fill == null) return;
    setTaxRatePct(fill);
    setDirty(true);
  }, [locked, taxRatePct, anyTaxable, suggestedTaxRate]);
  // The tax chip: the rate on the proposal is the suggestion, or 0, which the
  // fill above turns into the suggestion the moment a line is taxable (on the
  // load's own render too, so the box never flashes first). A typed 0 sets
  // taxOverride, so it keeps the box. Anything else, an Override, or no
  // suggestion at all shows the editable box.
  const suggestedPct = suggestedTaxRate == null ? null : roundMoney(suggestedTaxRate * 10000) / 100;
  const currentPct = Number(taxRatePct) || 0;
  const taxIsSuggested = suggestedPct != null && (Math.abs(currentPct - suggestedPct) < 0.0001 || currentPct === 0);
  const showTaxInput = !locked && (taxOverride || !taxIsSuggested);
  const suggestedTaxLabel = suggestedPct == null ? '' : `${formatPct(suggestedPct)}%${suggestedTaxSource ? ` · ${suggestedTaxSource}` : ''}`;
  const overrideTax = () => {
    taxOperatorEditedRef.current = true;
    setTaxOverride(true);
    // The box opens on the rate the chip showed, never a hidden 0.
    if (currentPct === 0 && suggestedPct > 0) { setTaxRatePct(String(suggestedPct)); markEdit(); }
  };
  const applySuggestedTax = () => {
    taxOperatorEditedRef.current = false;
    setTaxOverride(false);
    setTaxRatePct(String(suggestedPct));
    markEdit();
  };
  // New and generated rows follow the building use (owner 2026-10-28, proposal
  // defaults check). A business building: the row's rule, which is the served
  // registry's commercialTaxableDefault for a hand-added row (lawn and tree &
  // shrub off, the rest on; building lines and corrective work take the
  // 'other' rule) and the server's flag for a generated row. A residential
  // community, or no pick yet: not taxable, with the rule kept in
  // `bizTaxable` (builder-only, never saved) for a later Business pick. Reads
  // the pick at call time (formRef), so a generation that resolves after a
  // pick change follows the new pick. Saved rows keep their switch as saved.
  const taxUnderUse = (rule) => (formRef.current?.buildingUse === 'nonresidential'
    ? { taxable: rule === true, bizTaxable: undefined }
    : { taxable: false, bizTaxable: rule === true });
  const familyRule = (family) => serviceTaxRule(familyRegistryRef.current, family) === true;
  // The pick re-sets every row: a residential community turns each row off
  // (Florida does not tax pest work at homes and their common areas) and
  // keeps its flag; a business building puts each row back on its kept flag.
  // A mixed site then flips its exceptions by hand. Not an itemization edit,
  // so generation's authored-lines guard is untouched.
  const chooseBuildingUse = (next) => {
    if ((next !== 'residential' && next !== 'nonresidential') || next === buildingUse) return;
    markEdit();
    setBuildingUse(next);
    // The save's "pick the building use" message is answered now; any other message stays.
    setError((prev) => (prev === BUILDING_USE_REQUIRED ? null : prev));
    const apply = next === 'residential'
      ? (row) => ({ ...row, bizTaxable: row.bizTaxable ?? row.taxable, taxable: false })
      : ({ bizTaxable, ...row }) => ({ ...row, taxable: bizTaxable ?? row.taxable });
    setBuildings((prev) => prev.map((b) => ({ ...b, lineItems: b.lineItems.map(apply) })));
    setProgramsState((prev) => prev.map(apply));
    setCorrectiveWork((prev) => prev.map(apply));
  };
  // Sidebar mirrors what SAVES: in programs mode the payload omits the
  // buildings entirely, so their (hidden) line items must not count.
  const totals = useMemo(
    () => computeTotals(programsMode ? [] : buildings, taxRate, correctiveWork, programsState),
    [programsMode, buildings, taxRate, correctiveWork, programsState],
  );
  // The save's revenue-side limits over the same itemization the sidebar
  // sums: the costing card withholds profit and margin while any of it
  // would be refused (GH codex P2 r8 on #4270).
  // Every unpriced program row is refused by save() (it is dropped from
  // the payload, so the reload would silently delete it), so any such row
  // withholds the margin too, with the save's own message (GH codex P2
  // r10 on #4270).
  const revenueIssue = useMemo(
    () => (programsState.some((row) => !programRowIsPriced(row))
      ? 'Every program row needs a name, a per-application price of at least $0.01, and a whole-number frequency (1–52) — fix or remove it.'
      : proposalRevenueIssue({ buildings: programsMode ? [] : buildings, correctiveWork, programs: programsState, taxRate })),
    [programsMode, buildings, correctiveWork, programsState, taxRate],
  );

  // One-line summaries for the folded sections.
  const programsAnnual = roundMoney(programsState.filter(programRowIsPriced)
    .reduce((sum, p) => sum + roundMoney(roundMoney(p.pricePerApplication) * Math.round(Number(p.frequencyPerYear))), 0));
  const scopeLabels = scopeItems.filter((item) => item.label.trim() && item.value.trim()).map((item) => item.label.trim());
  const scopeSummary = scopeLabels.length ? scopeLabels.join(' · ') : 'None added';
  const namedWork = correctiveWork.filter((w) => String(w.label || '').trim());
  const correctiveSummary = namedWork.length
    ? `${plural(namedWork.length, 'item')} · ${money(namedWork.reduce((sum, w) => sum + roundMoney(w.amount), 0))}`
    : 'None';
  const responsibilityCount = responsibilitiesText.split('\n').filter((line) => line.trim()).length;
  const responsibilitiesSummary = responsibilityCount ? plural(responsibilityCount, 'line') : 'None';
  // The fixed terms apply to a recurring program only (same number the sidebar shows as "Annual recurring").
  const hasRecurring = Number(totals.annualRecurring) > 0;
  const termKinds = Object.values(termChoices);
  const termsSummary = [
    PAYMENT_TERM_LABELS[commercialTerms.paymentTerms] || 'Payment not set',
    !hasRecurring ? 'One-time work, no term'
      : termKinds.includes('custom') ? 'Custom terms' : termKinds.every((kind) => kind === 'none') ? 'Terms not stated' : 'Standard terms',
    validThrough ? `Valid through ${validThrough}` : null,
  ].filter(Boolean).join(' · ');

  // "Generate from estimate" (slice 1A-ii): pulls DRAFT sections derived
  // from what the estimator priced/knows. Fills only sections that are
  // currently EMPTY — never overwrites operator-authored content — and
  // everything stays editable until Save publishes it.
  const generateFromEstimate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const { draft } = await adminFetch(`/admin/estimates/${estimateId}/proposal/generated`);
      // Emptiness checks read the LIVE render-assigned formRef, not the
      // state captured when the request began — the form stays editable
      // during the fetch and fill-only must mean "empty NOW", never
      // "empty when I clicked" (codex 1A-ii r1b).
      const live = formRef.current;
      let filled = 0;
      // Monetary fills (programs/corrective) tracked separately — only they
      // justify clearing the synthesized building pricing (codex 1A-ii r2h).
      let monetaryFilled = 0;
      let programsInstalled = false;
      // ANY existing row in a section blocks its fill — rows exist only
      // because the operator added or loaded them, and content predicates
      // can't see field edits that leave no text (family/frequency/tax —
      // codex 1A-ii r17b). Fill-only means fill EMPTY sections.
      if (draft?.propertyScope?.items?.length && live.scopeItems.length === 0) {
        setScopeItems(draft.propertyScope.items.map((item) => ({ label: item.label, value: item.value })));
        filled += 1;
      }
      // NEVER install programs over an authored building itemization —
      // programs mode omits buildings from the save, so generating here
      // would silently erase the prior lines and rewrite the totals
      // (pre-push codex P0). Lines count as authored only when the loaded
      // proposal was actually operator-authored or the operator edited this
      // session — a never-saved draft shows the server's SYNTHESIZED
      // fallback lines, which generation may freely replace (codex 1A-ii r1).
      const hasAuthoredBuildingLines = (live.loadedAuthored || buildingsEditedRef.current || persistedBuildingsRef.current)
        && live.buildings.some((b) => (b.lineItems || []).some((l) => String(l.description || '').trim()));
      // ANY existing program row blocks the fill — a row exists only
      // because the operator added or loaded it, and family/frequency/tax
      // edits leave no text for a content predicate to see (codex 1A-ii
      // r17b). Fill-only means fill EMPTY sections.
      // The MONETARY sides install all-or-nothing at the client too (codex
      // 1A-ii r19): they jointly replace ONE synthesized itemization, so
      // installing half while a leftover placeholder row blocks the other
      // half would clear building lines carrying BOTH charges — the blank
      // row then saves as nothing and the PUT recomputes the missing total
      // to ZERO.
      const monetaryInstallBlocked = hasAuthoredBuildingLines
        || (draft?.programs?.length && live.programsState.length !== 0)
        || (draft?.correctiveWork?.length && live.correctiveWork.length !== 0);
      if (draft?.programs?.length && !monetaryInstallBlocked) {
        setProgramsState(draft.programs.map((program) => ({
          id: program.id || crypto.randomUUID(),
          service: program.service,
          label: program.label,
          frequencyPerYear: program.frequencyPerYear,
          pricePerApplication: program.pricePerApplication,
          ...taxUnderUse(program.taxable === true),
          note: '',
          inclusionsText: (program.inclusions || []).join('\n'),
          exclusionsText: (program.exclusions || []).join('\n'),
          coversText: '',
          genInclusions: program.inclusions || [],
          genExclusions: program.exclusions || [],
        })));
        filled += 1;
        monetaryFilled += 1;
        programsInstalled = true;
      }
      if (draft?.correctiveWork?.length && !monetaryInstallBlocked) {
        setCorrectiveWork(draft.correctiveWork.map((w) => ({
          id: w.id || crypto.randomUUID(),
          ...(w.service ? { service: w.service } : {}),
          label: w.label,
          amount: w.amount,
          ...taxUnderUse(w.taxable === true),
          includesText: (w.includes || []).join('\n'),
        })));
        filled += 1;
        monetaryFilled += 1;
      }
      // Responsibilities derive from the generated programs' families —
      // installing them when programs were BLOCKED would describe scope the
      // proposal doesn't carry (codex 1A-ii r3d). programsInstalled is set
      // by the programs branch above.
      if (draft?.customerResponsibilities?.length && !live.responsibilitiesText.trim() && programsInstalled) {
        setResponsibilitiesText(draft.customerResponsibilities.join('\n'));
        // MERGE over any persisted provenance, never replace (pre-push
        // codex r14b) — this map is the proposal's own record of what
        // generation installed, saved as `generatedResponsibilities`;
        // family-switch installs come from the served familyRegistry.
        generatedRespByFamilyRef.current = {
          ...(generatedRespByFamilyRef.current || {}),
          ...(draft.responsibilitiesByFamily || {}),
        };
        filled += 1;
      }
      if (filled > 0) {
        // Taxable generated items need a rate beside them — fill the canonical
        // FL commercial default only when the current rate is zero/unset
        // (codex 1A-ii r3); the operator reviews it like everything else.
        if (monetaryFilled > 0 && draft?.suggestedTaxRate && !(Number(live.taxRate) > 0)) {
          setTaxRatePct(String(roundMoney(draft.suggestedTaxRate * 10000) / 100));
        }
        // Monetary sections were installed — the on-screen SYNTHESIZED
        // building lines describe the same charges and would double-count
        // on save (codex 1A-ii r2g). Authored/edited/persisted lines never
        // reach here (the guards above), so clearing is safe.
        if (monetaryFilled > 0
          && !(live.loadedAuthored || buildingsEditedRef.current || persistedBuildingsRef.current)) {
          setBuildings([emptyBuilding(0, taxUnderUse(familyRule('other')))]);
        }
        markEdit();
        // Partial generation still surfaces the programs warning.
        if (draft?.warnings?.length) setError(draft.warnings.join(' '));
      } else if (draft?.warnings?.length) setError(draft.warnings.join(' '));
      else if (draft?.programs?.length && hasAuthoredBuildingLines) {
        setError('Programs were not generated: this proposal already has building line items. Clear them first to switch to generated programs.');
      } else if ((draft?.programs?.length || draft?.correctiveWork?.length) && monetaryInstallBlocked) {
        setError('Programs and corrective work were not generated: those sections already have rows. Generation replaces both monetary sections together — remove the started rows first.');
      } else setError('Nothing to generate — the estimate has no derivable sections this proposal is missing.');
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  const touch = () => markEdit();

  const mutateBuilding = useCallback((bi, fn) => {
    markBuildingsEdit();
    setBuildings((prev) => prev.map((b, i) => (i === bi ? fn(b) : b)));
  }, []);

  const updateLine = (bi, li, patch) =>
    mutateBuilding(bi, (b) => ({
      ...b,
      lineItems: b.lineItems.map((l, i) => (i === li ? { ...l, ...patch } : l)),
    }));

  const addLine = (bi) => mutateBuilding(bi, (b) => ({ ...b, lineItems: [...b.lineItems, emptyLine(taxUnderUse(familyRule('other')))] }));
  const removeLine = (bi, li) =>
    mutateBuilding(bi, (b) => ({ ...b, lineItems: b.lineItems.filter((_, i) => i !== li) }));
  const addBuilding = () => { markBuildingsEdit(); setBuildings((prev) => [...prev, emptyBuilding(prev.length, taxUnderUse(familyRule('other')))]); };
  const duplicateBuilding = (bi) => {
    markBuildingsEdit();
    setBuildings((prev) => {
      const src = prev[bi];
      const copy = {
        name: `${src.name || 'Building'} (copy)`,
        note: src.note,
        // With bid authoring gated off the server refuses a NEW line that
        // carries a unit (no saved unit under its fresh id), and the unit
        // selector is disabled, so the copy would be unsaveable. Copy the
        // lines unit-less then; the original keeps its saved units
        // (GH codex P2 r3 on #4305).
        lineItems: src.lineItems.map((l) => ({ ...l, id: crypto.randomUUID(), ...(bidToolsEnabled ? {} : { unit: '' }) })),
      };
      return [...prev.slice(0, bi + 1), copy, ...prev.slice(bi + 1)];
    });
  };
  const removeBuilding = (bi) => { markBuildingsEdit(); setBuildings((prev) => prev.filter((_, i) => i !== bi)); };
  // Removing a program also prunes ITS family's GENERATED responsibility
  // lines — a pest+lawn draft that loses the lawn program must not save
  // mowing/watering/re-entry obligations for a service the agreement no
  // longer carries (codex 1A-ii r12). Exact-line matching against the
  // generated registry only: lines shared by a remaining program family
  // stay, and hand-authored/edited lines are never in the registry so
  // pruning cannot touch them.
  const removeProgram = (idx) => {
    markEdit();
    const removed = programsState[idx];
    const next = programsState.filter((_, i) => i !== idx);
    setProgramsState(next);
    const byFamily = generatedRespByFamilyRef.current;
    const removedLines = (byFamily && removed && byFamily[removed.service]) || [];
    if (!removedLines.length) return;
    const remainingFamilies = new Set(next.map((p) => p.service));
    const keep = new Set(Object.entries(byFamily)
      .filter(([family]) => remainingFamilies.has(family))
      .flatMap(([, lines]) => lines));
    setResponsibilitiesText((text) => text.split('\n')
      .filter((line) => !(removedLines.includes(line.trim()) && !keep.has(line.trim())))
      .join('\n'));
    // Persisted provenance follows the agreement: the last program of a
    // family leaving drops its provenance entry (codex 1A-ii r15).
    if (!remainingFamilies.has(removed.service)) {
      const { [removed.service]: _gone, ...rest } = byFamily;
      generatedRespByFamilyRef.current = Object.keys(rest).length ? rest : null;
    }
  };

  // Changing a program's FAMILY must not keep the old family's generated
  // copy beside the new label — a generated pest program switched to Lawn
  // would otherwise save a lawn agreement still promising interior pest
  // treatment and pest-specific exclusions (codex 1A-ii r14). Pruning is
  // exact-line against the row's own persisted provenance
  // (generatedInclusions/generatedExclusions — codex 1A-ii r17); the
  // served family registry is only the INSTALL source for the new
  // family's stack. Hand-authored lines are never in provenance, so they
  // survive untouched.
  const changeProgramFamily = (idx, nextFamily) => {
    const prev = programsState[idx];
    if (!prev || prev.service === nextFamily) return;
    markEdit();
    const newReg = familyRegistryRef.current?.[nextFamily];
    // Prune ONLY lines THIS program's generation installed (its persisted
    // per-program provenance — never catalog membership, which would eat a
    // hand-authored line that happens to match a stock sentence: codex
    // 1A-ii r17, same doctrine as generatedResponsibilities). When the row
    // held generated copy, the new family's stack installs from the served
    // registry and becomes the row's new provenance. The dynamic cadence
    // bullet is family-independent and always survives.
    const cadenceRe = /^\d+ scheduled applications? per year$/;
    const swapLines = (text, provLines = [], newLines = []) => {
      const provSet = new Set(provLines);
      const newSet = new Set(newLines);
      const lines = text.split('\n');
      const hadGenerated = lines.some((line) => provSet.has(line.trim()));
      const kept = lines.filter((line) => {
        const t = line.trim();
        return !(provSet.has(t) && !newSet.has(t) && !cadenceRe.test(t));
      });
      const present = new Set(kept.map((line) => line.trim()));
      const installed = hadGenerated ? newLines.filter((line) => !present.has(line)) : [];
      const provenance = hadGenerated
        ? [...provLines.filter((line) => present.has(line)), ...installed]
        : provLines;
      return { text: [...kept, ...installed].join('\n'), hadGenerated, provenance };
    };
    setProgramsState((list) => list.map((p, i) => {
      if (i !== idx) return p;
      const next = { ...p, service: nextFamily };
      const inc = swapLines(p.inclusionsText, p.genInclusions, newReg?.inclusions);
      const exc = swapLines(p.exclusionsText, p.genExclusions, newReg?.exclusions);
      next.inclusionsText = inc.text;
      next.genInclusions = inc.provenance;
      next.exclusionsText = exc.text;
      next.genExclusions = exc.provenance;
      // Generated taxability is family-derived — resync it to the new
      // family's default (the visible Tax switch stays operator-editable).
      // A row added here whose switch the operator has not touched follows
      // its family the same way (the new-row default).
      if (newReg && (inc.hadGenerated || exc.hadGenerated || (p.isNew && !p.taxTouched))) Object.assign(next, taxUnderUse(newReg.taxable === true));
      // A kept business rule (residential, or no pick yet) belongs to the old
      // family: it follows the new one even where the visible switch stays as
      // the operator left it, so a later Business pick restores the right rule.
      else if (newReg && p.bizTaxable !== undefined) next.bizTaxable = newReg.taxable === true;
      return next;
    }));
    // Generated responsibilities follow the same swap, pruning ONLY via the
    // proposal's own persisted provenance (never catalog membership — codex
    // 1A-ii r15): lines this generation installed for the old family leave
    // (unless another remaining program's family still needs them), and the
    // new family's lines install from the served registry, recorded back
    // into provenance so a later removal/switch can prune them too.
    const byFamily = generatedRespByFamilyRef.current;
    if (!byFamily) return;
    const removedLines = byFamily[prev.service] || [];
    const remainingFamilies = new Set(
      programsState.map((p, i) => (i === idx ? nextFamily : p.service)),
    );
    const keep = new Set(Object.entries(byFamily)
      .filter(([family]) => remainingFamilies.has(family))
      .flatMap(([, lines]) => lines));
    const lines = responsibilitiesText.split('\n');
    const hadGenerated = lines.some((line) => removedLines.includes(line.trim()));
    const nextProvenance = { ...byFamily };
    if (!remainingFamilies.has(prev.service)) delete nextProvenance[prev.service];
    if (hadGenerated) {
      const kept = lines.filter((line) => !(removedLines.includes(line.trim()) && !keep.has(line.trim())));
      const present = new Set(kept.map((line) => line.trim()));
      const installLines = (newReg?.responsibilities || []).filter((line) => !present.has(line));
      // Only the lines we actually append are provenance — a pre-existing
      // identical line may be hand-authored and must stay unprunable.
      if (installLines.length) {
        nextProvenance[nextFamily] = [...new Set([...(nextProvenance[nextFamily] || []), ...installLines])];
      }
      setResponsibilitiesText([...kept, ...installLines].join('\n'));
    }
    generatedRespByFamilyRef.current = Object.keys(nextProvenance).length ? nextProvenance : null;
  };

  // One program field edit. Builder-only keys (isNew, taxTouched, freqCustom)
  // ride on the row; the payload maps named fields only, so they never save.
  const patchProgram = (idx, patch) => {
    markEdit();
    setProgramsState((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };
  const patchCorrective = (idx, patch) => {
    markEdit();
    setCorrectiveWork((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };
  // Visits per year, from the preset pick or the Custom box. Keeps the
  // generated cadence bullet in sync — a stale "4 scheduled service visits
  // per year" line beside a changed frequency is a wrong promise (codex
  // 1A-ii r6).
  const setProgramFrequency = (idx, nextFreq, freqCustom) => {
    markEdit();
    setProgramsState((prev) => prev.map((it, i) => {
      if (i !== idx) return it;
      const n = Math.round(Number(nextFreq));
      const synced = Number.isFinite(n) && n >= 1
        ? it.inclusionsText.replace(/^\d+ scheduled applications? per year$/m, `${n} scheduled application${n === 1 ? '' : 's'} per year`)
        : it.inclusionsText;
      return { ...it, frequencyPerYear: nextFreq, inclusionsText: synced, freqCustom };
    }));
  };
  const addProgram = () => {
    markEdit();
    setProgramsState((prev) => [...prev, {
      id: crypto.randomUUID(), service: 'pest', label: '', frequencyPerYear: 4, pricePerApplication: 0, visitMinutes: '',
      ...taxUnderUse(familyRule('pest')), note: '', inclusionsText: '', exclusionsText: '', coversText: '', genInclusions: [], genExclusions: [],
      isNew: true,
    }]);
    setOpenSections((prev) => ({ ...prev, programs: true }));
    setProgramChooserOpen(false);
  };
  // A row started from a template: the service's served stack (inclusions, exclusions, responsibilities) installs the
  // way a family change installs it, with the same provenance, so a later family switch or removal prunes exactly
  // these lines. The cadence bullet leads the inclusions (setProgramFrequency keeps it in sync) and is not provenance.
  // The price box starts empty: no template carries a price.
  const addProgramFromTemplate = (template) => {
    const { service, label, frequencyPerYear: n } = template;
    const reg = familyRegistryRef.current?.[service];
    const bullet = `${n} scheduled application${n === 1 ? '' : 's'} per year`;
    const regInc = (reg?.inclusions || []).map((line) => String(line).trim()).filter(Boolean);
    const regExc = (reg?.exclusions || []).map((line) => String(line).trim()).filter(Boolean);
    const genInclusions = regInc.filter((line) => line !== bullet);
    markEdit();
    if (reg) {
      const lines = responsibilitiesText.trim() ? responsibilitiesText.split('\n') : [];
      const present = new Set(lines.map((line) => line.trim()));
      // Only the lines appended here are provenance: a pre-existing identical line may be hand-authored and must stay unprunable.
      const appended = [...new Set((reg.responsibilities || []).map((line) => String(line).trim()).filter((line) => line && !present.has(line)))];
      if (appended.length) {
        setResponsibilitiesText([...lines, ...appended].join('\n'));
        generatedRespByFamilyRef.current = {
          ...(generatedRespByFamilyRef.current || {}),
          [service]: [...new Set([...(generatedRespByFamilyRef.current?.[service] || []), ...appended])],
        };
      }
    }
    setProgramsState((prev) => [...prev, {
      id: crypto.randomUUID(), service, label, frequencyPerYear: n, pricePerApplication: '', visitMinutes: '',
      ...taxUnderUse(familyRule(service)), note: '', coversText: '',
      inclusionsText: reg ? [bullet, ...genInclusions].join('\n') : '',
      exclusionsText: reg ? regExc.join('\n') : '',
      genInclusions: reg ? genInclusions : [],
      genExclusions: reg ? regExc : [],
      isNew: true,
    }]);
    setOpenSections((prev) => ({ ...prev, programs: true }));
    setProgramChooserOpen(false);
  };
  // Standard / Custom for one fixed term (a blank old term is the only 'none',
  // and only until this pick). Custom starts from the current wording (the
  // standard text when there was none), so the operator edits it instead of
  // retyping it.
  const chooseTerm = (key, choice) => {
    markEdit();
    setTermChoices((prev) => ({ ...prev, [key]: choice }));
    setCommercialTerms((prev) => {
      const standard = standardTermText(key);
      if (choice === 'standard') return { ...prev, [key]: standard };
      return { ...prev, [key]: prev[key] || standard };
    });
  };

  // Render-assigned mirror of the current form state: save()'s retry loop
  // runs inside ONE async closure, whose captured state variables freeze at
  // the render that started it — a retry building from those would re-save
  // the stale payload and then overwrite the newer edits on reload (codex
  // #3297 r5b P0). The ref is reassigned every render, so each retry builds
  // from what is actually on screen.
  const formRef = React.useRef(null);
  formRef.current = {
    title, preparedFor, propertyAddress, buildingUse, taxRate, terms, validThrough, projectCosting,
    buildings, scopeItems, programsState, correctiveWork, responsibilitiesText, commercialTerms,
    loadedAuthored, dirty,
  };

  // Structured sections serialize only when actually authored — an empty
  // card omits its key so the server normalizes it to null and the customer
  // surfaces render exactly as before.
  const structuredSectionsPayload = (f) => {
    const items = f.scopeItems
      .map((item) => ({ label: item.label.trim(), value: item.value.trim() }))
      .filter((item) => item.label && item.value);
    const programsPayload = f.programsState
      .filter(programRowIsPriced)
      .map((p) => ({
        ...(p.id ? { id: p.id } : {}),
        service: p.service,
        ...(p.identity ? { identity: p.identity } : {}),
        label: p.label.trim(),
        // UNROUNDED — a fractional entry (4.5) must reach the server's
        // whole-number validation and 400, never silently round to a
        // different promised cadence (codex 1A-ii r1).
        frequencyPerYear: Number(p.frequencyPerYear),
        pricePerApplication: Number(p.pricePerApplication) || 0,
        // UNROUNDED like the frequency: a fractional or out-of-range entry reaches the server's 400.
        ...(String(p.visitMinutes ?? '').trim() !== '' ? { visitMinutes: Number(p.visitMinutes) } : {}),
        taxable: p.taxable === true,
        note: p.note.trim() || null,
        inclusions: p.inclusionsText.split('\n').map((s) => s.trim()).filter(Boolean),
        exclusions: p.exclusionsText.split('\n').map((s) => s.trim()).filter(Boolean),
        // Per-program provenance persists with the program (codex 1A-ii
        // r17) — PUT stores the normalizer output exactly, so omitting
        // these would delete the provenance on every save.
        generatedInclusions: p.genInclusions || [],
        generatedExclusions: p.genExclusions || [],
        // "Name | note" entries keep subdivision notes through the
        // round-trip — name-only parsing silently dropped authored scope
        // like "Exterior only" (codex 1A-ii r13).
        buildings: p.coversText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((entry) => {
          const [rawName, ...noteParts] = entry.split('|');
          const name = rawName.trim();
          const note = noteParts.join('|').trim();
          return name ? { name, ...(note ? { note } : {}) } : null;
        }).filter(Boolean),
      }));
    const work = f.correctiveWork
      .map((w) => ({
        ...(w.id ? { id: w.id } : {}),
        ...(w.service ? { service: w.service } : {}),
        ...(w.originalRequestedService ? { originalRequestedService: w.originalRequestedService } : {}),
        label: w.label.trim(),
        amount: Number(w.amount) || 0,
        taxable: w.taxable === true,
        includes: w.includesText.split('\n').map((s) => s.trim()).filter(Boolean),
      }))
      .filter((w) => w.label);
    const responsibilities = f.responsibilitiesText.split('\n').map((s) => s.trim()).filter(Boolean);
    const ct = {
      paymentTerms: f.commercialTerms.paymentTerms.trim() || null,
      initialTermMonths: f.commercialTerms.initialTermMonths.trim() === '' ? null : Number(f.commercialTerms.initialTermMonths),
      renewal: f.commercialTerms.renewal.trim() || null,
      priceAdjustment: f.commercialTerms.priceAdjustment.trim() || null,
      cancellation: f.commercialTerms.cancellation.trim() || null,
      accessRequirements: f.commercialTerms.accessRequirements.trim() || null,
    };
    const hasTerms = Object.values(ct).some((v) => v !== null);
    return {
      ...(items.length ? { propertyScope: { items } } : {}),
      ...(programsPayload.length ? { programs: programsPayload } : {}),
      ...(work.length ? { correctiveWork: work } : {}),
      ...(responsibilities.length ? { customerResponsibilities: responsibilities } : {}),
      // Provenance of generation-installed responsibility lines — persisted
      // with the proposal so a reopened one prunes exactly what generation
      // wrote (codex 1A-ii r15). PUT persists the payload exactly, so
      // omitting this would delete the stored provenance on every save.
      ...(generatedRespByFamilyRef.current && Object.keys(generatedRespByFamilyRef.current).length
        ? { generatedResponsibilities: generatedRespByFamilyRef.current } : {}),
      ...(hasTerms ? { commercialTerms: ct } : {}),
    };
  };

  // "Add program" opens a chooser: one button per template plus a blank row.
  const programChooser = (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Choose a program to add">
      {PROGRAM_TEMPLATES.map((t) => (
        <Button key={t.service} variant="secondary" size="sm" onClick={() => addProgramFromTemplate(t)}>
          {t.label} · {PROGRAM_FREQUENCY_PRESETS.find((f) => f.perYear === t.frequencyPerYear)?.label}
        </Button>
      ))}
      <Button variant="ghost" size="sm" onClick={addProgram}>Blank program</Button>
      <Button variant="ghost" size="sm" onClick={() => setProgramChooserOpen(false)}>Cancel</Button>
    </div>
  );

  const buildPayload = (f = formRef.current) => ({
    expectedEditVersion: loadedVersionRef.current,
    ...(bidToolsEnabled ? { projectCosting: f.projectCosting } : {}),
    proposal: {
      title: f.title.trim() || 'Commercial Service Proposal',
      preparedFor: f.preparedFor.trim(),
      propertyAddress: f.propertyAddress.trim(),
      ...(f.buildingUse ? { buildingUse: f.buildingUse } : {}),
      taxRate: f.taxRate,
      terms: f.terms.trim() || null,
      ...(bidToolsEnabled ? { validThrough: f.validThrough || null } : {}),
      ...structuredSectionsPayload(f),
      // Priced programs ARE the recurring itemization — the server rejects
      // building line items beside them, so the payload omits buildings
      // entirely in programs mode (the UI collapses that editor too).
      buildings: f.programsState.some(programRowIsPriced) ? [] : f.buildings.map((b) => ({
        name: b.name.trim() || 'Building',
        note: b.note.trim() || null,
        lineItems: b.lineItems
          .filter((l) => l.description.trim())
          .map((l) => ({
            id: l.id,
            description: l.description.trim(),
            quantity: l.quantity,
            unit: l.unit,
            unitPrice: l.unitPrice,
            frequency: l.frequency,
            taxable: l.taxable === true,
            ...(l.service ? { service: l.service } : {}),
            ...(l.originalRequestedService ? { originalRequestedService: l.originalRequestedService } : {}),
            ...(l.quoteRequired === true ? { quoteRequired: true } : {}),
          })),
      })).filter((b) => b.lineItems.length > 0),
    },
  });

  const downloadBidForm = async ({ file, ...options }) => {
    const genAtClick = editGenRef.current;
    if (!locked && !(await save())) throw new Error('Save the proposal successfully before exporting the form.');
    if (editGenRef.current !== genAtClick) throw new Error('The proposal changed while the form was being prepared. Review the form row for each line and download again.');
    const body = new FormData();
    body.append('sourcePdf', file);
    body.append('options', JSON.stringify({ ...options, expectedEditVersion: loadedVersionRef.current }));
    const response = await fetch(`${API_BASE}/admin/estimates/${estimateId}/proposal/bid-form.pdf`, {
      method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` }, body,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'Could not prepare the bid form.');
    }
    const blob = await response.blob();
    if (editGenRef.current !== genAtClick) throw new Error('The proposal changed while the form was being prepared. Review the form row for each line and download again.');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${options.template}-bid-form.pdf`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  // Returns true ONLY when the persisted proposal equals the on-screen
  // state — download/send/Mark-won gate on this, and a true returned while
  // newer keystrokes sit unsaved would let them act on a stale snapshot
  // (codex #3297 r5 P0). Mid-save edits re-save in a bounded loop.
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // The building use sets which rows carry sales tax, so every save states it.
      if (!formRef.current.buildingUse) {
        setError(BUILDING_USE_REQUIRED);
        return false;
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        // Applying the normalized reload below is only safe if no keystroke
        // lands while the round-trip is in flight — otherwise it would
        // silently discard those edits (codex #3297 r5). Generation is
        // captured BEFORE the payload builds: an edit interleaving here
        // makes the end-check fail toward a retry, never toward treating a
        // stale payload as current. (React flushes discrete input events
        // synchronously, so formRef is committed before this continuation
        // runs.)
        const genAtSave = editGenRef.current;
        // EVERY existing unpriced program row is incomplete — a row exists
        // only because the operator added or loaded it, and family/
        // frequency/tax edits leave no text for a content predicate to see
        // (codex 1A-ii r19b, same rule as generation's fill-only check).
        // Unpriced rows would be FILTERED from the payload and silently
        // deleted by the reload — surface the server's minimum-price rule
        // instead (codex 1A-ii r3).
        const incompleteProgram = formRef.current.programsState.find(
          (row) => !programRowIsPriced(row),
        );
        if (incompleteProgram) {
          setError(`Program “${incompleteProgram.label?.trim() || '(unnamed)'}” needs a name, a per-application price of at least $0.01, and a whole-number frequency (1–52) — fix or remove it.`);
          return false;
        }
        const payload = buildPayload();
        if (payload.proposal.buildings.length === 0 && !(payload.proposal.programs || []).length
          && !(payload.proposal.correctiveWork || []).length) {
          setError('Add a service program, corrective work, or a building with a described line item.');
          return false;
        }
        // Programs mode omits buildings from the payload — refuse to save
        // while authored/edited building lines still exist so a manually
        // added program can never silently discard the prior itemization
        // and rewrite the totals without it (codex 1A-ii r2d). The
        // synthesized fallback's own lines don't count.
        if ((payload.proposal.programs || []).length
          && (formRef.current.loadedAuthored || buildingsEditedRef.current || persistedBuildingsRef.current)
          && formRef.current.buildings.some((b) => (b.lineItems || []).some((l) => String(l.description || '').trim()))) {
          setError('Programs replace building line items. Use “Clear building lines” (or remove the programs) before saving — building lines are never silently discarded.');
          return false;
        }
        const committed = await adminFetch(`/admin/estimates/${estimateId}/proposal`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        // The version THIS save committed keys every later save and the
        // delivery review — never a version observed on the reload, which
        // could belong to another editor's save (pre-push codex P1 r3).
        const committedVersion = committed?.editVersion || null;
        if (committedVersion) loadedVersionRef.current = committedVersion;
        // What this PUT just persisted is now the server-side truth — a
        // retry (concurrent edit) must guard against discarding it even
        // before applyLoaded refreshes loadedAuthored.
        persistedBuildingsRef.current = payload.proposal.buildings.length > 0;
        // Swap in the NORMALIZED state before download/send can proceed —
        // the operator must see exactly what persisted (the server clamps
        // string lengths as a safety net; approving un-normalized local
        // state could send a document that differs from the screen — codex
        // #3297 r2). Direct fetch, NOT reload(): reload swallows its error
        // into the page-level banner and resolves (codex #3297 r3).
        const fresh = await adminFetch(`/admin/estimates/${estimateId}/proposal`);
        if (committedVersion && fresh.estimate?.editVersion && fresh.estimate.editVersion !== committedVersion) {
          // Another editor saved between this PUT and its reload: their
          // content is on the server under a newer version. Applying it
          // here would drop it from view while keeping ours in the form;
          // adopting its version would let the next save overwrite it.
          setError('The proposal was changed by another editor right after your save. Reload to review the latest version before editing further.');
          return false;
        }
        if (!committedVersion) loadedVersionRef.current = fresh.estimate?.editVersion;
        if (editGenRef.current === genAtSave) {
          applyLoaded(fresh);
          setDirty(false);
          setSavedOnce(true);
          return true;
        }
        // Edits landed mid-flight — loop and persist the newer state.
      }
      setError('Your latest edits are still unsaved — pause typing and save again.');
      return false;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const downloadPdf = async () => {
    setError(null);
    setDownloading(true);
    try {
      // The PDF renders server-side from persisted estimate_data, so save the
      // on-screen edits first (skipped when locked — the stored proposal IS
      // what's on screen then).
      if (!locked) {
        const saved = await save();
        if (!saved) return;
      }
      // The shared adminFetch always parses the body as JSON, which corrupts
      // PDF bytes — raw fetch (same auth header) and read as a blob.
      const r = await fetch(`${API_BASE}/admin/estimates/${estimateId}/proposal.pdf`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
      });
      if (!r.ok) throw new Error(`Could not generate PDF (${r.status})`);
      const blob = await r.blob();
      // Save a real file (no blank blob tab, no dead link after a minute): a
      // temporary anchor with a download name, like the bid-form export. The
      // name is the number the estimate page prints, else a short id.
      const slug = String(estimate?.estimateSlug || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      const shortId = String(estimateId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Waves-Proposal-${slug || shortId || 'copy'}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  };

  const sendProposal = async () => {
    setError(null);
    setSending(true);
    try {
      // Persist any on-screen edits so the emailed PDF matches the page.
      if (dirty || !savedOnce) {
        const saved = await save();
        if (!saved) return;
      }
      const outcome = await openSend(estimateId, {
        expectedEditVersion: loadedVersionRef.current,
      });
      if (outcome) await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  // Mirrors the estimates-list Mark won flow: proposals are won manually (no
  // online checkout); the server creates the customer when none is linked. No
  // invoice is made at the win: each visit bills when it is completed.
  const markWon = async () => {
    setError(null);
    const invoiceMode = !!estimate?.billByInvoice;
    const confirmMsg = invoiceMode
      ? `Mark ${estimate?.customerName || 'this proposal'} as won?\n\nThis stamps the proposal as won and creates the customer if none is linked. No invoice is created now: each visit is billed once when it is completed, including any one-time work booked on it. The customer is NOT texted and NOT auto-scheduled.`
      : `Mark ${estimate?.customerName || 'this proposal'} as won?\n\nThis stamps the proposal as won and creates the customer if none is linked. The customer is NOT texted, NOT auto-scheduled, and NO invoice is created — bill it from the proposal when ready.`;
    if (!window.confirm(confirmMsg)) return;
    setMarkingWon(true);
    try {
      if (dirty) {
        const saved = await save();
        if (!saved) return;
      }
      const result = await adminFetch(`/admin/estimates/${estimateId}/mark-accepted`, {
        method: 'POST',
        body: JSON.stringify({ source: 'verbal_yes' }),
      });
      const notes = [];
      if (result?.createdCustomer?.id) notes.push('A new customer record was created from the proposal.');
      if (result?.warnings?.length) notes.push(...result.warnings);
      if (notes.length) window.alert(`Marked won:\n\n${notes.join('\n')}`);
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setMarkingWon(false);
    }
  };

  const copyLink = () => {
    if (!estimate?.token) return;
    navigator.clipboard?.writeText(`${window.location.origin}/estimate/${estimate.token}`);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-13 text-zinc-500">
        <Loader2 size={16} className="animate-spin" /> Loading proposal…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <div className="text-13 text-alert-fg bg-alert-bg border border-hairline border-alert-fg/30 rounded px-3 py-2">
          {loadError}
        </div>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/admin/estimates')}>
          <ArrowLeft size={15} /> Back to estimates
        </Button>
      </div>
    );
  }

  const statusLabel = STATUS_LABELS[estimate?.status] || estimate?.status || 'Draft';

  return (
    <div className="max-w-6xl mx-auto px-4 py-5">
      {/* Header */}
      <AdminCommandHeader
        title={`Commercial proposal — ${estimate?.customerName || 'Estimate'}`}
        icon={Building2}
        actions={[
          { key: 'back', label: 'Estimates', size: 'sm', variant: 'ghost', icon: ArrowLeft, onClick: () => navigate('/admin/estimates') },
        ]}
      />
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {estimate?.address && (
          <div className="min-w-0 text-13 text-zinc-500 truncate">{estimate.address}</div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Badge tone={estimate?.status === 'accepted' ? 'strong' : 'neutral'}>{statusLabel}</Badge>
          {estimate?.billByInvoice && <Badge tone="neutral">Bill by invoice</Badge>}
          {dirty && <Badge tone="neutral">Unsaved changes</Badge>}
        </div>
      </div>

      {locked && (
        <div className="mb-4 text-13 text-zinc-600 bg-zinc-50 border border-hairline border-zinc-200 rounded px-3 py-2">
          {locked}
        </div>
      )}
      {error && (
        <div className="mb-4 text-13 text-alert-fg bg-alert-bg border border-hairline border-alert-fg/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-5 items-start">
        {/* Main column. Read-only while a send or a Mark won runs: each ends in a reload that replaces the form and
            clears Unsaved changes, so an edit typed meanwhile would be lost without a trace (pipeline audit 10-30,
            item 3). A disabled fieldset turns off every field, picker and row button inside it at once. Preflight is
            off in this app, so the fieldset's browser border, padding and margin are reset here. */}
        <fieldset disabled={sending || markingWon} className="flex-1 min-w-0 w-full space-y-5 m-0 p-0 border-0">
          {!locked && (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="sm" onClick={generateFromEstimate} disabled={generating}>
                {generating ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
                Generate from estimate
              </Button>
              <span className="text-12 text-zinc-500">Fills the empty sections from the estimate. It never replaces what is already filled in.</span>
            </div>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Proposal details</CardTitle>
            </CardHeader>
            <CardBody>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className={LABEL}>Proposal title</span>
                  <Input value={title} disabled={!!locked} className="mt-1"
                    onChange={(e) => { setTitle(e.target.value); touch(); }} />
                </label>
                <label className="block">
                  <span className={LABEL}>Prepared for</span>
                  <Input value={preparedFor} disabled={!!locked} className="mt-1"
                    placeholder="e.g. Yellowstone HOA, attn: Board of Directors"
                    onChange={(e) => { setPreparedFor(e.target.value); touch(); }} />
                </label>
                <label className="block">
                  <span className={LABEL}>Property address</span>
                  <Input value={propertyAddress} disabled={!!locked} className="mt-1"
                    onChange={(e) => { setPropertyAddress(e.target.value); touch(); }} />
                </label>
                <div className="block">
                  {showTaxInput ? (
                    <label className="block">
                      <span className={LABEL}>Tax rate (%) — taxable lines only</span>
                      <Input type="number" min="0" step="0.01" value={taxRatePct} className="mt-1"
                        onChange={(e) => { taxOperatorEditedRef.current = true; setTaxOverride(true); setTaxRatePct(e.target.value); touch(); }} />
                    </label>
                  ) : (
                    <>
                      <span className={LABEL}>Tax rate — taxable lines only</span>
                      <div className="mt-1 flex items-center gap-2">
                        <span data-testid="tax-rate-chip"
                          className="inline-flex min-w-0 items-center h-11 md:h-9 px-3 rounded-sm border border-hairline border-zinc-300 bg-zinc-50 text-14 md:text-13 tabular-nums text-zinc-900">
                          <span className="truncate">
                            {locked
                              ? `${formatPct(currentPct)}%${suggestedPct != null && Math.abs(currentPct - suggestedPct) < 0.0001 && suggestedTaxSource ? ` · ${suggestedTaxSource}` : ''}`
                              : suggestedTaxLabel}
                          </span>
                        </span>
                        {!locked && (
                          <Button variant="ghost" size="sm" onClick={overrideTax}>Override</Button>
                        )}
                      </div>
                    </>
                  )}
                  {showTaxInput && suggestedPct != null && (
                    <button type="button" className="mt-1 block bg-transparent border-0 p-0 cursor-pointer text-12 text-zinc-600 underline underline-offset-2" onClick={applySuggestedTax}>
                      Use {suggestedTaxLabel}
                    </button>
                  )}
                  {showTaxInput && suggestedPct == null && (
                    <span className="mt-1 block text-12 text-zinc-500">The county rate could not be looked up. Enter the rate.</span>
                  )}
                </div>
                <div className="block">
                  <label className="block">
                    <span className={LABEL}>Building use</span>
                    <Select className="mt-1" value={buildingUse} disabled={!!locked}
                      onChange={(e) => chooseBuildingUse(e.target.value)}>
                      {!buildingUse && <option value="">{locked ? 'Not set' : 'Pick one'}</option>}
                      {BUILDING_USE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </Select>
                  </label>
                  {(buildingUse || !locked) && (
                    <span className="mt-1 block text-12 text-zinc-500">
                      {BUILDING_USE_OPTIONS.find((option) => option.value === buildingUse)?.note
                        || 'Pick before saving. It sets which rows carry sales tax.'}
                    </span>
                  )}
                  {differingTaxRows > 0 && (
                    <span className="mt-1 block text-12 text-zinc-700" role="note" data-testid="row-tax-summary">
                      Taxable differs from the building use on {plural(differingTaxRows, 'row')}.
                      Visit bills follow the building use, so they will not match the quote there.
                    </span>
                  )}
                </div>
              </div>
            </CardBody>
          </Card>

          {prospectBrief && (
            <Card>
              <CardHeader>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left bg-transparent border-0 p-0 cursor-pointer u-focus-ring"
                  onClick={() => setBriefOpen((v) => !v)}
                >
                  <ClipboardList size={15} className="text-zinc-500" />
                  <CardTitle>Prospect research</CardTitle>
                  <span className="text-11 uppercase tracking-label text-zinc-400">internal — never sent</span>
                  <span className="ml-auto text-zinc-400">
                    {briefOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </span>
                </button>
              </CardHeader>
              {briefOpen && (
                <CardBody className="space-y-4">
                  {prospectBrief.summary && (
                    <p className="text-14 text-zinc-700 whitespace-pre-wrap">{prospectBrief.summary}</p>
                  )}
                  {prospectBrief.propertyProfile && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                      {[
                        ['Property type', prospectBrief.propertyProfile.propertyType],
                        ['Footprint sqft', prospectBrief.propertyProfile.footprintSqft?.toLocaleString?.()],
                        ['Units', prospectBrief.propertyProfile.units],
                        ['Buildings', prospectBrief.propertyProfile.buildings],
                        ['Land use', prospectBrief.propertyProfile.landUse],
                      ].filter(([, v]) => v != null && v !== '').map(([label, value]) => (
                        <div key={label}>
                          <div className={LABEL}>{label}</div>
                          <div className="text-13 text-zinc-700 mt-0.5">{String(value)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {(prospectBrief.servicePrograms || []).length > 0 && (
                    <div>
                      <div className={LABEL}>Suggested programs (unpriced)</div>
                      <ul className="mt-1 space-y-1">
                        {prospectBrief.servicePrograms.map((p, i) => (
                          <li key={i} className="text-13 text-zinc-700">
                            <span className="text-zinc-900">{p.name}</span>
                            {p.cadence && <span className="text-zinc-500"> · {p.cadence.replace('_', '-')}</span>}
                            {p.scope && <span className="text-zinc-500"> — {p.scope}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(prospectBrief.riskFactors || []).length > 0 && (
                    <div>
                      <div className={LABEL}>Risk factors</div>
                      <ul className="mt-1 space-y-1 list-disc pl-4">
                        {prospectBrief.riskFactors.map((r, i) => (
                          <li key={i} className="text-13 text-zinc-700">{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(prospectBrief.walkthroughChecklist || []).length > 0 && (
                    <div>
                      <div className={LABEL}>Walkthrough checklist</div>
                      <ul className="mt-1 space-y-1 list-disc pl-4">
                        {prospectBrief.walkthroughChecklist.map((r, i) => (
                          <li key={i} className="text-13 text-zinc-700">{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(prospectBrief.openQuestions || []).length > 0 && (
                    <div>
                      <div className={LABEL}>Open questions</div>
                      <ul className="mt-1 space-y-1 list-disc pl-4">
                        {prospectBrief.openQuestions.map((r, i) => (
                          <li key={i} className="text-13 text-zinc-700">{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {prospectBrief.researchedAt && (
                    <div className="text-11 text-zinc-400">
                      Researched {new Date(prospectBrief.researchedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET
                    </div>
                  )}
                </CardBody>
              )}
            </Card>
          )}

          <FoldCard
            title="Property scope" open={openSections.scope} onToggle={() => toggleSection('scope')}
            summary={scopeSummary} bodyClassName="space-y-2"
          >
            <div className="text-12 text-zinc-500">
              Optional — facts the proposal was scoped against (buildings, units, turf sq ft,
              device counts). Shown on the proposal when filled in.
            </div>
            {scopeItems.map((item, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <Input
                  size="sm" className="w-32 sm:w-48 shrink-0" placeholder="Label (e.g. Units)" maxLength={80}
                  value={item.label} disabled={!!locked}
                  onChange={(e) => { markEdit(); setScopeItems((prev) => prev.map((it, i) => (i === idx ? { ...it, label: e.target.value } : it))); }}
                />
                <Input
                  size="sm" className="flex-1" placeholder="Value (e.g. 4 residential units, tenant-occupied)" maxLength={160}
                  value={item.value} disabled={!!locked}
                  onChange={(e) => { markEdit(); setScopeItems((prev) => prev.map((it, i) => (i === idx ? { ...it, value: e.target.value } : it))); }}
                />
                {!locked && (
                  <Button variant="ghost" size="sm" title="Remove row"
                    onClick={() => { markEdit(); setScopeItems((prev) => prev.filter((_, i) => i !== idx)); }}>
                    <Trash2 size={14} />
                  </Button>
                )}
              </div>
            ))}
            {!locked && (
              <Button variant="ghost" size="sm"
                onClick={() => { markEdit(); setScopeItems((prev) => [...prev, { label: '', value: '' }]); }}>
                <Plus size={14} /> Add scope row
              </Button>
            )}
          </FoldCard>

          {programsState.length === 0 ? (
            !locked && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-hairline border-zinc-200 bg-white px-4 py-3">
                <span className="flex-1 min-w-[200px] text-13 text-zinc-600">
                  Price by service program (a price per application) instead of building line items?
                </span>
                {programChooserOpen ? programChooser : (
                  <Button variant="secondary" size="sm" onClick={() => setProgramChooserOpen(true)}>
                    <Plus size={14} /> Add program
                  </Button>
                )}
              </div>
            )
          ) : (
            <FoldCard
              title="Service programs" open={openSections.programs} onToggle={() => toggleSection('programs')}
              summary={`${plural(programsState.length, 'program')} · ${money(programsAnnual)}/yr`}
              bodyClassName="space-y-3"
            >
              <div className="text-12 text-zinc-500">
                Per-service programs with per-application pricing — when any program is priced, programs
                replace the building line items as the recurring itemization (use &ldquo;Covers&rdquo; for
                building labels). Annual totals derive from price × frequency.
              </div>
              {programsState.map((p, idx) => {
                const freqChoice = programFrequencyChoice(p);
                return (
                  <div key={idx} className="space-y-2 border-b border-hairline border-zinc-100 pb-3 last:border-0 last:pb-0">
                    <div className="flex flex-wrap gap-2 items-end">
                      <label className="block w-32 shrink-0">
                        <span className={LABEL}>Service</span>
                        <Select
                          size="sm" className="mt-1" value={p.service} disabled={!!locked} aria-label="Service family"
                          onChange={(e) => changeProgramFamily(idx, e.target.value)}
                        >
                          {PROGRAM_FAMILY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </Select>
                      </label>
                      <label className="block flex-1 min-w-[180px]">
                        <span className={LABEL}>Program name</span>
                        <Input
                          size="sm" className="mt-1" placeholder="e.g. Quarterly pest program" maxLength={120}
                          value={p.label} disabled={!!locked}
                          onChange={(e) => patchProgram(idx, { label: e.target.value })}
                        />
                      </label>
                      <label className="block w-36 shrink-0">
                        <span className={LABEL}>Frequency</span>
                        <Select
                          size="sm" className="mt-1" value={freqChoice} disabled={!!locked} aria-label="Program frequency"
                          onChange={(e) => (e.target.value === 'custom'
                            ? patchProgram(idx, { freqCustom: true })
                            : setProgramFrequency(idx, Number(e.target.value), false))}
                        >
                          {PROGRAM_FREQUENCY_PRESETS.map((f) => <option key={f.perYear} value={String(f.perYear)}>{f.label}</option>)}
                          <option value="custom">Custom</option>
                        </Select>
                      </label>
                      {freqChoice === 'custom' && (
                        <label className="block w-24 shrink-0">
                          <span className={LABEL}>Visits / yr</span>
                          <Input
                            size="sm" className="mt-1" type="number" min="1" max="52" step="1" title="Visits per year" aria-label="Visits per year"
                            value={p.frequencyPerYear} disabled={!!locked}
                            onChange={(e) => setProgramFrequency(idx, e.target.value, true)}
                          />
                        </label>
                      )}
                      <label className="block w-40 shrink-0">
                        <span className={LABEL}>Price per application</span>
                        <Input
                          size="sm" className="mt-1" type="number" min="0" step="0.01" title="Price per application" aria-label="Price per application"
                          value={p.pricePerApplication} disabled={!!locked}
                          onChange={(e) => patchProgram(idx, { pricePerApplication: e.target.value })}
                        />
                      </label>
                      <label className="block w-28 shrink-0">
                        <span className={LABEL}>Visit minutes</span>
                        <Input
                          size="sm" className="mt-1" type="number" min="5" max="480" step="5"
                          title="Visit length in minutes (sizes the first visit a customer books online; over 90, the office books it)"
                          aria-label="Visit length in minutes"
                          value={p.visitMinutes ?? ''} disabled={!!locked}
                          onChange={(e) => patchProgram(idx, { visitMinutes: e.target.value })}
                        />
                      </label>
                      <div className="flex h-11 md:h-7 items-center gap-2 shrink-0">
                        <Switch
                          checked={p.taxable} disabled={!!locked} aria-label="Taxable program"
                          onChange={(v) => patchProgram(idx, { taxable: v, taxTouched: true })}
                        />
                        <span className="text-13 text-zinc-600">Taxable</span>
                      </div>
                      <span className="flex h-11 md:h-7 items-center text-13 text-zinc-700 tabular-nums shrink-0">
                        {money(roundMoney((Number(p.pricePerApplication) || 0) * (Math.round(Number(p.frequencyPerYear)) || 0)))}/yr
                      </span>
                      {!locked && (
                        <Button variant="ghost" size="sm" title="Remove program" aria-label="Remove program"
                          onClick={() => removeProgram(idx)}>
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                    <RowTaxNotice text={rowNotice(p)} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <label className="block">
                        <span className={LABEL}>Includes</span>
                        <Textarea
                          className="mt-1" rows={3} value={p.inclusionsText} disabled={!!locked}
                          placeholder={'What this program includes — one per line'}
                          onChange={(e) => patchProgram(idx, { inclusionsText: e.target.value })}
                        />
                      </label>
                      <label className="block">
                        <span className={LABEL}>Not included</span>
                        <Textarea
                          className="mt-1" rows={3} value={p.exclusionsText} disabled={!!locked}
                          placeholder={'Not included / quoted separately — one per line'}
                          onChange={(e) => patchProgram(idx, { exclusionsText: e.target.value })}
                        />
                      </label>
                    </div>
                    <label className="block">
                      <span className={LABEL}>Covers (optional)</span>
                      <Input
                        size="sm" className="mt-1" placeholder="Comma-separated names, add a note with | (e.g. Tower A | Exterior only, Clubhouse)" maxLength={400}
                        value={p.coversText} disabled={!!locked}
                        onChange={(e) => patchProgram(idx, { coversText: e.target.value })}
                      />
                    </label>
                    {/* Customer-visible on every proposal surface — a loaded
                        note must be editable here, not silently round-tripped
                        out of sight (codex 1A-ii r15). */}
                    <label className="block">
                      <span className={LABEL}>Program note (optional, shown on the proposal)</span>
                      <Input
                        size="sm" className="mt-1" maxLength={300}
                        value={p.note} disabled={!!locked}
                        onChange={(e) => patchProgram(idx, { note: e.target.value })}
                      />
                    </label>
                  </div>
                );
              })}
              {!locked && (programChooserOpen ? programChooser : (
                <Button variant="ghost" size="sm" onClick={() => setProgramChooserOpen(true)}>
                  <Plus size={14} /> Add program
                </Button>
              ))}
            </FoldCard>
          )}

          {programsMode && (
            <div className="flex flex-wrap items-center gap-3 text-13 text-zinc-600 bg-zinc-50 border border-hairline border-zinc-200 rounded px-3 py-2">
              <span className="flex-1 min-w-[240px]">
                Service programs are the recurring itemization — the building line-item editor is hidden and
                building lines are not saved alongside programs. Use each program&rsquo;s &ldquo;Covers&rdquo; field for building labels.
              </span>
              {!locked && buildings.some((b) => (b.lineItems || []).some((l) => String(l.description || '').trim())) && (
                <Button variant="secondary" size="sm"
                  onClick={() => { markBuildingsEdit(); setBuildings([emptyBuilding(0, taxUnderUse(familyRule('other')))]); }}>
                  <Trash2 size={14} /> Clear building lines
                </Button>
              )}
            </div>
          )}

          {!programsMode && buildings.map((b, bi) => {
            const sub = buildingSubtotals(b);
            return (
              <Card key={bi}>
                <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-zinc-50 border-b border-hairline border-zinc-200 rounded-t-md">
                  <Building2 size={15} className="text-zinc-400 shrink-0" />
                  <Input
                    value={b.name} disabled={!!locked} size="sm"
                    className="flex-1 min-w-[160px]" placeholder="Building / area name (e.g. Clubhouse & pool)"
                    onChange={(e) => mutateBuilding(bi, (x) => ({ ...x, name: e.target.value }))}
                  />
                  {!locked && (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => duplicateBuilding(bi)} title="Duplicate building">
                        <Copy size={14} />
                      </Button>
                      {buildings.length > 1 && (
                        <Button variant="ghost" size="sm" onClick={() => removeBuilding(bi)} title="Remove building">
                          <Trash2 size={15} />
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                <CardBody className="space-y-2">
                  {/* Column headers (desktop) */}
                  <div className={`hidden md:grid ${showUnitColumn ? 'grid-cols-[repeat(14,minmax(0,1fr))]' : 'grid-cols-12'} gap-2 px-0.5`}>
                    <span className={`${showUnitColumn ? 'col-span-2' : 'col-span-4'} ${LABEL}`}>Service description</span>
                    <span className={`${showUnitColumn ? 'col-span-2' : 'col-span-1'} ${LABEL}`}>Qty</span>
                    {showUnitColumn && <span className={`col-span-2 ${LABEL}`}>Unit</span>}
                    <span className={`col-span-2 ${LABEL}`}>Unit price</span>
                    <span className={`col-span-2 ${LABEL}`}>Frequency</span>
                    <span className={`col-span-1 ${LABEL} text-center`}>Tax</span>
                    <span className={`${showUnitColumn ? 'col-span-2' : 'col-span-1'} ${LABEL} text-right`}>Amount</span>
                    <span className="col-span-1" />
                  </div>

                  {b.lineItems.map((li, lii) => (
                    <div key={lii} className={`grid grid-cols-2 ${showUnitColumn ? 'md:grid-cols-[repeat(14,minmax(0,1fr))]' : 'md:grid-cols-12'} gap-2 items-end md:items-center border-b border-hairline border-zinc-100 md:border-0 pb-2 md:pb-0`}>
                      <label className={`block col-span-2 ${showUnitColumn ? 'md:col-span-2' : 'md:col-span-4'}`}>
                        <span className={PHONE_LABEL}>Service description</span>
                        <Input
                          size="sm" placeholder="Service description"
                          value={li.description} disabled={!!locked}
                          onChange={(e) => updateLine(bi, lii, { description: e.target.value })}
                        />
                      </label>
                      <label className={`block col-span-1 ${showUnitColumn ? 'md:col-span-2' : 'md:col-span-1'}`}>
                        <span className={PHONE_LABEL}>Qty</span>
                        <Input
                          size="sm" type="number" min="0.0001" step="0.0001" title="Quantity" aria-label="Quantity"
                          value={li.quantity} disabled={!!locked}
                          onChange={(e) => updateLine(bi, lii, { quantity: e.target.value })}
                        />
                      </label>
                      {showUnitColumn && (
                        <label className="block col-span-1 md:col-span-2">
                          <span className={PHONE_LABEL}>Unit</span>
                          <Select size="sm" value={li.unit || ''} disabled={!!locked || !bidToolsEnabled} aria-label="Quantity unit"
                            onChange={(e) => updateLine(bi, lii, { unit: e.target.value })}>
                            <option value="">No unit</option>
                            {Object.entries(PROPOSAL_UNITS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                          </Select>
                        </label>
                      )}
                      <label className="block col-span-1 md:col-span-2">
                        <span className={PHONE_LABEL}>Unit price</span>
                        <Input
                          size="sm" type="number" min="0" step="0.0001" title="Unit price" aria-label="Unit price"
                          value={li.unitPrice} disabled={!!locked}
                          onChange={(e) => updateLine(bi, lii, { unitPrice: e.target.value })}
                        />
                      </label>
                      <label className="block col-span-1 md:col-span-2">
                        <span className={PHONE_LABEL}>Frequency</span>
                        <Select
                          size="sm" value={li.frequency} disabled={!!locked} aria-label="Frequency"
                          onChange={(e) => updateLine(bi, lii, { frequency: e.target.value })}
                        >
                          {FREQUENCY_OPTIONS.map((f) => (
                            <option key={f.value} value={f.value}>{f.label}</option>
                          ))}
                        </Select>
                      </label>
                      <div className="col-span-1 md:col-span-1 flex h-11 md:h-auto md:justify-center items-center gap-2" title="Taxable line">
                        <Switch checked={li.taxable} disabled={!!locked} aria-label="Taxable line"
                          onChange={(v) => updateLine(bi, lii, { taxable: v })} />
                        <span className="md:hidden text-13 text-zinc-600">Taxable</span>
                      </div>
                      <div
                        className={`col-span-1 ${showUnitColumn ? 'md:col-span-2' : 'md:col-span-1'} text-right text-13 tabular-nums text-zinc-700`}
                        title={li.frequency === 'one_time' ? 'One-time amount' : `${money(lineAnnual(li))} per year`}
                      >
                        <span className={PHONE_LABEL}>Amount</span>
                        {money(lineAmount(li))}
                        {li.frequency !== 'one_time' && (
                          <span className="text-11 text-zinc-400">/{FREQUENCY_OPTIONS.find((f) => f.value === li.frequency)?.perYear === 12 ? 'mo' : 'visit'}</span>
                        )}
                      </div>
                      <div className="col-span-1 md:col-span-1 flex justify-end">
                        {!locked && b.lineItems.length > 1 && (
                          <Button variant="ghost" size="sm" onClick={() => removeLine(bi, lii)} title="Remove line" aria-label="Remove line">
                            <Trash2 size={14} />
                          </Button>
                        )}
                      </div>
                      <RowTaxNotice text={rowNotice(li)} />
                    </div>
                  ))}

                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    {!locked && (
                      <Button variant="ghost" size="sm" onClick={() => addLine(bi)}>
                        <Plus size={14} /> Add line item
                      </Button>
                    )}
                    <span className="ml-auto text-12 text-zinc-500 tabular-nums">
                      Recurring {money(sub.annual)}/yr · One-time {money(sub.oneTime)}
                    </span>
                  </div>

                  <label className="block pt-1">
                    <span className={LABEL}>Building note (optional — shown on the PDF)</span>
                    <Input
                      size="sm" className="mt-1" value={b.note} disabled={!!locked}
                      placeholder="e.g. Rodent stations serviced quarterly; written activity report to the board after every visit."
                      onChange={(e) => mutateBuilding(bi, (x) => ({ ...x, note: e.target.value }))}
                    />
                  </label>
                </CardBody>
              </Card>
            );
          })}

          {!locked && !programsMode && (
            <Button variant="secondary" size="sm" onClick={addBuilding}>
              <Plus size={15} /> Add building
            </Button>
          )}

          {bidToolsEnabled && (
            <div className="flex items-center gap-2 text-14">
              <Switch
                checked={bidToolsOpen}
                id="bid-tools-switch" label="Bid tools"
                onChange={(v) => { bidToolsChosenRef.current = true; setBidToolsOpen(v); }}
              />
              <span className="text-zinc-600">Required bid form and private project cost sheet, for solicitation bids.</span>
            </div>
          )}
          {bidToolsEnabled && !programsMode && (
            <div hidden={!bidToolsOpen}>
              <ProposalBidForm buildings={buildings} onDownload={downloadBidForm} disabled={saving || estimate?.status === 'sending'} />
            </div>
          )}
          {(bidToolsEnabled || projectCosting.rows.length > 0) && (
            <div hidden={bidToolsEnabled && !bidToolsOpen}>
              <ProposalProjectCosting value={projectCosting} totals={totals} revenueIssue={revenueIssue} disabled={!!locked || !bidToolsEnabled}
                onChange={(value) => { setProjectCosting(value); markEdit(); }} />
            </div>
          )}

          <FoldCard
            title="Corrective work (one-time)" open={openSections.corrective} onToggle={() => toggleSection('corrective')}
            summary={correctiveSummary} bodyClassName="space-y-3"
          >
            <div className="text-12 text-zinc-500">
              Optional — one-time remediation separated from the recurring programs.
              Amounts count toward the one-time and first-year totals.
            </div>
            {correctiveWork.map((w, idx) => (
              <div key={idx} className="space-y-2 border-b border-hairline border-zinc-100 pb-3 last:border-0 last:pb-0">
                <div className="flex flex-wrap gap-2 items-end">
                  <label className="block flex-1 min-w-[200px]">
                    <span className={LABEL}>Work description</span>
                    <Input
                      size="sm" className="mt-1" placeholder="e.g. Initial German roach cleanout — Units 2 & 4" maxLength={160}
                      value={w.label} disabled={!!locked}
                      onChange={(e) => patchCorrective(idx, { label: e.target.value })}
                    />
                  </label>
                  <label className="block w-28 shrink-0">
                    <span className={LABEL}>Amount</span>
                    <Input
                      size="sm" className="mt-1" type="number" min="0" step="0.01" title="Amount" aria-label="Amount"
                      value={w.amount} disabled={!!locked}
                      onChange={(e) => patchCorrective(idx, { amount: e.target.value })}
                    />
                  </label>
                  <div className="flex h-11 md:h-7 items-center gap-2 shrink-0">
                    <Switch
                      checked={w.taxable} disabled={!!locked} aria-label="Taxable work"
                      onChange={(v) => patchCorrective(idx, { taxable: v })}
                    />
                    <span className="text-13 text-zinc-600">Taxable</span>
                  </div>
                  {!locked && (
                    <Button variant="ghost" size="sm" title="Remove work item" aria-label="Remove work item"
                      onClick={() => { markEdit(); setCorrectiveWork((prev) => prev.filter((_, i) => i !== idx)); }}>
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
                <RowTaxNotice text={rowNotice(w)} />
                <label className="block">
                  <span className={LABEL}>What it includes</span>
                  <Textarea
                    className="mt-1" rows={2} value={w.includesText} disabled={!!locked}
                    placeholder={'One per line\ne.g. Crack & crevice treatment in both kitchens\nFollow-up inspection at 2 weeks'}
                    onChange={(e) => patchCorrective(idx, { includesText: e.target.value })}
                  />
                </label>
              </div>
            ))}
            {!locked && (
              <Button variant="ghost" size="sm"
                onClick={() => { markEdit(); setCorrectiveWork((prev) => [...prev, { id: crypto.randomUUID(), label: '', amount: 0, ...taxUnderUse(familyRule('other')), includesText: '' }]); }}>
                <Plus size={14} /> Add corrective work
              </Button>
            )}
          </FoldCard>

          <FoldCard
            title="Customer responsibilities" open={openSections.responsibilities} onToggle={() => toggleSection('responsibilities')}
            summary={responsibilitiesSummary}
          >
            <Textarea
              rows={3} value={responsibilitiesText} disabled={!!locked} aria-label="Customer responsibilities"
              placeholder={'Optional — one per line\ne.g. Provide unit access with 24-hour tenant notice\nReport pest activity through the Waves app or office line'}
              onChange={(e) => { setResponsibilitiesText(e.target.value); touch(); }}
            />
          </FoldCard>

          <FoldCard
            title="Commercial terms" open={openSections.terms} onToggle={() => toggleSection('terms')}
            summary={termsSummary}
          >
            {(bidToolsEnabled || validThrough) && <label className="block mb-4 text-14">
              Valid through (Eastern time)
              <Input type="date" value={validThrough} disabled={!!locked || !bidToolsEnabled} className="mt-1 max-w-xs"
                onChange={(e) => { setValidThrough(e.target.value); markEdit(); }} />
              <span className="block mt-1 text-zinc-600">Prices remain valid through the end of this date, including resends. Leave blank for the standard seven days after sending. For a bid hold, enter the date required by the solicitation.</span>
            </label>}
            <div className="text-12 text-zinc-500 mb-2">
              Optional — structured terms shown as their own section on the proposal.
              Free-text terms below become &ldquo;Additional terms&rdquo; once any of these are set.
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className={LABEL}>Payment terms</span>
                {/* Canonical payer vocabulary only (server rejects free
                    text) — billing derives due dates from these tokens,
                    which only exists for invoice-mode proposals. Auto Pay
                    (GATE_COMMERCIAL_AUTOPAY) is the one term for a proposal
                    that does NOT bill by invoice: the customer's Auto Pay
                    collects after each service, and the server refuses it
                    beside Bill by invoice. */}
                {/* Stays ENABLED when a stored term exists on a
                    non-invoice proposal so the operator can CLEAR the
                    stale term (the PUT rejects setting a new one). */}
                <Select
                  size="sm" className="mt-1" value={commercialTerms.paymentTerms}
                  disabled={!!locked || (!estimate?.billByInvoice && !autopayEnabled && !commercialTerms.paymentTerms)}
                  onChange={(e) => { markEdit(); setCommercialTerms((prev) => ({ ...prev, paymentTerms: e.target.value })); }}
                >
                  <option value="">Not set</option>
                  {!estimate?.billByInvoice && (autopayEnabled || commercialTerms.paymentTerms === AUTOPAY_PAYMENT_TERMS) && (
                    <option value={AUTOPAY_PAYMENT_TERMS}>Auto Pay</option>
                  )}
                  {/* Net-15 and Due on receipt have no signed-agreement
                      wording (owner 2026-10-28 builder scope), so they are
                      not offered; a proposal already on one shows it so it
                      can be changed. */}
                  {['due_on_receipt', 'net15'].includes(commercialTerms.paymentTerms) && (
                    <option value={commercialTerms.paymentTerms} disabled={!estimate?.billByInvoice}>
                      {PAYMENT_TERM_LABELS[commercialTerms.paymentTerms]} (no online signing)
                    </option>
                  )}
                  <option value={INVOICE_PAYMENT_TERMS} disabled={!estimate?.billByInvoice}>Net-30</option>
                  {/* Net-60: the Net 30 paragraph with sixty days (owner 2026-10-29). Signs online like Net-30. */}
                  <option value={NET60_PAYMENT_TERMS} disabled={!estimate?.billByInvoice}>Net-60</option>
                </Select>
                {!estimate?.billByInvoice && (
                  <span className="mt-1 block text-11 text-zinc-400">
                    {autopayEnabled
                      ? 'Auto Pay charges the saved card or bank account after each service. Net terms require Bill by invoice.'
                      : 'Requires Bill by invoice — for manually billed agreements, put payment language in Additional terms.'}
                  </span>
                )}
              </label>
              {/* maxLength mirrors normalizeCommercialTerms' clamps so a
                  contractual sentence can never silently truncate on save
                  (codex #3297 r2). */}
              {!hasRecurring && (
                <p className="text-12 text-zinc-500 sm:col-span-2">
                  One-time work: no term applies. Term picks show when the proposal has a recurring program.
                </p>
              )}
              {hasRecurring && [
                ['initialTermMonths', 'Initial term', undefined],
                ['renewal', 'Renewal', 120],
                ['priceAdjustment', 'Price adjustment', 160],
                ['cancellation', 'Cancellation', 160],
              ].map(([key, label, maxLength]) => {
                const choice = termChoices[key];
                return (
                  <div key={key}>
                    <label className="block">
                      <span className={LABEL}>{label}</span>
                      <Select size="sm" className="mt-1" value={choice} disabled={!!locked}
                        onChange={(e) => chooseTerm(key, e.target.value)}>
                        <option value="standard">{key === 'initialTermMonths' ? `${AGREEMENT_TERMS.initialTermMonths} months (standard)` : 'Standard'}</option>
                        {choice === 'none' && <option value="none">Not stated (old proposal)</option>}
                        <option value="custom">Custom</option>
                      </Select>
                    </label>
                    {choice === 'standard' && key !== 'initialTermMonths' && (
                      <p className="mt-1 text-12 text-zinc-500">{standardTermText(key)}</p>
                    )}
                    {choice === 'none' && (
                      <p className="mt-1 text-12 text-zinc-500">
                        Not on the proposal. Pick Standard or Custom.
                      </p>
                    )}
                    {choice === 'custom' && (key === 'initialTermMonths' ? (
                      <Input
                        size="sm" className="mt-1" type="number" min="0" max="60" step="1"
                        aria-label="Initial term in months" placeholder="Months (0 = month-to-month)"
                        value={commercialTerms[key]} disabled={!!locked}
                        onChange={(e) => { markEdit(); setCommercialTerms((prev) => ({ ...prev, [key]: e.target.value })); }}
                      />
                    ) : (
                      <Textarea
                        className="mt-1" rows={2} maxLength={maxLength} aria-label={`${label} wording`}
                        value={commercialTerms[key]} disabled={!!locked}
                        onChange={(e) => { markEdit(); setCommercialTerms((prev) => ({ ...prev, [key]: e.target.value })); }}
                      />
                    ))}
                    {/* GATE_COMMERCIAL_PROPOSAL_SIGN on (the status line exists): typed
                        wording that differs from the standard blocks online signing. */}
                    {choice === 'custom' && commercialAgreement && termChoiceOf(key, commercialTerms[key]) === 'custom' && (
                      <p className="mt-1 text-12 text-zinc-500">Custom wording turns off online signing for this proposal.</p>
                    )}
                  </div>
                );
              })}
              <label className="block sm:col-span-2">
                <span className={LABEL}>Property access</span>
                <Input
                  size="sm" className="mt-1" maxLength={200} value={commercialTerms.accessRequirements} disabled={!!locked}
                  placeholder="e.g. Office provides keys for common areas; tenants notified by property manager"
                  onChange={(e) => { markEdit(); setCommercialTerms((prev) => ({ ...prev, accessRequirements: e.target.value })); }}
                />
              </label>
            </div>
          </FoldCard>

          <FoldCard
            title="Additional terms" open={openSections.additionalTerms} onToggle={() => toggleSection('additionalTerms')}
            summary={terms.trim() ? terms.trim().split('\n')[0] : 'None'}
          >
            <Textarea
              rows={4} value={terms} disabled={!!locked} aria-label="Additional terms"
              placeholder="e.g. Net-30 billing to the management company; 12-month term with 30-day written cancellation; written service report delivered after every visit; as-needed interior unit treatments billed per visit at the listed rate."
              onChange={(e) => { setTerms(e.target.value); touch(); }}
            />
          </FoldCard>
        </fieldset>

        {/* Sidebar: totals + actions */}
        <div className="w-full lg:w-80 shrink-0 lg:sticky lg:top-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Totals</CardTitle>
            </CardHeader>
            <CardBody className="space-y-2">
              {[
                ['Monthly equivalent', totals.monthlyEquivalent],
                ['Annual recurring', totals.annualRecurring],
                ['One-time', totals.oneTime],
                ...(totals.totalTax > 0 ? [['Tax (taxable lines)', totals.totalTax]] : []),
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between text-13">
                  <span className="text-zinc-500">{label}</span>
                  <span className="tabular-nums text-zinc-900">{money(value)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between pt-2 border-t border-hairline border-zinc-200 text-14">
                <span className="text-zinc-600">First-year total</span>
                <span className="tabular-nums font-medium text-zinc-900">{money(totals.firstYearTotal)}</span>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-2">
              {!locked && (
                <Button variant="primary" className="w-full" onClick={save} disabled={saving}>
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                  {saving ? 'Saving…' : dirty || !savedOnce ? 'Save proposal' : 'Saved'}
                </Button>
              )}
              <Button variant="secondary" className="w-full" onClick={downloadPdf} disabled={downloading}>
                {downloading ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Download PDF
              </Button>

              {!locked && fixedDeadlinePassed && (
                <p className="text-13 text-zinc-600">The bid validity date has passed. Save a later Valid through date before sending or marking this proposal won.</p>
              )}
              {!locked && !fixedDeadlinePassed && (
                <Button variant="secondary" className="w-full" onClick={sendProposal} disabled={sending || saving}>
                  {sending ? <Loader2 size={15} className="animate-spin" /> : <SendIcon size={15} />} Review and send
                </Button>
              )}

              {/* A draft from the estimator handoff already carries a share
                  token, but /estimate/<token> serves the full proposal — match
                  the estimates list and only offer the customer link once the
                  estimate is actually published (sent/viewed). */}
              {['sent', 'viewed'].includes(estimate?.status) && estimate?.token && (
                <Button variant="ghost" size="sm" className="w-full" onClick={copyLink}>
                  <LinkIcon size={14} /> {linkCopied ? 'Link copied' : 'Copy customer link'}
                </Button>
              )}

              {savedOnce && !estimate?.archivedAt && !fixedDeadlinePassed && canMarkProposalWon(estimate) && (
                <Button variant="secondary" className="w-full" onClick={markWon} disabled={markingWon}>
                  {markingWon ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Mark won
                </Button>
              )}
            </CardBody>
          </Card>

          {(estimate?.sentAt || estimate?.viewedAt || commercialAgreement) && (
            <Card>
              <CardBody className="space-y-1 text-12 text-zinc-500">
                {estimate?.sentAt && <div>Sent {new Date(estimate.sentAt).toLocaleString()}</div>}
                {estimate?.viewedAt && <div>Viewed {new Date(estimate.viewedAt).toLocaleString()}</div>}
                {estimate?.acceptedAt && <div>Won {new Date(estimate.acceptedAt).toLocaleString()}</div>}
                {commercialAgreement && (
                  <div data-testid="proposal-agreement-status">
                    {commercialAgreement.signingBlocked === 'terms_conflict'
                      ? commercialAgreement.note
                      : commercialAgreement.state === 'signed'
                      ? `Agreement signed ${formatETDateTime(commercialAgreement.signedAt, { month: 'short', day: 'numeric', year: 'numeric' })}`
                      : commercialAgreement.state === 'awaiting'
                        ? `Agreement awaiting signature since ${formatETDateTime(commercialAgreement.since, { month: 'short', day: 'numeric', year: 'numeric' })}`
                        : 'Agreement not started'}
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      </div>

      {/* Below lg the sidebar sits under the whole form, so this bar keeps
          the first-year total and Save in reach while scrolling. Sticky
          inside the admin content column (#admin-main), whose bottom padding
          insets the sticky edge (WebKit, Chromium and Firefox alike). The
          offset cancels the padding's breathing room so no page shows under
          the bar (AdminLayoutV2 MAIN_PADDING): on a phone the padding is the
          56px tab bar + safe area + 16px, so -16px seats the bar on the tab
          bar; from md the shell pads 24px with no tab bar, so -24px seats it
          on the window edge. */}
      {isPhone && (
        <div className="sticky -bottom-4 md:-bottom-6 z-30 -mx-4 mt-5 border-t border-hairline border-zinc-200 bg-white px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className={LABEL}>First-year total</div>
              <div className="text-14 tabular-nums text-zinc-900">
                <span className="font-medium">{money(totals.firstYearTotal)}</span>
                <span className="text-12 text-zinc-500"> · {money(totals.monthlyEquivalent)}/mo</span>
              </div>
            </div>
            {!locked && (
              <Button variant="primary" size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                {saving ? 'Saving…' : dirty || !savedOnce ? 'Save' : 'Saved'}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
