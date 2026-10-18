import { expect, type Page } from "@playwright/test";

// W74 — observing the permalink flash without racing it.
//
// `flashAnchor` (src/lib/anchor.ts) adds `permalink-flash` and removes it 1200ms later. Asserting that
// class directly is only safe when the assertion is the VERY NEXT thing after the action — which is why
// search.spec.ts's checks are fine and editor.spec.ts's were not. Those did:
//
//     save → wait for the row → read its id → assert the class
//
// On a fast Mac the whole chain fits inside 1200ms and the class is still on the element. On a slower
// machine it does not, so the test observed a flash that had already come and gone, and failed with
// "unexpected value permalink-heading" — a message that points at styling rather than at timing. It
// cost a wrong diagnosis before the shape became obvious.
//
// Recording the flash as it HAPPENS removes the race entirely: the observer starts before the action,
// so no amount of slowness can hide the event. It also means the assertion no longer depends on how
// long the animation lasts, which is a UX value and not a test contract.
//
// W76 — W74 converted editor.spec.ts and stopped there, leaving the identical save→read-id→assert
// shape in shell-study-hypothesis (x3), shell-reports and shell-treatment. They passed for a month
// because they only ever ran on this Mac and, later, on an idle shard; the first time a hosted shard
// was loaded (two sibling shards thrashing memory) one of them failed with exactly the misleading
// "unexpected value permalink-heading" this header warns about. All five now use the observer, so
// the direct `toHaveClass(/permalink-flash/)` shape is gone from the suite except where it is the
// very next statement after the action (search.spec.ts).

/** Start recording every element id that receives `permalink-flash`. Call BEFORE the action. */
export async function watchFlashes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __flashed?: string[]; __flashObs?: MutationObserver };
    w.__flashObs?.disconnect();
    w.__flashed = [];
    const note = (el: Element | null) => {
      if (el instanceof HTMLElement && el.classList.contains("permalink-flash") && el.id) w.__flashed!.push(el.id);
    };
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        // The class is added to an element already in the DOM, so it arrives as an attribute mutation.
        if (r.type === "attributes") note(r.target as Element);
        // …but a node could also be inserted with the class already on it. Cheap to cover both.
        for (const added of Array.from(r.addedNodes)) {
          note(added as Element);
          if (added instanceof HTMLElement) added.querySelectorAll(".permalink-flash").forEach(note);
        }
      }
    });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    w.__flashObs = obs;
  });
}

/** Assert `id` was flashed at some point since `watchFlashes`. Order-independent and speed-independent. */
export async function expectFlashed(page: Page, id: string | null): Promise<void> {
  expect(id, "the row has no permalink id to flash").toBeTruthy();
  await expect
    .poll(() => page.evaluate((i) => ((window as unknown as { __flashed?: string[] }).__flashed ?? []).includes(i), id!), {
      timeout: 5_000,
      message: `expected ${id} to have been flashed since watchFlashes()`,
    })
    .toBe(true);
}
