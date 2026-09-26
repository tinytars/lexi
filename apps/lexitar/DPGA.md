# DPGA.md — Digital Public Goods Alliance: what it is & how LexiTar gets certified

**Created:** 2026-07-11 · **Last verified against code:** 2026-09-24 (Indicators 7 and 9A; the rest 2026-09-19) · **Folder:** `apps/lexitar/`
**Why this doc:** LexiTar's positioning and its funding strategy — both kept with the Foundation's records, not in this repo — hinge on LexiTar being **developed as a Digital Public Good (DPG)** and the Tiny Tars Foundation **pursuing DPGA registration**. This doc explains what that means and the concrete path to it.

> **Claim discipline:** say LexiTar is **"developed as a Digital Public Good."** Do **not** say "certified," "DPG-certified," or "certified-ready" until the Foundation has actually submitted a DPGA application. Once submitted, LexiTar is a **"nominee"**; only after full review is it a **recognized DPG**.

---

## 0. TL;DR

- **DPGA = Digital Public Goods Alliance** — a UNICEF/Norad-rooted, multilateral body (members incl. UNICEF, UNESCO, GitHub, national governments) that **certifies** open-source software/data/AI/content as **Digital Public Goods** against the **DPG Standard (9 indicators)** and lists them in a public **Registry**.
- **It doesn't (mostly) fund** — it certifies and connects. Registration is a **free credibility badge** that de-risks every philanthropic ask and can open DPGA-facilitated funders (e.g. Co-Develop).
- **Process:** free 5-min eligibility test → apply at `app.digitalpublicgoods.net/signup` → two-stage technical review (~30 days) → recognized DPG on the Registry → **annual renewal.**
- **The former hard gate is closed:** `tinytars/lexi` has been public under the MIT license (`../../LICENSE`, copyright Tiny Tars Foundation) since 2026-09-13, satisfying Indicator 2. What remains is mostly writing — privacy-policy coverage, ownership, the model-dependency story — plus one piece of code: a user-facing way to trigger the erasure the API already implements.

---

## 1. What the DPGA / a DPG is

A **Digital Public Good** is open-source software, open data, an open AI system, or open content that (a) is **relevant to the UN Sustainable Development Goals (SDGs)**, (b) uses **approved open licenses**, and (c) is designed to **do no harm** — and does all of it in a way that's platform-independent, documented, and privacy-respecting. The **DPGA** maintains the **DPG Standard**, reviews nominees against it, and publishes recognized DPGs in the **DPG Registry** (a discovery surface funders, governments, and multilaterals actually shop from).

**Scoping note for LexiTar:** the DPG is the **LexiTar public software** (this repo — `apps/lexitar` and `packages/frame`, plus the `@tinytars/vault` primitives it builds on) — **not** any user's data. Individual users' health data is never the DPG and stays private and out of scope: the vault is encrypted in the browser under a key the operator never holds, and since 2026-09-24 every uploaded original is sealed the same way, under a per-file content key that exists only inside that vault (`../../SECURITY.md`, `VAULT.md` §2a). One limit is stated rather than glossed, here and in both of those documents: answering a question about a patient's own documents means the deployment decrypting them in memory to send to the model provider that answers it (§3, Indicator 7).

---

## 2. Why LexiTar pursues DPG status

1. **Funding credibility:** a recognized-DPG badge signals genuine non-commercial public good — it strengthens *every* foundation/AI-for-good application and opens DPGA-facilitated funders.
2. **Brand positioning:** "developed as a Digital Public Good" is the canonical positioning, satisfying the Google Ad Grant non-commercial requirement while signaling privacy-by-design / data-minimization / purpose-limitation.
3. **Private-benefit defense:** DPG open-licensing is also the operational answer to foundation lawyers' private-benefit concern — the charity's core asset is open and community-owned, not a founder's proprietary product.

---

## 3. The DPG Standard — 9 indicators & LexiTar's readiness

