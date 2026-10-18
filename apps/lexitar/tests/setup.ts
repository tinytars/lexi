// Loads the operator's credential store into the environment, for tests/live/** — which talks to a
// real store and cannot be run without one. The UNIT suite needs nothing from here: its one
// credential-bound test was tests/unit/vault-v2.test.ts and it now mints a throwaway org key, which
// tests/unit/credential-free-imports.test.ts holds it to. load-creds lets an already-set variable
// win, so a test that sets its own is never overridden by whatever this machine happens to carry.
import "../scripts/load-creds";
