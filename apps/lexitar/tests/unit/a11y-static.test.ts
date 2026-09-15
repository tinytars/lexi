import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// W70 Phase 3, rewritten in W71 — the accessibility facts that can honestly be checked from SOURCE.
//
// The first version of this file was the anti-pattern W68 removed from this codebase, relocated to
// Svelte source text. It asserted that App.svelte contained `aria-label="Email"`, that
// MarkerChart.svelte contained `class="mc-figure-toggle"` and `aria-expanded={expanded}`, that it did
// NOT contain `function onFigureClick`, and that a specific CSS line existed verbatim. Every one of
// those detects deletion and nothing else: switching the email field to a `<label for>` — BETTER
// accessibility — would have failed it, while rendering the right attribute onto a `display:none`
// element would have passed.
//
// What survives is only the shape that store-key-classes.test.ts established: assertions DERIVED from
// the other side of the invariant, which a NEW violation trips without anyone remembering to update
// them. A sweep of every component for a hand-rolled dialog catches the next AboutOverlay; a list of
// aria-label strings catches nothing that is not already deleted.
//
// The judgement that was being tested by grep now lives in src/lib/marker-status.ts and is asserted
// by behaviour in marker-status.test.ts, and axe (tests/e2e/a11y.spec.ts) evaluates the real
// accessibility tree in a browser, which is the only place labels and roles can actually be decided.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("no input is left placeholder-only", () => {
  // A blind patient could not get into their own health record: the email, password, recovery-code
  // and new-password fields were placeholder-only. Placeholder is not a label (WCAG 3.3.2) and the
  // text vanishes on the first keystroke.
  //
  // Derived: every <input> that HAS a placeholder must also have a name. A newly added one fails this
  // without the test knowing anything about it — which is exactly what naming the four known fields
  // could not do.
  it.each(["src/App.svelte", "src/lib/ChatTab.svelte"])("%s", (file) => {
    const offenders = [...read(file).matchAll(/<input\b[^>]*placeholder=[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => !/aria-label=|aria-labelledby=|\bid=/.test(tag));
    expect(offenders).toEqual([]);
  });
});

describe("the app can announce", () => {
  const app = read("src/App.svelte");

  // Before W70 there were ZERO live regions anywhere: no aria-live, role="alert", role="status" or
  // aria-busy across App.svelte and all 62 lib components. Errors were silently inserted <p>s.
  //
  // Derived, and the reason this one is worth keeping: it reads the CHANNEL LIST off the component's
  // own error state rather than restating it. An error channel added tomorrow and not routed into the
  // live region fails here.
  it("routes every error channel into the assertive region", () => {
    const declared = [...app.matchAll(/let (\w*[eE]rror)\b[^=]*=\s*\$state/g)].map((m) => m[1]);
    expect(declared.length, "expected some error state on App").toBeGreaterThan(2);

    const announced = app.match(/const announcedError = \$derived\(([\s\S]*?)\);/);
    expect(announced, "announcedError should exist").toBeTruthy();
    const missing = declared.filter((c) => !announced![1].includes(c));
    expect(missing, "error channels that never reach a screen reader").toEqual([]);
  });

  it("the hidden regions use a recipe that keeps them in the accessibility tree", () => {
    // display:none / visibility:hidden would remove them from the a11y tree too, which is the classic
    // way to ship a live region that announces nothing. .sr-only lives in @tinytars/frame's theme now.
    const theme = read("../../packages/frame/theme.css");
    const srOnly = theme.match(/\.sr-only\s*\{[\s\S]*?\}/);
    expect(srOnly).toBeTruthy();
    expect(srOnly![0]).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });
});

describe("no component hand-rolls its own modal any more", () => {
  // AboutOverlay carried an independent copy of the overlay and so an independent copy of every
  // defect: no focus trap, no focus restore, and a <svelte:window> Escape that closed every mounted
  // overlay at once. Its own comment claimed "the app has no dialog component of its own".
  const components = readdirSync(join(ROOT, "src/lib")).filter((f) => f.endsWith(".svelte"));

  it("finds the components at all, so an empty sweep cannot pass", () => {
    expect(components.length).toBeGreaterThan(40);
  });

  it("only Modal.svelte owns a backdrop-and-panel overlay", () => {
    const offenders = components
      .filter((f) => f !== "Modal.svelte")
      .filter((f) => /role="dialog"|aria-modal="true"/.test(read(join("src/lib", f))));
    expect(offenders).toEqual([]);
  });
});

// NOT asserted here, deliberately:
//
//   • "every <select> has an accessible name" — label association cannot be decided from source text.
//     The codebase's real shape is `<label><span>Severity</span><select>`, and a regex naive enough to
//     miss the intervening <span> reported 13 offenders where axe reports one.
//   • MarkerChart's status word and accessible name — now marker-status.ts, asserted by behaviour.
//   • nested-interactive / role="button" wrappers — axe rates these against the real accessibility
//     tree; the source-text version asserted a CSS class name and the ABSENCE of two function
//     declarations, which is a deletion detector wearing an accessibility label.
