import { assert } from "chai";
import {
  SyncService,
  type SyncClient,
  type SyncStateRepository,
} from "../src/modules/syncService";
import type { DocumentModel, SyncRecord } from "../src/modules/types";

const MODEL: DocumentModel = {
  title: "Example",
  blocks: [],
  sourceHash: "source-hash",
};

describe("SyncService", function () {
  it("recreates an unchanged item when its Feishu document was deleted", async function () {
    const state = new MemoryState(record("deleted-document", MODEL.sourceHash));
    const calls = { create: 0, replace: [] as string[] };
    const client = fakeClient({
      documentExists: async () => false,
      createDocument: async () => {
        calls.create++;
        return {
          documentId: "replacement-document",
          documentUrl: "https://feishu.cn/docx/replacement-document",
        };
      },
      replaceDocument: async (documentId) => {
        calls.replace.push(documentId);
        return [];
      },
    });
    const service = createService(state, client);

    const result = await service.syncItem(fakeItem());

    assert.equal(result.outcome, "created");
    assert.equal(calls.create, 1);
    assert.deepEqual(calls.replace, ["replacement-document"]);
    assert.equal(state.current?.documentId, "replacement-document");
    assert.equal(state.current?.sourceHash, MODEL.sourceHash);
  });

  it("checks that an unchanged mapped document still exists", async function () {
    const state = new MemoryState(
      record("existing-document", MODEL.sourceHash),
    );
    let existenceChecks = 0;
    const client = fakeClient({
      documentExists: async () => {
        existenceChecks++;
        return true;
      },
    });

    const result = await createService(state, client).syncItem(fakeItem());

    assert.equal(result.outcome, "unchanged");
    assert.equal(existenceChecks, 1);
  });

  it("serializes concurrent operations for the same Zotero item", async function () {
    const state = new MemoryState();
    let createCalls = 0;
    let replaceCalls = 0;
    let releaseReplace!: () => void;
    const replaceGate = new Promise<void>((resolve) => {
      releaseReplace = resolve;
    });
    const client = fakeClient({
      documentExists: async () => true,
      createDocument: async () => {
        createCalls++;
        return {
          documentId: "created-document",
          documentUrl: "https://feishu.cn/docx/created-document",
        };
      },
      replaceDocument: async () => {
        replaceCalls++;
        await replaceGate;
        return [];
      },
    });
    const service = createService(state, client);
    const item = fakeItem();

    const first = service.syncItem(item);
    await waitUntil(() => replaceCalls === 1);
    const second = service.syncItem(item);
    releaseReplace();
    const results = await Promise.all([first, second]);

    assert.deepEqual(
      results.map((result) => result.outcome),
      ["created", "unchanged"],
    );
    assert.equal(createCalls, 1);
    assert.equal(replaceCalls, 1);
  });
});

class MemoryState implements SyncStateRepository {
  current?: SyncRecord;

  constructor(initial?: SyncRecord) {
    this.current = initial;
  }

  async get(): Promise<SyncRecord | undefined> {
    return this.current ? { ...this.current } : undefined;
  }

  async set(value: SyncRecord): Promise<void> {
    this.current = { ...value };
  }

  async delete(): Promise<void> {
    this.current = undefined;
  }
}

function createService(
  state: SyncStateRepository,
  client: SyncClient,
): SyncService {
  return new SyncService({
    state,
    client,
    buildDocument: async () => MODEL,
  });
}

function fakeClient(overrides: Partial<SyncClient> = {}): SyncClient {
  return {
    getCurrentUser: async () => ({ name: "Example User", openId: "ou_test" }),
    testConnection: async () => undefined,
    createDocument: async () => ({
      documentId: "created-document",
      documentUrl: "https://feishu.cn/docx/created-document",
    }),
    documentExists: async () => true,
    replaceDocument: async () => [],
    deleteDocument: async () => undefined,
    ...overrides,
  };
}

function fakeItem(): Zotero.Item {
  return {
    libraryID: Zotero.Libraries.userLibraryID,
    key: "ITEM1234",
    isRegularItem: () => true,
    getField: () => "Example",
  } as Zotero.Item;
}

function record(documentId: string, sourceHash: string): SyncRecord {
  return {
    libraryID: Zotero.Libraries.userLibraryID,
    itemKey: "ITEM1234",
    documentId,
    documentUrl: `https://feishu.cn/docx/${documentId}`,
    sourceHash,
    lastSyncedAt: "2026-07-14T00:00:00.000Z",
  };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Zotero.Promise.delay(10);
  }
  throw new Error("Timed out waiting for sync operation");
}
