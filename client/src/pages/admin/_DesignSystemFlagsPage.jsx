import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Button,
  Select,
  Switch,
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Badge,
} from '../../components/ui';
import { refetchFlags } from '../../hooks/useFeatureFlag';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, init) {
  const token = localStorage.getItem('waves_admin_token');
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init && init.headers),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  });
}

const KNOWN_FLAGS = [
  // dispatch-v2 retired — V1 SchedulePage default + DispatchGate gone,
  // /admin/dispatch and /admin/schedule both resolve to V2 (Board tab
  // + DispatchPageV2 under AdminDispatchPage).
  'newsletter-v1',
  'ff_invoice_send_receipt',
];

export default function DesignSystemFlagsPage() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [users, setUsers] = useState([]);
  const [flagKeys, setFlagKeys] = useState([]);
  const [states, setStates] = useState({});
  const [newFlag, setNewFlag] = useState('');
  const [newFlagUser, setNewFlagUser] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await adminFetch('/admin/feature-flags/all');
      setUsers(data.users || []);
      const merged = [...new Set([...(data.flag_keys || []), ...KNOWN_FLAGS])].sort();
      setFlagKeys(merged);
      setStates(data.states || {});
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (userId, flagKey, next) => {
    await adminFetch('/admin/feature-flags/toggle', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, flag_key: flagKey, enabled: next }),
    });
    setStates((prev) => ({
      ...prev,
      [userId]: { ...(prev[userId] || {}), [flagKey]: next },
    }));
    // Refetch the in-memory flag cache when the toggler IS the current user
    // so the change reflects without a full reload. waves_admin_user stores
    // the user record as JSON (not the bare id); parse before comparing.
    try {
      const raw = localStorage.getItem('waves_admin_user');
      const meId = raw && JSON.parse(raw)?.id;
      if (meId === userId) refetchFlags();
    } catch { /* legacy bare-id format — skip refetch */ }
  };

  const addFlag = async () => {
    const key = newFlag.trim();
    if (!key || !newFlagUser) return;
    await toggle(newFlagUser, key, true);
    setFlagKeys((prev) => [...new Set([...prev, key])].sort());
    setNewFlag('');
  };

  return (
    <div className="bg-surface-page min-h-full p-6 font-sans text-zinc-900">
      <header className="mb-6">
        <div className="text-11 uppercase tracking-label text-ink-secondary">
          Internal · Design System
        </div>
        <h1 className="text-28 font-normal tracking-tight">Feature Flags</h1>
        <p className="text-13 text-ink-secondary mt-1 max-w-2xl">
          Per-user on/off switches for in-flight work. Toggling reflects on the
          user's next page load. Absence of a row = disabled.
        </p>
      </header>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Enable a flag for a user</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[180px]">
              <label className="u-label block mb-1 text-ink-secondary">User</label>
              <Select
                value={newFlagUser}
                onChange={(e) => setNewFlagUser(e.target.value)}
                className="w-full"
              >
                <option value="">Select user…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.role})
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="u-label block mb-1 text-ink-secondary">Flag key</label>
              <Select
                value={newFlag}
                onChange={(e) => setNewFlag(e.target.value)}
                className="w-full"
              >
                <option value="">Select flag…</option>
                {[...new Set([...flagKeys, ...KNOWN_FLAGS])].sort().map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </Select>
            </div>
            <Button onClick={addFlag} disabled={!newFlag.trim() || !newFlagUser}>
              Enable
            </Button>
          </div>
        </CardBody>
      </Card>

      <MyFlagsCard
        users={users}
        flagKeys={flagKeys}
        states={states}
        toggle={toggle}
        loading={loading}
      />


      <Card>
        <CardHeader>
          <CardTitle>All flags × users</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          {err && (
            <div className="p-4 text-13 text-alert-fg">
              Error: {err}
            </div>
          )}
          {loading ? (
            <div className="p-6 text-13 text-ink-secondary">Loading…</div>
          ) : flagKeys.length === 0 ? (
            <div className="p-6 text-13 text-ink-secondary">
              No flags defined yet. Add one above.
            </div>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>User</TH>
                  <TH>Role</TH>
                  {flagKeys.map((k) => (
                    <TH key={k} align="center">
                      {k}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {users.map((u) => (
                  <TR key={u.id}>
                    <TD>{u.name}</TD>
                    <TD>
                      <Badge>{u.role}</Badge>
                    </TD>
                    {flagKeys.map((k) => {
                      const on = !!(states[u.id] && states[u.id][k]);
                      return (
                        <TD key={k} align="center">
                          <Switch
                            checked={on}
                            onChange={(next) => toggle(u.id, k, next)}
                          />
                        </TD>
                      );
                    })}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// Mobile-friendly single-user view. Resolves the current admin user from
// localStorage.waves_admin_user (set during login), falls back to matching
// role === 'admin' if localStorage is empty. Renders one vertical list of
// Name + Switch rows — no horizontal scrolling required to flip a flag.
function MyFlagsCard({ users, flagKeys, states, toggle, loading }) {
  const meId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem('waves_admin_user');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.id && users.some((u) => u.id === parsed.id)) return parsed.id;
      } catch {
        // Legacy format where the bare id was stored — fall through.
        if (users.some((u) => u.id === raw)) return raw;
      }
    }
    return users.find((u) => u.role === 'admin')?.id || null;
  }, [users]);

  const me = users.find((u) => u.id === meId);
  if (loading || !me) return null;
  const myState = states[meId] || {};

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Your flags — {me.name}</CardTitle>
      </CardHeader>
      <CardBody className="p-0">
        <ul className="divide-y divide-zinc-200">
          {flagKeys.map((k) => {
            const on = !!myState[k];
            return (
              <li
                key={k}
                className="flex items-center justify-between gap-3 px-4 py-3 min-h-[56px]"
              >
                <span className="text-14 text-ink-primary break-all">{k}</span>
                <Switch
                  checked={on}
                  onChange={(next) => toggle(meId, k, next)}
                />
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
