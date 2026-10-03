// Turning a pasted address into an account. Two properties matter, and only one of them is about
// getting the right answer: the ladder must resolve the cheap cases without opening anything, and when
// it cannot resolve them it must stop, because opening a record to find out whose it is discloses that
// record to a principal the owner approved for a different person's export.
//
// The "opened nothing" half is asserted by the recorded request list, never by reading stderr — a
// message can say it opened nothing while a request went out.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clientKeyFromUrl, findClientKey, resolveOwner } from "../../scripts/resolve-owner";
import { main } from "../../scripts/record-export";
import { grant, OTHER, OWNER, supportCli } from "../support/support-origin";

const cli = supportCli();
const accessCalls = () => cli.sent.filter((s) => s === "POST /api/support/access").length;
const manifest = () =>
  JSON.parse(readFileSync(join(cli.dir, readdirSync(cli.dir)[0], "manifest.json"), "utf8")) as Record<string, string>;

describe("clientKeyFromUrl", () => {
  it("takes the person from a link that also names a section", () => {
    expect(clientKeyFromUrl("#alex/markers")).toBe("alex");
  });

  // What an address bar most often holds, and what parseHash returns null for.
  it("takes the person from a lone segment, which parses to no permalink at all", () => {
    expect(clientKeyFromUrl("#alex")).toBe("alex");
  });

  it("accepts the whole pasted URL, not just its fragment", () => {
    expect(clientKeyFromUrl("https://literacy.tinytars.foundation/#alex/markers/mk-1")).toBe("alex");
  });

  it("lower-cases and decodes, because a key is compared and never displayed", () => {
    expect(clientKeyFromUrl("#Alex%20B/markers")).toBe("alex b");
  });

  it("refuses a link that names a section and nobody rather than picking someone", () => {
    expect(() => clientKeyFromUrl("#markers")).toThrow(/not whose it is.*--patient/s);
  });

  it("refuses a URL with no fragment at all", () => {
    expect(() => clientKeyFromUrl("https://literacy.tinytars.foundation/")).toThrow(/carries no #/);
  });
});

describe("resolveOwner", () => {
  it("resolves nothing when nothing is approved", () => {
    expect(resolveOwner("alex", [])).toEqual({ kind: "none" });
  });

  it("uses the only approved record without looking at the key", () => {
    expect(resolveOwner("alex", [{ ownerAccountId: OWNER }])).toMatchObject({ kind: "owner", ownerAccountId: OWNER });
  });

  // A vault created through the provider flow is keyed by the owner's own account id, so the pasted
  // slug often is the answer and costs nothing to check.
  it("matches an account id among several approved records", () => {
    expect(resolveOwner(OTHER, [{ ownerAccountId: OWNER }, { ownerAccountId: OTHER }])).toMatchObject({
      kind: "owner",
      ownerAccountId: OTHER,
    });
  });

  it("reports every candidate rather than guessing between them", () => {
    expect(resolveOwner("alex", [{ ownerAccountId: OWNER }, { ownerAccountId: OTHER }])).toEqual({
      kind: "ambiguous",
      candidates: [OWNER, OTHER],
    });
  });
});

describe("findClientKey", () => {
  it("returns the key as the vault spells it, since normalization is only case", () => {
    expect(findClientKey({ "Alex B": {} }, "alex b")).toBe("Alex B");
    expect(findClientKey({ alex: {} }, "blair")).toBeUndefined();
  });
});

describe("record:export --url", () => {
  it("exports the one approved record a pasted link can only mean", async () => {
    await main(["--url", "https://literacy.tinytars.foundation/#alex/markers"]);
    expect(manifest().accountId).toBe(OWNER);
    expect(accessCalls()).toBe(1);
  });

  it("resolves an account-id key among several approved records with one open", async () => {
    cli.use({ owners: [grant(OTHER), grant(OWNER)] });
    await main(["--url", `#${OWNER}`]);
    expect(manifest().accountId).toBe(OWNER);
    expect(accessCalls()).toBe(1);
  });

  it("opens nothing when a slug could be any of several approved records", async () => {
    cli.use({ owners: [grant(OWNER), grant(OTHER)] });
    await expect(main(["--url", "#alex/markers"])).rejects.toThrow(new RegExp(`${OWNER}.*${OTHER}.*--probe`, "s"));
    expect(cli.sent).toContain("GET /api/support/owners");
    expect(accessCalls()).toBe(0);
  });

  it("under --probe opens candidates in order and stops at the one that holds the key", async () => {
    cli.use({ owners: [grant(OTHER), grant(OWNER)] });
    await main(["--url", "#alex", "--probe"]);
    expect(manifest().accountId).toBe(OWNER);
    expect(manifest().clientKey).toBe("alex");
    expect(accessCalls()).toBe(2);
    expect(cli.err).toMatch(/each open writes a row on that person's own access screen/);
  });

  it("refuses to be told the same thing two ways", async () => {
    await expect(main(["--url", "#alex", "--patient", OWNER])).rejects.toThrow(/pass one/);
  });
});
