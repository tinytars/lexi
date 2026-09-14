// W55 P4 — the org-recovery principal id, shared by every route/module that mints or reads its
// envelope. Was a private const in vault/principals.ts; pulled out so signup, org-key, and
// recovery-envelope can all reference the same value.
export const ORG_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
