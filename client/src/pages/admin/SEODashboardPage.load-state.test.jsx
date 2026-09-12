// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SEODashboardPage from "./SEODashboardPage";

const reply = (data, { ok = true, status = 200, statusText = "OK" } = {}) => ({
  ok,
  status,
  statusText,
  clone() {
    return this;
  },
  json: async () => data,
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => "fixture-token" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows a retryable error instead of zero metrics when a dashboard read fails", async () => {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls += 1;
      if (calls <= 3) {
        return reply(
          { error: "Search data is temporarily unavailable" },
          { ok: false, status: 503, statusText: "Unavailable" },
        );
      }
      if (calls === 4)
        return reply({ total: 2, withAIO: 2, wavesCited: 1, results: [] });
      if (calls === 5) return reply({ summary: {}, rankings: [] });
      return reply({ llmStats: {} });
    }),
  );

  render(<SEODashboardPage />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "SEO dashboard unavailable: Search data is temporarily unavailable",
  );
  expect(screen.queryByText("Source Coverage")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Source Coverage")).toBeInTheDocument();
  expect(screen.getAllByText("50.0%")).toHaveLength(2);
  expect(fetch).toHaveBeenCalledTimes(6);
});

it("prevents an older retry from replacing a newer dashboard response", async () => {
  const older = [deferred(), deferred(), deferred()];
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      calls += 1;
      if (calls <= 3) return older[calls - 1].promise;
      if (calls === 4)
        return Promise.resolve(
          reply({ total: 4, withAIO: 4, wavesCited: 3, results: [] }),
        );
      if (calls === 5) return Promise.resolve(reply({ summary: {}, rankings: [] }));
      return Promise.resolve(reply({ llmStats: {} }));
    }),
  );

  render(
    <React.StrictMode>
      <SEODashboardPage />
    </React.StrictMode>,
  );

  expect((await screen.findAllByText("75.0%")).length).toBeGreaterThan(0);
  await act(async () => {
    older[0].resolve(reply({ total: 1, withAIO: 1, wavesCited: 0 }));
    older[1].resolve(reply({ summary: {}, rankings: [] }));
    older[2].resolve(reply({ llmStats: {} }));
  });
  await waitFor(() => expect(screen.getAllByText("75.0%").length).toBeGreaterThan(0));
  expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
});
