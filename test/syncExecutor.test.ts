import { assert } from "chai";
import { remoteHashForSection } from "../src/modules/feishu/documentSnapshot";
import {
  FeishuSyncExecutor,
  type SyncBlockWriter,
  type SyncDocumentReader,
  type SyncMediaUploader,
} from "../src/modules/feishu/syncExecutor";
import type {
  DocumentSection,
  DocumentSnapshot,
  FeishuBlock,
  SyncedSection,
} from "../src/modules/types";

describe("FeishuSyncExecutor", function () {
  it("repairs remotely edited managed content and preserves unknown roots", async function () {
    const document = new MemoryDocument([
      textBlock("user-block", "User content"),
      textBlock("managed-block", "Managed v1"),
    ]);
    const previous = await mapping(
      document.snapshot(),
      "metadata",
      "source-v1",
      ["managed-block"],
    );
    (document.blocks[1].text as any).elements[0].text_run.content =
      "Edited remotely";

    const result = await executor(document).syncDocumentSections(
      document.documentId,
      [section("metadata", "source-v1", "Managed v1")],
      [previous],
      async () => "",
    );

    assert.isTrue(result.changed);
    assert.equal(result.sections[0].sourceHash, "source-v1");
    assert.deepEqual(
      document.blocks.map((block) => block.block_id),
      ["user-block", "created-1"],
    );
    assert.equal(textContent(document.blocks[0]), "User content");
    assert.equal(textContent(document.blocks[1]), "Managed v1");
  });

  it("recovers after interruption immediately following deletion", async function () {
    const document = new MemoryDocument([
      textBlock("user-block", "User content"),
      textBlock("managed-block", "Managed v1"),
    ]);
    const previous = await mapping(
      document.snapshot(),
      "metadata",
      "source-v1",
      ["managed-block"],
    );
    let checkpoint: SyncedSection[] = [previous];
    let interrupted = false;
    try {
      await executor(document).syncDocumentSections(
        document.documentId,
        [section("metadata", "source-v2", "Managed v2")],
        [previous],
        async () => "",
        async (sections) => {
          checkpoint = clone(sections);
          if (!sections.length) throw new Error("interrupted after deletion");
        },
      );
    } catch {
      interrupted = true;
    }
    assert.isTrue(interrupted);
    assert.deepEqual(checkpoint, []);
    assert.deepEqual(
      document.blocks.map((block) => block.block_id),
      ["user-block"],
    );

    const recovered = await executor(document).syncDocumentSections(
      document.documentId,
      [section("metadata", "source-v2", "Managed v2")],
      checkpoint,
      async () => "",
    );

    assert.equal(recovered.sections[0].sourceHash, "source-v2");
    assert.equal(textContent(document.blocks[0]), "User content");
    assert.equal(textContent(document.blocks[1]), "Managed v2");
  });

  it("keeps not-yet-deleted obsolete mappings in deletion checkpoints", async function () {
    const document = new MemoryDocument([
      textBlock("obsolete-block", "Obsolete"),
      textBlock("user-block", "User content"),
      textBlock("managed-block", "Managed v1"),
    ]);
    const obsolete = await mapping(
      document.snapshot(),
      "obsolete",
      "obsolete-source",
      ["obsolete-block"],
    );
    const managed = await mapping(
      document.snapshot(),
      "metadata",
      "source-v1",
      ["managed-block"],
    );
    let checkpoint: SyncedSection[] = [obsolete, managed];
    try {
      await executor(document).syncDocumentSections(
        document.documentId,
        [section("metadata", "source-v2", "Managed v2")],
        [obsolete, managed],
        async () => "",
        async (sections) => {
          checkpoint = clone(sections);
          throw new Error("interrupted during deletions");
        },
      );
    } catch {
      // The checkpoint is intentionally interrupted.
    }

    assert.deepEqual(
      checkpoint.map((section) => section.key),
      ["obsolete"],
    );
    const recovered = await executor(document).syncDocumentSections(
      document.documentId,
      [section("metadata", "source-v2", "Managed v2")],
      checkpoint,
      async () => "",
    );

    assert.equal(recovered.sections[0].key, "metadata");
    assert.sameMembers(document.blocks.map(textContent), [
      "User content",
      "Managed v2",
    ]);
    assert.isTrue(
      document.blocks.some((block) => block.block_id === "user-block"),
    );
  });

  it("recovers after interruption immediately following insertion", async function () {
    const document = new MemoryDocument([
      textBlock("user-block", "User content"),
    ]);
    let checkpoint: SyncedSection[] = [];
    let interrupted = false;
    try {
      await executor(document).syncDocumentSections(
        document.documentId,
        [section("metadata", "source-v1", "Managed")],
        undefined,
        async () => "",
        async (sections) => {
          checkpoint = clone(sections);
          if (sections[0]?.sourceHash === "") {
            throw new Error("interrupted after insertion");
          }
        },
      );
    } catch {
      interrupted = true;
    }
    assert.isTrue(interrupted);
    assert.equal(checkpoint[0].sourceHash, "");
    assert.lengthOf(document.blocks, 2);

    const recovered = await executor(document).syncDocumentSections(
      document.documentId,
      [section("metadata", "source-v1", "Managed")],
      checkpoint,
      async () => "",
    );

    assert.equal(recovered.sections[0].sourceHash, "source-v1");
    assert.lengthOf(document.blocks, 2);
    assert.equal(textContent(document.blocks[0]), "User content");
    assert.equal(textContent(document.blocks[1]), "Managed");
  });

  it("retries a section after a media upload failure", async function () {
    const document = new MemoryDocument([]);
    const media = new RetryMediaUploader();
    const desired: DocumentSection[] = [
      {
        key: "note:image",
        sourceHash: "image-source",
        blocks: [
          {
            type: "image",
            attachmentKey: "IMAGE_KEY",
            alt: "Figure",
          },
        ],
      },
    ];
    const first = await executor(document, media).syncDocumentSections(
      document.documentId,
      desired,
      undefined,
      async () => "figure.png",
    );

    assert.lengthOf(first.errors, 1);
    assert.equal(first.sections[0].sourceHash, "");
    assert.lengthOf(document.blocks, 1);

    const second = await executor(document, media).syncDocumentSections(
      document.documentId,
      desired,
      first.sections,
      async () => "figure.png",
    );

    assert.deepEqual(second.errors, []);
    assert.equal(second.sections[0].sourceHash, "image-source");
    assert.lengthOf(document.blocks, 1);
    assert.equal(media.calls, 2);
  });
});

