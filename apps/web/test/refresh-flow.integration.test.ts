function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("web refresh behavior", () => {
  let getUsers: typeof import("@/lib/utils/api").getUsers;
  let getConversations: typeof import("@/lib/utils/api").getConversations;

  beforeEach(async () => {
    jest.resetModules();
    jest.useRealTimers();

    (global as any).window = {
      location: {
        pathname: "/dashboard",
        search: "",
        href: "/dashboard",
      },
    };

    // Force single-tab fallback path in tests.
    (global as any).BroadcastChannel = undefined;

    ({ getUsers, getConversations } = await import("@/lib/utils/api"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("refreshes during auth bootstrap when /api/me returns 401", async () => {
    let refreshCalls = 0;
    let meCalls = 0;

    jest.spyOn(global, "fetch" as any).mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as RequestInfo | URL;
      const url = String(input);

      if (url === "/api/auth/refresh") {
        refreshCalls += 1;
        return jsonResponse({ success: true }, 200);
      }

      if (url === "/api/me") {
        meCalls += 1;
        if (meCalls === 1) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        return jsonResponse({ id: "u1" }, 200);
      }

      if (url === "/api/users" || url === "/api/conversations") {
        return jsonResponse([], 200);
      }

      return jsonResponse({ error: "Unexpected URL" }, 500);
    });

    await Promise.all([getUsers(), getConversations()]);

    expect(refreshCalls).toBe(1);
    expect(meCalls).toBe(2);
  });

  it("deduplicates concurrent 401 refresh and keeps user logged in", async () => {
    let refreshCalls = 0;
    const calls: Record<string, number> = {
      "/api/users": 0,
      "/api/conversations": 0,
    };

    jest.spyOn(global, "fetch" as any).mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as RequestInfo | URL;
      const url = String(input);

      if (url === "/api/auth/refresh") {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse({ success: true }, 200);
      }

      if (url === "/api/me") {
        return jsonResponse({ id: "u1" }, 200);
      }

      if (url === "/api/users" || url === "/api/conversations") {
        calls[url] += 1;
        if (calls[url] === 1) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        return jsonResponse([], 200);
      }

      return jsonResponse({ error: "Unexpected URL" }, 500);
    });

    const [users, conversations] = await Promise.all([getUsers(), getConversations()]);

    expect(refreshCalls).toBe(1);
    expect(users).toEqual([]);
    expect(conversations).toEqual([]);
    expect((global as any).window.location.href).toBe("/dashboard");
  });
});
