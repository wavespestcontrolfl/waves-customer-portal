import useVisiblePageRefresh from "../../hooks/useVisiblePageRefresh";
/**
 * Photo Assessments — admin surface for the lawn-assessment + pest-identifier
 * lead magnets (/admin/lawn-assessments), plus admin-run tree & shrub
 * assessments (no public funnel, no customer report page yet).
 *
 * One list over all three assessment types with per-stage funnel tiles
 * (analyzed → unlocked → viewed → booked), a detail sheet (customer report
 * preview + tech treatment view + photos), manual send-report, lead/customer
 * linking, and admin-created assessments (phone prospects / existing
 * customers — no public funnel involved).
 *
 * Tier 1 V2 surface — components/ui + Tailwind zinc. The funnel gate state
 * (GATE_LAWN_ASSESSMENT / GATE_PEST_IDENTIFIER) is display-only here; Adam
 * flips gates, the page just shows LIVE/DARK.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import {
  Button,
  Badge,
  Card,
  CardBody,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Input,
  Select,
  Textarea,
  Tabs,
  TabList,
  Tab,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";
import PhotoAssessmentDetailSheet from "./PhotoAssessmentDetailSheet";

const TYPE_LABELS = { lawn: "Lawn", pest: "Pest ID", tree_shrub: "Tree & Shrub" };
// Deep-linkable types (?open=<type>:<id>) — a Set, so a prototype key like
// "toString" never counts as a type.
const ASSESSMENT_TYPES = new Set(Object.keys(TYPE_LABELS));

const dateTimeET = (v) =>
  v
    ? new Date(v).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      })
    : "—";

// Funnel stage, deepest rung first. Viewed outranks sent: the public claim
// path stamps last_sent_at when it mints the link, so a claimed-then-viewed
// row must read "Viewed", not stay stuck at "Report sent". "Link released"
// catches Get-link rows (status flips to sent at mint, but last_sent_at /
// claimed_at stay null because nothing was emailed or claimed) — the report
// URL is live, so they must not read as an unreleased teaser.
// Below the timestamp rungs the stage comes from data, not more branches:
// a status with its own stage first, then the type's resting stage — a
// type with no public funnel or report page (tree & shrub) rests at
// "Analyzed", never "Teaser only" — then the funnel teaser.
const STATUS_STAGES = {
  sent: { key: "link_released", label: "Link released" },
  archived: { key: "archived", label: "Archived" },
};
const NO_FUNNEL_STAGES = {
  tree_shrub: { key: "analyzed", label: "Analyzed" },
};
const TEASER_STAGE = { key: "teaser", label: "Teaser only" };

export function stageOf(row) {
  if (row.report_first_viewed_at) return { key: "viewed", label: "Viewed" };
  if (row.last_sent_at) return { key: "sent", label: "Report sent" };
  if (row.claimed_at) return { key: "unlocked", label: "Unlocked" };
  return STATUS_STAGES[row.status] ?? NO_FUNNEL_STAGES[row.type] ?? TEASER_STAGE;
}

const SOURCE_LABELS = { public_funnel: "Public funnel", admin: "Admin", tech: "Tech" };

// Downscale to ≤1600px JPEG before upload — same payload contract as the
// public funnel client (keeps admin uploads under the server's size cap).
async function fileToResizedBase64(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not read image"));
    el.src = dataUrl;
  });
  const MAX = 1600;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpeg = canvas.toDataURL("image/jpeg", 0.85);
  return { data: jpeg.split(",")[1], mimeType: "image/jpeg" };
}

// Lead-magnet funnels only — tree & shrub has no public funnel, so it has
// no tile (the server still reports its admin_created count).
function FunnelTiles({ funnel }) {
  if (!funnel) return null;
  const tiles = ["lawn", "pest"].map((type) => ({ type, ...funnel[type] }));
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
      {tiles.map((t) => {
        const rate = t.analyzed ? Math.round((t.claimed / t.analyzed) * 100) : 0;
        return (
          <Card key={t.type}>
            <CardBody className="py-3">
              <div className="flex items-baseline justify-between">
                <div className="text-[13px] uppercase tracking-label text-zinc-500">
                  {TYPE_LABELS[t.type]} funnel · {funnel.days ? `last ${funnel.days}d` : "all time"}
                </div>
                <div className="text-[13px] text-zinc-500">{rate}% unlock rate</div>
              </div>
              <div className="mt-2 flex items-center gap-4 flex-wrap">
                {[
                  ["Analyzed", t.analyzed],
                  ["Unlocked", t.claimed],
                  ["Viewed", t.viewed],
                  ["Leads", t.leads],
                  ["Booked", t.booked],
                ].map(([label, n]) => (
                  <div key={label}>
                    <div className="text-[20px] leading-6 text-zinc-900 tabular-nums">{n ?? 0}</div>
                    <div className="text-[13px] text-zinc-500">{label}</div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}

function NewAssessmentDialog({ open, onClose, onCreated }) {
  const [type, setType] = useState("lawn");
  const [files, setFiles] = useState([]);
  const [contact, setContact] = useState({ first_name: "", last_name: "", email: "", phone: "" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setType("lawn");
      setFiles([]);
      setContact({ first_name: "", last_name: "", email: "", phone: "" });
      setNote("");
      setError("");
      setBusy(false);
    }
  }, [open]);

  const submit = async () => {
    if (busy) return;
    if (!files.length) { setError("Add at least one photo."); return; }
    setBusy(true);
    setError("");
    try {
      const photos = await Promise.all(files.slice(0, 5).map(fileToResizedBase64));
      const r = await adminFetch(`/admin/photo-assessments/${type}`, {
        method: "POST",
        body: { photos, note: note.trim() || undefined, contact },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Create failed (${r.status})`);
      onCreated(data.id, type);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose}>
      <DialogHeader>
        <DialogTitle>New assessment</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <div>
          <label className="block text-[13px] text-zinc-500 mb-1">Type</label>
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="lawn">Lawn assessment</option>
            <option value="pest">Pest identification</option>
            <option value="tree_shrub">Tree &amp; shrub assessment</option>
          </Select>
        </div>
        <div>
          <label className="block text-[13px] text-zinc-500 mb-1">Photos (1–5)</label>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files || []).slice(0, 5))}
            className="block w-full text-[14px] text-zinc-700 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-[14px] file:text-zinc-900"
          />
          {files.length ? <div className="mt-1 text-[13px] text-zinc-500">{files.length} photo{files.length > 1 ? "s" : ""} selected</div> : null}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="First name" value={contact.first_name} onChange={(e) => setContact((c) => ({ ...c, first_name: e.target.value }))} />
          <Input placeholder="Last name" value={contact.last_name} onChange={(e) => setContact((c) => ({ ...c, last_name: e.target.value }))} />
          <Input placeholder="Email" type="email" value={contact.email} onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))} />
          <Input placeholder="Phone" type="tel" value={contact.phone} onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))} />
        </div>
        <div>
          <label className="block text-[13px] text-zinc-500 mb-1">What are they seeing? (optional)</label>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {error ? <div className="text-[14px] text-alert-fg">{error}</div> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={submit} disabled={busy}>{busy ? "Analyzing…" : "Run analysis"}</Button>
      </DialogFooter>
    </Dialog>
  );
}

// `embedded` — rendered as the "Lead Magnets" tab inside AssessmentsHubPage:
// the hub owns the page header + padding, so skip our own h1/padding and keep
// the functional row (subtitle, gate badges). With `onSecondaryNav` the hub
// header also owns the Add Assessment button (same spot + look as Schedule's
// Add Appointment); standalone keeps the inline button.
export default function PhotoAssessmentsPage({ embedded = false, onSecondaryNav }) {
  const [assessments, setAssessments] = useState([]);
  const [gates, setGates] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [typeTab, setTypeTab] = useState("all");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState(null); // { type, id }
  const [showNew, setShowNew] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep link from the Communications "Analyze photos" flow:
  // ?open=<type>:<id> opens the detail sheet straight to that row (the
  // sheet fetches by type/id itself — no need to wait for the list load).
  // Runs once on mount; the param is stripped right after so a manual
  // sheet-close or a later navigation doesn't reopen it.
  useEffect(() => {
    const openParam = searchParams.get("open");
    if (!openParam) return;
    const [openType, openId] = openParam.split(":");
    if (ASSESSMENT_TYPES.has(openType) && openId) {
      setSelected({ type: openType, id: openId });
    }
    const next = new URLSearchParams(searchParams);
    next.delete("open");
    setSearchParams(next, { replace: true });
    // Deliberately run once on mount only — searchParams/setSearchParams are
    // left out of the deps so a later navigation never reopens the sheet.
  }, []);

  const loadSeq = useRef(0);
  const overlayOpen = useRef(false);
  overlayOpen.current = Boolean(selected || showNew);
  const load = useCallback(async ({ background = false } = {}) => {
    const seq = ++loadSeq.current;
    if (!background) setLoading(true);
    try {
      const params = new URLSearchParams({ type: typeTab, status });
      const [listRes, funnelRes] = await Promise.all([
        adminFetch(`/admin/photo-assessments?${params}`),
        adminFetch("/admin/photo-assessments/funnel?days=30"),
      ]);
      if (!listRes.ok) throw new Error(`List failed (${listRes.status})`);
      const list = await listRes.json();
      const nextFunnel = funnelRes.ok ? await funnelRes.json() : null;
      if (seq !== loadSeq.current || (background && overlayOpen.current)) return;
      setLoadError("");
      setAssessments(list.assessments || []);
      setGates(list.gates || null);
      if (nextFunnel) setFunnel(nextFunnel);
    } catch (err) {
      if (seq === loadSeq.current) setLoadError(err.message);
    } finally {
      // The winning read also finishes any foreground load it superseded.
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [typeTab, status]);

  useEffect(() => { load(); return () => { loadSeq.current += 1; }; }, [load]);
  useVisiblePageRefresh(() => load({ background: true }), {
    intervalMs: 60000, enabled: !loading && !selected && !showNew,
  });

  const hubOwnsHeader = embedded && Boolean(onSecondaryNav);
  useEffect(() => {
    if (!hubOwnsHeader) return undefined;
    onSecondaryNav({
      actions: [
        { key: "new-assessment", label: "Add Assessment", icon: Plus, onClick: () => setShowNew(true) },
      ],
    });
    return () => onSecondaryNav(null);
  }, [hubOwnsHeader, onSecondaryNav]);

  return (
    <div className={embedded ? "max-w-[1200px]" : "p-4 md:p-6 max-w-[1200px]"}>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          {!embedded && (
            <h1 className="text-[22px] leading-7 text-zinc-900">Photo assessments</h1>
          )}
          <p className="text-[14px] text-zinc-500 mt-0.5">
            Lawn-assessment and pest-identifier lead magnets — teaser → unlock → report → booking. Tree &amp; shrub assessments are admin-run.
          </p>
          {gates ? (
            <div className="flex gap-2 mt-2">
              <Badge tone={gates.lawn ? "strong" : "neutral"}>Lawn funnel {gates.lawn ? "LIVE" : "DARK"}</Badge>
              <Badge tone={gates.pest ? "strong" : "neutral"}>Pest funnel {gates.pest ? "LIVE" : "DARK"}</Badge>
            </div>
          ) : null}
        </div>
        {!hubOwnsHeader && (
          <Button onClick={() => setShowNew(true)}>New assessment</Button>
        )}
      </div>

      <FunnelTiles funnel={funnel} />

      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <Tabs value={typeTab} onValueChange={setTypeTab}>
          <TabList>
            <Tab value="all">All</Tab>
            <Tab value="lawn">Lawn</Tab>
            <Tab value="pest">Pest</Tab>
            <Tab value="tree_shrub">Tree &amp; Shrub</Tab>
          </TabList>
        </Tabs>
        <div className="w-40">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="analyzed">Analyzed</option>
            <option value="sent">Sent</option>
            <option value="archived">Archived</option>
          </Select>
        </div>
      </div>

      {loadError ? <div className="text-[14px] text-alert-fg mb-3">{loadError} <Button variant="ghost" onClick={load}>Retry</Button></div> : null}

      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Created</TH>
              <TH>Type</TH>
              <TH>Contact</TH>
              <TH>Result</TH>
              <TH>Stage</TH>
              <TH>Source</TH>
              <TH>Linked</TH>
            </TR>
          </THead>
          <TBody>
            {loading ? (
              <TR><TD colSpan={7} className="text-zinc-500">Loading…</TD></TR>
            ) : assessments.length === 0 ? (
              <TR><TD colSpan={7} className="text-zinc-500">No assessments yet. They appear here as prospects use the funnels — or create one for a phone prospect.</TD></TR>
            ) : assessments.map((row) => {
              const stage = stageOf(row);
              const name = [row.contact?.first_name, row.contact?.last_name].filter(Boolean).join(" ");
              return (
                <TR
                  key={`${row.type}-${row.id}`}
                  className="cursor-pointer hover:bg-zinc-50"
                  onClick={() => setSelected({ type: row.type, id: row.id })}
                >
                  <TD className="whitespace-nowrap tabular-nums">{dateTimeET(row.created_at)}</TD>
                  <TD>{TYPE_LABELS[row.type]}</TD>
                  <TD>{name || <span className="text-zinc-400">No contact yet</span>}</TD>
                  <TD>{row.headline}{row.type === "pest" && row.urgency ? <span className="text-zinc-500"> · {row.urgency}</span> : null}</TD>
                  <TD><Badge tone={stage.key === "sent" ? "strong" : "neutral"}>{stage.label}</Badge></TD>
                  <TD className="text-zinc-500">{SOURCE_LABELS[row.source] || row.source}</TD>
                  <TD className="text-zinc-500">
                    {[row.lead_id ? "Lead" : null, row.customer_id ? "Customer" : null].filter(Boolean).join(" + ") || "—"}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      <PhotoAssessmentDetailSheet
        open={!!selected}
        type={selected?.type}
        id={selected?.id}
        onClose={() => setSelected(null)}
        onChanged={load}
      />

      <NewAssessmentDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={(id, type) => {
          setShowNew(false);
          setSelected({ type, id });
          load();
        }}
      />
    </div>
  );
}
