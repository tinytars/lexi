// W76 — the key chat's prompt+tool+model are stamped under (see brain-source.ts). It lives here for
// the same reason CORE_BRAIN lives in finding-config.ts: brain-source.ts imports this module, so a
// consumer that needs only the key does not have to reach through it.
export const CHAT_BRAIN = "chat";
