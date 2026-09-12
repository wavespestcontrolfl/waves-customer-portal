import { useCallback, useEffect, useState } from "react";
import {
  BarChart3,
  DollarSign,
  Gift,
  LayoutDashboard,
  ListChecks,
  Settings,
  Users,
} from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
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
  Field,
  Input,
  Select,
  Switch,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  UiSurface,
} from "../../components/ui";
import { getAdminUser } from "../../lib/adminAuth";

const API = import.meta.env.VITE_API_URL || "/api";

function af(path, opts = {}) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...opts,
  }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
}

const fc = (c) => "$" + (c / 100).toFixed(2);
const fd = (d) => "$" + parseFloat(d || 0).toFixed(2);
const MILESTONE_LABELS = {
  none: "--",
  advocate: "Advocate",
  ambassador: "Ambassador",
  champion: "Champion",
};
// Referral status is one of pending/contacted/estimated/sms_failed/
// signed_up/credited/rejected/lost; payout status is pending/applied. Main
// colors sms_failed/rejected red (genuine alert) and signed_up/credited/
// applied green (kept via the kit's "strong" tone — the established
// substitute across Tier1 migrations; the kit has no green tone), folding
// everything else (pending/contacted/estimated/lost) to neutral.
const STATUS_ALERTS = new Set(["sms_failed", "rejected"]);
const STATUS_STRONG = new Set(["signed_up", "credited", "applied"]);

function StatusBadge({ status }) {
  return (
    <Badge
      tone={
        STATUS_ALERTS.has(status)
          ? "alert"
          : STATUS_STRONG.has(status)
            ? "strong"
            : "neutral"
      }
    >
      {status?.replaceAll("_", " ") || "--"}
    </Badge>
  );
}

function MilestoneBadge({ level }) {
  const label = MILESTONE_LABELS[level] || level;
  if (!level || level === "none")
    return <span className="text-ink-secondary">--</span>;
  return (
    <Badge tone={level === "champion" ? "strong" : "neutral"}>{label}</Badge>
  );
}

function Stat({ label, value, sub }) {
  return (
    <Card className="min-w-[150px] flex-1 border-0 bg-zinc-50">
      <CardBody>
        <div className="text-14 font-medium text-ink-secondary">{label}</div>
        {/* text-20 is not a configured font-size utility (Tailwind emits no
            rule for it), silently collapsing this KPI to the inherited
            14px body size. Main used an explicit 24px; the nearest
            configured token in tailwind.config.js's fontSize scale
            (11/12/13/14/16/18/22/28 — no 20 or 24) is 22. */}
        <div className="mt-1 text-22 font-medium tabular-nums text-zinc-900">
          {value}
        </div>
        {sub && <div className="mt-1 text-14 text-ink-secondary">{sub}</div>}
      </CardBody>
    </Card>
  );
}

function EmptyState({ children }) {
  return (
    <p className="m-0 py-5 text-center text-14 text-ink-secondary">
      {children}
    </p>
  );
}

