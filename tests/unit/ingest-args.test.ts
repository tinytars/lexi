import { describe, it, expect, vi, afterEach } from "vitest";
import { parseArgs, usage } from "../../scripts/ingest-args";

describe("parseArgs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a bare positional argument as the input path", () => {
    expect(parseArgs(["./client-a.xlsx"]).inputPath).toBe("./client-a.xlsx");
  });

  it("parses --client, --display-name, --dob, and --gender", () => {
    const out = parseArgs(["--client", "a", "--display-name", "Client A", "--dob", "1980-01-01", "--gender", "female"]);
    expect(out).toMatchObject({ client: "a", displayName: "Client A", dob: "1980-01-01", gender: "female" });
  });

  it("rejects an invalid --gender value", () => {
    expect(() => parseArgs(["--gender", "other"])).toThrow(/--gender must be "male" or "female"/);
  });

  it("collects repeatable flags into arrays", () => {
    const out = parseArgs(["--add-marker", "Vitamin D", "--add-marker", "TSH", "--remove-marker", "LDL"]);
    expect(out.addMarkers).toEqual(["Vitamin D", "TSH"]);
    expect(out.removeMarkers).toEqual(["LDL"]);
  });

  it("parses --add-study via parseStudy and --clear-studies as a boolean", () => {
    const out = parseArgs(["--add-study", "Selection|found low ferritin", "--clear-studies"]);
    expect(out.addStudies).toEqual([{ focus: "Selection", detail: "found low ferritin" }]);
    expect(out.clearStudies).toBe(true);
  });

  it("collects --remove-ratio as a repeatable list", () => {
    expect(parseArgs(["--remove-ratio", "AST/ALT", "--remove-ratio", "T/E2"]).removeRatios).toEqual(["AST/ALT", "T/E2"]);
  });

  it("requires key=value for --set-factor", () => {
    expect(() => parseArgs(["--set-factor", "bmi"])).toThrow(/--set-factor requires key=value/);
  });

  it("parses --sync-treatment-attachments with an optional trailing name", () => {
    expect(parseArgs(["--sync-treatment-attachments"]).syncTreatmentAttachmentsName).toBeUndefined();
    expect(parseArgs(["--sync-treatment-attachments", "Tirzepatide"])).toMatchObject({
      syncTreatmentAttachments: true,
      syncTreatmentAttachmentsName: "Tirzepatide",
    });
    // a following flag (not a bare name) must not be swallowed as the name.
    const out = parseArgs(["--sync-treatment-attachments", "--force"]);
    expect(out.syncTreatmentAttachmentsName).toBeUndefined();
    expect(out.force).toBe(true);
  });

  it("errors the same way today on an unrecognized flag", () => {
    expect(() => parseArgs(["--not-a-real-flag"])).toThrow(/unknown arg: --not-a-real-flag/);
  });

  it("defaults every boolean/array field so downstream code never sees undefined", () => {
    const out = parseArgs([]);
    expect(out.clearDiseases).toBe(false);
    expect(out.addTreatments).toEqual([]);
    expect(out.help).toBe(false);
    expect(out.needsClient).toBe(false);
  });

  // Regression: --add-decision/--remove-decision/--clear-decisions/--sync-treatment-attachments
  // mutate client state in ingest.ts but were missing from the old hand-maintained needsClient
  // OR-list, so running any of them without --client silently no-op'd instead of erroring.
  it("sets needsClient for every flag that mutates client state", () => {
    const clientMutatingInvocations = [
      ["--display-name", "Client A"],
      ["--dob", "1980-01-01"],
      ["--gender", "female"],
      ["--add-marker", "TSH"],
      ["--remove-marker", "TSH"],
      ["--add-disease", "2020-01|CLL"],
      ["--remove-disease", "CLL"],
      ["--clear-diseases"],
      ["--add-treatment", "Tirzepatide|6mg/week"],
      ["--remove-treatment", "Tirzepatide"],
      ["--clear-treatments"],
      ["--sync-treatment-attachments"],
      ["--migrate-treatments"],
      ["--migrate-correlations"],
      ["--migrate-notes"],
      ["--add-decision", "TRT|improved free T"],
      ["--remove-decision", "TRT"],
      ["--clear-decisions"],
      ["--set-factor", "bmi=25"],
      ["--add-study", "Selection|found low ferritin"],
      ["--clear-studies"],
      ["--remove-ratio", "AST/ALT"],
      ["--refresh-ranges"],
      ["--refresh-finding"],
      ["--refresh-marker-groups"],
      ["--import-reports", "./reports"],
      ["--remove-source", "abc123"],
      ["--migrate-sources"],
      ["--process-pending"],
      ["--prune-finding-orphans"],
      ["./client-a.xlsx"],
    ];
    for (const argv of clientMutatingInvocations) {
      expect(parseArgs(argv).needsClient, `needsClient for ${argv.join(" ")}`).toBe(true);
    }
  });

  it("does not set needsClient for flags that support an omit-client-for-all mode", () => {
    for (const argv of [["--reconcile"], ["--backfill-treatment-assessment"], ["--backfill-note-results"]]) {
      expect(parseArgs(argv).needsClient, `needsClient for ${argv.join(" ")}`).toBe(false);
    }
  });
});

// Table-driven so adding/renaming a flag only means adding a row here, not a golden-file diff.
const DOCUMENTED_FLAGS = [
  "--client", "--display-name", "--set-dob", "--set-gender", "--add-marker", "--remove-marker",
  "--add-disease", "--remove-disease", "--clear-diseases", "--add-treatment", "--remove-treatment",
  "--clear-treatments", "--sync-treatment-attachments", "--migrate-treatments", "--migrate-correlations",
  "--migrate-notes", "--add-decision", "--remove-decision", "--clear-decisions", "--set-factor",
  "--add-study", "--clear-studies", "--remove-ratio", "--refresh-ranges", "--marker", "--all-markers",
  "--refresh-finding", "--refresh-marker-groups", "--import-reports", "--dry-run", "--remove-source",
  "--no-sync", "--process-pending", "--reconcile", "--backfill-treatment-assessment",
  "--backfill-note-results", "--backfill-family-results", "--backfill-allergy-results",
  "--prune-finding-orphans", "--backfill-plan-assessment", "--migrate-sources", "--force", "--init",
  "--rebuild-roster", "--mode", "--help",
];

describe("usage", () => {
  it("exits 0 and mentions every documented flag", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    // usage()'s `never` return type (it really does exit) makes TS treat code after a direct call as
    // unreachable, even though the mock above prevents that at runtime — cast away `never` to keep it.
    (usage as unknown as () => void)();
    const output = write.mock.calls.map((c) => c[0]).join("");
    for (const flag of DOCUMENTED_FLAGS) expect(output).toContain(flag);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
