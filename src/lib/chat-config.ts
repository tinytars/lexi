// W76 — the model /api/chat relays on, moved out of the route handler beside its six siblings
// (finding-, ranges-, extract-, marker-groups-, regroup-, treatment-infer-config.ts). It was the
// only model id in the app still inline at a call site, under a "keep the two in sync" comment
// pointing at scripts/inference-config.ts and a "W17 will promote this" note that outlived W17.
//
// Chat is the cheap tier on purpose: a follow-on Q&A surface over a Finding that has already been
// generated, not the Opus deliverable. It runs on ANTHROPIC_API_KEY, never the Finding pool's key,
// so no volume of questions can drain the credits a regen needs.
export const CHAT_MODEL = "claude-sonnet-4-6";

// W76 — the key chat's prompt+tool+model are stamped under (see brain-source.ts). It lives here for
// the same reason CORE_BRAIN lives in finding-config.ts: brain-source.ts imports this module, so a
// consumer that needs only the key does not have to reach through it.
export const CHAT_BRAIN = "chat";
