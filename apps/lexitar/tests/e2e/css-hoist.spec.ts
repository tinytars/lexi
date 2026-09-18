import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSyntheticAsProvider } from "./_synthetic";
import { clickNav, clickProfileSub } from "./_nav";

// W64 — ~60 duplicated rule bodies were hoisted into app.css. The failure mode of a hoist is not a
// crash: it is a rule that silently stops applying, in one section, which no unit test can see.
// This asserts the hoisted bodies still reach each section that used to carry its own copy.
//
// NOT asserted, because it was measured to be a non-difference: the editbar variants. All of them
// hold a single child, and `justify-content: space-between` aligns a lone child to the START — so
// Study's missing flex block and the seven flex ones render the ✓ saved in the same place. The
// audit called that a rendering bug; it is not one.
async function labelStyle(page: Page, sel: string) {
  const label = page.locator(`${sel} .field > span`).first();
  await expect(label).toBeVisible();
  return label.evaluate((e) => {
    const s = getComputedStyle(e);
    return { transform: s.textTransform, weight: s.fontWeight, size: s.fontSize };
  });
}

test("the hoisted field label reaches every editor that used to define it", async ({ page }) => {
  await openSyntheticAsProvider(page);

  // Allergies/Family carry a `:not(.permalink-heading)` variant of this rule locally — a real
  // difference in what it SELECTS, so those keep their own copy; the body must still match.
  await clickProfileSub(page, "Allergies");
  await page.locator('.side-row-action[aria-label="Add allergy"]').click();
  const allergies = await labelStyle(page, ".az-modal");
  expect(allergies.transform).toBe("uppercase");
  expect(allergies.weight).toBe("600");
  await page.locator(".az-modal .btn", { hasText: "Cancel" }).click();

  await clickProfileSub(page, "Family");
  await page.locator('.side-row-action[aria-label="Add family history"]').click();
  expect(await labelStyle(page, ".fh-modal")).toEqual(allergies);
  await page.locator(".fh-modal .btn", { hasText: "Cancel" }).click();

  // Personalization never had the label rule locally at all — it reads the hoisted one.
  await clickProfileSub(page, "Bio");
  expect(await labelStyle(page, ".personalization")).toEqual(allergies);
});

// The one rename in the hoist: Personalization's .field--wide meant `grid-column: 1 / -1` while four
// other editors used the same name for `width: 100%`. It is .field--span now, and the two must not
// have swapped meanings.
test("Personalization's spanning field still spans its grid", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await clickProfileSub(page, "Bio");

  const span = page.locator(".personalization .field--span").first();
  await expect(span).toBeVisible();
  const grid = page.locator(".personalization .form-grid").first();
  const [spanBox, gridBox] = [await span.boundingBox(), await grid.boundingBox()];
  // Spanning the full grid means matching its width, not just being wide.
  expect(Math.round(spanBox!.width)).toBe(Math.round(gridBox!.width));
});

// The one visible drift among the ~60: Treatment's inputs rendered a size larger than every other
// editor's. Converged on 0.95rem / 6px.
test("Treatment's modal inputs match the other editors'", async ({ page }) => {
  await openSyntheticAsProvider(page);
  await clickNav(page, "Treatment");
  await page.getByTitle("Add treatment").click();
  // A brand-new treatment shows nothing but the capture widgets until an extraction succeeds — no
  // input[type=text] exists in the modal before that, so a real (stubbed) capture is the way in.
  await page.route("**/api/treatment-infer", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ name: "CSS check", kind: "drug" }) }),
  );
  await page.locator(".add-mode-toggle .btn", { hasText: "From text" }).click();
  await page.locator(".text-intake textarea").fill("placeholder");
  await page.locator(".text-intake .btn", { hasText: "Extract from text" }).click();
  await expect(page.locator(".ai-tag")).toBeVisible({ timeout: 10_000 });

  const input = page.locator(".tedit input[type=text]").first();
  await expect(input).toBeVisible();
  const style = await input.evaluate((e) => {
    const s = getComputedStyle(e);
    return { size: s.fontSize, radius: s.borderTopLeftRadius };
  });
  expect(style).toEqual({ size: "15.2px", radius: "6px" }); // 0.95rem at a 16px root
});
