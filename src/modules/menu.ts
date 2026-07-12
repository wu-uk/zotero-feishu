import { getString } from "../utils/locale";
import { uniqueRegularUserItems } from "./syncService";
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
  const syncableItems = uniqueRegularUserItems(items);
  addon.syncStatus.markSyncing(syncableItems);
  try {
    const results = await addon.sync.syncItems(
      syncableItems,
      (_completed, _total, result) => {
        addon.syncStatus.markResult(result);
      },
    );
    if (results.some((result) => result.errors.length)) {
      showErrorDialog(results);
    }
  } catch (error) {
    addon.syncStatus.markFailed(syncableItems, errorMessage(error));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
