import { describe, expect, it, afterEach } from "vitest";
import { clearRawKeyring, corpusSubject, mintRawKey, rawKeyFor, setRawKeyring, setRawKeySink, withRawKey } from "../../src/lib/vault-raw-keys";
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

describe("mintRawKey", () => {
  // THE invariant of the whole migration: a sealed object whose key was never saved is unopenable,
  // and because the corpus reads every raw_objects row under a namespace, one of them refuses that
  // patient's every question. So the key must be durable before its ciphertext can exist.
  it("does not return the key until the sink reports the write has landed", async () => {
    const order: string[] = [];
    setRawKeySink(async () => {
      await new Promise((r) => setTimeout(r, 0));
      order.push("saved");
    });

    await mintRawKey("alex", "ab12cd34-report.pdf");

    expect(order).toEqual(["saved"]);
  });

  it("mints a distinct 32-byte key per file", async () => {
    setRawKeySink(async () => undefined);

    const one = await mintRawKey("alex", "ab12cd34-report.pdf");
    const two = await mintRawKey("alex", "ef56gh78-labs.pdf");

    expect(one).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(two).not.toBe(one);
  });

  it("hands the sink the NORMALIZED id, so the key lands where the ring reads it", async () => {
    const seen: string[] = [];
    setRawKeySink(async (id) => void seen.push(id));

    await mintRawKey("Alex", "ab12cd34-report.pdf");

    expect(seen).toEqual(["alex"]);
  });

  // No open vault is no place to record a key, and an upload that stays plaintext is recoverable
  // where a sealed object nothing holds a key for is not.
  it("returns null with no sink registered", async () => {
    expect(await mintRawKey("alex", "ab12cd34-report.pdf")).toBeNull();
  });

  it("stops minting once the vault locks", async () => {
    setRawKeySink(async () => undefined);

    clearRawKeyring();

    expect(await mintRawKey("alex", "ab12cd34-report.pdf")).toBeNull();
  });

  it("lets a failed save through as a throw, so the caller never uploads under an unsaved key", async () => {
    setRawKeySink(async () => Promise.reject(new Error("the content key could not be saved")));

    await expect(mintRawKey("alex", "ab12cd34-report.pdf")).rejects.toThrow("could not be saved");
  });
});
