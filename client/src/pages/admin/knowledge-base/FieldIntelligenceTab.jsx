import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  Textarea,
} from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";
import { formatDate, parseArray } from "./config";

const EMPTY_QUEUE = { pending: [], blocked: [], recentYellow: [] };
const REVIEW_STATUS_LABELS = {
  auto: "Auto",
  pending_review: "Needs review",
  approved: "Approved",
  blocked: "Blocked",
};

function TierBadge({ tier }) {
  return <Badge>{(tier || "untiered").toUpperCase()}</Badge>;
}

function WikiPageDetail({
  page,
  busy,
  canRegenerate,
  onClose,
  onReview,
  onBlock,
  onTierPin,
  onRegenerate,
  actionError,
}) {
  const activeOp = busy(page.slug);
  const isBusy = Boolean(activeOp);

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="text-18 break-words">{page.title}</CardTitle>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-ui-caption text-ink-secondary">
            <TierBadge tier={page.review_tier} />
            <Badge tone={page.review_status === "pending_review" ? "alert" : "neutral"}>
              {REVIEW_STATUS_LABELS[page.review_status] || page.review_status}
            </Badge>
            <span className="u-nums">{page.data_point_count} data points</span>
            <span>{page.confidence} confidence</span>
            {page.last_human_review && (
              <span className="u-nums">Reviewed {formatDate(page.last_human_review)}</span>
            )}
          </div>
        </div>
        <Button variant="ghost" disabled={isBusy} onClick={onClose}>Close</Button>
      </CardHeader>

      <CardBody>
        <div className="ui-record-actions mb-4">
          {page.review_status !== "approved" && (
            <Button
              loading={activeOp === "approve"}
              disabled={isBusy}
              onClick={() => onReview(page.slug, "approve")}
            >
              Approve
            </Button>
          )}
          {page.review_status !== "blocked" && (
            <Button variant="secondary" disabled={isBusy} onClick={(event) => onBlock(event, page)}>
              Block
            </Button>
          )}
          {canRegenerate && (
            <Button
              variant="secondary"
              loading={activeOp === "regenerate"}
              disabled={isBusy}
              onClick={() => onRegenerate(page.slug)}
            >
              Regenerate
            </Button>
          )}
          <Select
            aria-label="Pin review tier"
            className="w-full sm:w-48"
            value=""
            disabled={isBusy}
            onChange={(event) => onTierPin(page.slug, event.target.value)}
          >
            <option value="">Pin tier...</option>
            <option value="green">Green (auto)</option>
            <option value="yellow">Yellow (digest)</option>
            <option value="red">Red (review)</option>
          </Select>
        </div>

        {page.human_notes && (
          <div className="mb-4 rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3 text-ui-body">
            <span className="font-medium">Notes: </span>{page.human_notes}
          </div>
        )}
        {actionError && <ActionFeedback error className="mb-4">{actionError}</ActionFeedback>}
        <pre className="m-0 max-h-[480px] overflow-y-auto whitespace-pre-wrap rounded-md border-hairline border-zinc-200 bg-zinc-50 p-4 font-sans text-ui-body leading-relaxed text-zinc-800">
          {page.content}
        </pre>
      </CardBody>
    </Card>
  );
}

