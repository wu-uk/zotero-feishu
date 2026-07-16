import { assert } from "chai";
import {
  SyncService,
  type SyncClient,
  type SyncStateRepository,
} from "../src/modules/syncService";
import type {
  DocumentModel,
  DocumentSnapshot,
  SyncRecord,
} from "../src/modules/types";

const MODEL: DocumentModel = {
  title: "Example",
  sections: [
    {
      key: "metadata",
      sourceHash: "metadata-hash",
      blocks: [{ type: "paragraph", runs: [{ text: "Metadata" }] }],
    },
  ],
  sourceHash: "source-hash",
};

describe("SyncService", function () {
  it("recreates an unchanged item when its Feishu document was deleted", async function () {
    const state = new MemoryState(record("deleted-document", MODEL.sourceHash));
    const calls = { create: 0, write: [] as string[] };
    const client = fakeClient({
      inspectDocument: async (documentId) =>
        documentId === "replacement-document"
          ? snapshot("replacement-document")
          : undefined,
      createDocument: async () => {
        calls.create++;
        return {
          documentId: "replacement-document",
          documentUrl: "https://feishu.cn/docx/replacement-document",
        };
      },
      syncDocumentSections: async (
        documentId,
        _sections,
        _previous,
        _resolve,
        checkpoint,
      ) => {
        calls.write.push(documentId);
        const result = writeResult(true);
        await checkpoint(result.sections);
        return result;
      },
    });
    const service = createService(state, client);

    const result = await service.syncItem(fakeItem());

    assert.equal(result.outcome, "created");
    assert.equal(calls.create, 1);
    assert.deepEqual(calls.write, ["replacement-document"]);
    assert.equal(state.current?.documentId, "replacement-document");
    assert.equal(state.current?.sourceHash, MODEL.sourceHash);
    assert.isUndefined(state.current?.pendingSync);
  });

  it("validates an unchanged mapped document before returning unchanged", async function () {
    const state = new MemoryState(
      record("existing-document", MODEL.sourceHash),
    );
    let inspections = 0;
    let validations = 0;
    const client = fakeClient({
      inspectDocument: async () => {
        inspections++;
        return snapshot("existing-document");
      },
      syncDocumentSections: async () => {
        validations++;
        return writeResult(false);
      },
    });

    const result = await createService(state, client).syncItem(fakeItem());

    assert.equal(result.outcome, "unchanged");
    assert.equal(inspections, 1);
    assert.equal(validations, 1);
  });

  it("updates a changed Zotero title on the mapped Page block", async function () {
    const state = new MemoryState(
      record("existing-document", MODEL.sourceHash, "Old title"),
    );
    const titles: string[] = [];
    const client = fakeClient({
      inspectDocument: async () => snapshot("existing-document", "Old title"),
      updateDocumentTitle: async (_documentId, title) => {
        titles.push(title);
      },
    });

    const result = await createService(state, client).syncItem(fakeItem());

    assert.equal(result.outcome, "updated");
    assert.deepEqual(titles, ["Example"]);
    assert.equal(state.current?.documentTitle, "Example");
  });

  it("serializes concurrent operations for the same Zotero item", async function () {
    const state = new MemoryState();
    let createCalls = 0;
    let validationCalls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = fakeClient({
      createDocument: async () => {
        createCalls++;
        return {
          documentId: "created-document",
          documentUrl: "https://feishu.cn/docx/created-document",
        };
      },
      syncDocumentSections: async () => {
        validationCalls++;
        if (validationCalls === 1) await firstGate;
        return writeResult(validationCalls === 1);
      },
    });
    const service = createService(state, client);
    const item = fakeItem();

    const first = service.syncItem(item);
    await waitUntil(() => validationCalls === 1);
    const second = service.syncItem(item);
    releaseFirst();
    const results = await Promise.all([first, second]);

    assert.deepEqual(
      results.map((result) => result.outcome),
      ["created", "unchanged"],
    );
    assert.equal(createCalls, 1);
    assert.equal(validationCalls, 2);
  });

  it("resolves child notes for sync, open, and delete operations", async function () {
    const parent = fakeItem();
    const child = {
      libraryID: parent.libraryID,
      key: "CHILD_NOTE",
      topLevelItem: parent,
      isRegularItem: () => false,
      getField: () => "Child",
    } as Zotero.Item;
    const state = new MemoryState(
      record("existing-document", MODEL.sourceHash),
    );
    const deleted: string[] = [];
    const launched: string[] = [];
    const originalLaunchURL = Zotero.launchURL;
    Zotero.launchURL = (url) => launched.push(url);
    try {
      const service = createService(
        state,
        fakeClient({
          deleteDocument: async (documentId) => {
            deleted.push(documentId);
          },
        }),
      );

      assert.equal((await service.syncItem(child)).itemKey, parent.key);
      assert.isTrue(await service.openItem(child));
      assert.isTrue(await service.deleteItem(child));
    } finally {
      Zotero.launchURL = originalLaunchURL;
    }

    assert.deepEqual(launched, ["https://feishu.cn/docx/existing-document"]);
    assert.deepEqual(deleted, ["existing-document"]);
  });
});

class MemoryState implements SyncStateRepository {
  current?: SyncRecord;

  constructor(initial?: SyncRecord) {
    this.current = initial;
  }

  async get(): Promise<SyncRecord | undefined> {
    return clone(this.current);
  }

  async set(value: SyncRecord): Promise<void> {
    this.current = clone(value);
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
    inspectDocument: async (documentId) => snapshot(documentId),
    updateDocumentTitle: async () => undefined,
    syncDocumentSections: async () => writeResult(false),
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

function record(
  documentId: string,
  sourceHash: string,
  documentTitle = MODEL.title,
): SyncRecord {
  return {
    libraryID: Zotero.Libraries.userLibraryID,
    itemKey: "ITEM1234",
    documentId,
    documentUrl: `https://feishu.cn/docx/${documentId}`,
    documentTitle,
    sourceHash,
    lastSyncedAt: "2026-07-14T00:00:00.000Z",
    sections: writeResult(false).sections,
  };
}

function writeResult(changed: boolean) {
  return {
    sections: [
      {
        key: "metadata",
        sourceHash: "metadata-hash",
        remoteHash: "metadata-remote-hash",
        blockIds: ["metadata-block"],
      },
    ],
    errors: [],
    rebuilt: false,
    changed,
  };
}

function snapshot(documentId: string, title = MODEL.title): DocumentSnapshot {
  return {
    documentId,
    title,
    revisionId: 1,
    rootBlockIds: ["metadata-block"],
    blocks: [
      {
        block_id: "metadata-block",
        block_type: 2,
        parent_id: documentId,
        text: { elements: [] },
      },
    ],
  };
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Zotero.Promise.delay(10);
  }
  throw new Error("Timed out waiting for sync operation");
}
