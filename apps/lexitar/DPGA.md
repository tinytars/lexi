# DPGA.md — Digital Public Goods Alliance: what it is & how LexiTar gets certified

**Created:** 2026-07-11 · **Folder:** `apps/health-dash-web/`
**Why this doc:** LexiTar's positioning (`../BRANDING.md` §1) and its funding strategy — kept with the Foundation's records, not in this repo — both hinge on LexiTar being **developed as a Digital Public Good (DPG)** and the Tiny Tars Foundation **pursuing DPGA registration**. This doc explains what that means and the concrete path to it.

> **Claim discipline (`../BRANDING.md` §1):** say LexiTar is **"developed as a Digital Public Good."** Do **not** say "certified," "DPG-certified," or "certified-ready" until the Foundation has actually submitted a DPGA application. Once submitted, LexiTar is a **"nominee"**; only after full review is it a **recognized DPG**.

---

## 0. TL;DR

- **DPGA = Digital Public Goods Alliance** — a UNICEF/Norad-rooted, multilateral body (members incl. UNICEF, UNESCO, GitHub, national governments) that **certifies** open-source software/data/AI/content as **Digital Public Goods** against the **DPG Standard (9 indicators)** and lists them in a public **Registry**.
- **It doesn't (mostly) fund** — it certifies and connects. Registration is a **free credibility badge** that de-risks every philanthropic ask (`FOUND.md` §2E/§3) and can open DPGA-facilitated funders (e.g. Co-Develop).
- **Process:** free 5-min eligibility test → apply at `app.digitalpublicgoods.net/signup` → two-stage technical review (~30 days) → recognized DPG on the Registry → **annual renewal.**
- **LexiTar is unusually well-aligned** on privacy/security/standards (its architecture was built for exactly this), **but the one hard gate is Indicator 2: the core LexiTar software must be released under an approved open-source license** (MIT / Apache 2.0 — see `FOUND.md` §4). That, plus ownership + documentation, is the work.

---

## 1. What the DPGA / a DPG is

A **Digital Public Good** is open-source software, open data, an open AI system, or open content that (a) is **relevant to the UN Sustainable Development Goals (SDGs)**, (b) uses **approved open licenses**, and (c) is designed to **do no harm** — and does all of it in a way that's platform-independent, documented, and privacy-respecting. The **DPGA** maintains the **DPG Standard**, reviews nominees against it, and publishes recognized DPGs in the **DPG Registry** (a discovery surface funders, governments, and multilaterals actually shop from).

**Scoping note for LexiTar:** the DPG is the **LexiTar public software** (the open, community-owned Health Literacy Utility) — **not** the private patient data or the internal health-dash vault. The certification is about the *code/system*, which must be open-licensed; **individual users' PHI is never the DPG and stays private, client-encrypted, and out of scope.**

---

## 2. Why LexiTar pursues DPG status

1. **Funding credibility (`FOUND.md`):** a recognized-DPG badge signals genuine non-commercial public good — it strengthens *every* foundation/AI-for-good application and opens DPGA-facilitated funders.
2. **Brand positioning (`BRANDING.md` §1):** "developed as a Digital Public Good" is the canonical positioning, satisfying the Google Ad Grant non-commercial requirement while signaling privacy-by-design / data-minimization / purpose-limitation.
3. **Private-benefit defense:** DPG open-licensing is also the operational answer to foundation lawyers' private-benefit concern (the charity's core asset is open + community-owned, not a founder's proprietary product — `FOUND.md` §4).

---

## 3. The DPG Standard — 9 indicators & LexiTar's readiness

