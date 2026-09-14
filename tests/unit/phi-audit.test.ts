import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveIdentifiers, scanTree, scanText, type Identifiers } from "../../scripts/phi-audit";

// A synthetic tree, never the real records/: this suite runs on the credential-free `hosted` job,
// which asserts records/private/ is absent. The values below are invented and shaped like the real
// ones only in kind.
const DOB = "1971-03-14";
const SHA = "0f9a6b2c4d8e1f3a5b7c9d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a";
const ORIGINAL_NAME = "Doe-Jane-2019-panel.pdf";

// Two sentences that both reach the vault, from opposite directions. The first is instruction text
// the system prompt supplies to every patient alike; the second is prose about one patient.
const BOILERPLATE = "the current dose has not been re-evaluated in this reporting period";
const PATIENT_PROSE = "tricuspid pulmonary valve with moderate regurgitation gradient nine millimetres";
const NARRATIVE =
  `${BOILERPLATE} ${PATIENT_PROSE} and the plan continues unchanged until the next ` +
  "scheduled panel is drawn and reviewed with the attending team in full detail.";

// The short structured values. Every one is under 8 words, so NO shingle can ever be formed from it
// and `narrative` cannot reach it at any value of MIN_NARRATIVE — which is the whole reason the
// clinical class exists. `PROMPT_EXAMPLE` is the house-style example the system prompt supplies, and
// `GENERIC_CONDITION` is one word: both must be excluded, for different reasons.
const DIAGNOSIS = "Bicuspid mitral valve with trace regurgitation";
const ICD_CODE = "Q99.42";
const CONDITION = "seasonal grass allergy";
const PROMPT_EXAMPLE = "Coronary calcium 0; no obstructive disease";
const GENERIC_CONDITION = "hypertension";

let root: string;
let phi: string;
let golden: string;
let ids: Identifiers;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "phi-audit-"));
  phi = join(root, "records", "private");
  mkdirSync(join(phi, "c0ffee"), { recursive: true });
  writeFileSync(join(phi, "roster.json"), JSON.stringify({ clients: { c0ffee: { displayName: "Jane" } } }));
  writeFileSync(
    join(phi, "c0ffee", "vault.json"),
    JSON.stringify({
      clients: {
        c0ffee: {
          dob: DOB,
          sources: [{ originalName: ORIGINAL_NAME, sha256: SHA }],
          summary: NARRATIVE,
          factors: {
            diseases: [{ diagnostic: DIAGNOSIS, icdCodes: [ICD_CODE] }, { diagnostic: PROMPT_EXAMPLE }],
            conditions: [{ text: CONDITION }, { text: GENERIC_CONDITION }],
          },
        },
      },
    }),
  );

  // The assembled prompts. `system--` is the same for every patient, so anything in it is text the
  // model was given; `user--` interpolates patient context and so is left in scope deliberately.
  golden = join(root, "brain", "prompt-golden");
  mkdirSync(golden, { recursive: true });
  writeFileSync(
    join(golden, "system--finding.txt"),
    `Rules: ${BOILERPLATE}. Write it in the house style, e.g. "${PROMPT_EXAMPLE}". Report accordingly.`,
  );
  writeFileSync(join(golden, "user--finding.txt"), `Context: ${PATIENT_PROSE}.`);

  // The escape the audit exists to catch: a real identifier outside the store.
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "leak.ts"), `export const seeded = { dob: "${DOB}" };\n`);

  // G2's shape: a fixture that reached for the real diagnosis as its sample value.
  mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
  writeFileSync(join(root, "tests", "fixtures", "sample.json"), JSON.stringify({ diagnostic: DIAGNOSIS }));

  // Gitignored build output. A dev server or an e2e run leaves bundled Functions here, carrying
  // whatever the source carries — so scanning it makes the verdict a function of what the machine
  // happens to have run, which is the same defect as anchoring the exclusion to the scan root.
  mkdirSync(join(root, ".wrangler", "tmp"), { recursive: true });
  writeFileSync(join(root, ".wrangler", "tmp", "functionsWorker-0.42.js"), `const dob="${DOB}";`);

  ids = deriveIdentifiers(phi, golden);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("deriveIdentifiers", () => {
  it("reads identifiers out of the vault rather than a written-down list", () => {
    expect([...ids.literals.entries()]).toEqual(
      expect.arrayContaining([
        [DOB, "dob"],
        [SHA, "source-digest"],
        [ORIGINAL_NAME, "source-filename"],
      ]),
    );
    expect(ids.names).toEqual(["Jane"]);
  });
});

describe("scanTree excludes the PHI store by absolute path", () => {
  // The regression: the exclusion used to be a repo-root-anchored pattern tested against the path
  // RELATIVE TO THE SCAN ROOT, so scoping the scan narrower made it stop matching and the audit
  // reported the store's own contents as escapes — `tree .` said 8, `tree apps/health-dash-web`
  // said 79, on one tree. Both roots below must agree that the store is not an escape.
  it("holds when the scan root is the tree containing the store", () => {
    const where = scanTree(root, ids, [phi]).map((f) => f.where);
    expect(where.some((w) => w.includes("records/private"))).toBe(false);
    expect(where).toContain(join("src", "leak.ts"));
  });

  it("holds when the scan root IS the store's parent, the case that used to break", () => {
    const where = scanTree(join(root, "records"), ids, [phi]).map((f) => f.where);
    expect(where.some((w) => w.includes("private"))).toBe(false);
  });

  it("skips gitignored build output, so having run a dev server cannot change the verdict", () => {
    const where = scanTree(root, ids, [phi]).map((f) => f.where);
    expect(where.some((w) => w.includes(".wrangler"))).toBe(false);
    expect(where).toContain(join("src", "leak.ts")); // and still finds the real escape beside it
  });

  // Without this the assertions above would pass on an audit that found nothing at all, which is
  // the failure mode a PHI check can least afford.
  it("is not vacuous: the same scan without the exclusion DOES report the store", () => {
    const where = scanTree(root, ids, []).map((f) => f.where);
    expect(where.some((w) => w.includes("records/private"))).toBe(true);
  });
});

