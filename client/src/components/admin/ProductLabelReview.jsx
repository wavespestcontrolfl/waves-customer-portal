import { useEffect, useState } from "react";
import { ExternalLink, FileText } from "lucide-react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  UiSurface,
  buttonStyles,
} from "../ui";

const FIELD_LABELS = {
  minTempF: ["Minimum temperature", "°F"],
  maxTempF: ["Maximum temperature", "°F"],
  maxWindMph: ["Maximum wind", "mph"],
  rainFreeHours: ["Rain-free interval", "hours"],
};

// Per-kind copy and route. The review flow (read, source check, approve,
// reject, revoke) is the same for weather limits and application rates.
const KINDS = {
  weather: {
    path: "label-review",
    ariaLabel: "Label weather review",
    title: "Label weather evidence",
    intro:
      "Read the EPA label, check the source pages, then approve weather facts for the Job Card. This review does not verify mixing rates.",
    current: "Current weather review",
    approve: "Approve weather facts",
    revoke: "Revoke weather review",
    confirm:
      "I matched the exact product and formulation and checked each fact against the source pages. Conditional and missing limits remain unresolved.",
    saved: "Review saved. Reopen the Job Card to use the current evidence.",
    footer:
      "No numeric limit in the source is not a clearance to apply. Missing and conditional evidence can still produce UNKNOWN.",
  },
  rates: {
    path: "label-rate-review",
    ariaLabel: "Label rate review",
    title: "Label rate evidence",
    intro:
      "Read the EPA label, check each quoted rate passage against its source page, then approve. Approved passages are stored as label evidence; they do not change catalog rates, protocols or pricing.",
    current: "Current rate review",
    approve: "Approve rate lines",
    revoke: "Revoke rate review",
    confirm:
      "I matched the exact product and formulation and checked every quoted passage, its site and its pests against the source pages.",
    saved: "Review saved.",
    footer:
      "Each line is the label's own passage. Nothing here is a computed or converted amount.",
  },
};

async function request(productId, path, action = "", body) {
  const response = await fetch(`${import.meta.env.VITE_API_URL || "/api"}/admin/inventory/${productId}/${path}${action}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Label review could not be loaded.");
  return data;
}

function EvidenceCard({ label, value, strong, quote, note, page, sourceUrl, children }) {
  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap justify-between gap-2">
          <span>{label}</span>
          <Badge tone={strong ? "strong" : "neutral"}>{value}</Badge>
        </div>
        {children}
        {quote && (
          <blockquote className="mx-0 my-3 border-0 border-l-2 border-solid border-zinc-200 pl-3 text-ui-body text-ink-secondary">
            {quote}
          </blockquote>
        )}
        {note && (
          <p className="my-2 text-ui-body text-ink-secondary">{note}</p>
        )}
        {page && (
          <a
            href={`${sourceUrl}#page=${page}`}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonStyles({
              variant: "ghost",
              density: "comfortable",
              className: "px-0",
            })}
          >
            Source page {page}
          </a>
        )}
      </CardBody>
    </Card>
  );
}