| # | Indicator | LexiTar status | Gap / action |
|---|---|---|---|
| 1 | **SDG Relevance** | ✅ Strong — SDG 3 (Health & Well-being) + SDG 10 (Reduced Inequalities); health literacy for low-literacy/LEP adults | Document the SDG mapping |
| 2 | **Open Licensing** | ❌ **The hard gate** — core is currently private/proprietary | **Release the core LexiTar software under MIT or Apache 2.0** (`FOUND.md` §4). Biggest single blocker |
| 3 | **Clear Ownership** | 🟡 Tiny Tars Foundation owns it, but the LLC↔charity IP split isn't formalized | Document ownership + the license/service arrangement (LLC keeps enterprise-integration sales; utility stays open) |
| 4 | **Platform Independence** | 🟡 Runs on Cloudflare + depends on a proprietary LLM (Anthropic) | Show core function isn't locked to one closed platform; document the model dependency (and any open-model fallback) — the AI dependency is the nuance to address |
| 5 | **Documentation** | 🟡 Internal docs exist; not public/DPG-grade | Publish technical + user docs (install, API, contribution guide) |
| 6 | **Non-PII Data Extraction** (export in a non-proprietary format) | ✅ **Likely already satisfied** — `src/lib/export.ts` ships CSV (`exportCsv`) and a structured JSON dump (`exportJson`) through `ExportTab.svelte`. The indicator asks for *a* non-proprietary format, not specifically FHIR (verified 2026-08-22, doc `cross-app/11`) | Document the existing CSV/JSON export as the evidence. FHIR remains a nice-to-have for Indicator 8, **not a blocker here** |
| 7 | **Privacy & Applicable Laws** | 🟡 **Downgraded 2026-08-24; the engineering half closed 2026-08-25.** Six mandatory sub-requirements: data minimization, consent mechanisms, a *published* privacy policy, **deletion mechanisms**, retention transparency, governance/access-control docs. **Deletion now exists** — `POST /api/account/erase` (W72), with an access-control policy that can be read in one place (`functions/_lib/capabilities.ts`). The remaining five are documentation, not code, and the honest caveat is that erasure reports itself `complete: false` for objects written before migration 0008 | Publish `/privacy`; document the other four; close the pre-0008 raw-object gap (`SECURITY.md` gap 1) so erasure is unconditionally complete |
| 8 | **Open Standards & Best Practices** | ✅ **Already satisfied by shipped mechanisms** — WebAuthn/FIDO2 (passkeys, live), NIST-standard AES-GCM-256 and PBKDF2-SHA256, ECDH-ES over P-256, HMAC-SHA256, all via WebCrypto | Cite these rather than blocking on FHIR. See `SECURITY.md` §Cryptographic choices |
| 9A | **Do No Harm — Data Privacy & Security** | 🟡 **Same six sub-requirements as Indicator 7; deletion closed 2026-08-25.** The architecture is strong and written down (`SECURITY.md`), *including* the authorisation gaps that remain open — `/api/raw` is authenticated but not authorised, and `chat-history` PUT is unscoped. W72 built the missing primitive for the first (`raw_objects` ownership rows) without yet enforcing it on reads | `SECURITY.md` is the architecture document; the two named gaps must close before an application, not after |
| 9B | **Do No Harm — Inappropriate/Illegal Content** | 🟡 LexiTar generates health explanations | Document the **education-not-medicine, fail-closed, no-diagnosis** safeguards (`BRANDING.md` §1/§7) as the content-harm control |
| 9C | **Do No Harm — Protection from Harassment** | ✅ Effectively N/A — single-user self-service, no user-to-user/social surface | Note N/A with rationale |

**Read:** LexiTar clears or nearly clears **7 of 9** on architecture alone (privacy/security/standards/SDG are its strengths). The real work is **Indicator 2 (open-source the core)**, then **3/4/5** (ownership docs, platform-independence/model nuance, public documentation), then formalizing **9B**.

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
1. **Open-source the core** (Indicator 2) — pick MIT or Apache 2.0; carve the public utility out from any proprietary LLC integrations (`FOUND.md` §4). *Prerequisite for everything.*
2. **Formalize ownership + the LLC↔charity IP arrangement** (Indicator 3).
3. **Publish DPG-grade documentation** — install/run, contribution guide, API (Indicator 5).
4. **Resolve the model-dependency / platform-independence story** (Indicator 4) — document the LLM dependency and how core function is not locked to one proprietary platform.
5. **Ship + document the FHIR export** (Indicator 6) and **write up the do-no-harm content controls** (9B).

---

## 5b. Verified status, 2026-08-24 (W72)

Re-checked against the code rather than against the previous row, per `docs/cross-app/11`:

- **Indicator 6 moves from "once FHIR ships" to "likely already satisfied."** CSV and JSON export
  exist and ship today. This was a self-inflicted blocker: the indicator never required FHIR.
- **Indicator 8 likewise** — WebAuthn and NIST primitives are live and citable now.
- **Indicators 7 and 9A move DOWN, from ✅ to 🟡.** Not because anything regressed, but because the
  six sub-requirements were not previously cross-walked, and one of them — a deletion mechanism —
  does not exist. Marking these green would have failed an assessor's first check.
- **Indicator 5** now has `SECURITY.md`, `LINTING.md` and `ARCHITECTURE.md` in-repo; the public-grade
  README/CONTRIBUTING set follows the split (`cross-app/06` and `10` Phase B).

Net: two indicators cheaper than believed, two more honest than believed, one unchanged blocker
(Indicator 2, open licensing, which only executing 06/10 closes).

## 6. Next actions
- [ ] Run the **free eligibility test** to get an official readiness read against the 9 indicators.
- [ ] Decide the **open-source license** (MIT vs Apache 2.0) + scope exactly which code is the open utility vs. the LLC's proprietary integrations.
- [ ] Draft the **ownership + IP** documentation (Foundation owns the open utility; LLC licenses enterprise integrations).
- [ ] Only after the above: submit at `app.digitalpublicgoods.net/signup` as the Tiny Tars Foundation.
- [ ] Until submitted, keep all copy at **"developed as a Digital Public Good"** — never "certified" (`BRANDING.md` §1).

---

## Sources
- DPGA — [DPG Standard (9 indicators)](https://www.digitalpublicgoods.net/standard) · [Submission Guide](https://www.digitalpublicgoods.net/submission-guide) · [FAQ](https://www.digitalpublicgoods.net/frequently-asked-questions) · [Registry](https://www.digitalpublicgoods.net/registry) · [DPG Standard on GitHub](https://github.com/DPGAlliance/DPG-Standard)
- Related internal docs — `../BRANDING.md` §1 (claim discipline), `FEATURES.md` (the 4 DPG pillars). The funding role, open-source IP position and LexiTar's scope/population live with the Foundation's records rather than here.
