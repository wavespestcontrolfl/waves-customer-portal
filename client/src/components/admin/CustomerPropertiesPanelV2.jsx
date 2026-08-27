import { useEffect, useState } from "react";
import { Button, Card, CardBody } from "../ui";
import { OCCUPANCY_OPTIONS } from "../../lib/contact-roles";
import { adminFetch } from "../../utils/admin-fetch";

// customer_properties column widths (server PROPERTY_FIELD_LIMITS mirrors
// migration 20260629000001); the server 400s past these too.
const LIMITS = { address_line1: 200, address_line2: 100, city: 50, zip: 10, label: 100 };
const PROPERTY_LABEL_MAX = LIMITS.label;

const EMPTY_FORM = {
  address_line1: "",
  address_line2: "",
  city: "",
  state: "FL",
  zip: "",
  occupancy_type: "unknown",
  label: "",
};

function formatPropertyAddress(p) {
  const street = [p.address_line1, p.address_line2].filter(Boolean).join(", ");
  const locality = [p.city, [p.state, p.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" ");
  return [street, locality].filter(Boolean).join(", ");
}

/**
 * Service addresses on file for one customer (customer_properties). Reads
 * GET /admin/customers/:id/properties; adds via POST; edits occupancy/label
 * via PATCH — the same admin-only endpoints the call pipeline's manual lane
 * uses, so the dedupe / primary-fence rules are the server's, not ours.
 *
 * Writes (add, occupancy, label) share ONE lock — a single request in flight,
 * every write control disabled meanwhile — because each response replaces
 * the list.
 *
 * The PRIMARY row is the customer's default service address (it mirrors
 * customers.address_*). For a property manager that is NOT a residence —
 * the panel says so instead of letting the star imply "lives here".
 */
export default function CustomerPropertiesPanelV2({
  customerId,
  contactRole,
  canEdit = false,
  // Any value the parent changes when the profile address is saved (the PUT
  // path syncs the primary customer_properties row) — the panel refetches so
  // the primary row never lags the refreshed profile.
  refreshToken = "",
  // Called after a successful add. Adding the FIRST address to an
  // address-less profile makes it primary and mirrors it into
  // customers.address_* server-side — the parent must reload so the
  // header/map don't keep rendering the stale (empty) profile address.
  onChanged = null,
}) {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [rowBusy, setRowBusy] = useState(null);
  const [rowErr, setRowErr] = useState("");
  // Inline label editing: { id, value } while a row's label input is open.
  const [labelEdit, setLabelEdit] = useState(null);
  // ONE write lock for additions and row edits: every response replaces the
  // whole list, so an overlapping POST and PATCH could let an older snapshot
  // land last and hide the new row / revert the edit.
  const writeBusy = saving || !!rowBusy;

  useEffect(() => {
    if (!customerId) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadErr("");
    adminFetch(`/admin/customers/${customerId}/properties`)
      .then((d) => {
        if (!cancelled) setProperties(Array.isArray(d.properties) ? d.properties : []);
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(e.message || "Could not load properties");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, refreshToken]);

  const submitAdd = async (e) => {
    e.preventDefault();
    setSaveErr("");
    if (!form.address_line1.trim() || !form.city.trim() || !form.zip.trim()) {
      setSaveErr("Street, city and ZIP are required.");
      return;
    }
    // Required: the server defaults a missing state to FL, so an empty field
    // must be a visible validation error rather than a silent Florida.
    const stateCode = form.state.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(stateCode)) {
      setSaveErr("State is required as a two-letter code (e.g. FL).");
      return;
    }
    if (writeBusy) return;
    setSaving(true);
    try {
      const d = await adminFetch(`/admin/customers/${customerId}/properties`, {
        method: "POST",
        body: JSON.stringify({
          address_line1: form.address_line1.trim(),
          address_line2: form.address_line2.trim() || null,
          city: form.city.trim(),
          state: stateCode,
          zip: form.zip.trim(),
          occupancy_type: form.occupancy_type || "unknown",
          label: form.label.trim() || null,
        }),
      });
      setProperties(Array.isArray(d.properties) ? d.properties : []);
      setForm(EMPTY_FORM);
      setAdding(false);
      if (typeof onChanged === "function") {
        try {
          await onChanged();
        } catch {
          /* the list above is already fresh — a profile reload miss is not a save failure */
        }
      }
    } catch (err) {
      setSaveErr(err.message || "Could not add property");
    } finally {
      setSaving(false);
    }
  };

  // One PATCH at a time: every response replaces the whole list, so two
  // in-flight edits could let an older snapshot overwrite the newer one.
  // All row controls are disabled while rowBusy is set (see below).
  const patchRow = async (propertyId, patch) => {
    if (writeBusy) return;
    setRowBusy(propertyId);
    setRowErr("");
    try {
      const d = await adminFetch(
        `/admin/customers/${customerId}/properties/${propertyId}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      setProperties(Array.isArray(d.properties) ? d.properties : []);
    } catch (err) {
      setRowErr(err.message || "Could not update property");
    } finally {
      setRowBusy(null);
    }
  };

  const commitLabel = async () => {
    if (!labelEdit) return;
    const { id, value } = labelEdit;
    const current = properties.find((p) => p.id === id);
    const next = value.trim();
    setLabelEdit(null);
    if (!current || (current.label || "") === next) return;
    await patchRow(id, { label: next || null });
  };

  const isManager = contactRole === "property_manager";
  const inputCls =
    "w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring";

  return (
    <Card className="mb-5" data-testid="customer-properties-panel">
      <CardBody className="p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="u-label text-ink-secondary">
            Service addresses ({properties.length})
          </div>
          {canEdit && !adding && (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              Add service address
            </Button>
          )}
        </div>
        <div className="text-12 text-ink-secondary mb-3">
          {isManager
            ? "This contact is a property manager — the primary row is the default service address on the profile, not a residence."
            : "The primary row is the address on the profile; every other row is an additional serviced property."}
        </div>

        {loading && <div className="text-12 text-ink-secondary">Loading…</div>}
        {loadErr && (
          <div className="px-2 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-12">{loadErr}</div>
        )}

        {!loading && !loadErr && (
          <div className="divide-y divide-zinc-200/60">
            {properties.map((p) => (
              <div
                key={p.id}
                className="py-2 flex flex-col sm:flex-row sm:items-center gap-2"
                data-testid="customer-property-row"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-13 text-zinc-900 break-words">
                    {p.is_primary && (
                      <span
                        className="text-10 uppercase tracking-label text-ink-tertiary mr-1.5"
                        title={isManager ? "Default service address" : "Address on the profile"}
                      >
                        {isManager ? "Default" : "Primary"}
                      </span>
                    )}
                    {formatPropertyAddress(p)}
                  </div>
                  {labelEdit?.id === p.id ? (
                    <input
                      aria-label={`Label for ${p.address_line1}`}
                      autoFocus
                      value={labelEdit.value}
                      maxLength={PROPERTY_LABEL_MAX}
                      onChange={(e) =>
                        setLabelEdit((le) => (le ? { ...le, value: e.target.value } : le))
                      }
                      onBlur={commitLabel}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitLabel();
                        } else if (e.key === "Escape") {
                          // The 360 drawer closes on a window-level Escape —
                          // cancelling a label edit must not close the profile.
                          e.preventDefault();
                          e.stopPropagation();
                          e.nativeEvent?.stopImmediatePropagation?.();
                          setLabelEdit(null);
                        }
                      }}
                      className="mt-1 w-full max-w-xs h-8 px-2 text-12 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
                    />
                  ) : canEdit ? (
                    <button
                      type="button"
                      aria-label={`Edit label for ${p.address_line1}`}
                      disabled={writeBusy}
                      onClick={() => setLabelEdit({ id: p.id, value: p.label || "" })}
                      className="block p-0 border-0 bg-transparent text-12 text-ink-secondary hover:text-zinc-900 hover:underline u-focus-ring text-left disabled:opacity-50"
                    >
                      {p.label || "Add label"}
                    </button>
                  ) : (
                    p.label && (
                      <div className="text-12 text-ink-secondary">{p.label}</div>
                    )
                  )}
                </div>
                <select
                  aria-label={`Occupancy for ${p.address_line1}`}
                  value={p.occupancy_type || "unknown"}
                  disabled={!canEdit || writeBusy}
                  onChange={(e) => patchRow(p.id, { occupancy_type: e.target.value })}
                  className="text-12 text-zinc-900 border border-hairline border-zinc-300 rounded-xs px-2 py-1 bg-white"
                >
                  {OCCUPANCY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            {properties.length === 0 && (
              <div className="text-12 text-ink-secondary py-2">No properties on file.</div>
            )}
          </div>
        )}
        {rowErr && (
          <div className="mt-2 px-2 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-12">{rowErr}</div>
        )}

        {adding && (
          <form onSubmit={submitAdd} className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="sm:col-span-2">
              <label className="u-label text-ink-secondary block mb-1" htmlFor="cp-line1">
                Street address
              </label>
              <input
                id="cp-line1"
                className={inputCls}
                maxLength={LIMITS.address_line1}
                value={form.address_line1}
                onChange={(e) => setForm((f) => ({ ...f, address_line1: e.target.value }))}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="u-label text-ink-secondary block mb-1" htmlFor="cp-line2">
                Unit / line 2
              </label>
              <input
                id="cp-line2"
                className={inputCls}
                maxLength={LIMITS.address_line2}
                value={form.address_line2}
                onChange={(e) => setForm((f) => ({ ...f, address_line2: e.target.value }))}
              />
            </div>
            <div>
              <label className="u-label text-ink-secondary block mb-1" htmlFor="cp-city">
                City
              </label>
              <input
                id="cp-city"
                className={inputCls}
                maxLength={LIMITS.city}
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="u-label text-ink-secondary block mb-1" htmlFor="cp-state">
                  State
                </label>
                <input
                  id="cp-state"
                  className={inputCls}
                  value={form.state}
                  maxLength={2}
                  placeholder="FL"
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      state: e.target.value.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 2),
                    }))
                  }
                />
              </div>
              <div>
                <label className="u-label text-ink-secondary block mb-1" htmlFor="cp-zip">
                  ZIP
                </label>
                <input
                  id="cp-zip"
                  className={inputCls}
                  maxLength={LIMITS.zip}
                  value={form.zip}
                  onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <label className="u-label text-ink-secondary block mb-1" htmlFor="cp-occ">
                Occupancy
              </label>
              <select
                id="cp-occ"
                className={inputCls}
                value={form.occupancy_type}
                onChange={(e) => setForm((f) => ({ ...f, occupancy_type: e.target.value }))}
              >
                {OCCUPANCY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="u-label text-ink-secondary block mb-1" htmlFor="cp-label">
                Label (optional)
              </label>
              <input
                id="cp-label"
                className={inputCls}
                maxLength={PROPERTY_LABEL_MAX}
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              />
            </div>
            {saveErr && (
              <div className="sm:col-span-2 px-2 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-12">
                {saveErr}
              </div>
            )}
            <div className="sm:col-span-2 flex gap-2 justify-end">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setAdding(false);
                  setSaveErr("");
                  setForm(EMPTY_FORM);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={writeBusy}>
                {saving ? "Saving…" : "Save address"}
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
