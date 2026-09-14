// Node refuses to strip types from a .ts file resolved into node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — a hard rule with no override flag, hit here
// because @tinytars/frame and @tinytars/vault ship raw .ts with no compiled dist. `tsx --import`
// lifts the restriction but does so process-wide with `keepNames: true`, which injects an
// `__name(fn, "name")` helper call into every function it transforms — including first-party
// tests/e2e/*.ts closures that Playwright's `page.evaluate` serializes into the browser, where
// that helper doesn't exist (`ReferenceError: __name is not defined`). Scoping the transform to
// only these two packages' node_modules trees avoids touching anything Playwright already
// handles correctly on its own.
import { transform } from "esbuild";

const SCOPED = ["/node_modules/@tinytars/frame/", "/node_modules/@tinytars/vault/"];

export async function load(url, context, next) {
  if (url.endsWith(".ts") && SCOPED.some((prefix) => url.includes(prefix))) {
    const { source } = await next(url, { ...context, format: "module" });
    const code = typeof source === "string" ? source : Buffer.from(source).toString("utf8");
    const { code: transformed } = await transform(code, { loader: "ts", format: "esm", sourcefile: url });
    return { format: "module", source: transformed, shortCircuit: true };
  }
  return next(url, context);
}
