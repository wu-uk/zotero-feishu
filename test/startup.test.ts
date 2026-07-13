import { assert } from "chai";
import { config, version } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("registers exactly one Feishu preferences pane", function () {
    const plugin = Zotero[config.addonInstance] as any;
    const panes = Zotero.PreferencePanes.pluginPanes.filter(
      (pane) => pane.pluginID === config.addonID,
    );

    assert.lengthOf(panes, 1);
    assert.equal(panes[0].id, "zotero-feishu-preferences");
    assert.equal(plugin.data.preferencePaneID, panes[0].id);
  });

  it("registers the Feishu sync status column", function () {
    const plugin = Zotero[config.addonInstance] as any;
    assert.isTrue(plugin.syncStatus.isRegistered);
    assert.isTrue(
      Zotero.ItemTreeManager.isCustomColumn(
        Zotero.getMainWindow().CSS.escape(`${config.addonID}-syncStatus`),
      ),
    );
  });

  it("registers Feishu menus through the official menu manager", function () {
    const plugin = Zotero[config.addonInstance] as any;
    assert.lengthOf(plugin.data.menuIDs, 2);
    assert.match(plugin.data.menuIDs[0], /zotero-feishu-item-menu$/);
    assert.match(plugin.data.menuIDs[1], /zotero-feishu-collection-menu$/);
    assert.notEqual(plugin.data.menuIDs[0], plugin.data.menuIDs[1]);
  });

  it("loads the versioned item-tree stylesheet", function () {
    const link = Zotero.getMainWindow().document.getElementById(
      "zotero-feishu-sync-status-style",
    ) as HTMLLinkElement;
    assert.exists(link);
    assert.include(link.href, `zoteroPane.css?v=${version}`);
  });
});
