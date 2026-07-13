import { assert } from "chai";
import { config } from "../package.json";

const PREFERENCE_PANE_ID = "zotero-feishu-preferences";

describe("preferences", function () {
  this.timeout(10_000);

  it("renders a single connection action without advanced app settings", async function () {
    let preferencesWindow: Window | null = null;
    try {
      Zotero.Utilities.Internal.openPreferences(PREFERENCE_PANE_ID);
      preferencesWindow = await waitForPreferencesWindow();
      const document = preferencesWindow.document;
      const plugin = Zotero[config.addonInstance] as any;
      const action = await waitForElement<HTMLButtonElement>(
        document,
        "zotero-feishu-connection-action",
        (element) =>
          element.dataset.bound === "true" || plugin.data.prefs?.error,
      );
      if (plugin.data.prefs?.error) throw plugin.data.prefs.error;
      const status = document.getElementById(
        "zotero-feishu-connection-status",
      ) as HTMLElement;
      const title = document.getElementById(
        "zotero-feishu-status-title",
      ) as HTMLElement;
      const help = document.getElementById("zotero-feishu-target-help");
      const stylesheet = document.getElementById(
        "zotero-feishu-preferences-style",
      ) as HTMLLinkElement;

      assert.include(["neutral", "success", "warning"], status.dataset.state);
      assert.isNotEmpty(title.textContent);
      assert.isNotEmpty(action.textContent);
      assert.equal(action.parentElement?.className, "status-line");
      assert.equal(
        help?.namespaceURI,
        "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
      );
      assert.equal(help?.getAttribute("value"), "?");
      assert.isNotEmpty(help?.getAttribute("tooltiptext"));
      assert.include(stylesheet.href, "preferences.css?v=");
      assert.equal(
        action.dataset.mode,
        status.dataset.state === "neutral" ? "connect" : "disconnect",
      );
      assert.lengthOf(document.querySelectorAll(".connection-action"), 1);
      assert.lengthOf(
        document.querySelectorAll(".zotero-feishu-preferences button"),
        1,
      );
      assert.notExists(document.getElementById("zotero-feishu-app-id"));
      assert.notExists(document.querySelector(".advanced-settings"));
    } finally {
      try {
        preferencesWindow?.close();
      } catch {
        // The Zotero test runner may close the preferences window first.
      }
    }
  });
});

async function waitForElement<T extends HTMLElement>(
  document: Document,
  id: string,
  ready: (element: T) => boolean,
): Promise<T> {
  let found: T | null = null;
  await waitUntil(() => {
    found = document.getElementById(id) as T | null;
    return Boolean(found && ready(found));
  });
  return found!;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Zotero.Promise.delay(50);
  }
  throw new Error("Timed out waiting for the preferences UI");
}

async function waitForPreferencesWindow(): Promise<Window> {
  const services = (Zotero.getMainWindow() as any).Services;
  let found: Window | null = null;
  await waitUntil(() => {
    found = services.wm.getMostRecentWindow("zotero:pref") as Window | null;
    return Boolean(found);
  });
  return found!;
}
