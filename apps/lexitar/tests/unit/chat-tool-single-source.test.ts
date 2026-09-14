import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GET_MARKER_READINGS_TOOL } from "../../src/lib/chat-tools";

// W76. functions/api/chat.ts hand-copied this schema for sixty-odd commits under a comment saying
// "keep the name/shape in sync with chat-tools.ts" — and it had not been. The copy dropped every
// per-property description and the instruction telling the model to answer latest-value questions
// from the catalog WITHOUT a call, so the relayed schema was inviting billable tool calls the
// executor's own declaration discourages. The route was at 100% line coverage the whole time: both
// objects existed, both were valid, and no assertion anywhere compared them.
//
// The fix is that there is now one object, so parity is not a thing that can be true or false. What
// remains testable is that nobody re-declares it, which is a source-level property — hence a grep.
describe("the chat tool is declared once, where it is executed", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const relay = readFileSync(resolve(ROOT, "functions/api/chat.ts"), "utf8");

  it("the relay imports the shared declaration instead of writing its own", () => {
    expect(relay).toMatch(/import \{[^}]*GET_MARKER_READINGS_TOOL[^}]*\} from "\.\.\/\.\.\/src\/lib\/chat-tools"/);
    expect(relay).not.toMatch(/(const|let|var)\s+GET_MARKER_READINGS_TOOL/);
  });

  it("no route declares a tool schema of its own", () => {
    // input_schema is Anthropic's tool-declaration key and appears nowhere else; a Function that
    // grows one is declaring a tool the browser has no executor for.
    expect(relay).not.toContain("input_schema");
  });

  it("the shared declaration still carries what the copy had dropped", () => {
    const { properties } = GET_MARKER_READINGS_TOOL.input_schema;
    expect(GET_MARKER_READINGS_TOOL.description).toContain("without a call");
    expect(properties.markers.description).toBeTruthy();
    expect(properties.from.description).toBeTruthy();
    expect(properties.to.description).toBeTruthy();
  });
});