function FieldIntelligenceDirectory({
  queue,
  pages,
  selected,
  queueLoading,
  pagesLoading,
  queueError,
  pagesError,
  busySlugs,
  loadQueue,
  loadPages,
  openPage,
  onReview,
  onBlock,
}) {
  return (
    <>
      <Card className={queue.pending.length > 0 ? "border-alert-fg" : undefined}>
        <CardHeader>
          <CardTitle>
            Needs review <span className="u-nums">({queue.pending.length})</span>
          </CardTitle>
        </CardHeader>
        <CardBody>
          <p className="mb-3 text-ui-body text-ink-secondary">
            Red-tier pages are excluded from estimates, recommendations, and agents until
            approved. Everything else maintains itself.
          </p>
          {queueLoading && <ActionFeedback>Loading review queue…</ActionFeedback>}
          {queueError && <ActionFeedback error onRetry={loadQueue}>{queueError}</ActionFeedback>}
          {!queueLoading && !queueError && queue.pending.length === 0 && (
            <p className="text-ui-body text-ink-secondary">
              Nothing needs your judgment right now.
            </p>
          )}
          <div className="divide-y divide-zinc-200">
            {queue.pending.map((page) => (
              <div key={page.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <Button
                    variant="ghost"
                    className="h-auto min-h-11 max-w-full justify-start whitespace-normal px-0 text-left"
                    onClick={() => openPage(page.slug)}
                  >
                    {page.title}
                  </Button>
                  <div className="flex flex-wrap items-center gap-2 text-ui-caption text-ink-secondary">
                    <span className="u-nums">{page.data_point_count} data points</span>
                    <span>{page.confidence} confidence</span>
                    {parseArray(page.risk_flags).map((flag) => (
                      <Badge key={flag} tone="alert">{flag.replace(/_/g, " ")}</Badge>
                    ))}
                  </div>
                </div>
                <div className="ui-record-actions">
                  <Button
                    loading={busySlugs.get(page.slug) === "approve"}
                    disabled={busySlugs.has(page.slug)}
                    onClick={() => onReview(page.slug, "approve")}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busySlugs.has(page.slug)}
                    onClick={(event) => onBlock(event, page)}
                  >
                    Block
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      {!queueError && queue.blocked.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Blocked <span className="u-nums">({queue.blocked.length})</span></CardTitle>
          </CardHeader>
          <CardBody className="grid gap-1">
            {queue.blocked.map((page) => (
              <Button
                key={page.id}
                variant="ghost"
                className="h-auto min-h-11 justify-start whitespace-normal text-left text-ink-secondary"
                onClick={() => openPage(page.slug)}
              >
                {page.title}
              </Button>
            ))}
          </CardBody>
        </Card>
      )}

      {!queueError && queue.recentYellow.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              Updated this week — optional review {" "}
              <span className="u-nums">({queue.recentYellow.length})</span>
            </CardTitle>
          </CardHeader>
          <CardBody className="grid gap-1">
            {queue.recentYellow.map((page) => (
              <Button
                key={page.id}
                variant="ghost"
                className="h-auto min-h-11 justify-between gap-3 whitespace-normal text-left"
                onClick={() => openPage(page.slug)}
              >
                <span>{page.title}</span>
                <span className="shrink-0 text-ui-caption text-ink-secondary u-nums">
                  {page.data_point_count} pts
                </span>
              </Button>
            ))}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All wiki pages <span className="u-nums">({pages.length})</span></CardTitle>
        </CardHeader>
        <CardBody>
          {pagesLoading && <ActionFeedback>Loading wiki pages…</ActionFeedback>}
          {pagesError && <ActionFeedback error onRetry={loadPages}>{pagesError}</ActionFeedback>}
          {!pagesLoading && !pagesError && pages.length === 0 && (
            <p className="text-ui-body text-ink-secondary">
              No wiki pages yet. Pages generate automatically from confirmed lawn assessments.
            </p>
          )}
          <div className="grid gap-2">
            {pages.map((page) => (
              <Button
                key={page.id}
                variant="ghost"
                aria-pressed={selected?.id === page.id}
                className={`h-auto min-h-11 w-full justify-between gap-3 whitespace-normal rounded-md border-hairline px-3 py-2 text-left ${selected?.id === page.id ? "border-zinc-900" : "border-zinc-200"}`}
                onClick={() => openPage(page.slug)}
              >
                <span className="min-w-0">
                  <span className="block break-words text-ui-body font-medium text-zinc-900">{page.title}</span>
                  <span className="mt-1 block text-ui-caption text-ink-secondary">
                    {page.category} · <span className="u-nums">{page.data_point_count} pts</span> · {page.confidence}
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap justify-end gap-2">
                  <TierBadge tier={page.review_tier} />
                  {page.review_status === "pending_review" && <Badge tone="alert">Review</Badge>}
                  {page.review_status === "blocked" && <Badge>Blocked</Badge>}
                </span>
              </Button>
            ))}
          </div>
        </CardBody>
      </Card>
    </>
  );
}

export default function FieldIntelligenceTab({
  showFeedback,
  isMobile,
  canRegenerate,
  canReviewQueue = true,
}) {
  const [queue, setQueue] = useState(EMPTY_QUEUE);
  const [pages, setPages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [pagesLoading, setPagesLoading] = useState(true);
  const [queueError, setQueueError] = useState("");
  const [pagesError, setPagesError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailRetrySlug, setDetailRetrySlug] = useState("");
  const [actionError, setActionError] = useState(null);
  const [pendingBlock, setPendingBlock] = useState(null);
  const [blockNotes, setBlockNotes] = useState("");
  const pendingBlockRef = useRef(null);
  // slug -> operation in flight ("approve" | "block" | "tier" | "regenerate")
  const writesRef = useRef(new Map());
  const [busySlugs, setBusySlugs] = useState(new Map());

  const loadQueue = useCallback(async () => {
    setQueueError("");
    if (!canReviewQueue) {
      // /admin/wiki/review/queue is requireAdmin on the server; a technician
      // session would only ever get a 403, so the queue reads as empty for
      // them (the pre-migration page swallowed that error the same way).
      setQueue(EMPTY_QUEUE);
      setQueueLoading(false);
      return;
    }
    setQueueLoading(true);
    try {
      const data = await adminFetch("/admin/wiki/review/queue");
      setQueue({
        pending: data.pending || [],
        blocked: data.blocked || [],
        recentYellow: data.recentYellow || [],
      });
    } catch {
      setQueue(EMPTY_QUEUE);
      setQueueError("The Field Intelligence review queue could not be loaded.");
    } finally {
      setQueueLoading(false);
    }
  }, [canReviewQueue]);

  const loadPages = useCallback(async () => {
    setPagesLoading(true);
    setPagesError("");
    try {
      const data = await adminFetch("/admin/wiki?limit=200");
      setPages(data.pages || []);
    } catch {
      setPages([]);
      setPagesError("Wiki pages could not be loaded.");
    } finally {
      setPagesLoading(false);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      await loadQueue();
      await loadPages();
    };
    load();
  }, [loadPages, loadQueue]);

  const beginWrite = (slug, operation) => {
    if (writesRef.current.has(slug)) return false;
    writesRef.current.set(slug, operation);
    setBusySlugs(new Map(writesRef.current));
    return true;
  };

  const finishWrite = (slug) => {
    writesRef.current.delete(slug);
    setBusySlugs(new Map(writesRef.current));
  };

  const openPage = useCallback(async (slug) => {
    setDetailError("");
    setDetailRetrySlug(slug);
    try {
      const data = await adminFetch(`/admin/wiki/${slug}`);
      if (data?.page) setSelected(data.page);
      else setDetailError("The wiki page response did not include a page.");
    } catch {
      setDetailError("The wiki page could not be opened.");
    }
  }, []);

  const reloadLists = () => {
    loadQueue();
    loadPages();
  };

  const handleReview = async (slug, action, notes) => {
    if (!beginWrite(slug, action)) return;
    setActionError(null);
    try {
      await adminFetch(`/admin/wiki/review/${slug}`, {
        method: "POST",
        body: JSON.stringify({ action, notes }),
      });
      showFeedback(action === "approve" ? "Page approved — now agent-visible" : "Page blocked");
      if (action === "block" && pendingBlockRef.current?.slug === slug) {
        pendingBlockRef.current = null;
        setPendingBlock(null);
        setBlockNotes("");
      }
      setSelected((current) => current?.slug === slug ? null : current);
      reloadLists();
    } catch (error) {
      const message = error.message || "The review action could not be completed.";
      setActionError({ slug, message });
      showFeedback("Review action failed", true);
    } finally {
      finishWrite(slug);
    }
  };

  const handleTierPin = async (slug, tier) => {
    if (!tier || !beginWrite(slug, "tier")) return;
    setActionError(null);
    try {
      await adminFetch(`/admin/wiki/tier/${slug}`, {
        method: "PUT",
        body: JSON.stringify({ tier }),
      });
      showFeedback(`Tier pinned to ${tier}`);
      setSelected((current) => current?.slug === slug ? null : current);
      reloadLists();
    } catch (error) {
      setActionError({ slug, message: error.message || "The tier could not be updated." });
      showFeedback("Tier update failed", true);
    } finally {
      finishWrite(slug);
    }
  };

  const handleRegenerate = async (slug) => {
    if (!beginWrite(slug, "regenerate")) return;
    setActionError(null);
    try {
      await adminFetch(`/admin/wiki/update/${slug}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      showFeedback("Page regenerated");
      reloadLists();
    } catch (error) {
      setActionError({ slug, message: error.message || "The page could not be regenerated." });
      showFeedback("Regeneration failed — see update log", true);
    } finally {
      finishWrite(slug);
    }
  };

  const openBlockDialog = (event, page) => {
    event.currentTarget.focus({ preventScroll: true });
    setActionError(null);
    setBlockNotes("");
    pendingBlockRef.current = page;
    setPendingBlock(page);
  };

  const detail = selected && (
    <WikiPageDetail
      page={selected}
      busy={(slug) => busySlugs.get(slug) || null}
      canRegenerate={canRegenerate}
      onClose={() => setSelected(null)}
      onReview={handleReview}
      onBlock={openBlockDialog}
      onTierPin={handleTierPin}
      onRegenerate={handleRegenerate}
      actionError={actionError?.slug === selected.slug ? actionError.message : ""}
    />
  );

  if (isMobile && selected) {
    return (
      <>
        {detail}
        <BlockPageDialog
          page={pendingBlock}
          notes={blockNotes}
          setNotes={setBlockNotes}
          busy={pendingBlock ? busySlugs.get(pendingBlock.slug) === "block" : false}
          error={actionError && actionError.slug === pendingBlock?.slug ? actionError.message : ""}
          onClose={() => {
            pendingBlockRef.current = null;
            setPendingBlock(null);
            setBlockNotes("");
          }}
          onConfirm={() => handleReview(pendingBlock.slug, "block", blockNotes || undefined)}
        />
      </>
    );
  }

  return (
    <>
      <div className={`grid gap-4 ${selected ? "md:grid-cols-2" : "grid-cols-1"}`}>
        <div className="min-w-0 space-y-4">
          {detailError && (
            <ActionFeedback error onRetry={() => openPage(detailRetrySlug)}>
              {detailError}
            </ActionFeedback>
          )}

          <FieldIntelligenceDirectory
            queue={queue}
            pages={pages}
            selected={selected}
            queueLoading={queueLoading}
            pagesLoading={pagesLoading}
            queueError={queueError}
            pagesError={pagesError}
            busySlugs={busySlugs}
            loadQueue={loadQueue}
            loadPages={loadPages}
            openPage={openPage}
            onReview={handleReview}
            onBlock={openBlockDialog}
          />
        </div>

        {selected && <div className="min-w-0 self-start md:sticky md:top-5">{detail}</div>}
      </div>

      <BlockPageDialog
        page={pendingBlock}
        notes={blockNotes}
        setNotes={setBlockNotes}
        busy={pendingBlock ? busySlugs.get(pendingBlock.slug) === "block" : false}
        error={actionError && actionError.slug === pendingBlock?.slug ? actionError.message : ""}
        onClose={() => {
          pendingBlockRef.current = null;
          setPendingBlock(null);
          setBlockNotes("");
        }}
        onConfirm={() => handleReview(pendingBlock.slug, "block", blockNotes || undefined)}
      />
    </>
  );
}

function BlockPageDialog({ page, notes, setNotes, busy, error, onClose, onConfirm }) {
  return (
    <Dialog open={Boolean(page)} onClose={() => !busy && onClose()} size="sm">
      <DialogHeader>
        {/* The pre-migration prompt() text, verbatim. */}
        <DialogTitle>Why is this page blocked? (stored as review notes)</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <Textarea
          aria-label="Review notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={4}
        />
        {error && <ActionFeedback error className="mt-3">{error}</ActionFeedback>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={busy} onClick={onConfirm}>Block</Button>
      </DialogFooter>
    </Dialog>
  );
}
