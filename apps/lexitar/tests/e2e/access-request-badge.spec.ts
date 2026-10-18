import { test, expect } from "./_fixtures";
import { openSynthetic } from "./_synthetic";

// A support request was filed against a real account and the owner, looking at their own record, saw
// nothing: the pending list loaded only when the Access panel was opened, and the panel is reachable
// only from the account menu. So the one surface that could have told them was the one place they had
// no reason to look. This pins both halves of the fix — the list loads on entry, and the sidebar says
// so in the same stack as "out of date" and "no credit" — because either alone restores the silence.

const PENDING = {
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    providers: [
      {
        linkId: "e2e-pending-support-link",
        providerAccountId: "e2e-pending-support-agent",
        displayName: "Record Export CLI",
        kind: "support",
        status: "invited",
        expiresAt: null,
        publicKeyJwk: null,
      },
    ],
  }),
};

test("a pending request to read the record raises a sidebar badge that opens the Access panel", async ({
  page,
}) => {
  await page.route("**/api/providers", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill(PENDING);
  });

  await openSynthetic(page);

  // Visible without opening anything — the assertion the old behaviour could not pass.
  const badge = page.locator('[data-testid="access-request-badge"]');
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await expect(badge).toHaveText(/1 request to read your record/i);

  await badge.click();
  await expect(page.locator(".access-panel .access-pending")).toContainText(
    "Record Export CLI",
  );
  await expect(page.locator(".access-panel .access-approve")).toBeVisible();
});

test("no badge when nothing is pending", async ({ page }) => {
  await page.route("**/api/providers", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ providers: [] }),
    });
  });

  await openSynthetic(page);
  await expect(page.locator(".sidebar .nav-item").first()).toBeVisible();
  await expect(
    page.locator('[data-testid="access-request-badge"]'),
  ).toHaveCount(0);
});
