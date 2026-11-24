# Finding an answer in this repository

**Where an answer is, as opposed to what this project is or how to run it.** Thirty-nine documents
hold about 542,000 B here, most of them under `apps/lexitar/`, and the largest is 57,233 B — so the
expensive mistake is not a slow search but an unaimed one, which returns a plausible section of the
wrong document. [`README.md`](README.md) says what LexiTar is and why,
[`START-HERE.md`](START-HERE.md) is the tutorial, and [`ARCHITECTURE.md`](ARCHITECTURE.md) is the
contract; this file says which document holds a given answer, and restates none of them.

It is also what an agent reads first. The shape is the estate's shared retrieval contract —
`promontory-studio/plover-context`'s `infra/retrieval/CONTRACT.md` — which asks for an entry point
short enough to be read whole, an alias table written by hand, and a generated projection of every
heading beside it.

## Three ways in, in this order

1. **The alias table below**, where the subject is known. It maps the words a question arrives in
   onto the document that answers it, and it is one hop: a row is written only where the document is
   certain, because a missing row is recovered from by the commands below while a wrong row sends a
   question somewhere plausible and empty.

2. **Three ranked commands**, where the table has no row:

   | To find | Command |
   |---|---|
   | the section holding it | `git grep -nE '^#{2,3} .*<word>' -- '*.md'` |
   | the document about it | `git grep -ci <word> -- '*.md' \| sort -t: -k2 -rn \| head` |
   | the file itself | `git ls-files \| grep -i <word>` |

3. **[`HEADINGS.md`](HEADINGS.md)**, where the subject itself is unknown — every `##` and `###`
   heading in the corpus on one page, 308 of them across 36 documents, generated rather than
   maintained. Scan it for the words the question uses, then open the one document.

### The words a question uses

<!-- BEGIN ALIASES -->
| A question saying | Folder or file | Then |
|---|---|---|
| encryption, what the operator can read, org recovery, bearer token, R2 layout, cascade delete | `apps/lexitar` | `VAULT.md` |
| the vault boundary stated precisely, the claim this codebase does *not* make | `ARCHITECTURE.md` | — |
| which secret, where it belongs, rotation, what a clone can do with none of them | `apps/lexitar` | `CREDENTIALS.md` |
| passkey, which passphrase to log in with, setting a Pages secret, adding a user, wrangler | `apps/lexitar` | `AUTH.md` |
| HTTP route, endpoint, request shape, access-events log, raw-original download | `apps/lexitar` | `API.md` |
| lab file, PDF, parser, dedup, watchlist, source provenance, removing a source | `apps/lexitar` | `INGEST.md` |
| reference range, personalized target, how a reading is classified, blood marker | `apps/lexitar` | `BLOOD.md` |
| DEXA, body composition, bone density | `apps/lexitar` | `DEXA.md` |
| radiology, imaging, a free-text report | `apps/lexitar` | `NARRATIVE.md` |
| what the model is shown, prompt cache, the context ceiling, what an inference costs | `apps/lexitar` | `CORPUS.md` |
| which model runs what, switching provider, OpenAI, a local model | `apps/lexitar` | `INFERENCE.md` |
| which stack, open weights, running with no vendor account | `apps/lexitar` | `MODELS.md` |
| model quality, what was scored, pre-registration, what is not measured | `apps/lexitar` | `MEASUREMENT.md` |
| the Finding DAG, which section is stale, what recomputes | `apps/lexitar/docs` | `finding-dag.md` |
| why a Translate is blocked, leaf, vocabulary | `apps/lexitar/docs` | `TRANSLATE.md` |
| snapshot, the restore drill, the alarm | `apps/lexitar` | `BACKUP.md` |
| moving beta users from dev to prod, the passkey consequence | `apps/lexitar` | `CUTOVER.md` |
| exporting one record, a third party at the command line, the weekly renewal | `apps/lexitar/docs` | `RECORD-EXPORT.md` |
| which operation cannot run in continuous integration | `apps/lexitar/docs` | `OPS-LOCAL.md` |
| HIPAA, the FTC breach rule, COPPA, FDA, which law applies | `apps/lexitar` | `LAWS.md` |
| liability, negligence, GDPR, the mitigation rule | `apps/lexitar` | `LIABILITY.md` |
| a complaint, who reads a report, removal, age | `apps/lexitar` | `MODERATION.md` |
| the DPG Standard, an indicator, the compliance dashboard | `apps/lexitar` | `DPGA.md` |
| Sustainable Development Goal, which target, what is not claimed | `SDG.md` | — |
| reporting a vulnerability, what this app claims about its security | `SECURITY.md` | — |
| local dev, the ingest CLI, testing, deploying this app | `apps/lexitar` | `README.md` |
| the miniflare pin, testing discipline, this app's build rules | `apps/lexitar/docs` | `BUILDING.md` |
| an e2e failure that happened before, in-flight request interception | `apps/lexitar/docs` | `E2E-HISTORY.md` |
| which lint rules are off, and why | `apps/lexitar` | `LINTING.md` |
| why an applied migration was rewritten in place | `apps/lexitar/docs/adr` | `0001-rewrite-applied-migration-0002.md` |
| the frame package, a controller, a screen, the menu primitives | `packages/frame` | `ARCHITECTURE.md` |
| where a pull request belongs, the sign-off a contribution arrives under | `CONTRIBUTING.md` | — |
| what this is, in two minutes or in ten | `START-HERE.md` | — |
<!-- END ALIASES -->

