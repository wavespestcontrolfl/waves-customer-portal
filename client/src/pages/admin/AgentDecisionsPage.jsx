import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, ClipboardList, Edit3, MessageSquare, PhoneCall, RefreshCw, Save, ShieldAlert, UserRound, XCircle } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field as FormField,
  Input,
  Textarea,
  UiSurface,
} from "../../components/ui";
import { adminFetch } from "../../utils/admin-fetch";

const STATUSES = ["pending_review", "accepted", "corrected", "dismissed", "all"];

function Chip({ children, tone = "neutral" }) {
  return <Badge tone={tone === "red" ? "alert" : "neutral"}>{children}</Badge>;
}

function statusLabel(value) {
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function actionLabel(value) {
  return String(value || "").replace(/_/g, " ");
}

function confidence(value) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(Number(value) * 100)}%`;
}

function percent(value) {
  const number = Number(value || 0);
  return `${Math.round(number * 100)}%`;
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : "-";
}

function timeLabel(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function TextList({ items = [], empty = "-" }) {
  if (!items.length) return <span className="text-ink-secondary">{empty}</span>;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => <Chip key={item}>{actionLabel(item)}</Chip>)}
    </div>
  );
}

function DetailField({ label, value }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="min-w-0">
      <div className="text-14 font-medium text-ink-secondary">{label}</div>
      <div className="break-words text-ui-body text-zinc-800">{String(value)}</div>
    </div>
  );
}

function Panel({ icon: Icon, title, children }) {
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2 text-14 font-medium text-zinc-900">
        {Icon && <Icon size={16} aria-hidden />}
        {title}
      </div>
      {children}
    </Card>
  );
}

export default function AgentDecisionsPage({ embedded = false } = {}) {
  const [status, setStatus] = useState("pending_review");
  const [data, setData] = useState({ decisions: [], metrics: null });
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [correctionNote, setCorrectionNote] = useState("");
  const [correctedActions, setCorrectedActions] = useState("");
  const [idealReply, setIdealReply] = useState("");
  const [actualReply, setActualReply] = useState("");
  const [replyReviewNote, setReplyReviewNote] = useState("");
  const [replyScenarioLabel, setReplyScenarioLabel] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminFetch(`/admin/agent-decisions?status=${encodeURIComponent(status)}&limit=100`);
      setData(next);
      setSelectedId((current) => (
        next.decisions?.some((d) => d.id === current) ? current : next.decisions?.[0]?.id || null
      ));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = useMemo(
    () => data.decisions?.find((d) => d.id === selectedId) || data.decisions?.[0] || null,
    [data.decisions, selectedId]
  );

  useEffect(() => {
    setCorrectionNote("");
    setCorrectedActions(selected?.recommendedActions?.join("\n") || "");
  }, [selected?.id]);

  useEffect(() => {
    if (!selected?.id) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    adminFetch(`/admin/agent-decisions/${selected.id}/context`)
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((err) => {
        if (!cancelled) setDetail({ error: err.message });
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [selected?.id]);

  useEffect(() => {
    const training = detail?.replyTraining;
    const humanReply = detail?.context?.actualHumanReply?.body || "";
    setActualReply(training?.actualHumanReply || humanReply || "");
    setIdealReply(training?.outboundBody || selected?.suggestedMessage || humanReply || "");
    setReplyReviewNote(training?.reviewNote || "");
    setReplyScenarioLabel(training?.scenarioLabel || selected?.inputSnapshot?.reply_training_hint?.scenarioLabel || "");
  }, [detail?.replyTraining?.id, detail?.context?.actualHumanReply?.id, selected?.id, selected?.suggestedMessage]);

  const review = useCallback(async (decision, verdict) => {
    if (!decision) return;
    setBusyId(`${decision.id}:${verdict}`);
    setError("");
    setNotice("");
    try {
      const body = { verdict };
      if (verdict === "corrected") {
        body.correctedActions = correctedActions
          .split(/\n|,/)
          .map((item) => item.trim())
          .filter(Boolean);
        body.correctionNote = correctionNote;
      } else if (correctionNote.trim()) {
        body.correctionNote = correctionNote;
      }
      await adminFetch(`/admin/agent-decisions/${decision.id}/review`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setNotice(`Decision ${statusLabel(verdict).toLowerCase()}.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }, [correctedActions, correctionNote, load]);

  const saveReplyTraining = useCallback(async (decision, replyVerdict) => {
    if (!decision) return;
    setBusyId(`${decision.id}:reply:${replyVerdict}`);
    setError("");
    setNotice("");
    try {
      const finalReply = replyVerdict === "accepted"
        ? (idealReply.trim() || decision.suggestedMessage || "")
        : replyVerdict === "no_reply_needed"
          ? ""
          : idealReply;
      const next = await adminFetch(`/admin/agent-decisions/${decision.id}/reply-training`, {
        method: "POST",
        body: JSON.stringify({
          replyVerdict,
          finalReply,
          actualReply,
          reviewNote: replyReviewNote,
          scenarioLabel: replyScenarioLabel,
        }),
      });
      setDetail((current) => ({ ...(current || {}), replyTraining: next.replyTraining }));
      setNotice(`Reply training ${statusLabel(replyVerdict).toLowerCase()} saved.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }, [actualReply, idealReply, replyReviewNote, replyScenarioLabel]);

  const metrics = data.metrics || {};
  const replyMetrics = metrics.replyTraining || {};
  const replyVerdicts = replyMetrics.verdicts || {};
  const replyRates = replyMetrics.rates || {};

  return (
    <UiSurface density="comfortable" className="min-h-full space-y-5 text-zinc-800">
      {!embedded && (
        <AdminCommandHeader
          title="Agent review"
          subtitle="Shadow decisions from customer communication agents."
          icon={Bot}
        />
      )}

      <div className="space-y-5 min-w-0">
        {data.missingTable && (
          <ActionFeedback error>
            <ShieldAlert size={18} aria-hidden />
            Run the agent_decisions migration before review data can be recorded.
          </ActionFeedback>
        )}

        {error && <ActionFeedback error>{error}</ActionFeedback>}
        {notice && <ActionFeedback>{notice}</ActionFeedback>}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            ["Pending", metrics.pending || 0],
            ["Accepted", metrics.accepted || 0],
            ["Corrected", metrics.corrected || 0],
            ["Dismissed", metrics.dismissed || 0],
            ["Reply Examples", metrics.replyTraining?.reviewed || 0],
          ].map(([label, value]) => (
            <Card key={label} className="p-4">
              <div className="text-14 font-medium text-ink-secondary">{label}</div>
              <div className="text-28 font-medium text-zinc-900 u-nums">{value}</div>
            </Card>
          ))}
        </div>

        <div className="grid gap-3 xl:grid-cols-3 items-start">
          <Card><CardHeader><CardTitle>Reply quality</CardTitle></CardHeader><CardBody className="grid grid-cols-2 gap-2">
              {[
                ["Accept", replyVerdicts.accepted || 0, replyRates.accepted],
                ["Edit", replyVerdicts.edited || 0, replyRates.edited],
                ["Reject", replyVerdicts.rejected || 0, replyRates.rejected],
                ["No reply", replyVerdicts.noReplyNeeded || 0, replyRates.noReplyNeeded],
              ].map(([label, count, rate]) => (
                <Card key={label} className="p-3">
                  <div className="text-14 font-medium text-ink-secondary">{label}</div>
                  <div className="flex items-baseline gap-2 u-nums">
                    <strong className="text-22 font-medium text-zinc-900">{count}</strong>
                    <span className="text-ui-caption text-ink-secondary">{percent(rate)}</span>
                  </div>
                </Card>
              ))}
          </CardBody></Card>

          <Card><CardHeader><CardTitle>By workflow</CardTitle></CardHeader><CardBody>
            {replyMetrics.byWorkflow?.length ? (
              <div className="space-y-2">
                {replyMetrics.byWorkflow.map((row) => (
                  <div key={row.workflow} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 text-ui-body">
                    <div className="truncate font-medium text-zinc-900">{row.workflow}</div>
                    <span className="text-ink-secondary u-nums">{row.reviewed} reviewed</span>
                    <span className={`${row.rejectedRate > 0.15 ? "text-alert-fg" : "text-zinc-900"} font-medium u-nums`}>
                      {percent(row.acceptanceRate)} accept
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <ActionFeedback>No reviewed reply examples yet.</ActionFeedback>
            )}
          </CardBody></Card>

          <Card><CardHeader><CardTitle>Top scenarios</CardTitle></CardHeader><CardBody>
            {replyMetrics.byScenario?.length ? (
              <div className="flex flex-wrap gap-2">
                {replyMetrics.byScenario.map((row) => (
                  <Chip key={row.scenarioLabel}>{actionLabel(row.scenarioLabel)} · {row.count}</Chip>
                ))}
              </div>
            ) : (
              <ActionFeedback>No scenario labels yet.</ActionFeedback>
            )}
          </CardBody></Card>
        </div>

        {replyMetrics.recentRejected?.length ? (
          <Card><CardHeader><CardTitle>Recent rejected drafts</CardTitle></CardHeader><CardBody className="space-y-2">
              {replyMetrics.recentRejected.map((row) => (
                <div key={row.id} className="space-y-1 border-t border-hairline border-zinc-200 pt-2 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-center gap-2 text-ui-caption text-ink-secondary">
                    <Chip tone="red">Rejected</Chip>
                    <span>{row.customerName || "Unknown customer"}</span>
                    <span>{row.workflow}</span>
                    {row.scenarioLabel && <span>{actionLabel(row.scenarioLabel)}</span>}
                    <span>{timeLabel(row.reviewedAt)}</span>
                  </div>
                  <div className="text-ui-body text-zinc-800">{row.inboundBody || "-"}</div>
                  {row.reviewNote && <div className="text-ui-caption text-ink-secondary">{row.reviewNote}</div>}
                </div>
              ))}
          </CardBody></Card>
        ) : null}

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Decision status">
          {STATUSES.map((item) => (
            <Button
              key={item}
              type="button"
              onClick={() => setStatus(item)}
              variant={status === item ? "primary" : "secondary"}
              aria-pressed={status === item}
            >
              {statusLabel(item)}
            </Button>
          ))}
          <Button
            type="button"
            onClick={load}
            loading={loading}
            variant="secondary"
            className="sm:ml-auto"
          >
            <RefreshCw size={16} aria-hidden />
            Refresh
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(280px,380px)_minmax(0,1fr)] items-start">
          <Card className="overflow-hidden">
            {loading ? (
              <ActionFeedback className="m-4">Loading decisions...</ActionFeedback>
            ) : data.decisions?.length ? (
              data.decisions.map((decision) => (
                <button
                  key={decision.id}
                  type="button"
                  onClick={() => setSelectedId(decision.id)}
                  aria-pressed={selected?.id === decision.id}
                  className="block min-h-11 w-full border-0 border-b border-hairline border-zinc-200 bg-white p-4 text-left text-ui-body hover:bg-zinc-50 aria-pressed:bg-zinc-100 u-focus-ring"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <Badge tone="neutral">{statusLabel(decision.status)}</Badge>
                    <span className="ml-auto text-ui-caption text-ink-secondary u-nums">{timeLabel(decision.createdAt)}</span>
                  </div>
                  <div className="font-medium text-zinc-900">{decision.customerName || "Unknown customer"}</div>
                  <div className="mt-1 text-ui-caption text-ink-secondary">{statusLabel(decision.detectedIntent)} · {confidence(decision.confidence)}</div>
                  <div className="mt-2 text-ui-body text-zinc-800">
                    {decision.inboundMessage || "No message body"}
                  </div>
                </button>
              ))
            ) : (
              <ActionFeedback className="m-4">No decisions found.</ActionFeedback>
            )}
          </Card>

          <Card className="min-h-[480px]"><CardBody>
            {!selected ? (
              <ActionFeedback>Select a decision to review.</ActionFeedback>
            ) : (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{statusLabel(selected.status)}</Badge>
                  <Chip>{selected.mode}</Chip>
                  <Chip>{selected.workflow}</Chip>
                  <span className="ml-auto text-ui-caption text-ink-secondary u-nums">Decision {shortId(selected.id)}</span>
                </div>

                <section>
                  <h2 className="text-18 font-medium text-zinc-900">{selected.customerName || "Unknown customer"}</h2>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Chip>Intent: {statusLabel(selected.detectedIntent)}</Chip>
                    <Chip>Confidence: {confidence(selected.confidence)}</Chip>
                    {selected.estimateId && <Chip>Estimate {shortId(selected.estimateId)} · {selected.estimateStatus || "-"}</Chip>}
                    {selected.leadId && <Chip>Lead {shortId(selected.leadId)} · {selected.leadStatus || "-"}</Chip>}
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-14 font-medium text-zinc-900">Inbound message</h3>
                  <div className="rounded-md bg-zinc-50 p-3 text-ui-body">{selected.inboundMessage || "-"}</div>
                </section>

                <Panel icon={MessageSquare} title="Conversation context">
                  {detailLoading ? (
                    <ActionFeedback>Loading thread...</ActionFeedback>
                  ) : detail?.context?.smsThread?.length ? (
                    <div className="space-y-2">
                      {detail.context.smsThread.map((msg) => (
                        <div key={msg.id} className="space-y-1 rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3">
                          <div className="flex flex-wrap items-center gap-2 text-ui-caption text-ink-secondary">
                            <span>{msg.direction === "inbound" ? "Customer" : "Waves"}</span>
                            <span>{timeLabel(msg.createdAt)}</span>
                            {msg.type && <span>{msg.type}</span>}
                            {msg.isTrigger && <Chip tone="amber">Trigger</Chip>}
                          </div>
                          <div className="whitespace-pre-wrap text-ui-body">{msg.body || "-"}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <ActionFeedback>No recent SMS thread found.</ActionFeedback>
                  )}
                </Panel>

                <div className="grid gap-3 xl:grid-cols-2">
                  <Panel icon={UserRound} title="Customer / Lead / Estimate">
                    {detail?.error ? (
                      <ActionFeedback error>{detail.error}</ActionFeedback>
                    ) : (
                      <div className="grid grid-cols-2 gap-3">
                        <DetailField label="Customer" value={[detail?.context?.customer?.first_name, detail?.context?.customer?.last_name].filter(Boolean).join(" ") || selected.customerName} />
                        <DetailField label="Phone" value={detail?.context?.customer?.phone || selected.customerPhone || selected.sourceFromPhone} />
                        <DetailField label="Address" value={detail?.context?.customer?.address_line1 || detail?.context?.estimate?.address} />
                        <DetailField label="City" value={detail?.context?.customer?.city} />
                        <DetailField label="WaveGuard" value={detail?.context?.customer?.waveguard_tier || detail?.context?.estimate?.waveguard_tier} />
                        <DetailField label="Lead status" value={detail?.context?.lead?.status || selected.leadStatus} />
                        <DetailField label="Estimate status" value={detail?.context?.estimate?.status || selected.estimateStatus} />
                        <DetailField label="Service interest" value={detail?.context?.lead?.service_interest || detail?.context?.estimate?.service_interest} />
                      </div>
                    )}
                  </Panel>

                  <Panel icon={PhoneCall} title="Recent calls">
                    {detailLoading ? (
                      <ActionFeedback>Loading calls...</ActionFeedback>
                    ) : detail?.context?.calls?.length ? (
                      <div className="space-y-2">
                        {detail.context.calls.map((call) => (
                          <div key={call.id} className="space-y-1 border-b border-hairline border-zinc-200 pb-2 last:border-b-0">
                            <div className="flex flex-wrap gap-2 text-ui-caption text-ink-secondary">
                              <span>{call.direction || "call"}</span>
                              <span>{timeLabel(call.createdAt)}</span>
                              {call.outcome && <span>{call.outcome}</span>}
                            </div>
                            <div className="text-ui-body">{call.synopsis || call.transcription || call.notes || "-"}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <ActionFeedback>No recent calls found.</ActionFeedback>
                    )}
                  </Panel>
                </div>

                <Panel icon={ClipboardList} title="Recent service context">
                  {detailLoading ? (
                    <ActionFeedback>Loading services...</ActionFeedback>
                  ) : detail?.context?.services?.length ? (
                    <div className="space-y-2">
                      {detail.context.services.map((service) => (
                        <div key={service.id} className="space-y-1 border-b border-hairline border-zinc-200 pb-2 last:border-b-0">
                          <div className="flex flex-wrap gap-2 text-ui-caption text-ink-secondary">
                            <span>{service.serviceType}</span>
                            <span>{service.serviceDate || timeLabel(service.createdAt)}</span>
                            <span>{service.status}</span>
                          </div>
                          <div className="text-ui-body">{service.technicianNotes || "-"}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <ActionFeedback>No recent service records found.</ActionFeedback>
                  )}
                </Panel>

                <section className="space-y-2">
                  <h3 className="text-14 font-medium text-zinc-900">Suggested reply</h3>
                  <div className="rounded-md bg-zinc-50 p-3 text-ui-body">{selected.suggestedMessage || "-"}</div>
                </section>

                <Panel icon={MessageSquare} title="Reply training">
                  <div className="space-y-3">
                    {detail?.replyTraining && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip>Saved</Chip>
                        {detail.replyTraining.replyVerdict && <Chip tone={detail.replyTraining.replyVerdict === "rejected" ? "red" : "neutral"}>{statusLabel(detail.replyTraining.replyVerdict)}</Chip>}
                        {detail.replyTraining.scenarioLabel && <Chip>{actionLabel(detail.replyTraining.scenarioLabel)}</Chip>}
                        <span className="text-ui-caption text-ink-secondary">
                          {detail.replyTraining.reviewedBy ? `Reviewed by ${detail.replyTraining.reviewedBy}` : "Reviewed"}
                          {detail.replyTraining.reviewedAt ? ` · ${timeLabel(detail.replyTraining.reviewedAt)}` : ""}
                        </span>
                      </div>
                    )}
                    <div className="grid gap-3 xl:grid-cols-2">
                      <FormField label="Actual human reply">
                        <Textarea
                          value={actualReply}
                          onChange={(event) => setActualReply(event.target.value)}
                          rows={5}
                          placeholder="If you replied, paste or adjust the actual reply here."
                        />
                      </FormField>
                      <FormField label="Final / rewrite reply">
                        <Textarea
                          value={idealReply}
                          onChange={(event) => setIdealReply(event.target.value)}
                          rows={5}
                          placeholder="Accepted draft, edited version, or your replacement reply."
                        />
                      </FormField>
                    </div>
                    <div className="grid gap-3 xl:grid-cols-[minmax(180px,260px)_1fr]">
                      <FormField label="Scenario label">
                      <Input
                        value={replyScenarioLabel}
                        onChange={(event) => setReplyScenarioLabel(event.target.value)}
                        placeholder="scenario, e.g. scheduling"
                      />
                      </FormField>
                      <FormField label="Review note">
                      <Input
                        value={replyReviewNote}
                        onChange={(event) => setReplyReviewNote(event.target.value)}
                        placeholder="What should the agent learn from this reply?"
                      />
                      </FormField>
                    </div>
                    <div className="ui-record-actions justify-end">
                      <Button
                        type="button"
                        disabled={!!busyId || !(idealReply.trim() || selected.suggestedMessage)}
                        onClick={() => saveReplyTraining(selected, "accepted")}
                        variant="secondary"
                        loading={busyId === `${selected.id}:reply:accepted`}
                      >
                        <CheckCircle2 size={16} aria-hidden /> Accept draft
                      </Button>
                      <Button
                        type="button"
                        disabled={!!busyId || !idealReply.trim()}
                        onClick={() => saveReplyTraining(selected, "edited")}
                        variant="secondary"
                        loading={busyId === `${selected.id}:reply:edited`}
                      >
                        <Edit3 size={16} aria-hidden /> Edit & save
                      </Button>
                      <Button
                        type="button"
                        disabled={!!busyId || !idealReply.trim()}
                        onClick={() => saveReplyTraining(selected, "rejected")}
                        variant="danger"
                        loading={busyId === `${selected.id}:reply:rejected`}
                      >
                        <XCircle size={16} aria-hidden /> Reject & rewrite
                      </Button>
                      <Button
                        type="button"
                        disabled={!!busyId}
                        onClick={() => saveReplyTraining(selected, "no_reply_needed")}
                        variant="secondary"
                        loading={busyId === `${selected.id}:reply:no_reply_needed`}
                      >
                        <Save size={16} aria-hidden /> No reply needed
                      </Button>
                    </div>
                  </div>
                </Panel>

                <div className="grid gap-3 sm:grid-cols-2">
                  <section className="space-y-2">
                    <h3 className="text-14 font-medium text-zinc-900">Recommended actions</h3>
                    <TextList items={selected.recommendedActions} />
                  </section>
                  <section className="space-y-2">
                    <h3 className="text-14 font-medium text-zinc-900">Allowed in future</h3>
                    <TextList items={selected.autoActionsAllowed} />
                  </section>
                  <section className="space-y-2">
                    <h3 className="text-14 font-medium text-zinc-900">Blocked actions</h3>
                    <TextList items={selected.blockedActions} />
                  </section>
                  <section className="space-y-2">
                    <h3 className="text-14 font-medium text-zinc-900">Safety flags</h3>
                    <TextList items={selected.safetyFlags} />
                  </section>
                </div>

                <section className="space-y-2">
                  <h3 className="text-14 font-medium text-zinc-900">Reasoning</h3>
                  <div className="text-ui-body text-zinc-800">{selected.reasoningSummary || "-"}</div>
                </section>

                <section className="space-y-3 border-t border-hairline border-zinc-200 pt-4">
                  <h3 className="text-14 font-medium text-zinc-900">Correction</h3>
                  <FormField label="Corrected actions">
                  <Textarea
                    value={correctedActions}
                    onChange={(event) => setCorrectedActions(event.target.value)}
                    rows={4}
                  />
                  </FormField>
                  <FormField label="Review reason">
                  <Textarea
                    value={correctionNote}
                    onChange={(event) => setCorrectionNote(event.target.value)}
                    rows={3}
                    placeholder="Why was this accepted, corrected, or dismissed?"
                  />
                  </FormField>
                  <div className="ui-record-actions">
                    <Button type="button" disabled={!!busyId} loading={busyId === `${selected.id}:accepted`} onClick={() => review(selected, "accepted")}>
                      <CheckCircle2 size={16} aria-hidden /> Accept
                    </Button>
                    <Button type="button" disabled={!!busyId} loading={busyId === `${selected.id}:corrected`} onClick={() => review(selected, "corrected")} variant="secondary">
                      <Edit3 size={16} aria-hidden /> Correct
                    </Button>
                    <Button type="button" disabled={!!busyId} loading={busyId === `${selected.id}:dismissed`} onClick={() => review(selected, "dismissed")} variant="danger">
                      <XCircle size={16} aria-hidden /> Dismiss
                    </Button>
                  </div>
                </section>
              </div>
            )}
          </CardBody></Card>
        </div>
      </div>
    </UiSurface>
  );
}
