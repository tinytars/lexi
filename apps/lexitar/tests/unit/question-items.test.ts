import { describe, it, expect } from "vitest";
import { questionGroups, questionItems } from "../../src/lib/question-items";
import { questionsSidebarGroups } from "../../src/lib/questions-sidebar-groups";
import { questionsSearchLeaves } from "../../src/lib/search-index";
import { itemRecordId } from "@pablotech/akesi-pil/item-registry";
import type { Client } from "../../src/lib/types";

// W63 — the questions derivation existed three times. Two copies were verbatim identical; the
// third (search) had drifted into walking the WHOLE doctorConversation, so it offered questions the
// page never renders, whose anchors resolve to nothing.
//
// `doctorConversation` holds the per-system groups FIRST, one per `disease` entry, then groups that
// belong to other sections. `systemOrder` here is driven by `disease`, so with two diseases only
// the first two entries are this section's — "Other Voices" below is the trailing kind that must
// never be indexed.
function client(over: Partial<Client> = {}): Client {
  return {
    displayName: "A", dob: "1980-01-01", gender: "male", watchlist: [], results: [],
    finding: {
      disease: [
        { group: "Renal", finding: "r" },
        { group: "Cardiovascular Risk", finding: "cv" },
      ],
      doctorConversation: [
        // Deliberately NOT in systemOrder order — the derivation re-orders by it.
        { group: "Cardiovascular Risk", questions: ["Is my ApoB actionable?", "Statin or not?"] },
        { group: "Renal", questions: ["Is eGFR drifting?"] },
        { group: "Other Voices", questions: ["a question this section never renders"] },
      ],
    },
    ...over,
  } as unknown as Client;
}

describe("questionGroups", () => {
  it("takes only the leading per-system groups, in System Analysis order", () => {
    expect(questionGroups(client()).map((g) => g.group)).toEqual(["Renal", "Cardiovascular Risk"]);
  });
});

describe("questionItems", () => {
  it("is flat, one item per question, with the anchor keyed to the ORIGINAL index", () => {
    const items = questionItems(client());
    expect(items.map((i) => i.question)).toEqual([
      "Is eGFR drifting?",
      "Is my ApoB actionable?",
      "Statin or not?",
    ]);
    // Positional anchors: "Statin or not?" is questions[1] of its group and must stay index 1 even
    // though it is the third item overall.
    expect(items[2].index).toBe(1);
    expect(items[2].anchor).toContain("1");
  });

  it("puts a pinned question first, which is what the sidebar row already did", () => {
    const pinnedLast = client({
      itemRegistry: [{ kind: "question", label: "Statin or not?", pinned: true }],
    } as Partial<Client>);
    expect(questionItems(pinnedLast)[0].question).toBe("Statin or not?");
    expect(questionItems(pinnedLast)[0].pinned).toBe(true);
  });
});

describe("all three surfaces read the same derivation", () => {
  it("the body list, the sidebar's All row and search agree, question for question", () => {
    const c = client();
    const body = questionItems(c).map((i) => `${i.question}@${i.anchor}`);
    const sidebarAll = questionsSidebarGroups(c)[0].children!.map((r) => `${r.searchText}@${r.anchor}`);
    const search = questionsSearchLeaves(c).map((l) => `${l.label}@${l.anchor}`);
    expect(sidebarAll).toEqual(body);
    expect(search).toEqual(body);
  });

  it("search no longer indexes a group this section never renders", () => {
    const labels = questionsSearchLeaves(client()).map((l) => l.label);
    expect(labels).not.toContain("a question this section never renders");
    expect(labels).toHaveLength(3);
  });

  it("a pin moves the row and the cell together, not one without the other", () => {
    const c = client({
      itemRegistry: [{ kind: "question", label: "Statin or not?", pinned: true }],
    } as Partial<Client>);
    const firstBody = questionItems(c)[0];
    const firstRow = questionsSidebarGroups(c)[0].children![0];
    expect(firstRow.anchor).toBe(firstBody.anchor);
    // And the pin they read is one record, not two.
    expect(firstRow.itemId).toBe(itemRecordId("question", firstBody.question));
    expect(firstRow.pinned).toBe(true);
  });

  it("a per-topic row shows that topic's questions in the All row's order", () => {
    const c = client({
      itemRegistry: [{ kind: "question", label: "Statin or not?", pinned: true }],
    } as Partial<Client>);
    const cv = questionsSidebarGroups(c).find((g) => g.key === "topic:Cardiovascular Risk")!;
    expect(cv.children!.map((r) => r.searchText)).toEqual(["Statin or not?", "Is my ApoB actionable?"]);
    expect(cv.count).toBe(2);
  });
});