class MemoryDocument implements SyncDocumentReader, SyncBlockWriter {
  readonly documentId = "document-id";
  readonly title = "Example";
  private nextId = 1;
  blocks: FeishuBlock[];

  constructor(blocks: FeishuBlock[]) {
    this.blocks = blocks.map((block) => ({
      ...block,
      parent_id: this.documentId,
    }));
  }

  snapshot(): DocumentSnapshot {
    return {
      documentId: this.documentId,
      title: this.title,
      revisionId: 1,
      rootBlockIds: this.blocks.map((block) => block.block_id),
      blocks: clone(this.blocks),
    };
  }

  async inspectDocument(): Promise<DocumentSnapshot> {
    return this.snapshot();
  }

  async getRootChildren(): Promise<FeishuBlock[]> {
    return clone(this.blocks);
  }

  async deleteChildRange(
    _documentId: string,
    _parentBlockId: string,
    startIndex: number,
    endIndex: number,
  ): Promise<void> {
    this.blocks.splice(startIndex, endIndex - startIndex);
  }

  async appendBlocks(
    _documentId: string,
    children: unknown[],
    _parentBlockId?: string,
    index = -1,
  ): Promise<FeishuBlock[]> {
    const created = children.map((child) => ({
      ...(child as Record<string, unknown>),
      block_id: `created-${this.nextId++}`,
      parent_id: this.documentId,
    })) as FeishuBlock[];
    const insertionIndex = index < 0 ? this.blocks.length : index;
    this.blocks.splice(insertionIndex, 0, ...created);
    return clone(created);
  }

  async appendDescendants(): Promise<FeishuBlock[]> {
    throw new Error("HTML conversion is not used in this test");
  }
}

class RetryMediaUploader implements SyncMediaUploader {
  calls = 0;

  async upload(): Promise<void> {
    this.calls++;
    if (this.calls === 1) throw new Error("temporary upload failure");
  }
}

function executor(
  document: MemoryDocument,
  media: SyncMediaUploader = { upload: async () => undefined },
): FeishuSyncExecutor {
  return new FeishuSyncExecutor(
    document,
    document,
    {
      convert: async () => {
        throw new Error("HTML conversion is not used in this test");
      },
    },
    media,
  );
}

function section(
  key: string,
  sourceHash: string,
  text: string,
): DocumentSection {
  return {
    key,
    sourceHash,
    blocks: [{ type: "paragraph", runs: [{ text }] }],
  };
}

async function mapping(
  snapshot: DocumentSnapshot,
  key: string,
  sourceHash: string,
  blockIds: string[],
): Promise<SyncedSection> {
  return {
    key,
    sourceHash,
    remoteHash: await remoteHashForSection(snapshot, { blockIds }),
    blockIds,
  };
}

function textBlock(blockId: string, content: string): FeishuBlock {
  return {
    block_id: blockId,
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content,
            text_element_style: {},
          },
        },
      ],
      style: {},
    },
  };
}

function textContent(block: FeishuBlock): string {
  return String(
    ((block.text as any)?.elements?.[0] as any)?.text_run?.content || "",
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
