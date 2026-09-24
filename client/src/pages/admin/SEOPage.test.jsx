// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
} from "react-router-dom";
import SEOPage from "./SEOPage";

vi.mock("./SEODashboardPage", () => ({
  default: () => <div>SEO dashboard fixture</div>,
}));

function jsonResponse(body = {}) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
    clone() {
      return this;
    },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function RouterState() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">
        {location.search}{location.hash}
      </output>
      <button type="button" onClick={() => navigate(-1)}>
        Browser Back
      </button>
    </>
  );
}

function renderPage(initialEntries = ["/admin/seo"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SEOPage />
      <RouterState />
    </MemoryRouter>,
  );
}

describe("SEOPage workspace navigation", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      "waves_admin_user",
      JSON.stringify({ id: "seo-test", role: "admin", name: "SEO operator" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({})),
    );
  });

  it("renders the complete SEO shell with comfortable shared navigation", async () => {
    const { container } = renderPage();

    expect(
      screen.getByRole("heading", { name: "SEO", level: 1 }),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-ui-density="comfortable"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "SEO section" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Command SEO view" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Command" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      await screen.findByText("SEO dashboard fixture"),
    ).toBeInTheDocument();
  });

  it("preserves each workspace's selected view while switching workspaces", async () => {
    renderPage();
    await screen.findByText("SEO dashboard fixture");

    let viewNav = screen.getByRole("navigation", { name: "Command SEO view" });
    fireEvent.click(
      within(viewNav).getByRole("button", { name: "Advisor" }),
    );
    expect(
      within(viewNav).getByRole("button", { name: "Advisor" }),
    ).toHaveAttribute("aria-current", "page");

    const workspaceNav = screen.getByRole("navigation", {
      name: "SEO section",
    });
    fireEvent.click(
      within(workspaceNav).getByRole("button", {
        name: "Rankings",
        exact: true,
      }),
    );
    expect(
      within(workspaceNav).getByRole("button", {
        name: "Rankings",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Monitor" })).toBeInTheDocument();

    fireEvent.click(
      within(workspaceNav).getByRole("button", { name: "Command" }),
    );
    viewNav = screen.getByRole("navigation", { name: "Command SEO view" });
    expect(
      within(viewNav).getByRole("button", { name: "Advisor" }),
    ).toHaveAttribute("aria-current", "page");

    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });

  it("deep-links both navigation levels and restores them with browser history", async () => {
    renderPage([
      "/admin/seo?workspace=performance&view=rankings-monitor&source=audit#evidence",
    ]);

    const workspaceNav = screen.getByRole("navigation", {
      name: "SEO section",
    });
    expect(
      within(workspaceNav).getByRole("button", { name: "Rankings" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Monitor" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(
      within(workspaceNav).getByRole("button", { name: "Command" }),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      "?workspace=command&view=dashboard&source=audit#evidence",
    );

    fireEvent.click(screen.getByRole("button", { name: "Advisor" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "?workspace=command&view=advisor&source=audit#evidence",
    );
    fireEvent.click(
      within(workspaceNav).getByRole("button", { name: "Rankings" }),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      "?workspace=performance&view=rankings-monitor&source=audit#evidence",
    );

    fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
    expect(await screen.findByRole("button", { name: "Advisor" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it.each(["unknown", "constructor", "__proto__", "toString"])("falls back to the command dashboard for invalid URL state %s", async (workspace) => {
    renderPage([`/admin/seo?workspace=${workspace}&view=rankings`]);
    expect(screen.getByRole("button", { name: "Command" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByText("SEO dashboard fixture")).toBeInTheDocument();
  });

  it("does not restore a skipped backlink from an older automatic refresh", async () => {
    const staleQueue = deferred();
    let queueReads = 0;
    fetch.mockImplementation((url, options = {}) => {
      const route = String(url);
      if (route.endsWith("/admin/seo/backlinks")) return jsonResponse({});
      if (route.includes("/admin/backlink-agent/queue?")) {
        queueReads += 1;
        if (queueReads === 1) {
          return jsonResponse({
            items: [
              {
                id: "queue-1",
                url: "https://stale.example/page",
                domain: "stale.example",
                source: "manual",
                status: "pending",
              },
            ],
          });
        }
        if (queueReads === 2) return staleQueue.promise;
        return jsonResponse({ items: [] });
      }
      if (route.endsWith("/admin/backlink-agent/stats")) {
        return jsonResponse({ total: 1, pending: 1 });
      }
      if (route.endsWith("/admin/backlink-agent/profiles")) {
        return jsonResponse({ profiles: [] });
      }
      if (route.endsWith("/admin/backlink-agent/targets")) {
        return jsonResponse({ targets: [] });
      }
      if (
        route.endsWith("/admin/backlink-agent/queue/queue-1/skip") &&
        options.method === "POST"
      ) {
        return jsonResponse({});
      }
      return jsonResponse({});
    });

    renderPage(["/admin/seo?workspace=authority&view=backlinks"]);
    fireEvent.click(await screen.findByRole("button", { name: "Agent" }));
    expect(await screen.findByText("stale.example")).toBeInTheDocument();

    fireEvent(window, new Event("online"));
    await waitFor(() => expect(queueReads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(screen.queryByText("stale.example")).not.toBeInTheDocument(),
    );

    await act(async () => {
      staleQueue.resolve(
      await jsonResponse({
        items: [
          {
            id: "queue-1",
            url: "https://stale.example/page",
            domain: "stale.example",
            source: "manual",
            status: "pending",
          },
        ],
      }),
      );
    });
    expect(screen.queryByText("stale.example")).not.toBeInTheDocument();
  });
});
