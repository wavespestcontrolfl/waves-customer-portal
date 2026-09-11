import { useState, useEffect, useCallback } from "react";
import { Users } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  UiSurface,
  buttonStyles,
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

function fmtCents(c) {
  return "$" + (c / 100).toFixed(2);
}

function StatCard({ label, value, sub }) {
  return (
    <Card>
      <CardBody>
        <p className="m-0 text-ui-body text-ink-secondary">{label}</p>
        <p className="m-0 mt-2 text-[26px] font-medium">{value}</p>
        {sub && (
          <p className="m-0 mt-1 text-ui-body text-ink-secondary">{sub}</p>
        )}
      </CardBody>
    </Card>
  );
}
function StatusBadge({ status }) {
  return <Badge>{status}</Badge>;
}
export default function ReferralsPage() {
  const [tab, setTab] = useState("dashboard");
  const [stats, setStats] = useState(null);
  const [promoters, setPromoters] = useState([]);
  const [queue, setQueue] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [loading, setLoading] = useState(true);

  // Enroll form
  const [enrollForm, setEnrollForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
  });
  const [enrolling, setEnrolling] = useState(false);
  const [enrollResult, setEnrollResult] = useState(null);

  // Submit referral form
  const [refForm, setRefForm] = useState({
    promoterPhone: "",
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    address: "",
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(() => {
    Promise.all([
      adminFetch("/admin/referrals/stats").catch(() => null),
      adminFetch("/admin/referrals/promoters").catch(() => ({ promoters: [] })),
      adminFetch("/admin/referrals/queue").catch(() => ({ referrals: [] })),
      adminFetch("/admin/referrals/payouts").catch(() => ({ payouts: [] })),
    ]).then(([s, p, q, pay]) => {
      setStats(s);
      setPromoters(p.promoters || []);
      setQueue(q.referrals || []);
      setPayouts(pay.payouts || []);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleEnroll = async () => {
    if (!enrollForm.phone || !enrollForm.firstName) return;
    setEnrolling(true);
    try {
      const r = await adminFetch("/admin/referrals/enroll", {
        method: "POST",
        body: JSON.stringify({
          customerPhone: enrollForm.phone,
          customerEmail: enrollForm.email,
          firstName: enrollForm.firstName,
          lastName: enrollForm.lastName,
        }),
      });
      setEnrollResult(
        r.alreadyEnrolled
          ? "Already enrolled"
          : `Enrolled! Link: ${r.promoter?.clicki_referral_link}`,
      );
      setEnrollForm({ firstName: "", lastName: "", phone: "", email: "" });
      loadData();
    } catch (e) {
      setEnrollResult("Error: " + e.message);
    }
    setEnrolling(false);
  };

  const handleSubmitReferral = async () => {
    if (!refForm.phone || !refForm.firstName) return;
    setSubmitting(true);
    try {
      await adminFetch("/admin/referrals/submit", {
        method: "POST",
        body: JSON.stringify({
          promoterPhone: refForm.promoterPhone,
          referralFirstName: refForm.firstName,
          referralLastName: refForm.lastName,
          referralPhone: refForm.phone,
          referralEmail: refForm.email,
          referralAddress: refForm.address,
          referralNotes: refForm.notes,
          source: "admin",
        }),
      });
      setRefForm({
        promoterPhone: "",
        firstName: "",
        lastName: "",
        phone: "",
        email: "",
        address: "",
        notes: "",
      });
      loadData();
    } catch {
      /* */
    }
    setSubmitting(false);
  };

  const handleStatusChange = async (id, status) => {
    await adminFetch(`/admin/referrals/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    loadData();
  };

  const handleApprovePayout = async (id) => {
    await adminFetch(`/admin/referrals/payouts/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    loadData();
  };

  if (loading)
    return (
      <UiSurface density="comfortable">
        <p className="m-0 p-8 text-ui-body text-ink-secondary" role="status">
          Loading referral program...
        </p>
      </UiSurface>
    );
  return (
    <UiSurface density="comfortable" className="space-y-4">
      <AdminCommandHeader title="Referrals" icon={Users} variant="workspace" />
      <nav
        aria-label="Referral workspaces"
        className="flex gap-2 overflow-x-auto pb-1"
      >
        {[
          { key: "dashboard", label: "Dashboard" },
          { key: "queue", label: `Queue (${queue.length})` },
          { key: "promoters", label: "Promoters" },
          { key: "payouts", label: "Payouts" },
          { key: "enroll", label: "Enroll" },
        ].map((t) => (
          <Button
            key={t.key}
            className="shrink-0 whitespace-nowrap"
            variant={tab === t.key ? "primary" : "secondary"}
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </nav>
      {tab === "dashboard" && stats && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-6">
            <StatCard label="Active Promoters" value={stats.activePromoters} />
            <StatCard
              label="Total Referrals"
              value={stats.totalReferrals}
              sub={`${stats.convertedReferrals} converted`}
            />
            <StatCard label="Pending" value={stats.pendingReferrals} />
            <StatCard label="Total Clicks" value={stats.totalClicks} />
            <StatCard
              label="Total Earned"
              value={fmtCents(
                stats.totalReferralRewards + stats.totalClickRewards,
              )}
            />
            <StatCard
              label="Paid Out"
              value={fmtCents(stats.totalPaidOut)}
              sub={`${stats.pendingPayouts} pending`}
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Recent Referrals</CardTitle>
            </CardHeader>
            <CardBody>
              {queue.length === 0 ? (
                <p className="m-0 text-ui-body text-ink-secondary">
                  No referrals yet
                </p>
              ) : (
                queue.slice(0, 10).map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 py-3"
                  >
                    <div className="min-w-0 break-words">
                      <p className="m-0 text-ui-body font-medium">
                        {r.referral_first_name} {r.referral_last_name}
                      </p>
                      <p className="m-0 text-ui-body text-ink-secondary">
                        {r.referral_phone} · from {r.promoter_name || "unknown"}{" "}
                        · {r.source}
                      </p>
                    </div>
                    <StatusBadge status={r.status} />
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
              {promoters.slice(0, 10).map((p) => (
                <div
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 py-3"
                >
                  <div>
                    <p className="m-0 text-ui-body font-medium">
                      {p.first_name} {p.last_name}
                    </p>
                    <p className="m-0 text-ui-body text-ink-secondary">
                      {p.total_referrals_converted} converted · {p.total_clicks}{" "}
                      clicks
                    </p>
                  </div>
                  <p className="m-0 text-ui-body font-medium">
                    {fmtCents(p.total_earned_cents)}
                  </p>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>
      )}
      {tab === "queue" && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Submit Referral</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                {[
                  ["promoterPhone", "Promoter phone"],
                  ["firstName", "First name *"],
                  ["lastName", "Last name"],
                  ["phone", "Phone *"],
                  ["email", "Email"],
                  ["address", "Address"],
                  ["notes", "Notes"],
                ].map(([key, label]) => (
                  <Field key={key} label={label}>
                    <Input
                      aria-label={label}
                      value={refForm[key]}
                      onChange={(e) =>
                        setRefForm((f) => ({ ...f, [key]: e.target.value }))
                      }
                    />
                  </Field>
                ))}
              </div>
              <Button disabled={submitting} onClick={handleSubmitReferral}>
                {submitting ? "Submitting..." : "Submit Referral"}
              </Button>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Referral Queue ({queue.length})</CardTitle>
            </CardHeader>
            <CardBody>
              {queue.length === 0 ? (
                <p className="m-0 text-ui-body text-ink-secondary">
                  No pending referrals
                </p>
              ) : (
                <Table layout="records">
                  <THead>
                    <TR>
                      {["Referral", "From", "Status", "Notes", "Actions"].map(
                        (label) => (
                          <TH key={label}>{label}</TH>
                        ),
                      )}
                    </TR>
                  </THead>
                  <TBody>
                    {queue.map((r) => (
                      <TR key={r.id}>
                        <TD data-label="Referral">
                          <div className="min-w-0 break-words">
                            <p className="m-0 font-medium">
                              {r.referral_first_name} {r.referral_last_name}
                            </p>
                            <p className="m-0 text-ink-secondary">
                              {r.referral_phone}{" "}
                              {r.referral_email ? `· ${r.referral_email}` : ""}
                            </p>
                          </div>
                        </TD>
                        <TD data-label="From">
                          {r.promoter_name || r.promoter_phone || "--"}
                        </TD>
                        <TD data-label="Status">
                          <StatusBadge status={r.status} />
                        </TD>
                        <TD data-label="Notes">
                          {r.referral_notes || r.referral_address || "--"}
                        </TD>
                        <TD data-label="Actions">
                          <div className="ui-record-actions">
                            {r.status === "pending" && (
                              <Button
                                variant="secondary"
                                onClick={() =>
                                  handleStatusChange(r.id, "contacted")
                                }
                              >
                                Contacted
                              </Button>
                            )}
                            {(r.status === "contacted" ||
                              r.status === "estimated") && (
                              <Button
                                onClick={() =>
                                  handleStatusChange(r.id, "converted")
                                }
                              >
                                Convert
                              </Button>
                            )}
                            {r.status !== "converted" &&
                              r.status !== "rejected" && (
                                <Button
                                  variant="secondary"
                                  onClick={() =>
                                    handleStatusChange(r.id, "rejected")
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
        <Card>
          <CardHeader>
            <CardTitle>Promoters ({promoters.length})</CardTitle>
          </CardHeader>
          <CardBody>
            <Table layout="records">
              <THead>
                <TR>
                  {[
                    "Name",
                    "Phone",
                    "Clicks",
                    "Referrals",
                    "Earned",
                    "Balance",
                    "Link",
                  ].map((label) => (
                    <TH key={label}>{label}</TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {promoters.map((p) => (
                  <TR key={p.id}>
                    <TD data-label="Name">
                      <span className="font-medium">
                        {p.first_name} {p.last_name}
                      </span>
                    </TD>
                    <TD data-label="Phone">{p.customer_phone}</TD>
                    <TD data-label="Clicks">{p.total_clicks}</TD>
                    <TD data-label="Referrals">
                      {p.total_referrals_converted}/{p.total_referrals_sent}
                    </TD>
                    <TD data-label="Earned">
                      {fmtCents(p.total_earned_cents)}
                    </TD>
                    <TD data-label="Balance">
                      {fmtCents(
                        p.click_balance_cents + p.referral_balance_cents,
                      )}
                    </TD>
                    <TD data-label="Link">
                      {p.clicki_referral_link ? (
                        <a
                          className={buttonStyles({ variant: "secondary" })}
                          href={p.clicki_referral_link}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Copy
                        </a>
                      ) : (
                        "--"
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      )}
      {tab === "payouts" && (
        <Card>
          <CardHeader>
            <CardTitle>Payouts</CardTitle>
          </CardHeader>
          <CardBody>
            {payouts.length === 0 ? (
              <p className="m-0 text-ui-body text-ink-secondary">
                No payout requests yet
              </p>
            ) : (
              <Table layout="records">
                <THead>
                  <TR>
                    {["Promoter", "Amount", "Method", "Status", "Actions"].map(
                      (label) => (
                        <TH key={label}>{label}</TH>
                      ),
                    )}
                  </TR>
                </THead>
                <TBody>
                  {payouts.map((p) => (
                    <TR key={p.id}>
                      <TD data-label="Promoter">
                        {p.first_name} {p.last_name}
                      </TD>
                      <TD data-label="Amount">{fmtCents(p.amount_cents)}</TD>
                      <TD data-label="Method">{p.method?.replace("_", " ")}</TD>
                      <TD data-label="Status">
                        <StatusBadge status={p.status} />
                      </TD>
                      <TD data-label="Actions">
                        {p.status === "pending" && (
                          <Button onClick={() => handleApprovePayout(p.id)}>
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
      {tab === "enroll" && (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Enroll New Promoter</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {[
              ["firstName", "First name *"],
              ["lastName", "Last name"],
              ["phone", "Phone *"],
              ["email", "Email"],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <Input
                  aria-label={label}
                  value={enrollForm[key]}
                  onChange={(e) =>
                    setEnrollForm((f) => ({ ...f, [key]: e.target.value }))
                  }
                />
              </Field>
            ))}
            <Button onClick={handleEnroll} disabled={enrolling}>
              {enrolling ? "Enrolling..." : "Enroll Promoter"}
            </Button>
            {enrollResult && (
              <ActionFeedback error={enrollResult.includes("Error")}>
                {enrollResult}
              </ActionFeedback>
            )}
          </CardBody>
        </Card>
      )}
    </UiSurface>
  );
}
