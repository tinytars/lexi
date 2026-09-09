---
name: Bug report
about: Something in @tinytars/frame isn't behaving as documented
title: ""
labels: bug
---

**Describe the bug**
A clear description of what's wrong, including which module is involved (a session/auth
controller, a screen, a menu primitive, or a generic panel — see `ARCHITECTURE.md` for the list).

**To reproduce**
Minimal steps or a code snippet that triggers it.

**Expected behavior**
What you expected to happen instead.

**Environment**
- @tinytars/frame version:
- Svelte version:
- Runtime (browser / SSR host) and version:

**Is this a security vulnerability?**
If this report involves a potential vulnerability in session/access handling, **do not** file it
here — see [SECURITY.md](../../SECURITY.md) for private disclosure instead. If it's actually about
key derivation, envelope framing, or access resolution, it likely belongs in
[`tinytars/vault`](https://github.com/tinytars/vault), not here.
