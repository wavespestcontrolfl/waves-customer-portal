import { useEffect, useRef } from "react";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "../../../../components/ui";
import { formatDate } from "../config";
import { ApprovedActions, DraftActions, RetiredActions } from "./FactActions";
import FactHistory from "./FactHistory";

const STATUS_BADGE = { draft: ["Draft", "neutral"], approved: ["Approved", "strong"], retired: ["Retired", "neutral"] };

function Dates({ fact }) {
  if (fact.status === "approved") return <>Approved by the owner on {formatDate(fact.approved_at, true)}.</>;
  if (fact.status === "retired") return <>Retired on {formatDate(fact.retired_at, true)}{fact.retire_reason ? `: ${fact.retire_reason}` : ""}.</>;
  return <>Drafted on {formatDate(fact.created_at, true)}.</>;
}

export default function FactCard({ fact, ownerActions, onDone, onStale, onEditing, highlight = false }) {
  const ref = useRef(null);
  // The card a change just created: scrolled into view and outlined until the admin does something else.
  useEffect(() => { if (highlight) ref.current?.scrollIntoView?.({ block: "center" }); }, [highlight]);
  const [label, tone] = STATUS_BADGE[fact.status] || STATUS_BADGE.draft;
  const Actions = { draft: DraftActions, approved: ApprovedActions, retired: RetiredActions }[fact.status] || RetiredActions;
  return (
    <div ref={ref} data-highlighted={highlight || undefined} className={highlight ? "rounded-sm outline outline-2 outline-zinc-900" : undefined}>
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-2">
        <CardTitle className="text-18">{fact.topic}</CardTitle>
        <div className="flex flex-wrap gap-2">
          {fact.supersedes_id && <Badge>Replaces an approved fact</Badge>}
          <Badge tone={tone}>{label}</Badge>
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {fact.question && <p className="text-ui-caption text-ink-secondary">Answers: {fact.question}</p>}
        <blockquote className="m-0 whitespace-pre-wrap break-words border-l-2 border-zinc-300 pl-3 text-ui-body text-ink-primary">{fact.fact_text}</blockquote>
        <p className="text-ui-caption text-ink-secondary"><Dates fact={fact} /></p>
        {fact.owner_words && <p className="text-ui-caption text-ink-secondary">Owner's words: "{fact.owner_words}"</p>}
        <Actions fact={fact} ownerActions={ownerActions} onDone={(message, switchTo, focusId) => onDone(message, switchTo, fact.status, focusId)} onStale={onStale} onEditing={onEditing} />
        <FactHistory fact={fact} />
      </CardBody>
    </Card>
    </div>
  );
}
