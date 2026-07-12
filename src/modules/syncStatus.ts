import { getString } from "../utils/locale";
import type { SyncResult } from "./types";
import { version } from "../../package.json";

type SyncStatusKind = "syncing" | "success" | "failed";

interface SyncStatusEntry {
  kind: SyncStatusKind;
  tooltip: string;
  itemID: number;
}

const STYLE_ID = "zotero-feishu-sync-status-style";

export class SyncStatusService {
  private readonly entries = new Map<string, SyncStatusEntry>();
  private registeredDataKey?: string;

  get isRegistered(): boolean {
    return Boolean(
      this.registeredDataKey &&
      Zotero.ItemTreeManager.isCustomColumn(this.registeredDataKey),
    );
  }

  register(): void {
    if (this.registeredDataKey) return;
    const namespacedDataKey = statusColumnDataKey();
    if (Zotero.ItemTreeManager.isCustomColumn(namespacedDataKey)) {
      Zotero.ItemTreeManager.unregisterColumn(namespacedDataKey);
    }
    const dataKey = Zotero.ItemTreeManager.registerColumn({
      dataKey: "syncStatus",
      label: getString("sync-status-column"),
      pluginID: addon.data.config.addonID,
      enabledTreeIDs: ["main"],
      defaultIn: ["default"],
      flex: 0,
      width: "34",
      minWidth: 34,
      fixedWidth: true,
      staticWidth: true,
      iconPath: `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`,
      showInColumnPicker: true,
      dataProvider: (item) => this.cellData(item),
      renderCell: (index, data, column, _isFirstColumn, doc) =>
        this.renderCell(index, data, column.className, doc),
      zoteroPersist: ["hidden"],
    });
    if (!dataKey)
      throw new Error("Unable to register Feishu sync status column");
    this.registeredDataKey = dataKey;
  }

  unregister(): void {
    if (this.registeredDataKey) {
      Zotero.ItemTreeManager.unregisterColumn(this.registeredDataKey);
      this.registeredDataKey = undefined;
    }
    this.entries.clear();
  }

  registerWindow(win: Window): void {
    const doc = win.document;
    doc.getElementById(STYLE_ID)?.remove();
    const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
    link.id = STYLE_ID;
    link.setAttribute("rel", "stylesheet");
    link.setAttribute(
      "href",
      `chrome://${addon.data.config.addonRef}/content/zoteroPane.css?v=${encodeURIComponent(version)}`,
    );
    doc.documentElement?.appendChild(link);
  }

  unregisterWindow(win: Window): void {
    win.document.getElementById(STYLE_ID)?.remove();
  }

  markSyncing(items: Zotero.Item[]): void {
    for (const item of items) {
      this.entries.set(statusKey(item.libraryID, item.key), {
        kind: "syncing",
        tooltip: getString("sync-status-syncing"),
        itemID: item.id,
      });
    }
    refreshItems(items.map((item) => item.id));
  }

  markResult(result: SyncResult): void {
    const key = statusKey(result.libraryID, result.itemKey);
    const current = this.entries.get(key);
    const item = current
      ? undefined
      : Zotero.Items.getByLibraryAndKey(result.libraryID, result.itemKey);
    const itemID = current?.itemID || (item ? item.id : undefined);
    if (!itemID) return;
    const kind = statusKindForResult(result);
    this.entries.set(key, {
      kind,
      tooltip:
        kind === "failed"
          ? getString("sync-status-failed", {
              args: {
                error:
                  result.errors.join("\n") ||
                  getString("sync-status-failed-generic"),
              },
            })
          : getString("sync-status-success", {
              args: { outcome: outcomeLabel(result.outcome) },
            }),
      itemID,
    });
    refreshItems([itemID]);
  }

  markFailed(items: Zotero.Item[], error: string): void {
    for (const item of items) {
      this.entries.set(statusKey(item.libraryID, item.key), {
        kind: "failed",
        tooltip: getString("sync-status-failed", { args: { error } }),
        itemID: item.id,
      });
    }
    refreshItems(items.map((item) => item.id));
  }

  private cellData(item: Zotero.Item): string {
    const entry = this.entries.get(statusKey(item.libraryID, item.key));
    return entry?.kind || "";
  }

  private renderCell(
    index: number,
    data: string,
    columnClassName: string,
    doc: Document,
  ): HTMLElement {
    const view = (doc.defaultView as any)?.ZoteroPane?.itemsView;
    const item = view?.getRow?.(index)?.ref as Zotero.Item | undefined;
    const entry = item
      ? this.entries.get(statusKey(item.libraryID, item.key))
      : undefined;
    return renderStatusCell(
      data,
      columnClassName,
      doc,
      entry?.tooltip || defaultTooltip(data),
    );
  }
}

export function statusKindForResult(result: SyncResult): "success" | "failed" {
  return result.outcome === "failed" || result.errors.length
    ? "failed"
    : "success";
}

function statusKey(libraryID: number, itemKey: string): string {
  return `${libraryID}:${itemKey}`;
}

function statusColumnDataKey(): string {
  const css = (Zotero.getMainWindow() as any).CSS as typeof CSS;
  return css.escape(`${addon.data.config.addonID}-syncStatus`);
}

function outcomeLabel(outcome: SyncResult["outcome"]): string {
  switch (outcome) {
    case "created":
      return getString("sync-outcome-created");
    case "updated":
      return getString("sync-outcome-updated");
    case "unchanged":
      return getString("sync-outcome-unchanged");
    case "partial":
      return getString("sync-outcome-partial");
    case "failed":
      return getString("sync-outcome-failed");
  }
}

export function renderStatusCell(
  data: string,
  columnClassName: string,
  doc: Document,
  tooltip = "",
): HTMLElement {
  const cell = doc.createElement("span");
  cell.className = `cell ${columnClassName} zotero-feishu-sync-cell`;
  if (!isSyncStatusKind(data)) return cell;

  cell.title = tooltip;
  const indicator = doc.createElement("span");
  indicator.className = `zotero-feishu-sync-indicator is-${data}`;
  indicator.setAttribute("role", "img");
  indicator.setAttribute("aria-label", tooltip);
  if (data === "success") indicator.textContent = "✓";
  if (data === "failed") indicator.textContent = "×";
  cell.appendChild(indicator);
  return cell;
}

function isSyncStatusKind(value: string): value is SyncStatusKind {
  return value === "syncing" || value === "success" || value === "failed";
}

function defaultTooltip(kind: string): string {
  if (kind === "syncing") return getString("sync-status-syncing");
  if (kind === "failed") return getString("sync-status-failed-generic");
  return "";
}

function refreshItems(itemIDs: number[]): void {
  const ids = new Set(itemIDs);
  for (const win of Zotero.getMainWindows()) {
    const view = (win as any).ZoteroPane?.itemsView as any;
    if (!view?.tree) continue;
    for (const id of ids) {
      if (view._rowCache) delete view._rowCache[id];
      const row = view._rowMap?.[id];
      if (row !== undefined) view.tree.invalidateRow(row);
    }
  }
}
