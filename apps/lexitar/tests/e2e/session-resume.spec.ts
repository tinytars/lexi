import { test, expect } from "./_fixtures";
import { signUp, ownerSignOut } from "./_login";
import { E2E_CLINICIAN } from "./_synthetic";

// W49 — a browser refresh must NOT force re-auth. The hd_session cookie survives; the account private
// key is persisted (non-extractable) in IndexedDB and the vault DEK is re-derived on load. Signing out
// clears the stored key, so a post-sign-out refresh lands back on the lock screen.

test("owner stays signed in across a refresh, and sign-out + refresh locks", async ({ page }) => {
  await signUp(page, `e2e-resume-${Date.now()}@local.invalid`);
  await expect(page.locator(".account-trigger")).toBeVisible();

  await page.reload();

  // Resumed: the app shell is back (account menu present) and the sign-in form is gone — no re-auth.
  await expect(page.locator(".account-trigger")).toBeVisible();
  await expect(page.locator('.lock input[type="password"]')).toHaveCount(0);

  await ownerSignOut(page);
  await page.reload();

  // Signed out → stored key cleared → the lock screen returns.
  await expect(page.locator('.lock input[type="password"]')).toBeVisible();
});

test("the persisted account key is non-extractable (XSS can't export it)", async ({ page }) => {
  await signUp(page, `e2e-resume-xss-${Date.now()}@local.invalid`);
  await expect(page.locator(".account-trigger")).toBeVisible();

  const exportable = await page.evaluate(async () => {
    const key = await new Promise<CryptoKey | null>((resolve, reject) => {
      const open = indexedDB.open("security-session", 1);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction("keys", "readonly");
        const req = tx.objectStore("keys").get("account-private-key");
        req.onsuccess = () => resolve((req.result as CryptoKey) ?? null);
        req.onerror = () => reject(req.error);
      };
      open.onerror = () => reject(open.error);
    });
    if (!key) return "no-key";
    if (key.extractable) return "extractable";
    try {
      await crypto.subtle.exportKey("pkcs8", key);
      return "exported"; // should be unreachable for a non-extractable key
    } catch {
      return "non-extractable";
    }
  });
  expect(exportable).toBe("non-extractable");
});

test("a signed-in provider resumes on the roster across a refresh", async ({ page }) => {
  await page.goto("/");
  await page.fill('input[type="email"]', E2E_CLINICIAN.email);
  await page.fill('input[type="password"]', E2E_CLINICIAN.password);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".roster-list");

  await page.reload();
  await expect(page.locator(".roster-list")).toBeVisible();
  await expect(page.locator('.lock input[type="password"]')).toHaveCount(0);
});
