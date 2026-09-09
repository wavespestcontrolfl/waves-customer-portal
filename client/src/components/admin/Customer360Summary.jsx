import { buttonStyles, Button } from "../ui";
import { formatETDateOnly, formatETDateTime, formatETTime, etDatetimeLocalToISO } from "../../lib/timezone";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const date = (value) => formatETDateOnly(value, { month: "long", day: "numeric" });

function NextAppointment({ isAdmin, customer, upcoming, instructions, onViewServices }) {
  const next = upcoming[0];
  if (!next) return <section className="c360-next-service"><h2>Next appointment</h2><p>No upcoming appointment.</p>{isAdmin && <a className={buttonStyles({ variant: "secondary", density: "comfortable", className: "" })} href={`/admin/schedule?customer=${customer.id}`}>Book appointment</a>}</section>;
  const windowTime = (value) => formatETTime(etDatetimeLocalToISO(`${String(next.scheduled_date).slice(0, 10)}T${String(value).slice(0, 5)}`));
  const appointmentHref = `/admin/schedule?date=${String(next.scheduled_date).slice(0, 10)}&appointment=${encodeURIComponent(next.id)}`;
  return <section className="c360-next-service"><h2>Next appointment</h2>
    <h3>{next.service_type || "Service"}</h3>
    <p>{date(next.scheduled_date)} · {next.window_start ? `${windowTime(next.window_start)}${next.window_end ? `–${windowTime(next.window_end)}` : " · End not set"}` : "Window not set"}</p>
    <p>{next.technician_name || "Unassigned"} · {String(next.status || "Status not set").replaceAll("_", " ")}</p>
    {instructions && <p className="c360-appointment-note">{instructions}</p>}
    <div className="c360-summary-actions"><a className={buttonStyles({ variant: "secondary", density: "comfortable", className: "" })} href={appointmentHref}>View appointment</a><a className="u-focus-ring" href={appointmentHref}>Reschedule</a></div>
    {upcoming.length > 1 && <p className="text-ink-secondary">{upcoming.length - 1} more upcoming · <button data-ui-text-action type="button" onClick={onViewServices}>View service records</button></p>}
  </section>;
}

function LatestCommunication({ comms, loading, error, customer, onMessage }) {
  const latest = comms[0];
  return <section className="c360-latest-message"><h2>Latest communication</h2>
    {error ? <p>Communication history is unavailable. Open the conversation to retry.</p> : loading ? <p>Loading communication…</p> : latest ? <><p className="text-ink-secondary">{latest.channel === "voice" ? "Call" : latest.direction === "inbound" ? "Received" : "Outbound"} · {formatETDateTime(latest.createdAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p><p className="c360-summary-excerpt">{latest.aiSummary || latest.body || "Attachment"}</p></> : <p>No communication recorded.</p>}
    {customer.phone && <Button variant="secondary" aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onMessage(); }}>Open conversation</Button>}
  </section>;
}

function AttentionSummary({ isAdmin, customer, balance, unread, alerts, onTab }) {
  const attention = (isAdmin ? alerts : []).filter((item) => item.alert && item.label !== "$");
  if (isAdmin) {
    if (balance?.complete && balance.overdueCount > 0) attention.unshift({ text: `${balance.overdueCount} overdue invoice${balance.overdueCount === 1 ? "" : "s"} · ${money.format(balance.overdueBalance)}` });
    if (customer.servicePausedAt) attention.push({ text: "Billing is paused" });
  }
  if (unread > 0) attention.push({ text: `${unread} unread conversation${unread === 1 ? "" : "s"}` });
  return <section className="c360-attention-summary"><h2>{attention.length ? "Needs attention" : "Attention"}</h2>
    {attention.length ? <ul>{attention.map((item, index) => <li key={index}>{item.text}</li>)}</ul> : <p>No alerts in the loaded records.</p>}
    {isAdmin && !balance?.complete && <p>Balance could not be verified.</p>}
    <details><summary>Why this status?</summary><p>{isAdmin ? "Based on billing records, unread conversations, saved card expiry and recorded prepay renewals." : "Based on unread conversations."} Customer requests are listed below.</p>{isAdmin && <>{balance?.asOf && <p>Billing checked {date(balance.asOf)}.</p>}<div className="c360-summary-actions"><Button variant="secondary" onClick={() => onTab("billing")}>View billing</Button></div></>}</details>
  </section>;
}

function AccountSummary({ customer, discounts, referral, onTab }) {
  return <section className="c360-account-summary"><h2>Account</h2>
    <p>{customer.tier ? `${customer.tier} membership` : "No membership tier recorded"}</p>
    {customer.memberSince && <p>Customer since {formatETDateOnly(customer.memberSince, { month: "long", year: "numeric" })}</p>}
    {discounts.map((discount, index) => <p key={index}>{discount.discount_name || "Discount"}: {discount.discount_type === "percentage" ? `${discount.discount_value}%` : money.format(discount.discount_value)}</p>)}
    {referral && <p>Referral code: {customer.referralCode || "Not set"}{referral.total_referrals != null ? ` · ${referral.total_referrals} referrals` : ""}</p>}
    <Button variant="secondary" onClick={() => onTab("property")}>Account details</Button>
  </section>;
}

export default function Customer360Summary({ isAdmin, customer, upcoming, services, comms, commsLoading, commsError, balance, unread, preferences, alerts, onMessage, onTab, onViewServices, discounts, referral }) {
  const service = services[0];
  const accessNotes = alerts.filter((item) => !item.alert);
  return <div className="c360-operational-summary">
    <NextAppointment isAdmin={isAdmin} customer={customer} upcoming={upcoming} instructions={preferences.special_instructions} onViewServices={onViewServices} />
    <LatestCommunication comms={comms} loading={commsLoading} error={commsError} customer={customer} onMessage={onMessage} />
    <section className="c360-latest-service"><h2>Latest service</h2>{service ? <><h3>{service.service_type}</h3><p>{date(service.service_date)}{service.technician_name ? ` · ${service.technician_name}` : ""}</p><Button variant="secondary" onClick={onViewServices}>View service record & report</Button></> : <p>No completed service recorded.</p>}</section>
    <AttentionSummary isAdmin={isAdmin} customer={customer} balance={balance} unread={unread} alerts={alerts} onTab={onTab} />
    <section className="c360-access-summary"><h2>Access & important notes</h2>{accessNotes.length ? accessNotes.map((item, index) => <p key={index}>{item.text}</p>) : <p>No access instructions recorded.</p>}{customer.crmNotes && <p>{customer.crmNotes}</p>}</section>
    <AccountSummary customer={customer} discounts={discounts} referral={referral} onTab={onTab} />
  </div>;
}
