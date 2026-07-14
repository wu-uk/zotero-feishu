import { getLocaleID, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { registerMenus, unregisterMenus } from "./modules/menu";

const preferencePaneID = "zotero-feishu-preferences";

function unregisterPreferencePane(): void {
  const paneIDs = Zotero.PreferencePanes.pluginPanes
    .filter((pane) => pane.pluginID === addon.data.config.addonID)
    .map((pane) => pane.id)
    .filter((id): id is string => Boolean(id));

  if (
    addon.data.preferencePaneID &&
    !paneIDs.includes(addon.data.preferencePaneID)
  ) {
    paneIDs.push(addon.data.preferencePaneID);
  }

  for (const paneID of paneIDs) {
    Zotero.PreferencePanes.unregister(paneID);
  }
  addon.data.preferencePaneID = undefined;
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  unregisterPreferencePane();
  addon.data.preferencePaneID = await Zotero.PreferencePanes.register({
    id: preferencePaneID,
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: addon.data.config.addonName,
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
  addon.syncStatus.register();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
  registerMenus(win);
  addon.syncStatus.registerWindow(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterMenus(win);
  addon.syncStatus.unregisterWindow(win);
}

function onShutdown(): void {
  unregisterPreferencePane();
  addon.sync.unregister();
  addon.syncStatus.unregister();
  unregisterMenus();
  for (const win of Zotero.getMainWindows()) {
    addon.syncStatus.unregisterWindow(win);
  }
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(type: string, data: { window: Window }) {
  if (type !== "load") return;
  try {
    await registerPrefsScripts(data.window);
  } catch (error) {
    addon.data.prefs = { window: data.window, error };
    const document = data.window.document;
    const container = document.getElementById(
      "zotero-feishu-connection-status",
    );
    const title = document.getElementById("zotero-feishu-status-title");
    const detail = document.getElementById("zotero-feishu-status-detail");
    if (container) container.setAttribute("data-state", "error");
    if (title) {
      const localization = (document as any).l10n;
      title.textContent = localization?.formatValue
        ? await localization.formatValue(
            getLocaleID("pref-status-initialization-failed"),
          )
        : "Unable to initialize Feishu settings";
    }
    if (detail) detail.textContent = errorMessage(error);
    ztoolkit.log("Unable to initialize Feishu settings", error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
