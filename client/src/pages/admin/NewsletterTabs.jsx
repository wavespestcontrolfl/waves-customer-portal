// client/src/pages/admin/NewsletterTabs.jsx
//
// In-house newsletter composer (replaces Beehiiv). Exposes the three
// content views (Compose / History / Subscribers) as named exports so
// NewsletterPage.jsx can host them as tabs alongside its Dashboard
// tab. The Automations tab is wired separately via
// EmailAutomationsPanelV2 — imported directly by NewsletterPage.

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Download,
  Eye,
  MailCheck,
  Save,
  Search,
  Send,
  Sparkles,
  UserPlus,
  Wand2,
  XCircle,
} from "lucide-react";
import { Badge, Button, Card, cn } from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const INPUT_CLS =
  "w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900";
const TEXTAREA_CLS = `${INPUT_CLS} font-mono leading-relaxed`;
const PANEL_CLS = "bg-white border-hairline border-zinc-200 rounded-sm";
const SOURCE_SEGMENTS = [
  { value: "footer", label: "Footer" },
  { value: "newsletter_landing", label: "Landing" },
  { value: "newsletter_archive", label: "Archive" },
  { value: "portal_learn", label: "Portal Learn" },
  { value: "quote_wizard", label: "Quote Wizard" },
  { value: "quote_wizard_deferred", label: "Quote Deferred" },
  { value: "public_form", label: "Public Form" },
  { value: "admin_manual", label: "Manual" },
  { value: "beehiiv_import", label: "Admin Import" },
  { value: "beehiiv_migration", label: "Beehiiv Migration" },
  { value: "beehiiv_migration_orphan", label: "Beehiiv Orphans" },
  { value: "website", label: "Website Legacy" },
];

function FieldLabel({ children }) {
  return (
    <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
      {children}
    </label>
  );
}

function PanelHeader({ title, hint, action }) {
  return (
    <div className="flex items-start justify-between gap-3 p-4 border-b border-hairline border-zinc-200">
      {" "}
      <div className="min-w-0">
        {" "}
        <h3 className="text-14 font-medium text-zinc-900">{title}</h3>
        {hint && <p className="text-12 text-ink-tertiary mt-0.5">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    return data;
  });
}

// Starter HTML templates. Operator picks one → seeds the HTML body textarea.
// "Fresh This Week" (née Weekend Lineup) is the flagship — ~60% of
// historical sends and highest-engagement format. Blank is the escape
// hatch for rare one-off free-form sends. Headlines are deliberately
// placeholder-y so the operator (or AI Draft) can rewrite them per send —
// the value here is the structure + voice cues, not literal headlines.
// Deliberately minimal markup — SendGrid footer is appended automatically.
// Drafts persist the {{greeting-name}} substitution token (resolved per
// recipient at send time by SendGrid). Previews have no recipient — strip
// it so the operator never sees the literal token.
const stripGreetingToken = (s) => String(s || "").split("{{greeting-name}}").join("");

const TEMPLATES = [
  {
    key: "blank",
    label: "Blank",
    newsletterType: "free-form",
    html: "",
  },
  {
    key: "weekend",
    label: "Fresh This Week",
    newsletterType: "local-weekly-fresh-events",
    html: `<h1>[Punchy weekend headline — e.g., "Your No-Lame-Plans Weekend Starts Here"]</h1>
<p>What's good, neighbor — here's what's hitting around Southwest Florida this weekend. Pick one (or three) and get out of the house.</p>
<h2>[Event 1 name]</h2>
<p><strong>[City] · [Day, time]</strong>— [One or two sentences on why it's worth going. Keep it casual, drop a vibe.]</p>
<h2>[Event 2 name]</h2>
<p><strong>[City] · [Day, time]</strong>— [Why-go blurb.]</p>
<h2>[Event 3 name]</h2>
<p><strong>[City] · [Day, time]</strong>— [Why-go blurb.]</p>
<h2>[Optional event 4 / 5]</h2>
<p><strong>[City] · [Day, time]</strong>— [Why-go blurb.]</p>
<h2>One more thing</h2>
<p>[Optional pest/lawn tie-in — e.g., "If your yard's looking rough before guests come over, we've got a same-week slot." Drop this section if you'd rather keep it pure events.]</p>
<p>Have a good one out there.</p>
<p>— The Waves crew</p>`,
  },
  {
    key: "pest_insider",
    label: "Pest Insider",
    newsletterType: "pest-insider-monthly",
    html: `<h1>[PSA-energy subject — e.g., "🦟 PSA: Mosquitoes Are Back and Hungrier Than Ever"]</h1>
<p>[Seasonal hook — why THIS pest matters right now in SWFL. Biological urgency, never commercial.]</p>
<h2>[🦟 Curiosity-gap facts heading — e.g., "Alright, Let's Talk About Mosquitoes"]</h2>
<p>✔ <strong>[Fact title]</strong> – [Real biology + punchline. Jokes at the pest's expense.]</p>
<p>✔ <strong>[Fact title]</strong> – [6-9 of these carry the issue.]</p>
<h2>[Benefit-framed pitch heading — e.g., "Turn Your Yard Into a No-Fly Zone"]</h2>
<p>[ONE sincere section: what Waves does about it. Plain feature-benefit, no jokes inside, no prices, no invented tech names.]</p>
<p>🔹 <strong>[Capability]</strong> – [Honest benefit.]</p>
<h2>[Voice-y close heading]</h2>
<p>[Close + call CTA. The AI draft attaches the phone number automatically.]</p>
<p>— The Waves Pest Control Team 🌊</p>`,
  },
];

// ── Compose ────────────────────────────────────────────────────────

