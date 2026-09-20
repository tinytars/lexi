# LexiTar against the DPG Standard

An assessment of LexiTar **as it is**, against the [Digital Public Goods Standard](https://github.com/DPGAlliance/DPG-Standard/blob/main/standard.md)
(v1.1.4) and the questions its [application form](https://github.com/DPGAlliance/DPG-Standard/blob/main/standard-questions.md)
asks for each indicator. Each indicator gets a verdict, the evidence behind it, and the gaps that stand
between it and "meets". The gaps are the input to a development plan. This doc is not a plan, a
tracker, or a history: when LexiTar changes, rewrite the affected verdict to describe the new state.

**Assessed against:** `dev` at `6e2d811`, and the live `tinytars.foundation/privacy` and `/terms` pages.
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
| 4.2 | Any closed dependency | ⚪ | Yes — hosting, models, speech, email, OAuth |
| 4.3 | Open alternative: hosting | ✅ | Node/Docker self-host, e2e-tested in CI on both hosts |
| 4.4 | Open alternative: inference | ✅ | Any OpenAI-compatible server, incl. local open weights, by config alone |
| 4.5 | Open alternative: read-aloud | ✅ | Browser `speechSynthesis` fallback |
| 4.6 | Open alternative: email | 🟡 | Gmail or nothing; no SMTP path, and silence drops a security notification |
| 4.7 | Open alternative: sign-in | ✅ | Passkeys and passwords; Google OAuth is optional |
| **5** | **Documentation** | **✅** | |
| 5.1 | Developer and architecture docs | ✅ | `../../ARCHITECTURE.md`, `API.md`, `AUTH.md`, `VAULT.md`, `INFERENCE.md` |
| 5.2 | Enough for a stranger to launch and run it | ✅ | `../../START-HERE.md` §B, clone to running in ten minutes |
| 5.3 | User guide | ❌ | Nothing tells a patient how to use the product |
| **6** | **Extracting data and content** | **✅** | |
| 6.1 | Is non-PII data or content handled | ⚪ | Yes — reasoning prompts, the finding DAG, reference material |
| 6.2 | Export/import in a non-proprietary format | ✅ | CSV and JSON export; PDF/XLSX import |
| **7** | **Privacy and applicable laws** | **❌** | |
| 7.1 | Which laws it complies with | ❌ | No law named anywhere; GDPR, FTC HBNR, CCPA, MHMDA all plausibly apply |
| 7.2 | Evidence of adherence | ❌ | Policy and Terms are published, but their encryption claims contradict the code |
| 7.3 | Processors disclosed | ❌ | Anthropic, Azure and Google are unnamed in the policy |
| 7.4 | Consent for special-category data | ❌ | None captured at signup or at the point a model call sends data out |
| 7.5 | Deletion available to the user | ❌ | `POST /api/account/erase` works; no UI reaches it |
| **8** | **Standards and best practices** | **✅** | |
| 8.1 | Open standards, with evidence | ✅ | WebAuthn, Web Crypto, OAuth2/OIDC, WCAG 2.1 AA via axe in e2e |
| 8.2 | Best practices, with evidence | ✅ | CI on every PR, coverage thresholds, CodeQL, Dependabot, disclosure policy |
| **9A** | **Data privacy and security** | **🟡** | |
| 9A.1 | Is PII collected / stored / distributed | ⚪ | All three — distributed to clinicians the patient links |
| 9A.2 | Which types | ✅ | Identity, lab results, symptoms, treatments, notes, photos, chat |
| 9A.3 | Vault confidentiality | ✅ | Client-side encryption, per-principal envelopes |
| 9A.4 | Access control and audit | ✅ | One capability table, per-namespace ownership, logged privileged reads |
| 9A.5 | Uploaded originals | ❌ | Stored unencrypted — the most sensitive files are the least protected |
| 9A.6 | Transfer to third-party models | 🟡 | Avoidable by config, but the live deployment sends plaintext health data out |
| 9A.7 | Erasure integrity | ✅ | Reports itself incomplete rather than claiming a clean erase |
| **9B** | **Inappropriate, misleading, illegal content** | **❌** | |
| 9B.1 | Is content collected / stored / distributed | ⚪ | All three — uploads, notes, generated explanations |
| 9B.2 | Which types | ✅ | PDFs, photos, free text, AI-generated health explanations |
| 9B.3 | Identifying illegal content | ❌ | An acceptable-use clause, and nothing that acts on it |
| 9B.4 | Detect / moderate / report / remove | ❌ | No process, no channel, no owner |
| 9B.5 | Average response time | ❌ | Undefined, because there is no process to time |
| 9B.6 | Misleading content | 🟡 | Disclaimer, no-diagnosis prompts and staleness tracking; no way to flag a wrong answer |
| **9C** | **Protection from harassment** | **🟡** | |
| 9C.1 | Does it enable interaction between users | ⚪ | Yes, narrowly — patient↔clinician sharing; no messaging or social surface |
| 9C.2 | How users protect themselves | 🟡 | Links are patient-approved, time-boxed, revocable and logged; no abuse-report path |
| 9C.3 | Safety of underage users | ❌ | 16+ in the Terms, unenforced at signup |
| **—** | **Scale** (form section, unscored) | **⚪** | Live at `literacy.tinytars.foundation`; **English only**, against an audience defined partly by limited English |

**Verdict: not ready to submit.** Indicators 7 and 9B fail outright, and both need work that isn't
writing: consent and deletion in the product, a content-reporting process behind it. Indicator 3's
ownership split and 9C's age gate are smaller but real. Everything else either passes or passes with a
note.

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
| **Anthropic API** (Claude Opus / Sonnet / Haiku) | Every AI feature, by default | ✅ Any OpenAI-compatible server, set per feature in `inference.config.json` — no code change. That includes open weights served locally by Ollama, vLLM or LM Studio (`INFERENCE.md`). Both web routes and the CLI resolve their client through `functions/_lib/inference/resolve.ts`; `tests/unit/openai-adapter.test.ts` exercises the adapter against a real Chat Completions server |
| **Azure AI Speech** (read-aloud) | `functions/api/speak.ts` | ✅ Falls back to the browser's own `speechSynthesis` on any failure |
| **Gmail API** (outbound email) | `functions/_lib/email.ts` | 🟡 No-ops without credentials, but that drops notification emails, which `step-up.ts` relies on as a security control. There's no SMTP path |
| **Google OAuth** (sign-in) | `functions/_lib/google.ts` | ✅ Optional; passkeys and passwords work without it |

An operator can therefore run LexiTar with no proprietary component in the request path: Node or Docker
for the host, a local open-weights model for inference, the browser voice for read-aloud, passkeys for
sign-in. `INFERENCE.md` also lists what needs no model at all — vault, sign-in, manual entry, markers
and charts, reference material, export.

**Gaps**
- **Document ingestion still needs a capable model.** An `openai` provider declares `caps`, and a
  request needing something it lacks is refused with `422 model_unsupported` rather than being sent.
  With a typical local model (no vision, no PDF), chat without photos, persona, pasted treatment text,
  ranges and marker groups work, while report and document extraction and the photo paths don't. So the
  open-model configuration is functional but not feature-complete, and the form answer should say so
  rather than claim parity.
- **Quality is unmeasured off Claude.** `INFERENCE.md` is candid that the prompts were written against
  Claude and that a smaller model may fail Finding validation more often. `scripts/brain-benchmark.ts`
  exists; no published run compares an open model against it.
- **Email needs an open transport** (SMTP) so a self-host doesn't lose security notifications.
- **Self-hosting is documented as a dev path, not an operator's.** `README.md` and the `Dockerfile`
  cover launch; env-var inventory, storage layout and backups for a production self-host aren't written
  down.

## 5. Documentation — ✅

**The form asks:** documentation that lets "a technical person unfamiliar with the project … launch and
run" it: developer docs, architecture, user guides.

Developer and architecture docs are strong: `../../START-HERE.md` (a ten-minute clone-to-running path),
`../../README.md`, `../../ARCHITECTURE.md`, `../../CONTRIBUTING.md`, `../../SECURITY.md`, `API.md`,
`AUTH.md`, `VAULT.md`, `INFERENCE.md`, `docs/BUILDING.md`.

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
(`src/lib/Disclaimer.svelte`). They cover retention, deletion on request, a 16+ age limit, and the fact
that the Foundation is not a HIPAA covered entity.

**Gaps**
- **The policy's central claims are false as the code stands.** It says data is "readable only inside
  your own browser", that "we do not hold plain-text access to your health records", and that a lost key
  means "we cannot recover the encrypted contents". In fact:
  - uploaded originals (PDFs, images) are stored **unencrypted** under `raw/` (`VAULT.md`, `functions/api/raw/`);
  - every vault carries an **org-recovery envelope by default** that the Foundation's key can open
    (`VAULT.md` §org recovery; the patient can revoke it);
  - AI features send health data in plain text through the server to whichever provider
    `inference.config.json` names — Anthropic in the live deployment — and read-aloud sends it to Azure.

  An assessor comparing the policy with `VAULT.md` finds the contradiction directly. The fix is either
  the code or the policy, but they have to agree.
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
- Every route serving patient files authorises per client namespace (`functions/_lib/raw-owner.ts`,
  `tests/unit/raw-authorization.test.ts`). Unowned namespaces are refused, and ownership never flips.
- Access policy lives in one table (`functions/_lib/capabilities.ts`). Privileged reads are logged to
  `phi_access_events`, and support access is consent-gated and time-boxed.
- Erasure (`functions/_lib/erasure.ts`) deletes everything attributable, and reports itself
  incomplete rather than claiming a clean erase.

**Gaps**
- **Uploaded originals are plaintext at rest.** The most sensitive files a user gives LexiTar are the
  ones not covered by its encryption. They should be encrypted client-side like the vault.
- **Health data goes to third-party models in plain text** with no user-facing disclosure or consent at
  the point of use, and no documented retention or zero-retention terms with Anthropic or Azure. An
  operator *can* now keep inference in-house (`inference.config.json` → a local model, Indicator 4), but
  the deployment users actually meet does not, and nothing in the UI says where their data goes.
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

**Gaps**
- **No illegal-content process.** Nothing detects, reports or removes illegal uploads, and there's no
  documented response time. LexiTar accepts image uploads and stores them in plain text, so "we can't see
  it" isn't available as an answer either. A written policy and a reporting channel are needed, plus
  either scanning or a reasoned position on why it doesn't apply.
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
