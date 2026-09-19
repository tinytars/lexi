import type { Client, ClientFinding } from "../types";

export interface LeafRegenSpec<TResult = unknown> {
  node: string;
  toolSchema: object;
  systemPromptExtra: string;
  // Sections mergeInto writes, which a full refresh carries forward if the leaf fails. hypothesisEvaluation omits it:
  // it owns nested decisions.patient plus doctorConversation, and carrying half that pair would contradict itself.
  ownedSections?: readonly (keyof ClientFinding)[];
  // The row-array property of toolSchema.input_schema; leaf-regen.ts rewrites its description to match a scoped request.
  scopedArrayKey?: string;
  // Defaults to buildLeafContext. The id-keyed row leaves narrow to `targetIds` here, since their content isn't unique.
  buildContext?(client: Client, targetIds?: string[]): Record<string, unknown>;
  isEmpty?(context: Record<string, unknown>): boolean;
  validate(raw: unknown): TResult;
  // Checks against the INPUT go here, against the EXISTING FINDING in mergeInto: the merge-time client is not the input.
  checkAgainstInput?(context: Record<string, unknown>, result: TResult, targetLabels?: string[]): void;
  // `targetIds` mirrors buildContext's, so a scoped response pairs against those ids rather than the full row list.
  mergeInto(client: Client, result: TResult, targetIds?: string[]): Client;
}
