import type { SyncRecord, SyncState } from "./types";

const EMPTY_STATE: SyncState = { version: 2, records: {} };

export class StateStore {
  private state?: SyncState;

  private get path(): string {
    const pathUtils = ztoolkit.getGlobal("PathUtils") as any;
    return pathUtils.join(pathUtils.profileDir, "zotero-feishu", "state.json");
  }

  private key(libraryID: number, itemKey: string): string {
    return `${libraryID}:${itemKey}`;
  }

  async load(): Promise<SyncState> {
    if (this.state) return this.state;
    const ioUtils = ztoolkit.getGlobal("IOUtils") as any;
    try {
      const parsed = JSON.parse(await ioUtils.readUTF8(this.path));
      if (
        (parsed.version !== 1 && parsed.version !== 2) ||
        typeof parsed.records !== "object"
      ) {
        throw new Error("Unsupported sync state version");
      }
      this.state = {
        version: 2,
        records: parsed.records as Record<string, SyncRecord>,
      };
    } catch (error) {
      if ((error as any)?.name !== "NotFoundError") {
        ztoolkit.log("Unable to read sync state; starting empty", error);
      }
      this.state = { ...EMPTY_STATE, records: {} };
    }
    return this.state;
  }

  async get(
    libraryID: number,
    itemKey: string,
  ): Promise<SyncRecord | undefined> {
    return (await this.load()).records[this.key(libraryID, itemKey)];
  }

  async set(record: SyncRecord): Promise<void> {
    const state = await this.load();
    state.records[this.key(record.libraryID, record.itemKey)] = record;
    await this.save();
  }

  async delete(libraryID: number, itemKey: string): Promise<void> {
    const state = await this.load();
    delete state.records[this.key(libraryID, itemKey)];
    await this.save();
  }

  private async save(): Promise<void> {
    const ioUtils = ztoolkit.getGlobal("IOUtils") as any;
    const pathUtils = ztoolkit.getGlobal("PathUtils") as any;
    const directory = pathUtils.parent(this.path);
    await ioUtils.makeDirectory(directory, { ignoreExisting: true });
    await ioUtils.writeUTF8(this.path, JSON.stringify(this.state, null, 2), {
      tmpPath: `${this.path}.tmp`,
    });
  }
}
