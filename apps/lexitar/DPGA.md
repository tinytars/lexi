# LexiTar against the DPG Standard

An assessment of LexiTar **as it is**, against the [Digital Public Goods Standard](https://github.com/DPGAlliance/DPG-Standard/blob/main/standard.md)
(v1.1.4) and the questions its [application form](https://github.com/DPGAlliance/DPG-Standard/blob/main/standard-questions.md)
asks for each indicator. Each indicator gets a verdict, the evidence behind it, and the gaps that stand
between it and "meets". The gaps are the input to a development plan. This doc is not a plan, a
tracker, or a history: when LexiTar changes, rewrite the affected verdict to describe the new state.

**Assessed against:** `dev` at `c8c1ea6`, and the live `tinytars.foundation/privacy` and `/terms` pages.
`main` — what production runs — is seven commits behind it and sets `REPORTS: "never"`, so where dev and
production differ the verdict says which, rather than averaging them.
**Scope:** the software in this repo (`apps/lexitar`, `packages/frame`) plus the open packages it is
built from (`@tinytars/vault`, `@pablotech/akesi`, `@pablotech/neuro`). Users' health data is never
part of the DPG.
**Wording:** until an application is submitted, LexiTar is "developed as a Digital Public Good", never "certified".

**Verdicts:** ✅ meets · 🟡 partly meets (an assessor would ask for more) · ❌ does not meet

## Compliance dashboard

Every question the application form asks, and where LexiTar stands on it today.
**⚪** marks a question that describes the solution rather than scoring it — the answer still has to be
right, but there is nothing to fix.

| # | What the form asks | Light | Where LexiTar stands |
|---|---|---|---|
| **1** | **SDG relevance** | **✅** | |
| 1.1 | Which SDGs | ✅ | SDG 3 (health), SDG 10 (inequality) |
| 1.2 | Relation to each SDG's targets | 🟡 | True of the product, written nowhere public |
| **2** | **Open licensing** | **✅** | |
| 2.1 | Which approved open licence | ✅ | MIT, for the app and every first-party package |
| 2.2 | Public evidence of it | ✅ | `../../LICENSE` in a public repo |
| **3** | **Clear ownership** | **🟡** | |
| 3.1 | Who owns the solution | ✅ | Tiny Tars Foundation |
| 3.2 | Public evidence of ownership | ✅ | LICENSE, `../../README.md`, Terms §Intellectual property |
| 3.3 | Type of organisation | ✅ | 501(c)(3) non-profit |
| 3.4 | Country of the owner | ✅ | United States |
| 3.5 | Do you own all the code | ❌ | `@pablotech/akesi` and `@pablotech/neuro` — the reasoning core — are copyright an individual |
| 3.6 | If not, the right to redistribute | 🟡 | MIT covers it, but no CLA or DCO governs inbound contributions |
| **4** | **Platform independence** | **✅** | |
| 4.1 | Core technologies | ✅ | TypeScript, Svelte, Web Crypto, WebAuthn, SQLite-compatible storage, object storage |
| 4.2 | Any closed dependency | ⚪ | Yes — hosting, models, speech, email, OAuth. With reports attached, native PDF input too |
| 4.3 | Open alternative: hosting | ✅ | Node/Docker self-host, e2e-tested in CI on both hosts |
| 4.4 | Open alternative: inference | ✅ | Any OpenAI-compatible server by config alone; two alternative stacks ship as files, one with no vendor account at all, both measured |
| 4.5 | Open alternative: read-aloud | ✅ | Browser `speechSynthesis` fallback |
| 4.6 | Open alternative: email | 🟡 | Gmail or nothing; no SMTP path, and silence drops a security notification |
| 4.7 | Open alternative: sign-in | ✅ | Passkeys and passwords; Google OAuth is optional |
| **5** | **Documentation** | **✅** | |
| 5.1 | Developer and architecture docs | ✅ | `../../ARCHITECTURE.md`, `API.md`, `AUTH.md`, `VAULT.md`, `INFERENCE.md`, `CORPUS.md`, `MODELS.md`, `MEASUREMENT.md` |
| 5.2 | Enough for a stranger to launch and run it | ✅ | `../../START-HERE.md` §B, clone to running in ten minutes |
| 5.3 | User guide | ❌ | Nothing tells a patient how to use the product |
| **6** | **Extracting data and content** | **✅** | |
| 6.1 | Is non-PII data or content handled | ⚪ | Yes — reasoning prompts, the finding DAG, reference material |
| 6.2 | Export/import in a non-proprietary format | ✅ | CSV and JSON export; PDF/XLSX import |
| **7** | **Privacy and applicable laws** | **❌** | |
| 7.1 | Which laws it complies with | ❌ | No law named anywhere; GDPR, FTC HBNR, CCPA, MHMDA all plausibly apply |
| 7.2 | Evidence of adherence | ✅ | Policy and terms published and now true: what leaves this device, the recovery envelope, the enforced age limit, the reporting channel |
| 7.3 | Processors disclosed | ✅ | Named in the policy, each with what it receives and what its terms actually cover — including where nothing has been negotiated |
| 7.4 | Consent for special-category data | ❌ | No consent surface anywhere, and the corpus raised the stake from extracted values to whole documents |
| 7.5 | Deletion available to the user | ✅ | Two-step self-service erase in the account panel, reporting honestly what it could not attribute |
| **8** | **Standards and best practices** | **✅** | |
| 8.1 | Open standards, with evidence | ✅ | WebAuthn, Web Crypto, OAuth2/OIDC, WCAG 2.1 AA via axe in e2e |
| 8.2 | Best practices, with evidence | ✅ | CI on every PR, coverage thresholds, CodeQL, Dependabot, disclosure policy |
| **9A** | **Data privacy and security** | **✅** | |
| 9A.1 | Is PII collected / stored / distributed | ⚪ | All three — and what a linked clinician now receives includes the original documents, through the model |
| 9A.2 | Which types | ✅ | Identity, lab results, symptoms, treatments, notes, photos, chat |
| 9A.3 | Vault confidentiality | ✅ | Client-side encryption, per-principal envelopes |
| 9A.4 | Access control and audit | ✅ | One capability table, per-namespace ownership, logged privileged reads |
| 9A.5 | Uploaded originals | ✅ | Sealed under per-file content keys held inside the vault, and a plaintext `PUT` is now refused outright (`415 plaintext_refused`). Deployment note: the dev store sweeps to zero sealable objects; production runs the pre-refusal build until `main` is promoted, and its read-only sweep on 2026-09-27 counted 35 objects still to seal |
| 9A.6 | Transfer to third-party models | ✅ | Disclosed at the point of use, on demand and in the published policy: whole documents, on record open, about an hour of provider-side cache, no negotiated zero-retention arrangement |
| 9A.7 | Erasure integrity | ✅ | The report states what deletion cannot reach, and the half that is enforceable — revocation killing the corpus keepalive — is pinned by a test rather than assumed |
| **9B** | **Inappropriate, misleading, illegal content** | **✅** | |
| 9B.1 | Is content collected / stored / distributed | ⚪ | All three — uploads, notes, generated explanations |
| 9B.2 | Which types | ✅ | PDFs, photos, free text, AI-generated health explanations |
| 9B.3 | Identifying illegal content | ✅ | `MODERATION.md` §2–3: uploads are sealed under keys the operator does not hold, so identification is by report rather than by scanning, and the `illegal-content` reason carries a 1-business-day target |
| 9B.4 | Detect / moderate / report / remove | ✅ | Three in-app controls → `POST /api/report` → a labelled issue in a private tracker a named role answers, with both removal paths documented |
| 9B.5 | Average response time | ✅ | Acknowledge within 3 business days, resolve within 10, illegal material within 1 — one string shown as the user files, quoted in `MODERATION.md` and in the published policy, measurable off the issues' own timestamps |
| 9B.6 | Misleading content | ✅ | Disclaimer, no-diagnosis prompts, staleness tracking, per-page citations, a corpus that refuses rather than shrinks — and now a per-message Report control that reaches a person |
| **9C** | **Protection from harassment** | **✅** | |
| 9C.1 | Does it enable interaction between users | ⚪ | Yes, narrowly — patient↔clinician sharing; no messaging or social surface |
| 9C.2 | How users protect themselves | ✅ | Links are patient-approved, time-boxed, revocable and logged, and each one now carries a Report control — reporting is the thing revoking is not |
| 9C.3 | Safety of underage users | ✅ | 16+ refused in the browser at signup, on Skip and on later edit; `accounts.age_attested_at` records that the check passed, never a date of birth. Year-granular self-declaration, and the docs say so rather than implying verified age |
| **—** | **Scale** (form section, unscored) | **⚪** | Live at `literacy.tinytars.foundation`; **English only**, against an audience defined partly by limited English |

**Verdict: one indicator short of submittable.** Section 9 is green throughout — 9A, 9B and 9C — and
indicator 7 is now the only outright failure, on the two questions a document cannot answer: no law is
named anywhere, and there is no consent surface for special-category health data. Indicator 3's
ownership split (the reasoning core is copyright an individual, not the Foundation) and the missing
end-user guide are smaller but real. Everything else passes, or passes with a note.

Section 9 turned green on product work, not on wording. Between 2026-09-24 and 2026-09-27: uploaded
originals are sealed under per-file content keys inside the vault and an unsealed upload is refused
outright, so the store cannot acquire new readable objects; what leaves the device is disclosed in one
audited string at the point of use, on demand, and in a published policy rewritten to match it; deletion
became a two-step control in the product that reports what it could not attribute and what it cannot
recall; the 16+ limit became a refusal in the browser rather than a sentence in the Terms; and a report
about a wrong answer, illegal material or an abusive account now reaches a person, through a private
tracker, against stated times. The two honest qualifications are stated where they belong rather than
averaged away: production runs `main`, seven commits behind, so the refusal and the disclosure are true
of the software before they are true of the deployment; and documents uploaded before the sealing are
still being converted where they sit, which is why `MODERATION.md` is staged rather than unconditional.

---

## 1. Relevance to the SDGs — ✅

**The form asks:** which SDGs, and how LexiTar relates to each one's targets.

LexiTar explains a person's own lab results in plain language to adults with low health literacy or
limited English. That speaks to **SDG 3** (target 3.8, access to quality essential health care; 3.4,
non-communicable disease) and **SDG 10** (target 10.2, inclusion regardless of status).

**Gaps**
- No public doc (`../../README.md`, `../../START-HERE.md`) mentions the SDGs. The mapping has to be written
  out target by target for the form. It should also be stated somewhere public that a reviewer can link to.

## 2. Use of approved open licenses — ✅

**The form asks:** which OSI-approved license, with a link to it.

`../../LICENSE` is MIT, copyright Tiny Tars Foundation, in a public repo. `@tinytars/vault` is MIT.
`@pablotech/akesi` and `@pablotech/neuro` ship an MIT `LICENSE` file. Runtime dependencies are open too:
SimpleWebAuthn (MIT), pdf.js (Apache-2.0), SheetJS `xlsx` 0.18.5 (Apache-2.0).

**Gaps**
- None blocking. `@pablotech/akesi` and `@pablotech/neuro` omit the `license` field in `package.json`, so
  automated licence scanners report them as UNKNOWN even though the file is present.

## 3. Clear ownership — 🟡

**The form asks:** who owns it, public evidence of ownership, the owner's country, and whether the owner
owns all the code. If not, what gives it the right to redistribute (e.g. a Contributor License Agreement).

The Tiny Tars Foundation (a US 501(c)(3)) is named as owner in the LICENSE, in `../../README.md`, and in
the Terms' "Intellectual property" section ("name, logos, software, and brand … remain the property of
the Foundation").

**Gaps**
- **The Foundation doesn't own all the code.** The clinical reasoning core, `@pablotech/akesi` and
  `@pablotech/neuro` (repo `pablo-tech/pilos`), is copyright an individual. The form's "do you own all
  of the code" answer is therefore No. The MIT licence gives the Foundation the right to redistribute,
  but an assessor will see a core dependency outside the owner's control. The options are to transfer
  those packages to the Foundation or to state the arrangement publicly.
- **No contributor terms.** `../../CONTRIBUTING.md` sets no inbound licence (no CLA or DCO), so
  ownership of outside contributions is implied by MIT, not documented.
- **Commercial use of the code is unstated.** Nothing public says how any commercial offering relates to the open
  utility. A reviewer asking "who can profit from this" finds no answer.

## 4. Platform independence — ✅

**The form asks:** the core dependencies, whether any closed component creates a proprietary dependency,
and how each can be swapped for an open alternative "with minimal configuration changes".

**Core technologies:** TypeScript, Svelte 5, Vite, Web Crypto, WebAuthn, SQLite-compatible storage and
object storage.

| Closed component | What depends on it | Open alternative today |
|---|---|---|
| **Cloudflare Pages / D1 / R2** (hosting) | Everything, in the live deployment | ✅ The same `functions/` tree runs on Node (`node:sqlite` + filesystem blobs) via `npm run serve:node` or the `Dockerfile` (`server/`). CI runs e2e on both hosts, and `tests/unit/platform-imports.test.ts` blocks Cloudflare imports from routes and UI |
| **Anthropic API** (Claude Opus / Sonnet / Haiku) | Every AI feature, by default | ✅ Any OpenAI-compatible server, set per feature in `inference.config.json` — no code change. That includes open weights served locally by Ollama, vLLM or LM Studio (`INFERENCE.md`). Both web routes and the CLI resolve their client through `functions/_lib/inference/resolve.ts`; `tests/unit/openai-adapter.test.ts` exercises the adapter against a real Chat Completions server. Two whole alternative stacks ship as copyable files (`inference.examples/mixed.json`, `open-local.json` — the second needs no vendor account at all), described in `MODELS.md` and measured in `MEASUREMENT.md` |
| **Azure AI Speech** (read-aloud) | `functions/api/speak.ts` | ✅ Falls back to the browser's own `speechSynthesis` on any failure |
| **Gmail API** (outbound email) | `functions/_lib/email.ts` | 🟡 No-ops without credentials, but that drops notification emails, which `step-up.ts` relies on as a security control. There's no SMTP path |
| **Google OAuth** (sign-in) | `functions/_lib/google.ts` | ✅ Optional; passkeys and passwords work without it |

An operator can therefore run LexiTar with no proprietary component in the request path: Node or Docker
for the host, a local open-weights model for inference, the browser voice for read-aloud, passkeys for
sign-in. `INFERENCE.md` also lists what needs no model at all — vault, sign-in, manual entry, markers
and charts, reference material, export.

**Source documents stayed portable.** Every inference about a person is now made in sight of that
person's own PDFs, attached server-side by the route as ordinary `document` blocks (`CORPUS.md`) — not
through a vendor file-upload or context API, which is what keeps the mechanism expressible on an
OpenAI-compatible endpoint (`tests/unit/corpus-portability.test.ts`). The cheaper vendor-only shape was
available and was rejected for that reason: one shared cache entry needs mid-conversation `system`
messages and `tool_addition` blocks, which `openai.ts` cannot express, so the app pays a cache write per
attached feature instead. `REPORTS` in `wrangler.jsonc` turns the whole mechanism off per environment —
unset means off, and any other value throws rather than defaulting.

**Gaps**
- **Attaching reports narrows the open stacks.** A provider declares `caps`, and a request needing
  something it lacks is refused with `422 model_unsupported` rather than sent — refuse, never degrade.
  Since every feature that answers about a person now carries that person's PDFs, an attached
  environment needs native PDF input on all five of them (`chat`, `finding`, `ranges`, `markerGroups`,
  `leafRegen`), which no open candidate offers. Both shipped alternative stacks therefore say in their
  own `$doc` that they require `REPORTS: "never"`. That is a real configuration, tested and documented,
  but a deployer choosing open weights gives up the corpus, and the form answer should say that rather
  than claim parity.
- **Quality off the vendor is measured, and one half of it failed.** `MEASUREMENT.md` carries the runs
  and `MODELS.md` the verdict: a 4B open model held the shipped contract on `ranges` — the
  highest-volume call, with a ten-check validator — on every case at first attempt. The document
  features did not survive the 4 GiB card they were measured on: the accurate vision model would not
  load, and the one that fit passed the validator on an extraction while reporting a patient name that
  is not on the page. A larger GPU was not tested and `MODELS.md` declines to guess, so the honest
  claim is "measured on the structured features, unproven on the document features".
- **Email needs an open transport** (SMTP) so a self-host doesn't lose security notifications.
- **Self-hosting is documented as a dev path, not an operator's.** `README.md` and the `Dockerfile`
  cover launch; env-var inventory, storage layout and backups for a production self-host aren't written
  down.

## 5. Documentation — ✅

**The form asks:** documentation that lets "a technical person unfamiliar with the project … launch and
run" it: developer docs, architecture, user guides.

Developer and architecture docs are strong: `../../START-HERE.md` (a ten-minute clone-to-running path),
`../../README.md`, `../../ARCHITECTURE.md`, `../../CONTRIBUTING.md`, `../../SECURITY.md`, `API.md`,
`AUTH.md`, `VAULT.md`, `INGEST.md`, `INFERENCE.md`, `CORPUS.md`, `MODELS.md`, `MEASUREMENT.md`,
`docs/BUILDING.md`. The last three are unusually strong evidence for this indicator: they state what was
measured, on what hardware, and which claims are not proven.

**Gaps**
- **No end-user guide.** Nothing explains, for a patient, how to import a report, read a translation,
  or share with a clinician. `START-HERE.md` §A explains what LexiTar is, not how to use it.
- The self-hosting guide from Indicator 4.

## 6. Mechanism for extracting data and content — ✅

**The form asks:** whether LexiTar handles non-PII data or content, and how it's exported or imported in
a non-proprietary format.

A user's own record exports as CSV and structured JSON (`src/lib/export.ts`: `exportCsv`, `exportJson`),
through `@tinytars/frame`'s `ExportTab.svelte`. Lab data imports from PDF and XLSX. LexiTar's
non-PII content (its reasoning prompts and the finding DAG) is plain source in public repos.

**Gaps** — none.

## 7. Adherence to privacy and applicable laws — ❌

**The form asks:** the list of laws LexiTar complies with, and links (privacy policy, terms) that
demonstrate it.

A privacy policy (`tinytars.foundation/privacy`) and terms (`/terms`) are published and linked in-app
(`src/lib/Disclaimer.svelte`), and both were rewritten on 2026-09-27 to describe the product that
ships: what leaves the browser and to whom, the Foundation-openable recovery envelope that is there
until the patient removes it, each processor by name with what its terms actually cover — including
where nothing has been negotiated — the enforced age limit, self-service deletion and the reach it
does not have, and a reporting channel with stated response times. The indicator still fails, on the
two questions that rewrite does not answer.

**Gaps**
- **No laws are identified (7.1).** The form asks for a list. The candidates LexiTar would have to show
  adherence to: GDPR (EU users; health data is special-category), the FTC Health Breach Notification
  Rule, CCPA/CPRA, Washington's My Health My Data Act, and ADA/WCAG for accessibility. None is cited
  anywhere, in the policy or in this repo.
- **No consent capture for special-category data (7.4).** GDPR Article 9 wants explicit consent for
  processing health data, and there is no consent surface — disclosure at the point of use is not
  consent, and the `REPORTS` switch is the operator's, not the patient's. The corpus raised what such
  consent would have to cover from extracted marker values to whole documents.

Neither is in this milestone's scope, and neither has been narrowed by it: what changed is that the
published claims are now true, not that a law has been named.

## 8. Adherence to standards and best practices — ✅

**The form asks:** open standards and best practices followed, with evidence such as validators or test suites.

- **Open standards:** WebAuthn/FIDO2 passkeys; W3C Web Crypto (AES-GCM-256, PBKDF2-SHA256, ECDH-ES
  P-256, HMAC-SHA256); OAuth 2.0 / OpenID Connect (Google sign-in); WCAG 2.1 AA, asserted by axe in
  `tests/e2e/a11y.spec.ts`; CSV and JSON for export.
- **Best practices:** CI on every PR (`.github/workflows/ci.yml`) with ~270 unit and ~70 e2e files
  and enforced coverage (`coverage-thresholds.json`); CodeQL; Dependabot for npm and Actions; private
  vulnerability reporting (`../../SECURITY.md`); a code of conduct.

**Gaps** — none blocking. Health-data interoperability (FHIR, LOINC codes for markers) isn't used. That
isn't required, but an assessor in the health domain may look for it.

## 9A. Data privacy and security — ✅

**The form asks:** whether PII is collected, stored and distributed; what types; and how privacy,
security and integrity are ensured.

**Answer on the form:** PII is **collected, stored and distributed** (to clinicians a patient links).
Types: email, name, password hash, passkeys, lab reports and marker values, symptoms, treatments, notes,
family history, photos, chat history.

What's in place:
- The vault is client-side encrypted (`@tinytars/vault`), with per-principal envelopes for owner, org
  recovery and provider links.
- Uploaded originals are sealed the same way (`VAULT.md` §2a): each carries its own AES-GCM-256 content
  key, minted in the browser and held in `Vault.rawKeys` *inside* the vault blob, so who can decrypt a
  file, how access is revoked and how a rotation works stay the vault's answers rather than three new
  mechanisms. A document and its transcription sidecar share one key, and the key is written to the
  vault before the ciphertext is uploaded, so a crash cannot orphan a file.
- **A plaintext upload is now refused rather than logged.** `PUT /api/raw/…` answers an unsealed body
  with `415 plaintext_refused` (`functions/api/raw/[[path]].ts:188-189`), unconditionally — including on
  a namespace's first upload, which is the case a narrower rule would have broken — so the store cannot
  acquire new readable objects. `GET` is untouched; it streams what is stored and never decrypts.
- The deployment therefore holds no standing key for those files: the browser of the person using the
  record hands the route a key map per request, and authorisation runs inside the assembler that opens
  them (`openReportCorpus` calls `rawAccessFor` before it lists anything —
  `functions/_lib/inference/corpus.ts:145`), so a route cannot be written that forgets the check. An
  unauthorised client is a 404, never a 403, because a 403 would confirm the namespace exists, and a
  refusal that names files sends the count only (`CorpusKeyError`, `CorpusUnmeasuredError`).
- Every route serving patient files authorises per client namespace (`functions/_lib/raw-owner.ts`,
  `tests/unit/raw-authorization.test.ts`). Unowned namespaces are refused, and ownership never flips.
- Access policy lives in one table (`functions/_lib/capabilities.ts`). Privileged reads are logged to
  `phi_access_events`, and support access is consent-gated and time-boxed.
- **What leaves the device is disclosed where the work happens**, in one audited string reused
  everywhere (`MODEL_DISCLOSURE`, `src/lib/brand.ts`): whole reports rather than summaries, sent when a
  record is opened and not only when a question is asked, resident in the provider's prompt cache for
  about an hour of idleness on the provider's own expiry schedule, on standard commercial terms with no
  negotiated zero-retention arrangement. It names no vendor — the model provider is a deployment choice
  (`providerFor` in `src/lib/model-config.ts`), so a vendor name in audited copy would be false wherever
  an operator picked another — and points at the published policy, which names the companies in use
  today and is reissued when any of them changes. A unit test pins both halves
  (`tests/unit/brand.test.ts`).
- **Deletion is self-service and states its own reach.** A two-step armed control in the Account panel
  echoes the account's own email to `POST /api/account/erase` (`src/App.svelte:1720`,
  `src/lib/erase-account.ts`), and the result is rendered from the route's own report rather than a
  claim: storage it could not attribute is reported as a count, and `ERASURE_REACH` says in the same
  words as `../../SECURITY.md` and `MODERATION.md` what deletion cannot recall — the copies already
  written at the model and speech providers, which expire on their schedules.
- **The half of erasure that is enforceable is pinned by a test, not asserted.** `erasure.ts` revokes
  sessions before it writes the tombstone, so an erased account's browser cannot send anything further;
  `tests/unit/erasure-function.test.ts` holds a `corpus-warm` refresh on a pre-erasure cookie to a 401,
  which is the property that stops the keepalive re-warming a deleted record.

**Gaps** — none against the software in this repo.

**One deployment note, which is not a gap in the software.** Production runs `main`, seven commits
behind `dev`, so until that promotion it serves the pre-refusal build and sets `REPORTS: "never"` (no
document leaves at all under that setting). A preview sweep on the dev store reports zero *sealable*
plaintext. The production store's own preview sweep was run read-only on 2026-09-27 and is the honest
number here: **35 objects would be sealed, none are sealed yet, 6 are missing, and no namespace is
orphaned or unreachable.** Those 35 are readable where they sit until the sealing run is executed
against production, which writes and is therefore the operator's; what the refusal already guarantees
is that the count cannot grow once production runs this build. The residual classes the sweep
deliberately leaves — orphaned namespaces, which `POST /api/raw/claim` must still be able to
claim, and unreachable ones, which only their owner's browser can seal via `src/lib/raw-seal-heal.ts`
— are drained by claim and by use rather than by an operator. Those objects are readable where they
sit; none of them can be added to.

## 9B. Inappropriate, misleading and illegal content — ✅

**The form asks:** whether content is collected, stored or distributed; what types; how inappropriate,
misleading or illegal content (explicitly including CSAM) is identified; and the processes to detect,
moderate, report and remove it, with an average response time.

**Answer on the form:** content is **collected, stored and distributed**. That covers uploaded PDFs and
photos, free-text notes, and AI-generated explanations, shared with linked clinicians.

What's in place:
- The Terms' acceptable-use clause forbids "unlawful content".
- For *misleading* content: the audited `MEDICAL_DISCLAIMER` (`src/lib/brand.ts`) is shown in-app;
  prompts carry education-not-medicine rules ("do not diagnose"); and the finding DAG marks derived
  content stale when its inputs change (`../../ARCHITECTURE.md`).
- Also for misleading content, and newer: an answer about a person is generated in sight of that
  person's own documents rather than only the structured extraction taken from them at import
  (`CORPUS.md`). The failure that addresses is specific — a model reading an extraction cannot tell what
  the extraction dropped, so it answers confidently from a partial record — and the claim is tested
  against a real model, on three questions whose answers exist only inside a document's own pages
  (`tests/live/corpus-answers-the-document.test.ts`, opt-in, never in CI because it spends money).
- Two properties of that mechanism are the strongest misleading-content evidence LexiTar has, and both
  are enforced in code rather than asserted in a prompt. Every attached feature that is not returning a
  JSON schema sets `citations: { enabled: true }` (`functions/_lib/inference/attach.ts:66` — the two
  are mutually exclusive in the API), so an answer carries `page_location` cites a reader can check
  against the page. And a corpus that cannot be assembled whole **throws** — an unmeasured
  page count, a missing object, an unopenable key, a ceiling — instead of quietly attaching fewer
  documents, because a partial corpus produces an answer that reads exactly like a complete one
  (`functions/_lib/inference/corpus.ts:14-16`). Refusal is the safe failure and the code picks it every
  time.
- **`MODERATION.md` is the document this indicator asks for**, and it answers all four of its parts:
  what can and cannot be identified, and why scanning a patient's uploads is a design property rather
  than a shortfall; the channel; the removal path; and the response times. It is deliberately staged
  where the truth is staged — new uploads cannot be readable, and documents uploaded before
  2026-09-24 are being converted in place — so it does not overclaim on the day it is written.
- **The channel is in the product, in three places**, all on seams that already existed: a per-message
  control in the chat row that already carries "copy link to this message", a `danger` item in the leaf
  action registry (`src/lib/leaf-actions.ts:119`), and a "report this account" control beside the
  existing revoke button in provider access. Each opens the same form over the same three reasons —
  a misleading answer, illegal content, an abusive account.
- **A report reaches a person, and carries no health content.** `functions/api/report.ts` is
  session-gated, rate-budgeted with the same per-IP HMAC bucket as crash reports, and scrubbed with the
  same scrubbers; it files a GitHub issue into a *private* tracker
  (`promontory-studio/plover-factory`) labelled `safety-report` plus `kind:<reason>`
  (`functions/api/report.ts:132`). The label matters twice: the autopilot fixer there only acts on
  `client-error`, so a safety report is never auto-patched, and a triage query sorts on the kind. The
  body carries an account id, the reason, a scrubbed note and — for a flagged answer — the feature and
  message id, so a reviewer can ask the user rather than read their record. A repeat report comments on
  the open issue instead of filing a duplicate. `tests/unit/report-function.test.ts` pins the labels,
  the budget refusal and the scrubbing.
- **A named owner and a measurable response time.** `MODERATION.md` and the published policy both name
  the Tiny Tars Foundation as accountable and its **safety contact** — a standing role, not an
  individual whose departure would make the copy stale — as who answers, with acknowledgement in 3
  business days, resolution in 10, and illegal material looked at within 1. Because reports are issues,
  those targets are measurable after the fact from the issues' own `created_at` and `closed_at`, which
  is the reason the GitHub sink is worth more here than an inbox.
- **Removal works on a file nobody but its owner can open**, and `MODERATION.md` says which of the two
  paths applies to which report: the owner deletes through `DELETE /api/raw/{id}/{file}`, which is
  session-gated and needs a real ownership claim; the operator removes the ciphertext out of band
  through the `ops.yml` lane, which is possible precisely because deleting never requires reading.

**Gaps** — none. The response-time figures are targets rather than measured averages until the tracker
has reports to measure; an assessor may ask for the observed number at that point.

## 9C. Protection from harassment — ✅

**The form asks:** whether LexiTar facilitates interaction with or between users; if so, how users
protect themselves, and how underage users are kept safe.

**Answer on the form:** **Yes, narrowly.** A patient can link clinicians, who then read their vault,
and support staff can be granted consent-gated access. There's no messaging, no public profile and no
social surface.

What's in place: provider links are patient-approved, time-boxed and revocable; support access expires
and re-keys on exit; privileged access is logged and shown to the patient. The contributor side has
`../../CODE_OF_CONDUCT.md`.

- **The 16+ limit is enforced, and where it cannot be verified it says so.** `src/lib/age-limit.ts`
  holds the threshold and the refusals over the one age computation the app already has; onboarding
  refuses an underage birth year *and* refuses to skip the field, which is the hole an assessor probes
  first, and the same refusal guards later edits in `Personalization.svelte`. The check runs in the
  browser because a date of birth never reaches the server by design, and sending one there to check an
  age would cost more privacy than the check buys; the server records only that the gate was passed and
  when (`accounts.age_attested_at`, `migrations/0016_age_attestation.sql`). The limit is therefore
  year-granular and self-declared, and the policy, the terms and `MODERATION.md` all say that rather
  than implying a verified age.
- **A patient can report a clinician account, not only revoke it** — the third of Phase 3's entry
  points, beside the revoke button where the question arises.

**Gaps** — none scored. The form's language question is answered under Scale below, where English-only
remains the real mismatch.

---

## Scale of solution (form section, not an indicator)

Deployed at `literacy.tinytars.foundation`. **English only** — no i18n layer exists, although LexiTar's
stated audience includes adults with limited English. This will be asked under "designed to support
different languages", and it's the largest mismatch between LexiTar's positioning and the product.
