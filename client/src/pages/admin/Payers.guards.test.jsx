// @vitest-environment jsdom
/**
 * Billing audit PR 4 (B-56c / B-61b) regressions for PayerDetailSheet & PayersPage:
 *  - Request-sequence cancellation guards for loadStatements, loadAr, StatementDetail.loadDetail, openDetailById
 *  - Non-JSON /followups response handled cleanly via .catch(() => null)
 *  - encodeURIComponent(id) on /admin/payers/:id
 *  - Dirty edit modal confirmation guard on Cancel / Escape / backdrop close
 */
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PayersPage from "./PayersPage";
import PayerDetailSheet from "./PayerDetailSheet";

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("waves_admin_token", "test-token");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("PayerDetailSheet cancellation guards and JSON resilience (B-56c)", () => {
  it("ignores stale statements and AR responses when switching payers mid-flight", async () => {
    const slowStmts1 = deferred();
    const slowAr1 = deferred();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("/admin/payers/p1/statements")) return slowStmts1.promise;
        if (u.endsWith("/admin/payers/p1/ar")) return slowAr1.promise;
        if (u.endsWith("/admin/payers/p2/statements")) {
          return jsonRes({
            statements: [{ id: "stmt-p2", status: "sent", total: 250, period_start: "2026-07-01", period_end: "2026-07-31", invoice_count: 2 }],
          });
        }
        if (u.endsWith("/admin/payers/p2/ar")) {
          return jsonRes({ summary: { outstanding_total: 250, past_due_total: 0, statement_count: 1, buckets: {} } });
        }
        return jsonRes({});
      }),
    );

    const { rerender } = render(
      <PayerDetailSheet payer={{ id: "p1", display_name: "First Payer" }} onClose={() => {}} />,
    );
    rerender(
      <PayerDetailSheet payer={{ id: "p2", display_name: "Second Payer" }} onClose={() => {}} />,
    );

    expect(await screen.findByText("S-stmt-p2")).toBeInTheDocument();

    await act(async () => {
      slowStmts1.resolve(jsonRes({
        statements: [{ id: "stmt-stale-p1", status: "sent", total: 999, period_start: "2026-06-01", period_end: "2026-06-30", invoice_count: 1 }],
      }));
      slowAr1.resolve(jsonRes({ summary: { outstanding_total: 999, past_due_total: 999, statement_count: 1, buckets: {} } }));
      await Promise.all([slowStmts1.promise, slowAr1.promise]);
    });

    expect(screen.queryByText("S-stmt-stale-p1")).not.toBeInTheDocument();
    expect(screen.getByText("S-stmt-p2")).toBeInTheDocument();
    // Both the AR header and the statement row render p2's $250.00 (never p1's $999.00).
    expect(screen.getAllByText("$250.00")).toHaveLength(2);
    expect(screen.queryByText("$999.00")).not.toBeInTheDocument();
  });

  it("handles non-JSON /followups responses cleanly without crashing and cancels stale detail loads", async () => {
    const slowLines1 = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("/admin/payers/p1/statements")) {
          return jsonRes({
            statements: [
              { id: "s1", status: "sent", total: 100, period_start: "2026-06-01", period_end: "2026-06-30", invoice_count: 1 },
              { id: "s2", status: "sent", total: 200, period_start: "2026-07-01", period_end: "2026-07-31", invoice_count: 1 },
            ],
          });
        }
        if (u.endsWith("/admin/payers/p1/ar")) {
          return jsonRes({ summary: { outstanding_total: 300, past_due_total: 0, statement_count: 2, buckets: {} } });
        }
        if (u.endsWith("/statements/s1")) return slowLines1.promise;
        if (u.endsWith("/statements/s2")) {
          return jsonRes({ lines: [{ service_date: "2026-07-10", service_type: "Lawn Care", total: 200 }] });
        }
        if (u.endsWith("/statements/s2/followups")) {
          // Non-JSON HTML gateway error — r2.json() rejects.
          return { ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token '<'"); } };
        }
        return jsonRes({});
      }),
    );

    render(<PayerDetailSheet payer={{ id: "p1", display_name: "Acme HOA" }} onClose={() => {}} />);
    const btn1 = await screen.findByRole("button", { name: /S-s1/ });
    const btn2 = screen.getByRole("button", { name: /S-s2/ });

    // Open s1 (slow), then immediately switch to s2.
    fireEvent.click(btn1);
    fireEvent.click(btn2);

    expect(await screen.findByText(/Lawn Care/)).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load reminder status.");

    // Late s1 resolution must not pollute s2.
    await act(async () => {
      slowLines1.resolve(jsonRes({ lines: [{ service_date: "2026-06-05", service_type: "Stale Visit", total: 100 }] }));
      await slowLines1.promise;
    });
    expect(screen.queryByText(/Stale Visit/)).not.toBeInTheDocument();
  });

  it("shows a retry error instead of 'Reminders: not started' when HTTP 200 /followups returns invalid JSON or omits sequence, and allows explicit null", async () => {
    let followupCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("/admin/payers/p1/statements")) {
          return jsonRes({
            statements: [
              { id: "s1", status: "sent", total: 100, period_start: "2026-07-01", period_end: "2026-07-31", invoice_count: 1 },
            ],
          });
        }
        if (u.endsWith("/admin/payers/p1/ar")) {
          return jsonRes({ summary: { outstanding_total: 100, past_due_total: 0, statement_count: 1, buckets: {} } });
        }
        if (u.endsWith("/statements/s1")) {
          return jsonRes({ lines: [{ service_date: "2026-07-10", service_type: "Pest Control", total: 100 }] });
        }
        if (u.endsWith("/statements/s1/followups")) {
          followupCalls += 1;
          if (followupCalls === 1) {
            // HTTP 200 with malformed JSON body.
            return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token '<'"); } };
          }
          if (followupCalls === 2) {
            // HTTP 200 missing the sequence field.
            return jsonRes({});
          }
          return jsonRes({ sequence: null });
        }
        return jsonRes({});
      }),
    );

    render(<PayerDetailSheet payer={{ id: "p1", display_name: "Acme HOA" }} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /S-s1/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load reminder status.");
    expect(screen.queryByText(/Reminders:\s*not started/)).not.toBeInTheDocument();
    expect(screen.getByText(/Reminders:\s*status unavailable/)).toBeInTheDocument();

    // Retry #1 returns HTTP 200 without a sequence field — still an error, never "not started".
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(followupCalls).toBe(2));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load reminder status.");
    expect(screen.queryByText(/Reminders:\s*not started/)).not.toBeInTheDocument();

    // Retry #2 returns explicit { sequence: null } — valid empty state renders "not started".
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(followupCalls).toBe(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/Reminders:\s*not started/)).toBeInTheDocument();
  });

  it("rejects HTTP 200 malformed JSON on statements, statement lines, and payers list instead of rendering empty states", async () => {
    const badJsonOk = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON"); } });

    // PayerDetailSheet statements + lines
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("/admin/payers/p1/statements")) return badJsonOk();
        if (u.endsWith("/admin/payers/p1/ar")) return jsonRes({ summary: { outstanding_total: 0, past_due_total: 0, statement_count: 0, buckets: {} } });
        return jsonRes({});
      }),
    );
    render(<PayerDetailSheet payer={{ id: "p1", display_name: "Acme HOA" }} onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this payer's statements.");
    expect(screen.queryByText(/No statements yet/)).not.toBeInTheDocument();

    // StatementDetail lines
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("/admin/payers/p1/statements")) {
          return jsonRes({ statements: [{ id: "s1", status: "sent", total: 50, period_start: "2026-07-01", period_end: "2026-07-31", invoice_count: 1 }] });
        }
        if (u.endsWith("/admin/payers/p1/ar")) return jsonRes({ summary: { outstanding_total: 50, past_due_total: 0, statement_count: 1, buckets: {} } });
        if (u.endsWith("/statements/s1")) return badJsonOk();
        if (u.endsWith("/statements/s1/followups")) return jsonRes({ sequence: null });
        return jsonRes({});
      }),
    );
    render(<PayerDetailSheet payer={{ id: "p1", display_name: "Acme HOA" }} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /S-s1/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load statement visits.");
    expect(screen.queryByText(/No visits on this statement/)).not.toBeInTheDocument();

    // PayersPage list
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => badJsonOk()));
    render(
      <MemoryRouter initialEntries={["/admin/payers"]}>
        <PayersPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load payers.");
    expect(screen.queryByText(/No payers yet/)).not.toBeInTheDocument();
  });
});