function Evidence({ entry, kind }) {
  return (
    <div className="grid gap-3">
      <div className="rounded-sm bg-zinc-50 p-3">
        <div className="text-ui-body text-zinc-900">
          {entry.source.productName} · EPA {entry.source.registration}
        </div>
        <div className="mt-1 text-ui-caption text-ink-secondary">
          Label accepted {entry.source.acceptedDate || "date unavailable"}
        </div>
        <a
          href={entry.source.url}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonStyles({
            variant: "ghost",
            density: "comfortable",
            className: "mt-1 px-0",
          })}
        >
          Open source PDF <ExternalLink size={15} aria-hidden />
        </a>
      </div>
      {kind === "rates"
        ? (entry.facts.directions || []).map((direction, index) => (
            <EvidenceCard
              key={index}
              label={direction.useSite}
              value="LABEL PASSAGE"
              quote={direction.quote}
              page={direction.page}
              sourceUrl={entry.source.url}
            >
              <p className="my-2 text-ui-caption text-ink-secondary">
                {[
                  direction.targets,
                  direction.method,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </EvidenceCard>
          ))
        : Object.entries(FIELD_LABELS).map(([key, [label, unit]]) => {
            const fact = entry.facts[key];
            const value =
              fact.status === "limit"
                ? `${fact.value} ${unit}`
                : fact.status === "conditional"
                  ? "CONDITIONAL"
                  : "NOT STATED";
            return (
              <EvidenceCard
                key={key}
                label={label}
                value={value}
                strong={fact.status === "limit"}
                quote={fact.quote}
                note={fact.note}
                page={fact.page}
                sourceUrl={entry.source.url}
              />
            );
          })}
    </div>
  );
}

export default function ProductLabelReview({ product, kind = "weather" }) {
  const copy = KINDS[kind];
  const [review, setReview] = useState(null);
  const [activeCurrent, setActiveCurrent] = useState(false);
  const [activeReason, setActiveReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setConfirmed(false);
    setError("");
    setNotice("");
    request(product.id, copy.path)
      .then((data) => {
        if (!cancelled) {
          setReview(data.review);
          setActiveCurrent(data.activeCurrent === true);
          setActiveReason(data.activeReason || "");
        }
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [product, copy.path]);

  async function act(action, body) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(product.id, copy.path, action, body);
      const data = await request(product.id, copy.path);
      setReview(data.review);
      setActiveCurrent(data.activeCurrent === true);
      setActiveReason(data.activeReason || "");
      setConfirmed(false);
      setNotice(
        action === "/extract"
          ? "Candidate ready for source review."
          : copy.saved,
      );
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  const draft = review?.draft;
  const active = review?.active;
  const disabled = busy || loading;

  return (
    <UiSurface
      as="section"
      density="comfortable"
      aria-label={copy.ariaLabel}
      className="my-4 max-w-[calc(100vw-64px)]"
    >
      <Card className="overflow-hidden">
        <CardBody className="space-y-4 break-words [overflow-wrap:anywhere]">
          <div>
            <h3 className="m-0 flex items-center gap-2 text-18 font-medium text-zinc-900">
              <FileText size={18} aria-hidden /> {copy.title}
            </h3>
            <p className="mt-2 mb-3 text-ui-body text-ink-secondary">
              {copy.intro}
            </p>
          </div>
          {loading && <ActionFeedback>Loading label review…</ActionFeedback>}
          {error && <ActionFeedback error>{error}</ActionFeedback>}
          {notice && <ActionFeedback>{notice}</ActionFeedback>}
          {active && (
            <details className="border-0 border-b border-solid border-zinc-200 pb-3">
              <summary className="box-border min-h-11 cursor-pointer text-ui-body font-medium text-zinc-900">
                {copy.current} ·{" "}
                {active.status === "approved"
                  ? activeCurrent
                    ? "APPROVED"
                    : "INACTIVE · REVIEW REQUIRED"
                  : "REVOKED"}
              </summary>
              {active.status === "approved" && !activeCurrent && (
                <ActionFeedback>
                  {activeReason}. Discard any outdated candidate before reading
                  the label again.
                </ActionFeedback>
              )}
              <Evidence entry={active} kind={kind} />
              <p className="my-3 text-ui-caption text-ink-secondary">
                Reviewed{" "}
                {new Date(active.reviewedAt).toLocaleString("en-US", {
                  timeZone: "America/New_York",
                })}{" "}
                ET
              </p>
              {active.status === "approved" && (
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => act("/revoke", { reviewId: active.id })}
                >
                  {copy.revoke}
                </Button>
              )}
            </details>
          )}
          {draft ? (
            <div className="space-y-4">
              <h4 className="my-3.5 text-14 font-medium text-zinc-900">
                CANDIDATE · NOT YET ACTIVE
              </h4>
              <p className="text-ui-body text-ink-secondary">
                Catalog: {product.name} ·{" "}
                {product.formulation || "formulation not recorded"} · EPA{" "}
                {product.epaRegNumber || "not recorded"}
              </p>
              <Evidence entry={draft} kind={kind} />
              <Checkbox
                className="shrink-0"
                id={`${copy.path}-${product.id}`}
                label={copy.confirm}
                checked={confirmed}
                disabled={disabled}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <div className="ui-record-actions">
                <Button
                  disabled={disabled || !confirmed}
                  onClick={() =>
                    act("/decision", {
                      candidateId: draft.id,
                      decision: "approve",
                      identityConfirmed: true,
                    })
                  }
                >
                  {copy.approve}
                </Button>
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() =>
                    act("/decision", {
                      candidateId: draft.id,
                      decision: "reject",
                    })
                  }
                >
                  Reject candidate
                </Button>
              </div>
            </div>
          ) : (
            <Button
              disabled={disabled}
              loading={busy}
              onClick={() => act("/extract", {})}
            >
              Find & read EPA label
            </Button>
          )}
          <p className="mt-3.5 mb-0 text-ui-body text-ink-secondary">
            {copy.footer}
          </p>
        </CardBody>
      </Card>
    </UiSurface>
  );
}