| # | Indicator | LexiTar status | Gap / action |
|---|---|---|---|
| 1 | **SDG Relevance** | ✅ Strong — SDG 3 (Health & Well-being) + SDG 10 (Reduced Inequalities); health literacy for low-literacy/LEP adults | Document the SDG mapping in the application |
| 2 | **Open Licensing** | ✅ **Closed 2026-09-13** — repo public under MIT (`../../LICENSE`); `@tinytars/vault` and `@tinytars/frame` are open too | None. Cite the LICENSE and the public repo |
| 3 | **Clear Ownership** | 🟡 LICENSE copyright and `../../README.md` both name the Tiny Tars Foundation; `../../CODEOWNERS` exists. What's still unwritten is the arrangement with the for-profit side (enterprise integrations sold separately; the utility stays open) | Write a short public ownership statement (Foundation owns the open utility; any commercial integration is separate and licensed from it) |
| 4 | **Platform Independence** | ✅ **Closed 2026-09-19.** **Hosting:** the same `functions/` tree runs on Cloudflare Pages (D1 + R2) or a Node self-host (`node:sqlite` + filesystem blobs, `npm run serve:node` or the `Dockerfile`); CI runs the full e2e suite on both hosts and boots the image, and `tests/unit/platform-imports.test.ts` fails if a route or the UI imports a Cloudflare module (`../../ARCHITECTURE.md` §Cloudflare is one host). **Model:** every inference is configured in one file, `inference.config.json`, which names a provider, model and key env var per feature. Anthropic is the default; any OpenAI-compatible endpoint works too, including OpenAI and a local open model through Ollama, vLLM or LM Studio (`INFERENCE.md`). Capability is declared per provider and enforced per feature, so a model that cannot read a PDF refuses that one feature with a 422 instead of degrading it silently, and the fix is routing that feature to a capable model. **Source documents:** every inference about a person is made in sight of that person's own PDFs (`CORPUS.md`), assembled from the app's own storage and attached as ordinary `document` blocks that the OpenAI adapter translates, never through a vendor-only file or context API — and `REPORTS: "never"` turns the whole mechanism off per environment, so a fully text-only stack stays a real, tested configuration rather than a dead column. Quality off the default vendor is **measured, not assumed** (`MEASUREMENT.md`), and the stacks those numbers produced ship as copyable configs in `inference.examples/`, described in `MODELS.md`. Features that need no model (vault, sign-in, manual entry, markers and charts, export) are listed there with the ones that do. The remaining single-vendor piece is optional: read-aloud uses Azure Speech and falls back to the browser voice | Cite `INFERENCE.md`, `CORPUS.md`, `MEASUREMENT.md`, `MODELS.md`, and `tests/unit/{openai-adapter,corpus-portability,inference-examples}.test.ts` |
| 5 | **Documentation** | ✅ **Largely satisfied** — public `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md` at the root; `API.md`, `AUTH.md`, `VAULT.md`, `docs/BUILDING.md` in this app | None blocking. Point the application at these |
| 6 | **Non-PII Data Extraction** (export in a non-proprietary format) | ✅ `src/lib/export.ts` ships CSV (`exportCsv`) and structured JSON (`exportJson`), surfaced through `@tinytars/frame`'s `ExportTab.svelte`. The indicator asks for *a* non-proprietary format, not FHIR | Cite the export as evidence. FHIR stays a nice-to-have |
| 7 | **Privacy & Applicable Laws** | 🟡 **Re-assessed 2026-09-24 against the report corpus**, which did not exist at the 2026-09-19 verification. What the corpus does: every AI answer about a person is generated in sight of that person's own uploaded documents, attached server-side by the route (`CORPUS.md`). **Whole documents, not extracted values, are sent to the configured model provider** — Anthropic by default, or whatever `inference.config.json` names, including a local open model, which is the deployer's lever. That is a real data-minimization gap and it is **not closed**; naming it is worth more than a claim that it is handled. What *is* closed as of 2026-09-24: those documents are no longer readable at rest by anyone holding the bucket (Indicator 9A), and the deployment holds no standing key for them — it is handed the keys, per request, by the browser of the person asking. **`REPORTS: "never"` turns the whole mechanism off per environment**, and production ships with it off. Still missing on the consent axis: the app has no consent surface at all, and the published policy does not cover consent, minimization or governance. Six mandatory sub-requirements. **Published privacy policy: done** — `https://tinytars.foundation/privacy`, linked from the in-app disclaimer (`src/lib/Disclaimer.svelte`, `LEGAL_BASE` in `src/lib/brand.ts`). It covers retention and deletion-on-request, but says nothing about consent, data minimization, or governance/access control. **Deletion: API only** — `POST /api/account/erase` works (self-only, email-echo confirmation, `functions/_lib/erasure.ts`), but no UI calls it, so a user can't erase their account themselves | (a) Add a self-service "Delete account" action that calls `/api/account/erase`. (b) Extend the privacy policy to cover consent, minimization and governance, **and to say plainly that whole documents are sent to the model provider when the user asks a question about them**. (c) Access control is already readable in one place (`functions/_lib/capabilities.ts`) — cite it. (d) Add an in-app consent step before the first attached inference |
| 8 | **Open Standards & Best Practices** | ✅ WebAuthn/FIDO2 passkeys, AES-GCM-256, PBKDF2-SHA256, ECDH-ES over P-256, HMAC-SHA256 — all via WebCrypto (`@tinytars/vault`'s `ARCHITECTURE.md`) | Cite these |
| 9A | **Do No Harm — Data Privacy & Security** | 🟡 → **nearly ✅; nothing left to disclose.** **Re-assessed 2026-09-24: patient data is now encrypted at rest without exception.** Uploaded originals — the most sensitive files a user gives LexiTar — used to sit in R2 as the files themselves, authorised but not encrypted, so anyone holding the bucket could read them: an operator, a leaked storage token, a snapshot, the backup copy. Each is now an AES-GCM-256 envelope under a per-file content key minted in the browser and stored only inside the encrypted vault, alongside its transcription sidecar (`VAULT.md` §2a). The deployment holds no standing key that opens any of them, and the backup bucket stops holding plaintext PHI. The limit, disclosed rather than hidden: the deployment decrypts a document in memory while answering its owner's question about it (Indicator 7). Every route serving patient files authorises per client namespace through `functions/_lib/raw-owner.ts`: `/api/raw`, `/api/chat-history` and `/api/document-extract` (W73). Only the owner, or an account holding a live vault grant, may read or delete. A namespace with no owner is claimable only while it is **empty**. One holding objects nobody owns is **orphaned** and refused on every route, and that includes writes (W76). This closed the planned disclosure and a worse hole behind it: one upload could make a stranger the owner, who could then delete the originals. Ownership never flips, because the first writer wins. An owner locked out by legacy data gets back in by proving a stored file's full SHA-256 (`POST /api/raw/claim`, automatic on vault open). Otherwise the operator assigns it (`raw-backfill --assign`) or the retention sweep removes it (`orphan-sweep`, 90 days). Verified state 2026-09-19: every stored object on prod and dev has an owner. Prod had 0 orphans. Dev's 2 were leftovers of accounts that no longer exist, and they were deleted. Erasure reports `complete: false` instead of claiming a clean erase when it can't attribute an object (`erasure.ts`) | Cite `raw-owner.ts`, `tests/unit/raw-authorization.test.ts` and `API.md` §`/api/raw`. What still stands between 9A and ✅ is Indicator 7's self-service deletion UI and privacy-policy coverage |
| 9B | **Do No Harm — Inappropriate/Illegal Content** | 🟡 Safeguards exist in code: the audited `MEDICAL_DISCLAIMER` (`src/lib/brand.ts`) shown in-app, education-not-medicine framing, no diagnosis/triage/treatment recommendations | Write up the content-harm controls (disclaimer, framing, fail-closed generation) as one section the application can cite |
| 9C | **Do No Harm — Protection from Harassment** | ✅ Effectively N/A — single-user self-service, no user-to-user/social surface | Note N/A with rationale |

**Read:** 6 of 9 are satisfied (1, 2, 4, 5, 6, 8). Indicator 3 needs writing only. Indicators 7 and 9 need a small piece of UI (self-service deletion), a fuller privacy policy, and a 9B write-up; 9C is N/A.

---

## 4. How to get certified (the process)

1. **Eligibility test (free, ~5 min)** — `digitalpublicgoods.net` self-assessment to gauge readiness against the 9 indicators before formally applying.
2. **Apply** — an *authorized representative of the solution owner* (i.e. the Tiny Tars Foundation) creates an account and submits at **`app.digitalpublicgoods.net/signup`** ("Start your DPG application"). The custom form walks through each indicator's evidence.
3. **Two-stage technical review** — the DPGA technical team reviews the submission against all 9 indicators; the project moves from **nominee → fully-reviewed recognized DPG**. Typically **~30 days** (varies with volume).
4. **Result** — approved solutions are **listed on the DPG Registry** and the owner joins the DPG Product Owners community. **No fee.**
5. **Annual renewal** — DPG status is valid **one year**; an annual re-review confirms continued compliance. Lapsed/non-compliant solutions are removed from the Registry.

Support / questions: `support@digitalpublicgoods.net`. Detailed evaluation criteria live in the DPGA's Review Policy on GitHub.

---

## 5. Gaps to close before applying (ranked)
1. **Self-service account deletion in the UI** (Indicators 7/9A) — wire a confirmed "Delete account" action to `POST /api/account/erase`. The only remaining code gap.
2. **Privacy policy coverage** (Indicator 7) — add consent, data minimization, and governance/access control; say that a question about a document sends that document to the model provider; reference the self-service deletion.
3. **Consent surface for attached inference** (Indicator 7) — there is none today. Deliberately out of scope of the 2026-09-24 encryption work, recorded rather than quietly carried.
4. **Ownership statement** (Indicator 3).
5. **Do-no-harm write-up** (9B content controls).

---

## 5b. Verified status history

**2026-09-24** — Indicators 7 and 9A re-assessed against the report corpus, which merged four days
after the previous verification:

- **9A: uploaded originals are encrypted at rest.** They were the one class of patient data outside
  the encryption boundary, and both `../../SECURITY.md` and this document had claimed otherwise. Each
  original is now sealed under a per-file content key held only inside the patient's encrypted vault
  (`VAULT.md` §2a); two migration lanes sealed what was already stored, one of them browser-side
  precisely so accounts that revoked org recovery are reachable without the operator. The claim in
  those two documents is now true rather than corrected.
- **7: the corpus is disclosed, not defended.** Whole documents go to the configured model provider
  when their owner asks a question about them; the deployment sees them in plaintext at that moment.
  Both facts are now written in `../../SECURITY.md`, `VAULT.md`, `CORPUS.md` and here, in the same
  words.
- **7: the minimization and consent gaps stay open** and are listed in §5. Encrypting at rest does
  not answer either one.

**2026-09-19** — re-checked against `tinytars/lexi` at `main`:

- **Indicator 4 closed.** Inference moved to one config file with an OpenAI-compatible adapter, so
  a deployer can run any feature on OpenAI or a local open model (`INFERENCE.md`).

- **Indicator 2 closed.** Repo public under MIT since 2026-09-13.
- **Indicator 5 moves to ✅.** The public doc set (README, ARCHITECTURE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG, API, AUTH, VAULT, BUILDING) is in place.
- **9A's two authorisation gaps closed** (W73, `raw-owner.ts`), and the unclaimed-namespace residual with them (W76). Orphaned namespaces are refused on every route, which also ends the squat-then-delete hole. There are three ways out: reclaim by hash (`POST /api/raw/claim`), assignment (`raw-backfill --assign`), or the sweep (`orphan-sweep`). Backfill run on both environments. Prod has 0 orphans. Dev's 2 (leftovers of accounts that no longer exist) were deleted, so dev is now at 0 too. Nothing left to disclose.
- **Indicator 7's privacy policy is published** at `tinytars.foundation/privacy`, but coverage is partial.
- **New finding:** erasure is implemented server-side but has no UI entry point, so it doesn't yet count as a user-facing deletion mechanism.
- **Indicator 4 confirmed as a single-provider dependency** on Anthropic, with no fallback.
- **Indicator 4's hosting half closed** (tinytars/lexi #43, #44, #53): a Node self-host and Docker
  image run the unchanged backend, proven by the e2e suite on both hosts in CI. Deploy tooling
  (wrangler, backups, snapshots) stays Cloudflare-specific, and the Node host is an alternative,
  not a second production.

**2026-08-24** — Indicators 6 and 8 moved to "already satisfied" (CSV/JSON export and WebAuthn/NIST crypto were live; FHIR had never been required). Indicators 7 and 9A moved *down* to 🟡 once the six privacy sub-requirements were cross-walked and deletion turned out not to exist; deletion was built 2026-08-25.

## 6. Next actions
- [ ] Run the **free eligibility test** to get an official readiness read against the 9 indicators.
- [ ] Ship the **self-service "Delete account"** UI over `/api/account/erase`.
- [ ] Extend the **privacy policy** (consent, minimization, governance, self-service deletion, and what the corpus sends to the model provider).
- [ ] Write the **ownership** and **do-no-harm** statements.
- [ ] Only after the above: submit at `app.digitalpublicgoods.net/signup` as the Tiny Tars Foundation.
- [ ] Until submitted, keep all copy at **"developed as a Digital Public Good"** — never "certified".

---

## Sources
- DPGA — [DPG Standard (9 indicators)](https://www.digitalpublicgoods.net/standard) · [Submission Guide](https://www.digitalpublicgoods.net/submission-guide) · [FAQ](https://www.digitalpublicgoods.net/frequently-asked-questions) · [Registry](https://www.digitalpublicgoods.net/registry) · [DPG Standard on GitHub](https://github.com/DPGAlliance/DPG-Standard)
- Related docs in this repo — `FEATURES.md` (the 4 DPG pillars), `LIABILITY.md` (the non-commercial utility's legal posture), `../../SECURITY.md`, `../../ARCHITECTURE.md`. The funding role, open-source IP position, brand/claim guidelines, and LexiTar's scope/population live with the Foundation's records rather than here.
