import { getLocaleID, getString } from "../utils/locale";
import { uniqueRegularUserItems } from "./syncService";
import type { SyncResult } from "./types";

const ITEM_MENU_ID = "zotero-feishu-item-menu";
const COLLECTION_MENU_ID = "zotero-feishu-collection-menu";

export function registerMenus(): void {
  if (addon.data.menuIDs?.length) return;
  const icon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;
  Zotero.MenuManager.unregisterMenu(ITEM_MENU_ID);
  Zotero.MenuManager.unregisterMenu(COLLECTION_MENU_ID);

  const itemMenu = Zotero.MenuManager.registerMenu({
    menuID: ITEM_MENU_ID,
    pluginID: addon.data.config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "submenu",
        l10nID: getLocaleID("menu-root"),
        icon,
        onShowing: (_event, context) => {
          context.setVisible(
            Boolean(uniqueRegularUserItems(context.items || []).length),
          );
        },
        menus: [
          {
            menuType: "menuitem",
            l10nID: getLocaleID("menu-sync-selected"),
            onCommand: (_event, context) => void syncItems(context.items || []),
          },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("menu-open-document"),
            onCommand: (_event, context) =>
              void openSelected(menuWindow(context), context.items || []),
          },
          { menuType: "separator" },
          {
            menuType: "menuitem",
            l10nID: getLocaleID("menu-delete-document"),
            onCommand: (_event, context) =>
              void deleteSelected(menuWindow(context), context.items || []),
          },
        ],
      },
    ],
  });
  const collectionMenu = Zotero.MenuManager.registerMenu({
    menuID: COLLECTION_MENU_ID,
    pluginID: addon.data.config.addonID,
    target: "main/library/collection",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-sync-collection"),
        icon,
        onShowing: (_event, context) => {
          context.setVisible(Boolean(selectedCollection(context)));
        },
        onCommand: (_event, context) => {
          const collection = selectedCollection(context);
          if (collection) void syncItems(collection.getChildItems());
        },
      },
    ],
  });

  if (!itemMenu || !collectionMenu) {
    if (itemMenu) Zotero.MenuManager.unregisterMenu(itemMenu);
    if (collectionMenu) Zotero.MenuManager.unregisterMenu(collectionMenu);
    throw new Error("Unable to register Feishu menus");
  }
  addon.data.menuIDs = [itemMenu, collectionMenu];
}

export function unregisterMenus(): void {
  for (const menuID of addon.data.menuIDs || []) {
    Zotero.MenuManager.unregisterMenu(menuID);
  }
  addon.data.menuIDs = [];
}

function menuWindow(context: { menuElem: XULElement }): Window {
  return (
    (context.menuElem.ownerDocument?.defaultView as Window | null) ||
    Zotero.getMainWindow()
  );
}

function selectedCollection(context: {
  collectionTreeRow?: any;
}): Zotero.Collection | undefined {
  const row = context.collectionTreeRow as Zotero.CollectionTreeRow | undefined;
  if (!row?.isCollection()) return undefined;
  const collection = row.ref as Zotero.Collection;
  return collection.libraryID === Zotero.Libraries.userLibraryID
    ? collection
    : undefined;
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

async function openSelected(win: Window, items: Zotero.Item[]): Promise<void> {
  const [item, ...rest] = items;
  if (!item || rest.length || !(await addon.sync.openItem(item))) {
    win.alert(getString("error-select-one-mapped"));
  }
}

async function deleteSelected(
  win: Window,
  items: Zotero.Item[],
): Promise<void> {
  const [item, ...rest] = items;
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
