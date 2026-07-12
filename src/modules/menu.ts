import { getString } from "../utils/locale";
import type { SyncResult } from "./types";

export function registerMenus(win: _ZoteroTypes.MainWindow): void {
  const icon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;
  ztoolkit.Menu.register("item", {
    tag: "menu",
    id: "zotero-feishu-item-menu",
    label: getString("menu-root"),
    icon,
    children: [
      {
        tag: "menuitem",
        label: getString("menu-sync-selected"),
        commandListener: () => void syncItems(selectedItems()),
      },
      {
        tag: "menuitem",
        label: getString("menu-open-document"),
        commandListener: () => void openSelected(win),
      },
      { tag: "menuseparator" },
      {
        tag: "menuitem",
        label: getString("menu-delete-document"),
        commandListener: () => void deleteSelected(win),
      },
    ],
  });

  ztoolkit.Menu.register("collection" as any, {
    tag: "menuitem",
    id: "zotero-feishu-collection-sync",
    label: getString("menu-sync-collection"),
    icon,
    commandListener: () => {
      const collection = ztoolkit
        .getGlobal("ZoteroPane")
        .getSelectedCollection();
      if (collection) void syncItems(collection.getChildItems());
    },
  });
}

function selectedItems(): Zotero.Item[] {
  return ztoolkit.getGlobal("ZoteroPane").getSelectedItems();
}

async function syncItems(items: Zotero.Item[]): Promise<void> {
  const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-starting"), progress: 0 })
    .show();
  try {
    const results = await addon.sync.syncItems(
      items,
      (completed, total, result) => {
        progress.changeLine({
          text: `${completed}/${total} ${result.title}`,
          progress: total ? Math.round((completed / total) * 100) : 100,
          type: result.outcome === "failed" ? "fail" : "success",
        });
      },
    );
    progress.changeLine({
      text: summarize(results),
      progress: 100,
      type: results.some((result) => result.outcome === "failed")
        ? "fail"
        : "success",
    });
    progress.startCloseTimer(8000);
    if (results.some((result) => result.errors.length)) {
      showErrorDialog(results);
    }
  } catch (error) {
    progress.changeLine({
      text: errorMessage(error),
      progress: 100,
      type: "fail",
    });
  }
}

function showErrorDialog(results: SyncResult[]): void {
  const details = results
    .filter((result) => result.errors.length)
    .map(
      (result) =>
        `${result.title}\n${result.errors.map((error) => `- ${error}`).join("\n")}`,
    )
    .join("\n\n");
  new ztoolkit.Dialog(1, 1)
    .addCell(
      0,
      0,
      {
        tag: "textarea",
        namespace: "html",
        attributes: { readonly: true, "aria-label": "Sync errors" },
        properties: { value: details },
        styles: {
          width: "640px",
          height: "300px",
          resize: "both",
          fontFamily: "monospace",
          whiteSpace: "pre-wrap",
        },
      },
      false,
    )
    .addButton("Close", "close")
    .open("Zotero Feishu Sync - Errors", {
      width: 700,
      height: 400,
      centerscreen: true,
      resizable: true,
    });
}

async function openSelected(win: Window): Promise<void> {
  const [item, ...rest] = selectedItems();
  if (!item || rest.length || !(await addon.sync.openItem(item))) {
    win.alert(getString("error-select-one-mapped"));
  }
}

async function deleteSelected(win: Window): Promise<void> {
  const [item, ...rest] = selectedItems();
  if (!item || rest.length) {
    win.alert(getString("error-select-one-mapped"));
    return;
  }
  const title = String(item.getField("title") || item.key);
  if (!win.confirm(getString("delete-confirm", { args: { title } }))) return;
  try {
    const deleted = await addon.sync.deleteItem(item);
    win.alert(
      deleted
        ? getString("delete-success")
        : getString("error-select-one-mapped"),
    );
  } catch (error) {
    win.alert(errorMessage(error));
  }
}

function summarize(results: SyncResult[]): string {
  const counts = new Map<string, number>();
  results.forEach((result) =>
    counts.set(result.outcome, (counts.get(result.outcome) || 0) + 1),
  );
  if (!results.length) return getString("sync-no-items");
  const summary = ["created", "updated", "unchanged", "partial", "failed"]
    .map((key) => `${key}: ${counts.get(key) || 0}`)
    .join(" | ");
  const firstError = results.find((result) => result.errors.length)?.errors[0];
  return firstError ? `${summary} | ${firstError}` : summary;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
