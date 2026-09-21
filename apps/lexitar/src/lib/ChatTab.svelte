<script lang="ts">
  import type { Client, Vault, NoteAttachment, Attachment } from "./types";
  import type { ChatImportResult } from "./import-flow";
  import type { UnitSystem } from "./units";
  import { buildChatContext, type ChatContext } from "./chat-context";
  import { runMarkerTool } from "./chat-tools";
  import { titleFor, buildReferenceTurn, shownReply, type Thread } from "./chat-threads";
  import { DEFAULT_PERSONA, PERSONAS, type PersonaId } from "./personas";
  import { adaptAnswer } from "./persona-client";
  import HeadingAnchor from "./HeadingAnchor.svelte";
  import ReferenceCard from "./ReferenceCard.svelte";
  import LeafCard from "@tinytars/frame/LeafCard.svelte";
  import TurnCard from "./TurnCard.svelte";
  import PersonaBubble from "@tinytars/frame/PersonaBubble.svelte";
  import LeafActionMenu from "@tinytars/frame/LeafActionMenu.svelte";
  import type { LeafMenuItem } from "@tinytars/frame/menu-items";
  import { standardLeafActions, buildNoteAttachment } from "./leaf-actions";
  // MAX_ATTACHMENTS, not MAX_VISION_ATTACHMENTS: that cap is about how many IMAGES one request may
  // carry to a vision model. A document rides as text and a plain attachment costs nothing at all,
  // so capping a chat attach at four was the image tier leaking into a surface that isn't one.
  import { MAX_ATTACHMENTS, appendAttachments, fetchAttachmentBase64, attachFiles, attachmentUrl } from "./attachment-store";
  import { documentTextsFor, needTranscription } from "./document-extract-client";
  import { documentsPromptBlock } from "@pablotech/akesi/document-read";
  import { DEFAULT_ATTACH_ACCEPT } from "@tinytars/frame/attach-controller";
  import { ABILITY_UNAVAILABLE, supports } from "./model-ability";
  import DictateButton from "@tinytars/frame/DictateButton.svelte";
  import AttachmentStrip from "@tinytars/frame/AttachmentStrip.svelte";
  import { PRODUCT_NAME } from "./brand";
  import { providerFor } from "./model-config";
  import { messageAnchor, reportAnchor } from "./anchor";
  import { type Permalink, parseHash } from "./permalink";
  import { resolveReference } from "./reference-resolver";

  // Chat is the primary experience: a Gemini-style thread shell. Threads persist per client as an
  // in-browser-encrypted blob (W16, chat-store.ts) — restored on return, PHI never plaintext at rest.
  // M76 Phase 5 — the thread list itself (state + persistence) lives in App.svelte now, rendered in
  // Sidebar.svelte's lower zone; this component keeps only the conversation pane.
  interface Props {
    client: Client;
    // The vault DEK (encrypts the thread blob, W44) and the client id (keys it). Absent on a
    // roster/locked view — persistence is simply skipped until both are present. /api/chat itself
    // is gated by the hd_session cookie, so no auth token is threaded here anymore.
    dek: CryptoKey | null;
    clientId: string | null;
    unitSystem?: UnitSystem;
    persona?: PersonaId;
    // W38 — the active thread id (App.svelte's `section`, reused as-is — no new concept needed).
    activeId: string | null;
    // Bindable — App.svelte owns the array; send()/onPaste() append turns straight back through it.
    threads: Thread[];
    hydrated: boolean;
    // M69 — pasted-permalink reference cards: vault to resolve against, onNavigate to reuse
    // App.svelte's navigate() when a card is clicked.
    vault: Vault | null;
    onNavigate?: (patch: Partial<Permalink>) => void;
    onPersist: () => void;
    onImportFile?: (file: File) => Promise<ChatImportResult>;
    onCreateNote?: (attachment: NoteAttachment) => void;
  }
  let {
    client,
    dek,
    clientId,
    unitSystem = "imperial",
    persona = DEFAULT_PERSONA,
    activeId,
    threads = $bindable(),
    hydrated,
    vault,
    onNavigate,
    onPersist,
    onImportFile,
    onCreateNote,
  }: Props = $props();

  let input = $state("");
  let loading = $state(false);
  // A subtle "looking up {marker}…" label while a get_marker_readings tool round is in flight.
  let pending = $state<string | null>(null);
  let error = $state<{ code: string; text: string } | null>(null);
  let fileUpload = $state<{ fileName: string } | null>(null);
  // W46 Phase 6 — images (and, since the documents milestone, PDFs and text files) staged via the
  // composer's Attach action, already uploaded (attachFiles ran inside the shared leaf-actions
  // attach handler) but not yet part of a sent turn. Cleared once send() folds them into the
  // outgoing user turn.
  let pendingAttachments = $state<Attachment[]>([]);
  let attachError = $state<string | null>(null);
  const chatPhotos = supports("chat", "photos");
  // Switching threads (new/select/delete, all driven from the sidebar now) clears any stale error
  // banner from the previously-open thread.
  $effect(() => { void activeId; error = null; });
  let chatTabEl: HTMLDivElement | undefined;

  const BILLING_URL = providerFor("chat").billingUrl;

  let current = $derived(threads.find((t) => t.id === activeId) ?? threads[0]);

  // M88 — each user turn plus the assistant turn immediately following it (if any) becomes one
  // LeafCard row, mirroring Treatment/Reports' patient/AI leaf convention. A user turn can be
  // followed by another user turn (e.g. a pasted reference card, then a typed question) — those
  // become two separate single-sided rows; an assistant turn never starts its own row, since
  // send() only ever appends it right after the user turn that triggered it.
  type Turn = Thread["turns"][number];
  type ChatRow = { turn: Turn; turnIdx: number; reply: Turn | null };
  let rows = $derived.by(() => {
    const turns = current.turns;
    const out: ChatRow[] = [];
    let i = 0;
    while (i < turns.length) {
      const turn = turns[i];
      const next = turns[i + 1];
      if (next?.role === "assistant") {
        out.push({ turn, turnIdx: i, reply: next });
        i += 2;
      } else {
        out.push({ turn, turnIdx: i, reply: null });
        i += 1;
      }
    }
    return out;
  });
  function rowTitle(turn: Turn): string {
    return turn.reference ? turn.reference.preview.title : turn.text;
  }

  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
  }

  // M-annotate — a row's "Annotate" menu item hands the note-creation callback a self-contained
  // attachment (permalink back to this turn + a preview), mirroring Notes.svelte's "Chat" item
  // (chat-createNote is the reverse direction of note→chat).
  function buildAttachment(row: ChatRow): NoteAttachment {
    return buildNoteAttachment(
      "chatTurn",
      { tab: "chat", section: current.id, anchor: messageAnchor(current.id, row.turnIdx) },
      {
        title: truncate(rowTitle(row.turn), 140),
        subtitle: row.reply ? truncate(row.reply.text, 140) : undefined,
        tag: "Chat",
      },
    );
  }

  // W84 — replies the reader flipped back to Lexi's original, by turn index. View state only.
  let showOriginal = $state<Record<number, boolean>>({});

  function turnActions(row: ChatRow): LeafMenuItem[] {
    const items = standardLeafActions({
      annotate: onCreateNote ? () => onCreateNote!(buildAttachment(row)) : undefined,
    });
    const adapted = row.reply?.adapted;
    if (!adapted) return items;
    const original = !!showOriginal[row.turnIdx];
    return [
      ...items,
      {
        label: original ? `Show ${PERSONAS[adapted.persona].name}'s version` : `Show ${PERSONAS.lexi.name}'s original`,
        onClick: () => (showOriginal = { ...showOriginal, [row.turnIdx]: !original }),
      },
    ];
  }

  // M92 Phase 6 — the pane no longer self-scrolls (one native page scrollbar now, composer kept
  // reachable via sticky positioning instead); "pinned to the latest message" means scrolling the
  // whole page, not an internal .chat-body region. Scrolling to document.documentElement.scrollHeight
  // overshoots past the composer into the page's Disclaimer/Footer (which render below every tab,
  // M92 Phase 2) — scrollIntoView on the chat container itself stops right at the composer instead.
  // New turns, the "looking up…" bubble, and thread switches all still move the bottom into view.
  $effect(() => {
    void current.turns.length;
    void current.id;
    void loading;
    void error;
    chatTabEl?.scrollIntoView({ block: "end" });
  });

  // ≤5 browser↔Function↔Claude rounds; the last round drops tools so the model must answer.
  const MAX_ROUNDS = 5;

  // W46 Phase 6 — an Anthropic `image` content block, source bytes re-fetched from raw storage
  // (there's no server-side image cache across turns, so a prior turn's attachment is re-fetched
  // and re-sent every time it needs to ride along with a later question, same as history text).
  async function imageBlock(a: Attachment) {
    return { type: "image", source: { type: "base64", media_type: a.mediaType, data: await fetchAttachmentBase64(clientId!, a.key) } };
  }

  // Builds a turn's `content` for the Anthropic message array: plain text when it carries no
  // attachments (the common case, unchanged shape), else an image-blocks-then-text array.
  //
  // Images and documents travel differently, on purpose. An image must be re-sent as bytes on every
  // round — there is no server-side cache across turns. A document was transcribed ONCE at attach
  // time, so it rides as text: dramatically cheaper on a surface that replays its whole history on
  // every send, and quotable, which is the point of attaching it.
  //
  // Except a PDF, where the corpus is on: an attached PDF is stored under the same raw/ prefix the
  // corpus is assembled from, so the model already has the original — see needTranscription.
  async function turnContent(text: string, attachments: Attachment[] | undefined): Promise<unknown> {
    const all = attachments ?? [];
    const images = all.filter((a) => a.mediaType.startsWith("image/"));
    const docs = clientId ? await documentTextsFor(clientId, needTranscription(all)) : [];
    const block = documentsPromptBlock(docs);
    const full = block ? `${block}\n\n${text}` : text;
    if (images.length === 0) return full;
    return [...(await Promise.all(images.map(imageBlock))), { type: "text", text: full }];
  }

  async function send() {
    const q = input.trim();
    if (!q || loading || !dek) return;
    input = "";
    error = null;
    const threadId = current.id;
    const images = pendingAttachments;
    pendingAttachments = [];
    // History = this thread's prior turns (final Q+A only; tool rounds are never stored).
    const history = await Promise.all(current.turns.map(async (t) => ({ role: t.role, content: await turnContent(t.text, t.attachments) })));
    // Append the user turn + set the title from the first message.
    threads = threads.map((t) =>
      t.id === threadId
        ? { ...t, title: titleFor(t, q), turns: [...t.turns, { role: "user" as const, text: q, ...(images.length ? { attachments: images } : {}) }], lastActivityAt: Date.now() }
        : t,
    );
    onPersist();
    loading = true;
    pending = null;
    // M69 — fold every reference-card turn's resolved context into this send, live re-resolved
    // (matches buildChatContext's "always fresh" discipline). wrong-patient/unresolved/section
    // turns all have context: null already and are skipped — nothing to add for those.
    const references: NonNullable<ChatContext["references"]> = [];
    if (vault) {
      for (const t of current.turns) {
        if (!t.reference) continue;
        const resolved = resolveReference(vault, clientId, t.reference.permalink);
        if (resolved.context) references.push({ kind: resolved.kind, tag: resolved.preview.tag, title: resolved.preview.title, data: resolved.context });
      }
    }
    // The running conversation the browser owns: history + the catalog+question turn, grown with
    // each assistant tool_use / user tool_result round. Only the final answer lands in the thread.
    const questionText = `CONTEXT:\n${JSON.stringify({ ...buildChatContext(client, unitSystem), ...(references.length ? { references } : {}) })}\n\nQUESTION:\n${q}`;
    const messages: unknown[] = [
      ...history,
      { role: "user", content: await turnContent(questionText, images) },
    ];
    try {
      let answer: string | null = null;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages, unitSystem, clientId, final: round === MAX_ROUNDS - 1 }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; errorCode?: string };
          error = { code: body.errorCode ?? "model_error", text: body.error ?? `request failed (${res.status})` };
          return;
        }
        const data = (await res.json()) as
          | { kind: "answer"; answer: string }
          | { kind: "tool_use"; assistant: unknown; toolUses: { id: string; name: string; input: { markers?: string[]; from?: string; to?: string } }[] };
        if (data.kind === "answer") {
          answer = data.answer;
          break;
        }
        // Execute the tool locally against the in-browser vault; relay results back.
        messages.push({ role: "assistant", content: data.assistant });
        const names = data.toolUses.flatMap((tu) => tu.input?.markers ?? []);
        pending = names.length ? `looking up ${names.join(", ")}…` : "looking up…";
        messages.push({
          role: "user",
          content: data.toolUses.map((tu) => ({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(runMarkerTool(client, { markers: tu.input?.markers ?? [], from: tu.input?.from, to: tu.input?.to }, unitSystem)),
          })),
        });
      }
      if (answer === null) {
        error = { code: "model_error", text: "the assistant could not complete the request" };
        return;
      }
      if (persona !== DEFAULT_PERSONA) pending = `${PERSONAS[persona].name} is putting it in plain talk…`;
      const adapted = await adaptAnswer(persona, clientId, answer, q);
      threads = threads.map((t) =>
        t.id === threadId
          ? { ...t, turns: [...t.turns, { role: "assistant" as const, text: answer!, ...(adapted ? { adapted } : {}) }], lastActivityAt: Date.now() }
          : t,
      );
      onPersist();
    } catch (e) {
      error = { code: "network", text: (e as Error).message };
    } finally {
      loading = false;
      pending = null;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // W46 Phase 6 — images (and now documents) dropped/pasted straight into the composer stage the
  // same way an Attach pick does (upload now via the shared attachFiles(), fold into the outgoing
  // turn on send). A document is read during attachFiles, so this await can take a few seconds.
  async function stageAttachments(files: File[]) {
    if (!clientId || files.length === 0) return;
    // A photo is re-sent as bytes on every round, so a chat model without vision cannot carry one at
    // all — say so at the composer instead of letting the send fail. Documents are unaffected: they
    // ride as text that was read at attach time.
    const staged = chatPhotos ? files : files.filter((f) => !f.type.startsWith("image/"));
    if (staged.length < files.length) attachError = ABILITY_UNAVAILABLE.photos;
    if (staged.length === 0) return;
    try {
      const added = await attachFiles(clientId, staged, { maxCount: MAX_ATTACHMENTS });
      pendingAttachments = appendAttachments(pendingAttachments, added);
    } catch (err) {
      attachError = err instanceof Error ? err.message : "Attaching failed — try again.";
    }
  }

  // A spreadsheet is the one file a conversation can do nothing with — there is no reading it as
  // prose, and its value is the trend data inside it — so it goes to the marker importer. That is a
  // ROUTE, not a refusal: nothing else is ever turned away, whichever way it arrives.
  const isSpreadsheet = (f: { name: string }) => /\.(xlsx|xls)$/i.test(f.name);

  async function stageOrImport(files: File[]) {
    for (const file of files.filter(isSpreadsheet)) await importReportFile(file);
    const rest = files.filter((f) => !isSpreadsheet(f));
    if (rest.length > 0) await stageAttachments(rest);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    // Anything dropped on the composer is staged, whatever it is. Dropping a file here is an
    // unambiguous "I want to talk about this" — silently refusing it, which an unmatched filter
    // does, is the worst available answer.
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) void stageOrImport(files);
  }

  // M69 — a paste that is *only* a permalink (nothing before matters, nothing may follow the
  // hash) becomes its own reference-card turn instead of raw textarea text. Mixed paste + prose
  // is ambiguous intent, so it's left to paste normally.
  // W46 Phase 6 — a paste that carries image files (a screenshot, an image copied from elsewhere)
  // stages them the same way, checked first since it's unambiguous (no text competing for intent).
  function onPaste(e: ClipboardEvent) {
    const imageFiles = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length > 0) {
      e.preventDefault();
      stageAttachments(imageFiles);
      return;
    }
    if (!vault) return;
    const trimmed = (e.clipboardData?.getData("text/plain") ?? "").trim();
    const hashIdx = trimmed.indexOf("#");
    if (hashIdx < 0) return;
    const pl = parseHash(trimmed.slice(hashIdx));
    if (!pl) return;
    e.preventDefault();
    const turn = buildReferenceTurn(resolveReference(vault, clientId, pl));
    const threadId = current.id;
    threads = threads.map((t) =>
      t.id === threadId
        ? {
            ...t,
            title: titleFor(t, turn.text),
            turns: [...t.turns, turn],
            lastActivityAt: Date.now(),
          }
        : t,
    );
    onPersist();
  }

  // W50 — the report-ingest half of the composer's Attach: previously its own separate "Add file"
  // menu item + hidden input, now routed here from within the unified Attach picker (see
  // routeFile below) when the picked file is a PDF/XLSX rather than an image.
  async function importReportFile(file: File) {
    if (!onImportFile || !clientId) return;
    fileUpload = { fileName: file.name };
    try {
      const result = await onImportFile(file);
      if (!result.ok) {
        error = { code: "import_error", text: result.message };
        return;
      }
      const permalink: Permalink = { tab: "labs", section: "healthReports", anchor: reportAnchor(result.id) };
      const turn = buildReferenceTurn({
        kind: "report",
        permalink,
        preview: {
          title: result.originalName,
          subtitle: result.kind === "pending" ? "Uploaded — processing" : "Just added",
          tag: result.kind === "pending" ? "Processing" : result.kind === "report" ? "Report" : "Source",
        },
        context: null,
      });
      const threadId = current.id;
      threads = threads.map((t) =>
        t.id === threadId
          ? { ...t, title: titleFor(t, turn.text), turns: [...t.turns, turn], lastActivityAt: Date.now() }
          : t,
      );
      onPersist();
    } finally {
      fileUpload = null;
    }
  }
