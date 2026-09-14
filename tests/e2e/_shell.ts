import { expect, type Page } from "@playwright/test";
import { openPatientNamed, type PilotName } from "./_login";

// W74 — the helpers `shell-nav.spec.ts` shared with itself, now that it is seven files.
//
// It was 1437 lines and 53 tests, which made it indivisible to the CI gate: `--shard` partitions by
// FILE, so whichever shard held it ran ~56 tests against one workerd while every other shard ran 19.
// That shard was the gate's chronic red — it exhausted the server, auto-retried, and sometimes failed
// again. Splitting the file is what makes the partition balance; this module is what stops the split
// from copy-pasting five helpers seven ways.
//
// Only the helpers used by MORE than one of the split files live here. A helper with one caller stays
// in the file that calls it, where its comment sits next to the test it explains.

/** Unlock as a pilot and open their record. */
export async function unlock(page: Page, name: PilotName) {
  await openPatientNamed(page, name);
}


// Treatment's default bucket is All (per-drug dose history), whose card menu edits the MEDICINE
// (Name/Reason/Kind) — it deliberately has no Amount field. Any test that edits a dose has to pick
// a temporal bucket first, where a card IS one dose entry.
// W64 — "All" belongs here: ALL_GROUP_LABEL leads every grouped section's row list, and three
// call sites below already pass it. The union predated that row.
export async function gotoTreatmentBucket(page: Page, bucket: "All" | "Ongoing" | "Planned" | "Past") {
  await page.locator(".sidebar .group-list .sub-item", { hasText: bucket }).click();
  await expect(page.locator(".sidebar .group-list .sub-item", { hasText: bucket })).toHaveClass(/active/);
}

// Every Treatment view is now one card per MEDICINE whose Patient side is a table of that drug's
// dose periods. The card's own menu edits the medicine (Name/Reason/Kind); a dose is edited from its
// row in that table, which is what these dose-level tests want.
// "Ongoing" is a property of a dose WINDOW, not of a row's position: a medicine's newest row can be
// a future-dated step, and its last row can be the AM half of a twice-daily pair whose PM half is
// also live. So a test that needs an ongoing dose creates one with an explicit past start and no
// end, rather than trusting "the first row in the Ongoing view" — which is what made these bind to
// the fixture's shape and break when the real vault (38 treatments) replaced the old one.
// A brand-new treatment has no manual entry point — the modal shows nothing but the capture
// widgets until an extraction succeeds. Every "add a treatment" helper below goes through a
// stubbed "From text" capture (never mind that the pasted text is a placeholder — the point of
// these tests is what happens after a treatment exists, not the extraction itself).
export async function identifyTreatmentByText(page: Page, result: Record<string, unknown>) {
  await page.route("**/api/treatment-infer", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) }),
  );
  await page.locator(".add-mode-toggle .btn", { hasText: "From text" }).click();
  await page.locator(".text-intake textarea").fill("placeholder");
  await page.locator(".text-intake .btn", { hasText: "Extract from text" }).click();
  await expect(page.locator(".ai-tag")).toBeVisible({ timeout: 10_000 });
}

export async function addOngoingTreatment(page: Page, name: string) {
  await page.getByTitle("Add treatment").click();
  await identifyTreatmentByText(page, { name, kind: "drug" });
  // M-dose-gates-assessment — treatmentAssessment only triggers once the drug has a dose on file, so
  // a helper standing in for "a real ongoing treatment" has to set one, not just a start date.
  await page.locator(".tedit .field", { hasText: /^Amount/ }).locator("input").fill("1");
  await page.locator(".tedit-daterow .field", { hasText: "Start" }).locator("input").fill("2020-01-01");
  await page.locator(".tedit-actions .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".unified-treatment .saved")).toBeVisible({ timeout: 10_000 });
}

export async function editFirstDoseEntry(page: Page) {
  await page.locator(".unified-treatment .med-table td.med-actions .btn", { hasText: "Edit" }).first().click();
}
