import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Badge,
  Button,
  buttonStyles,
  Card,
  Checkbox,
  Field,
  Input,
  Select,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Textarea,
} from "../../components/ui";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}
const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// The 9 GBP sub-tabs are grouped into 4 parent sections with a leaf sub-row.
// `subTab` state still holds the LEAF key, so every {subTab === "..."} block
// below is unchanged.
const GBP_TAB_GROUPS = [
  {
    key: "overview",
    label: "Overview",
    tabs: ["overview"],
  },
  {
    key: "profile",
    label: "Profile",
    tabs: ["info", "hours", "services", "photos"],
  },
  {
    key: "updates",
    label: "Updates",
    tabs: ["updates", "history", "bulk"],
  },
  {
    key: "alerts",
    label: "Alerts",
    tabs: ["notifications"],
  },
];
// ══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════
export default function GBPManagement() {
  const [locations, setLocations] = useState([]);
  const [selectedLoc, setSelectedLoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState("overview");
  const [updates, setUpdates] = useState([]);
  const [updatesFilter, setUpdatesFilter] = useState("pending");
  const [syncing, setSyncing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [toast, setToast] = useState("");

  // Load locations
  const loadLocations = useCallback(async () => {
    try {
      const d = await adminFetch("/admin/gbp/locations");
      setLocations(d.locations || []);
      if (d.locations?.length > 0 && !selectedLoc)
        setSelectedLoc(d.locations[0]);
    } catch {
      /* fallback to Places API data */
      try {
        const d = await adminFetch("/admin/reviews/gbp-locations");
        const locs = (d.locations || []).map((l) => ({
          ...l,
          gbp: null,
          hasCredentials: false,
          pendingUpdates: 0,
        }));
        setLocations(locs);
        if (locs.length > 0) setSelectedLoc(locs[0]);
      } catch {
        /* ignore */
      }
    }
    setLoading(false);
  }, []);
  const loadUpdates = useCallback(
    async (status) => {
      try {
        const d = await adminFetch(
          `/admin/gbp/updates?status=${status || updatesFilter}&limit=100`,
        );
        setUpdates(d.updates || []);
      } catch {
        setUpdates([]);
      }
    },
    [updatesFilter],
  );
  useEffect(() => {
    loadLocations();
  }, [loadLocations]);
  useEffect(() => {
    loadUpdates(updatesFilter);
  }, [updatesFilter]);
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };
  const handleSync = async (locId) => {
    setSyncing(true);
    try {
      const d = await adminFetch(`/admin/gbp/locations/${locId}/sync`, {
        method: "POST",
      });
      showToast(`Synced ${locId}: ${d.changesDetected} change(s) detected`);
      await loadLocations();
      await loadUpdates();
    } catch (e) {
      showToast(`Sync failed: ${e.message}`);
    }
    setSyncing(false);
  };
  const handleSyncAll = async () => {
    setSyncing(true);
    for (const loc of locations) {
      try {
        await adminFetch(`/admin/gbp/locations/${loc.id}/sync`, {
          method: "POST",
        });
      } catch {
        /* skip */
      }
    }
    showToast("All locations synced");
    await loadLocations();
    await loadUpdates();
    setSyncing(false);
  };
  const handlePush = async (locId) => {
    setPushing(true);
    try {
      const d = await adminFetch(`/admin/gbp/locations/${locId}/push`, {
        method: "POST",
      });
      showToast(`Pushed to Google: ${d.updatedFields?.join(", ")}`);
    } catch (e) {
      showToast(`Push failed: ${e.message}`);
    }
    setPushing(false);
  };
  const handleApprove = async (updateId) => {
    try {
      await adminFetch(`/admin/gbp/updates/${updateId}/approve`, {
        method: "POST",
      });
      showToast("Update approved");
      await loadUpdates();
      await loadLocations();
    } catch (e) {
      showToast(`Approve failed: ${e.message}`);
    }
  };
  const handleReject = async (updateId) => {
    try {
      await adminFetch(`/admin/gbp/updates/${updateId}/reject`, {
        method: "POST",
      });
      showToast("Update rejected");
      await loadUpdates();
    } catch (e) {
      showToast(`Reject failed: ${e.message}`);
    }
  };
  const handleBulkReject = async (ids) => {
    try {
      await adminFetch("/admin/gbp/updates/bulk-reject", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      showToast(`${ids.length} update(s) rejected`);
      await loadUpdates();
    } catch (e) {
      showToast(`Bulk reject failed: ${e.message}`);
    }
  };
  const loc = selectedLoc;
  const gbp = loc?.gbp;
  const subTabs = [
    {
      key: "overview",
      label: "Overview",
    },
    {
      key: "info",
      label: "Business Info",
    },
    {
      key: "hours",
      label: "Hours",
    },
    {
      key: "services",
      label: "Services",
    },
    {
      key: "photos",
      label: "Photos",
    },
    {
      key: "updates",
      label: "Update Queue",
      badge: locations.reduce((s, l) => s + (l.pendingUpdates || 0), 0),
    },
    {
      key: "history",
      label: "Change History",
    },
    {
      key: "bulk",
      label: "Bulk Edit",
    },
    {
      key: "notifications",
      label: "Alerts",
    },
  ];
  const subTabByKey = Object.fromEntries(subTabs.map((t) => [t.key, t]));
  const activeGroup =
    GBP_TAB_GROUPS.find((g) => g.tabs.includes(subTab)) || GBP_TAB_GROUPS[0];
  if (loading)
    return (
      <div className="text-ink-secondary p-[60px] text-center">
        Loading GBP data...
      </div>
    );
  return (
    <div>
      {/* Location Selector */}
      <div className="flex gap-[10px] mb-[20px] flex-wrap items-center">
        {locations.map((l) => (
          <Button
            key={l.id}
            onClick={() => {
              setSelectedLoc(l);
              setSubTab("overview");
            }}
            variant={selectedLoc?.id === l.id ? "primary" : "secondary"}
            className="min-w-[170px] text-left flex-col items-start"
          >
            {" "}
            <div className="text-ui-body font-medium">{l.name}</div>{" "}
            <div className="flex items-center gap-[6px] mt-[4px]">
              {l.rating && (
                <span className="text-ui-body font-medium">{l.rating}</span>
              )}
              <span className="text-ui-body">({l.totalReviews || 0})</span>
              {l.pendingUpdates > 0 && (
                <Badge tone="warn">{l.pendingUpdates} pending</Badge>
              )}
            </div>{" "}
            <div
              title={l.authError || ""}
              className={
                "text-ui-body mt-[4px] " +
                (selectedLoc?.id === l.id
                  ? "text-white"
                  : l.authError
                    ? "text-alert-fg"
                    : "text-ink-secondary")
              }
            >
              {l.hasCredentials
                ? "● API Connected"
                : l.authError
                  ? "● API auth error"
                  : "○ Places API only"}
            </div>{" "}
          </Button>
        ))}
        <Button onClick={handleSyncAll} disabled={syncing} variant="primary">
          {syncing ? "Syncing..." : "Sync All"}
        </Button>{" "}
      </div>
      {/* Sub-tabs: parent groups + leaf sub-row */}
      <div className="mb-2 flex flex-wrap gap-1">
        {GBP_TAB_GROUPS.map((g) => {
          const badge = g.tabs.reduce(
            (s, k) => s + (subTabByKey[k]?.badge || 0),
            0,
          );
          const isActive = activeGroup.key === g.key;
          return (
            <Button
              key={g.key}
              onClick={() => setSubTab(g.tabs[0])}
              variant={isActive ? "primary" : "secondary"}
            >
              {g.label}
              {badge > 0 && <span>{badge}</span>}
            </Button>
          );
        })}
      </div>
      {activeGroup.tabs.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1">
          {activeGroup.tabs.map((k) => {
            const t = subTabByKey[k];
            const isActive = subTab === k;
            return (
              <Button
                key={k}
                onClick={() => setSubTab(k)}
                variant={isActive ? "primary" : "secondary"}
              >
                {t.label}
                {t.badge > 0 && <span>{t.badge}</span>}
              </Button>
            );
          })}
        </div>
      )}
      {!loc ? (
        <Card className="mb-3 text-center p-[40px] text-ink-secondary">
          No locations available
        </Card>
      ) : (
        <>
          {subTab === "overview" && (
            <OverviewTab
              loc={loc}
              gbp={gbp}
              onSync={() => handleSync(loc.id)}
              onPush={() => handlePush(loc.id)}
              syncing={syncing}
              pushing={pushing}
            />
          )}
          {subTab === "info" && (
            <BusinessInfoTab
              loc={loc}
              gbp={gbp}
              onSave={loadLocations}
              showToast={showToast}
            />
          )}
          {subTab === "hours" && (
            <HoursTab
              loc={loc}
              gbp={gbp}
              onSave={loadLocations}
              showToast={showToast}
            />
          )}
          {subTab === "services" && (
            <ServicesTab
              loc={loc}
              gbp={gbp}
              onSave={loadLocations}
              showToast={showToast}
            />
          )}
          {subTab === "photos" && <PhotosTab loc={loc} gbp={gbp} />}
          {subTab === "updates" && (
            <UpdateQueueTab
              updates={updates.filter((u) => u.status === "pending")}
              locations={locations}
              onApprove={handleApprove}
              onReject={handleReject}
              onBulkReject={handleBulkReject}
            />
          )}
          {subTab === "history" && (
            <ChangeHistoryTab
              updates={updates}
              locations={locations}
              filter={updatesFilter}
              setFilter={setUpdatesFilter}
              loadUpdates={loadUpdates}
            />
          )}
          {subTab === "bulk" && (
            <BulkEditTab
              locations={locations}
              onSave={loadLocations}
              showToast={showToast}
            />
          )}
          {subTab === "notifications" && (
            <NotificationsTab showToast={showToast} />
          )}
        </>
      )}
      {/* Toast */}
      {toast && (
        <Card
          role="status"
          className="fixed bottom-5 right-5 z-[130] p-3 text-ui-body font-medium shadow-lg pointer-events-none"
        >
          {toast}
        </Card>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// OVERVIEW TAB
// ══════════════════════════════════════════════════════════════
function OverviewTab({ loc, gbp, onSync, onPush, syncing, pushing }) {
  const info = gbp || {};
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
      {/* Left — Profile Summary */}
      <Card className="p-5 mb-3">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900 mb-[16px]">
          Profile Summary
        </div>
        {[
          {
            label: "Business Name",
            value: info.business_name || loc.name,
          },
          {
            label: "Address",
            value: info.address || loc.address,
          },
          {
            label: "Phone",
            value: info.phone || loc.phone,
          },
          {
            label: "Website",
            value: info.website_url,
            link: true,
          },
          {
            label: "Primary Category",
            value: info.primary_category || "pest_control",
          },
          {
            label: "Store Code",
            value: info.store_code || "—",
          },
          {
            label: "Place ID",
            value: loc.googlePlaceId,
          },
          {
            label: "Last Synced",
            value: info.last_synced_at
              ? new Date(info.last_synced_at).toLocaleString()
              : "Never",
          },
        ].map((f, i) => (
          <div
            key={i}
            className="flex justify-between items-start py-2 border-b border-hairline border-zinc-200"
          >
            {" "}
            <span className="text-ui-body text-ink-secondary font-medium min-w-[120px]">
              {f.label}
            </span>
            {f.link ? (
              <a
                href={f.value}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ui-body text-zinc-900 text-right max-w-[280px] overflow-hidden whitespace-nowrap"
              >
                {f.value || "—"}
              </a>
            ) : (
              <span className="text-ui-body text-zinc-900 text-right max-w-[280px]">
                {f.value || "—"}
              </span>
            )}
          </div>
        ))}
      </Card>
      {/* Right — Rating + Actions */}
      <div className="flex flex-col gap-[16px]">
        {" "}
        <Card className="p-5 mb-3 text-center">
          {" "}
          <div className="text-[48px] font-medium text-zinc-900">
            {loc.rating || "—"}
          </div>{" "}
          <div className="text-ui-body text-ink-secondary mt-[4px]">
            {loc.totalReviews || 0} reviews on Google
          </div>{" "}
          <div className="flex gap-[8px] mt-[16px] justify-center flex-wrap">
            {loc.mapsUrl && (
              <a
                href={loc.mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonStyles({
                  variant: "primary",
                  density: "comfortable",
                })}
              >
                View on Maps
              </a>
            )}
            {loc.googleReviewUrl && (
              <a
                href={loc.googleReviewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonStyles({
                  variant: "secondary",
                  density: "comfortable",
                })}
              >
                Review Link
              </a>
            )}
          </div>{" "}
        </Card>{" "}
        <Card className="p-5 mb-3">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900 mb-[12px]">
            Actions
          </div>{" "}
          <div className="flex flex-col gap-[8px]">
            {" "}
            <Button
              onClick={onSync}
              disabled={syncing}
              variant="primary"
              className="w-full"
            >
              {syncing ? "Syncing from Google..." : "Sync from Google"}
            </Button>{" "}
            <Button
              onClick={onPush}
              disabled={pushing || !loc.hasCredentials}
              variant="primary"
              className="w-full"
            >
              {pushing ? "Pushing..." : "Push to Google"}
            </Button>
            {!loc.hasCredentials && (
              <div className="text-ui-body text-alert-fg text-center">
                OAuth not configured — push disabled
              </div>
            )}
            <a
              href={`https://business.google.com/dashboard/l/${loc.googlePlaceId}`}
              className={buttonStyles({
                variant: "secondary",
                density: "comfortable",
                className: "text-center",
              })}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Google Business
            </a>{" "}
            <a
              href={`https://business.google.com/posts/l/${loc.googlePlaceId}`}
              className={buttonStyles({
                variant: "secondary",
                density: "comfortable",
                className: "text-center",
              })}
              target="_blank"
              rel="noopener noreferrer"
            >
              Create Google Post
            </a>{" "}
          </div>{" "}
        </Card>
        {/* SAB indicator */}
        {info.hide_address && (
          <Card className="p-5 mb-3">
            {" "}
            <div className="text-ui-body font-medium text-zinc-900 mb-[4px]">
              Service-Area Business
            </div>{" "}
            <div className="text-ui-body text-ink-secondary">
              Address is hidden on Google. This location serves customers at
              their premises.
            </div>
            {info.service_areas &&
              (() => {
                const areas =
                  typeof info.service_areas === "string"
                    ? JSON.parse(info.service_areas)
                    : info.service_areas;
                return (
                  areas.length > 0 && (
                    <div className="text-ui-body text-zinc-900 mt-[8px]">
                      Areas: {areas.map((a) => a.name || a).join(", ")}
                    </div>
                  )
                );
              })()}
          </Card>
        )}
      </div>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// BUSINESS INFO TAB — editable fields
// ══════════════════════════════════════════════════════════════
function BusinessInfoTab({ loc, gbp, onSave, showToast }) {
  const [form, setForm] = useState({
    business_name: "",
    description: "",
    phone: "",
    website_url: "",
    primary_category: "",
    store_code: "",
    hide_address: false,
  });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (gbp) {
      setForm({
        business_name: gbp.business_name || loc.name || "",
        description: gbp.description || "",
        phone: gbp.phone || loc.phone || "",
        website_url: gbp.website_url || "",
        primary_category: gbp.primary_category || "",
        store_code: gbp.store_code || "",
        hide_address: gbp.hide_address || false,
      });
    }
  }, [gbp, loc]);
  const handleSave = async () => {
    setSaving(true);
    try {
      await adminFetch(`/admin/gbp/locations/${loc.id}`, {
        method: "PUT",
        body: JSON.stringify(form),
      });
      showToast("Profile updated");
      onSave();
    } catch (e) {
      showToast(`Save failed: ${e.message}`);
    }
    setSaving(false);
  };
  return (
    <div className="max-w-[700px]">
      {" "}
      <Card className="p-5 mb-3">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900 mb-[16px]">
          Edit Business Information
        </div>{" "}
        <FieldGroup>
          {" "}
          <Field label="Business Name">
            <Input
              value={form.business_name}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  business_name: e.target.value,
                }))
              }
            />
          </Field>{" "}
          <Field label="Phone">
            <Input
              value={form.phone}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  phone: e.target.value,
                }))
              }
            />
          </Field>{" "}
        </FieldGroup>{" "}
        <Field label="Website URL">
          <Input
            value={form.website_url}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                website_url: e.target.value,
              }))
            }
          />
        </Field>{" "}
        <Field label="Primary Category">
          <Input
            value={form.primary_category}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                primary_category: e.target.value,
              }))
            }
            placeholder="e.g. pest_control_service"
          />
        </Field>{" "}
        <Field label="Store Code">
          <Input
            value={form.store_code}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                store_code: e.target.value,
              }))
            }
            placeholder="Optional identifier"
          />
        </Field>{" "}
        <Field label="Description">
          <Textarea
            value={form.description}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                description: e.target.value,
              }))
            }
            rows={4}
            placeholder="Business description shown on Google..."
            className="resize-y"
          />
        </Field>{" "}
        <label className="flex items-center gap-[10px] cursor-pointer text-ui-body text-zinc-900 mb-[16px]">
          {" "}
          <Checkbox
            checked={form.hide_address}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                hide_address: e.target.checked,
              }))
            }
          />
          Service-Area Business (hide address)
        </label>{" "}
        <div className="flex gap-[8px]">
          {" "}
          <Button onClick={handleSave} disabled={saving} variant="primary">
            {saving ? "Saving..." : "Save Changes"}
          </Button>{" "}
          <Button
            onClick={() => showToast("Push to Google to apply changes")}
            variant="secondary"
          >
            Push to Google
          </Button>{" "}
        </div>{" "}
      </Card>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// HOURS TAB
