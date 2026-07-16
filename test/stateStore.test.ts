import { assert } from "chai";
import {
  CorruptSyncStateError,
  StateStore,
  type StateStoreOptions,
} from "../src/modules/stateStore";
import type { SyncRecord } from "../src/modules/types";

describe("StateStore", function () {
  it("serializes concurrent writes without losing records", async function () {
    const fake = createFakeIO();
    const store = new StateStore(fake.options);
    const secondStore = new StateStore(fake.options);

    await Promise.all([
      store.set(record("ITEM_A")),
      secondStore.set(record("ITEM_B")),
    ]);

    const state = await store.load();
    assert.deepEqual(Object.keys(state.records).sort(), [
      "1:ITEM_A",
      "1:ITEM_B",
    ]);
    assert.isTrue(
      fake.writes.every((write) => write.tmpPath === "memory/state.json.tmp"),
    );
  });

  it("serializes interleaved deletes and writes", async function () {
    const fake = createFakeIO({
      version: 2,
      records: {
        "1:ITEM_A": legacyRecord("ITEM_A"),
        "1:ITEM_B": legacyRecord("ITEM_B"),
      },
    });
    const store = new StateStore(fake.options);

    await Promise.all([
      store.delete(1, "ITEM_A"),
      store.set(record("ITEM_C")),
      store.set({ ...record("ITEM_B"), sourceHash: "updated" }),
    ]);

    const state = await store.load();
    assert.notProperty(state.records, "1:ITEM_A");
    assert.equal(state.records["1:ITEM_B"].sourceHash, "updated");
    assert.property(state.records, "1:ITEM_C");
  });

  it("migrates v1 and v2 records to v3 fields", async function () {
    for (const version of [1, 2]) {
      const fake = createFakeIO({
        version,
        records: {
          "1:ITEM_A": {
            ...legacyRecord("ITEM_A"),
            sections: [
              {
                key: "metadata",
                sourceHash: "source",
                blockIds: ["block"],
              },
            ],
          },
        },
      });
      const state = await new StateStore(fake.options).load();

      assert.equal(state.version, 3);
      assert.equal(state.records["1:ITEM_A"].documentTitle, "");
      assert.equal(state.records["1:ITEM_A"].sections?.[0].remoteHash, "");
    }
  });

  it("returns deep copies instead of mutable internal state", async function () {
    const fake = createFakeIO();
    const store = new StateStore(fake.options);
    await store.set(record("ITEM_A"));

    const loaded = await store.load();
    loaded.records["1:ITEM_A"].sections![0].blockIds[0] = "changed";
    const stored = await store.get(1, "ITEM_A");

    assert.equal(stored?.sections?.[0].blockIds[0], "block");
  });

  it("backs up corrupt state and stops loading", async function () {
    const fake = createFakeIO("not json");
    const store = new StateStore(fake.options);

    let caught: unknown;
    try {
      await store.load();
    } catch (error) {
      caught = error;
    }

    assert.instanceOf(caught, CorruptSyncStateError);
    assert.deepEqual(fake.moves, [
      {
        source: "memory/state.json",
        destination: "memory/state.corrupt-1234.json",
      },
    ]);
    assert.lengthOf(fake.writes, 0);
  });
});

function record(itemKey: string): SyncRecord {
  return {
    libraryID: 1,
    itemKey,
    documentId: `doc-${itemKey}`,
    documentUrl: `https://feishu.cn/docx/doc-${itemKey}`,
    documentTitle: "Example",
    sourceHash: "source",
    lastSyncedAt: "2026-07-16T00:00:00.000Z",
    sections: [
      {
        key: "metadata",
        sourceHash: "source",
        remoteHash: "remote",
        blockIds: ["block"],
      },
    ],
  };
}

function legacyRecord(itemKey: string): Omit<SyncRecord, "documentTitle"> {
  const value = record(itemKey);
  const { documentTitle: _documentTitle, ...legacy } = value;
  return legacy;
}

function createFakeIO(initial?: unknown): {
  options: StateStoreOptions;
  writes: Array<{ contents: string; tmpPath?: string }>;
  moves: Array<{ source: string; destination: string }>;
} {
  let contents =
    initial === undefined
      ? undefined
      : typeof initial === "string"
        ? initial
        : JSON.stringify(initial);
  const writes: Array<{ contents: string; tmpPath?: string }> = [];
  const moves: Array<{ source: string; destination: string }> = [];
  return {
    options: {
      path: "memory/state.json",
      now: () => 1234,
      pathUtils: {
        profileDir: "memory",
        join: (...parts) => parts.join("/"),
        parent: (path) => path.slice(0, path.lastIndexOf("/")),
      },
      ioUtils: {
        readUTF8: async () => {
          if (contents === undefined) {
            const error = new Error("missing");
            error.name = "NotFoundError";
            throw error;
          }
          return contents;
        },
        makeDirectory: async () => undefined,
        writeUTF8: async (_path, value, options) => {
          writes.push({ contents: value, tmpPath: options?.tmpPath });
          contents = value;
        },
        move: async (source, destination) => {
          moves.push({ source, destination });
          contents = undefined;
        },
      },
    },
    writes,
    moves,
  };
}
