import { getPref } from "../utils/prefs";
import { buildDocument } from "./documentBuilder";
import {
  FeishuClient,
  FeishuError,
  type CreatedDocument,
} from "./feishuClient";
import { OAuthService } from "./oauthService";
import { StateStore } from "./stateStore";
import type {
  DocumentModel,
  FeishuUser,
  RichBlock,
  SyncRecord,
  SyncResult,
} from "./types";

export type ProgressCallback = (
  completed: number,
  total: number,
  result: SyncResult,
) => void;

export interface SyncStateRepository {
  get(libraryID: number, itemKey: string): Promise<SyncRecord | undefined>;
  set(record: SyncRecord): Promise<void>;
  delete(libraryID: number, itemKey: string): Promise<void>;
}

export interface SyncClient {
  getCurrentUser(): Promise<FeishuUser>;
  testConnection(folderToken: string): Promise<void>;
  createDocument(title: string, folderToken: string): Promise<CreatedDocument>;
  documentExists(documentId: string): Promise<boolean>;
  replaceDocument(
    documentId: string,
    blocks: RichBlock[],
    resolveAttachment: (attachmentKey: string) => Promise<string>,
  ): Promise<string[]>;
  deleteDocument(documentId: string): Promise<void>;
}

export interface SyncServiceDependencies {
  oauth?: OAuthService;
  state?: SyncStateRepository;
  client?: SyncClient;
  buildDocument?: (item: Zotero.Item) => Promise<DocumentModel>;
}

export class SyncService {
  readonly oauth: OAuthService;
  readonly state: SyncStateRepository;
  readonly client: SyncClient;
  private readonly documentBuilder: (
    item: Zotero.Item,
  ) => Promise<DocumentModel>;
  private readonly itemOperations = new Map<string, Promise<void>>();

  constructor(dependencies: SyncServiceDependencies = {}) {
    this.oauth = dependencies.oauth || new OAuthService();
    this.state = dependencies.state || new StateStore();
    this.client = dependencies.client || new FeishuClient(this.oauth);
    this.documentBuilder = dependencies.buildDocument || buildDocument;
  }

  unregister(): void {
    this.oauth.cancelPendingAuthorization();
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
    return this.withItemOperation(item, () => this.performSyncItem(item));
  }

  private async performSyncItem(item: Zotero.Item): Promise<SyncResult> {
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
      const model = await this.documentBuilder(item);
      let record = await this.state.get(item.libraryID, item.key);
      if (record && !(await this.client.documentExists(record.documentId))) {
        record = undefined;
      }
      if (record?.sourceHash === model.sourceHash) {
        return {
          ...base,
          outcome: "unchanged",
          documentUrl: record.documentUrl,
        };
      }

      let created = false;
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
        (key) => resolveAttachment(item.libraryID, key),
      );
      record.sourceHash = errors.length ? "" : model.sourceHash;
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
    return this.withItemOperation(item, () => this.performDeleteItem(item));
  }

  private async performDeleteItem(item: Zotero.Item): Promise<boolean> {
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

  private async withItemOperation<T>(
    item: Zotero.Item,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${item.libraryID}:${item.key}`;
    const previous = this.itemOperations.get(key) || Promise.resolve();
    const current = previous.then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.itemOperations.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.itemOperations.get(key) === tail) {
        this.itemOperations.delete(key);
      }
    }
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

  async getCurrentUser(): Promise<FeishuUser> {
    return this.client.getCurrentUser();
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

async function resolveAttachment(
  libraryID: number,
  attachmentKey: string,
): Promise<string> {
  if (!attachmentKey)
    throw new Error("Zotero attachment has no attachment key");
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
