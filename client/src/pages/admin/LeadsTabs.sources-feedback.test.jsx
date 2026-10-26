// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeadsSection } from "./LeadsTabs";

vi.mock("../../components/admin/customer360/CustomerSmsPanel", () => ({
  useCustomerSms: () => vi.fn(),
}));

const SOURCE_A = {
  id: "source-a",
  name: "Synthetic Search",
  source_type: "website",
  channel: "Search",
  monthly_cost: "100",
  month_leads: "4",
  month_conversions: "1",
  is_active: true,
};

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function FeedbackToggle() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate("/admin/pipeline?feedback=1")}
    >
      Enable feedback
    </button>
  );
}

function mount(query = "?feedback=1") {
  return render(
    <MemoryRouter initialEntries={[`/admin/pipeline${query}`]}>
      <FeedbackToggle />
      <LeadsSection />
    </MemoryRouter>,
  );
}

function sourceRow(name) {
  return screen.getByText(name, { exact: true }).closest("tr");
}

describe("lead source read feedback", () => {
  let calls;
  let route;

  beforeEach(() => {
    calls = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    route = async (path) => {
      if (path.includes("/admin/leads?")) {
        return response({
          leads: [],
          total: 0,
          consultationLinksEnabled: false,
        });
      }
      if (path.endsWith("/admin/leads/sources")) {
        return response({ sources: [SOURCE_A] });
      }
      if (path.endsWith("/admin/dispatch/technicians")) {
        return response({ technicians: [] });
      }
      if (path.includes("/admin/services?")) return response({ services: [] });
      return response({});
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const path = String(url);
        calls.push(path);
        return route(path);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows an ROI failure, preserves the source list, and recovers on retry", async () => {
    let roiAttempt = 0;
    route = async (path) => {
      if (path.includes("/analytics/by-source?include_inactive=1")) {
        roiAttempt += 1;
        if (roiAttempt === 1) throw new Error("synthetic ROI failure");
        return response({
          sources: [
            {
              source: SOURCE_A,
              totalLeads: 4,
              conversions: 1,
              totalCost: 100,
              totalRevenue: 125,
              costPerLead: 25,
              costPerAcquisition: 100,
              roi: 25,
              avgResponseTime: 8,
            },
          ],
        });
      }
      return path.endsWith("/admin/leads/sources")
        ? response({ sources: [SOURCE_A] })
        : path.includes("/admin/leads?")
          ? response({ leads: [], total: 0, consultationLinksEnabled: false })
          : response({ technicians: [], services: [] });
    };

    mount();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    expect(
      await screen.findByText(/Source ROI is unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByText("Synthetic Search")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(
        screen.queryByText(/Source ROI is unavailable/),
      ).not.toBeInTheDocument();
      expect(screen.getByText("25.0%")).toBeInTheDocument();
    });
    expect(roiAttempt).toBe(2);
  });

  it("retries the expanded source in the same scope and renders recovered totals", async () => {
    let detailAttempt = 0;
    route = async (path) => {
      if (path.includes("/analytics/by-source?include_inactive=1")) {
        return response({ sources: [] });
      }
      if (path.endsWith("/admin/leads/sources/source-a")) {
        detailAttempt += 1;
        if (detailAttempt === 1) throw new Error("synthetic detail failure");
        return response({
          totalLeads: 7,
          conversions: 2,
          totalCost: 80,
          totalRevenue: 120,
          roi: 50,
          avgResponseTime: 6,
        });
      }
      return path.endsWith("/admin/leads/sources")
        ? response({ sources: [SOURCE_A] })
        : path.includes("/admin/leads?")
          ? response({ leads: [], total: 0, consultationLinksEnabled: false })
          : response({ technicians: [], services: [] });
    };

    mount("?feedback=1&source_name=Synthetic&from=2026-10-01&to=2026-10-26");
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(await waitFor(() => sourceRow("Synthetic Search")));

    expect(
      await screen.findByText("Source funnel and ROI details are unavailable."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(
        sourceRow("Synthetic Search").nextElementSibling,
      ).toHaveTextContent("Total Leads: 7");
    });
    expect(
      calls.filter((path) => path.endsWith("/admin/leads/sources/source-a")),
    ).toHaveLength(2);
  });

  it("ignores a late detail response after another source is expanded", async () => {
    const sourceB = { ...SOURCE_A, id: "source-b", name: "Synthetic Mail" };
    const detailA = deferred();
    const detailB = deferred();
    route = async (path) => {
      if (path.includes("/analytics/by-source?include_inactive=1")) {
        return response({ sources: [] });
      }
      if (path.endsWith("/admin/leads/sources/source-a"))
        return detailA.promise;
      if (path.endsWith("/admin/leads/sources/source-b"))
        return detailB.promise;
      return path.endsWith("/admin/leads/sources")
        ? response({ sources: [SOURCE_A, sourceB] })
        : path.includes("/admin/leads?")
          ? response({ leads: [], total: 0, consultationLinksEnabled: false })
          : response({ technicians: [], services: [] });
    };

    mount();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(await waitFor(() => sourceRow("Synthetic Search")));
    expect(await screen.findByText("Loading source details…")).toBeInTheDocument();
    fireEvent.click(sourceRow("Synthetic Mail"));
    expect(await screen.findByText("Loading source details…")).toBeInTheDocument();

    await act(async () => {
      detailB.resolve(
        response({
          totalLeads: 9,
          conversions: 3,
          totalCost: 90,
          totalRevenue: 180,
          roi: 100,
          avgResponseTime: 4,
        }),
      );
    });
    await waitFor(() => {
      expect(sourceRow("Synthetic Mail").nextElementSibling).toHaveTextContent(
        "Total Leads: 9",
      );
    });

    await act(async () => {
      detailA.resolve(
        response({
          totalLeads: 2,
          conversions: 0,
          totalCost: 100,
          totalRevenue: 0,
          roi: -100,
          avgResponseTime: null,
        }),
      );
    });
    expect(sourceRow("Synthetic Mail").nextElementSibling).toHaveTextContent(
      "Total Leads: 9",
    );
    expect(sourceRow("Synthetic Search").nextElementSibling).toBe(
      sourceRow("Synthetic Mail"),
    );
  });

  it("drops a cached detail after a legacy-mode refresh fails", async () => {
    let detailAttempt = 0;
    route = async (path) => {
      if (path.includes("/analytics/by-source?include_inactive=1")) {
        return response({ sources: [] });
      }
      if (path.endsWith("/admin/leads/sources/source-a")) {
        detailAttempt += 1;
        if (detailAttempt === 2) throw new Error("synthetic refresh failure");
        return response({
          totalLeads: 7,
          conversions: 2,
          totalCost: 80,
          totalRevenue: 120,
          roi: 50,
          avgResponseTime: 6,
        });
      }
      return path.endsWith("/admin/leads/sources")
        ? response({ sources: [SOURCE_A] })
        : path.includes("/admin/leads?")
          ? response({ leads: [], total: 0, consultationLinksEnabled: false })
          : response({ technicians: [], services: [] });
    };

    mount("?feedback=0");
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(await waitFor(() => sourceRow("Synthetic Search")));
    expect(await screen.findByText("Total Leads:")).toBeInTheDocument();

    fireEvent.click(sourceRow("Synthetic Search"));
    fireEvent.click(sourceRow("Synthetic Search"));
    await waitFor(() => expect(detailAttempt).toBe(2));
    await waitFor(() => {
      expect(screen.queryByText("Total Leads:")).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText(/Source funnel and ROI details are unavailable/),
    ).not.toBeInTheDocument();
    expect(console.error).not.toHaveBeenCalledWith(
      "loadSourceDetail",
      expect.anything(),
    );
  });

  it("uses the live feedback mode when a pending detail read fails", async () => {
    const pendingDetail = deferred();
    route = async (path) => {
      if (path.includes("/analytics/by-source?include_inactive=1")) {
        return response({ sources: [] });
      }
      if (path.endsWith("/admin/leads/sources/source-a")) {
        return pendingDetail.promise;
      }
      return path.endsWith("/admin/leads/sources")
        ? response({ sources: [SOURCE_A] })
        : path.includes("/admin/leads?")
          ? response({ leads: [], total: 0, consultationLinksEnabled: false })
          : response({ technicians: [], services: [] });
    };

    mount("?feedback=0");
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(await waitFor(() => sourceRow("Synthetic Search")));
    await waitFor(() => {
      expect(
        calls.some((path) => path.endsWith("/admin/leads/sources/source-a")),
      ).toBe(true);
    });
    expect(screen.queryByText(/Loading source details/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Enable feedback" }));
    await act(async () => {
      pendingDetail.reject(new Error("synthetic pending failure"));
    });

    expect(
      await screen.findByText("Source funnel and ROI details are unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it.each(["", "?feedback=0", "?feedback=true", "?feedback=01"])(
    "keeps the legacy silent failure behavior for %s",
    async (query) => {
      route = async (path) => {
        if (path.includes("/analytics/by-source?include_inactive=1")) {
          throw new Error("synthetic ROI failure");
        }
        if (path.endsWith("/admin/leads/sources/source-a")) {
          throw new Error("synthetic detail failure");
        }
        return path.endsWith("/admin/leads/sources")
          ? response({ sources: [SOURCE_A] })
          : path.includes("/admin/leads?")
            ? response({ leads: [], total: 0, consultationLinksEnabled: false })
            : response({ technicians: [], services: [] });
      };

      mount(query);
      fireEvent.click(screen.getByRole("button", { name: "Sources" }));
      await waitFor(() => {
        expect(
          calls.some((path) =>
            path.includes("/analytics/by-source?include_inactive=1"),
          ),
        ).toBe(true);
      });
      fireEvent.click(await waitFor(() => sourceRow("Synthetic Search")));
      await waitFor(() => {
        expect(
          calls.some((path) => path.endsWith("/admin/leads/sources/source-a")),
        ).toBe(true);
      });

      expect(
        screen.queryByText(/Source ROI is unavailable/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Source funnel and ROI details are unavailable/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Loading source/)).not.toBeInTheDocument();
      expect(console.error).not.toHaveBeenCalledWith(
        "loadSourceDetail",
        expect.anything(),
      );
    },
  );
});
