import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// W62 — the guard for a bug class NOTHING else in this repo can catch.
//
// Twice in one week a prop was declared in a component's props type and left out of the
// `let { … } = $props()` destructure. Svelte accepts the prop and silently drops it: the parent binds
// it, the child never sees it, and the feature is simply dead. RecommendedMarkers declared
// `activeGroup` that way, so every Markers row click fell through to a scroll for weeks.
//
// Why a test and not a lint rule:
//   • There is NO ESLint in this repo — no config, no dependency, at app or workspace root.
//   • svelte-check structurally cannot see it. The Props interface types the incoming prop BAG;
//     destructuring a subset of a typed object is valid TypeScript. Nothing is unused to TS either,
//     since the annotation still references Props.
//   • svelte.config.js is empty and the compiler emits no warning for this.
//   • tsconfig's noUnusedLocals wouldn't apply: the missing binding never exists as a local.
//
// Reading source as text is an established convention here (brand.test.ts, sidebar-mode.test.ts,
// anchored-menu.test.ts and four others do the same).

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) svelteFiles(p, out);
    else if (e.name.endsWith(".svelte")) out.push(p);
  }
  return out;
}

/** The body of the first balanced `{…}` starting at `from`. */
function braceBody(src: string, from: number): string | null {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

/** Top-level field names of a props type body (skips nested object/function types). */
function declaredFields(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (depth === 0) {
      // `name?: T` / `name: T` — not a comment, not a continuation
      const m = /^([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(line);
      if (m && !line.startsWith("//") && !line.startsWith("*")) names.push(m[1]);
    }
    depth += (line.match(/[{(]/g) ?? []).length - (line.match(/[})]/g) ?? []).length;
  }
  return names;
}

/** Prop name -> the LOCAL identifier it binds (`pair: p` binds prop `pair` as local `p`). */
function boundPairs(body: string): { prop: string; local: string }[] {
  const names: { prop: string; local: string }[] = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    const t = current.trim();
    current = "";
    if (!t || t.startsWith("...")) return;
    // `prop = default`, `prop: local`, `prop: local = default`, `prop = $bindable(x)`
    const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/.exec(t);
    if (m) names.push({ prop: m[1], local: m[2] ?? m[1] });
  };
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") { current += ch + (body[++i] ?? ""); continue; }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; current += ch; continue; }
    if ("{([".includes(ch)) depth++;
    else if ("})]".includes(ch)) depth--;
    if (ch === "," && depth === 0) flush();
    else current += ch;
  }
  flush();
  return names;
}

function propsOf(src: string): { declared: string[]; bound: string[]; pairs: { prop: string; local: string }[]; rest: string } | null {
  const destructure = /let\s*\{/.exec(src);
  if (!destructure || !/\$props\(\)/.test(src)) return null;
  const pairs = boundPairs(braceBody(src, destructure.index) ?? "");
  const bound = pairs.map((p) => p.prop);
  // Everything after the destructure — script tail AND template, since a prop is often used only in
  // markup. Comments are stripped so a prop merely NAMED in a comment doesn't read as used.
  const after = src.slice(src.indexOf("$props()", destructure.index));
  const rest = after.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  // Either `interface Props { … }` or an inline `}: { … } = $props()` type.
  const iface = /interface\s+Props\s*\{/.exec(src);
  if (iface) return { declared: declaredFields(braceBody(src, iface.index) ?? ""), bound, pairs, rest };
  const inline = /\}\s*:\s*\{/.exec(src);
  if (inline) return { declared: declaredFields(braceBody(src, inline.index + 1) ?? ""), bound, pairs, rest };
  return null;
}

// doc 13 has been moving generic components into packages/frame — this guard's bug class
// (a declared prop silently dropped, or bound but never read) applies there exactly as much as
// it does in src/, so the glob follows the components rather than staying pinned to their old home.
const FILES = [...svelteFiles(resolve("src")), ...svelteFiles(resolve("../../packages/frame"))];

describe("every declared prop is destructured", () => {
  it("finds components to check (guards the glob itself)", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.filter((f) => propsOf(readFileSync(f, "utf8"))).length).toBeGreaterThan(40);
  });

  // The assertion that would have caught both shipped bugs.
  it("no component declares a prop it never binds", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const p = propsOf(readFileSync(file, "utf8"));
      if (!p) continue;
      const missing = p.declared.filter((d) => !p.bound.includes(d));
      if (missing.length) offenders.push(`${file.replace(resolve("."), ".")}: ${missing.join(", ")}`);
    }
    expect(offenders, "declared in Props but absent from `let { … } = $props()` — the prop is silently dropped").toEqual([]);
  });
});

// The same silent failure one line lower: bound, then never read. The parent passes it, the child
// accepts it, and nothing happens — indistinguishable to the user from the missing-binding case.
// `children` is exempt: it is rendered via {@render children()} but also legitimately absent.
const UNUSED_EXEMPT = new Set(["children"]);

describe("every bound prop is actually used", () => {
  it("no component binds a prop it never reads", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const p = propsOf(readFileSync(file, "utf8"));
      if (!p) continue;
      const dead = p.pairs
        .filter(({ local }) => !UNUSED_EXEMPT.has(local))
        .filter(({ local }) => !new RegExp(`\\b${local}\\b`).test(p.rest))
        .map(({ prop }) => prop);
      if (dead.length) offenders.push(`${file.replace(resolve("."), ".")}: ${dead.join(", ")}`);
    }
    expect(offenders, "bound from $props() but never referenced — the parent's value goes nowhere").toEqual([]);
  });
});
