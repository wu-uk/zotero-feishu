import type {
  PendingSync,
  SyncRecord,
  SyncState,
  SyncedSection,
} from "./types";

const CURRENT_VERSION = 3;

interface StateIO {
  readUTF8(path: string): Promise<string>;
  makeDirectory(
    path: string,
    options?: { ignoreExisting?: boolean },
  ): Promise<void>;
  writeUTF8(
    path: string,
    contents: string,
    options?: { tmpPath?: string },
  ): Promise<void>;
  move(
    sourcePath: string,
    destinationPath: string,
    options?: { noOverwrite?: boolean },
  ): Promise<void>;
}

interface StatePathUtils {
  profileDir: string;
  join(...parts: string[]): string;
  parent(path: string): string;
}

export interface StateStoreOptions {
  path?: string;
  ioUtils?: StateIO;
  pathUtils?: StatePathUtils;
  now?: () => number;
}

interface SharedStateStore {
  state?: SyncState;
  loadPromise?: Promise<SyncState>;
  writeQueue: Promise<void>;
}

export class CorruptSyncStateError extends Error {
  constructor(
    public readonly backupPath: string,
    cause: unknown,
  ) {
    super(
      `Zotero Feishu sync state is corrupt; backup saved to ${backupPath}`,
      { cause },
    );
  }
}

export class StateStore {
  private static readonly sharedStores = new WeakMap<
    StateIO,
    Map<string, SharedStateStore>
  >();

  constructor(private readonly options: StateStoreOptions = {}) {}

  private get ioUtils(): StateIO {
    return (
      this.options.ioUtils ||
      (ztoolkit.getGlobal("IOUtils") as unknown as StateIO)
    );
  }

  private get pathUtils(): StatePathUtils {
    return (
      this.options.pathUtils ||
      (ztoolkit.getGlobal("PathUtils") as unknown as StatePathUtils)
    );
  }

  private get path(): string {
    return (
      this.options.path ||
      this.pathUtils.join(
        this.pathUtils.profileDir,
        "zotero-feishu",
        "state.json",
      )
    );
  }

  private get shared(): SharedStateStore {
    let byPath = StateStore.sharedStores.get(this.ioUtils);
    if (!byPath) {
      byPath = new Map();
      StateStore.sharedStores.set(this.ioUtils, byPath);
    }
    let shared = byPath.get(this.path);
    if (!shared) {
      shared = { writeQueue: Promise.resolve() };
      byPath.set(this.path, shared);
    }
    return shared;
  }

  private key(libraryID: number, itemKey: string): string {
    return `${libraryID}:${itemKey}`;
  }

  async load(): Promise<SyncState> {
    return clone(await this.loadInternal());
  }

  async get(
    libraryID: number,
    itemKey: string,
  ): Promise<SyncRecord | undefined> {
    const record = (await this.loadInternal()).records[
      this.key(libraryID, itemKey)
    ];
    return record ? clone(record) : undefined;
  }

  async set(record: SyncRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = clone(await this.loadInternal());
      state.records[this.key(record.libraryID, record.itemKey)] =
        normalizeRecord(record);
      await this.saveInternal(state);
      this.shared.state = state;
    });
  }

  async delete(libraryID: number, itemKey: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = clone(await this.loadInternal());
      delete state.records[this.key(libraryID, itemKey)];
      await this.saveInternal(state);
      this.shared.state = state;
    });
  }

  private async loadInternal(): Promise<SyncState> {
    if (this.shared.state) return this.shared.state;
    if (!this.shared.loadPromise) {
      this.shared.loadPromise = this.readState();
    }
    return this.shared.loadPromise;
  }

  private async readState(): Promise<SyncState> {
    try {
      const parsed = JSON.parse(await this.ioUtils.readUTF8(this.path));
      this.shared.state = migrateState(parsed);
      return this.shared.state;
    } catch (error) {
      if (isNotFoundError(error)) {
        this.shared.state = emptyState();
        return this.shared.state;
      }
      const backupPath = `${this.path.replace(/\.json$/i, "")}.corrupt-${(
        this.options.now || Date.now
      )()}.json`;
      try {
        await this.ioUtils.move(this.path, backupPath, { noOverwrite: true });
      } catch (backupError) {
        ztoolkit.log(
          "Unable to back up corrupt Feishu sync state",
          backupError,
        );
      }
      throw new CorruptSyncStateError(backupPath, error);
    }
  }

  private async saveInternal(state: SyncState): Promise<void> {
    const directory = this.pathUtils.parent(this.path);
    await this.ioUtils.makeDirectory(directory, { ignoreExisting: true });
    await this.ioUtils.writeUTF8(this.path, JSON.stringify(state, null, 2), {
      tmpPath: `${this.path}.tmp`,
    });
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.shared.writeQueue.then(operation, operation);
    this.shared.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    await result;
  }
}

function migrateState(value: unknown): SyncState {
  if (!isObject(value)) throw new Error("Sync state must be an object");
  const version = value.version;
  if (version !== 1 && version !== 2 && version !== CURRENT_VERSION) {
    throw new Error("Unsupported sync state version");
  }
  if (!isObject(value.records)) {
    throw new Error("Sync state records must be an object");
  }
  const records = Object.fromEntries(
    Object.entries(value.records).map(([key, record]) => [
      key,
      normalizeRecord(record),
    ]),
  );
  return { version: CURRENT_VERSION, records };
}

function normalizeRecord(value: unknown): SyncRecord {
  if (!isObject(value)) throw new Error("Invalid sync record");
  const libraryID = requiredNumber(value, "libraryID");
  const itemKey = requiredString(value, "itemKey");
  const documentId = requiredString(value, "documentId");
  const documentUrl = requiredString(value, "documentUrl");
  const sourceHash = optionalString(value.sourceHash);
  const lastSyncedAt = optionalString(value.lastSyncedAt);
  const documentTitle = optionalString(value.documentTitle);
  const sections = Array.isArray(value.sections)
    ? value.sections.map(normalizeSection)
    : undefined;
  const pendingSync = normalizePendingSync(value.pendingSync);
  return {
    libraryID,
    itemKey,
    documentId,
    documentUrl,
    documentTitle,
    sourceHash,
    lastSyncedAt,
    ...(sections ? { sections } : {}),
    ...(pendingSync ? { pendingSync } : {}),
  };
}

function normalizeSection(value: unknown): SyncedSection {
  if (!isObject(value) || !Array.isArray(value.blockIds)) {
    throw new Error("Invalid synced section");
  }
  return {
    key: requiredString(value, "key"),
    sourceHash: optionalString(value.sourceHash),
    remoteHash: optionalString(value.remoteHash),
    blockIds: value.blockIds.map((id) => {
      if (typeof id !== "string" || !id) {
        throw new Error("Invalid synced section block ID");
      }
      return id;
    }),
  };
}

function normalizePendingSync(value: unknown): PendingSync | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error("Invalid pending sync state");
  return {
    targetSourceHash: requiredString(value, "targetSourceHash"),
    startedAt: requiredString(value, "startedAt"),
  };
}

function emptyState(): SyncState {
  return { version: CURRENT_VERSION, records: {} };
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) {
    throw new Error(`Sync state is missing ${key}`);
  }
  return field;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Sync state is missing ${key}`);
  }
  return field;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNotFoundError(error: unknown): boolean {
  return (
    isObject(error) &&
    (error.name === "NotFoundError" || error.name === "NS_ERROR_FILE_NOT_FOUND")
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
