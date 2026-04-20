import React, { useEffect, useState, useCallback } from 'react';
import {
  Button,
  Input,
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

const KNOWN_FLAGS = ['dashboard-v2', 'dispatch-v2', 'customers-v2', 'estimates-v2', 'comms-v2', 'mobile-shell-v2', 'newsletter-v1'];

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
    const me = localStorage.getItem('waves_admin_user');
    if (me === userId) refetchFlags();
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
            <div>
              <label className="u-label block mb-1 text-ink-secondary">User</label>
              <Select
                value={newFlagUser}
                onChange={(e) => setNewFlagUser(e.target.value)}
                className="w-56"
              >
                <option value="">Select user…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.role})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="u-label block mb-1 text-ink-secondary">Flag key</label>
              <Input
                placeholder="dashboard-v2"
                value={newFlag}
                onChange={(e) => setNewFlag(e.target.value)}
                className="w-56"
              />
            </div>
            <Button onClick={addFlag} disabled={!newFlag.trim() || !newFlagUser}>
              Enable
            </Button>
          </div>
        </CardBody>
      </Card>

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
