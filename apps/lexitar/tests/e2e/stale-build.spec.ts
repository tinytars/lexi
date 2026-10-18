import { test, expect } from "./_fixtures";

// A tab open across a deploy asks for build assets that no longer exist.

test("a missing build asset answers 404, not the SPA's index.html", async ({ request }) => {
  const res = await request.get("/assets/index-GONE0000.js");
  expect(res.status()).toBe(404);
  expect(await res.text()).not.toContain('id="app"');
});

test("a build script that fails to load is reported, then reloads once and not again", async ({ page }) => {
  const reports: string[] = [];
  await page.route("**/api/client-error", (route) => {
    reports.push(JSON.parse(route.request().postData() ?? "{}").message);
    return route.fulfill({ status: 204 });
  });
  const loadStale = () =>
    page.evaluate(() => {
      const s = document.createElement("script");
      s.type = "module";
      s.src = "/assets/index-GONE0000.js";
      document.head.append(s);
    });

  await page.goto("/", { waitUntil: "networkidle" });
  await Promise.all([page.waitForEvent("load"), loadStale()]);
  await expect.poll(() => reports).toEqual([expect.stringContaining("/assets/index-GONE0000.js")]);

  await page.evaluate(() => ((window as { marker?: number }).marker = 1));
  await loadStale();
  await expect.poll(() => reports).toHaveLength(2);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as { marker?: number }).marker)).toBe(1);
});

// The stub above proves the guard fires; this proves the endpoint it fires at actually takes the
// report. Until the session gate came off, the boot guard's own case — a tab too stale to boot,
// which by definition has no session — was answered 401 and reported nothing.
test("the real endpoint takes the boot guard's report from a logged-out page", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const status = await page.evaluate(async () => {
    const res = await fetch("/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "StaleBuildError",
        message: "Failed to load " + location.origin + "/assets/index-E2E00000.js",
        stack: "",
        build: "",
        source: "boot-asset",
      }),
    });
    return res.status;
  });
  expect(status).toBe(204);
});