// ══════════════════════════════════════════════════════════════
function HoursTab({ loc, gbp, onSave, showToast }) {
  const [hours, setHours] = useState({});
  const [specialHours, setSpecialHours] = useState([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (gbp?.regular_hours) {
      const h =
        typeof gbp.regular_hours === "string"
          ? JSON.parse(gbp.regular_hours)
          : gbp.regular_hours;
      setHours(h);
    }
    if (gbp?.special_hours) {
      const sh =
        typeof gbp.special_hours === "string"
          ? JSON.parse(gbp.special_hours)
          : gbp.special_hours;
      setSpecialHours(sh);
    }
  }, [gbp]);
  const updateDay = (day, field, value) => {
    setHours((prev) => ({
      ...prev,
      [day]: {
        ...(prev[day] || {}),
        [field]: value,
      },
    }));
  };
  const addSpecialHour = () => {
    setSpecialHours((prev) => [
      ...prev,
      {
        date: "",
        open: "08:00",
        close: "17:00",
        closed: false,
      },
    ]);
  };
  const updateSpecial = (idx, field, value) => {
    setSpecialHours((prev) =>
      prev.map((s, i) =>
        i === idx
          ? {
              ...s,
              [field]: value,
            }
          : s,
      ),
    );
  };
  const removeSpecial = (idx) => {
    setSpecialHours((prev) => prev.filter((_, i) => i !== idx));
  };
  const handleSave = async () => {
    setSaving(true);
    try {
      await adminFetch(`/admin/gbp/locations/${loc.id}/hours`, {
        method: "PUT",
        body: JSON.stringify({ hours }),
      });
      if (specialHours.length > 0) {
        await adminFetch(`/admin/gbp/locations/${loc.id}/special-hours`, {
          method: "PUT",
          body: JSON.stringify({ specialHours }),
        });
      }
      showToast("Hours updated");
      onSave();
    } catch (e) {
      showToast(`Save failed: ${e.message}`);
    }
    setSaving(false);
  };
  const isToday = (day) =>
    DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1] === day;
  return (
    <div className="max-w-[600px]">
      {" "}
      <Card className="p-5 mb-3">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900 mb-[16px]">
          Regular Hours
        </div>
        {DAYS.map((day) => {
          const h = hours[day] || {};
          const today = isToday(day);
          return (
            <div
              key={day}
              className={`flex items-center gap-3 rounded-md mb-1 border border-hairline px-3 py-2 ${today ? "border-zinc-400 bg-zinc-50" : "border-zinc-200"}`}
            >
              {" "}
              <span className="text-ui-body w-[100px]">{day}</span>{" "}
              <Input
                type="time"
                value={h.open || "08:00"}
                onChange={(e) => updateDay(day, "open", e.target.value)}
                className="w-[120px]"
              />{" "}
              <span className="text-ink-secondary text-ui-body">to</span>{" "}
              <Input
                type="time"
                value={h.close || "17:00"}
                onChange={(e) => updateDay(day, "close", e.target.value)}
                className="w-[120px]"
              />{" "}
            </div>
          );
        })}
      </Card>{" "}
      <Card className="p-5 mb-3">
        {" "}
        <div className="flex justify-between items-center mb-[16px]">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900">
            Special Hours
          </div>{" "}
          <Button onClick={addSpecialHour} variant="primary">
            + Add
          </Button>{" "}
        </div>
        {specialHours.length === 0 ? (
          <div className="text-ink-secondary text-ui-body text-center p-[20px]">
            No special hours set. Add holidays, seasonal hours, etc.
          </div>
        ) : (
          specialHours.map((sh, i) => (
            <div
              key={i}
              className="flex items-center gap-[8px] mb-[8px] p-[10px] bg-white rounded-md"
            >
              {" "}
              <Input
                type="date"
                value={sh.date}
                onChange={(e) => updateSpecial(i, "date", e.target.value)}
                className="w-[150px]"
              />{" "}
              <label className="flex items-center gap-[4px] text-ui-body text-ink-secondary cursor-pointer">
                {" "}
                <Checkbox
                  checked={sh.closed}
                  onChange={(e) => updateSpecial(i, "closed", e.target.checked)}
                />
                Closed
              </label>
              {!sh.closed && (
                <>
                  {" "}
                  <Input
                    type="time"
                    value={sh.open}
                    onChange={(e) => updateSpecial(i, "open", e.target.value)}
                    className="w-[110px]"
                  />{" "}
                  <span className="text-ink-secondary text-ui-body">to</span>{" "}
                  <Input
                    type="time"
                    value={sh.close}
                    onChange={(e) => updateSpecial(i, "close", e.target.value)}
                    className="w-[110px]"
                  />{" "}
                </>
              )}
              <Button onClick={() => removeSpecial(i)} variant="danger">
                ×
              </Button>{" "}
            </div>
          ))
        )}
      </Card>{" "}
      <Button onClick={handleSave} disabled={saving} variant="primary">
        {saving ? "Saving..." : "Save Hours"}
      </Button>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SERVICES TAB
// ══════════════════════════════════════════════════════════════
function ServicesTab({ loc, gbp, onSave, showToast }) {
  const [services, setServices] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [newService, setNewService] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingSugg, setLoadingSugg] = useState(false);
  useEffect(() => {
    if (gbp?.services) {
      const s =
        typeof gbp.services === "string"
          ? JSON.parse(gbp.services)
          : gbp.services;
      setServices(s);
    }
  }, [gbp]);
  const loadSuggestions = async () => {
    setLoadingSugg(true);
    try {
      const d = await adminFetch(
        `/admin/gbp/services/suggestions?category=${encodeURIComponent(gbp?.primary_category || "pest_control")}`,
      );
      setSuggestions(d.services || []);
    } catch {
      setSuggestions([]);
    }
    setLoadingSugg(false);
  };
  useEffect(() => {
    loadSuggestions();
  }, [gbp?.primary_category]);
  const addService = (name) => {
    if (!name.trim() || services.includes(name.trim())) return;
    setServices((prev) => [...prev, name.trim()]);
    setNewService("");
  };
  const removeService = (idx) => {
    setServices((prev) => prev.filter((_, i) => i !== idx));
  };
  const handleSave = async () => {
    setSaving(true);
    try {
      await adminFetch(`/admin/gbp/locations/${loc.id}/services`, {
        method: "PUT",
        body: JSON.stringify({ services }),
      });
      showToast("Services updated");
      onSave();
    } catch (e) {
      showToast(`Save failed: ${e.message}`);
    }
    setSaving(false);
  };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-[16px]">
      {/* Current services */}
      <Card className="p-5 mb-3">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900 mb-[16px]">
          Current Services ({services.length})
        </div>{" "}
        <div className="flex gap-[8px] mb-[16px]">
          {" "}
          <Input
            value={newService}
            onChange={(e) => setNewService(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addService(newService)}
            placeholder="Add a service..."
            className="flex-[1]"
          />{" "}
          <Button onClick={() => addService(newService)} variant="primary">
            Add
          </Button>{" "}
        </div>
        {services.length === 0 ? (
          <div className="text-ink-secondary text-ui-body text-center p-[20px]">
            No services listed yet
          </div>
        ) : (
          <div className="flex flex-col gap-[4px]">
            {services.map((s, i) => (
              <div
                key={i}
                className="flex justify-between items-center bg-white rounded-md text-ui-body text-zinc-900"
              >
                {s}
                <Button onClick={() => removeService(i)} variant="danger">
                  ×
                </Button>{" "}
              </div>
            ))}
          </div>
        )}
        <Button
          onClick={handleSave}
          disabled={saving}
          variant="primary"
          className="mt-[16px]"
        >
          {saving ? "Saving..." : "Save Services"}
        </Button>{" "}
      </Card>
      {/* Suggested services */}
      <Card className="p-5 mb-3">
        {" "}
        <div className="flex justify-between items-center mb-[16px]">
          {" "}
          <div className="text-ui-body font-medium text-zinc-900">
            Google Suggestions
          </div>{" "}
          <Button
            onClick={loadSuggestions}
            disabled={loadingSugg}
            variant="secondary"
          >
            {loadingSugg ? "Loading..." : "Refresh"}
          </Button>{" "}
        </div>{" "}
        <div className="text-ui-body text-ink-secondary mb-[12px]">
          Click to add to your profile
        </div>{" "}
        <div className="flex flex-wrap gap-[6px]">
          {suggestions
            .filter((s) => !services.includes(s))
            .map((s, i) => (
              <Button key={i} onClick={() => addService(s)} variant="secondary">
                {s}
              </Button>
            ))}
          {suggestions.length === 0 && (
            <div className="text-ink-secondary text-ui-body">
              No suggestions available
            </div>
          )}
        </div>{" "}
      </Card>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PHOTOS TAB
// ══════════════════════════════════════════════════════════════
function PhotosTab({ loc, gbp }) {
  const photos = useMemo(() => {
    if (!gbp?.photos) return loc.photos || [];
    const p =
      typeof gbp.photos === "string" ? JSON.parse(gbp.photos) : gbp.photos;
    return p.length > 0 ? p : loc.photos || [];
  }, [gbp, loc]);
  return (
    <div>
      {" "}
      <div className="flex justify-between items-center mb-[16px]">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900">
          {loc.name} Photos ({photos.length})
        </div>{" "}
        <a
          href={`https://business.google.com/photos/l/${loc.googlePlaceId}`}
          className={buttonStyles({
            variant: "secondary",
            density: "comfortable",
          })}
          target="_blank"
          rel="noopener noreferrer"
        >
          Manage on Google
        </a>{" "}
      </div>
      {photos.length === 0 ? (
        <Card className="mb-3 text-center p-[40px] text-ink-secondary">
          No photos found
        </Card>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-[12px]">
          {photos.map((photo, i) => (
            <div
              key={i}
              className="rounded-md overflow-hidden border-hairline border-zinc-200 bg-white"
            >
              {" "}
              <img
                src={photo.url || photo.name}
                alt={`${loc.name} photo ${i + 1}`}
                loading="lazy"
                onError={(e) => {
                  e.target.style.display = "none";
                }}
                className="w-full h-[180px] block object-cover"
              />{" "}
              <div className="text-ui-body text-ink-secondary">
                {photo.widthPx || photo.width}x{photo.heightPx || photo.height}
              </div>{" "}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// UPDATE QUEUE TAB
// ══════════════════════════════════════════════════════════════
function UpdateQueueTab({
  updates,
  locations,
  onApprove,
  onReject,
  onBulkReject,
}) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const toggleSel = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const locName = (id) => locations.find((l) => l.id === id)?.name || id;
  const fieldLabel = (f) =>
    f.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <div>
      {" "}
      <div className="flex justify-between items-center mb-[16px]">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900">
          Pending Updates ({updates.length})
        </div>
        {selectedIds.size > 0 && (
          <Button
            onClick={() => {
              onBulkReject([...selectedIds]);
              setSelectedIds(new Set());
            }}
            variant="danger"
          >
            Reject Selected ({selectedIds.size})
          </Button>
        )}
      </div>
      {updates.length === 0 ? (
        <Card className="mb-3 text-center p-[40px] text-ink-secondary">
          {" "}
          <div className="text-[24px] mb-[8px]"></div>{" "}
          <div className="text-ui-body">No pending updates</div>{" "}
          <div className="text-ui-body mt-[4px]">
            All changes have been reviewed
          </div>{" "}
        </Card>
      ) : (
        <div className="grid gap-[8px]">
          {updates.map((u) => (
            <Card key={u.id} className="p-5 flex items-start gap-[12px]">
              {" "}
              <Checkbox
                checked={selectedIds.has(u.id)}
                onChange={() => toggleSel(u.id)}
                className="mt-[4px] cursor-pointer"
              />{" "}
              <div className="flex-[1]">
                {" "}
                <div className="flex justify-between items-center mb-[6px]">
                  {" "}
                  <div className="flex items-center gap-[8px]">
                    {" "}
                    <span className="text-ui-body font-medium text-zinc-900">
                      {fieldLabel(u.field_name)}
                    </span>{" "}
                    <Badge tone="neutral">{locName(u.location_id)}</Badge>{" "}
                    <Badge tone="neutral">{u.source}</Badge>{" "}
                  </div>{" "}
                  <span className="text-ui-body text-ink-secondary">
                    {new Date(u.detected_at).toLocaleString()}
                  </span>{" "}
                </div>{" "}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-[8px] text-ui-body">
                  {" "}
                  <div className="p-[10px] rounded-md border-hairline border-zinc-200">
                    {" "}
                    <div className="text-ui-body text-ink-secondary font-medium mb-[4px]">
                      OLD VALUE
                    </div>{" "}
                    <div className="text-ink-secondary max-h-[60px] overflow-hidden break-all">
                      {u.old_value || "(empty)"}
                    </div>{" "}
                  </div>{" "}
                  <div className="p-[10px] rounded-md border-hairline border-zinc-200">
                    {" "}
                    <div className="text-ui-body text-zinc-900 font-medium mb-[4px]">
                      NEW VALUE
                    </div>{" "}
                    <div className="text-zinc-900 max-h-[60px] overflow-hidden break-all">
                      {u.new_value || "(empty)"}
                    </div>{" "}
                  </div>{" "}
                </div>{" "}
              </div>{" "}
              <div className="flex flex-col gap-[6px]">
                {" "}
                <Button onClick={() => onApprove(u.id)} variant="primary">
                  Approve
                </Button>{" "}
                <Button onClick={() => onReject(u.id)} variant="danger">
                  Reject
                </Button>{" "}
              </div>{" "}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CHANGE HISTORY TAB
// ══════════════════════════════════════════════════════════════
function ChangeHistoryTab({
  updates,
  locations,
  filter,
  setFilter,
  loadUpdates,
}) {
  const locName = (id) => locations.find((l) => l.id === id)?.name || id;
  const fieldLabel = (f) =>
    f.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  // Main colored pending amber, approved green, rejected red; approved
  // (done) gets strong, pending gets warn, rejected keeps the genuine-alert
  // tone.
  const statusTone = (status) =>
    status === "approved"
      ? "strong"
      : status === "rejected"
        ? "alert"
        : status === "pending"
          ? "warn"
          : "neutral";
  useEffect(() => {
    loadUpdates(filter);
  }, [filter, loadUpdates]);
  return (
    <div>
      {" "}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-[16px]">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900">
          Change History
        </div>{" "}
        <div className="flex flex-wrap gap-[4px]">
          {["all", "pending", "approved", "rejected"].map((f) => (
            <Button
              key={f}
              onClick={() => {
                setFilter(f === "all" ? "" : f);
              }}
              variant={
                (filter || "") === (f === "all" ? "" : f)
                  ? "primary"
                  : "secondary"
              }
            >
              {f}
            </Button>
          ))}
        </div>{" "}
      </div>{" "}
      <Table className="w-full">
        <THead>
          <TR>
            {["Location", "Field", "Source", "Status", "Old → New", "Date"].map(
              (h) => (
                <TH key={h} className="text-ink-secondary text-left">
                  {h}
                </TH>
              ),
            )}
          </TR>
        </THead>
        <TBody>
          {updates.map((u) => (
            <TR key={u.id}>
              <TD>{locName(u.location_id)}</TD>
              <TD className="text-zinc-900">{fieldLabel(u.field_name)}</TD>
              <TD>
                <Badge tone="neutral">{u.source}</Badge>
              </TD>
              <TD>
                <Badge tone={statusTone(u.status)}>{u.status}</Badge>
              </TD>
              <TD className="text-ink-secondary max-w-[250px] overflow-hidden whitespace-nowrap">
                {(u.old_value || "").substring(0, 30)} →{" "}
                {(u.new_value || "").substring(0, 30)}
              </TD>
              <TD className="text-ink-secondary">
                {new Date(u.detected_at).toLocaleDateString()}
              </TD>
            </TR>
          ))}
          {updates.length === 0 && (
            <TR>
              <TD
                colSpan={6}
                className="p-[30px] text-center text-ink-secondary"
              >
                No changes found
              </TD>
            </TR>
          )}
        </TBody>
      </Table>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// BULK EDIT TAB
// ══════════════════════════════════════════════════════════════
function BulkEditTab({ locations, onSave, showToast }) {
  const [selectedLocs, setSelectedLocs] = useState(new Set());
  const [field, setField] = useState("description");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const fields = [
    {
      value: "description",
      label: "Description",
    },
    {
      value: "phone",
      label: "Phone",
    },
    {
      value: "website_url",
      label: "Website URL",
    },
    {
      value: "services",
      label: "Services (JSON)",
    },
    {
      value: "hide_address",
      label: "Hide Address",
    },
  ];
  const toggleLoc = (id) => {
    setSelectedLocs((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const selectAll = () => {
    if (selectedLocs.size === locations.length) setSelectedLocs(new Set());
    else setSelectedLocs(new Set(locations.map((l) => l.id)));
  };
  const handleApply = async () => {
    if (selectedLocs.size === 0) {
      showToast("Select at least one location");
      return;
    }
    setSaving(true);
    try {
      let parsedValue = value;
      if (field === "services") parsedValue = JSON.parse(value);
      if (field === "hide_address") parsedValue = value === "true";
      await adminFetch("/admin/gbp/locations/bulk-edit", {
        method: "POST",
        body: JSON.stringify({
          locationIds: [...selectedLocs],
          field,
          value: parsedValue,
        }),
      });
      showToast(`Updated "${field}" for ${selectedLocs.size} location(s)`);
      onSave();
    } catch (e) {
      showToast(`Bulk edit failed: ${e.message}`);
    }
    setSaving(false);
  };
  return (
    <div className="max-w-[700px]">
      {" "}
      <Card className="p-5 mb-3">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900 mb-[16px]">
          Bulk Edit Locations
        </div>{" "}
        <div className="mb-[16px]">
          {" "}
          <span>Select Locations</span>{" "}
          <div className="flex gap-[8px] flex-wrap mt-[4px]">
            {" "}
            <Button onClick={selectAll} variant="secondary">
              {selectedLocs.size === locations.length
                ? "Deselect All"
                : "Select All"}
            </Button>
            {locations.map((l) => (
              <label
                key={l.id}
                className="flex items-center gap-[6px] cursor-pointer text-ui-body rounded-md border-hairline border-zinc-200"
              >
                {" "}
                <Checkbox
                  checked={selectedLocs.has(l.id)}
                  onChange={() => toggleLoc(l.id)}
                />
                {l.name}
              </label>
            ))}
          </div>{" "}
        </div>{" "}
        <FieldGroup>
          {" "}
          <Field label="Field to Edit">
            <Select value={field} onChange={(e) => setField(e.target.value)}>
              {fields.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>{" "}
        </FieldGroup>{" "}
        <Field label="New Value">
          {field === "description" ? (
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={4}
              placeholder="Enter the value to apply to all selected locations..."
              className="resize-y"
            />
          ) : field === "hide_address" ? (
            <Select value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="false">Show Address</option>
              <option value="true">Hide Address (SAB)</option>
            </Select>
          ) : (
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter value..."
            />
          )}
        </Field>{" "}
        <Button
          onClick={handleApply}
          disabled={saving || selectedLocs.size === 0}
          variant="primary"
        >
          {saving ? "Applying..." : `Apply to ${selectedLocs.size} Location(s)`}
        </Button>{" "}
      </Card>{" "}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// NOTIFICATIONS TAB
// ══════════════════════════════════════════════════════════════
function NotificationsTab({ showToast }) {
  const [prefs, setPrefs] = useState({
    frequency: "daily",
    field_filters: [],
    enabled: true,
  });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    adminFetch("/admin/gbp/notifications?email=admin@wavespestcontrol.com")
      .then((d) => {
        if (d.preferences) setPrefs(d.preferences);
      })
      .catch(() => {});
  }, []);
  const handleSave = async () => {
    setSaving(true);
    try {
      await adminFetch("/admin/gbp/notifications", {
        method: "PUT",
        body: JSON.stringify({
          email: "admin@wavespestcontrol.com",
          ...prefs,
          field_filters: prefs.field_filters || [],
        }),
      });
      showToast("Notification preferences saved");
    } catch (e) {
      showToast(`Save failed: ${e.message}`);
    }
    setSaving(false);
  };
  const fieldOptions = [
    "business_name",
    "phone",
    "address",
    "website_url",
    "regular_hours",
    "description",
    "primary_category",
    "photos",
    "services",
    "attributes",
  ];
  const toggleField = (f) => {
    const filters = prefs.field_filters || [];
    if (filters.includes(f))
      setPrefs((p) => ({
        ...p,
        field_filters: filters.filter((x) => x !== f),
      }));
    else
      setPrefs((p) => ({
        ...p,
        field_filters: [...filters, f],
      }));
  };
  return (
    <div className="max-w-[600px]">
      {" "}
      <Card className="p-5 mb-3">
        {" "}
        <div className="text-ui-body font-medium text-zinc-900 mb-[16px]">
          GBP Change Alerts
        </div>{" "}
        <label className="flex items-center gap-[10px] cursor-pointer text-ui-body text-zinc-900 mb-[16px]">
          {" "}
          <Checkbox
            checked={prefs.enabled}
            onChange={(e) =>
              setPrefs((p) => ({
                ...p,
                enabled: e.target.checked,
              }))
            }
            className="w-[18px] h-[18px]"
          />
          Enable notifications
        </label>{" "}
        <Field label="Frequency">
          <Select
            value={prefs.frequency}
            onChange={(e) =>
              setPrefs((p) => ({
                ...p,
                frequency: e.target.value,
              }))
            }
          >
            <option value="realtime">Real-time (every change)</option>
            <option value="daily">Daily digest</option>
            <option value="weekly">Weekly digest</option>
            <option value="monthly">Monthly digest</option>
          </Select>
        </Field>{" "}
        <div className="mb-[16px]">
          {" "}
          <span>
            Alert on these fields only (leave empty = all fields)
          </span>{" "}
          <div className="flex flex-wrap gap-[6px] mt-[8px]">
            {fieldOptions.map((f) => {
              const active = (prefs.field_filters || []).includes(f);
              return (
                <Button
                  key={f}
                  onClick={() => toggleField(f)}
                  variant={active ? "primary" : "secondary"}
                >
                  {f.replace(/_/g, " ")}
                </Button>
              );
            })}
          </div>{" "}
        </div>{" "}
        <Button onClick={handleSave} disabled={saving} variant="primary">
          {saving ? "Saving..." : "Save Preferences"}
        </Button>{" "}
      </Card>{" "}
    </div>
  );
}

// ── Shared layout helpers ──
function FieldGroup({ children }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-[12px]">{children}</div>
  );
}
