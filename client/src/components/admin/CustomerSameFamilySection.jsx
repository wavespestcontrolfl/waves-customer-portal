import { useEffect, useState } from "react";
import { Button } from "../ui";
import { adminFetch } from "../../utils/admin-fetch";

// "Same family" link between customer profiles (owner 2026-11-04). Staff group
// profiles so the 10% Multi-Home Discount counts them as one family.
// GET/POST/DELETE /admin/customers/:id/multi-home-family are requireAdmin, so
// the parent panel mounts this only for an admin; a technician sees nothing.
// Linking sends nothing and changes no price.

const inputCls =
  "w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring";

function customerName(c) {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unnamed customer";
}

function LinkPicker({ query, onQuery, searchFailed, results, picked, onPick, busy, onCancel, onLink }) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-ui-label text-zinc-900">
        Search customers
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Name, phone or email"
          className={inputCls}
        />
      </label>
      {searchFailed && <div className="text-ui-label text-alert-fg">The search did not load. Type again to retry.</div>}
      {Array.isArray(results) && results.length === 0 && (
        <div className="text-ui-label text-ink-secondary">No customer matches.</div>
      )}
      {Array.isArray(results) && results.length > 0 && (
        <ul className="flex flex-col gap-1 list-none m-0 p-0">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                aria-pressed={picked?.id === c.id}
                onClick={() => onPick(c)}
                className={`w-full text-left border border-hairline border-solid rounded-sm px-3 py-1.5 text-ui-label ${picked?.id === c.id ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 bg-white"}`}
              >
                {customerName(c)}{c.address ? ` · ${c.address}` : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" disabled={!picked || busy} onClick={onLink}>{busy ? "Linking…" : "Link"}</Button>
      </div>
    </div>
  );
}

function FamilyMemberRow({ member }) {
  return (
    <div className="py-2" data-testid="same-family-member">
      <div className="text-ui-body text-zinc-900 break-words">{member.name}</div>
      {member.address && <div className="text-ui-label text-ink-secondary break-words">{member.address}</div>}
      {!member.active && <div className="text-ui-label text-ink-secondary">Inactive profile (does not count until active)</div>}
    </div>
  );
}

function UnlinkControl({ busy, confirmingUnlink, onAskUnlink, onKeep, onUnlink }) {
  if (!confirmingUnlink) {
    return <Button size="sm" variant="secondary" disabled={busy} onClick={onAskUnlink}>Unlink</Button>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-ui-label text-zinc-900">Remove this profile from the family?</span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={onKeep}>Keep link</Button>
      <Button size="sm" disabled={busy} onClick={onUnlink}>{busy ? "Removing…" : "Unlink"}</Button>
    </div>
  );
}

// Who is in this profile's family, and the Unlink control. A profile can be in
// a family with no other member on file (after a merge or a delete); it still
// gets Unlink so staff can clear it.
function FamilyMembers({ familyId, others, linking, ...unlinkProps }) {
  if (!familyId) {
    return linking ? null : <div className="text-ui-label text-ink-secondary">Not linked to another profile.</div>;
  }
  return (
    <div className="divide-y divide-zinc-200/60">
      {others.length === 0 && (
        <div className="py-2 text-ui-label text-ink-secondary" data-testid="same-family-alone">
          In a family, but no other profile in it is still on file (merged or deleted). Unlink to clear it, then link again.
        </div>
      )}
      {others.map((m) => <FamilyMemberRow key={m.id} member={m} />)}
      <div className="py-2"><UnlinkControl {...unlinkProps} /></div>
    </div>
  );
}

export default function CustomerSameFamilySection({ customerId }) {
  const [members, setMembers] = useState([]);
  const [familyId, setFamilyId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState("");
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const [linking, setLinking] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const [picked, setPicked] = useState(null);

  useEffect(() => {
    if (!customerId) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadErr("");
    setActionErr("");
    setConfirmingUnlink(false);
    setLinking(false);
    adminFetch(`/admin/customers/${customerId}/multi-home-family`)
      .then((d) => {
        if (!cancelled) {
          setMembers(Array.isArray(d?.members) ? d.members : []);
          setFamilyId(d?.familyId || null);
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(e.message || "Could not load the family link");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [customerId]);

  useEffect(() => {
    const term = query.trim();
    if (!linking || term.length < 2) {
      setResults(null);
      setSearchFailed(false);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      adminFetch(`/admin/customers?search=${encodeURIComponent(term)}&limit=10`)
        .then((data) => {
          if (cancelled) return;
          setResults(Array.isArray(data?.customers) ? data.customers.filter((c) => c.id !== customerId) : []);
          setSearchFailed(false);
        })
        .catch(() => {
          if (cancelled) return;
          setResults(null);
          setSearchFailed(true);
        });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [linking, query, customerId]);

  const others = members.filter((m) => !m.isSelf);

  const closeLink = () => {
    setLinking(false);
    setQuery("");
    setResults(null);
    setPicked(null);
  };

  const link = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setActionErr("");
    try {
      const d = await adminFetch(`/admin/customers/${customerId}/multi-home-family`, {
        method: "POST",
        body: JSON.stringify({ otherCustomerId: picked.id }),
      });
      setMembers(Array.isArray(d?.members) ? d.members : []);
      setFamilyId(d?.familyId || null);
      closeLink();
    } catch (err) {
      setActionErr(err.message || "Could not link the profile");
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (busy) return;
    setBusy(true);
    setActionErr("");
    try {
      const d = await adminFetch(`/admin/customers/${customerId}/multi-home-family`, { method: "DELETE" });
      setMembers(Array.isArray(d?.members) ? d.members : []);
      setFamilyId(d?.familyId || null);
      setConfirmingUnlink(false);
    } catch (err) {
      setActionErr(err.message || "Could not remove the family link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 pt-3 border-t border-hairline border-zinc-200" data-testid="same-family-section">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="ui-label text-ink-secondary">Same family</div>
        {!linking && !loading && !loadErr && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setLinking(true); setActionErr(""); }}>
            Link a profile
          </Button>
        )}
      </div>
      <div className="text-ui-label text-ink-secondary mb-3">
        Profiles linked here count as one family for the 10% Multi-Home Discount. Linking sends nothing and changes no price.
      </div>

      {loading && <div className="text-ui-label text-ink-secondary">Loading…</div>}
      {loadErr && (
        <div className="px-2 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">{loadErr}</div>
      )}

      {!loading && !loadErr && (
        <FamilyMembers
          familyId={familyId}
          others={others}
          linking={linking}
          busy={busy}
          confirmingUnlink={confirmingUnlink}
          onAskUnlink={() => { setConfirmingUnlink(true); setActionErr(""); }}
          onKeep={() => setConfirmingUnlink(false)}
          onUnlink={unlink}
        />
      )}

      {linking && (
        <LinkPicker
          query={query}
          onQuery={(value) => { setQuery(value); setPicked(null); }}
          searchFailed={searchFailed}
          results={results}
          picked={picked}
          onPick={setPicked}
          busy={busy}
          onCancel={closeLink}
          onLink={link}
        />
      )}

      {actionErr && (
        <div className="mt-2 px-2 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label" role="alert">{actionErr}</div>
      )}
    </div>
  );
}
