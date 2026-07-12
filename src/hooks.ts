import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { registerMenus } from "./modules/menu";

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
  addon.sync.register();
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
  addon.syncStatus.unregisterWindow(win);
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  unregisterPreferencePane();
  addon.sync.unregister();
  addon.syncStatus.unregister();
  for (const win of Zotero.getMainWindows()) {
    addon.syncStatus.unregisterWindow(win);
  }
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(type: string, data: { window: Window }) {
  if (type === "load") await registerPrefsScripts(data.window);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
