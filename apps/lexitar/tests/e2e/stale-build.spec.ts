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
