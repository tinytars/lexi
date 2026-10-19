import { it, expect, vi } from "vitest";
import { encryptVaultV2, generateDEK } from "@tinytars/vault/crypto";

it("probe", async () => {
  vi.stubEnv("DEV", false);
  const k0 = await generateDEK();
  const k1 = await generateDEK();
  const blob = await encryptVaultV2({ threads: [] }, k0);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? new Response(blob as BodyInit, { status: 200, headers: { etag: "e0" } })
        : new Response(null, { status: 204, headers: { etag: "e1" } }),
    ),
  );
  vi.resetModules();
  const s = await import("../../src/lib/chat-store");
  await s.loadThreads("robin", k1);
  await s.saveThreads([], "robin", k1).then(
    () => console.log("PROBE: save resolved"),
    (e) => console.log("PROBE: save rejected ->", (e as Error).name, "|", (e as Error).message),
  );
  expect(true).toBe(true);
});
