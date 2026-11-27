import { useState, useEffect, useCallback, useRef } from "react";
import useIsMobile from "../../../hooks/useIsMobile";
import { etDateString } from "../../../lib/timezone";
import {
  API_BASE, D, MONO,
  adminFetch, sCard, sBtn, sBadge, sInput, errMessage, LoadFailedNotice,
} from "./staffShared";

// =============================================================================
// DOCUMENTS TAB — internal company documents (admin only)
// =============================================================================
const DOC_CATEGORIES = [
  { value: "all", label: "All Documents" },
  { value: "sop", label: "SOPs" },
  { value: "onboarding", label: "New Hire Onboarding" },
  { value: "offer_letter", label: "Offer Letters" },
  { value: "policy", label: "Policies" },
  { value: "training", label: "Training" },
  { value: "safety", label: "Safety" },
  { value: "general", label: "General" },
];

const DOC_CAT_COLORS = {
  sop: "#3F3F46", // zinc-700
  onboarding: "#15803D", // green
  offer_letter: "#52525B", // zinc-600 — distinct from sop
  policy: "#A16207", // amber
  training: "#18181B", // zinc-900 (was hardcoded sky-500)
  safety: "#991B1B", // alert-fg red
  general: "#71717A", // zinc-500 muted
};

const FILE_ICONS = {
  pdf: "\uD83D\uDCC4",
  docx: "\uD83D\uDDD2\uFE0F",
  doc: "\uD83D\uDDD2\uFE0F",
  xlsx: "\uD83D\uDCCA",
  xls: "\uD83D\uDCCA",
  png: "\uD83D\uDDBC\uFE0F",
  jpg: "\uD83D\uDDBC\uFE0F",
  jpeg: "\uD83D\uDDBC\uFE0F",
  txt: "\uD83D\uDCC3",
  csv: "\uD83D\uDCCA",
};

