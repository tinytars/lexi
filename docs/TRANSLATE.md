# What blocks a leaf Translate

Vocabulary first, because the two get conflated and the conflation has already cost us a bug:

| Term | What it is | Who | Enforced where |
|---|---|---|---|
| **Translate** | LexiTar's reply to **one turn** — a note, a study entry, a treatment row. Ordinary app use, triggered by a save or the row's own Translate menu item. | anyone signed in | session only — `requireSession` in `functions/api/leaf-regen.ts`; `triggerLeafRegen` has **no** provider check, deliberately |
| **the sweep** | The unprompted background pass that fires a Translate for every stale leaf **on load**. Nobody asked for it. | provider | the `providerToken` in the `$effect` guard, `src/App.svelte` |
| **Translate all** / "regen" | The whole-Finding regeneration. Minutes long, streamed, the expensive one. | provider | `requireBearer(request, env.PROVIDER_TOKEN)` in `functions/api/refresh-finding.ts`, plus `doRefresh`'s own `providerToken` guard |

These three are **not interchangeable**, and each has been gated wrongly at least once:

- Gating **Translate** on provider access (W62's first cut) meant a patient could write a note and
  get silence back — no reply, no error. Reverted.
- Leaving **the sweep** ungated meant any signed-in patient's page load could fire six leaf
  Translates nobody asked for. Fixed in `e9a7e86`.
- **Translate all** has always been provider-gated and should stay that way; it is the one the
  business model may charge for.

When someone says "regen", they almost always mean **Translate all**. Ask before gating anything.


**A user turn always gets its reply.** That is a product rule, not an implementation detail
(owner, 2026-08-21). Anything that silences a turn's Translate is a bug, however reasonable the
mechanism looked in isolation.

## The load-bearing rule

**Staleness is a GATE on Translates, not just a badge.**

It is tempting to read `finding.nodeHashes` as display state — the ● chips, the "some sections out
of date" badge. It is not. `regenNode` refuses to run a leaf Translate while a **computed** ancestor
of that leaf is stale ([src/App.svelte:468](../src/App.svelte)):

```ts
if (!force && (!stale.has(key) || node.inputs.some((k) => stale.has(k) && dagNode(k)?.kind !== "input")))
  return { status: "skipped" };
```

So: **anything you add to a node's input closure that can mark a computed ancestor stale will
silence every leaf Translate downstream of it, until someone runs Translate all.**

This is not hypothetical. W62 tried folding "pinned areas of query" into every node's input closure
so that a pin would suggest a regeneration. Every computed ancestor went stale, and a single pin
would have silenced every subsequent turn reply. It was reverted for exactly this reason — and no
data migration could have saved it, since the *next* pin would re-break it. If you want something to
suggest a regeneration, make it an **advisory** (a prompt, a badge, a notice), never a staleness edge.

## Every condition that blocks one, in evaluation order

Checked in `triggerLeafRegen` → `regenNode` → `fetchLeafRegen`. `force: true` (the manual Translate
menu item) deliberately bypasses the two marked ⚑.

**Preconditions** — [src/App.svelte](../src/App.svelte), both callers
1. No `client.finding` — there is nothing to merge a result into.
2. No selected client id, vault, DEK, or vault R2 id.
3. **Sweep only:** no `providerToken`. The two deliberate callers (a save, the menu item) do *not*
   check this — that is what keeps a user turn answerable.

**The staleness gate** — `regenNode`, [src/App.svelte:468](../src/App.svelte)

4. ⚑ The node itself is **not** stale. Nothing changed, so there is nothing to re-ask.
5. ⚑ A **computed** (non-`input`) ancestor is stale. The rule above. `input`-kind ancestors are
   excluded on purpose: the raw datum you just edited is trivially stale at that moment, and waiting
   for it would mean the Translate never fires at all.

**Concurrency and dedupe** — [src/App.svelte:473-474](../src/App.svelte)

6. `leafRegenBusy[key]` — single-flight **per node key**, not per row. Every treatment row shares
   `treatmentAssessment`, so translating one row while another is in flight is skipped (with a reason
   string, so the click doesn't read as "nothing happened").
7. ⚑ `sig === leafRegenLastSig[key]` — the same inputs were already attempted. Note "attempted", not
   "succeeded": a failed attempt clears the sig so the next edit retries.

**Nothing to ask about** — [src/lib/leaf-regen-client.ts:52](../src/lib/leaf-regen-client.ts)

8. `spec.isEmpty(context)` — the node's own inputs are empty (no treatments, no hypotheses…).
   Returns `null`, surfacing as status `"empty"` rather than `"skipped"`.

**Coverage limits** — not refusals, but they mean a Translate never gets *attempted*

9. The sweep iterates only `LEAF_REGEN_NODES` ([src/App.svelte:447](../src/App.svelte)) — six of them.
   A leaf outside that list is only ever reached by a deliberate save or menu click.
10. `staleNodes` returns **empty** for a Finding carrying no `nodeHashes` (pre-W15b), so on such a
    vault nothing is ever stale and the sweep never fires. Callers fall back to the monolithic
    `isFindingStale`.

**Server** — [functions/api/leaf-regen.ts](../functions/api/leaf-regen.ts)

11. No session → 401. This route is session-gated and **deliberately not** behind `PROVIDER_TOKEN`;
    that secret guards Translate all. Briefly gating this route too is what made a patient's note
    come back silent.
12. Body over `MAX_BODY_BYTES` → 413; unknown `node` → 400.

## When you change any of this

- Adding an input to a node's closure? Ask what it marks stale, and whether that can silence a turn's
  reply. If it reaches a computed ancestor of a leaf, it can.
- Adding a gate for cost control? Decide which of the three things in the table above you are gating.
  They are not interchangeable, and "regen" in conversation usually means Translate all.
- Adding a new leaf? Decide whether it belongs in `LEAF_REGEN_NODES` (the sweep) or is
  deliberate-only.
- **Update this file.** It is the checklist for "why didn't my Translate fire?", and it is only worth
  having if it stays true.

## Open

- The sweep fires N Translates unprompted the moment a provider opens a patient with stale nodes.
  That is its own spending question, independent of anything above.
