# Relevance to the Sustainable Development Goals

LexiTar claims relevance to two of the seventeen United Nations Sustainable Development Goals, against
three targets in total: **3.8** and **3.4** under Goal 3 (Good Health and Well-being), and **10.2**
under Goal 10 (Reduced Inequalities). This page states the case target by target — the target's own
wording, the mechanism in LexiTar that bears on it, and a file in this repository a reader can open to
check that the mechanism is real. It closes with what LexiTar does not claim, which is the longer half
of an honest mapping.

Nothing else is claimed. No other goal, no other target, and none of the five official UN indicators
that sit under these three.

## The gap this closes is comprehension, not availability

Every target below is approached from the same observation, which is also the reason the project
exists: a person who has been given their medical records has not thereby been given what the records
say. The data is available. Interpreting it takes a vocabulary, a sense of which numbers move together,
and a reference range read against that person's own history rather than against a population — three
things a lab report is not written to supply.

That places LexiTar at a specific point in every one of these targets: after access, before
understanding. It is not a way to reach people the health system misses, and it is not care. It is the
step where an artifact a person already holds becomes something they can read, ask about, and take back
into an appointment.

## SDG 3.8 — a service a person cannot read is not access to what it found

> **Target 3.8** — "Achieve universal health coverage, including financial risk protection, access to
> quality essential health-care services and access to safe, effective, quality and affordable
> essential medicines and vaccines for all"

Coverage delivers the result. It does not deliver the meaning of the result. A patient who receives a
lab report they cannot interpret has been given access to a service and no access to what the service
found — and the target's wording is access to *quality* services, not to services at any legibility.

LexiTar takes the artifacts a covered patient already holds — lab panels, imaging reports, clinical
history — and renders each value against its own reference range and its own history in language
written for a non-clinical reader, then compiles that into a document meant to make the next
appointment more productive rather than to replace it. The shared import path is
[`apps/lexitar/INGEST.md`](apps/lexitar/INGEST.md); per-marker ranging and interpretation are
[`apps/lexitar/BLOOD.md`](apps/lexitar/BLOOD.md); free-text radiology and imaging reports take their
own path in [`apps/lexitar/NARRATIVE.md`](apps/lexitar/NARRATIVE.md). Every answer about a person is
produced in sight of that person's own source documents, whole and unaltered, rather than a schema's
summary of them — [`apps/lexitar/CORPUS.md`](apps/lexitar/CORPUS.md) is why that distinction is load
bearing for the word *quality*.

It is free, requires no insurer, provider or institution to adopt it, and runs against the patient's
own copy of their records, so nothing about using it depends on the coverage they have.

**Against the official indicators.** 3.8.1 measures coverage of essential health services; 3.8.2
measures the share of households whose out-of-pocket health spending exceeds a threshold of their
budget. LexiTar moves neither. It acts on the step between a covered service and a patient able to use
its output — which the indicators do not measure and the target's own wording does.

## SDG 3.4 — a chronic condition is managed between appointments, on numbers

> **Target 3.4** — "By 2030, reduce by one third premature mortality from non-communicable diseases
> through prevention and treatment and promote mental health and well-being"

Non-communicable disease is the category whose management happens mostly outside the clinic. Between
two appointments a year, what a person has to work with is a set of numbers: lipids, glucose and
HbA1c, blood pressure, bone density, body composition. Prevention in the target's sense is a series of
decisions made against those numbers by the person whose numbers they are — which is only possible if
they can read them, and specifically if they can see a value as a trend rather than as a single result
flagged high or low against a population range.

