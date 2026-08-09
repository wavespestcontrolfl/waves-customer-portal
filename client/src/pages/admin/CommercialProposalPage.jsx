import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Input, Select, Switch, Textarea, Badge, Card, CardHeader, CardTitle, CardBody } from '../../components/ui';
import {
  ArrowLeft, Plus, Trash2, Download, Building2, Loader2,
  Send as SendIcon, Link as LinkIcon, CheckCircle2, Copy,
  ClipboardList, ChevronDown, ChevronUp, Wand2,
} from 'lucide-react';

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

const emptyLine = () => ({
  description: '', quantity: 1, unitPrice: 0, frequency: 'monthly', taxable: false,
});
const emptyBuilding = (i) => ({ name: `Building ${i + 1}`, note: '', lineItems: [emptyLine()] });

const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;

const lineAmount = (li) => (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0);
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

// A builder program row counts (totals, payload) once it is actually
// priced — same predicate everywhere so the sidebar shows what will save.
const programRowIsPriced = (p) => String(p.label || '').trim()
  && Number(p.frequencyPerYear) >= 1 && Number(p.pricePerApplication) > 0;

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
  // derived exactly like normalizeProgram.
  for (const p of programs.filter(programRowIsPriced)) {
    const annual = roundMoney(roundMoney(p.pricePerApplication) * Math.round(Number(p.frequencyPerYear)));
    annualRecurring += annual;
    if (p.taxable) taxableAnnual += annual;
  }
  // Per-bucket cent rounding, mirroring computeProposalTotals — a merged
  // bucket can drift a cent from the saved proposal/PDF (codex 1A-i r3).
  const rate = Number(taxRate) || 0;
  const totalTax = roundMoney(roundMoney(taxableAnnual * rate) + roundMoney(taxableOneTime * rate));
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
  if (['accepted', 'declined', 'expired'].includes(est.status)) {
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

function summarizeSend(data) {
  const parts = [];
  if (data?.channels?.sms) {
    parts.push(data.channels.sms.ok ? 'Text sent' : `Text failed: ${data.channels.sms.error || 'unknown error'}`);
  }
  if (data?.channels?.email) {
    parts.push(data.channels.email.ok ? 'Email sent' : `Email failed: ${data.channels.email.error || 'unknown error'}`);
  }
  if (parts.length === 0) return data?.error || 'Estimate send failed';
  return parts.join(' / ');
}

const LABEL = 'text-11 uppercase tracking-label text-zinc-500';

export default function CommercialProposalPage() {
  const { estimateId } = useParams();
  const navigate = useNavigate();

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
  const [taxRatePct, setTaxRatePct] = useState('0');
  const [terms, setTerms] = useState('');
  const [buildings, setBuildings] = useState([emptyBuilding(0)]);
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
  const [sendMethod, setSendMethod] = useState('email');
  // Engine-composed prospect research (commercial proposal lane). Read-only
  // context for pricing the walkthrough — never sent to the customer.
  const [prospectBrief, setProspectBrief] = useState(null);
  const [briefOpen, setBriefOpen] = useState(true);

  const locked = lockReason(estimate);

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

  const applyLoaded = useCallback((data) => {
    const p = data.proposal || {};
    const est = data.estimate || null;
    setEstimate(est);
    setTitle(p.title || 'Commercial Service Proposal');
    setPreparedFor(p.preparedFor || est?.customerName || '');
    setPropertyAddress(p.propertyAddress || est?.address || '');
    setTaxRatePct(String((Number(p.taxRate) || 0) * 100));
    setTerms(p.terms || '');
    setBuildings(
      Array.isArray(p.buildings) && p.buildings.length
        ? p.buildings.map((b) => ({
            name: b.name || '',
            note: b.note || '',
            lineItems: (b.lineItems || []).map((li) => ({
              description: li.description || '',
              quantity: li.quantity ?? 1,
              unitPrice: li.unitPrice ?? 0,
              frequency: li.frequency || 'monthly',
              taxable: li.taxable === true,
            })),
          }))
        : [emptyBuilding(0)],
    );
    setScopeItems((p.propertyScope?.items || []).map((item) => ({
      label: item.label || '', value: item.value || '',
    })));
    setProgramsState((p.programs || []).map((program) => ({
      service: program.service || 'other',
      label: program.label || '',
      frequencyPerYear: program.frequencyPerYear ?? 4,
      pricePerApplication: program.pricePerApplication ?? 0,
      taxable: program.taxable === true,
      note: program.note || '',
      inclusionsText: (program.inclusions || []).join('\n'),
      exclusionsText: (program.exclusions || []).join('\n'),
      coversText: (program.buildings || []).map((b) => b.name).join(', '),
    })));
    setCorrectiveWork((p.correctiveWork || []).map((w) => ({
      label: w.label || '',
      amount: w.amount ?? 0,
      taxable: w.taxable === true,
      includesText: (w.includes || []).join('\n'),
    })));
    setResponsibilitiesText((p.customerResponsibilities || []).join('\n'));
    setCommercialTerms({
      paymentTerms: p.commercialTerms?.paymentTerms || '',
      initialTermMonths: p.commercialTerms?.initialTermMonths != null ? String(p.commercialTerms.initialTermMonths) : '',
      renewal: p.commercialTerms?.renewal || '',
      priceAdjustment: p.commercialTerms?.priceAdjustment || '',
      cancellation: p.commercialTerms?.cancellation || '',
      accessRequirements: p.commercialTerms?.accessRequirements || '',
    });
    setProspectBrief(data.prospectBrief || null);
    // An already-authored proposal means download/send are meaningful now.
    setSavedOnce(p.enabled === true);
    setLoadedAuthored(p.enabled === true && p.synthesized !== true);
    buildingsEditedRef.current = false;
    persistedBuildingsRef.current = p.enabled === true && p.synthesized !== true
      && (p.buildings || []).some((b) => (b.lineItems || []).length > 0);
    setDirty(false);
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
  // Sidebar mirrors what SAVES: in programs mode the payload omits the
  // buildings entirely, so their (hidden) line items must not count.
  const totals = useMemo(
    () => computeTotals(programsMode ? [] : buildings, taxRate, correctiveWork, programsState),
    [programsMode, buildings, taxRate, correctiveWork, programsState],
  );

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
      if (draft?.propertyScope?.items?.length && !live.scopeItems.some((i) => i.label.trim())) {
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
      if (draft?.programs?.length && !live.programsState.some((p) => p.label.trim()) && !hasAuthoredBuildingLines) {
        setProgramsState(draft.programs.map((program) => ({
          service: program.service,
          label: program.label,
          frequencyPerYear: program.frequencyPerYear,
          pricePerApplication: program.pricePerApplication,
          taxable: program.taxable === true,
          note: '',
          inclusionsText: (program.inclusions || []).join('\n'),
          exclusionsText: (program.exclusions || []).join('\n'),
          coversText: '',
        })));
        filled += 1;
        monetaryFilled += 1;
        programsInstalled = true;
      }
      if (draft?.correctiveWork?.length && !live.correctiveWork.some((w) => String(w.label || '').trim())
        && !hasAuthoredBuildingLines) {
        setCorrectiveWork(draft.correctiveWork.map((w) => ({
          label: w.label,
          amount: w.amount,
          taxable: w.taxable === true,
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
        filled += 1;
      }
      if (filled > 0) {
        // Taxable generated items need a rate beside them — fill the canonical
        // FL commercial default only when the current rate is zero/unset
        // (codex 1A-ii r3); the operator reviews it like everything else.
        if (monetaryFilled > 0 && draft?.suggestedTaxRate && !(Number(live.taxRate) > 0)) {
          setTaxRatePct(String(draft.suggestedTaxRate * 100));
        }
        // Monetary sections were installed — the on-screen SYNTHESIZED
        // building lines describe the same charges and would double-count
        // on save (codex 1A-ii r2g). Authored/edited/persisted lines never
        // reach here (the guards above), so clearing is safe.
        if (monetaryFilled > 0
          && !(live.loadedAuthored || buildingsEditedRef.current || persistedBuildingsRef.current)) {
          setBuildings([emptyBuilding(0)]);
        }
        markEdit();
        // Partial generation still surfaces the programs warning.
        if (draft?.warnings?.length) setError(draft.warnings.join(' '));
      } else if (draft?.warnings?.length) setError(draft.warnings.join(' '));
      else if (draft?.programs?.length && hasAuthoredBuildingLines) {
        setError('Programs were not generated: this proposal already has building line items. Clear them first to switch to generated programs.');
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

  const addLine = (bi) => mutateBuilding(bi, (b) => ({ ...b, lineItems: [...b.lineItems, emptyLine()] }));
  const removeLine = (bi, li) =>
    mutateBuilding(bi, (b) => ({ ...b, lineItems: b.lineItems.filter((_, i) => i !== li) }));
  const addBuilding = () => { markBuildingsEdit(); setBuildings((prev) => [...prev, emptyBuilding(prev.length)]); };
  const duplicateBuilding = (bi) => {
    markBuildingsEdit();
    setBuildings((prev) => {
      const src = prev[bi];
      const copy = {
        name: `${src.name || 'Building'} (copy)`,
        note: src.note,
        lineItems: src.lineItems.map((l) => ({ ...l })),
      };
      return [...prev.slice(0, bi + 1), copy, ...prev.slice(bi + 1)];
    });
  };
  const removeBuilding = (bi) => { markBuildingsEdit(); setBuildings((prev) => prev.filter((_, i) => i !== bi)); };

  // Render-assigned mirror of the current form state: save()'s retry loop
  // runs inside ONE async closure, whose captured state variables freeze at
  // the render that started it — a retry building from those would re-save
  // the stale payload and then overwrite the newer edits on reload (codex
  // #3297 r5b P0). The ref is reassigned every render, so each retry builds
  // from what is actually on screen.
  const formRef = React.useRef(null);
  formRef.current = {
    title, preparedFor, propertyAddress, taxRate, terms,
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
        service: p.service,
        label: p.label.trim(),
        // UNROUNDED — a fractional entry (4.5) must reach the server's
        // whole-number validation and 400, never silently round to a
        // different promised cadence (codex 1A-ii r1).
        frequencyPerYear: Number(p.frequencyPerYear),
        pricePerApplication: Number(p.pricePerApplication) || 0,
        taxable: p.taxable === true,
        note: p.note.trim() || null,
        inclusions: p.inclusionsText.split('\n').map((s) => s.trim()).filter(Boolean),
        exclusions: p.exclusionsText.split('\n').map((s) => s.trim()).filter(Boolean),
        buildings: p.coversText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((name) => ({ name })),
      }));
    const work = f.correctiveWork
      .map((w) => ({
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
      ...(hasTerms ? { commercialTerms: ct } : {}),
    };
  };

  const buildPayload = (f = formRef.current) => ({
    proposal: {
      title: f.title.trim() || 'Commercial Service Proposal',
      preparedFor: f.preparedFor.trim(),
      propertyAddress: f.propertyAddress.trim(),
      taxRate: f.taxRate,
      terms: f.terms.trim() || null,
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
            description: l.description.trim(),
            quantity: Math.max(1, Math.round(Number(l.quantity) || 1)),
            unitPrice: Number(l.unitPrice) || 0,
            frequency: l.frequency,
            taxable: l.taxable === true,
          })),
      })).filter((b) => b.lineItems.length > 0),
    },
  });

  // Returns true ONLY when the persisted proposal equals the on-screen
  // state — download/send/Mark-won gate on this, and a true returned while
  // newer keystrokes sit unsaved would let them act on a stale snapshot
  // (codex #3297 r5 P0). Mid-save edits re-save in a bounded loop.
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
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
        // A program row with a name but no valid price/frequency would be
        // FILTERED from the payload and silently deleted by the reload —
        // surface the server's minimum-price rule instead (codex 1A-ii r3).
        const incompleteProgram = formRef.current.programsState.find(
          (row) => (String(row.label || '').trim() || Number(row.pricePerApplication) > 0
            || String(row.inclusionsText || '').trim() || String(row.exclusionsText || '').trim())
            && !programRowIsPriced(row),
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
        await adminFetch(`/admin/estimates/${estimateId}/proposal`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
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
    // Open the tab synchronously, tied to the click — Safari/iOS and popup
    // blockers block a window.open issued after the async save/fetch below.
    const win = window.open('', '_blank');
    if (win) {
      win.opener = null;
      try { win.document.write('Generating proposal PDF…'); } catch { /* about:blank write can throw in some browsers */ }
    }
    setDownloading(true);
    try {
      // The PDF renders server-side from persisted estimate_data, so save the
      // on-screen edits first (skipped when locked — the stored proposal IS
      // what's on screen then).
      if (!locked) {
        const saved = await save();
        if (!saved) { if (win) win.close(); return; }
      }
      // The shared adminFetch always parses the body as JSON, which corrupts
      // PDF bytes — raw fetch (same auth header) and read as a blob.
      const r = await fetch(`${API_BASE}/admin/estimates/${estimateId}/proposal.pdf`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
      });
      if (!r.ok) throw new Error(`Could not generate PDF (${r.status})`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      if (win) win.location = url;
      else window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      if (win) win.close();
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  };

  const sendProposal = async () => {
    setError(null);
    const wantsEmail = sendMethod === 'email' || sendMethod === 'both';
    const wantsSms = sendMethod === 'sms' || sendMethod === 'both';
    if (wantsEmail && !estimate?.customerEmail) {
      setError('No customer email on this estimate — edit the estimate contact first or send by text.');
      return;
    }
    if (wantsSms && !estimate?.customerPhone) {
      setError('No customer phone on this estimate — send by email instead.');
      return;
    }
    const methodLabel = sendMethod === 'both' ? 'text + email' : sendMethod === 'sms' ? 'text' : 'email';
    if (!window.confirm(
      `Send this proposal to ${estimate?.customerName || 'the customer'} by ${methodLabel}?\n\nThe email includes the branded proposal PDF as an attachment.`,
    )) return;
    setSending(true);
    try {
      // Persist any on-screen edits so the emailed PDF matches the page.
      if (dirty || !savedOnce) {
        const saved = await save();
        if (!saved) return;
      }
      const data = await adminFetch(`/admin/estimates/${estimateId}/send`, {
        method: 'POST',
        body: JSON.stringify({
          sendMethod,
          idempotencyKey:
            globalThis.crypto?.randomUUID?.() ||
            `proposal-send-${estimateId}-${Math.random()}`,
        }),
      });
      const summary = summarizeSend(data);
      if (data.partialFailure) window.alert(`Send had issues: ${summary}`);
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  // Mirrors the estimates-list Mark won flow: proposals are won manually (no
  // online checkout); the server creates the customer when none is linked and,
  // in invoice mode, builds the first invoice from the proposal lines.
  const markWon = async () => {
    setError(null);
    const invoiceMode = !!estimate?.billByInvoice;
    const confirmMsg = invoiceMode
      ? `Mark ${estimate?.customerName || 'this proposal'} as won?\n\nThis stamps the proposal as won, creates the customer if none is linked, and creates the first invoice from the proposal line items (one-time items plus the first period of each recurring service). The customer is NOT texted and NOT auto-scheduled — ongoing recurring visits are billed as completed.`
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
      if (result?.proposalInvoice?.invoiceNumber) {
        notes.push(`Invoice ${result.proposalInvoice.invoiceNumber} for $${Number(result.proposalInvoice.total || 0).toFixed(2)} was created.`);
      }
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
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <Button variant="ghost" size="sm" onClick={() => navigate('/admin/estimates')}>
          <ArrowLeft size={15} /> Estimates
        </Button>
        <div className="min-w-0">
          <h1 className="text-18 text-zinc-900 truncate">
            Commercial proposal — {estimate?.customerName || 'Estimate'}
          </h1>
          {estimate?.address && (
            <div className="text-13 text-zinc-500 truncate">{estimate.address}</div>
          )}
        </div>
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
        {/* Main column */}
        <div className="flex-1 min-w-0 w-full space-y-5">
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
                <label className="block">
                  <span className={LABEL}>Tax rate (%) — taxable lines only</span>
                  <Input type="number" min="0" step="0.01" value={taxRatePct} disabled={!!locked} className="mt-1"
                    onChange={(e) => { setTaxRatePct(e.target.value); touch(); }} />
                </label>
              </div>
            </CardBody>
          </Card>

          {prospectBrief && (
            <Card>
              <CardHeader>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left"
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

          {!locked && (
            <Button variant="secondary" size="sm" onClick={generateFromEstimate} disabled={generating}>
              {generating ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}
              Generate from estimate
            </Button>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Property scope</CardTitle>
            </CardHeader>
            <CardBody className="space-y-2">
              <div className="text-12 text-zinc-500">
                Optional — facts the proposal was scoped against (buildings, units, turf sq ft,
                device counts). Shown on the proposal when filled in.
              </div>
              {scopeItems.map((item, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <Input
                    size="sm" className="w-48 shrink-0" placeholder="Label (e.g. Units)" maxLength={80}
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
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Service programs</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="text-12 text-zinc-500">
                Per-service programs with per-application pricing — when any program is priced, programs
                replace the building line items as the recurring itemization (use &ldquo;Covers&rdquo; for
                building labels). Annual totals derive from price × frequency.
              </div>
              {programsState.map((p, idx) => (
                <div key={idx} className="space-y-2 border-b border-hairline border-zinc-100 pb-3 last:border-0 last:pb-0">
                  <div className="flex flex-wrap gap-2 items-center">
                    <Select
                      size="sm" className="w-32 shrink-0" value={p.service} disabled={!!locked} title="Service family"
                      onChange={(e) => { markEdit(); setProgramsState((prev) => prev.map((it, i) => (i === idx ? { ...it, service: e.target.value } : it))); }}
                    >
                      {PROGRAM_FAMILY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </Select>
                    <Input
                      size="sm" className="flex-1 min-w-[180px]" placeholder="Program name (e.g. Quarterly pest program)" maxLength={120}
                      value={p.label} disabled={!!locked}
                      onChange={(e) => { markEdit(); setProgramsState((prev) => prev.map((it, i) => (i === idx ? { ...it, label: e.target.value } : it))); }}
                    />
                    <Input
                      size="sm" className="w-20 shrink-0" type="number" min="1" max="52" step="1" title="Visits per year"
                      value={p.frequencyPerYear} disabled={!!locked}
                      onChange={(e) => { markEdit(); setProgramsState((prev) => prev.map((it, i) => (i === idx ? { ...it, frequencyPerYear: e.target.value } : it))); }}
                    />
                    <Input
                      size="sm" className="w-28 shrink-0" type="number" min="0" step="0.01" title="Price per application"
                      value={p.pricePerApplication} disabled={!!locked}
                      onChange={(e) => { markEdit(); setProgramsState((prev) => prev.map((it, i) => (i === idx ? { ...it, pricePerApplication: e.target.value } : it))); }}
                    />
                    <div className="flex items-center gap-1 shrink-0" title="Taxable program">
                      <Switch checked={p.taxable} disabled={!!locked}
                        onChange={(v) => { markEdit(); setProgramsState((prev) => prev.map((it, i) => (i === idx ? { ...it, taxable: v } : it))); }} />
                      <span className="text-12 text-zinc-500">Tax</span>
                    </div>
                    <span className="text-12 text-zinc-500 tabular-nums shrink-0">
                      {money(roundMoney((Number(p.pricePerApplication) || 0) * (Math.round(Number(p.frequencyPerYear)) || 0)))}/yr
                    </span>
                    {!locked && (
                      <Button variant="ghost" size="sm" title="Remove program"
                        onClick={() => { markEdit(); setProgramsState((prev) => prev.filter((_, i) => i !== idx)); }}>
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Textarea
                      rows={3} value={p.inclusionsText} disabled={!!locked}
                      placeholder={'What this program includes — one per line'}
                      onChange={(e) => { markEdit(); setProgramsState((prev) => prev.map((it, i) => (i === idx ? { ...it, inclusionsText: e.target.value } : it))); }}
                    />
                    <Textarea
                      rows={3} value={p.exclusionsText} disabled={!!locked}
                      placeholder={'Not included / quoted separately — one per line'}
                      onChange={(e) => { markEdit(); setProgramsState((prev) => prev.map((it, i) => (i === idx ? { ...it, exclusionsText: e.target.value } : it))); }}
                    />
                  </div>
                  <Input
                    size="sm" placeholder="Covers (optional) — building or area names, comma-separated (e.g. Tower A, Clubhouse)" maxLength={400}
                    value={p.coversText} disabled={!!locked}
                    onChange={(e) => { markEdit(); setProgramsState((prev) => prev.map((it, i) => (i === idx ? { ...it, coversText: e.target.value } : it))); }}
                  />
                </div>
              ))}
              {!locked && (
                <Button variant="ghost" size="sm"
                  onClick={() => { markEdit(); setProgramsState((prev) => [...prev, { service: 'pest', label: '', frequencyPerYear: 4, pricePerApplication: 0, taxable: false, note: '', inclusionsText: '', exclusionsText: '', coversText: '' }]); }}>
                  <Plus size={14} /> Add program
                </Button>
              )}
            </CardBody>
          </Card>

          {programsMode && (
            <div className="flex flex-wrap items-center gap-3 text-13 text-zinc-600 bg-zinc-50 border border-hairline border-zinc-200 rounded px-3 py-2">
              <span className="flex-1 min-w-[240px]">
                Service programs are the recurring itemization — the building line-item editor is hidden and
                building lines are not saved alongside programs. Use each program&rsquo;s &ldquo;Covers&rdquo; field for building labels.
              </span>
              {!locked && buildings.some((b) => (b.lineItems || []).some((l) => String(l.description || '').trim())) && (
                <Button variant="secondary" size="sm"
                  onClick={() => { markBuildingsEdit(); setBuildings([emptyBuilding(0)]); }}>
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
                  <div className="hidden md:grid grid-cols-12 gap-2 px-0.5">
                    <span className={`col-span-4 ${LABEL}`}>Service description</span>
                    <span className={`col-span-1 ${LABEL}`}>Qty</span>
                    <span className={`col-span-2 ${LABEL}`}>Unit price</span>
                    <span className={`col-span-2 ${LABEL}`}>Frequency</span>
                    <span className={`col-span-1 ${LABEL} text-center`}>Tax</span>
                    <span className={`col-span-1 ${LABEL} text-right`}>Amount</span>
                    <span className="col-span-1" />
                  </div>

                  {b.lineItems.map((li, lii) => (
                    <div key={lii} className="grid grid-cols-2 md:grid-cols-12 gap-2 items-center border-b border-hairline border-zinc-100 md:border-0 pb-2 md:pb-0">
                      <Input
                        className="col-span-2 md:col-span-4" size="sm" placeholder="Service description"
                        value={li.description} disabled={!!locked}
                        onChange={(e) => updateLine(bi, lii, { description: e.target.value })}
                      />
                      <Input
                        className="col-span-1 md:col-span-1" size="sm" type="number" min="1" title="Quantity"
                        value={li.quantity} disabled={!!locked}
                        onChange={(e) => updateLine(bi, lii, { quantity: e.target.value })}
                      />
                      <Input
                        className="col-span-1 md:col-span-2" size="sm" type="number" min="0" step="0.01" title="Unit price"
                        value={li.unitPrice} disabled={!!locked}
                        onChange={(e) => updateLine(bi, lii, { unitPrice: e.target.value })}
                      />
                      <Select
                        className="col-span-1 md:col-span-2" size="sm" value={li.frequency} disabled={!!locked}
                        onChange={(e) => updateLine(bi, lii, { frequency: e.target.value })}
                      >
                        {FREQUENCY_OPTIONS.map((f) => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </Select>
                      <div className="col-span-1 md:col-span-1 flex md:justify-center items-center gap-1" title="Taxable line">
                        <Switch checked={li.taxable} disabled={!!locked}
                          onChange={(v) => updateLine(bi, lii, { taxable: v })} />
                        <span className="md:hidden text-12 text-zinc-500">Taxable</span>
                      </div>
                      <div
                        className="col-span-1 md:col-span-1 text-right text-13 tabular-nums text-zinc-700"
                        title={li.frequency === 'one_time' ? 'One-time amount' : `${money(lineAnnual(li))} per year`}
                      >
                        {money(lineAmount(li))}
                        {li.frequency !== 'one_time' && (
                          <span className="text-11 text-zinc-400">/{FREQUENCY_OPTIONS.find((f) => f.value === li.frequency)?.perYear === 12 ? 'mo' : 'visit'}</span>
                        )}
                      </div>
                      <div className="col-span-1 md:col-span-1 flex justify-end">
                        {!locked && b.lineItems.length > 1 && (
                          <Button variant="ghost" size="sm" onClick={() => removeLine(bi, lii)} title="Remove line">
                            <Trash2 size={14} />
                          </Button>
                        )}
                      </div>
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

          <Card>
            <CardHeader>
              <CardTitle>Corrective work (one-time)</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="text-12 text-zinc-500">
                Optional — one-time remediation separated from the recurring programs.
                Amounts count toward the one-time and first-year totals.
              </div>
              {correctiveWork.map((w, idx) => (
                <div key={idx} className="space-y-2 border-b border-hairline border-zinc-100 pb-3 last:border-0 last:pb-0">
                  <div className="flex gap-2 items-center">
                    <Input
                      size="sm" className="flex-1" placeholder="Work description (e.g. Initial German roach cleanout — Units 2 & 4)" maxLength={160}
                      value={w.label} disabled={!!locked}
                      onChange={(e) => { markEdit(); setCorrectiveWork((prev) => prev.map((it, i) => (i === idx ? { ...it, label: e.target.value } : it))); }}
                    />
                    <Input
                      size="sm" className="w-28 shrink-0" type="number" min="0" step="0.01" title="Amount"
                      value={w.amount} disabled={!!locked}
                      onChange={(e) => { markEdit(); setCorrectiveWork((prev) => prev.map((it, i) => (i === idx ? { ...it, amount: e.target.value } : it))); }}
                    />
                    <div className="flex items-center gap-1 shrink-0" title="Taxable line">
                      <Switch checked={w.taxable} disabled={!!locked}
                        onChange={(v) => { markEdit(); setCorrectiveWork((prev) => prev.map((it, i) => (i === idx ? { ...it, taxable: v } : it))); }} />
                      <span className="text-12 text-zinc-500">Tax</span>
                    </div>
                    {!locked && (
                      <Button variant="ghost" size="sm" title="Remove work item"
                        onClick={() => { markEdit(); setCorrectiveWork((prev) => prev.filter((_, i) => i !== idx)); }}>
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                  <Textarea
                    rows={2} value={w.includesText} disabled={!!locked}
                    placeholder={'What it includes — one per line\ne.g. Crack & crevice treatment in both kitchens\nFollow-up inspection at 2 weeks'}
                    onChange={(e) => { markEdit(); setCorrectiveWork((prev) => prev.map((it, i) => (i === idx ? { ...it, includesText: e.target.value } : it))); }}
                  />
                </div>
              ))}
              {!locked && (
                <Button variant="ghost" size="sm"
                  onClick={() => { markEdit(); setCorrectiveWork((prev) => [...prev, { label: '', amount: 0, taxable: false, includesText: '' }]); }}>
                  <Plus size={14} /> Add corrective work
                </Button>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Customer responsibilities</CardTitle>
            </CardHeader>
            <CardBody>
              <Textarea
                rows={3} value={responsibilitiesText} disabled={!!locked}
                placeholder={'Optional — one per line\ne.g. Provide unit access with 24-hour tenant notice\nReport pest activity through the Waves app or office line'}
                onChange={(e) => { setResponsibilitiesText(e.target.value); touch(); }}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Commercial terms</CardTitle>
            </CardHeader>
            <CardBody>
              <div className="text-12 text-zinc-500 mb-2">
                Optional — structured terms shown as their own section on the proposal.
                Free-text terms below become &ldquo;Additional terms&rdquo; once any of these are set.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className={LABEL}>Payment terms</span>
                  {/* Canonical payer vocabulary only (server rejects free
                      text) — billing derives due dates from these tokens,
                      which only exists for invoice-mode proposals. */}
                  {/* Stays ENABLED when a stored term exists on a
                      non-invoice proposal so the operator can CLEAR the
                      stale term (the PUT rejects setting a new one). */}
                  <Select
                    size="sm" className="mt-1" value={commercialTerms.paymentTerms}
                    disabled={!!locked || (!estimate?.billByInvoice && !commercialTerms.paymentTerms)}
                    onChange={(e) => { markEdit(); setCommercialTerms((prev) => ({ ...prev, paymentTerms: e.target.value })); }}
                  >
                    <option value="">Not set</option>
                    <option value="due_on_receipt">Due on receipt</option>
                    <option value="net15">Net-15</option>
                    <option value="net30">Net-30</option>
                  </Select>
                  {!estimate?.billByInvoice && (
                    <span className="mt-1 block text-11 text-zinc-400">
                      Requires Bill by invoice — for manually billed agreements, put payment language in Additional terms.
                    </span>
                  )}
                </label>
                {/* maxLength mirrors normalizeCommercialTerms' clamps so a
                    contractual sentence can never silently truncate on save
                    (codex #3297 r2). */}
                {[
                  ['initialTermMonths', 'Initial term (months, 0 = month-to-month)', 'number', 'e.g. 12', undefined],
                  ['renewal', 'Renewal', 'text', 'e.g. Renews month-to-month after the initial term', 120],
                  ['priceAdjustment', 'Price adjustment', 'text', 'e.g. Rates reviewed annually with 30-day notice', 160],
                  ['cancellation', 'Cancellation', 'text', 'e.g. 30-day written notice, no cancellation fee', 160],
                ].map(([key, label, type, placeholder, maxLength]) => (
                  <label key={key} className="block">
                    <span className={LABEL}>{label}</span>
                    <Input
                      size="sm" className="mt-1" type={type}
                      min={type === 'number' ? '0' : undefined} step={type === 'number' ? '1' : undefined}
                      max={key === 'initialTermMonths' ? '60' : undefined}
                      maxLength={maxLength}
                      value={commercialTerms[key]} disabled={!!locked} placeholder={placeholder}
                      onChange={(e) => { markEdit(); setCommercialTerms((prev) => ({ ...prev, [key]: e.target.value })); }}
                    />
                  </label>
                ))}
                <label className="block sm:col-span-2">
                  <span className={LABEL}>Property access</span>
                  <Input
                    size="sm" className="mt-1" maxLength={200} value={commercialTerms.accessRequirements} disabled={!!locked}
                    placeholder="e.g. Office provides keys for common areas; tenants notified by property manager"
                    onChange={(e) => { markEdit(); setCommercialTerms((prev) => ({ ...prev, accessRequirements: e.target.value })); }}
                  />
                </label>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Additional terms</CardTitle>
            </CardHeader>
            <CardBody>
              <Textarea
                rows={4} value={terms} disabled={!!locked}
                placeholder="e.g. Net-30 billing to the management company; 12-month term with 30-day written cancellation; written service report delivered after every visit; as-needed interior unit treatments billed per visit at the listed rate."
                onChange={(e) => { setTerms(e.target.value); touch(); }}
              />
            </CardBody>
          </Card>
        </div>

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

              {!locked && (
                <div className="flex gap-2 pt-1">
                  <Select size="sm" value={sendMethod} onChange={(e) => setSendMethod(e.target.value)} className="flex-1">
                    <option value="email">Email (PDF attached)</option>
                    <option value="sms">Text (link)</option>
                    <option value="both">Text + email</option>
                  </Select>
                  <Button variant="secondary" onClick={sendProposal} disabled={sending}>
                    {sending ? <Loader2 size={15} className="animate-spin" /> : <SendIcon size={15} />} Send
                  </Button>
                </div>
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

              {savedOnce && !estimate?.archivedAt && canMarkProposalWon(estimate) && (
                <Button variant="secondary" className="w-full" onClick={markWon} disabled={markingWon}>
                  {markingWon ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Mark won
                </Button>
              )}
            </CardBody>
          </Card>

          {(estimate?.sentAt || estimate?.viewedAt) && (
            <Card>
              <CardBody className="space-y-1 text-12 text-zinc-500">
                {estimate.sentAt && <div>Sent {new Date(estimate.sentAt).toLocaleString()}</div>}
                {estimate.viewedAt && <div>Viewed {new Date(estimate.viewedAt).toLocaleString()}</div>}
                {estimate.acceptedAt && <div>Won {new Date(estimate.acceptedAt).toLocaleString()}</div>}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
