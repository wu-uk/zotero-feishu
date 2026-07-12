import { assert } from "chai";
import { config } from "../package.json";
import {
  renderStatusCell,
  statusKindForResult,
} from "../src/modules/syncStatus";
import type { SyncResult } from "../src/modules/types";

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    libraryID: 1,
    itemKey: "ABC123",
    title: "Example",
    outcome: "updated",
    errors: [],
    ...overrides,
  };
}

describe("sync status", function () {
  it("marks completed items without errors as successful", function () {
    assert.equal(statusKindForResult(result()), "success");
    assert.equal(
      statusKindForResult(result({ outcome: "unchanged" })),
      "success",
    );
  });

  it("marks failed and partial results with errors as failed", function () {
    assert.equal(statusKindForResult(result({ outcome: "failed" })), "failed");
    assert.equal(
      statusKindForResult(
        result({ outcome: "partial", errors: ["Image upload failed"] }),
      ),
      "failed",
    );
  });

  it("renders an accessible status indicator", function () {
    const cell = renderStatusCell(
      "success",
      "sync-status",
      Zotero.getMainWindow().document,
      "Synced",
    );
    const indicator = cell.querySelector(".is-success");
    assert.equal(cell.title, "Synced");
    assert.equal(indicator?.textContent, "✓");
    assert.equal(indicator?.getAttribute("role"), "img");
    assert.equal(indicator?.getAttribute("aria-label"), "Synced");
  });

  it("runs the renderer registered with Zotero ItemTreeManager", function () {
    const plugin = Zotero[config.addonInstance] as any;
    const service = plugin.syncStatus as any;
    const item = {
      id: -1,
      libraryID: Zotero.Libraries.userLibraryID,
      key: "STATUS_RENDER_TEST",
    } as Zotero.Item;
    service.markSyncing([item]);

    const options = (Zotero.ItemTreeManager as any)._columnManager
      ._optionsCache[service.registeredDataKey];
    const data = options.dataProvider(item, service.registeredDataKey);
    const win = Zotero.getMainWindow() as any;
    const view = win.ZoteroPane.itemsView;
    const originalGetRow = view.getRow;
    view.getRow = () => ({ ref: item });
    let cell: HTMLElement;
    try {
      cell = options.renderCell(
        0,
        data,
        { ...options, className: "sync-status" },
        false,
        win.document,
      );
    } finally {
      view.getRow = originalGetRow;
    }
    assert.equal(data, "syncing");
    assert.exists(cell.querySelector(".is-syncing"));
  });
});
