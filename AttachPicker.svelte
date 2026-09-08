<script lang="ts">
  import { onMount } from "svelte";
  import { registerAttachPicker, DEFAULT_ATTACH_ACCEPT, type AttachMode } from "./attach-controller";

  // W46 Phase 4 — mounted once (App.svelte), owns the single hidden file input every leaf's
  // "Attach" action shares via attach-controller.ts. One input, not three: the same element's
  // `accept`/`capture` attributes are set right before each programmatic `.click()`, so "Take
  // photo" / "Photo library" / "Choose file" don't need three separate elements per leaf row.
  let inputEl: HTMLInputElement;
  let onFilesCb: ((files: File[]) => void) | null = null;

  function open(mode: AttachMode, onFiles: (files: File[]) => void, accept = DEFAULT_ATTACH_ACCEPT): void {
    onFilesCb = onFiles;
    if (mode === "camera") {
      inputEl.accept = "image/*";
      inputEl.setAttribute("capture", "environment");
    } else {
      inputEl.accept = accept;
      inputEl.removeAttribute("capture");
    }
    inputEl.click();
  }

  onMount(() => registerAttachPicker(open));

  function onChange(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    const cb = onFilesCb;
    onFilesCb = null;
    if (files.length > 0) cb?.(files);
  }
</script>

<input bind:this={inputEl} type="file" multiple style="display:none" onchange={onChange} />
