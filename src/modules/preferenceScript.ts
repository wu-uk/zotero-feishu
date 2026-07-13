import type { FluentMessageId } from "../../typings/i10n";
import { getLocaleID } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  AuthorizationCancelledError,
  MissingAppPermissionsError,
  type AuthorizationProgress,
} from "./feishuDeviceAuth";

type StatusState = "neutral" | "busy" | "success" | "warning" | "error";

interface StatusElements {
  container: HTMLElement;
  title: HTMLElement;
  detail: HTMLElement;
}

export async function registerPrefsScripts(window: Window): Promise<void> {
  addon.data.prefs = { window };
  const document = window.document;
  refreshStylesheet(document);
  await initializeTargetHelp(document);
  const targetFolder = input(document, "zotero-feishu-target-folder");
  const action = button(document, "zotero-feishu-connection-action");
  const status: StatusElements = {
    container: element(document, "zotero-feishu-connection-status"),
    title: element(document, "zotero-feishu-status-title"),
    detail: element(document, "zotero-feishu-status-detail"),
  };
  let authorizationPending = false;

  targetFolder.value = String(getPref("targetFolder") || "");
  await renderConnectionStatus(document, status);
  await renderAction(document, action, authorizationPending);

  bind(action, async () => {
    if (authorizationPending) {
      action.disabled = true;
      addon.sync.oauth.cancelPendingAuthorization();
      return;
    }
    if (addon.sync.oauth.isAuthorized()) {
      addon.sync.oauth.clearAuthorization();
      await renderConnectionStatus(document, status);
      await renderAction(document, action, false);
      return;
    }

    saveTargetFolder(targetFolder.value);
    authorizationPending = true;
    await renderAction(document, action, authorizationPending);
    try {
      await addon.sync.oauth.startAutomaticAuthorization((progress) => {
        void renderProgress(document, status, progress);
      });
      await renderConnectionStatus(document, status);
    } catch (error) {
      await renderAuthorizationError(document, status, error);
    } finally {
      authorizationPending = false;
      action.disabled = false;
      await renderAction(document, action, authorizationPending);
    }
  });

  targetFolder.addEventListener("change", () =>
    saveTargetFolder(targetFolder.value),
  );
  window.addEventListener(
    "unload",
    () => addon.sync.oauth.cancelPendingAuthorization(),
    { once: true },
  );
}

function refreshStylesheet(document: Document): void {
  const stylesheet = document.getElementById("zotero-feishu-preferences-style");
  stylesheet?.setAttribute(
    "href",
    `chrome://${addon.data.config.addonRef}/content/preferences.css?v=${Date.now()}`,
  );
}

async function initializeTargetHelp(document: Document): Promise<void> {
  const placeholder = document.getElementById(
    "zotero-feishu-target-help-placeholder",
  );
  if (!placeholder?.parentNode) return;

  const help = (document as any).createXULElement("label") as HTMLElement;
  help.id = "zotero-feishu-target-help";
  help.setAttribute("class", "help-icon");
  help.setAttribute(
    "value",
    await translate(document, "pref-target-folder-help"),
  );
  help.setAttribute(
    "tooltiptext",
    await translate(document, "pref-target-folder-help-tooltip"),
  );
  help.setAttribute(
    "aria-label",
    await translate(document, "pref-target-folder-help-label"),
  );
  placeholder.parentNode.replaceChild(help, placeholder);
}

async function renderConnectionStatus(
  document: Document,
  status: StatusElements,
): Promise<void> {
  if (!addon.sync.oauth.isAuthorized()) {
    await setStatus(document, status, "neutral", "pref-status-not-connected");
    return;
  }

  await setStatus(document, status, "busy", "pref-status-loading-user");
  try {
    const user = await addon.sync.getCurrentUser();
    await setStatus(
      document,
      status,
      "success",
      "pref-status-connected-user",
      undefined,
      { name: user.name },
    );
  } catch (error) {
    ztoolkit.log("Unable to load the connected Feishu user", error);
    await setStatus(
      document,
      status,
      "warning",
      "pref-status-connected-unknown",
      errorMessage(error),
    );
  }
}

async function renderAction(
  document: Document,
  action: HTMLButtonElement,
  authorizationPending: boolean,
): Promise<void> {
  const mode = authorizationPending
    ? "cancel"
    : addon.sync.oauth.isAuthorized()
      ? "disconnect"
      : "connect";
  action.dataset.mode = mode;
  action.textContent = await translate(document, `pref-${mode}`);
}

async function renderProgress(
  document: Document,
  status: StatusElements,
  progress: AuthorizationProgress,
): Promise<void> {
  const detailId = `pref-status-${progress.phase.replaceAll("_", "-")}`;
  if (progress.phase === "waiting_app_permissions") {
    await setStatus(
      document,
      status,
      "warning",
      "pref-status-permissions-required",
      undefined,
      { scopes: progress.missingScopes?.join(", ") || "" },
      detailId,
    );
    return;
  }
  await setStatus(
    document,
    status,
    progress.phase === "authorized" ? "success" : "busy",
    progress.phase === "authorized"
      ? "pref-status-authorized"
      : "pref-status-connecting",
    undefined,
    undefined,
    detailId,
  );
}

async function renderAuthorizationError(
  document: Document,
  status: StatusElements,
  error: unknown,
): Promise<void> {
  if (error instanceof AuthorizationCancelledError) {
    await setStatus(document, status, "neutral", "pref-status-not-connected");
    return;
  }
  if (error instanceof MissingAppPermissionsError) {
    await setStatus(
      document,
      status,
      "warning",
      "pref-status-permissions-required",
      undefined,
      { scopes: error.missingScopes.join(", ") },
      "pref-status-waiting-app-permissions",
    );
    return;
  }
  ztoolkit.log("Feishu authorization failed", error);
  await setStatus(
    document,
    status,
    "error",
    "pref-status-authorization-failed",
    errorMessage(error),
  );
}

async function setStatus(
  document: Document,
  status: StatusElements,
  state: StatusState,
  titleId: string,
  detailText?: string,
  args?: Record<string, unknown>,
  detailId?: string,
): Promise<void> {
  status.container.dataset.state = state;
  status.container.setAttribute("aria-busy", String(state === "busy"));
  status.title.textContent = await translate(document, titleId, args);
  const detail = detailText
    ? detailText
    : detailId
      ? await translate(document, detailId, args)
      : "";
  status.detail.textContent = detail;
  status.detail.hidden = !detail;
}

function saveTargetFolder(targetFolder: string): void {
  setPref("targetFolder", targetFolder.trim());
}

async function translate(
  document: Document,
  id: string,
  args?: Record<string, unknown>,
): Promise<string> {
  const localization = (document as any).l10n;
  if (!localization?.formatValue) return id;
  const value = await localization.formatValue(
    getLocaleID(id as FluentMessageId),
    args,
  );
  return value || id;
}

function input(document: Document, id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function button(document: Document, id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

function element(document: Document, id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function bind(element: HTMLElement, listener: () => Promise<void>): void {
  if (element.dataset.bound === "true") return;
  element.dataset.bound = "true";
  element.addEventListener("click", () => void listener());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
