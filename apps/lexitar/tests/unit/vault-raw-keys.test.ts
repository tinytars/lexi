import { describe, expect, it, afterEach } from "vitest";
import { clearRawKeyring, corpusSubject, rawKeyFor, setRawKeyring, withRawKey } from "../../src/lib/vault-raw-keys";
import type { Vault } from "../../src/lib/types";

const KEY = "A".repeat(43) + "=";
const OTHER = "B".repeat(43) + "=";

afterEach(clearRawKeyring);

describe("setRawKeyring", () => {
  it("finds a key stored under a display-cased id from the normalized one", () => {
    setRawKeyring({ rawKeys: { Alex: { "ab12cd34-report.pdf": KEY } } });

    expect(rawKeyFor("alex", "ab12cd34-report.pdf")).toBe(KEY);
  });

  // A vault written before the ring existed has none, and every reader tolerates that.
  it("publishes an empty ring for a vault with no keys", () => {
    setRawKeyring({});

    expect(rawKeyFor("alex", "ab12cd34-report.pdf")).toBeUndefined();
  });
});

it("takes the keys with it when the vault locks", () => {
  setRawKeyring({ rawKeys: { alex: { "ab12cd34-report.pdf": KEY } } });

  clearRawKeyring();

  expect(rawKeyFor("alex", "ab12cd34-report.pdf")).toBeUndefined();
});

describe("corpusSubject", () => {
  it("pairs the record with the keys that open its documents", () => {
    setRawKeyring({ rawKeys: { alex: { "ab12cd34-report.pdf": KEY } } });

    expect(corpusSubject("alex")).toEqual({ clientId: "alex", rawKeys: { "ab12cd34-report.pdf": KEY } });
  });

  it("keeps a null subject null, so a body with no record still type-checks", () => {
    expect(corpusSubject(null)).toEqual({ clientId: null, rawKeys: {} });
  });
});

describe("withRawKey", () => {
  it("records the key in the vault that will be saved", () => {
    const vault = withRawKey({ clients: {} } as Vault, "Alex", "ab12cd34-report.pdf", KEY);

    expect(vault.rawKeys).toEqual({ alex: { "ab12cd34-report.pdf": KEY } });
  });

  // The two halves cannot diverge: a key saved but not published leaves this page unable to open
  // the file it just uploaded.
  it("publishes the same key to the open ring", () => {
    withRawKey({ clients: {} } as Vault, "alex", "ab12cd34-report.pdf", KEY);

    expect(rawKeyFor("alex", "ab12cd34-report.pdf")).toBe(KEY);
  });

  it("leaves another record's keys alone", () => {
    const before = { clients: {}, rawKeys: { sam: { "ef56gh78-labs.pdf": OTHER } } } as Vault;

    const after = withRawKey(before, "alex", "ab12cd34-report.pdf", KEY);

    expect(after.rawKeys?.sam).toEqual({ "ef56gh78-labs.pdf": OTHER });
  });
});
