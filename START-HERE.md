# Start here

Two ways in. Pick the one that sounds like you.

- **[A · You're not a developer, and you're curious what this is](#a--youre-not-a-developer-and-youre-curious-what-this-is)**
  — two to three minutes, no code.
- **[B · You write code and want to see it run](#b--you-write-code-and-want-to-see-it-run)** —
  about ten minutes, you'll have it running locally.

Read [`README.md`](README.md) first if you haven't — it says what LexiTar is and isn't in full.
This file is the tutorial; [`ARCHITECTURE.md`](ARCHITECTURE.md) is the exact contract. Nothing is
explained three times: where this file would have to restate a mechanism, it links instead.

---

## A · You're not a developer, and you're curious what this is

### The situation this exists for

A patient gets a lab report back. It has forty rows of biomarkers, a reference range next to each
one, and no explanation of what any of it means for *them* — whether a slightly-elevated number is
worth a follow-up question or background noise, whether last year's trend line reversing course
changes anything. They have been handed data. They have not been handed understanding, and the gap
between the two is where most people's health literacy actually breaks down — not in whether the
numbers exist, but in whether anyone can read them.

LexiTar is built to close exactly that gap: it takes a patient's own labs, imaging, and clinical
history and translates them into longitudinal, reference-range context a person can actually act
on, then compiles that into a **Physician Consultation Blueprint™** — a structured document meant
to make an appointment more productive, not to replace one. It is education, not medicine: not a
diagnostic engine, not a medical-advice service, and not something built to be sold.

LexiTar is a **Health Literacy Utility**, developed as a **Digital Public Good** and maintained by
the **Tiny Tars Foundation**, a registered 501(c)(3) public charity, funded by community
philanthropy rather than by monetizing the data it holds.

### The principle underneath it

**Absolute data sovereignty.** A patient's biometric data belongs entirely to them, under a
permanent zero-monetization policy — no advertising, no medical remarketing, no selling, renting,
or trading personal or health data, ever. That isn't just a policy statement: every record is
encrypted on the patient's own device before it ever reaches storage, so the people running LexiTar
hold ciphertext, not plaintext, in the ordinary course of operating the app. The one narrow
exception — a disclosed, revocable, fully audited recovery path, never a hidden backdoor — is
described precisely, including what it does *not* allow, in
[`ARCHITECTURE.md`'s vault-boundary section](ARCHITECTURE.md#the-vault-boundary-precisely-stated).

**No "AI" branding, full disclosure of AI use.** The app itself doesn't put the word "AI" in its
own interface — a reference assessment or a translated term is framed as an educational lookup, not
a chatbot reply — because a translation utility and a "health AI product" read as very different
things to the people this serves. That's a display choice, not a concealment: the app's own About
panel plainly discloses that LexiTar reasons with a language model, and nothing it produces is
framed as a diagnosis or a treatment recommendation.

### What it is not

- **Not a diagnostic engine, and not medical advice.** It maps, translates, and compiles what's
  already in a patient's own records — it doesn't decide what's wrong with anyone.
- **Not a commercial product.** No ads, no data sale, no monetization of any kind — see
  [`README.md`](README.md#why) for the policy in full.
- **Not a place your data becomes someone else's asset.** The operator's ability to ever decrypt a
  patient's record is disclosed, narrow, and logged every time it's used — never silent, never
  unlimited. Precisely stated, not rounded up: [`ARCHITECTURE.md`](ARCHITECTURE.md#the-vault-boundary-precisely-stated).
- **Not "certified," and never described that way.** LexiTar doesn't claim HIPAA certification or
  any equivalent seal — see [`SECURITY.md`](SECURITY.md) for what it actually claims and how to
  report a concern.

### Six words, decoded

The rest of the documentation uses these freely.

| Word | In plain English |
|---|---|
| **Marker** | One measured value from a lab or scan — a single biomarker reading, with its date, unit, and reference range. |
| **Finding** | The AI-generated, plain-language reasoning layer over a patient's markers — what's notable, what's trending, what might be worth a question at the next visit. |
| **Blueprint** | Short for Physician Consultation Blueprint™ — the structured, patient-authored document a Finding feeds into, meant to be brought to an actual appointment. |
| **Translate** | Turning one specific value or term into plain language, on demand, inside a conversation — not a wholesale rewrite of a Finding. |
| **Vault** | The patient's own encrypted record — labs, imaging, history — decrypted only on their own device, never on LexiTar's servers. |
| **Stale** | A Finding whose reasoning was computed from data that has since changed — flagged for a fresh look, not treated as silently still correct. |

### If you want the version written for developers

[`README.md`](README.md) is the front page; its **Why** and **What it does** sections make the
same argument as this section with the full technical grounding attached.

---

## B · You write code and want to see it run

### Ten minutes, from clone to a running app

```console
$ npm install
$ cp apps/lexitar/.dev.vars.example apps/lexitar/.dev.vars
$ npm run dev:functions --workspace apps/lexitar
```

`dev:functions` builds the Svelte app and serves it through `wrangler pages dev`, so the Cloudflare
Pages Functions in `apps/lexitar/functions/` run exactly as they do in production — session
cookies, WebAuthn, the vault endpoints, all of it — against your own local D1/R2 state. Most of
`.dev.vars.example`'s secrets are for routes (chat, provider access) you don't need just to look
around; the app itself needs none of them to boot.

### See a real vault end-to-end without creating an account

`apps/lexitar` ships a fully synthetic, credential-free test identity for exactly this — no real
account, no real data, nothing to sign up for:

```console
$ npm run test:e2e --workspace apps/lexitar -- --project=synthetic
```

This is the same suite `.github/workflows/ci.yml`'s `lexitar` job runs on every push — it stands up
the app, provisions a synthetic patient with its own encrypted vault, and drives the UI through
Playwright against that real (if synthetic) encrypted record. If you want to see the fixture itself
rather than just watch it pass, `apps/lexitar/tests/fixtures/synthetic-patient.ts` and
`apps/lexitar/scripts/provision-e2e-patient.ts` are where it's built — the same crypto primitives
(`@tinytars/vault/crypto`) a real signup uses, just with a password that's public by design instead
of secret.

### Then read, in this order

| Read | Time | For |
|---|---|---|
| [`README.md`](README.md) | 5 min | what LexiTar is, why it exists, the shape of the app |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 10 min | the vault boundary stated precisely, the ingest pipeline, the Finding DAG's staleness model |
| [`apps/lexitar/README.md`](apps/lexitar/README.md) | 5 min | local dev, the ingest CLI, testing, deploy — this app's own operational detail |
| [`apps/lexitar/VAULT.md`](apps/lexitar/VAULT.md) | 15 min | the storage/encryption model in full |
| [`apps/lexitar/AUTH.md`](apps/lexitar/AUTH.md) | 10 min | accounts, credentials, the audit trail |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 5 min | where a PR belongs (`apps/lexitar` vs. `packages/frame`) and the rules either way |

### The one thing that is not obvious

The instinct on first reading `ARCHITECTURE.md`'s vault-boundary section is to round "the operator
can't read your data" up to an absolute. Don't — the doc is deliberately precise about why that
would be an overclaim: every account gets a disclosed, revocable, fully-audited org-recovery path,
not a mathematical impossibility of access. The claim that's actually true, and the only one this
codebase makes, is narrower and more checkable: *no undisclosed backdoor, every privileged read
logged.* If you're evaluating this app's security model, that's the sentence to hold it to — not
the stronger one it deliberately avoids.