// Format an ingested event into a concise AI Draft prompt seed. Keeps
// the operator-facing prompt short — Claude handles the voice + the
// extra padding events. Strips obvious HTML from descriptions since
// some RSS feeds embed markup in the contentSnippet/summary fields.
function buildEventPrompt(event) {
  if (!event) return "";
  const dateLabel = event.startAt
    ? new Date(event.startAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Ongoing";
  const cityLabel = event.city
    ? event.city.replace(/(?:^|\s)\S/g, (s) => s.toUpperCase())
    : null;
  const desc = (event.description || "")
    .replace(/<[^>]*>/g, " ") // strip HTML
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  const lines = [
    `Anchor this Weekend Lineup on this event:`,
    `- ${event.title}`,
    `- ${dateLabel}${cityLabel ? ` · ${cityLabel}` : ""}${event.venueName ? ` · ${event.venueName}` : ""}`,
  ];
  // Include venueAddress when populated by the P3b leg 3 normalizer.
  // Helps Claude write specific where-to-find-it copy ("Bayfront Park,
  // 5 Bayfront Dr, Sarasota — free parking on Tamiami") instead of
  // generic ("at the Sarasota waterfront"). Some events have venueName
  // but no address (yet) → omit this line in that case.
  if (event.venueAddress) lines.push(`- Address: ${event.venueAddress}`);
  if (desc) lines.push(`- ${desc}`);
  if (event.eventUrl) lines.push(`- ${event.eventUrl}`);
  lines.push("");
  lines.push(
    "Pad with 2-3 other typical SWFL weekend activities for the same window.",
  );
  return lines.join("\n");
}

export function ComposeView({
  pendingEvent,
  onPendingEventConsumed,
  onSendComplete,
} = {}) {
  // Autopilot notifications deep-link their lane (?autopilotType=…) so
  // the monthly Pest Insider notification hydrates ITS draft, not the
  // weekly one.
  const [searchParams] = useSearchParams();
  const autopilotTypeParam = searchParams.get("autopilotType");
  const [draftId, setDraftId] = useState(null);
  const [subject, setSubject] = useState("");
  const [subjectB, setSubjectB] = useState("");
  const [abEnabled, setAbEnabled] = useState(false);
  const [autoShareSocial, setAutoShareSocial] = useState(true);
  const [previewText, setPreviewText] = useState("");
  const [htmlBody, setHtmlBody] = useState("");
  const [textBody, setTextBody] = useState("");
  // Locked event ids from the last AI draft — carried into the /sends save so
  // the sent newsletter can advance events_raw.times_featured for what shipped.
  const [draftEventIds, setDraftEventIds] = useState([]);
  // Only true when the event association changed THIS session (fresh AI draft
  // or template swap). Gates whether the save sends eventIds: on an ordinary
  // manual edit — or when editing a loaded draft whose ids the client never set
  // — we omit them so the server preserves the stored ids instead of blanking.
  const [eventIdsDirty, setEventIdsDirty] = useState(false);
  const [fromName, setFromName] = useState("Waves Pest Control");
  const [fromEmail, setFromEmail] = useState("newsletter@wavespestcontrol.com");
  // Defaults to the logged-in admin's email (populated below) so test
  // sends don't fire into the shared contact@ inbox by default. Falls
  // back to '' if /me is unreachable — operator types their own.
  const [testEmail, setTestEmail] = useState("");
  const [status, setStatus] = useState("");
  const [activeCount, setActiveCount] = useState(null);
  const [segmentCount, setSegmentCount] = useState(null);
  const [autopilotBanner, setAutopilotBanner] = useState(false);

  // Track the latest pendingEvent value so the mount-only autopilot
  // preload effect can read a fresh value without adding pendingEvent
  // to its dependency array (which would re-fire the fetch).
  const pendingEventRef = useRef(pendingEvent);
  pendingEventRef.current = pendingEvent;

  // Track whether the user has interacted with any compose field.
  // Prevents the autopilot preload from binding draftId to the
  // autopilot row when the user has already started typing.
  const userHasEdited = useRef(false);

  // Segment
  const [segmentMode, setSegmentMode] = useState("all"); // all | customers | leads | custom
  const [segmentSources, setSegmentSources] = useState([]);
  // Tags filter — additive on top of the audience mode (e.g. "Customers
  // only AND tagged 'platinum-tier'"). Maps to f.tags on the server, which
  // matches against newsletter_subscribers.tags (JSONB array) via the
  // ?| operator. Free-form so operators can use whatever taxonomy fits
  // the campaign — the column is JSONB with no enum.
  const [segmentTags, setSegmentTags] = useState([]);
  const [tagDraft, setTagDraft] = useState("");
  // Existing distinct tags pulled from the DB — fed into the tag input's
  // <datalist>so the operator picks an existing tag instead of typing
  // a near-miss that matches zero subscribers.
  const [tagSuggestions, setTagSuggestions] = useState([]);

  // Schedule
  const [scheduleAt, setScheduleAt] = useState("");

  // Preview dialog
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

  // Send confirm dialog
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);

  // AI modal
  const [aiOpen, setAiOpen] = useState(false);
  // Last template the operator chose (via the Template button row OR the
  // AI Draft modal). Plumbed into /draft-ai so AI drafts land in the
  // selected template's structure + voice.
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  // Initial prompt seed for the AI Draft modal. Set when an event was
  // handed off from DashboardView's "Draft newsletter" click; cleared
  // after the modal opens (so reopening from the regular button isn't
  // re-seeded).
  const [aiInitialPrompt, setAiInitialPrompt] = useState("");

  // Consume pendingEvent on mount (or whenever a new one arrives via
  // tab switch). Apply the Weekend Lineup template so the body is
  // pre-seeded, then auto-open the AI Draft modal with the event-shaped
  // prompt. Acknowledge consumption so NewsletterPage clears the
  // handoff state.
  useEffect(() => {
    if (!pendingEvent) return;
    const weekend = TEMPLATES.find((t) => t.key === "weekend");
    if (weekend) setHtmlBody(weekend.html);
    setSelectedTemplate("weekend");
    setAiInitialPrompt(buildEventPrompt(pendingEvent));
    setAiOpen(true);
    if (onPendingEventConsumed) onPendingEventConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEvent]);

  // Auto-select the flagship template for brand-new composes so the
  // operator lands in the "Fresh This Week" flow by default. Skip when
  // loading an existing draft (draftId) or when event-seeded
  // (pendingEvent) — those paths set their own template.
  useEffect(() => {
    if (!draftId && !pendingEvent && !selectedTemplate) {
      const weekend = TEMPLATES.find((t) => t.key === 'weekend');
      if (weekend) {
        setHtmlBody(weekend.html);
        setSelectedTemplate('weekend');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const segmentFilter = useMemo(() => {
    const f = {};
    if (segmentMode === "customers") f.customersOnly = true;
    if (segmentMode === "leads") f.leadsOnly = true;
    // Source chips are only visible in 'custom' mode — scope the filter
    // to that mode so a stale segmentSources selection doesn't leak
    // through after the operator switches back to "All active" /
    // "Customers only" / "Leads only". Tags remain additive across all
    // modes by design.
    if (segmentMode === "custom" && segmentSources.length)
      f.sources = segmentSources;
    if (segmentTags.length) f.tags = segmentTags;
    return Object.keys(f).length ? f : null;
  }, [segmentMode, segmentSources, segmentTags]);

  useEffect(() => {
    adminFetch("/admin/newsletter/subscribers?status=active&limit=1")
      .then((d) => setActiveCount(d.counts?.active || 0))
      .catch(() => setActiveCount(null));
    adminFetch("/admin/auth/me")
      .then((me) => {
        if (me?.email) setTestEmail(me.email);
      })
      .catch(() => {
        /* leave blank, operator types */
      });
    adminFetch("/admin/newsletter/tags")
      .then((d) => setTagSuggestions(Array.isArray(d?.tags) ? d.tags : []))
      .catch(() => setTagSuggestions([]));
  }, []);

  // Auto-load pending autopilot draft on mount (if compose form is empty).
  // Uses a cancelled flag so a late-resolving fetch won't overwrite
  // fields the user has started editing during the round-trip.
  // userHasEdited ref is the authoritative guard — if the user typed
  // anything into subject/htmlBody/previewText/textBody before the
  // fetch resolves, we skip hydration entirely (including draftId)
  // so the user's new content doesn't get saved to the autopilot row.
  // pendingEventRef reads the latest value without adding it to deps.
  useEffect(() => {
    if (draftId || pendingEventRef.current) return; // already editing a draft or event-seeded
    let cancelled = false;
    // ?autopilotType= comes from autopilot notifications (e.g. the monthly
    // Pest Insider) so the click lands on THAT lane's draft instead of the
    // weekly default.
    const laneParam = autopilotTypeParam === "pest-insider-monthly"
      ? "?type=pest-insider-monthly"
      : "";
    adminFetch(`/admin/newsletter/sends/latest-autopilot${laneParam}`)
      .then((d) => {
        if (cancelled || pendingEventRef.current || userHasEdited.current) return;
        if (!d?.draft) return;
        const ap = d.draft;
        setDraftId(ap.id);
        setSubject(ap.subject || "");
        setPreviewText(ap.preview_text || "");
        setHtmlBody(ap.html_body || "");
        setTextBody(ap.text_body || "");
        setAutoShareSocial(ap.auto_share_social !== false);
        const tplForType = TEMPLATES.find((t) => t.newsletterType === ap.newsletter_type);
        setSelectedTemplate(tplForType?.key || "weekend");
        setAutopilotBanner(true);
      })
      .catch(() => { /* no autopilot draft — nothing to do */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recalculate segment match count when the filter changes.
  useEffect(() => {
    let cancelled = false;
    adminFetch("/admin/newsletter/segment-preview", {
      method: "POST",
      body: JSON.stringify({ segmentFilter }),
    })
      .then((d) => {
        if (!cancelled) setSegmentCount(d.count);
      })
      .catch(() => {
        if (!cancelled) setSegmentCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [segmentFilter]);

  const activeNewsletterType = (() => {
    const key = selectedTemplate || "blank";
    const t = TEMPLATES.find((x) => x.key === key);
    return t?.newsletterType || null;
  })();

  const applyTemplate = (key) => {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    if (
      htmlBody &&
      !confirm("Replace the current HTML body with this template?")
    )
      return;
    userHasEdited.current = true;
    setHtmlBody(t.html);
    setSelectedTemplate(key === "blank" ? null : key);
    // A hand-picked template body isn't anchored to AI-locked events — clear the
    // ids and mark dirty so the save writes the empty set (the prior AI events
    // no longer match this body).
    setDraftEventIds([]);
    setEventIdsDirty(true);
  };

  const saveDraft = async () => {
    setStatus("Saving...");
    try {
      const body = {
        subject,
        subjectB: abEnabled ? subjectB : null,
        previewText,
        htmlBody,
        textBody,
        fromName,
        fromEmail,
        segmentFilter,
        newsletterType: activeNewsletterType,
        autoShareSocial,
      };
      // Send eventIds only when the event association changed this session
      // (dirty). Omitting them lets the server preserve the stored ids on an
      // ordinary edit or when editing a loaded draft; including them on a fresh
      // AI re-draft (even of an already-saved campaign) updates them in step
      // with the new body.
      const saveBody = eventIdsDirty ? { ...body, eventIds: draftEventIds } : body;
      if (draftId) {
        await adminFetch(`/admin/newsletter/sends/${draftId}`, {
          method: "PATCH",
          body: JSON.stringify(saveBody),
        });
      } else {
        const d = await adminFetch("/admin/newsletter/sends", {
          method: "POST",
          body: JSON.stringify(saveBody),
        });
        setDraftId(d.send.id);
      }
      setEventIdsDirty(false);
      setStatus("Draft saved.");
    } catch (e) {
      setStatus("Save failed: " + e.message);
    }
  };

  const openPreview = async () => {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewHtml("");
    try {
      const res = await adminFetch("/admin/newsletter/preview", {
        method: "POST",
        body: JSON.stringify({ htmlBody, previewText, newsletterType: activeNewsletterType }),
      });
      setPreviewHtml(res.html || "");
    } catch (e) {
      setPreviewHtml(
        `<p style="font-family:sans-serif;color:#C8312F;padding:20px;">Preview failed: ${e.message}</p>`,
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const sendTest = async () => {
    if (!draftId) {
      setStatus("Save a draft first.");
      return;
    }
    setStatus(`Sending test to ${testEmail}...`);
    try {
      await adminFetch(`/admin/newsletter/sends/${draftId}/test`, {
        method: "POST",
        body: JSON.stringify({ email: testEmail }),
      });
      setStatus(`Test sent to ${testEmail}.`);
    } catch (e) {
      setStatus("Test failed: " + e.message);
    }
  };

  // Open the typed-confirm modal. The actual fetch happens in confirmSend
  // once the operator types SEND and clicks the button.
  const [validationResult, setValidationResult] = useState(null);

  const sendNow = async () => {
    if (!draftId) {
      setStatus("Save a draft first.");
      return;
    }
    try {
      setStatus("Validating…");
      const v = await adminFetch(`/admin/newsletter/sends/${draftId}/validate`, {
        method: "POST",
      });
      setValidationResult(v);
      if (v.errors?.length > 0) {
        setStatus("Validation failed — fix errors before sending.");
        return;
      }
      setSendConfirmOpen(true);
    } catch (e) {
      setStatus("Validation check failed: " + e.message);
    }
  };

  const confirmSend = async () => {
    setSendConfirmOpen(false);
    const audience = segmentCount ?? activeCount ?? "?";
    setStatus(`Queuing send to ${audience} subscribers...`);
    try {
      // Server returns 202 — campaign runs asynchronously now (a long
      // synchronous send was timing out the proxy and prompting double-
      // clicks). Operator polls History for the final delivered/failed
      // counts.
      await adminFetch(`/admin/newsletter/sends/${draftId}/send`, {
        method: "POST",
      });
      setStatus(`Send queued. Opening History…`);
      resetForm();
      // Brief delay so the operator sees the status before the tab
      // switches; History view will refresh when the parent flips
      // refreshKey, surfacing the new row at status='sending'.
      if (onSendComplete) setTimeout(onSendComplete, 1200);
    } catch (e) {
      setStatus("Send failed: " + e.message);
    }
  };

  const schedule = async () => {
    if (!draftId) {
      setStatus("Save a draft first.");
      return;
    }
    if (!scheduleAt) {
      setStatus("Pick a date/time first.");
      return;
    }
    const when = new Date(scheduleAt);
    if (when.getTime() <= Date.now()) {
      setStatus("Pick a time in the future.");
      return;
    }
    setStatus("Scheduling...");
    try {
      const res = await adminFetch(
        `/admin/newsletter/sends/${draftId}/schedule`,
        {
          method: "POST",
          body: JSON.stringify({ scheduledFor: when.toISOString() }),
        },
      );
      setStatus(
        `Scheduled for ${new Date(res.send.scheduled_for).toLocaleString()}.`,
      );
      resetForm();
    } catch (e) {
      setStatus("Schedule failed: " + e.message);
    }
  };

  const resetForm = () => {
    setDraftId(null);
    setSubject("");
    setSubjectB("");
    setAbEnabled(false);
    setAutoShareSocial(true);
    setPreviewText("");
    setHtmlBody("");
    setTextBody("");
    setDraftEventIds([]);
    setEventIdsDirty(false);
    setScheduleAt("");
    setSelectedTemplate(null);
  };

  const handleAiDraft = async ({
    prompt,
    template,
    audience,
    tone,
    includeCTA,
    eventIds,
  }) => {
    userHasEdited.current = true;
    const tpl = template ? TEMPLATES.find((t) => t.key === template) : null;
    const newsletterType = tpl?.newsletterType || null;
    const res = await adminFetch("/admin/newsletter/draft-ai", {
      method: "POST",
      body: JSON.stringify({ prompt, template, newsletterType, eventIds, audience, tone, includeCTA }),
    });
    const d = res.draft || {};
    if (d.subject || d.selectedSubject) setSubject(d.subject || d.selectedSubject);
    if (d.previewText) setPreviewText(d.previewText);
    if (d.htmlBody) setHtmlBody(d.htmlBody);
    if (d.textBody) setTextBody(d.textBody);
    // Carry the locked event ids so saveDraft persists them for times_featured.
    // Mark dirty so the next save (POST or PATCH) writes the new set — covers
    // re-drafting an already-saved campaign with a different event lineup.
    setDraftEventIds(Array.isArray(res.eventIds) ? res.eventIds : []);
    setEventIdsDirty(true);
    // Always sync — `template` is null when operator picks "Free-form" in
    // the modal, and we want that to clear the prior selection so the
    // next modal opens defaulting to no template.
    setSelectedTemplate(template || null);
    setAiOpen(false);
    // Clear the event-seeded prompt on success too (mirror of the
    // onClose handler). Otherwise the next "Draft with AI" toolbar
    // click would prefill with the stale event seed.
    setAiInitialPrompt("");
    setStatus("AI draft inserted. Review before saving.");
  };

  const audienceLabel =
    segmentCount !== null && segmentFilter
      ? `${segmentCount} of ${activeCount ?? "?"} subscribers match segment`
      : activeCount !== null
        ? `${activeCount} active subscriber${activeCount === 1 ? "" : "s"}`
        : "Loading subscribers…";

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
      {autopilotBanner && (
        <div className="col-span-full flex items-center justify-between bg-amber-50 border border-amber-200 rounded-sm px-4 py-3 text-13 text-amber-900">
          <span>
            <strong>Autopilot draft</strong> — This draft was auto-generated by the weekly autopilot. Review and send when ready.
          </span>
          <button
            onClick={() => setAutopilotBanner(false)}
            className="ml-3 text-amber-600 hover:text-amber-800"
            aria-label="Dismiss banner"
          >
            <XCircle size={16} strokeWidth={1.75} />
          </button>
        </div>
      )}
      {" "}
      <div className={PANEL_CLS}>
        {" "}
        <PanelHeader
          title="Campaign Content"
          hint="Write the message body, subject, preview text, and sender details."
          action={
            <div className="flex items-center gap-2">
              {draftId && <Badge tone="neutral">Draft saved</Badge>}
              <Button onClick={() => setAiOpen(true)} variant="secondary">
                {" "}
                <Wand2
                  size={14}
                  strokeWidth={1.75}
                  className="mr-2"
                  aria-hidden
                />
                Draft With AI
              </Button>{" "}
            </div>
          }
        />{" "}
        <div className="p-4 space-y-4">
          {" "}
          <div>
            {" "}
            <FieldLabel>Template</FieldLabel>{" "}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => applyTemplate('weekend')}
                className="h-8 px-3 text-12 font-medium rounded-sm border-hairline border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 u-focus-ring"
              >
                Fresh This Week
              </button>
              <button type="button" onClick={() => applyTemplate('blank')} className="text-11 text-ink-tertiary hover:text-ink-secondary underline">Start from scratch</button>
            </div>{" "}
          </div>{" "}
          {activeNewsletterType === "local-weekly-fresh-events" && (
            <DigestPlanner
              onDraftFromPlan={async ({ eventIds, prompt }) => {
                try {
                  setStatus("Drafting from plan…");
                  await handleAiDraft({
                    prompt,
                    template: "weekend",
                    audience: "Waves subscribers — North Port to Tampa",
                    tone: "Neighborly, FOMO-driven, local friend energy",
                    includeCTA: true,
                    eventIds,
                  });
                } catch (e) {
                  setStatus("Draft failed: " + e.message);
                }
              }}
            />
          )}
          <div>
            {" "}
            <FieldLabel>
              Subject{" "}
              {abEnabled && (
                <span className="text-ink-tertiary normal-case">(A)</span>
              )}
            </FieldLabel>{" "}
            <input
              type="text"
              value={subject}
              onChange={(e) => { userHasEdited.current = true; setSubject(e.target.value); }}
              className={INPUT_CLS}
              placeholder="e.g. Florida spring pest alert — what to watch for"
            />{" "}
            <label className="mt-2 inline-flex items-center gap-2 text-12 text-ink-secondary">
              {" "}
              <input
                type="checkbox"
                checked={abEnabled}
                onChange={(e) => setAbEnabled(e.target.checked)}
              />
              A/B test a second subject (random 50/50 split)
            </label>{" "}
          </div>
          {abEnabled && (
            <div>
              {" "}
              <FieldLabel>Subject (B)</FieldLabel>{" "}
              <input
                type="text"
                value={subjectB}
                onChange={(e) => setSubjectB(e.target.value)}
                className={INPUT_CLS}
                placeholder="Alternative subject line"
              />{" "}
            </div>
          )}
          <div>
            {" "}
            <FieldLabel>Preview text</FieldLabel>{" "}
            <input
              type="text"
              value={previewText}
              onChange={(e) => { userHasEdited.current = true; setPreviewText(e.target.value); }}
              className={INPUT_CLS}
              placeholder="One-line preview that renders after the subject in Gmail/Apple Mail."
            />{" "}
          </div>{" "}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {" "}
            <div>
              {" "}
              <FieldLabel>From name</FieldLabel>{" "}
              <input
                type="text"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                className={INPUT_CLS}
              />{" "}
            </div>{" "}
            <div>
              {" "}
              <FieldLabel>From email</FieldLabel>{" "}
              <input
                type="text"
                value={fromEmail}
                onChange={(e) => setFromEmail(e.target.value)}
                className={`${INPUT_CLS} font-mono`}
              />{" "}
            </div>{" "}
          </div>{" "}
          <div>
            {" "}
            <FieldLabel>HTML body</FieldLabel>{" "}
            <textarea
              value={htmlBody}
              onChange={(e) => { userHasEdited.current = true; setHtmlBody(e.target.value); }}
              rows={16}
              className={TEXTAREA_CLS}
              placeholder="<h1>Subject line</h1><p>Your newsletter content here. The unsubscribe footer is appended automatically.</p>"
            />{" "}
            <p className="text-11 text-ink-tertiary mt-1">
              The unsubscribe footer + List-Unsubscribe header are added
              automatically — do not include your own.
            </p>{" "}
          </div>{" "}
          <div>
            {" "}
            <FieldLabel>
              Plain-text fallback{" "}
              <span className="text-ink-tertiary normal-case">
                (optional — improves deliverability)
              </span>{" "}
            </FieldLabel>{" "}
            <textarea
              value={textBody}
              onChange={(e) => { userHasEdited.current = true; setTextBody(e.target.value); }}
              rows={5}
              className={INPUT_CLS}
              placeholder="Same content in plain text for mail clients that don't render HTML."
            />{" "}
          </div>{" "}
        </div>{" "}
      </div>{" "}
      <aside className="space-y-4">
        {" "}
        <div className={PANEL_CLS}>
          {" "}
          <PanelHeader title="Audience" hint={audienceLabel} />{" "}
          <div className="p-4 space-y-3">
            {" "}
            <div className="flex flex-wrap gap-1.5">
              {[
                { key: "all", label: "All active" },
                { key: "customers", label: "Customers only" },
                { key: "leads", label: "Non-customers only" },
                { key: "custom", label: "By source…" },
              ].map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setSegmentMode(o.key)}
                  className={cn(
                    "h-8 px-3 text-12 font-medium rounded-sm border-hairline u-focus-ring",
                    segmentMode === o.key
                      ? "bg-zinc-900 text-white border-zinc-900"
                      : "bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {segmentMode === "custom" && (
              <div className="flex flex-wrap gap-1.5">
                {SOURCE_SEGMENTS.map((src) => {
                  const on = segmentSources.includes(src.value);
                  return (
                    <button
                      key={src.value}
                      type="button"
                      onClick={() =>
                        setSegmentSources((cur) =>
                          on
                            ? cur.filter((x) => x !== src.value)
                            : [...cur, src.value],
                        )
                      }
                      className={cn(
                        "h-7 px-2.5 text-11 rounded-full border-hairline u-focus-ring",
                        on
                          ? "bg-zinc-900 text-white border-zinc-900"
                          : "bg-white text-ink-secondary border-zinc-300 hover:border-zinc-900",
                      )}
                    >
                      {src.label}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="mt-3">
              {" "}
              <FieldLabel>
                Tags{" "}
                <span className="normal-case tracking-normal text-ink-tertiary">
                  (optional, additive)
                </span>{" "}
              </FieldLabel>{" "}
              <div className="flex flex-wrap items-center gap-1.5">
                {segmentTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      setSegmentTags((cur) => cur.filter((x) => x !== t))
                    }
                    className="h-7 px-2.5 text-11 rounded-full bg-zinc-900 text-white border-hairline border-zinc-900 u-focus-ring"
                    title="Click to remove"
                  >
                    {t} ×
                  </button>
                ))}
                <input
                  type="text"
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  list="newsletter-tag-suggestions"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      const v = tagDraft.trim().toLowerCase();
                      if (v && !segmentTags.includes(v))
                        setSegmentTags((cur) => [...cur, v]);
                      setTagDraft("");
                    } else if (
                      e.key === "Backspace" &&
                      !tagDraft &&
                      segmentTags.length
                    ) {
                      setSegmentTags((cur) => cur.slice(0, -1));
                    }
                  }}
                  placeholder={
                    segmentTags.length
                      ? "add another…"
                      : "e.g. platinum-tier, hurricane-prep"
                  }
                  className="h-7 flex-1 min-w-[160px] bg-white border-hairline border-zinc-300 rounded-full px-3 text-11 text-zinc-900 placeholder:text-ink-tertiary focus:outline-none focus:border-zinc-900"
                />{" "}
                <datalist id="newsletter-tag-suggestions">
                  {tagSuggestions
                    .filter((t) => !segmentTags.includes(t))
                    .map((t) => (
                      <option key={t} value={t} />
                    ))}
                </datalist>{" "}
              </div>{" "}
              <div className="text-11 text-ink-tertiary mt-1">
                Press Enter or comma to add. Matches subscribers tagged with ANY
                of the listed tags.
              </div>{" "}
            </div>{" "}
          </div>{" "}
        </div>{" "}
        <div className={PANEL_CLS}>
          {" "}
          <PanelHeader
            title="Review + Send"
            hint="Save before test sends, live sends, or scheduling."
          />{" "}
          <div className="p-4 space-y-3">
            {" "}
            <Button
              onClick={saveDraft}
              variant="secondary"
              disabled={!subject}
              className="w-full"
            >
              {" "}
              <Save size={14} strokeWidth={1.75} className="mr-2" aria-hidden />
              {draftId ? "Update draft" : "Save draft"}
            </Button>{" "}
            <Button
              onClick={openPreview}
              variant="secondary"
              disabled={!htmlBody}
              className="w-full"
            >
              {" "}
              <Eye size={14} strokeWidth={1.75} className="mr-2" aria-hidden />
              Preview
            </Button>{" "}
            <div>
              {" "}
              <FieldLabel>Test recipient</FieldLabel>{" "}
              <input
                type="text"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                className={`${INPUT_CLS} font-mono`}
                placeholder="test@wavespestcontrol.com"
              />{" "}
            </div>{" "}
            <Button
              onClick={sendTest}
              variant="secondary"
              disabled={!draftId || !testEmail}
              className="w-full"
            >
              {" "}
              <MailCheck
                size={14}
                strokeWidth={1.75}
                className="mr-2"
                aria-hidden
              />
              Send Test
            </Button>{" "}
            <Button
              onClick={sendNow}
              disabled={!draftId || !htmlBody || segmentCount === 0}
              className="w-full"
            >
              {" "}
              <Send size={14} strokeWidth={1.75} className="mr-2" aria-hidden />
              Send To Audience
            </Button>{" "}
            {validationResult && (
              <div className="mt-2 space-y-1">
                {validationResult.errors?.map((e, i) => (
                  <div key={`e${i}`} className="flex items-start gap-1.5 text-11 text-red-700 bg-red-50 rounded px-2 py-1">
                    <XCircle size={11} className="mt-0.5 shrink-0" />{e}
                  </div>
                ))}
                {validationResult.warnings?.map((w, i) => (
                  <div key={`w${i}`} className="flex items-start gap-1.5 text-11 text-amber-700 bg-amber-50 rounded px-2 py-1">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />{w}
                  </div>
                ))}
                {validationResult.valid && !validationResult.warnings?.length && (
                  <div className="flex items-center gap-1.5 text-11 text-green-700 bg-green-50 rounded px-2 py-1">
                    <CheckCircle2 size={11} className="shrink-0" />Validation passed
                  </div>
                )}
              </div>
            )}
          </div>{" "}
        </div>{" "}
        <div className={PANEL_CLS}>
          {" "}
          <PanelHeader
            title="Schedule"
            hint="Queued sends fire within one minute of the target time."
          />{" "}
          <div className="p-4 space-y-3">
            {" "}
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className={`${INPUT_CLS} font-mono`}
            />{" "}
            <Button
              onClick={schedule}
              variant="secondary"
              disabled={!draftId || !scheduleAt || !htmlBody}
              className="w-full"
            >
              {" "}
              <CalendarClock
                size={14}
                strokeWidth={1.75}
                className="mr-2"
                aria-hidden
              />
              Schedule Send
            </Button>{" "}
            <div className="text-11 text-ink-tertiary">
              {scheduleAt
                ? `Fires ${new Date(scheduleAt).toLocaleString("en-US", {
                    timeZone: "America/New_York",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })} ET`
                : "America/New_York timezone"}
            </div>{" "}
          </div>{" "}
        </div>
        <div className={PANEL_CLS}>
          <PanelHeader title="Social" />
          <div className="p-4 space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoShareSocial}
                onChange={(e) => {
                  setAutoShareSocial(e.target.checked);
                  userHasEdited.current = true;
                }}
                className="mt-0.5 w-4 h-4 rounded border-hairline"
              />
              <span className="text-12 text-ink-secondary leading-snug">
                Auto-post a teaser after this newsletter is sent
              </span>
            </label>
            <div className="text-11 text-ink-tertiary pl-6">
              Facebook, Instagram, LinkedIn & Google Business Profile.
              Links to the public newsletter archive. Test sends are never posted.
            </div>
          </div>
        </div>
        {status && (
          <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-3 text-12 text-ink-secondary">
            {status}
          </div>
        )}
      </aside>
      {aiOpen && (
        <AiDraftModal
          initialNewsletterType={activeNewsletterType}
          initialPrompt={aiInitialPrompt}
          onClose={() => {
            setAiOpen(false);
            setAiInitialPrompt("");
          }}
          onDraft={handleAiDraft}
        />
      )}
      {previewOpen && (
        <PreviewDialog
          html={previewHtml}
          loading={previewLoading}
          onClose={() => setPreviewOpen(false)}
        />
      )}
      {sendConfirmOpen && (
        <SendConfirmDialog
          subject={subject}
          subjectB={abEnabled ? subjectB : null}
          previewText={previewText}
          fromName={fromName}
          fromEmail={fromEmail}
          audience={segmentCount ?? activeCount ?? null}
          activeCount={activeCount}
          segmentFilter={segmentFilter}
          htmlBody={htmlBody}
          onCancel={() => setSendConfirmOpen(false)}
          onConfirm={confirmSend}
        />
      )}
    </div>
  );
}

// ── Send confirm dialog ──────────────────────────────────────────────
//
// Replaces window.confirm() for the most consequential button in the admin
// app. Shows a rendered preview of the body, the resolved audience, and a
// type-SEND gate — the goal is to make a destructive double-click much
// less likely than a stray Enter on the browser modal.

function SendConfirmDialog({
  subject,
  subjectB,
  previewText,
  fromName,
  fromEmail,
  audience,
  activeCount,
  segmentFilter,
  htmlBody,
  onCancel,
  onConfirm,
}) {
  const [typed, setTyped] = useState("");
  const ready = typed.trim().toUpperCase() === "SEND" && audience > 0;

  const segmentSummary = useMemo(() => {
    if (!segmentFilter) return `All active (${activeCount ?? "?"})`;
    const parts = [];
    if (segmentFilter.customersOnly) parts.push("Customers only");
    else if (segmentFilter.leadsOnly) parts.push("Non-customers only");
    if (Array.isArray(segmentFilter.sources) && segmentFilter.sources.length) {
      parts.push(`Sources: ${segmentFilter.sources.join(", ")}`);
    }
    if (Array.isArray(segmentFilter.tags) && segmentFilter.tags.length) {
      parts.push(`Tags: ${segmentFilter.tags.join(", ")}`);
    }
    return parts.length ? parts.join(" · ") : "Filtered";
  }, [segmentFilter, activeCount]);

  // Body-only preview — no chrome wrap. The wrap is server-side and
  // identical for every campaign, so the operator's review value is
  // entirely in the body. Sandbox tight (no scripts, no same-origin)
  // since the operator authored the HTML and may have pasted anything.
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><style>html,body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.55;color:#0F172A;}body{padding:14px;}h1,h2,h3,h4{line-height:1.25;}img{max-width:100%;height:auto;}*{box-sizing:border-box;}</style></head><body>${stripGreetingToken(htmlBody) || '<em style="color:#64748B">(empty body)</em>'}</body></html>`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      {" "}
      <div
        className="bg-white border-hairline border-zinc-300 rounded-sm shadow-xl w-full max-w-2xl flex flex-col"
        style={{ maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {" "}
        <div className="p-5 border-b border-hairline border-zinc-200 flex items-start justify-between flex-shrink-0">
          {" "}
          <div className="min-w-0">
            {" "}
            <h3 className="text-16 font-medium text-zinc-900">
              Send to {audience != null ? audience.toLocaleString() : "?"}{" "}
              subscriber{audience === 1 ? "" : "s"}?
            </h3>{" "}
            <p className="text-12 text-ink-secondary mt-0.5">
              This can't be undone. Each recipient is contacted at the SendGrid
              send below.
            </p>{" "}
          </div>{" "}
          <button
            type="button"
            onClick={onCancel}
            className="text-ink-tertiary hover:text-zinc-900 text-14 ml-3"
            aria-label="Close"
          >
            ×
          </button>{" "}
        </div>{" "}
        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-3">
          {" "}
          <ConfirmRow
            label="Subject"
            value={subject || <em className="text-ink-tertiary">(missing)</em>}
          />
          {subjectB && (
            <ConfirmRow
              label="Subject (B)"
              value={subjectB}
              hint="A/B 50/50 random split"
            />
          )}
          {previewText && (
            <ConfirmRow label="Preview text" value={previewText} />
          )}
          <ConfirmRow label="From" value={`${fromName} <${fromEmail}>`} />{" "}
          <ConfirmRow label="Audience" value={segmentSummary} />{" "}
          <div>
            {" "}
            <div className="text-11 uppercase tracking-label text-ink-secondary mb-1">
              Body preview
            </div>{" "}
            <iframe
              title="Body preview"
              srcDoc={srcDoc}
              sandbox=""
              style={{
                width: "100%",
                height: 320,
                border: "1px solid #E4E4E7",
                borderRadius: 4,
                background: "#fff",
              }}
            />{" "}
            <p className="text-11 text-ink-tertiary mt-1">
              Body only — Waves header + unsubscribe footer are added
              server-side. Send a test if you want to see the full chrome.
            </p>{" "}
          </div>{" "}
        </div>{" "}
        <div className="px-5 py-4 border-t border-hairline border-zinc-200 flex items-center gap-3 flex-shrink-0 flex-wrap">
          {" "}
          <label className="text-12 text-ink-secondary flex-shrink-0">
            Type SEND to confirm:
          </label>{" "}
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            className="bg-white border-hairline border-zinc-300 rounded-sm py-1.5 px-2 text-13 text-zinc-900 font-mono w-32"
            placeholder="SEND"
          />{" "}
          <div className="ml-auto flex items-center gap-2">
            {" "}
            <Button onClick={onCancel} variant="secondary">
              Cancel
            </Button>{" "}
            <Button onClick={onConfirm} disabled={!ready}>
              Send to all
            </Button>{" "}
          </div>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// ── Preview dialog ───────────────────────────────────────────────────
//
// Renders the operator's draft inside the same chrome the live send uses
// (server returns the wrapped HTML from POST /admin/newsletter/preview).
// Sandboxed iframe — no scripts, no same-origin — since the body is
// operator-authored.

function PreviewDialog({ html, loading, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      {" "}
      <div
        className="bg-white border-hairline border-zinc-300 rounded-sm shadow-xl w-full max-w-3xl flex flex-col"
        style={{ maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {" "}
        <div className="p-5 border-b border-hairline border-zinc-200 flex items-center justify-between flex-shrink-0">
          {" "}
          <div>
            {" "}
            <h3 className="text-16 font-medium text-zinc-900">Preview</h3>{" "}
            <p className="text-12 text-ink-secondary mt-0.5">
              How the email looks with header + footer chrome. Unsubscribe link
              is a demo token; real recipients get their own.
            </p>{" "}
          </div>{" "}
          <button
            type="button"
            onClick={onClose}
            className="text-ink-tertiary hover:text-zinc-900 text-14 ml-3"
            aria-label="Close"
          >
            ×
          </button>{" "}
        </div>{" "}
        <div className="overflow-y-auto flex-1 bg-zinc-50 p-3">
          {loading ? (
            <div className="text-13 text-ink-secondary p-8 text-center">
              Rendering…
            </div>
          ) : (
            <iframe
              title="Newsletter preview"
              srcDoc={html}
              sandbox=""
              style={{
                width: "100%",
                minHeight: "60vh",
                border: "1px solid #E4E4E7",
                borderRadius: 4,
                background: "#fff",
              }}
            />
          )}
        </div>{" "}
        <div className="px-5 py-3 border-t border-hairline border-zinc-200 flex justify-end flex-shrink-0">
          {" "}
          <Button onClick={onClose} variant="secondary">
            Close
          </Button>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

function ConfirmRow({ label, value, hint }) {
  return (
    <div className="flex items-baseline gap-3">
      {" "}
      <div className="text-11 uppercase tracking-label text-ink-secondary w-28 flex-shrink-0">
        {label}
      </div>{" "}
      <div className="flex-1 min-w-0">
        {" "}
        <div className="text-13 text-zinc-900 break-words">{value}</div>
        {hint && <div className="text-11 text-ink-tertiary mt-0.5">{hint}</div>}
      </div>{" "}
    </div>
  );
}

// ── Digest Planner ────────────────────────────────────────────────

const SECTION_LABELS = {
  fresh_this_week: "Fresh This Week",
  just_starting: "Just Starting",
  weekend_picks: "Weekend Picks",
  family_or_low_key_pick: "Family / Low-Key Pick",
  road_trip_pick: "Road Trip Pick",
};

function DigestPlanner({ onDraftFromPlan }) {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [weekStart, setWeekStart] = useState("");
  const [homeownerTopic, setHomeownerTopic] = useState("");
  const [suppressedOpen, setSuppressedOpen] = useState(false);

  const generatePlan = async () => {
    setLoading(true);
    try {
      const body = {};
      if (weekStart) body.weekStart = weekStart;
      const res = await adminFetch("/admin/newsletter/events/digest-plan", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setPlan(res);
    } catch (e) {
      setPlan({ error: e.message });
    } finally {
      setLoading(false);
    }
  };

  const draftFromPlan = () => {
    if (!plan?.sections) return;
    const allEvents = Object.values(plan.sections).flat();
    const ids = allEvents.map((e) => e.id);
    const summary = allEvents.slice(0, 8).map((e) => `${e.title} (${e.city || "SWFL"})`).join(", ");
    const prompt = `Fresh events this week from North Port to Tampa: ${summary}.${homeownerTopic ? ` Homeowner Minute topic: ${homeownerTopic}.` : ""}`;
    onDraftFromPlan({ eventIds: ids, prompt });
  };

  const fmtDate = (d) => {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-US", {
      month: "short", day: "numeric", weekday: "short", timeZone: "America/New_York",
    });
  };

  return (
    <div className="border-hairline border-zinc-200 rounded-sm bg-zinc-50 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <CalendarDays size={14} strokeWidth={1.75} className="text-ink-secondary" />
        <span className="text-13 font-medium text-ink-primary">Digest Planner</span>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="block text-11 text-ink-tertiary mb-0.5">Week starting (Thursday)</label>
          <input type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)}
            className="h-8 px-2 text-12 bg-white border-hairline border-zinc-300 rounded-sm w-full" />
        </div>
        <Button size="sm" onClick={generatePlan} disabled={loading}>
          <Sparkles size={12} className="mr-1" />{loading ? "Planning…" : "Generate Plan"}
        </Button>
      </div>
      {plan?.error && <div className="text-12 text-red-600 bg-red-50 rounded p-2">{plan.error}</div>}
      {plan?.sections && (
        <>
          <div className="text-11 text-ink-tertiary">
            {plan.weekStart} — {plan.weekEnd} · {plan.stats?.totalEligible || 0} eligible · {plan.stats?.totalAssigned || 0} assigned
          </div>
          {plan.warnings?.length > 0 && (
            <div className="space-y-1">
              {plan.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-1.5 text-11 text-amber-700 bg-amber-50 rounded px-2 py-1">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" />{w}
                </div>
              ))}
            </div>
          )}
          {Object.entries(SECTION_LABELS).map(([key, label]) => {
            const events = plan.sections[key] || [];
            return (
              <div key={key}>
                <div className="text-11 font-medium text-ink-secondary uppercase tracking-label mb-1">{label} ({events.length})</div>
                {events.length === 0 ? (
                  <div className="text-11 text-ink-tertiary italic">None assigned</div>
                ) : (
                  <div className="space-y-1">
                    {events.map((ev) => (
                      <div key={ev.id} className="flex items-center justify-between bg-white border-hairline border-zinc-200 rounded px-2 py-1.5">
                        <div className="min-w-0">
                          <div className="text-12 font-medium text-ink-primary truncate">{ev.title}</div>
                          <div className="text-10 text-ink-tertiary">{ev.city || "—"} · {fmtDate(ev.startAt)}</div>
                        </div>
                        <span className="text-10 text-ink-tertiary u-nums ml-2 shrink-0">{ev.compositeScore}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {plan.suppressed?.length > 0 && (
            <div>
              <button type="button" onClick={() => setSuppressedOpen(!suppressedOpen)} className="text-11 text-ink-tertiary hover:text-ink-secondary">
                {suppressedOpen ? "Hide" : "Show"} suppressed ({plan.suppressed.length})
              </button>
              {suppressedOpen && (
                <div className="mt-1 space-y-0.5">
                  {plan.suppressed.map((s) => (
                    <div key={s.id} className="text-11 text-ink-tertiary line-through">{s.title} — {s.reason}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div>
            <label className="block text-11 text-ink-tertiary mb-0.5">Homeowner Minute topic (optional)</label>
            <input type="text" value={homeownerTopic} onChange={(e) => setHomeownerTopic(e.target.value)}
              placeholder="e.g. Check patio planters for standing water"
              className="h-8 px-2 text-12 bg-white border-hairline border-zinc-300 rounded-sm w-full" />
          </div>
          <Button onClick={draftFromPlan} className="w-full">
            <Wand2 size={13} className="mr-1.5" />Draft Newsletter from Plan
          </Button>
        </>
      )}
    </div>
  );
}

// ── AI draft modal ────────────────────────────────────────────────

function AiDraftModal({ initialNewsletterType, initialPrompt, onClose, onDraft }) {
  const [prompt, setPrompt] = useState(initialPrompt || "");
  const [audience, setAudience] = useState("Existing Waves customers");
  const [tone, setTone] = useState("Neighborly, owner-operator");
  const [includeCTA, setIncludeCTA] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    if (prompt.trim().length < 8) {
      setErr("Describe the newsletter (at least 8 characters)");
      return;
    }
    setLoading(true);
    setErr("");
    try {
      // Map the active newsletter type back to its template card so the
      // server's /draft-ai routes to the matching structured flow (a Pest
      // Insider compose must NOT fall back to the weekend/flagship path).
      const tplForType = TEMPLATES.find((t) => t.newsletterType === initialNewsletterType);
      const effectiveTemplate = initialNewsletterType === 'free-form'
        ? null
        : (tplForType?.key || 'weekend');
      await onDraft({
        prompt,
        template: effectiveTemplate,
        audience,
        tone,
        includeCTA,
      });
    } catch (e) {
      setErr(e.message);
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      {" "}
      <div
        className="bg-white border-hairline border-zinc-300 rounded-sm shadow-xl w-full max-w-lg p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        {" "}
        <div className="flex items-center justify-between">
          {" "}
          <h3 className="text-16 font-medium text-zinc-900">
            Draft with AI
          </h3>{" "}
          <button
            type="button"
            onClick={onClose}
            className="text-ink-tertiary hover:text-zinc-900 text-14"
          >
            ×
          </button>{" "}
        </div>{" "}
        <div>
          {" "}
          <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
            What's the newsletter about?
          </label>{" "}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            placeholder="e.g. Spring uptick in no-see-ums and what homeowners can do this week. Want to mention our mosquito service as a soft CTA."
          />{" "}
        </div>{" "}
        {" "}
        <div className="grid grid-cols-2 gap-3">
          {" "}
          <div>
            {" "}
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
              Audience
            </label>{" "}
            <input
              type="text"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />{" "}
          </div>{" "}
          <div>
            {" "}
            <label className="block text-11 uppercase tracking-label text-ink-secondary mb-1">
              Tone
            </label>{" "}
            <input
              type="text"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            />{" "}
          </div>{" "}
        </div>{" "}
        <label className="inline-flex items-center gap-2 text-12 text-ink-secondary">
          {" "}
          <input
            type="checkbox"
            checked={includeCTA}
            onChange={(e) => setIncludeCTA(e.target.checked)}
          />
          Include a call to action at the end
        </label>
        {err && <div className="text-12 text-alert-fg">{err}</div>}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-hairline border-zinc-200">
          {" "}
          <Button onClick={onClose} variant="secondary" disabled={loading}>
            Cancel
          </Button>{" "}
          <Button onClick={run} disabled={loading}>
            {loading ? "Drafting…" : "Draft it"}
          </Button>{" "}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

// ── History ────────────────────────────────────────────────────────

export function HistoryView() {
  const [sends, setSends] = useState([]);
  const [aggregate, setAggregate] = useState(null);
  const [loading, setLoading] = useState(true);
  // Per-send variant breakdown (a vs b counts) — fetched lazily when the
  // operator expands an A/B row, then cached.
  const [variantStats, setVariantStats] = useState({});
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    adminFetch("/admin/newsletter/sends")
      .then((d) => {
        setSends(d.sends || []);
        setAggregate(d.aggregate || null);
      })
      .catch(() => {
        setSends([]);
        setAggregate(null);
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const cancelSchedule = async (id) => {
    if (!confirm("Cancel this scheduled send and return it to draft?")) return;
    try {
      await adminFetch(`/admin/newsletter/sends/${id}/cancel-schedule`, {
        method: "POST",
      });
      load();
    } catch (e) {
      alert("Cancel failed: " + e.message);
    }
  };

  // Toggle the A/B breakdown panel. First open lazy-loads /sends/:id (the
  // detail endpoint includes variantStats); subsequent toggles read from
  // the cache.
  const toggleVariants = async (id) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (variantStats[id]) return;
    try {
      const d = await adminFetch(`/admin/newsletter/sends/${id}`);
      if (d.variantStats) {
        setVariantStats((prev) => ({ ...prev, [id]: d.variantStats }));
      }
    } catch {
      /* surfaces as 'no breakdown available' below */
    }
  };

  return (
    <Card className="p-0 overflow-hidden">
      {" "}
      <div className="flex items-center justify-between p-4 border-b border-hairline border-zinc-200 flex-wrap gap-2">
        {" "}
        <div>
          {" "}
          <h3 className="text-16 font-medium text-zinc-900">Past sends</h3>{" "}
          <p className="text-12 text-ink-tertiary mt-0.5">
            Delivery health, scheduling, and subject-line results.
          </p>{" "}
        </div>{" "}
        <span className="text-11 text-ink-tertiary u-nums">
          {sends.length} campaign{sends.length === 1 ? "" : "s"}
        </span>{" "}
      </div>
      {aggregate && aggregate.campaignCount > 0 && (
        <div className="border-b border-hairline border-zinc-200">
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-px bg-zinc-200">
            <AggStat label="Delivery" value={pctLabel(aggregate.rates.deliveryRate)} />
            <AggStat label="Open" value={pctLabel(aggregate.rates.openRate)} />
            <AggStat label="Click" value={pctLabel(aggregate.rates.clickRate)} />
            <AggStat
              label="Bounce"
              value={pctLabel(aggregate.rates.bounceRate)}
              alert={aggregate.rates.bounceRate > 0.02}
            />
            <AggStat label="Unsub" value={pctLabel(aggregate.rates.unsubscribeRate)} />
            <AggStat
              label="Complaint"
              value={pctLabel(aggregate.rates.complaintRate)}
              alert={aggregate.rates.complaintRate > 0.001}
            />
          </div>
          <p className="text-11 text-ink-tertiary px-4 py-1.5 u-nums">
            Pooled across {aggregate.campaignCount} sent campaign
            {aggregate.campaignCount === 1 ? "" : "s"} · open/click over delivered, bounce over recipients
          </p>
        </div>
      )}
      {loading ? (
        <div className="text-13 text-ink-secondary p-6 text-center">
          Loading…
        </div>
      ) : sends.length === 0 ? (
        <div className="text-13 text-ink-secondary p-8 text-center">
          No campaigns yet. Compose your first newsletter in the Compose tab.
        </div>
      ) : (
        <div className="space-y-0">
          {sends.map((s) => {
            const pct = s.recipient_count
              ? Math.round((s.delivered_count / s.recipient_count) * 100)
              : 0;
            const isAb = !!s.subject_b;
            const isOpen = expandedId === s.id;
            return (
              <div
                key={s.id}
                className="border-b border-hairline border-zinc-200"
              >
                {" "}
                <div className="px-4 py-3 flex flex-col lg:flex-row lg:items-start gap-3 lg:gap-4">
                  {" "}
                  <div className="flex-1 min-w-0">
                    {" "}
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {" "}
                      <span className="text-14 font-medium text-zinc-900 truncate">
                        {s.subject}
                      </span>
                      {isAb && (
                        <button
                          type="button"
                          onClick={() => toggleVariants(s.id)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-zinc-100 text-11 font-medium text-zinc-700 hover:bg-zinc-200 u-focus-ring"
                          title={
                            isOpen ? "Hide A/B breakdown" : "Show A/B breakdown"
                          }
                        >
                          A/B {isOpen ? "▾" : "▸"}
                        </button>
                      )}
                      {s.segment_filter && (
                        <Badge tone="muted">Segmented</Badge>
                      )}
                      <StatusChip status={s.status} />{" "}
                    </div>{" "}
                    <div className="text-11 text-ink-tertiary">
                      {s.created_by_name || "Admin"} ·{" "}
                      {s.status === "scheduled" && s.scheduled_for
                        ? `scheduled for ${new Date(s.scheduled_for).toLocaleString()}`
                        : s.sent_at
                          ? new Date(s.sent_at).toLocaleString()
                          : "draft (not sent)"}
                    </div>
                    {isAb && (
                      <div className="text-11 text-ink-tertiary mt-0.5 truncate">
                        B: {s.subject_b}
                      </div>
                    )}
                  </div>{" "}
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:flex lg:items-center gap-3 lg:gap-5 text-12 flex-shrink-0">
                    {s.status === "scheduled" ? (
                      <button
                        type="button"
                        onClick={() => cancelSchedule(s.id)}
                        className="text-11 px-2 py-1 border-hairline border-zinc-300 rounded-sm text-ink-secondary hover:text-zinc-900 hover:border-zinc-900 u-focus-ring"
                      >
                        Cancel schedule
                      </button>
                    ) : (
                      <>
                        {" "}
                        <Stat
                          label="Sent"
                          value={s.recipient_count || 0}
                        />{" "}
                        <Stat
                          label="Delivered"
                          value={`${s.delivered_count || 0} (${pct}%)`}
                        />{" "}
                        <Stat label="Open" value={pctLabel(s.rates?.openRate)} />{" "}
                        <Stat label="Click" value={pctLabel(s.rates?.clickRate)} />{" "}
                        <Stat
                          label="Bounced"
                          value={s.bounced_count || 0}
                          alert={s.bounced_count > 0}
                        />{" "}
                        <Stat
                          label="Unsub"
                          value={s.unsubscribed_count || 0}
                        />{" "}
                      </>
                    )}
                  </div>{" "}
                </div>
                {isAb && isOpen && (
                  <VariantBreakdown
                    stats={variantStats[s.id]}
                    subjectA={s.subject}
                    subjectB={s.subject_b}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ── A/B variant breakdown ────────────────────────────────────────────
//
// Per-variant counts pulled from /sends/:id (server aggregates the
// deliveries table grouped by ab_variant). "Winner" is whichever variant
// has the higher open rate among delivered messages — same heuristic
// most ESPs use; falls back to no-winner when both rates are within
// half a percentage point.

function VariantBreakdown({ stats, subjectA, subjectB }) {
  if (!stats) {
    return (
      <div className="px-5 pb-3 -mt-2 text-11 text-ink-tertiary">
        Loading variant breakdown…
      </div>
    );
  }
  const a = stats.a;
  const b = stats.b;
  if (!a && !b) {
    return (
      <div className="px-5 pb-3 -mt-2 text-11 text-ink-tertiary">
        No A/B delivery rows yet — open rates appear once SendGrid events
        arrive.
      </div>
    );
  }
  const openRate = (v) => (v && v.delivered ? v.opened / v.delivered : null);
  const aRate = openRate(a);
  const bRate = openRate(b);
  let winner = null;
  if (aRate != null && bRate != null && Math.abs(aRate - bRate) >= 0.005) {
    winner = aRate > bRate ? "a" : "b";
  }

  return (
    <div className="px-5 pb-4 -mt-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
      {" "}
      <VariantCell
        letter="A"
        subject={subjectA}
        stats={a}
        rate={aRate}
        isWinner={winner === "a"}
      />{" "}
      <VariantCell
        letter="B"
        subject={subjectB}
        stats={b}
        rate={bRate}
        isWinner={winner === "b"}
      />{" "}
    </div>
  );
}

function VariantCell({ letter, subject, stats, rate, isWinner }) {
  return (
    <div
      className={cn(
        "border-hairline rounded-sm p-3 bg-white",
        isWinner ? "border-zinc-900" : "border-zinc-200",
      )}
    >
      {" "}
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        {" "}
        <span className="text-11 uppercase tracking-label text-ink-secondary">
          Variant {letter}
        </span>
        {isWinner && <Badge tone="strong">Winner</Badge>}
      </div>{" "}
      <div className="text-12 text-zinc-900 mb-2 truncate" title={subject}>
        {subject || <em className="text-ink-tertiary">(missing)</em>}
      </div>
      {!stats ? (
        <div className="text-11 text-ink-tertiary">No deliveries recorded.</div>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {" "}
          <Stat label="Sent" value={stats.total} />{" "}
          <Stat label="Delivered" value={stats.delivered} />{" "}
          <Stat
            label="Opens"
            value={`${stats.opened}${rate != null ? ` (${(rate * 100).toFixed(0)}%)` : ""}`}
          />{" "}
          <Stat label="Clicks" value={stats.clicked} />{" "}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }) {
  if (status === "sent") return <Badge tone="strong">Sent</Badge>;
  if (status === "sending") return <Badge tone="neutral">Sending…</Badge>;
  if (status === "scheduled") return <Badge tone="neutral">Scheduled</Badge>;
  if (status === "failed") return <Badge tone="alert">Failed</Badge>;
  return <Badge tone="muted">Draft</Badge>;
}

function Stat({ label, value, alert }) {
  return (
    <div className="text-right">
      {" "}
      <div
        className={cn(
          "u-nums font-medium",
          alert ? "text-alert-fg" : "text-zinc-900",
        )}
      >
        {value}
      </div>{" "}
      <div className="text-11 text-ink-tertiary">{label}</div>{" "}
    </div>
  );
}

// Render a rate fraction (0..1) as a percentage, or "—" when null/undefined
// (zero-denominator) so an unmeasured rate isn't shown as a misleading 0%.
function pctLabel(rate) {
  if (rate === null || rate === undefined) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

// Centered tile for the History aggregate summary strip.
function AggStat({ label, value, alert }) {
  return (
    <div className="bg-white px-3 py-2 text-center">
      <div
        className={cn(
          "u-nums text-16 font-medium",
          alert ? "text-alert-fg" : "text-zinc-900",
        )}
      >
        {value}
      </div>
      <div className="text-11 text-ink-tertiary">{label}</div>
    </div>
  );
}

// ── Subscribers ───────────────────────────────────────────────────

const SUBSCRIBERS_PAGE_SIZE = 100;

export function SubscribersView() {
  const [subs, setSubs] = useState([]);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState("active");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");

  // Initial / filter-changed fetch — resets the list. Re-runs whenever
  // the filter or search query changes (via the useEffect below).
  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filter !== "all") qs.set("status", filter);
    if (q) qs.set("q", q);
    qs.set("limit", String(SUBSCRIBERS_PAGE_SIZE));
    qs.set("offset", "0");
    adminFetch(`/admin/newsletter/subscribers?${qs}`)
      .then((d) => {
        const next = d.subscribers || [];
        setSubs(next);
        setCounts(d.counts || {});
        setOffset(next.length);
        setHasMore(next.length === SUBSCRIBERS_PAGE_SIZE);
      })
      .catch(() => {
        setSubs([]);
        setHasMore(false);
      })
      .finally(() => setLoading(false));
  }, [filter, q]);
  useEffect(() => {
    load();
  }, [load]);

  const loadMore = async () => {
    setLoadingMore(true);
    const qs = new URLSearchParams();
    if (filter !== "all") qs.set("status", filter);
    if (q) qs.set("q", q);
    qs.set("limit", String(SUBSCRIBERS_PAGE_SIZE));
    qs.set("offset", String(offset));
    try {
      const d = await adminFetch(`/admin/newsletter/subscribers?${qs}`);
      const next = d.subscribers || [];
      setSubs((prev) => [...prev, ...next]);
      setOffset((cur) => cur + next.length);
      setHasMore(next.length === SUBSCRIBERS_PAGE_SIZE);
    } catch (e) {
      setStatus("Load more failed: " + e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = async () => {
    setStatus("Building CSV…");
    try {
      const qs = new URLSearchParams();
      if (filter !== "all") qs.set("status", filter);
      if (q) qs.set("q", q);
      // Bypass adminFetch's JSON parsing — this returns text/csv.
      const res = await fetch(
        `${API_BASE}/admin/newsletter/subscribers.csv?${qs}`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("CSV downloaded.");
    } catch (e) {
      setStatus("Export failed: " + e.message);
    }
  };

  const addSubscriber = async () => {
    const email = prompt("Email address to add:");
    if (!email) return;
    setStatus("Adding...");
    try {
      await adminFetch("/admin/newsletter/subscribers", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setStatus(`Added ${email}.`);
      load();
    } catch (e) {
      setStatus("Failed: " + e.message);
    }
  };

  const removeSubscriber = async (id, email) => {
    if (!confirm(`Unsubscribe ${email}?`)) return;
    try {
      await adminFetch(`/admin/newsletter/subscribers/${id}`, {
        method: "DELETE",
      });
      load();
    } catch (e) {
      alert("Failed: " + e.message);
    }
  };

  return (
    <Card className="p-0 overflow-hidden">
      {" "}
      <div className="flex items-start justify-between p-4 border-b border-hairline border-zinc-200 flex-wrap gap-3">
        {" "}
        <div>
          {" "}
          <h3 className="text-16 font-medium text-zinc-900">
            Subscribers
          </h3>{" "}
          <p className="text-12 text-ink-tertiary mt-0.5">
            Search the list, export filtered contacts, and manage opt-outs.
          </p>{" "}
        </div>{" "}
        <div className="flex items-center gap-2 flex-wrap">
          {" "}
          <Button onClick={exportCsv} variant="secondary">
            {" "}
            <Download
              size={14}
              strokeWidth={1.75}
              className="mr-2"
              aria-hidden
            />
            Export CSV
          </Button>{" "}
          <Button onClick={addSubscriber} variant="secondary">
            {" "}
            <UserPlus
              size={14}
              strokeWidth={1.75}
              className="mr-2"
              aria-hidden
            />
            Add Subscriber
          </Button>{" "}
        </div>{" "}
      </div>{" "}
      <div className="p-4 border-b border-hairline border-zinc-100 flex items-center gap-2 flex-wrap">
        {["active", "unsubscribed", "bounced", "all"].map((f) => {
          const active = filter === f;
          const count =
            f === "all"
              ? (counts.all ??
                Object.entries(counts)
                  .filter(([key]) => !["all", "bounced"].includes(key))
                  .reduce((sum, [, value]) => sum + Number(value || 0), 0))
              : counts[f] || 0;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-12 font-medium border-hairline u-focus-ring",
                active
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-ink-secondary border-zinc-300 hover:border-zinc-900",
              )}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              <span
                className={cn(
                  "u-nums text-11",
                  active ? "text-zinc-300" : "text-ink-tertiary",
                )}
              >
                {count}
              </span>{" "}
            </button>
          );
        })}
        <div className="relative w-full sm:w-72 sm:ml-auto">
          {" "}
          <Search
            size={14}
            strokeWidth={1.75}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary"
            aria-hidden
          />{" "}
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search email…"
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 pl-8 pr-2 text-12 text-zinc-900"
          />{" "}
        </div>{" "}
      </div>
      {status && (
        <div className="mx-4 mt-3 bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-3 text-12 text-ink-secondary">
          {status}
        </div>
      )}
      {loading ? (
        <div className="text-13 text-ink-secondary p-6 text-center">
          Loading…
        </div>
      ) : subs.length === 0 ? (
        <div className="text-13 text-ink-secondary p-8 text-center">
          No subscribers in this filter.
        </div>
      ) : (
        <div>
          {subs.map((s) => (
            <div
              key={s.id}
              className="px-4 py-3 border-b border-hairline border-zinc-200 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4"
            >
              {" "}
              <div className="flex-1 min-w-0">
                {" "}
                <div className="flex items-center gap-2">
                  {" "}
                  <span className="text-13 text-zinc-900 font-mono truncate">
                    {s.email}
                  </span>
                  {s.status === "unsubscribed" && (
                    <Badge tone="muted">Unsubscribed</Badge>
                  )}
                  {s.status === "bounced" && (
                    <Badge tone="alert">Bounced</Badge>
                  )}
                  {s.customer_id && <Badge tone="muted">Customer</Badge>}
                </div>{" "}
                <div className="text-11 text-ink-tertiary">
                  {s.first_name || s.last_name
                    ? `${s.first_name || ""} ${s.last_name || ""}`.trim() +
                      " · "
                    : ""}
                  Source: {s.source || "unknown"} · Joined{" "}
                  {new Date(s.subscribed_at).toLocaleDateString()}
                  {s.bounce_count > 0 &&
                    ` · ${s.bounce_count} bounce${s.bounce_count === 1 ? "" : "s"}`}
                </div>{" "}
              </div>
              {s.status === "active" && (
                <button
                  type="button"
                  onClick={() => removeSubscriber(s.id, s.email)}
                  className="text-11 px-2 py-1 border-hairline border-zinc-300 rounded-sm text-ink-secondary hover:text-zinc-900 hover:border-zinc-900 u-focus-ring self-start sm:self-center"
                >
                  Unsubscribe
                </button>
              )}
            </div>
          ))}
          {hasMore && (
            <div className="px-5 py-4 text-center">
              {" "}
              <Button
                onClick={loadMore}
                variant="secondary"
                disabled={loadingMore}
              >
                {loadingMore
                  ? "Loading…"
                  : `Load ${SUBSCRIBERS_PAGE_SIZE} more`}
              </Button>{" "}
            </div>
          )}
          {!hasMore && subs.length > SUBSCRIBERS_PAGE_SIZE && (
            <div className="px-5 py-4 text-center text-11 text-ink-tertiary">
              Showing all {subs.length} subscriber{subs.length === 1 ? "" : "s"}{" "}
              in this filter.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