</script>

<div class="chat-tab" data-testid="chat-tab" data-hydrated={hydrated} bind:this={chatTabEl}>
  <section class="conversation">
    <div class="chat-body">
      {#if current.turns.length === 0}
        <p class="chat-hint">
          Ask about {client.displayName}'s markers, trends, and Translation. Read-only assistant — not medical advice.
          Conversations are saved to your encrypted vault and restored when you return.
        </p>
      {/if}
      {#each rows as row, ri (row.turnIdx)}
        {@const showPending = ri === rows.length - 1 && !row.reply && loading}
        <!-- titleContent, not label: chat keeps the anchor id on the CARD (assignId={false}), so
             a permalink to a message scrolls the whole exchange into view. -->
        {#snippet turnTitle()}
          <HeadingAnchor anchor={messageAnchor(current.id, row.turnIdx)} assignId={false} label="Copy link to this message">
            <span class="turn-title">{rowTitle(row.turn)}</span>
          </HeadingAnchor>
        {/snippet}
        {#snippet patientTurn()}
          {#if row.turn.reference}
            <ReferenceCard reference={row.turn.reference} {onNavigate} />
          {:else}
            {#if row.turn.text}<span class="turn-text">{row.turn.text}</span>{/if}
            <AttachmentStrip attachments={row.turn.attachments ?? []} {clientId} {attachmentUrl} productName={PRODUCT_NAME} />
          {/if}
        {/snippet}
        {@const shown = row.reply ? shownReply(row.reply, !!showOriginal[row.turnIdx]) : null}
        {#snippet aiTurn()}<span class="turn-text">{shown!.text}</span>{/snippet}
        <TurnCard
          anchor={messageAnchor(current.id, row.turnIdx)}
          titleContent={turnTitle}
          items={turnActions(row)}
          patient={patientTurn}
          ai={row.reply ? aiTurn : undefined}
          aiLabel={PERSONAS[shown?.persona ?? persona].name}
          aiVoice={shown?.persona ?? persona}
          aiRetellable={false}
          aiPending={showPending}
          aiPendingText={pending ?? "…"}
          aiEmpty="No reply yet."
        />
      {/each}
      {#if fileUpload}
        <LeafCard dashed>
          <div class="rg-grid">
            <div class="rg-col">
              <PersonaBubble persona="owner" label="Patient">
                <span class="turn-text pending">Attaching {fileUpload.fileName}…</span>
              </PersonaBubble>
            </div>
          </div>
        </LeafCard>
      {/if}
      {#if error}
        <div class="chat-error">
          {error.text}
          {#if error.code === "insufficient_credit" && BILLING_URL}
            <a href={BILLING_URL} target="_blank" rel="noopener">Open the AI provider's billing console</a>
            <span class="chat-error-hint">Log in as the organization account.</span>
          {/if}
        </div>
      {/if}
    </div>

    {#if attachError}<p class="chat-error">{attachError}</p>{/if}
    {#if pendingAttachments.length > 0}
      <AttachmentStrip
        attachments={pendingAttachments}
        {clientId}
        {attachmentUrl}
        productName={PRODUCT_NAME}
        onRemove={(a) => (pendingAttachments = pendingAttachments.filter((x) => x.key !== a.key))}
      />
    {/if}
    <div
      class="chat-input"
      ondragover={(e) => e.preventDefault()}
      ondrop={onDrop}
    >
      <!-- One Attach entry point. routeFile still claims a SPREADSHEET, which is a marker import and
           nothing a conversation can do anything with — but no longer a PDF.
           Diverting every picked PDF into report ingest meant you could not talk about a document at
           all: the one thing a chat attachment is for. A PDF now falls through to attachFiles() like
           an image, gets read once at attach time, and rides the turn as text. Reports keeps its own
           import — and now refuses a document that is not actually a report (report-extract.ts). -->
      <LeafActionMenu
        icon="+"
        label="Add"
        items={standardLeafActions({
          attach: clientId ? {
            clientId, accept: DEFAULT_ATTACH_ACCEPT, maxCount: MAX_ATTACHMENTS,
            onAttached: (added) => (pendingAttachments = appendAttachments(pendingAttachments, added)),
            onError: (msg) => (attachError = msg),
            routeFile: async (file) => {
              if (!isSpreadsheet(file)) return false;
              await importReportFile(file);
              return true;
            },
          } : undefined,
        })}
      />
      <textarea
        bind:value={input}
        onkeydown={onKeydown}
        onpaste={onPaste}
        placeholder={`Ask ${PERSONAS[persona].name}… e.g. what changed since my last echo?`}
        aria-label="Ask a question about this record"
        rows="2"
      ></textarea>
      <DictateButton onResult={(t) => (input = input ? `${input} ${t}` : t)} />
      <button class="send" onclick={send} disabled={loading || !input.trim()}>Send</button>
    </div>
  </section>
</div>

<style>
  .chat-tab {
    display: flex;
    gap: 0;
    /* Match the other content tabs' width instead of spanning the full page (W22). */
    max-width: var(--leaf-max);
    margin: 0 auto;
  }
  .conversation {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .chat-note {
    margin: 0; padding: 0.4rem 0.85rem; color: var(--muted); font-size: 0.8rem;
    border-bottom: 1px solid var(--border); background: var(--band);
  }
  @media print { .chat-note { display: none !important; } }
  .chat-body {
    padding: 1rem;
    display: flex;
    flex-direction: column;
  }
  .chat-hint { color: var(--muted); font-size: 0.85rem; line-height: 1.5; margin: 0; max-width: 36rem; }
  .turn-title {
    display: inline-block; max-width: 22rem; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; vertical-align: bottom; font-weight: 600; font-size: 0.92rem;
  }
  .turn-text { white-space: pre-wrap; font-size: 0.88rem; }
  .turn-text.pending { color: var(--muted); }
  .chat-error { color: var(--alert); font-size: 0.85rem; }
  .chat-error a { display: inline-block; margin-top: 0.3rem; color: var(--alert); font-weight: 600; }
  .chat-error-hint { display: block; margin-top: 0.2rem; }
  .chat-input {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem 0.85rem;
    border-top: 1px solid var(--border);
    /* M92 Phase 6 — the pane no longer self-scrolls; a sticky composer is what keeps it reachable
       without scrolling further, replacing the old fixed-height self-scrolling shell. */
    position: sticky;
    bottom: 0;
    background: var(--bg);
  }
  .chat-input textarea {
    flex: 1;
    resize: none;
    font: inherit;
    font-size: 0.92rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .send {
    align-self: flex-end;
    padding: 0.55rem 1.1rem;
    border: none;
    border-radius: 8px;
    background: var(--p-owner);
    color: var(--surface);
    cursor: pointer;
    font: inherit;
    min-height: 44px;
  }
  .send:disabled { opacity: 0.5; cursor: default; }

  /* Print the conversation thread only — the sidebar (and its now-embedded thread list) already
     hides itself in print (Sidebar.svelte); only the composer needs dropping here. */
  @media print {
    .chat-input { display: none !important; }
  }
</style>
