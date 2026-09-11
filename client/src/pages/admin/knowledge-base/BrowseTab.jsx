import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  Textarea,
} from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";
import { CATEGORIES, formatDate, parseArray, sentenceCase } from "./config";

function statusTone(status) {
  return status === "flagged" ? "alert" : status === "active" ? "strong" : "neutral";
}

function errorForEntry(error, id) {
  return error?.id === String(id) ? error.message : "";
}

function KnowledgeEntryDetail({
  selected,
  editing,
  editContent,
  setEditing,
  setEditContent,
  setSelected,
  onVerify,
  onFlag,
  onDelete,
  onSave,
  isMobile,
  busy,
  actionError,
}) {
  const tags = parseArray(selected.tags);

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="text-18 break-words">{selected.title}</CardTitle>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge>{sentenceCase(selected.category)}</Badge>
            <Badge>{sentenceCase(selected.confidence)}</Badge>
            <Badge tone={statusTone(selected.status)}>{sentenceCase(selected.status)}</Badge>
            <span className="text-ui-caption text-ink-secondary">
              Source: {selected.source || "Unknown"}
            </span>
          </div>
        </div>
        {!isMobile && (
          <Button
            variant="ghost"
            aria-label="Close entry details"
            onClick={() => setSelected(null)}
            className="shrink-0 px-3"
          >
            <X size={17} aria-hidden />
          </Button>
        )}
      </CardHeader>

      <CardBody>
        {tags.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2" aria-label="Tags">
            {tags.map((tag) => <Badge key={tag}>#{tag}</Badge>)}
          </div>
        )}

        {editing ? (
          <div className="space-y-3">
            <Field label="Content">
              <Textarea
                value={editContent}
                onChange={(event) => setEditContent(event.target.value)}
                rows={isMobile ? 14 : 20}
              />
            </Field>
            <div className="ui-record-actions">
              <Button loading={busy(`save:${selected.id}`)} onClick={onSave}>
                Save
              </Button>
              <Button
                variant="ghost"
                disabled={busy(`save:${selected.id}`)}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <section aria-labelledby={`entry-content-${selected.id}`}>
            <h3 id={`entry-content-${selected.id}`} className="mb-2 text-ui-body font-medium">
              Content
            </h3>
            <div className="max-h-[400px] overflow-auto whitespace-pre-wrap rounded-md border-hairline border-zinc-200 bg-zinc-50 p-4 text-ui-body leading-relaxed">
              {selected.content}
            </div>
          </section>
        )}

        <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-ui-caption text-ink-secondary">
          <div>
            <dt className="inline font-medium text-zinc-700">Verified: </dt>
            <dd className="inline">
              {selected.last_verified_at
                ? `${formatDate(selected.last_verified_at)} by ${selected.verified_by}`
                : "Never"}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-zinc-700">Updated: </dt>
            <dd className="inline u-nums">{formatDate(selected.updated_at)}</dd>
          </div>
        </dl>

        {actionError && (
          <ActionFeedback error className="mt-4">{actionError}</ActionFeedback>
        )}
      </CardBody>

      {!editing && (
        <CardFooter className="ui-record-actions">
          <Button
            onClick={() => {
              setEditing(true);
              setEditContent(selected.content);
            }}
          >
            Edit
          </Button>
          <Button
            variant="secondary"
            loading={busy(`verify:${selected.id}`)}
            onClick={() => onVerify(selected.id)}
          >
            Verify
          </Button>
          <Button
            variant="secondary"
            loading={busy(`flag:${selected.id}`)}
            onClick={() => onFlag(selected.id)}
          >
            Flag
          </Button>
          <Button
            variant="danger"
            onClick={(event) => onDelete(event, selected)}
          >
            Delete
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

export default function BrowseTab({ showFeedback, onRefresh, isMobile }) {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const writesRef = useRef(new Set());
  const [writeKeys, setWriteKeys] = useState(new Set());
  const requestSequence = useRef(0);

  const beginWrite = (key) => {
    if (writesRef.current.has(key)) return false;
    writesRef.current.add(key);
    setWriteKeys(new Set(writesRef.current));
    return true;
  };

  const finishWrite = (key) => {
    writesRef.current.delete(key);
    setWriteKeys(new Set(writesRef.current));
  };

  const busy = (key) => writeKeys.has(key);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setLoadError("");
    const params = new URLSearchParams({ limit: "50" });
    if (filterCategory) params.set("category", filterCategory);
    if (filterStatus) params.set("status", filterStatus);

    try {
      if (searchQuery.trim()) {
        const data = await adminFetch(
          `/admin/kb/search?q=${encodeURIComponent(searchQuery)}&${params}`,
        );
        if (sequence !== requestSequence.current) return;
        setEntries(data.results || []);
        setTotal(data.results?.length || 0);
      } else {
        const data = await adminFetch(`/admin/kb?${params}`);
        if (sequence !== requestSequence.current) return;
        setEntries(data.entries || []);
        setTotal(data.total || 0);
      }
    } catch {
      if (sequence !== requestSequence.current) return;
      setEntries([]);
      setTotal(0);
      setLoadError("Knowledge base entries could not be loaded.");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [filterCategory, filterStatus, searchQuery]);

  useEffect(() => {
    load();
  }, [load]);

  const runEntryWrite = async (key, request, successMessage) => {
    if (!beginWrite(key)) return false;
    setActionError(null);
    try {
      await request();
      showFeedback(successMessage);
      load();
      onRefresh();
      return true;
    } catch (error) {
      const message = error.message || "The entry could not be updated.";
      setActionError({ id: key.split(":").slice(1).join(":"), message });
      showFeedback(message, true);
      return false;
    } finally {
      finishWrite(key);
    }
  };

  const handleVerify = (id) => runEntryWrite(
    `verify:${id}`,
    () => adminFetch(`/admin/kb/${id}/verify`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
    "Marked as verified",
  );

  const handleFlag = (id) => runEntryWrite(
    `flag:${id}`,
    () => adminFetch(`/admin/kb/${id}/flag`, {
      method: "POST",
      body: JSON.stringify({ reason: "Flagged from admin UI" }),
    }),
    "Entry flagged for review",
  );

  const handleSaveEdit = async () => {
    if (!selected) return;
    const saved = await runEntryWrite(
      `save:${selected.id}`,
      () => adminFetch(`/admin/kb/${selected.id}`, {
        method: "PUT",
        body: JSON.stringify({ content: editContent }),
      }),
      "Entry updated",
    );
    if (saved) {
      setEditing(false);
      setSelected((current) => current?.id === selected.id
        ? { ...current, content: editContent }
        : current);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const entry = pendingDelete;
    const deleted = await runEntryWrite(
      `delete:${entry.id}`,
      () => adminFetch(`/admin/kb/${entry.id}`, { method: "DELETE" }),
      "Entry deleted",
    );
    if (deleted) {
      setPendingDelete(null);
      setSelected(null);
    }
  };

  const detailProps = selected ? {
    selected,
    editing,
    editContent,
    setEditing,
    setEditContent,
    setSelected,
    onVerify: handleVerify,
    onFlag: handleFlag,
    onDelete: (event, entry) => {
      event.currentTarget.focus({ preventScroll: true });
      setActionError(null);
      setPendingDelete(entry);
    },
    onSave: handleSaveEdit,
    isMobile,
    busy,
    actionError: errorForEntry(actionError, selected.id),
  } : null;

  if (isMobile && selected) {
    return (
      <div>
        <Button variant="ghost" className="mb-3" onClick={() => setSelected(null)}>
          ← Back to list
        </Button>
        <KnowledgeEntryDetail {...detailProps} />
        <DeleteEntryDialog
          entry={pendingDelete}
          busy={pendingDelete ? busy(`delete:${pendingDelete.id}`) : false}
          error={errorForEntry(actionError, pendingDelete?.id)}
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      </div>
    );
  }

  return (
    <>
      <div className={`grid gap-4 ${selected ? "md:grid-cols-2" : "grid-cols-1"}`}>
        <div className="min-w-0">
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-[minmax(200px,1fr)_180px_160px]">
            <Field label="Search knowledge base" className="col-span-2 md:col-span-1">
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search knowledge base…"
              />
            </Field>
            <Field label="Category">
              <Select value={filterCategory} onChange={(event) => setFilterCategory(event.target.value)}>
                <option value="">All categories</option>
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)}>
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="flagged">Flagged</option>
                <option value="archived">Archived</option>
              </Select>
            </Field>
          </div>

          <div className="mb-2 text-ui-caption text-ink-secondary u-nums">
            {total} entries
          </div>
          {loading && (
            <ActionFeedback className="mb-3 min-h-11">Loading entries…</ActionFeedback>
          )}
          {loadError && (
            <ActionFeedback error onRetry={load} className="mb-3">
              {loadError}
            </ActionFeedback>
          )}

          {!loading && !loadError && entries.length === 0 ? (
            <Card>
              <CardBody className="py-10 text-center text-ink-secondary">
                {searchQuery
                  ? "No entries match this search. Try a different phrase or filter."
                  : "No knowledge base entries yet. Create one from the New entry section."}
              </CardBody>
            </Card>
          ) : (
            <div className="grid gap-2" aria-label="Knowledge base entries">
              {entries.map((entry) => (
                <Card
                  key={entry.id}
                  className={selected?.id === entry.id ? "border-zinc-900" : undefined}
                >
                  <Button
                    variant="ghost"
                    className="h-auto min-h-11 w-full justify-start rounded-md px-4 py-3 text-left"
                    aria-pressed={selected?.id === entry.id}
                    onClick={() => {
                      setSelected(entry);
                      setEditing(false);
                      setActionError("");
                    }}
                  >
                    <span className="flex min-w-0 flex-1 items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block break-words text-ui-body font-medium text-zinc-900">
                          {entry.title}
                        </span>
                        <span className="mt-2 flex flex-wrap gap-2">
                          <Badge>{sentenceCase(entry.confidence)}</Badge>
                          <Badge>{sentenceCase(entry.category)}</Badge>
                          {entry.status === "flagged" && <Badge tone="alert">Flagged</Badge>}
                        </span>
                      </span>
                      <span className="shrink-0 text-ui-caption text-ink-secondary u-nums">
                        {formatDate(entry.last_verified_at)}
                      </span>
                    </span>
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <div className="min-w-0 self-start md:sticky md:top-5">
            <KnowledgeEntryDetail {...detailProps} />
          </div>
        )}
      </div>

      <DeleteEntryDialog
        entry={pendingDelete}
        busy={pendingDelete ? busy(`delete:${pendingDelete.id}`) : false}
        error={errorForEntry(actionError, pendingDelete?.id)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </>
  );
}

function DeleteEntryDialog({ entry, busy, error, onClose, onConfirm }) {
  return (
    <Dialog open={Boolean(entry)} onClose={() => !busy && onClose()} size="sm">
      <DialogHeader>
        <DialogTitle>Delete knowledge base entry</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-ui-body text-zinc-700">
          Delete “{entry?.title}”? This permanently removes the entry.
        </p>
        {error && <ActionFeedback error className="mt-3">{error}</ActionFeedback>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={busy} onClick={onConfirm}>Delete entry</Button>
      </DialogFooter>
    </Dialog>
  );
}
