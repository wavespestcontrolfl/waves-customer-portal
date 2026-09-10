// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import BillingRecoveryPage from "./BillingRecoveryPage";
import PayerDetailSheet from "./PayerDetailSheet";
import PayerArAgingDialog from "./PayerArAgingDialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

it("keeps pending and failed recovery totals unknown while preserving successful zero totals", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let fail = true;
  const fetch = vi.fn(async url => {
    if (url.includes("/leaks?")) return fail ? pending : response({ summary: { leak_dollars: 0, review_dollars: 0, leak_visits: 0, leak_customers: 0, review_visits: 0 }, leaks: [], needs_review: [] });
    if (url.endsWith("/aging")) return response({ total_outstanding: 0, total_overdue: 0, invoice_count: 0, aging: {}, top_balances: [] });
    return response({ accounts: [], count: 0, atRisk: 0 });
  });
  vi.stubGlobal("fetch", fetch);
  render(<BillingRecoveryPage />);
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  await act(async () => release(response({ error: "Recovery unavailable" }, 503)));
  await screen.findByText("Recovery unavailable");
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  expect(screen.queryByText("No outstanding balances.")).not.toBeInTheDocument();
  fail = false;
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "60" } });
  await screen.findByText("No outstanding balances.");
  expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
  expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

it("does not treat a missing payer summary as an empty balance", async () => {
  vi.stubGlobal("fetch", vi.fn(async url => url.endsWith("/statements") ? response({ statements: [] }) : response({})));
  render(<PayerDetailSheet payer={{ id: 42, display_name: "Example payer" }} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "AR / aging" }));
  await screen.findByText("Could not load this payer's balance.");
  expect(screen.queryByText("No outstanding balance.")).not.toBeInTheDocument();
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
});

it("rejects a malformed aging worklist instead of displaying empty collections", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ statement_count: 0 })));
  render(<PayerArAgingDialog onClose={vi.fn()} />);
  await screen.findByText("Could not load payer aging.");
  expect(screen.queryByText(/No outstanding payer statements/)).not.toBeInTheDocument();
});