### What may be read, and how a hit may be quoted

`.retrieval/config` declares `quote = line`: a matched line may be returned as it stands, not
reduced to its heading. The reason is that a line here is usually the answer — a measured score in
`MEASUREMENT.md`, a target in `SDG.md`, an indicator's verdict in `DPGA.md`, the narrow claim in
`ARCHITECTURE.md` that a reader handed only a heading would round up into a stronger one this
codebase deliberately avoids.

**There is no `.retrieval/exclude` here, and that is a decision rather than an omission.** The file
names what is never opened or quoted, and this repository has nothing to put in it: it is public, it
holds no credential — `apps/lexitar/CREDENTIALS.md` says where each one lives instead — and it holds
no patient record, since a vault is ciphertext before it leaves the device. The one file that looks
like an identity, `apps/lexitar/tests/fixtures/synthetic-patient.ts`, is synthetic with a password
that is public by design, and `START-HERE.md` sends a reader to it on purpose; refusing to open what
the tutorial points at would be a control aimed at the wrong thing.

`scope` is `[!.]*.md` — every tracked markdown document except those under a dot-directory, which
drops three subagent definitions in `.claude/agents/` and two GitHub templates. Those are read by
the tool that dispatches them, not by somebody with a question.

## Known gaps — what this layer does not route

- **Six of the 39 documents in scope have no row**, which is the measurement rather than an
  estimate: this file and `HEADINGS.md`, which are the layer itself rather than destinations;
  `README.md`, which is where a reader of the table came from; `CHANGELOG.md`, which is read by date
  and not by subject; and `CODE_OF_CONDUCT.md` and `packages/frame/CONTRIBUTING.md`, which the grep
  finds by their own obvious words. Nothing routes to the published packages' own sections at the
  repository root either — `README.md` § *`packages/frame`* is where they are.
- **Nothing here routes to code**, and three of the documents above are about code that moves faster
  than they do: `BLOOD.md`, `INGEST.md` and `finding-dag.md` name files and line numbers, and a
  question about current behaviour is answered by the file they name rather than by them.
- **No document carries a generated Contents block**, including the nine over 15,000 B. A question
  that reaches one of those still has to find its section, which `HEADINGS.md` and the first of the
  three commands above are for.
- **A date is not routable here.** `E2E-HISTORY.md` and the dated decisions inside `VAULT.md` are
  reachable by subject and not by when they happened; `git log -1 --format='%h %ad' <file>` is what
  answers that.
