import { getPref } from "../utils/prefs";
import { buildDocument } from "./documentBuilder";
import { FeishuClient, FeishuError } from "./feishuClient";
import { OAuthService } from "./oauthService";
import { StateStore } from "./stateStore";
import type { SyncResult } from "./types";

export type ProgressCallback = (
  completed: number,
  total: number,
  result: SyncResult,
) => void;

export class SyncService {
  readonly oauth = new OAuthService();
  readonly state = new StateStore();
  readonly client = new FeishuClient(this.oauth);

  register(): void {
    this.oauth.registerCallback();
  }

  unregister(): void {
    this.oauth.unregisterCallback();
  }

  async syncItems(
    input: Zotero.Item[],
    onProgress?: ProgressCallback,
  ): Promise<SyncResult[]> {
    const items = uniqueRegularUserItems(input);
    const results: SyncResult[] = [];
    for (const item of items) {
      const result = await this.syncItem(item);
      results.push(result);
      onProgress?.(results.length, items.length, result);
    }
    return results;
  }

  async syncItem(item: Zotero.Item): Promise<SyncResult> {
    const title = String(item.getField("title") || "Untitled");
    const base: SyncResult = {
      libraryID: item.libraryID,
      itemKey: item.key,
      title,
      outcome: "failed",
      errors: [],
    };
    try {
      assertSupportedItem(item);
      const folder = configuredFolder();
      const model = await buildDocument(item);
      let record = await this.state.get(item.libraryID, item.key);
      if (record?.sourceHash === model.sourceHash) {
        return {
          ...base,
          outcome: "unchanged",
          documentUrl: record.documentUrl,
        };
      }

      let created = false;
      if (record && !(await this.client.documentExists(record.documentId))) {
        record = undefined;
      }
      if (!record) {
        const document = await this.client.createDocument(model.title, folder);
        created = true;
        record = {
          libraryID: item.libraryID,
          itemKey: item.key,
          documentId: document.documentId,
          documentUrl: document.documentUrl,
          sourceHash: "",
          lastSyncedAt: "",
        };
        await this.state.set(record);
      }

      const errors = await this.client.replaceDocument(
        record.documentId,
        model.blocks,
        (key) => resolveEmbeddedImage(item.libraryID, key),
      );
      record.sourceHash = model.sourceHash;
      record.lastSyncedAt = new Date().toISOString();
      await this.state.set(record);
      return {
        ...base,
        outcome: errors.length ? "partial" : created ? "created" : "updated",
        documentUrl: record.documentUrl,
        errors,
      };
    } catch (error) {
      ztoolkit.log("Feishu sync failed", item.key, error);
      return { ...base, errors: [errorMessage(error)] };
    }
  }

  async deleteItem(item: Zotero.Item): Promise<boolean> {
    const record = await this.state.get(item.libraryID, item.key);
    if (!record) return false;
    try {
      await this.client.deleteDocument(record.documentId);
    } catch (error) {
      if (!(error instanceof FeishuError && error.status === 404)) throw error;
    }
    await this.state.delete(item.libraryID, item.key);
    return true;
  }

  async openItem(item: Zotero.Item): Promise<boolean> {
    const record = await this.state.get(item.libraryID, item.key);
    if (!record) return false;
    Zotero.launchURL(record.documentUrl);
    return true;
  }

  async testConnection(): Promise<void> {
    await this.client.testConnection(configuredFolder());
  }
}

export function uniqueRegularUserItems(items: Zotero.Item[]): Zotero.Item[] {
  const userLibraryID = Zotero.Libraries.userLibraryID;
  const seen = new Set<string>();
  const resolved: Zotero.Item[] = [];
  items.forEach((selectedItem) => {
    const item = selectedItem.topLevelItem;
    if (!item.isRegularItem() || item.libraryID !== userLibraryID) return false;
    const key = `${item.libraryID}:${item.key}`;
    if (seen.has(key)) return;
    seen.add(key);
    resolved.push(item);
  });
  return resolved;
}

function assertSupportedItem(item: Zotero.Item): void {
  if (!item.isRegularItem())
    throw new Error("Only regular Zotero items can sync");
  if (item.libraryID !== Zotero.Libraries.userLibraryID) {
    throw new Error("Group libraries are not supported in this version");
  }
}

function configuredFolder(): string {
  return String(getPref("targetFolder") || "").trim();
}

async function resolveEmbeddedImage(
  libraryID: number,
  attachmentKey: string,
): Promise<string> {
  if (!attachmentKey)
    throw new Error("Zotero note image has no attachment key");
  const attachment = Zotero.Items.getByLibraryAndKey(libraryID, attachmentKey);
  if (!attachment || !attachment.isAttachment()) {
    throw new Error(`Zotero attachment ${attachmentKey} was not found`);
  }
  const path = await attachment.getFilePathAsync();
  if (!path)
    throw new Error(`Zotero attachment ${attachmentKey} is unavailable`);
  return path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