LexiTar's ranging stage computes a personalized target per marker rather than restating the lab's
generic reference interval, and its interpretation stage produces a plain-language Finding from the
readings in context ([`apps/lexitar/BLOOD.md`](apps/lexitar/BLOOD.md)). Body-composition and
bone-density scans run the same machinery with their own extraction path
([`apps/lexitar/DEXA.md`](apps/lexitar/DEXA.md)). The reasoning those stages apply is not improvised
per request: it comes from reviewed finding-DAG content maintained as a separate open corpus in
[`tinytars/reasoning`](https://github.com/tinytars/reasoning), so what the software concludes from a
marker is inspectable rather than latent in a prompt.

**Against the official indicators.** 3.4.1 is the mortality rate attributed to cardiovascular disease,
cancer, diabetes or chronic respiratory disease; 3.4.2 is the suicide mortality rate. LexiTar moves
neither, and no claim here should be read as contributing to a mortality figure. The target names
*prevention* alongside treatment, and the thing being offered is comprehension of the measurements
prevention is decided on.

## SDG 10.2 — the exclusion here is reading ability and language, not geography

> **Target 10.2** — "By 2030, empower and promote the social, economic and political inclusion of all,
> irrespective of age, sex, disability, race, ethnicity, origin, religion or economic or other status"

The group excluded from their own medical records is not defined by where they live or what they can
pay. It is defined by reading ability, by first language, and often by age or disability — the
statuses the target enumerates. A record written for clinicians excludes every patient who is not one,
and does so silently: nothing announces that the document was not written to be understood by the
person it is about.

Two properties of LexiTar bear on the target's word *empower*. The first is that the patient holds the
data: every record is encrypted on the patient's own device before it reaches storage, so the operator
holds ciphertext in the ordinary course of running the app
([`apps/lexitar/VAULT.md`](apps/lexitar/VAULT.md)). The second is that no institution stands in the
path. There is no provider portal to be enrolled in and no insurer to bill; the backend runs off
Cloudflare entirely as a plain Node self-host if a deployer wants no dependence on this project's
operator at all ([`ARCHITECTURE.md`](ARCHITECTURE.md#cloudflare-is-one-host-not-a-dependency)), and
seeing the whole system work does not require even an account — a synthetic credential-free identity
ships with the app and is driven end to end by the same suite CI runs on every push
([`START-HERE.md`](START-HERE.md)). When something goes wrong, the complaint channel is open to anyone
rather than to customers, and states what the operator can and cannot do about a report
([`apps/lexitar/MODERATION.md`](apps/lexitar/MODERATION.md)).

**Against the official indicator.** 10.2.1 is the proportion of people living below 50 per cent of
median income. LexiTar has no bearing on it. The claim is against the target's inclusion language, and
against one specific exclusion inside it.

## What this does not claim

- **No outcome study has been run.** No measured improvement in any person's health literacy,
  adherence, or clinical outcome is claimed anywhere in this repository, and none should be inferred
  from the sections above.
- **What has been measured is model output quality, which is a different thing.**
  [`apps/lexitar/MEASUREMENT.md`](apps/lexitar/MEASUREMENT.md) is the only page here that carries a
  number about model quality. A model that scores well on a benchmark has not been shown to have made
  anyone understand their results.
- **The interface is English-only today.** The audience this project describes includes people with
  limited English, and the software does not yet meet them in another language. That is a gap, not a
  nuance.
- **This is education, not care delivery.** LexiTar is not a diagnostic engine, not a medical-advice
  service, and not a substitute for an appointment; the line is drawn for regulatory purposes in
  [`apps/lexitar/LIABILITY.md`](apps/lexitar/LIABILITY.md). It follows that LexiTar sits upstream of
  every official UN indicator named on this page rather than contributing to one, and the mapping above
  is stated against the *targets*, which describe intent, rather than against the indicators, which
  measure population outcomes this project does not reach.
- **Relevance is not impact.** Everything here is an argument that the work addresses these targets. It
  is not evidence that it has moved them.

## Sources

Target and indicator wording is quoted from the United Nations' own goal pages, read 2026-09-27:

- Goal 3 — <https://sdgs.un.org/goals/goal3>
- Goal 10 — <https://sdgs.un.org/goals/goal10>

The assessment that scores this repository against the Digital Public Goods Standard, including the
indicator this page is the evidence for, is [`apps/lexitar/DPGA.md`](apps/lexitar/DPGA.md).