const REFERRALS_TAB_LEAVES = [
  { key: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { key: "queue", label: "Queue", Icon: ListChecks },
  { key: "promoters", label: "Promoters", Icon: Users },
  { key: "payouts", label: "Payouts", Icon: DollarSign },
  { key: "analytics", label: "Analytics", Icon: BarChart3 },
  { key: "settings", label: "Settings", Icon: Settings },
];
const REFERRALS_TAB_GROUPS = [
  {
    key: "overview",
    label: "Overview",
    Icon: LayoutDashboard,
    tabs: ["dashboard", "analytics"],
  },
  { key: "queue", label: "Queue", Icon: ListChecks, tabs: ["queue"] },
  {
    key: "promoters",
    label: "Promoters",
    Icon: Users,
    tabs: ["promoters", "payouts"],
  },
  { key: "settings", label: "Settings", Icon: Settings, tabs: ["settings"] },
];
const REFERRALS_LEAF_BY_KEY = Object.fromEntries(
  REFERRALS_TAB_LEAVES.map((leaf) => [leaf.key, leaf]),
);

const SETTINGS_FIELDS = [
  {
    section: "Rewards",
    items: [
      {
        key: "referrer_reward_cents",
        label: "Referrer Reward (cents)",
        type: "number",
      },
      {
        key: "referee_discount_cents",
        label: "Referee Discount (cents)",
        type: "number",
      },
    ],
  },
  {
    section: "Tier Bonuses",
    items: [
      {
        key: "bonus_silver_cents",
        label: "Silver Bonus (cents)",
        type: "number",
      },
      { key: "bonus_gold_cents", label: "Gold Bonus (cents)", type: "number" },
      {
        key: "bonus_platinum_cents",
        label: "Platinum Bonus (cents)",
        type: "number",
      },
    ],
  },
  {
    section: "Milestones",
    items: [
      {
        key: "milestone_3_bonus_cents",
        label: "3 Referrals Bonus (cents)",
        type: "number",
      },
      {
        key: "milestone_5_bonus_cents",
        label: "5 Referrals Bonus (cents)",
        type: "number",
      },
      {
        key: "milestone_10_bonus_cents",
        label: "10 Referrals Bonus (cents)",
        type: "number",
      },
    ],
  },
  {
    section: "Fraud Prevention",
    items: [
      {
        key: "max_referrals_per_month",
        label: "Max Referrals / Month",
        type: "number",
      },
      { key: "cooldown_days", label: "Cooldown Days", type: "number" },
      { key: "min_payout_cents", label: "Min Payout (cents)", type: "number" },
    ],
  },
  {
    section: "Program",
    items: [
      { key: "program_active", label: "Program Active", type: "boolean" },
      { key: "auto_credit_enabled", label: "Auto Credit", type: "boolean" },
      {
        key: "require_service_completion",
        label: "Require 1st Service",
        type: "boolean",
      },
      { key: "base_url", label: "Base URL", type: "text" },
    ],
  },
  {
    section: "SMS Templates",
    items: [
      { key: "invite_sms_template", label: "Invite SMS", type: "textarea" },
      { key: "reward_sms_template", label: "Reward SMS", type: "textarea" },
      {
        key: "milestone_sms_template",
        label: "Milestone SMS",
        type: "textarea",
      },
    ],
  },
];

export default function ReferralsPageV2() {
  const [tab, setTab] = useState("dashboard");
  const [stats, setStats] = useState(null);
  const [promoters, setPromoters] = useState([]);
  const [queue, setQueue] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [settings, setSettings] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [msg, setMsg] = useState(null);
  const [convertModal, setConvertModal] = useState(null);
  const [enrollModal, setEnrollModal] = useState(false);
  const [settingsEditing, setSettingsEditing] = useState(null);
  const [custSearch, setCustSearch] = useState("");
  const [custResults, setCustResults] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [approvingPayout, setApprovingPayout] = useState(null);
  const [refForm, setRefForm] = useState({
    promoterId: "",
    name: "",
    phone: "",
    email: "",
    address: "",
    notes: "",
  });

  const flash = useCallback((message) => {
    setMsg(message);
    window.setTimeout(() => setMsg(null), 3000);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      af("/admin/referrals/stats").catch(() => null),
      af("/admin/referrals/promoters?status=all").catch(() => ({
        promoters: [],
      })),
      af("/admin/referrals/queue").catch(() => ({ referrals: [] })),
      af("/admin/referrals/payouts").catch(() => ({ payouts: [] })),
    ]).then(([s, p, q, pay]) => {
      setStats(s);
      setPromoters(p.promoters || []);
      setQueue(q.referrals || []);
      setPayouts(pay.payouts || []);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab === "settings" && !settings)
      af("/admin/referrals/settings")
        .then((r) => setSettings(r.settings))
        .catch(() => {});
    if (tab === "analytics" && !analytics)
      af("/admin/referrals/analytics")
        .then((r) => setAnalytics(r))
        .catch(() => {});
  }, [tab]);

  const searchCustomers = async (q) => {
    setCustSearch(q);
    if (q.length < 2) {
      setCustResults([]);
      return;
    }
    try {
      const r = await af(
        `/admin/customers?search=${encodeURIComponent(q)}&limit=8`,
      );
      setCustResults(r.customers || []);
    } catch {
      setCustResults([]);
    }
  };

  const handleEnroll = async (customerId) => {
    setEnrolling(true);
    try {
      await af("/admin/referrals/enroll", {
        method: "POST",
        body: JSON.stringify({ customerId }),
      });
      flash("Promoter enrolled");
      setEnrollModal(false);
      setCustSearch("");
      setCustResults([]);
      load();
    } catch (error) {
      flash("Error: " + error.message);
    } finally {
      setEnrolling(false);
    }
  };

  const isAdmin = getAdminUser()?.role === "admin";
  const handleStatusChange = async (id, status) => {
    try {
      await af(`/admin/referrals/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      load();
    } catch (error) {
      flash("Error: " + error.message);
    }
  };

  const handleConvert = async () => {
    if (!convertModal) return;
    setConverting(true);
    try {
      await af(`/admin/referrals/${convertModal.id}/convert`, {
        method: "POST",
        body: JSON.stringify({
          customerId: convertModal.customerId,
          tier: convertModal.tier,
          monthlyValue: convertModal.monthlyValue,
        }),
      });
      flash("Referral converted");
      setConvertModal(null);
      setCustSearch("");
      setCustResults([]);
      load();
    } catch (error) {
      flash("Error: " + error.message);
    } finally {
      setConverting(false);
    }
  };

  const handleApprovePayout = async (id) => {
    setApprovingPayout(id);
    try {
      await af(`/admin/referrals/payouts/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      flash("Payout approved");
      load();
    } catch (error) {
      flash("Error: " + error.message);
    } finally {
      setApprovingPayout(null);
    }
  };

  const handleSaveSettings = async () => {
    if (!settingsEditing) return;
    setSavingSettings(true);
    try {
      const result = await af("/admin/referrals/settings", {
        method: "PUT",
        body: JSON.stringify(settingsEditing),
      });
      setSettings(result.settings);
      setSettingsEditing(null);
      flash("Settings saved");
    } catch (error) {
      flash("Error: " + error.message);
    } finally {
      setSavingSettings(false);
    }
  };

  const copyLink = async (link) => {
    try {
      await navigator.clipboard.writeText(link);
      flash("Copied");
    } catch (error) {
      flash("Error: " + error.message);
    }
  };

  const handleSubmitRef = async () => {
    if (!refForm.name || !refForm.phone) return;
    setSubmitting(true);
    try {
      await af("/admin/referrals/submit", {
        method: "POST",
        body: JSON.stringify(refForm),
      });
      setRefForm({
        promoterId: "",
        name: "",
        phone: "",
        email: "",
        address: "",
        notes: "",
      });
      flash("Referral submitted");
      load();
    } catch (error) {
      flash("Error: " + error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const activeGroup =
    REFERRALS_TAB_GROUPS.find((group) => group.tabs.includes(tab)) ||
    REFERRALS_TAB_GROUPS[0];
  const secondarySections =
    activeGroup.tabs.length > 1
      ? activeGroup.tabs.map((key) => REFERRALS_LEAF_BY_KEY[key])
      : [];
  const filteredPromoters = search
    ? promoters.filter((promoter) =>
        `${promoter.first_name} ${promoter.last_name} ${promoter.customer_phone} ${promoter.referral_code}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : promoters;
  const header = (
    <AdminCommandHeader
      title="Referrals"
      icon={Gift}
      sections={REFERRALS_TAB_GROUPS.map((group) =>
        group.key === "queue"
          ? { ...group, label: `${group.label} (${queue.length})` }
          : group,
      )}
      activeKey={activeGroup.key}
      onSectionChange={(key) => {
        const group = REFERRALS_TAB_GROUPS.find((item) => item.key === key);
        if (group) setTab(group.tabs[0]);
      }}
      ariaLabel="Referrals section"
      secondarySections={secondarySections}
      secondaryActiveKey={tab}
      onSecondaryChange={setTab}
      secondaryAriaLabel={`${activeGroup.label} views`}
      variant="workspace"
    />
  );

  if (loading)
    return (
      <UiSurface
        density="comfortable"
        className="mx-auto max-w-[1300px] text-ui-body text-ink-primary"
      >
        {header}
        <Card>
          <CardBody>
            <EmptyState>Loading referral program...</EmptyState>
          </CardBody>
        </Card>
      </UiSurface>
    );

  return (
    <UiSurface
      density="comfortable"
      className="mx-auto max-w-[1300px] space-y-4 text-ui-body text-ink-primary"
    >
      {header}
      {msg && (
        <ActionFeedback error={msg.startsWith("Error:")}>{msg}</ActionFeedback>
      )}

      {tab === "dashboard" && stats && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Stat label="Active Promoters" value={stats.activePromoters} />
            <Stat
              label="Referrals"
              value={stats.totalReferrals}
              sub={`${stats.convertedReferrals} converted`}
            />
            <Stat label="Pending" value={stats.pendingReferrals} />
            <Stat label="Total Rewards" value={fd(stats.totalRewardsDollars)} />
            <Stat
              label="Paid Out"
              value={fc(stats.totalPaidOutCents)}
              sub={`${stats.pendingPayouts} pending`}
            />
            <Stat label="Program ROI" value={`${stats.programROI}%`} />
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Recent Activity</CardTitle>
              </CardHeader>
              <CardBody>
                {queue.length === 0 ? (
                  <EmptyState>No referrals yet</EmptyState>
                ) : (
                  queue.slice(0, 8).map((referral) => (
                    <div
                      key={referral.id}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline border-zinc-200 py-3 last:border-0"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-zinc-900">
                          {referral.referee_name ||
                            `${referral.referral_first_name || ""} ${referral.referral_last_name || ""}`.trim()}
                        </div>
                        <div className="text-14 text-ink-secondary">
                          from{" "}
                          {referral.promoter_first
                            ? `${referral.promoter_first} ${referral.promoter_last}`
                            : "--"}{" "}
                          / {referral.source || "portal"}
                        </div>
                      </div>
                      <StatusBadge status={referral.status} />
                    </div>
                  ))
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Top Promoters</CardTitle>
              </CardHeader>
              <CardBody>
                {promoters.filter(
                  (promoter) => promoter.total_referrals_converted > 0,
                ).length === 0 && (
                  <EmptyState>No converted referrals yet</EmptyState>
                )}
                {promoters
                  .filter((promoter) => promoter.total_referrals_converted > 0)
                  .slice(0, 8)
                  .map((promoter) => (
                    <div
                      key={promoter.id}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline border-zinc-200 py-3 last:border-0"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <div>
                          <div className="font-medium text-zinc-900">
                            {promoter.first_name} {promoter.last_name}
                          </div>
                          <div className="text-14 text-ink-secondary">
                            {promoter.total_referrals_converted} converted /{" "}
                            {promoter.total_referrals_sent} sent
                          </div>
                        </div>
                        <MilestoneBadge
                          level={promoter.milestone_level || "none"}
                        />
                      </div>
                      <div className="font-medium tabular-nums text-zinc-900">
                        {fc(promoter.total_earned_cents)}
                      </div>
                    </div>
                  ))}
              </CardBody>
            </Card>
          </div>
        </div>
      )}

      {tab === "queue" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Submit Referral</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Field label="Friend's name" required>
                  <Input
                    value={refForm.name}
                    onChange={(event) =>
                      setRefForm((form) => ({
                        ...form,
                        name: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Phone" required>
                  <Input
                    value={refForm.phone}
                    onChange={(event) =>
                      setRefForm((form) => ({
                        ...form,
                        phone: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Email">
                  <Input
                    type="email"
                    value={refForm.email}
                    onChange={(event) =>
                      setRefForm((form) => ({
                        ...form,
                        email: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Promoter ID">
                  <Input
                    value={refForm.promoterId}
                    onChange={(event) =>
                      setRefForm((form) => ({
                        ...form,
                        promoterId: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Address">
                  <Input
                    value={refForm.address}
                    onChange={(event) =>
                      setRefForm((form) => ({
                        ...form,
                        address: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Notes">
                  <Input
                    value={refForm.notes}
                    onChange={(event) =>
                      setRefForm((form) => ({
                        ...form,
                        notes: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <div className="ui-record-actions justify-end">
                <Button
                  onClick={handleSubmitRef}
                  loading={submitting}
                  disabled={!refForm.name || !refForm.phone}
                >
                  Submit
                </Button>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Referral Queue ({queue.length})</CardTitle>
            </CardHeader>
            <CardBody className="p-0">
              {queue.length === 0 ? (
                <EmptyState>No pending referrals</EmptyState>
              ) : (
                <Table layout="records">
                  <THead>
                    <TR>
                      <TH>Referral</TH>
                      <TH>From</TH>
                      <TH>Source</TH>
                      <TH>Status</TH>
                      <TH>Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {queue.map((referral) => (
                      <TR key={referral.id}>
                        <TD data-label="Referral">
                          <div className="font-medium text-zinc-900">
                            {referral.referee_name ||
                              `${referral.referral_first_name || ""} ${referral.referral_last_name || ""}`.trim()}
                          </div>
                          <div className="text-14 text-ink-secondary">
                            {referral.referee_phone || referral.referral_phone}
                            {referral.referee_email || referral.referral_email
                              ? ` / ${referral.referee_email || referral.referral_email}`
                              : ""}
                          </div>
                        </TD>
                        <TD data-label="From">
                          {referral.promoter_first
                            ? `${referral.promoter_first} ${referral.promoter_last}`
                            : "--"}
                        </TD>
                        <TD data-label="Source">
                          {referral.source || "portal"}
                        </TD>
                        <TD data-label="Status">
                          <StatusBadge status={referral.status} />
                        </TD>
                        <TD data-label="Actions">
                          <div className="ui-record-actions">
                            {isAdmin &&
                              ["pending", "sms_failed"].includes(
                                referral.status,
                              ) && (
                                <Button
                                  variant="secondary"
                                  onClick={() =>
                                    handleStatusChange(referral.id, "contacted")
                                  }
                                >
                                  Contacted
                                </Button>
                              )}
                            {[
                              "contacted",
                              "estimated",
                              "pending",
                              "sms_failed",
                            ].includes(referral.status) && (
                              <Button
                                variant="secondary"
                                onClick={(event) => {
                                  event.currentTarget.focus({
                                    preventScroll: true,
                                  });
                                  setConvertModal({
                                    id: referral.id,
                                    name:
                                      referral.referee_name ||
                                      referral.referral_first_name,
                                    customerId: "",
                                    tier: "",
                                    monthlyValue: "",
                                  });
                                }}
                              >
                                Convert
                              </Button>
                            )}
                            {isAdmin &&
                              !["signed_up", "credited", "rejected"].includes(
                                referral.status,
                              ) && (
                                <Button
                                  variant="danger"
                                  onClick={() =>
                                    handleStatusChange(referral.id, "rejected")
                                  }
                                >
                                  Reject
                                </Button>
                              )}
                          </div>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {tab === "promoters" && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <Field label="Search promoters" className="w-full sm:max-w-sm">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
            <Button
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                setEnrollModal(true);
              }}
            >
              Enroll Customer
            </Button>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Promoters ({filteredPromoters.length})</CardTitle>
            </CardHeader>
            <CardBody className="p-0">
              <Table layout="records">
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Code</TH>
                    <TH>Link</TH>
                    <TH>Clicks</TH>
                    <TH>Referrals</TH>
                    <TH>Milestone</TH>
                    <TH>Available</TH>
                    <TH>Pending</TH>
                  </TR>
                </THead>
                <TBody>
                  {filteredPromoters.map((promoter) => (
                    <TR key={promoter.id}>
                      <TD data-label="Name">
                        <span className="font-medium text-zinc-900">
                          {promoter.first_name} {promoter.last_name}
                        </span>
                        <div className="text-14 text-ink-secondary">
                          {promoter.customer_phone}
                        </div>
                      </TD>
                      <TD data-label="Code" className="font-mono">
                        {promoter.referral_code || "--"}
                      </TD>
                      <TD data-label="Link">
                        {promoter.referral_link ? (
                          <Button
                            variant="secondary"
                            onClick={() => copyLink(promoter.referral_link)}
                          >
                            Copy Link
                          </Button>
                        ) : (
                          "--"
                        )}
                      </TD>
                      <TD data-label="Clicks" nums>
                        {promoter.total_clicks}
                      </TD>
                      <TD data-label="Referrals" nums>
                        {promoter.total_referrals_converted}/
                        {promoter.total_referrals_sent}
                      </TD>
                      <TD data-label="Milestone">
                        <MilestoneBadge
                          level={promoter.milestone_level || "none"}
                        />
                      </TD>
                      <TD data-label="Available" nums>
                        {fc(promoter.available_balance_cents || 0)}
                      </TD>
                      <TD data-label="Pending" nums>
                        {fc(promoter.pending_earnings_cents || 0)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardBody>
          </Card>
        </div>
      )}

      {tab === "payouts" && (
        <Card>
          <CardHeader>
            <CardTitle>Payouts</CardTitle>
          </CardHeader>
          <CardBody className="p-0">
            {payouts.length === 0 ? (
              <EmptyState>No payout requests</EmptyState>
            ) : (
              <Table layout="records">
                <THead>
                  <TR>
                    <TH>Promoter</TH>
                    <TH>Amount</TH>
                    <TH>Method</TH>
                    <TH>Status</TH>
                    <TH>1099</TH>
                    <TH>Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {payouts.map((payout) => (
                    <TR key={payout.id}>
                      <TD data-label="Promoter">
                        {payout.first_name} {payout.last_name}
                      </TD>
                      <TD data-label="Amount" nums>
                        {fc(payout.amount_cents)}
                      </TD>
                      <TD data-label="Method">
                        {(
                          payout.payout_method ||
                          payout.method ||
                          ""
                        ).replaceAll("_", " ")}
                      </TD>
                      <TD data-label="Status">
                        <StatusBadge status={payout.status} />
                      </TD>
                      <TD data-label="1099">
                        {payout.requires_1099 ? "Yes" : "--"}
                      </TD>
                      <TD data-label="Actions">
                        {payout.status === "pending" && (
                          <Button
                            onClick={() => handleApprovePayout(payout.id)}
                            loading={approvingPayout === payout.id}
                          >
                            Approve
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>
      )}

      {tab === "settings" && (
        <div className="space-y-4">
          {settings &&
            (() => {
              const current = settingsEditing || settings;
              const update = (key, value) =>
                setSettingsEditing({
                  ...(settingsEditing || settings),
                  [key]: value,
                });
              const isEditing = !!settingsEditing;
              return (
                <>
                  <div className="ui-record-actions justify-end">
                    {!isEditing && (
                      <Button
                        onClick={() => setSettingsEditing({ ...settings })}
                      >
                        Edit Settings
                      </Button>
                    )}
                    {isEditing && (
                      <Button
                        onClick={handleSaveSettings}
                        loading={savingSettings}
                      >
                        Save
                      </Button>
                    )}
                    {isEditing && (
                      <Button
                        variant="secondary"
                        onClick={() => setSettingsEditing(null)}
                        disabled={savingSettings}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {SETTINGS_FIELDS.map((section) => (
                      <Card
                        key={section.section}
                        className={
                          section.items[0]?.type === "textarea"
                            ? "lg:col-span-2"
                            : ""
                        }
                      >
                        <CardHeader>
                          <CardTitle>{section.section}</CardTitle>
                        </CardHeader>
                        <CardBody
                          className={
                            section.items[0]?.type === "textarea"
                              ? "space-y-4"
                              : "grid grid-cols-1 gap-4 sm:grid-cols-2"
                          }
                        >
                          {section.items.map((field) =>
                            field.type === "boolean" ? (
                              <div key={field.key} className="ui-field">
                                <span className="ui-label">{field.label}</span>
                                <Switch
                                  id={`setting-${field.key}`}
                                  checked={Boolean(current[field.key])}
                                  disabled={!isEditing}
                                  onChange={(value) => update(field.key, value)}
                                  label={
                                    current[field.key] ? "Enabled" : "Disabled"
                                  }
                                />
                              </div>
                            ) : (
                              <Field key={field.key} label={field.label}>
                                {field.type === "textarea" ? (
                                  <Textarea
                                    value={current[field.key] || ""}
                                    onChange={(event) =>
                                      update(field.key, event.target.value)
                                    }
                                    disabled={!isEditing}
                                    rows={3}
                                  />
                                ) : (
                                  <Input
                                    type={field.type}
                                    value={current[field.key] ?? ""}
                                    onChange={(event) =>
                                      update(
                                        field.key,
                                        field.type === "number"
                                          ? parseInt(event.target.value) || 0
                                          : event.target.value,
                                      )
                                    }
                                    disabled={!isEditing}
                                  />
                                )}
                              </Field>
                            ),
                          )}
                        </CardBody>
                      </Card>
                    ))}
                  </div>
                </>
              );
            })()}
        </div>
      )}

      {tab === "analytics" && (
        <div className="space-y-4">
          {!analytics ? (
            <div className="p-10 text-center text-ink-tertiary">
              Loading analytics...
            </div>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Conversion Funnel</CardTitle>
                </CardHeader>
                <CardBody>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <Stat
                      label="Clicks"
                      value={analytics.funnel.clicks}
                      sub={`${analytics.funnel.uniqueClicks} unique`}
                    />
                    <Stat
                      label="Referrals"
                      value={analytics.funnel.referrals}
                      sub={`${analytics.funnel.clickToReferralRate}% click-to-ref`}
                    />
                    <Stat
                      label="Converted"
                      value={analytics.funnel.converted}
                      sub={`${analytics.funnel.conversionRate}% rate`}
                    />
                    <Stat label="Lost" value={analytics.funnel.lost} />
                    <Stat label="Pending" value={analytics.funnel.pending} />
                  </div>
                </CardBody>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Financial / ROI</CardTitle>
                </CardHeader>
                <CardBody>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <Stat
                      label="Rewards Issued"
                      value={fd(analytics.financial.totalRewardsDollars)}
                    />
                    <Stat
                      label="Paid Out"
                      value={fc(analytics.financial.totalPaidOutCents)}
                    />
                    <Stat
                      label="Monthly Value"
                      value={fd(analytics.financial.totalMonthlyValue)}
                      sub="from converted refs"
                    />
                    <Stat
                      label="Est. Annual Rev"
                      value={fd(analytics.financial.estimatedAnnualRevenue)}
                    />
                    <Stat label="ROI" value={`${analytics.financial.roi}%`} />
                  </div>
                </CardBody>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Top Promoters</CardTitle>
                </CardHeader>
                <CardBody>
                  {analytics.topPromoters.length === 0 ? (
                    <EmptyState>No conversions yet</EmptyState>
                  ) : (
                    analytics.topPromoters.map((promoter, index) => {
                      const maxConversions =
                        analytics.topPromoters[0].conversions || 1;
                      const percent = Math.round(
                        (promoter.conversions / maxConversions) * 100,
                      );
                      return (
                        <div key={promoter.id} className="mb-4 last:mb-0">
                          <div className="mb-2 flex flex-wrap justify-between gap-2">
                            <span>
                              {index + 1}. {promoter.name}{" "}
                              <MilestoneBadge
                                level={promoter.milestone || "none"}
                              />
                            </span>
                            <span className="tabular-nums text-ink-secondary">
                              {promoter.conversions} conv /{" "}
                              {fc(promoter.earned)}
                            </span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-xs bg-zinc-100">
                            <div
                              className="h-full bg-zinc-900"
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      );
                    })
                  )}
                </CardBody>
              </Card>
            </>
          )}
        </div>
      )}

      <Dialog
        open={!!convertModal}
        onClose={converting ? undefined : () => setConvertModal(null)}
      >
        <DialogHeader>
          <DialogTitle>Convert Referral</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="m-0 text-14 text-ink-secondary">
            Converting: {convertModal?.name}
          </p>
          <Field label="Customer Search">
            <Input
              value={custSearch}
              onChange={(event) => searchCustomers(event.target.value)}
              placeholder="Search customer name or phone..."
            />
          </Field>
          {custResults.length > 0 && (
            <div className="rounded-md border-hairline border-zinc-200 bg-white p-1">
              {custResults.map((customer) => (
                <Button
                  key={customer.id}
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => {
                    setConvertModal((modal) => ({
                      ...modal,
                      customerId: customer.id,
                    }));
                    setCustSearch(
                      `${customer.first_name} ${customer.last_name}`,
                    );
                    setCustResults([]);
                  }}
                >
                  {customer.first_name} {customer.last_name} ({customer.phone})
                </Button>
              ))}
            </div>
          )}
          <Field label="WaveGuard Tier">
            <Select
              value={convertModal?.tier || ""}
              onChange={(event) =>
                setConvertModal((modal) => ({
                  ...modal,
                  tier: event.target.value,
                }))
              }
            >
              <option value="">Select tier...</option>
              <option value="Platinum">Platinum</option>
              <option value="Gold">Gold</option>
              <option value="Silver">Silver</option>
              <option value="Bronze">Bronze</option>
              <option value="One-Time">One-Time</option>
            </Select>
          </Field>
          <Field label="Monthly Value ($)">
            <Input
              type="number"
              placeholder="e.g. 79"
              value={convertModal?.monthlyValue || ""}
              onChange={(event) =>
                setConvertModal((modal) => ({
                  ...modal,
                  monthlyValue: event.target.value,
                }))
              }
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => setConvertModal(null)}
            disabled={converting}
          >
            Cancel
          </Button>
          <Button onClick={handleConvert} loading={converting}>
            Convert
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog
        open={enrollModal}
        onClose={enrolling ? undefined : () => setEnrollModal(false)}
      >
        <DialogHeader>
          <DialogTitle>Enroll Customer as Promoter</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Customer Search">
            <Input
              value={custSearch}
              onChange={(event) => searchCustomers(event.target.value)}
              placeholder="Search customer name or phone..."
            />
          </Field>
          {custResults.length > 0 && (
            <div className="rounded-md border-hairline border-zinc-200 bg-white p-1">
              {custResults.map((customer) => (
                <Button
                  key={customer.id}
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => handleEnroll(customer.id)}
                  disabled={enrolling}
                >
                  {customer.first_name} {customer.last_name} ({customer.phone})
                </Button>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => {
              setEnrollModal(false);
              setCustSearch("");
              setCustResults([]);
            }}
            disabled={enrolling}
          >
            Cancel
          </Button>
        </DialogFooter>
      </Dialog>
    </UiSurface>
  );
}
