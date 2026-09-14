// The ★ on a BODY cell, as the same write the sidebar row makes.
//
// A pin has two surfaces — the sidebar row and the cell itself — and they must agree, because they
// are the same item. Both go through vault-item-ops (which is where each kind's pin actually lives:
// a marker's is watchlist membership, a report's is a boolean on its SourceRecord, a generated
// item's is a lazily-minted itemRegistry record), so there is one write and one read, not two.
//
// `onPin` absent = this surface cannot pin (a read-only/provider-less view), and the cell shows no
// ★ at all rather than a dead one.
import type { Client } from "./types";
import { isPinnedIn, type SidebarItemKind } from "./vault-item-ops";

export type PinItem = (kind: SidebarItemKind, id: string) => void;

export interface CellPin {
  pinned: boolean;
  onTogglePin: () => void;
}

export function cellPin(
  client: Client,
  kind: SidebarItemKind,
  id: string,
  onPin: PinItem | undefined,
): CellPin | undefined {
  if (!onPin) return undefined;
  return { pinned: isPinnedIn(client, kind, id), onTogglePin: () => onPin(kind, id) };
}
