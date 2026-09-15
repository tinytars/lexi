import "../../scripts/load-creds";
import { expect, type Page } from "@playwright/test";

// W44 — shared account-login helpers for the e2e suite (replaces the per-spec passphrase-unlock
// copies). The migrated pilots sign in with {slug}@local.invalid + their old slug as the password
// (see scripts/migrate-accounts.ts); the provider lands on the roster and drills into a
// patient by display name. Runs against the real /api/auth/* Functions via wrangler pages dev.
// The provider's login password is the family passphrase (its verifier hash is seeded in
// migration 0002); it's sourced from the operator's private health-dash.env, not committed here.
// alex/blair passwords are just the public lowercased slugs — not secrets — so they stay literal.
// W69 — resolved when a spec USES the provider, not when this module is imported.
//
// The throw used to sit at module scope, and almost every spec imports this file — so on a machine
// without ~/.claude/infra/cloud/credentials the entire e2e suite died at COLLECTION, including the
// specs that never touch fam4. That single line is what pins e2e to this Mac: the family passphrase
// cannot go into Actions secrets, so no hosted runner could ever get past the import.
//
// Same fix as scripts/vault-verify.ts:29 — needing a credential to RUN must not mean needing one to
// IMPORT. A getter keeps the `{ email, password }` shape every caller already expects, and still
// fails loudly, by name, the moment a pilot-provider spec actually asks for the password.
function providerPassword(): string {
  const pass = process.env.PASSPHRASE;
  if (!pass) throw new Error("PASSPHRASE not set — source the operator's private health-dash.env (see VAULT.md)");
  return pass;
}

// G1 — a pilot's CLIENT id is their lowercased account id (migrations 0002 + 0011), not their name.
// It is the vault's R2 key, the /api/vault/{id} segment and the URL-hash prefix all at once, so the
// specs that assert on a location or stub a vault route need it. Here rather than in each spec: it
// is one fact, and the whole point of G1 is that it is not derivable from the display name.
export const PILOTS = {
  alex: { email: "alex@local.invalid", password: "alex", name: "Alex", clientId: "834bc60d-c937-467d-9e78-3caa734acf45" },
  blair: { email: "blair@local.invalid", password: "blair", name: "Blair", clientId: "7de3dfed-c872-4971-a923-c85d3322c087" },
  provider: {
    email: "fam4@local.invalid",
    get password(): string {
      return providerPassword();
    },
  },
  // W44 P4b — a support agent + a pending request against Blair, seeded LOCAL-only by seed-support-e2e.sql.
  support: { email: "support@local.invalid", name: "Support Agent" },
};

export async function loginAs(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
}

/** The pilots a spec can sign in as BY NAME. W64 — six spec-local wrappers took a `name: string`
 *  and then called openPatient() with no argument, so every one of them silently yielded Alex (the
 *  default) whatever was passed. Blair is a real pilot, so `openClient(page, "Blair")` reading as Alex
 *  was a trap waiting for the first spec that needed her. */
export const PILOT_BY_NAME = { Alex: PILOTS.alex, Blair: PILOTS.blair } as const;
export type PilotName = keyof typeof PILOT_BY_NAME;

/** A pilot's URL-hash prefix, `#{clientId}`. Regex-safe — a uuid has no metacharacters. */
export const hashOf: Record<PilotName, string> = {
  Alex: `#${PILOTS.alex.clientId}`,
  Blair: `#${PILOTS.blair.clientId}`,
};

export async function openPatientNamed(page: Page, name: PilotName) {
  await openPatient(page, PILOT_BY_NAME[name]);
}

// Sign in as a patient (their own account) and wait for the app shell (the tab strip).
export async function openPatient(page: Page, who: { email: string; password: string } = PILOTS.alex) {
  await loginAs(page, who.email, who.password);
  await page.waitForSelector('.sidebar .nav-item');
}

// Sign in as the provider (fam4), then drill into a patient by display name via the roster.
export async function openAsProvider(page: Page, patientName: string) {
  await loginAs(page, PILOTS.provider.email, PILOTS.provider.password);
  await page.click(`.roster-name:has-text("${patientName}")`);
  await page.waitForSelector('.sidebar .nav-item');
}

// W44 — robust fresh-account signup for e2e (the shared flake source). Creates a new password account,
// captures the one-time recovery code, acknowledges it. Every step web-first-waits so it's stable under
// the pre-push hook's load. Leaves the page on the W46 onboarding screen (fresh vault = 0 patients).
// Returns the recovery code. Use a unique email per test to stay non-contaminating.
export async function signUpRaw(page: Page, email: string, password = "e2e-pass-123"): Promise<void> {
  await page.goto("/");
  await page.click('button:has-text("Create an account")'); // toggle to signup mode
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  // W48 — signup enters directly (no recovery-code screen); a fresh account lands on onboarding.
  await page.locator(".onboard").waitFor({ state: "visible", timeout: 40000 });
}

// W46/W47 — a fresh account lands on the onboarding screen (empty vault). It asks only birth year + sex
// (no name); provide a year and Continue, then dismiss the Import modal createFirstClient auto-opens.
export async function completeOnboarding(page: Page): Promise<void> {
  await page.fill(".onboard input[type='number']", "1980");
  await page.click(".onboard button.primary"); // "Continue"
  const modalClose = page.locator("button.modal-close");
  await expect(modalClose).toBeVisible();
  await modalClose.click(); // close the auto-opened Import modal
}

// Full signup → onboarding → app shell. W47 — the owner shell no longer has a flat Sign-out button; the
// top-right account menu (.account-trigger) is the tell.
export async function signUp(page: Page, email: string, password = "e2e-pass-123"): Promise<void> {
  await signUpRaw(page, email, password);
  await completeOnboarding(page);
  await expect(page.locator(".account-trigger")).toBeVisible();
}

// W47 — owner account-menu interactions (the menu replaced the flat Account/Access/Sign out buttons).
export async function ownerSignOut(page: Page): Promise<void> {
  await page.click(".account-trigger");
  await page.click('.menu-item:has-text("Sign out")');
}
export async function openOwnerAccount(page: Page): Promise<void> {
  await page.click(".account-trigger");
  await page.click('.menu-item:has-text("Account settings")');
}
export async function openOwnerAccess(page: Page): Promise<void> {
  await page.click(".account-trigger");
  await page.click('.menu-item:has-text("Who can access")');
}
