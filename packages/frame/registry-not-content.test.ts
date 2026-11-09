// A claim about storage may annotate content. It may never stand in content's place.
//
// The defect this sweeps for shipped twice. `missing-attachments.svelte.ts` records which keys the
// host's file listing did not name, and that listing answers from recorded object rows rather than
// from the bucket — rows that began part-way through the consuming app's life, so a key it omits
// can have perfectly readable bytes. Two components branched on that claim ahead of their content:
// AttachmentStrip put a ⚠ where the thumbnail goes, and AttachmentViewer put an absence sentence
// where the image goes. The strip's version was the worse of the two, because substituting for the
// content also removes the only thing that fetches — so the claim became unfalsifiable by the one
// measurement that could contradict it, and the images stayed dark whatever the store held.
//
// The rule, then: no claim token may condition an {#if}/{:else if} whose branch chain renders a
// component tag or a media element. The claim keeps the jobs that do not displace anything — a
// title, a badge — and the badge chain in AttachmentStrip is why the check is written against
// content tags rather than against the claim appearing in markup at all: it holds only <span>s, it
// passes, and annotation stays legal.
//
// A claim token is the predicate itself, or the name of a `$derived` whose initializer mentions it
// DIRECTLY. That non-transitivity is the design, not an oversight in the walk. AttachmentViewer's
// `bodyError` derives from `claimedMissing` and gates an <img>, and it is correct: it combines the
// claim with the FETCH's outcome, so the sentence waits on the same evidence the image does. A
// transitive walk would condemn the very shape that fixes this, which makes one level the whole
// point of the measurement.
//
// It over-reaches and under-reaches, both by construction, because the alternative is parsing
// Svelte here. OVER: an annotation that legitimately wants its own small component inside a claim
// chain is flagged — that is a case to come back and reason about rather than an exemption to
// pre-grant. UNDER: the forward scan stops at the first {/if}, so a nested chain closes the walk
// early, and a condition spread over several lines is read only as far as its first line.
//
// Deliberately about this one registry. `PersonaBubble.svelte` substitutes a retell-registry value
// for its `children` snippet and is right to: that is a reader's own request with "Show original"
// beside it, not an unverified claim about storage.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const components = readdirSync(HERE).filter((f) => f.endsWith(".svelte"));

const CLAIM = "isAttachmentMissing";
/** A component tag (`<Capitalised`) or a media element — the things a claim must not replace. */
const CONTENT = /<[A-Z]|<img\b|<canvas\b|<video\b/;

/** The predicate, plus any `$derived` whose own initializer names it. One level, for the reason above. */
function claimTokens(src: string): string[] {
  const names = [CLAIM];
  for (const m of src.matchAll(/^[ \t]*(?:let|const)[ \t]+(\w+)[ \t]*=[ \t]*\$derived(?:\.by)?\((.*)$/gm)) {
    if (m[2].includes(CLAIM)) names.push(m[1]);
  }
  return names;
}

interface Sweep {
  offenders: string[];
  chainsExamined: number;
}

/** Every claim-conditioned chain in one file, and which of them reach content. */
function sweep(src: string, label: string): Sweep {
  const lines = src.split("\n");
  const tokens = claimTokens(src);
  const names = new RegExp(`\\b(${tokens.join("|")})\\b`);
  const offenders: string[] = [];
  let chainsExamined = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]*\{(#if|:else if)\b/.test(lines[i])) continue;
    if (!names.test(lines[i])) continue;
    chainsExamined++;
    // Forward to the first {/if}. Comments are dropped from the body, not from the file, so the
    // reported line number still points at the condition as written.
    let body = "";
    for (let j = i + 1; j < lines.length && !/^[ \t]*\{\/if\}/.test(lines[j]); j++) body += lines[j] + "\n";
    if (CONTENT.test(body.replace(/<!--[\s\S]*?-->/g, ""))) {
      offenders.push(`${label}:${i + 1} — ${lines[i].trim()}`);
    }
  }
  return { offenders, chainsExamined };
}

describe("the missing-attachment claim annotates and never substitutes for content", () => {
  it("sweeps every component in the package", () => {
    const offenders: string[] = [];
    let chainsExamined = 0;
    let filesNamingTheClaim = 0;
    for (const file of components) {
      const src = readFileSync(join(HERE, file), "utf8");
      if (!src.includes(CLAIM)) continue;
      filesNamingTheClaim++;
      const found = sweep(src, file);
      offenders.push(...found.offenders);
      chainsExamined += found.chainsExamined;
    }
    expect(offenders).toEqual([]);
    // Without these a sweep that matched nothing would pass as proof of compliance — the trap
    // snippet-props.test.ts guards the same way. Both floors are deliberately at what the package
    // holds today: the strip's badge chain is the one annotating chain, so if it ever goes, this
    // test should fall over and make somebody decide whether it still has a subject.
    expect(filesNamingTheClaim).toBeGreaterThanOrEqual(2);
    expect(chainsExamined).toBeGreaterThanOrEqual(1);
  });

  // The floors above prove the sweep looked. These prove it can convict. Both bodies are the real
  // pre-fix markup, so if the detector is ever weakened into a no-op, these fail rather than the
  // production files quietly passing.
  it("convicts the strip's pre-fix chain, which put a symbol where the thumbnail goes", () => {
    const found = sweep(
      [
        `{#if ${CLAIM}(a.key)}`,
        `  <span class="attachment-gone" aria-hidden="true">⚠</span>`,
        `{:else if a.mediaType.startsWith("image/")}`,
        `  <AttachmentThumb {clientId} fileKey={a.key} {attachmentUrl} />`,
        `{:else}`,
        `  <span class="attachment-glyph" aria-hidden="true">📄</span>`,
        `{/if}`,
      ].join("\n"),
      "<pre-fix AttachmentStrip>",
    );
    expect(found.offenders).toHaveLength(1);
    expect(found.offenders[0]).toContain(CLAIM);
  });

  it("convicts the viewer's pre-fix chain through a one-level $derived", () => {
    const found = sweep(
      [
        `  let missing = $derived(!!current && ${CLAIM}(current.key));`,
        `{#if missing}`,
        `  <p class="viewer-error">This file is missing from storage — nothing can open it.</p>`,
        `{:else if url.error && !isPdf}`,
        `  <p class="viewer-error">{url.error}</p>`,
        `{:else if isImage && current && url.current}`,
        `  <img class="viewer-image" src={url.current} alt={current.name} />`,
        `{:else}`,
        `  <p class="viewer-unsupported">No preview available for this file — use Download.</p>`,
        `{/if}`,
      ].join("\n"),
      "<pre-fix AttachmentViewer>",
    );
    expect(found.offenders).toHaveLength(1);
    expect(found.offenders[0]).toContain("missing");
  });
});
