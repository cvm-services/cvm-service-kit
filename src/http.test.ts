import { describe, expect, test } from "bun:test";
import { callHttp, pick } from "./http.ts";

function mockFetch(handler: (url: string, init: any) => any) {
  return async (url: string, init: any) => {
    const r = handler(url, init);
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
      headers: new Headers(r.headers ?? {}),
    } as unknown as Response;
  };
}

describe("callHttp", () => {
  test("substitutes url, query and body", async () => {
    let seen: any;
    const f = mockFetch((url, init) => {
      seen = { url, init };
      return { body: { ok: true } };
    });
    const r = await callHttp(
      {
        method: "POST",
        url: "https://api.test/v1/{id}/order",
        query: { c: "{country}" },
        body: { service: "{service}", amount: "{amount}" },
      },
      { id: 42, country: "US", service: "tg", amount: 10 },
      { fetchImpl: f as any },
    );
    expect(r.body).toEqual({ ok: true });
    expect(seen.url).toContain("/v1/42/order");
    expect(seen.url).toContain("c=US");
    expect(JSON.parse(seen.init.body)).toEqual({ service: "tg", amount: "10" });
    expect(seen.init.headers["Content-Type"]).toBe("application/json");
  });

  test("pick reads dot paths", () => {
    expect(pick({ data: [{ code: "go" }] }, "data.0.code")).toBe("go");
    expect(pick({}, "a.b.c")).toBeUndefined();
  });
});