describe("system-prompt text is not an escape, user-prompt text still is", () => {
  // Direction is the whole question. A phrase that travelled repo -> vault (the model echoing its own
  // instructions back) proves nothing escaped; one that travelled vault -> repo did. The system prompt
  // is the only text guaranteed to be the former, because it is byte-identical for every patient.
  // Without this, four Tier A findings stood permanently — and a check that cannot pass gets muted.
  it("drops shingles the system prompt itself supplied", () => {
    expect(scanText(`const rule = "${BOILERPLATE}";`, "rules.ts", ids)).toHaveLength(0);
  });

  // The non-vacuity guard for the test above: the subtraction must be narrow enough that prose about a
  // patient still fails, even when it appears in the USER half of the very same prompt.
  it("keeps patient prose, including where it reaches the user half of the prompt", () => {
    const found = scanText(`> ${PATIENT_PROSE}`, "notes.md", ids).filter((f) => f.tier === "A");
    expect(found).toHaveLength(1);
    expect(found[0].cls).toBe("clinical-narrative");
    expect(JSON.stringify(found[0])).not.toContain("tricuspid");
  });

  it("holds across a whole tree: the system fixture is clean, the user fixture is not", () => {
    const narrative = scanTree(root, ids, [phi]).filter((f) => f.cls === "clinical-narrative");
    const where = narrative.map((f) => f.where);
    expect(where).not.toContain(join("brain", "prompt-golden", "system--finding.txt"));
    expect(where).toContain(join("brain", "prompt-golden", "user--finding.txt"));
  });
});

// G3 — the blind spot, and what closes it. `narrative` needs an 8-word run drawn from a string of at
// least 200 characters, so a short diagnosis, an ICD code or a condition label is invisible to it no
// matter where MIN_NARRATIVE is set. Lowering the threshold was the obvious fix and is the wrong one;
// these need their own class, matched as a whole value.
describe("short clinical values (G3)", () => {
  it("derives them from the vault, minus prompt vocabulary and one-word terms", () => {
    expect([...ids.clinical.entries()]).toEqual(
      expect.arrayContaining([
        ["bicuspid mitral valve with trace regurgitation", "diagnosis"],
        ["q99 42", "icd-code"],
        ["seasonal grass allergy", "condition"],
      ]),
    );
    // The house-style example the prompt supplies identifies nobody: every patient's prompt has it.
    expect([...ids.clinical.keys()]).not.toContain("coronary calcium 0 no obstructive disease");
    // One word is vocabulary. Keeping it would flag every legitimate mention and the audit would
    // never pass again — the failure this file's header names.
    expect([...ids.clinical.keys()]).not.toContain(GENERIC_CONDITION);
  });

  it("catches what narrative structurally cannot, and fingerprints instead of quoting", () => {
    const text = `const sample = { diagnostic: "${DIAGNOSIS}" };`;
    // Non-vacuity, and the mutation proof in one: with the clinical class emptied, every other
    // detector in the file sees nothing here. This value is 6 words long — no shingle exists.
    const withoutClass: Identifiers = { ...ids, clinical: new Map() };
    expect(scanText(text, "sample.ts", withoutClass).filter((f) => f.tier === "A")).toHaveLength(0);

    const [finding] = scanText(text, "sample.ts", ids).filter((f) => f.tier === "A");
    expect(finding.cls).toBe("diagnosis");
    expect(JSON.stringify(finding)).not.toContain("Bicuspid");
  });

  it("matches a whole value, so a code embedded in a longer one is not a hit", () => {
    expect(scanText(`code "${ICD_CODE}"`, "x.ts", ids).filter((f) => f.cls === "icd-code")).toHaveLength(1);
    expect(scanText(`code "${ICD_CODE}0"`, "x.ts", ids).filter((f) => f.cls === "icd-code")).toHaveLength(0);
  });

  it("holds across a whole tree: the fixture that reused the diagnosis is reported", () => {
    const where = scanTree(root, ids, [phi]).filter((f) => f.cls === "diagnosis").map((f) => f.where);
    expect(where).toContain(join("tests", "fixtures", "sample.json"));
  });
});

describe("scanText", () => {
  it("reports a literal at Tier A and fingerprints it instead of quoting it", () => {
    const [finding] = scanText(`const dob = "${DOB}";`, "x.ts", ids).filter((f) => f.tier === "A");
    expect(finding.cls).toBe("dob");
    expect(finding.digest).toHaveLength(8);
    expect(JSON.stringify(finding)).not.toContain(DOB);
  });

  it("keeps a bare client name at Tier B — names are reported, never a failure", () => {
    const found = scanText("run it with --client Jane", "runbook.md", ids);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ tier: "B", cls: "client-name" });
  });
});