describe("PayersPage URL encoding, detail cancellation, and dirty edit modal guard (B-56c)", () => {
  it("URL-encodes the payer id in openDetailById and ignores a stale deep-link fetch when another payer is clicked", async () => {
    const slowDeepLink = deferred();
    const seenUrls = [];
    const listPayer = { id: "p-local", display_name: "Local Payer", active: true, payment_terms: "net30" };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        seenUrls.push(u);
        if (u.includes("/admin/payers?")) return jsonRes({ payers: [listPayer] });
        if (u.includes("/admin/payers/bad%2Fid%3F1")) return slowDeepLink.promise;
        if (u.includes("/admin/payers/p-local/statements")) return jsonRes({ statements: [] });
        if (u.includes("/admin/payers/p-local/ar")) {
          return jsonRes({ summary: { outstanding_total: 0, past_due_total: 0, statement_count: 0, buckets: {} } });
        }
        return jsonRes({});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/admin/payers?payer=bad%2Fid%3F1"]}>
        <PayersPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(seenUrls.some((u) => u.endsWith("/admin/payers/bad%2Fid%3F1"))).toBe(true),
    );

    // Operator opens a loaded payer while the deep-link fetch is still pending.
    fireEvent.click(await screen.findByRole("button", { name: "Local Payer" }));
    expect(await screen.findByRole("heading", { name: "Local Payer" })).toBeInTheDocument();

    // Late deep-link response must not replace the currently open sheet.
    await act(async () => {
      slowDeepLink.resolve(jsonRes({ payer: { id: "bad/id?1", display_name: "Stale Deep Link Payer", active: true } }));
      await slowDeepLink.promise;
    });

    expect(screen.getByRole("heading", { name: "Local Payer" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Stale Deep Link Payer" })).not.toBeInTheDocument();
  });

  it("confirms before discarding unsaved edits in the payer modal, and closes cleanly when pristine", async () => {
    const existing = {
      id: "p1",
      display_name: "West Bay Builders",
      company_name: "West Bay Builders LLC",
      ap_email: "ap@example.invalid",
      payment_terms: "net30",
      notes: null,
      active: true,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("/admin/payers?")) return jsonRes({ payers: [existing] });
        return jsonRes({});
      }),
    );
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <MemoryRouter initialEntries={["/admin/payers"]}>
        <PayersPage />
      </MemoryRouter>,
    );

    // Pristine edit dialog closes with no confirmation prompt.
    fireEvent.click(await screen.findByRole("button", { name: "Edit West Bay Builders" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Dirty edit dialog prompts; cancelling confirm keeps the modal and typed value.
    fireEvent.click(screen.getByRole("button", { name: "Edit West Bay Builders" }));
    dialog = await screen.findByRole("dialog");
    const nameInput = within(dialog).getByLabelText(/Payer name/);
    fireEvent.change(nameInput, { target: { value: "West Bay Updated" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(confirmSpy).toHaveBeenCalledWith("Discard unsaved payer changes?");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(nameInput).toHaveValue("West Bay Updated");

    // Reverting back to the initial value closes cleanly without prompting.
    confirmSpy.mockClear();
    fireEvent.change(nameInput, { target: { value: "West Bay Builders" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Dirty new-payer dialog closes once the operator accepts the confirm prompt.
    fireEvent.click(screen.getByRole("button", { name: "New payer" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Payer name/), { target: { value: "Unsaved Payer" } });
    confirmSpy.mockReturnValue(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(confirmSpy).toHaveBeenCalledWith("Discard unsaved payer changes?");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables reminder actions and clears stale status when /followups refresh fails after an active load", async () => {
    const payer = { id: "p-ref", display_name: "Refresh Fail Payer", active: true, payment_terms: "net30" };
    const statement = {
      id: "st-ref",
      number: "ST-2026-009",
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      status: "sent",
      total: 150,
    };
    let followupsCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts = {}) => {
        const u = String(url);
        if (u.endsWith("/statements")) return jsonRes({ statements: [statement] });
        if (u.endsWith("/ar")) {
          return jsonRes({ summary: { outstanding_total: 150, past_due_total: 0, statement_count: 1, buckets: {} } });
        }
        if (u.endsWith(`/statements/${statement.id}`)) return jsonRes({ lines: [] });
        if (u.endsWith(`/statements/${statement.id}/followups/pause`) && opts.method === "POST") {
          return jsonRes({ ok: true });
        }
        if (u.endsWith(`/statements/${statement.id}/followups`)) {
          followupsCalls += 1;
          if (followupsCalls === 1) return jsonRes({ sequence: { status: "active", next_step_label: "Day 7" } });
          return new Response("502 Bad Gateway", { status: 502, headers: { "Content-Type": "text/plain" } });
        }
        return jsonRes({});
      }),
    );

    render(<PayerDetailSheet payer={payer} onClose={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByText("S-st-ref"));
    expect(await screen.findByText(/active · next: Day 7/)).toBeInTheDocument();

    // Pause succeeds, then the post-action refresh of /followups fails.
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByText(/status unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/active · next: Day 7/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reminder now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  it("keeps reminder actions disabled while /followups is loading and cancels deep-link fetch when opening another dialog", async () => {
    const slowFollowups = deferred();
    const payer = { id: "p-load", display_name: "Alpha Payer", active: true, payment_terms: "net30" };
    const statement = {
      id: "st-load",
      number: "ST-2026-010",
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      status: "sent",
      total: 100,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("/statements")) return jsonRes({ statements: [statement] });
        if (u.endsWith("/ar")) {
          return jsonRes({ summary: { outstanding_total: 100, past_due_total: 0, statement_count: 1, buckets: {} } });
        }
        if (u.endsWith(`/statements/${statement.id}`)) return jsonRes({ lines: [] });
        if (u.endsWith(`/statements/${statement.id}/followups`)) return slowFollowups.promise;
        return jsonRes({});
      }),
    );

    const { unmount } = render(<PayerDetailSheet payer={payer} onClose={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByText("S-st-load"));

    // While /followups is still in flight, status shows loading and actions stay disabled.
    expect(await screen.findByText(/loading…/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reminder now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();

    await act(async () => {
      slowFollowups.resolve(jsonRes({ sequence: null }));
      await slowFollowups.promise;
    });
    expect(await screen.findByText(/not started/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reminder now" })).not.toBeDisabled();
    unmount();

    // Opening New payer cancels a slow deep-link detail fetch so a second dialog never pops over the form.
    const slowDeepLink = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/admin/payers?")) return jsonRes({ payers: [payer] });
        if (u.includes("/admin/payers/slow-id")) return slowDeepLink.promise;
        return jsonRes({});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/admin/payers?payer=slow-id"]}>
        <PayersPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New payer" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await act(async () => {
      slowDeepLink.resolve(jsonRes({ payer: { id: "slow-id", display_name: "Late Deep Link Payer", active: true } }));
      await slowDeepLink.promise;
    });
    expect(screen.queryByRole("heading", { name: "Late Deep Link Payer" })).not.toBeInTheDocument();
  });

  it("rejects a non-null sequence object with a missing or unrecognized status and keeps reminder actions disabled", async () => {
    const payer = { id: "p-bad-seq", display_name: "Malformed Seq Payer", active: true, payment_terms: "net30" };
    const statement = {
      id: "st-bad-seq",
      number: "ST-2026-011",
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      status: "sent",
      total: 100,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("/statements")) return jsonRes({ statements: [statement] });
        if (u.endsWith("/ar")) {
          return jsonRes({ summary: { outstanding_total: 100, past_due_total: 0, statement_count: 1, buckets: {} } });
        }
        if (u.endsWith(`/statements/${statement.id}`)) return jsonRes({ lines: [] });
        if (u.endsWith(`/statements/${statement.id}/followups`)) return jsonRes({ sequence: {} });
        return jsonRes({});
      }),
    );

    render(<PayerDetailSheet payer={payer} onClose={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByText("S-st-bad-seq"));

    expect(await screen.findByText(/status unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reminder now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
  });
});