export function DocumentsTab({ showToast }) {
  const isMobile = useIsMobile(640);
  const [docs, setDocs] = useState([]);
  const [techs, setTechs] = useState([]);
  const [loading, setLoading] = useState(true);
  // A failed list read is not an empty library: "No documents yet" and its
  // upload invitation show only after a read that succeeded.
  const [loadFailed, setLoadFailed] = useState(false);
  const loadRequestRef = useRef(0);
  const [catFilter, setCatFilter] = useState("all");
  const [techFilter, setTechFilter] = useState("all"); // 'all' | 'company' | <techId>
  // Archived view: the documents an admin archived, each with Restore.
  // docsArchived is the view the rows on screen were read for, so a row never
  // shows the other view's action while the next read is on its way.
  const [showArchived, setShowArchived] = useState(false);
  const [docsArchived, setDocsArchived] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadForm, setUploadForm] = useState({
    title: "",
    category: "general",
    description: "",
    technicianId: "",
    expirationDate: "",
  });
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({
    title: "",
    category: "",
    description: "",
    technicianId: "",
    expirationDate: "",
  });

  // Pull techs once for the filter chips and the upload/edit "assign
  // to" dropdowns. Reusing /admin/timetracking/technicians keeps the
  // shape identical to TeamTab without a new endpoint.
  useEffect(() => {
    adminFetch("/admin/timetracking/technicians")
      .then((r) => setTechs((r.technicians || []).filter((t) => t.active)))
      .catch(() => {
        /* filter chips just won't show */
      });
  }, []);

  const load = useCallback(async () => {
    // Only the latest read (filter change, view change, upload, edit,
    // archive, restore, Retry) may set the list or the failure notice.
    const request = ++loadRequestRef.current;
    try {
      const params = new URLSearchParams();
      params.set("category", catFilter);
      if (techFilter && techFilter !== "all")
        params.set("technicianId", techFilter);
      if (showArchived) params.set("archived", "only");
      const res = await adminFetch(
        `/admin/timetracking/documents?${params.toString()}`,
      );
      if (request !== loadRequestRef.current) return;
      setDocs(res.documents || []);
      setDocsArchived(showArchived);
      setLoadFailed(false);
    } catch {
      if (request !== loadRequestRef.current) return;
      // The list on screen may belong to another filter, so it is cleared;
      // the notice below says the read failed.
      setDocs([]);
      setDocsArchived(showArchived);
      setLoadFailed(true);
    }
    setLoading(false);
  }, [catFilter, techFilter, showArchived]);

  // An upload, edit, archive or restore bumps reloadKey when its write lands.
  // The effect then reads with the filters and view on screen at that moment,
  // not the ones captured at the click: the admin may switch views while the
  // write is in flight.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((key) => key + 1);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const handleUpload = async () => {
    if (!file) {
      showToast("Select a file");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", uploadForm.title || file.name);
      fd.append("category", uploadForm.category);
      fd.append("description", uploadForm.description);
      if (uploadForm.technicianId)
        fd.append("technicianId", uploadForm.technicianId);
      if (uploadForm.expirationDate)
        fd.append("expirationDate", uploadForm.expirationDate);

      const token = localStorage.getItem("waves_admin_token");
      const r = await fetch(`${API_BASE}/admin/timetracking/documents/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!r.ok) {
        let detail = `HTTP ${r.status}`;
        try {
          const body = await r.json();
          if (body?.error) detail = body.error;
        } catch { /* non-JSON error */ }
        throw new Error(detail);
      }
      showToast("Document uploaded");
      setShowUpload(false);
      setUploadForm({
        title: "",
        category: "general",
        description: "",
        technicianId: "",
        expirationDate: "",
      });
      setFile(null);
      reload();
    } catch (e) {
      showToast("Upload failed: " + errMessage(e));
    }
    setUploading(false);
  };

  const handleDownload = async (doc) => {
    try {
      const res = await adminFetch(
        `/admin/timetracking/documents/${doc.id}/download`,
      );
      window.open(res.url, "_blank");
    } catch (e) {
      showToast("Download failed: " + errMessage(e));
    }
  };

  const handleDelete = async (doc) => {
    if (!confirm(`Archive "${doc.title}"? You can restore it from Show archived.`)) return;
    try {
      await adminFetch(`/admin/timetracking/documents/${doc.id}`, {
        method: "DELETE",
      });
      showToast("Document archived");
      reload();
    } catch (e) {
      showToast("Failed: " + errMessage(e));
    }
  };

  // The stored file and metadata come back as they were; only the archive
  // flag is cleared.
  const handleRestore = async (doc) => {
    try {
      await adminFetch(`/admin/timetracking/documents/${doc.id}/restore`, {
        method: "POST",
      });
      showToast("Document restored");
      reload();
    } catch (e) {
      showToast("Restore failed: " + errMessage(e));
    }
  };

  const handleEditSave = async () => {
    try {
      await adminFetch(`/admin/timetracking/documents/${editingId}`, {
        method: "PUT",
        body: JSON.stringify(editForm),
      });
      showToast("Document updated");
      setEditingId(null);
      reload();
    } catch (e) {
      showToast("Failed: " + errMessage(e));
    }
  };

  const fmtSize = (bytes) => {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  };

  const fmtDate = (d) =>
    d
      ? new Date(d).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "";
  // Render a SQL DATE column (YYYY-MM-DD) without the UTC-midnight day
  // shift that hits Date-only strings in negative-offset timezones.
  // Anchor at noon UTC and format in UTC so the calendar day stays
  // intact regardless of the runtime tz.
  const fmtYmdDate = (d) => {
    if (!d) return "";
    const ymd = String(d).split("T")[0];
    return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  };

  if (loading)
    return (
      <div style={{ color: D.muted, padding: 40, textAlign: "center" }}>
        Loading documents...
      </div>
    );

  return (
    <div>
      {" "}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        {" "}
        <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>
          {docsArchived ? "Archived documents" : "Documents"}
        </div>{" "}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => setShowArchived((value) => !value)}
            aria-pressed={showArchived}
            style={sBtn(D.card, D.text)}
          >
            {showArchived ? "Show active" : "Show archived"}
          </button>
          {!showArchived && (
            <button
              onClick={() => setShowUpload(true)}
              style={sBtn(D.teal, D.white)}
            >
              + Upload Document
            </button>
          )}
        </div>{" "}
      </div>
      {/* Tech filter pills — All / Company / one-per-tech. Hidden when
          there are no techs to assign to. */}
      {techs.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 10,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {" "}
          <span
            style={{
              fontSize: 14,
              color: D.muted,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginRight: 4,
            }}
          >
            Assigned to
          </span>
          {[
            { value: "all", label: "All" },
            { value: "company", label: "Company-wide" },
            ...techs.map((t) => ({ value: t.id, label: t.name })),
          ].map((c) => (
            <button
              key={c.value}
              onClick={() => setTechFilter(c.value)}
              style={{
                padding: "6px 12px",
                borderRadius: 20,
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
                border: `1px solid ${techFilter === c.value ? D.teal : D.border}`,
                background: techFilter === c.value ? D.teal : "transparent",
                color: techFilter === c.value ? D.white : D.muted,
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {/* Category filter pills */}
      <div
        style={{
          display: "flex",
          gap: 6,
          marginBottom: 16,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {" "}
        <span
          style={{
            fontSize: 14,
            color: D.muted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginRight: 4,
          }}
        >
          Category
        </span>
        {DOC_CATEGORIES.map((c) => (
          <button
            key={c.value}
            onClick={() => setCatFilter(c.value)}
            style={{
              padding: "6px 14px",
              borderRadius: 20,
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
              border: `1px solid ${catFilter === c.value ? D.teal : D.border}`,
              background: catFilter === c.value ? D.teal : "transparent",
              color: catFilter === c.value ? D.white : D.muted,
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      {/* Upload form */}
      {showUpload && (
        <div style={{ ...sCard, borderColor: D.teal + "44" }}>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: D.heading,
              marginBottom: 12,
            }}
          >
            Upload Document
          </div>{" "}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 12,
              marginBottom: 12,
            }}
          >
            {" "}
            <div>
              {" "}
              <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                Title
              </div>{" "}
              <input
                value={uploadForm.title}
                onChange={(e) =>
                  setUploadForm((f) => ({ ...f, title: e.target.value }))
                }
                placeholder="Document title"
                style={sInput}
              />{" "}
            </div>{" "}
            <div>
              {" "}
              <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                Category
              </div>{" "}
              <select
                value={uploadForm.category}
                onChange={(e) =>
                  setUploadForm((f) => ({ ...f, category: e.target.value }))
                }
                style={sInput}
              >
                {DOC_CATEGORIES.filter((c) => c.value !== "all").map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>{" "}
            </div>{" "}
          </div>{" "}
          <div style={{ marginBottom: 12 }}>
            {" "}
            <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
              Description (optional)
            </div>{" "}
            <input
              value={uploadForm.description}
              onChange={(e) =>
                setUploadForm((f) => ({ ...f, description: e.target.value }))
              }
              placeholder="Brief description..."
              style={sInput}
            />{" "}
          </div>{" "}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 12,
            }}
          >
            {" "}
            <div>
              {" "}
              <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                Assigned to (optional)
              </div>{" "}
              <select
                value={uploadForm.technicianId}
                onChange={(e) =>
                  setUploadForm((f) => ({ ...f, technicianId: e.target.value }))
                }
                style={sInput}
              >
                {" "}
                <option value="">Company-wide</option>
                {techs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>{" "}
            </div>{" "}
            <div>
              {" "}
              <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
                Expiration (optional)
              </div>{" "}
              <input
                type="date"
                value={uploadForm.expirationDate}
                onChange={(e) =>
                  setUploadForm((f) => ({
                    ...f,
                    expirationDate: e.target.value,
                  }))
                }
                style={sInput}
              />{" "}
            </div>{" "}
          </div>{" "}
          <div style={{ marginBottom: 12 }}>
            {" "}
            <div style={{ fontSize: 14, color: D.muted, marginBottom: 4 }}>
              File
            </div>{" "}
            <input
              type="file"
              onChange={(e) => {
                const f = e.target.files[0];
                if (f) {
                  setFile(f);
                  if (!uploadForm.title)
                    setUploadForm((prev) => ({
                      ...prev,
                      title: f.name.replace(/\.[^.]+$/, ""),
                    }));
                }
              }}
              style={{ fontSize: 14, color: D.text }}
              accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg"
            />
            {file && (
              <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>
                {file.name} ({fmtSize(file.size)})
              </div>
            )}
          </div>{" "}
          <div style={{ display: "flex", gap: 8 }}>
            {" "}
            <button
              onClick={handleUpload}
              disabled={uploading || !file}
              style={{
                ...sBtn(D.green, D.white),
                opacity: uploading || !file ? 0.5 : 1,
              }}
            >
              {uploading ? "Uploading..." : "Upload"}
            </button>{" "}
            <button
              onClick={() => {
                setShowUpload(false);
                setFile(null);
              }}
              style={sBtn("transparent", D.muted)}
            >
              Cancel
            </button>{" "}
          </div>{" "}
        </div>
      )}
      {/* Documents grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile
            ? "1fr"
            : "repeat(auto-fill, minmax(320px, 1fr))",
          gap: 12,
        }}
      >
        {docs.map((doc) => {
          const catColor = DOC_CAT_COLORS[doc.category] || D.muted;
          const icon = FILE_ICONS[doc.file_type] || "\uD83D\uDCC1";
          const isEditing = editingId === doc.id;

          if (isEditing) {
            return (
              <div
                key={doc.id}
                style={{ ...sCard, borderColor: D.teal + "44" }}
              >
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    color: D.heading,
                    marginBottom: 10,
                  }}
                >
                  Edit Document
                </div>{" "}
                <div style={{ marginBottom: 8 }}>
                  {" "}
                  <div
                    style={{ fontSize: 14, color: D.muted, marginBottom: 3 }}
                  >
                    Title
                  </div>{" "}
                  <input
                    value={editForm.title}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, title: e.target.value }))
                    }
                    style={sInput}
                  />{" "}
                </div>{" "}
                <div style={{ marginBottom: 8 }}>
                  {" "}
                  <div
                    style={{ fontSize: 14, color: D.muted, marginBottom: 3 }}
                  >
                    Category
                  </div>{" "}
                  <select
                    value={editForm.category}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, category: e.target.value }))
                    }
                    style={sInput}
                  >
                    {DOC_CATEGORIES.filter((c) => c.value !== "all").map(
                      (c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ),
                    )}
                  </select>{" "}
                </div>{" "}
                <div style={{ marginBottom: 10 }}>
                  {" "}
                  <div
                    style={{ fontSize: 14, color: D.muted, marginBottom: 3 }}
                  >
                    Description
                  </div>{" "}
                  <input
                    value={editForm.description}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        description: e.target.value,
                      }))
                    }
                    style={sInput}
                  />{" "}
                </div>{" "}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  {" "}
                  <div>
                    {" "}
                    <div
                      style={{ fontSize: 14, color: D.muted, marginBottom: 3 }}
                    >
                      Assigned to
                    </div>{" "}
                    <select
                      value={editForm.technicianId}
                      onChange={(e) =>
                        setEditForm((f) => ({
                          ...f,
                          technicianId: e.target.value,
                        }))
                      }
                      style={sInput}
                    >
                      {" "}
                      <option value="">Company-wide</option>
                      {techs.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>{" "}
                  </div>{" "}
                  <div>
                    {" "}
                    <div
                      style={{ fontSize: 14, color: D.muted, marginBottom: 3 }}
                    >
                      Expiration
                    </div>{" "}
                    <input
                      type="date"
                      value={editForm.expirationDate}
                      onChange={(e) =>
                        setEditForm((f) => ({
                          ...f,
                          expirationDate: e.target.value,
                        }))
                      }
                      style={sInput}
                    />{" "}
                  </div>{" "}
                </div>{" "}
                <div style={{ display: "flex", gap: 6 }}>
                  {" "}
                  <button
                    onClick={handleEditSave}
                    style={sBtn(D.green, D.white)}
                  >
                    Save
                  </button>{" "}
                  <button
                    onClick={() => setEditingId(null)}
                    style={sBtn("transparent", D.muted)}
                  >
                    Cancel
                  </button>{" "}
                </div>{" "}
              </div>
            );
          }

          return (
            <div key={doc.id} style={sCard}>
              {" "}
              <div
                style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
              >
                {" "}
                <div style={{ fontSize: 28, flexShrink: 0, lineHeight: 1 }}>
                  {icon}
                </div>{" "}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {" "}
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      color: D.heading,
                      marginBottom: 4,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {doc.title}
                  </div>{" "}
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      marginBottom: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    {" "}
                    <span style={sBadge(catColor + "22", catColor)}>
                      {(
                        DOC_CATEGORIES.find((c) => c.value === doc.category) ||
                        {}
                      ).label || doc.category}
                    </span>{" "}
                    <span style={{ fontSize: 14, color: D.muted }}>
                      {doc.file_type?.toUpperCase()}
                    </span>{" "}
                    <span style={{ fontSize: 14, color: D.muted }}>
                      {fmtSize(doc.file_size)}
                    </span>{" "}
                  </div>
                  {doc.description && (
                    <div
                      style={{ fontSize: 14, color: D.muted, marginBottom: 6 }}
                    >
                      {doc.description}
                    </div>
                  )}
                  {(doc.technician_name || doc.expiration_date) && (
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        flexWrap: "wrap",
                        marginBottom: 6,
                      }}
                    >
                      {doc.technician_name && (
                        <span style={sBadge(D.teal + "22", D.teal)}>
                          {doc.technician_name}
                        </span>
                      )}
                      {doc.expiration_date &&
                        (() => {
                          // expiration_date is a SQL DATE (YYYY-MM-DD).
                          // new Date('2026-08-15') parses as UTC midnight,
                          // which is the prior evening in ET — off-by-one
                          // for the badge near midnight. Compare two
                          // YYYY-MM-DD anchors at noon UTC so calendar-day
                          // arithmetic stays clean across DST.
                          const expStr = String(doc.expiration_date).split(
                            "T",
                          )[0];
                          const todayStr = etDateString(new Date());
                          const exp = new Date(`${expStr}T12:00:00Z`);
                          const today = new Date(`${todayStr}T12:00:00Z`);
                          const days = Math.round(
                            (exp.getTime() - today.getTime()) / 86400000,
                          );
                          const expired = days < 0;
                          const soon = !expired && days <= 30;
                          const color = expired
                            ? D.red
                            : soon
                              ? D.amber
                              : D.muted;
                          return (
                            <span
                              style={{ fontSize: 14, color, fontFamily: MONO }}
                            >
                              {expired ? "Expired " : "Expires "}
                              {fmtYmdDate(doc.expiration_date)}
                              {expired
                                ? ` (${Math.abs(days)}d ago)`
                                : soon
                                  ? ` (${days}d)`
                                  : ""}
                            </span>
                          );
                        })()}
                    </div>
                  )}
                  <div style={{ fontSize: 14, color: D.muted }}>
                    Uploaded {fmtDate(doc.created_at)}
                  </div>{" "}
                </div>{" "}
              </div>{" "}
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginTop: 10,
                  borderTop: `1px solid ${D.border}`,
                  paddingTop: 10,
                }}
              >
                {" "}
                <button
                  onClick={() => handleDownload(doc)}
                  style={{
                    padding: "5px 12px",
                    background: D.teal + "22",
                    border: "none",
                    borderRadius: 6,
                    color: D.teal,
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  Download
                </button>{" "}
                {docsArchived ? (
                  <button
                    onClick={() => handleRestore(doc)}
                    style={{
                      padding: "5px 12px",
                      background: "transparent",
                      border: `1px solid ${D.border}`,
                      borderRadius: 6,
                      color: D.text,
                      fontSize: 14,
                      cursor: "pointer",
                    }}
                  >
                    Restore
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setEditingId(doc.id);
                        setEditForm({
                          title: doc.title,
                          category: doc.category,
                          description: doc.description || "",
                          technicianId: doc.technician_id || "",
                          expirationDate: doc.expiration_date
                            ? String(doc.expiration_date).split("T")[0]
                            : "",
                        });
                      }}
                      style={{
                        padding: "5px 12px",
                        background: "transparent",
                        border: `1px solid ${D.border}`,
                        borderRadius: 6,
                        color: D.muted,
                        fontSize: 14,
                        cursor: "pointer",
                      }}
                    >
                      Edit
                    </button>{" "}
                    <button
                      onClick={() => handleDelete(doc)}
                      style={{
                        padding: "5px 12px",
                        background: "transparent",
                        border: `1px solid ${D.border}`,
                        borderRadius: 6,
                        color: D.red,
                        fontSize: 14,
                        cursor: "pointer",
                      }}
                    >
                      Archive
                    </button>
                  </>
                )}{" "}
              </div>{" "}
            </div>
          );
        })}
      </div>
      {loadFailed && (
        <LoadFailedNotice onRetry={load}>Could not load documents.</LoadFailedNotice>
      )}
      {docs.length === 0 && !loadFailed && (docsArchived ? (
        <div style={{ ...sCard, textAlign: "center", padding: 24, color: D.muted, fontSize: 14 }}>
          No archived documents.
        </div>
      ) : !showUpload && (
        <div style={{ ...sCard, textAlign: "center", padding: 40 }}>
          {" "}
          <div style={{ fontSize: 32, marginBottom: 12 }}>
            {"\uD83D\uDCC1"}
          </div>{" "}
          <div
            style={{
              fontSize: 15,
              fontWeight: 500,
              color: D.heading,
              marginBottom: 6,
            }}
          >
            No documents yet
          </div>{" "}
          <div style={{ fontSize: 14, color: D.muted, marginBottom: 16 }}>
            Upload SOPs, onboarding packets, offer letters, and other internal
            documents.
          </div>{" "}
          <button
            onClick={() => setShowUpload(true)}
            style={sBtn(D.teal, D.white)}
          >
            + Upload First Document
          </button>{" "}
        </div>
      ))}
    </div>
  );
}
