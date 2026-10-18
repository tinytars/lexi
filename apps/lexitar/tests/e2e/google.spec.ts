import { test, expect } from "./_fixtures";

// W45 §J — Google OAuth entry points. The full callback flow needs a stub Google IdP (follow-up);
// here we assert the UI affordance and that /api/auth/google/start issues a correct OIDC+PKCE redirect
// (GOOGLE_CLIENT_ID is seeded to a test value by scripts/e2e-serve.sh). The custody round-trip itself
// is covered by tests/unit/google-function.test.ts.

test("the lock screen offers Continue with Google in both sign-in and sign-up", async ({ page }) => {
  await page.goto("/");
  const googleBtn = page.locator("button.google-btn");
  await expect(googleBtn).toBeVisible();
  await page.click('button:has-text("Create an account")');
  await expect(googleBtn).toBeVisible();
});

test("/api/auth/google/start redirects to Google with state, PKCE, and openid scope", async ({ request }) => {
  const res = await request.get("/api/auth/google/start", { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  const loc = res.headers()["location"];
  expect(loc).toContain("accounts.google.com");
  const u = new URL(loc);
  expect(u.searchParams.get("client_id")).toBe("e2e-google-client");
  expect(u.searchParams.get("response_type")).toBe("code");
  expect(u.searchParams.get("scope")).toContain("openid");
  expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  expect(u.searchParams.get("code_challenge")).toBeTruthy();
  expect(u.searchParams.get("state")).toBeTruthy();
  expect(res.headers()["set-cookie"]).toContain("hd_google_state=");
});

test("the callback rejects a mismatched state (CSRF guard) and redirects with an error", async ({ request }) => {
  const res = await request.get("/api/auth/google/callback?code=x&state=forged", { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()["location"]).toContain("google_error=state");
});
