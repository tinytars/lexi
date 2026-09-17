import { test, expect } from "./_fixtures";
import type { Page } from "@playwright/test";
import { openSyntheticAsProvider, mySynthetic } from "./_synthetic";
import { clickLeafMenuItem } from "./_leaf-menu";
import { clickNav } from "./_nav";
import { validLeafPayload } from "./_leaf-payloads";

// M63 — Notes: a reorderable single-textbox CRUD, leftmost in the Appointment tab.

async function openNotes(page: Page) {
  await openSyntheticAsProvider(page);
  await clickNav(page, "Notes");
  await page.waitForSelector(".notes", { timeout: 10_000 });
}

test("modal-Add, modal-Edit, and Delete all persist immediately (M66)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const marker = `M63 note ${Date.now()}`;
  const edited = `M63 note edited ${Date.now()}`;
  const patientName = mySynthetic().name;

  await openNotes(page);

  await page.getByTitle("Add note").click();
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Add note");
  await page.locator(".nt-modal .note-input").fill(marker);
  await page.locator(".nt-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".notes .saved")).toBeVisible({ timeout: 10_000 });

  // M66 — Edit now opens the same Add modal, pre-filled, instead of swapping the row's text for an
  // in-place textarea; act through a fresh page-level locator on the modal, not chained off `row`.
  const row = page.locator(".notes .leaf-card", { hasText: marker });
  await clickLeafMenuItem(row, "Edit");
  await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Edit note");
  await expect(page.locator(".nt-modal .note-input")).toHaveValue(marker);
  await page.locator(".nt-modal .note-input").fill(edited);
  await page.locator(".nt-modal .btn.primary", { hasText: "Save" }).click();
  await expect(page.locator(".notes .saved")).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await page.waitForSelector(".roster-list");
  await page.click(`.roster-name:has-text("${patientName}")`);
  await page.waitForSelector('.sidebar .nav-item');
  await clickNav(page, "Notes");
  await expect(page.locator(".notes")).toContainText(edited);
  await expect(page.locator(".notes")).not.toContainText(marker);

  // M66 — Delete lives directly on the row now (no in-place edit-open step needed first).
  const editedRow = page.locator(".notes .leaf-card", { hasText: edited });
  await clickLeafMenuItem(editedRow, /Delete/);
  await expect(page.locator(".notes")).not.toContainText(edited);
});

// W67 — the browser half of the id-pairing fix. The four id-keyed row leaves had NO e2e coverage at
// all (the specs in shell-leaf-regen.spec.ts cover the other five nodes), so the path that
// actually misattributed a patient's note was the one path nothing exercised end to end.
//
// The proof is order independence: the stub answers EVERY note, but returns the answers in REVERSE
// order, each result derived from the text of the note it belongs to. If the merge still paired by
// array position, every answer would land on some other note and both assertions below would show
// another note's text. Answering every note is itself part of the contract now — an unanswered row
// rejects the response — so a stub that skipped one would fail loudly instead of silently shifting.
test("noteResults answers land on their own note regardless of the order they come back (W67)", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  const stamp = Date.now();
  const noteA = `W67 pairing A ${stamp}`;
  const noteB = `W67 pairing B ${stamp}`;
  // Three, not two: the reversal has to be a real permutation, not a swap a position-pairing merge
  // could survive by accident. This used to lean on Alex's pre-existing notes to get past two —
  // a fixture property nothing asserted and nothing preserved. The test supplies its own third now.
  const noteC = `W67 pairing C ${stamp}`;
  // Deterministic from the note's own text, so a mismatch names the note that actually got the answer.
  const echoOf = (text: string) => `echo<<${text}>>`;

  // The subject here is answer-to-note PAIRING, and it needs the regen to fire at all: `regen()`
  // skips a leaf whose computed ancestors are stale. A synthetic patient's Finding ships fully
  // computed (nodeHashes unset, so nothing reads as needing recompute — see synthetic-patient.ts),
  // unlike the real pilots' committed vaults, so the pairing is always exercised here.
  await openNotes(page);

  const posted: { node?: string; inputs?: { pursuedNotes?: { id: string; text: string }[] } }[] = [];
  await page.route("**/api/leaf-regen", async (route) => {
    const body = route.request().postDataJSON() as {
      node?: string;
      inputs?: { pursuedNotes?: { id: string; text: string }[]; aiFindings?: { group: string }[] };
    };
    posted.push(body);
    if (body.node !== "noteResults") return route.fallback();
    // W68 — built by the shared helper from the request's own inputs, so it answers every note with
    // the id it was given and tags a body system the Finding actually has. This mock had to be hand-
    // patched every time the contract tightened; leaf-payloads.test.ts runs the helper's output
    // through the real validator, so the next tightening breaks there instead of here.
    const result = validLeafPayload("noteResults", (body.inputs ?? {}) as Record<string, unknown>, {
      perRow: (row) => echoOf((row as { text: string }).text),
    }) as { items: unknown[] };
    // REVERSED on purpose: the proof is that pairing follows the echoed id, not the array position.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: { items: [...result.items].reverse() } }),
    });
  });

  for (const text of [noteA, noteB, noteC]) {
    await page.getByTitle("Add note").click();
    await expect(page.locator(".modal-panel")).toHaveAttribute("aria-label", "Add note");
    await page.locator(".nt-modal .note-input").fill(text);
    await page.locator(".nt-modal .btn.primary", { hasText: "Save" }).click();
    await expect(page.locator(".notes .saved")).toBeVisible({ timeout: 10_000 });
  }

  // W75 — wait for a request that carries BOTH notes, not merely the first noteResults request.
  // The first save fires its own regen, so "some noteResults request happened" was satisfied by a
  // call that could only ever answer note A; the assertions below then raced the second call. That is
  // the most plausible cause of this spec's W74 flake (failed in the promotion gate, passed on rerun).
  const covers = (b: (typeof posted)[number], ...texts: string[]) =>
    b.node === "noteResults" && texts.every((t) => (b.inputs?.pursuedNotes ?? []).some((n) => n.text === t));
  await expect.poll(() => posted.some((b) => covers(b, noteA, noteB, noteC)), { timeout: 15_000 }).toBe(true);

  const rowA = page.locator(".notes .leaf-card", { hasText: noteA });
  const rowB = page.locator(".notes .leaf-card", { hasText: noteB });
  const rowC = page.locator(".notes .leaf-card", { hasText: noteC });
  await expect(rowA.locator(".p-assistant .note-text")).toHaveText(echoOf(noteA), { timeout: 15_000 });
  await expect(rowB.locator(".p-assistant .note-text")).toHaveText(echoOf(noteB), { timeout: 15_000 });
  await expect(rowC.locator(".p-assistant .note-text")).toHaveText(echoOf(noteC), { timeout: 15_000 });

  // The stub answered every note it was sent — verify that was at least the three this test added,
  // so the reversal is a real permutation and not a two-element swap a broken merge could survive.
  const answered = posted.filter((b) => b.node === "noteResults").pop()?.inputs?.pursuedNotes ?? [];
  expect(answered.length).toBeGreaterThanOrEqual(3);

  for (const row of [rowA, rowB, rowC]) await clickLeafMenuItem(row, /Delete/);
  await expect(page.locator(".notes")).not.toContainText(noteA);
  await expect(page.locator(".notes")).not.toContainText(noteB);
});
