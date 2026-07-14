import { getString } from "../utils/locale";
import { uniqueRegularUserItems } from "./syncService";
import type { SyncResult } from "./types";

const ITEM_MENU_ID = "zotero-feishu-item-menu";
const ITEM_SEPARATOR_ID = "zotero-feishu-item-menu-separator";
const COLLECTION_MENU_ID = "zotero-feishu-collection-menu";
const COLLECTION_SEPARATOR_ID = "zotero-feishu-collection-menu-separator";
const menuCleanups = new Map<Window, () => void>();
type MenuLocaleKey =
  | "menu-root"
  | "menu-sync-selected"
  | "menu-sync-collection"
  | "menu-open-document"
  | "menu-delete-document";

export function registerMenus(win: _ZoteroTypes.MainWindow): void {
  unregisterMenus(win);
  const document = win.document;
  const itemPopup = document.getElementById(
    "zotero-itemmenu",
  ) as XULPopupElement | null;
  const collectionPopup = document.getElementById(
    "zotero-collectionmenu",
  ) as XULPopupElement | null;
  if (!itemPopup || !collectionPopup) {
    throw new Error("Unable to find Zotero library menus");
  }

  const icon = `${rootURI}content/icons/favicon@0.5x.png`;
  const itemSeparator = createSeparator(document, ITEM_SEPARATOR_ID);
  const itemMenu = createItemMenu(win, icon);
  const collectionSeparator = createSeparator(
    document,
    COLLECTION_SEPARATOR_ID,
  );
  const collectionMenu = createCollectionMenu(win, icon);

  const updateItemMenu = (event: Event) => {
    if (event.target !== itemPopup) return;
    const visible = Boolean(uniqueRegularUserItems(selectedItems(win)).length);
    itemMenu.hidden = !visible;
    itemSeparator.hidden = !visible;
  };
  const updateCollectionMenu = (event: Event) => {
    if (event.target !== collectionPopup) return;
    const visible = Boolean(selectedCollection(win));
    collectionMenu.hidden = !visible;
    collectionSeparator.hidden = !visible;
  };

  itemPopup.addEventListener("popupshowing", updateItemMenu);
  collectionPopup.addEventListener("popupshowing", updateCollectionMenu);
  itemPopup.append(itemSeparator, itemMenu);
  collectionPopup.append(collectionSeparator, collectionMenu);

  menuCleanups.set(win, () => {
    itemPopup.removeEventListener("popupshowing", updateItemMenu);
    collectionPopup.removeEventListener("popupshowing", updateCollectionMenu);
    itemSeparator.remove();
    itemMenu.remove();
    collectionSeparator.remove();
    collectionMenu.remove();
  });
}

export function unregisterMenus(win?: Window): void {
  if (win) {
    menuCleanups.get(win)?.();
    menuCleanups.delete(win);
    removeStaleMenuElements(win.document);
    return;
  }
  for (const menuWindow of [...menuCleanups.keys()]) {
    unregisterMenus(menuWindow);
  }
}

function createItemMenu(win: Window, icon: string): XULMenuElement {
  const document = win.document;
  const menu = document.createXULElement("menu") as XULMenuElement;
  menu.id = ITEM_MENU_ID;
  menu.classList.add("menu-iconic");
  menu.setAttribute("label", getString("menu-root"));
  menu.setAttribute("image", icon);

  const popup = document.createXULElement("menupopup") as XULPopupElement;
  popup.append(
    createMenuItem(document, "menu-sync-selected", () => {
      void syncItems(selectedItems(win));
    }),
    createMenuItem(document, "menu-open-document", () => {
      void openSelected(win, selectedItems(win));
    }),
    document.createXULElement("menuseparator"),
    createMenuItem(document, "menu-delete-document", () => {
      void deleteSelected(win, selectedItems(win));
    }),
  );
  menu.appendChild(popup);
  return menu;
}

function createCollectionMenu(win: Window, icon: string): XULElement {
  const menu = createMenuItem(win.document, "menu-sync-collection", () => {
    const collection = selectedCollection(win);
    if (collection) void syncItems(collection.getChildItems());
  });
  menu.id = COLLECTION_MENU_ID;
  menu.classList.add("menuitem-iconic");
  menu.setAttribute("image", icon);
  return menu;
}

function createMenuItem(
  document: Document,
  localeKey: MenuLocaleKey,
  command: () => void,
): XULElement {
  const item = document.createXULElement("menuitem") as XULElement;
  item.setAttribute("label", getString(localeKey));
  item.addEventListener("command", command);
  return item;
}

function createSeparator(document: Document, id: string): XULElement {
  const separator = document.createXULElement("menuseparator") as XULElement;
  separator.id = id;
  return separator;
}

function selectedItems(win: Window): Zotero.Item[] {
  return (win as _ZoteroTypes.MainWindow).ZoteroPane.getSelectedItems();
}

function selectedCollection(win: Window): Zotero.Collection | undefined {
  const collection = (
    win as _ZoteroTypes.MainWindow
  ).ZoteroPane.getSelectedCollection();
  if (!collection) return undefined;
  return collection.libraryID === Zotero.Libraries.userLibraryID
    ? collection
    : undefined;
}

function removeStaleMenuElements(document: Document): void {
  for (const id of [
    ITEM_MENU_ID,
    ITEM_SEPARATOR_ID,
    COLLECTION_MENU_ID,
    COLLECTION_SEPARATOR_ID,
  ]) {
    document.getElementById(id)?.remove();
  }
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
