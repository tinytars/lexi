import { test, expect } from "./_fixtures";
import { completeOnboarding, ownerSignOut } from "./_login";

// W44 — passkey (WebAuthn + PRF) signup + login against the real Functions, driven by a CDP virtual
// authenticator. The unit tests mock the ceremony; only a real authenticator exercises the PRF wire
// (server sends the salt base64url, the client decodes it and derives the KEK from prf.results.first).
// If Playwright's bundled Chromium lacks PRF support this will fail at the ceremony — that's a real
// signal the harness can't cover PRF, not a flake to silence.
test("sign up and sign in with a passkey (virtual authenticator + PRF)", async ({ page }) => {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable", { enableUI: false });
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
      isUserVerified: true,
    },
  });

  const email = `passkey-${Date.now()}@local.invalid`;
  await page.goto("/");

  // Signup with a passkey (no password). W48 — enters directly (no recovery screen); empty vault opens.
  await page.click('.linkish:has-text("Create an account")');
  await page.fill('input[type="email"]', email);
  await page.click('.linkish:has-text("Create with a passkey")');
  // W46 — fresh account lands on onboarding; create the first record to reach the app shell.
  await completeOnboarding(page);
  await expect(page.locator(".account-trigger")).toBeVisible({ timeout: 20_000 });

  // Sign out, then sign back in with the passkey (login mode, no password).
  await ownerSignOut(page);
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await page.fill('input[type="email"]', email);
  await page.click('.linkish:has-text("Use a passkey")');
  await expect(page.locator(".account-trigger")).toBeVisible({ timeout: 20_000 });
});
