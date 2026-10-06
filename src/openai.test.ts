import { describe, expect, test } from "bun:test";
import { chatCompletions, listModels } from "./openai.ts";

function mock(body: any, status = 200) {
  let seen: any;
  const f = async (url: string, init: any) => {
    seen = { url, init };
    return { status, ok: status < 400, headers: new Headers(), text: async () => JSON.stringify(body) } as any;
  };
  return { f, get seen() { return seen; } };
}

describe("openai client", () => {
  test("chat sends auth and does NOT substitute braces in content", async () => {
    const m = mock({ choices: [{ message: { content: "hi" } }] });
    const out = await chatCompletions(
      { baseUrl: "https://api.test/v1", apiKey: "sk-1" },
      { model: "m", messages: [{ role: "user", content: "print {the} thing" }] },
      m.f as any,
    );
    expect(out.choices[0].message.content).toBe("hi");
    expect(m.seen.url).toBe("https://api.test/v1/chat/completions");
    expect(m.seen.init.headers.Authorization).toBe("Bearer sk-1");
    expect(JSON.parse(m.seen.init.body).messages[0].content).toBe("print {the} thing");
  });

  test("listModels", async () => {
    const m = mock({ data: [{ id: "a" }] });
    const out = await listModels({ baseUrl: "https://api.test/v1" }, m.f as any);
    expect(out.data[0].id).toBe("a");
  });

  test("non-2xx throws with detail", async () => {
    const m = mock({ error: "nope" }, 402);
    await expect(chatCompletions({ baseUrl: "https://api.test/v1" }, { model: "m" }, m.f as any)).rejects.toThrow(/402/);
  });
});
