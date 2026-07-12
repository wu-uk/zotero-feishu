import { getPref, setPref } from "../utils/prefs";
import { OAUTH_REDIRECT_URI } from "./oauthService";

export async function registerPrefsScripts(window: Window): Promise<void> {
  addon.data.prefs = { window };
  const document = window.document;
  const appId = input(document, "zotero-feishu-app-id");
  const appSecret = input(document, "zotero-feishu-app-secret");
  const targetFolder = input(document, "zotero-feishu-target-folder");
  const redirect = input(document, "zotero-feishu-redirect-uri");
  const status = document.getElementById("zotero-feishu-status") as HTMLElement;

  appId.value = String(getPref("appId") || "");
  targetFolder.value = String(getPref("targetFolder") || "");
  redirect.value = OAUTH_REDIRECT_URI;
  renderStatus(status);

  bind(document, "zotero-feishu-authorize", async () => {
    savePreferences(appId.value, targetFolder.value);
    try {
      await addon.sync.oauth.authorize(appId.value, appSecret.value);
      status.textContent = "Authorization opened in your browser";
    } catch (error) {
      status.textContent = errorMessage(error);
    }
  });

  bind(document, "zotero-feishu-test", async () => {
    savePreferences(appId.value, targetFolder.value);
    status.textContent = "Testing...";
    try {
      await addon.sync.testConnection();
      status.textContent = "Connected";
    } catch (error) {
      status.textContent = errorMessage(error);
    }
  });

  bind(document, "zotero-feishu-logout", async () => {
    addon.sync.oauth.clearAuthorization();
    appSecret.value = "";
    renderStatus(status);
  });

  appId.addEventListener("change", () =>
    savePreferences(appId.value, targetFolder.value),
  );
  targetFolder.addEventListener("change", () =>
    savePreferences(appId.value, targetFolder.value),
  );
}

function savePreferences(appId: string, targetFolder: string): void {
  setPref("appId", appId.trim());
  setPref("targetFolder", targetFolder.trim());
}

function renderStatus(status: HTMLElement): void {
  status.textContent = addon.sync.oauth.isAuthorized()
    ? "Authorized"
    : "Not authorized";
}

function input(document: Document, id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function bind(
  document: Document,
  id: string,
  listener: () => Promise<void>,
): void {
  const element = document.getElementById(id) as HTMLElement;
  if (element.dataset.bound === "true") return;
  element.dataset.bound = "true";
  element.addEventListener("click", () => void listener());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
