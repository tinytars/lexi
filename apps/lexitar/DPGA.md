# LexiTar against the DPG Standard

An assessment of LexiTar **as it is**, against the [Digital Public Goods Standard](https://github.com/DPGAlliance/DPG-Standard/blob/main/standard.md)
(v1.1.4) and the questions its [application form](https://github.com/DPGAlliance/DPG-Standard/blob/main/standard-questions.md)
asks for each indicator. Each indicator gets a verdict, the evidence behind it, and the gaps that stand
between it and "meets". The gaps are the input to a development plan. This doc is not a plan, a
tracker, or a history: when LexiTar changes, rewrite the affected verdict to describe the new state.

**Assessed against:** `dev` at `7d7b950`, and the live `tinytars.foundation/privacy` and `/terms` pages.
`main` — what production runs — is five commits behind it and sets `REPORTS: "never"`, so where dev and
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
| 7.2 | Evidence of adherence | ❌ | Published, and the at-rest claim is now true; neither document says whole documents go to a model provider |
| 7.3 | Processors disclosed | ❌ | Anthropic, Azure and Google are unnamed in the policy |
| 7.4 | Consent for special-category data | ❌ | No consent surface anywhere, and the corpus raised the stake from extracted values to whole documents |
| 7.5 | Deletion available to the user | ❌ | `POST /api/account/erase` works; no UI reaches it |
| **8** | **Standards and best practices** | **✅** | |
| 8.1 | Open standards, with evidence | ✅ | WebAuthn, Web Crypto, OAuth2/OIDC, WCAG 2.1 AA via axe in e2e |
| 8.2 | Best practices, with evidence | ✅ | CI on every PR, coverage thresholds, CodeQL, Dependabot, disclosure policy |
| **9A** | **Data privacy and security** | **🟡** | |
| 9A.1 | Is PII collected / stored / distributed | ⚪ | All three — and what a linked clinician now receives includes the original documents, through the model |
| 9A.2 | Which types | ✅ | Identity, lab results, symptoms, treatments, notes, photos, chat |
| 9A.3 | Vault confidentiality | ✅ | Client-side encryption, per-principal envelopes |
| 9A.4 | Access control and audit | ✅ | One capability table, per-namespace ownership, logged privileged reads |
| 9A.5 | Uploaded originals | 🟡 | Sealed under per-file content keys held inside the vault; the store is mid-migration and plaintext is still accepted |
| 9A.6 | Transfer to third-party models | 🟡 | Avoidable by config and by one env var; where it is on, whole originals leave when a record is opened, before any question |
| 9A.7 | Erasure integrity | 🟡 | Honest about the storage it controls; silent about the copies already sent to the model provider |
| **9B** | **Inappropriate, misleading, illegal content** | **❌** | |
| 9B.1 | Is content collected / stored / distributed | ⚪ | All three — uploads, notes, generated explanations |
| 9B.2 | Which types | ✅ | PDFs, photos, free text, AI-generated health explanations |
| 9B.3 | Identifying illegal content | ❌ | An acceptable-use clause, and nothing that acts on it. Sealing makes "the operator cannot read it" true, but it is unwritten |
| 9B.4 | Detect / moderate / report / remove | ❌ | No process, no channel, no owner |
| 9B.5 | Average response time | ❌ | Undefined, because there is no process to time |
| 9B.6 | Misleading content | 🟡 | Disclaimer, no-diagnosis prompts, staleness tracking, per-page citations, and a corpus that refuses rather than shrinks; no way to flag a wrong answer |
| **9C** | **Protection from harassment** | **🟡** | |
| 9C.1 | Does it enable interaction between users | ⚪ | Yes, narrowly — patient↔clinician sharing; no messaging or social surface |
| 9C.2 | How users protect themselves | 🟡 | Links are patient-approved, time-boxed, revocable and logged; no abuse-report path |
| 9C.3 | Safety of underage users | ❌ | 16+ in the Terms, unenforced at signup |
| **—** | **Scale** (form section, unscored) | **⚪** | Live at `literacy.tinytars.foundation`; **English only**, against an audience defined partly by limited English |

**Verdict: not ready to submit.** Indicators 7 and 9B fail outright, and both need work that isn't
writing: consent and deletion in the product, a content-reporting process behind it. Indicator 3's
ownership split and 9C's age gate are smaller but real. Everything else either passes or passes with a
note.

Sealing the uploaded originals and attaching them to every inference (`VAULT.md` §2a, `CORPUS.md`) moved
no indicator's light, and that is the finding. Inside 9A it traded one sub-question for another: 9A.5
rose off ❌ because the files are encrypted at rest, and 9A.7 fell off ✅ because erasure now has
something outside its reach to account for and does not. Indicator 7 fails for a new reason on top of
its old ones: the documents a patient uploads are sent whole to a model provider — on record open, not
on a question — and nothing the patient is shown says so.

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
- **`CORPUS.md` contradicts itself on the one fact this assessment leans on hardest.** §2 still calls
  the stored original "plaintext, deliberately outside the vault's encryption boundary" while §3
  describes the per-request key map that decrypts it; the sealing landed two days before that file was
  last touched. An assessor reading §2 alone concludes 9A.5 fails.
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
(`src/lib/Disclaimer.svelte`). They cover retention, deletion on request, a 16+ age limit, and the fact
that the Foundation is not a HIPAA covered entity.

**Gaps**
- **The policy is closer to the code than it was, and still contradicts it.** The at-rest half became
  true on 2026-09-24: uploaded originals are sealed under per-file content keys that exist only inside
  the patient's encrypted vault (`VAULT.md` §2a), so "we do not hold plain-text access to your health
  records" now holds at rest. Two claims still fail:
  - every vault carries an **org-recovery envelope by default** that the Foundation's key can open, so
    "we cannot recover the encrypted contents" is false unless the patient revoked it. This one is
    disclosed at signup on the lock screen and repeated on the public site — here the policy is what
    lags, not the product.
  - **whole documents, not extracted values, go to a model provider** when their owner asks a question
    about them (`CORPUS.md`), and read-aloud sends text to Azure. The policy mentions neither, and
    "readable only inside your own browser" reads as a denial of the first.

  The corpus also fixes the limit of the sealing, stated in the same terms in `../../SECURITY.md`,
  `VAULT.md` §2a and `CORPUS.md` §3: the deployment decrypts a document in memory while answering its
  owner's question about it. **That wording is narrower than the code.** `functions/api/corpus-warm.ts`
  sends the whole corpus at `max_tokens: 0` when a record is *selected*, and the browser refreshes it
  every 4.5 minutes for up to twelve idle cycles (`src/lib/corpus-warm.ts`), so opening a record — and
  then asking nothing — still transmits every original. The trigger is the owner's presence, not the
  owner's question, and all three documents should say so.
  `REPORTS: "never"` turns that path off entirely and is what `main` ships, while `dev` runs
  `"always"` — so an assessor reads one policy against two configurations, and the policy describes
  neither.
- **Processors aren't named.** The policy mentions only "infrastructure providers (such as our cloud
  host)". Anthropic, Microsoft Azure and Google receive or handle user data and aren't listed, nor are
  their retention terms.
- **No laws are identified.** The form asks for a list. Candidates LexiTar would have to show
  adherence to: GDPR (EU users; health data is special-category, needing explicit consent), the FTC
  Health Breach Notification Rule, CCPA/CPRA, Washington's My Health My Data Act, and ADA/WCAG for
  accessibility. None is cited, and there is no consent capture for processing health data.
- **Deletion is by request only.** `POST /api/account/erase` exists but no UI calls it (see 9A).

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

## 9A. Data privacy and security — 🟡

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
- Erasure (`functions/_lib/erasure.ts`) deletes everything attributable in the operator's own storage,
  and reports itself incomplete rather than claiming a clean erase.

**Gaps**
- **The store is only half-sealed.** New uploads are sealed, and two lanes seal what was already
  there — a browser heal on record open (`src/lib/raw-seal-heal.ts`), which is the only lane that
  reaches an account that revoked org recovery, and a store-wide operator sweep (`npm run raw:encrypt`).
  Until a sweep reports zero plaintext on both stores the read and write paths still accept a plaintext
  body, logging it so the remaining work is visible without listing the bucket
  (`functions/api/raw/[[path]].ts`); refusing plaintext is a later change. The sealing is also on `dev`
  only — production is five commits behind it, so the claim is true of the software and not yet of the
  deployment.
- **Whole documents go to third-party models**, not just the values extracted from them, wherever
  `REPORTS: "always"` is set — `dev` today, production not. There is still no disclosure or consent at
  the point of use, and no documented retention or zero-retention terms with Anthropic or Azure. Sealing
  defeats a leaked storage token, a snapshot and a backup copy, and it removes the operator's standing
  ability to read any patient's files; it does not hide a document from the running deployment while its
  owner is using the record.
- **The transfer is triggered by presence, not by a question, and it is designed to persist.**
  `corpus-warm.ts` sends every original before the patient types anything, so that the first answer is
  not paid for at the cursor, and the browser re-sends the same prefix every 4.5 minutes for up to
  twelve idle cycles — by construction, roughly 54 minutes of residency in a third party's prompt cache
  after the patient stops interacting. Both numbers are derived from the cache's economics
  (`src/lib/corpus-warm.ts`), which is a good reason for them and not a privacy analysis. Nothing weighs
  that residency against the patient's interest, and no document mentions it.
- **Erasure cannot reach what has already been sent, and does not say so.** `erasure.ts` is careful
  about storage it cannot prove is the account's, and silent about the copies at the model provider —
  which are now whole documents rather than extracted values, and which the warmer deliberately keeps
  resident. This is why 9A.7 is no longer a pass: the mechanism is sound, its stated scope is not the
  whole of what "erased" has to mean once originals leave the deployment.
- **No self-service deletion.** A user can't erase their own account from the UI.

## 9B. Inappropriate, misleading and illegal content — ❌

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

**Gaps**
- **No illegal-content process.** Nothing detects, reports or removes illegal uploads, and there's no
  documented response time. What changed is which answer is available: uploads are sealed under keys the
  operator does not hold (`VAULT.md` §2a), so server-side scanning is no longer possible and "we cannot
  read it" is now true rather than a claim the code refutes. That is the principled half of an answer the
  DPGA accepts. It is nowhere written down, and it does not supply the other half — a reporting channel,
  a named owner, and a removal path that works on a file nobody but its owner can open.
- **No way to flag a misleading answer.** A user or clinician who sees a wrong explanation has no
  in-app way to report it, and nothing routes such reports to a reviewer.

## 9C. Protection from harassment — 🟡

**The form asks:** whether LexiTar facilitates interaction with or between users; if so, how users
protect themselves, and how underage users are kept safe.

**Answer on the form:** **Yes, narrowly.** A patient can link clinicians, who then read their vault,
and support staff can be granted consent-gated access. There's no messaging, no public profile and no
social surface.

What's in place: provider links are patient-approved, time-boxed and revocable; support access expires
and re-keys on exit; privileged access is logged and shown to the patient. The contributor side has
`../../CODE_OF_CONDUCT.md`. The Terms and privacy policy set a minimum age of 16.

**Gaps**
- **The age limit isn't enforced.** Onboarding asks for a birth year but accepts any year up to the
  current one (`src/App.svelte`, the `birthYear` field), so a 10-year-old passes. "Not directed to children"
  rests on the Terms alone, and the form asks for *systems* protecting underage users.
- **No abuse-report path** for a patient who wants to report a clinician account, as opposed to revoking it.

---

## Scale of solution (form section, not an indicator)

Deployed at `literacy.tinytars.foundation`. **English only** — no i18n layer exists, although LexiTar's
stated audience includes adults with limited English. This will be asked under "designed to support
different languages", and it's the largest mismatch between LexiTar's positioning and the product.
