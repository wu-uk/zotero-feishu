import type {
  CalloutBlock,
  DocumentSection,
  DocumentSnapshot,
  DocumentWriteResult,
  FeishuBlock,
  RichBlock,
  SyncedSection,
} from "../types";
import {
  createdFileBlockId,
  prepareCalloutBlock,
  toFeishuBlock,
  type ConvertedBlocks,
  type ConvertedImageBlock,
} from "./blocks";
import type { CreatedFeishuBlock } from "./blockWriter";
import { remoteHashForSection } from "./documentSnapshot";
import type { MediaKind } from "./media";
import { planSectionSync } from "./sectionSync";

export type SectionCheckpoint = (sections: SyncedSection[]) => Promise<void>;

interface PendingMediaUpload {
  blockId: string;
  kind: MediaKind;
  attachmentKey: string;
  label: string;
}

export interface SyncDocumentReader {
  inspectDocument(documentId: string): Promise<DocumentSnapshot | undefined>;
  getRootChildren(documentId: string): Promise<FeishuBlock[]>;
}

export interface SyncBlockWriter {
  deleteChildRange(
    documentId: string,
    parentBlockId: string,
    startIndex: number,
    endIndex: number,
  ): Promise<void>;
  appendBlocks(
    documentId: string,
    children: unknown[],
    parentBlockId?: string,
    index?: number,
  ): Promise<CreatedFeishuBlock[]>;
  appendDescendants(
    documentId: string,
    index: number,
    childrenId: string[],
    descendants: unknown[],
  ): Promise<CreatedFeishuBlock[]>;
}

export interface SyncHtmlConverter {
  convert(
    block: Extract<RichBlock, { type: "html" }>,
  ): Promise<ConvertedBlocks>;
}

export interface SyncMediaUploader {
  upload(
    documentId: string,
    blockId: string,
    path: string,
    kind: MediaKind,
  ): Promise<void>;
}

export class FeishuSyncExecutor {
  constructor(
    private readonly reader: SyncDocumentReader,
    private readonly writer: SyncBlockWriter,
    private readonly converter: SyncHtmlConverter,
    private readonly media: SyncMediaUploader,
  ) {}

  async syncDocumentSections(
    documentId: string,
    sections: DocumentSection[],
    previous: SyncedSection[] | undefined,
    resolveAttachment: (attachmentKey: string) => Promise<string>,
    checkpoint: SectionCheckpoint = async () => undefined,
    initialSnapshot?: DocumentSnapshot,
  ): Promise<DocumentWriteResult> {
    const snapshot =
      initialSnapshot || (await this.reader.inspectDocument(documentId));
    if (!snapshot) throw new Error("The mapped Feishu document was deleted");
    const remoteHashes = new Map<string, string>();
    for (const section of previous || []) {
      if (remoteHashes.has(section.key)) continue;
      try {
        remoteHashes.set(
          section.key,
          await remoteHashForSection(snapshot, section),
        );
      } catch {
        // A missing or malformed mapped subtree is repaired below.
      }
    }
    const plan = planSectionSync(
      snapshot.rootBlockIds,
      previous,
      sections,
      remoteHashes,
    );
    const retainedKeys = new Set(plan.retained.map((section) => section.key));
    const changedSections = sections.filter(
      (section) => !retainedKeys.has(section.key),
    );
    const convertedSegments =
      await this.prepareConvertedSegments(changedSections);
    const rootBlockIds = [...snapshot.rootBlockIds];
    const initialRootBlockIds = [...snapshot.rootBlockIds];
    const managedBlockIds = new Set(
      (previous || []).flatMap((section) => section.blockIds),
    );
    const firstManagedIndex = initialRootBlockIds.findIndex((blockId) =>
      managedBlockIds.has(blockId),
    );
    const fallbackInsertionIndex =
      firstManagedIndex < 0
        ? rootBlockIds.length
        : initialRootBlockIds
            .slice(0, firstManagedIndex)
            .filter((blockId) => !managedBlockIds.has(blockId)).length;
    const currentMappings = [...(previous || [])];
    const deletionOrder = [...plan.deletions].sort(
      (left, right) =>
        lastRootIndex(rootBlockIds, right.blockIds) -
        lastRootIndex(rootBlockIds, left.blockIds),
    );

    for (const deletion of deletionOrder) {
      await this.deleteMappedBlocks(
        documentId,
        rootBlockIds,
        deletion.blockIds,
      );
      const mappingIndex = currentMappings.indexOf(deletion);
      if (mappingIndex >= 0) currentMappings.splice(mappingIndex, 1);
      await checkpoint(orderMappings(sections, currentMappings));
    }

    const retainedByKey = new Map(
      plan.retained.map((section) => [section.key, section]),
    );
    const errors: string[] = [];
    let cursor: number | undefined;
    for (const [sectionIndex, section] of sections.entries()) {
      const retained = retainedByKey.get(section.key);
      if (retained) {
        const retainedIndex = contiguousRootIndex(
          rootBlockIds,
          retained.blockIds,
        );
        if (retainedIndex < 0) {
          throw new Error(`Retained Feishu section ${section.key} moved`);
        }
        cursor = retainedIndex + retained.blockIds.length;
        continue;
      }

      const insertionIndex =
        cursor ??
        nextRetainedIndex(
          rootBlockIds,
          sections,
          sectionIndex,
          retainedByKey,
        ) ??
        Math.min(fallbackInsertionIndex, rootBlockIds.length);
      const written = await this.writeSection(
        documentId,
        section,
        insertionIndex,
        convertedSegments,
        resolveAttachment,
        async (mapping) => {
          replaceMapping(currentMappings, mapping);
          await checkpoint(orderMappings(sections, currentMappings));
        },
      );
      rootBlockIds.splice(insertionIndex, 0, ...written.section.blockIds);
      replaceMapping(currentMappings, written.section);
      await checkpoint(orderMappings(sections, currentMappings));
      errors.push(...written.errors);
      cursor = insertionIndex + written.section.blockIds.length;
    }
    return {
      sections: orderMappings(sections, currentMappings),
      errors,
      rebuilt: false,
      changed: Boolean(plan.deletions.length || changedSections.length),
    };
  }

  private async writeSection(
    documentId: string,
    section: DocumentSection,
    startIndex: number,
    convertedSegments: Map<RichBlock, ConvertedBlocks>,
    resolveAttachment: (attachmentKey: string) => Promise<string>,
    onInserted: (mapping: SyncedSection) => Promise<void>,
  ): Promise<{ section: SyncedSection; errors: string[] }> {
    const errors: string[] = [];
    const blockIds: string[] = [];
    const uploads: PendingMediaUpload[] = [];
    let blockIndex = startIndex;
    let pending: unknown[] = [];
    const checkpointInsertion = async () => {
      if (!blockIds.length) return;
      await onInserted({
        key: section.key,
        sourceHash: "",
        remoteHash: "",
        blockIds: [...blockIds],
      });
    };
    const flush = async () => {
      if (!pending.length) return;
      const created = await this.writer.appendBlocks(
        documentId,
        pending,
        documentId,
        blockIndex,
      );
      const createdIds = requireCreatedBlockIds(created, pending.length);
      blockIds.push(...createdIds);
      blockIndex += createdIds.length;
      pending = [];
      await checkpointInsertion();
    };

    for (const block of section.blocks) {
      if (block.type === "html") {
        await flush();
        const created = await this.appendConvertedBlocks(
          documentId,
          convertedSegments.get(block)!,
          blockIndex,
        );
        blockIds.push(...created.rootBlockIds);
        uploads.push(
          ...created.imageBlocks.map(({ blockId, source }) => ({
            blockId,
            kind: "image" as const,
            attachmentKey: source.source.attachmentKey,
            label:
              source.source.alt ||
              source.source.attachmentKey ||
              "embedded image",
          })),
        );
        blockIndex += created.rootBlockIds.length;
        await checkpointInsertion();
        continue;
      }
      if (block.type === "callout") {
        await flush();
        const createdIds = await this.appendCallout(
          documentId,
          block,
          blockIndex,
        );
        blockIds.push(...createdIds);
        blockIndex += createdIds.length;
        await checkpointInsertion();
        continue;
      }
      if (block.type !== "image" && block.type !== "file") {
        pending.push(toFeishuBlock(block));
        if (pending.length === 50) await flush();
        continue;
      }
      await flush();
      const kind: MediaKind = block.type;
      const created = await this.writer.appendBlocks(
        documentId,
        [
          kind === "image"
            ? { block_type: 27, image: {} }
            : { block_type: 23, file: { token: "" } },
        ],
        documentId,
        blockIndex,
      );
      const createdRootIds = requireCreatedBlockIds(created, 1);
      blockIds.push(...createdRootIds);
      blockIndex += createdRootIds.length;
      const blockId =
        kind === "image" ? createdRootIds[0] : createdFileBlockId(created);
      uploads.push({
        blockId,
        kind,
        attachmentKey: block.attachmentKey,
        label:
          block.type === "image"
            ? block.alt || block.attachmentKey
            : block.name || block.attachmentKey,
      });
      await checkpointInsertion();
    }
    await flush();
    if (!blockIds.length) {
      throw new Error(`Document section ${section.key} produced no blocks`);
    }

    for (const upload of uploads) {
      try {
        const path = await resolveAttachment(upload.attachmentKey);
        await this.media.upload(documentId, upload.blockId, path, upload.kind);
      } catch (error) {
        const prefix = upload.kind === "image" ? "Image" : "PDF";
        errors.push(`${prefix} ${upload.label}: ${errorMessage(error)}`);
      }
    }
    const finalSnapshot = await this.reader.inspectDocument(documentId);
    if (!finalSnapshot) {
      throw new Error("The Feishu document disappeared during sync");
    }
    const remoteHash = await remoteHashForSection(finalSnapshot, {
      blockIds,
    });
    return {
      section: {
        key: section.key,
        sourceHash: errors.length ? "" : section.sourceHash,
        remoteHash,
        blockIds,
      },
      errors,
    };
  }

  private async prepareConvertedSegments(
    sections: DocumentSection[],
  ): Promise<Map<RichBlock, ConvertedBlocks>> {
    const convertedSegments = new Map<RichBlock, ConvertedBlocks>();
    for (const section of sections) {
      for (const block of section.blocks) {
        if (block.type !== "html") continue;
        convertedSegments.set(block, await this.converter.convert(block));
      }
    }
    return convertedSegments;
  }

  private async deleteMappedBlocks(
    documentId: string,
    rootBlockIds: string[],
    mappedBlockIds: string[],
  ): Promise<void> {
    const indexes = mappedBlockIds
      .map((blockId) => rootBlockIds.indexOf(blockId))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right);
    const ranges: Array<{ start: number; end: number }> = [];
    for (const index of indexes) {
      const last = ranges.at(-1);
      if (last?.end === index) last.end++;
      else ranges.push({ start: index, end: index + 1 });
    }
    for (const range of ranges.reverse()) {
      await this.writer.deleteChildRange(
        documentId,
        documentId,
        range.start,
        range.end,
      );
      rootBlockIds.splice(range.start, range.end - range.start);
    }
  }

  private async appendCallout(
    documentId: string,
    block: CalloutBlock,
    index: number,
  ): Promise<string[]> {
    const prepared = prepareCalloutBlock(block);
    const created = await this.writer.appendDescendants(
      documentId,
      index,
      prepared.children_id,
      prepared.descendants,
    );
    const returnedIds = returnedRootIds(
      created,
      documentId,
      prepared.children_id.length,
    );
    if (returnedIds.length === prepared.children_id.length) {
      return returnedIds;
    }
    return this.getInsertedRootBlockIds(documentId, index, 1);
  }

  private async appendConvertedBlocks(
    documentId: string,
    converted: ConvertedBlocks,
    index: number,
  ): Promise<{
    rootBlockIds: string[];
    imageBlocks: Array<{
      blockId: string;
      source: ConvertedImageBlock;
    }>;
  }> {
    const { firstLevelBlockIds, descendants } = converted;
    if (!firstLevelBlockIds.length || !descendants.length) {
      return { rootBlockIds: [], imageBlocks: [] };
    }
    const created = await this.writer.appendDescendants(
      documentId,
      index,
      firstLevelBlockIds,
      descendants,
    );
    if (!converted.imageBlocks?.length) {
      const returnedIds = returnedRootIds(
        created,
        documentId,
        firstLevelBlockIds.length,
      );
      return {
        rootBlockIds:
          returnedIds.length === firstLevelBlockIds.length
            ? returnedIds
            : await this.getInsertedRootBlockIds(
                documentId,
                index,
                firstLevelBlockIds.length,
              ),
        imageBlocks: [],
      };
    }
    const snapshot = await this.reader.inspectDocument(documentId);
    if (!snapshot) {
      throw new Error("The Feishu document disappeared during insertion");
    }
    const rootBlockIds = snapshot.rootBlockIds.slice(
      index,
      index + firstLevelBlockIds.length,
    );
    if (rootBlockIds.length !== firstLevelBlockIds.length) {
      throw new Error("Feishu did not return the inserted root block IDs");
    }
    const blockIds = matchTemporaryBlockIds(converted, snapshot, rootBlockIds);
    return {
      rootBlockIds,
      imageBlocks: converted.imageBlocks.map((source) => {
        const blockId = blockIds.get(source.temporaryBlockId);
        if (!blockId) {
          throw new Error(
            `Unable to locate inserted image ${source.temporaryBlockId}`,
          );
        }
        return { blockId, source };
      }),
    };
  }

  private async getInsertedRootBlockIds(
    documentId: string,
    index: number,
    count: number,
  ): Promise<string[]> {
    const ids = (await this.reader.getRootChildren(documentId))
      .slice(index, index + count)
      .map((block) => block.block_id)
      .filter(Boolean);
    if (ids.length !== count) {
      throw new Error("Feishu did not return the inserted root block IDs");
    }
    return ids;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireCreatedBlockIds(
  blocks: CreatedFeishuBlock[],
  expected: number,
): string[] {
  const ids = blocks.map((block) => block.block_id).filter(Boolean);
  if (ids.length !== expected) {
    throw new Error("Feishu did not return the created block IDs");
  }
  return ids;
}

function returnedRootIds(
  blocks: CreatedFeishuBlock[],
  documentId: string,
  expected: number,
): string[] {
  const explicit = blocks
    .filter((block) => block.parent_id === documentId)
    .map((block) => block.block_id);
  if (explicit.length === expected) return explicit;
  return blocks.length === expected
    ? blocks.map((block) => block.block_id)
    : [];
}

function orderMappings(
  desired: DocumentSection[],
  mappings: SyncedSection[],
): SyncedSection[] {
  const remaining = [...mappings];
  const ordered: SyncedSection[] = [];
  for (const section of desired) {
    const index = remaining.findIndex((mapping) => mapping.key === section.key);
    if (index < 0) continue;
    ordered.push(remaining[index]);
    remaining.splice(index, 1);
  }
  return [...ordered, ...remaining];
}

function replaceMapping(
  mappings: SyncedSection[],
  replacement: SyncedSection,
): void {
  const index = mappings.findIndex(
    (mapping) => mapping.key === replacement.key,
  );
  if (index >= 0) mappings[index] = replacement;
  else mappings.push(replacement);
}

function contiguousRootIndex(
  rootBlockIds: string[],
  blockIds: string[],
): number {
  const start = rootBlockIds.indexOf(blockIds[0]);
  return start >= 0 &&
    blockIds.every(
      (blockId, offset) => rootBlockIds[start + offset] === blockId,
    )
    ? start
    : -1;
}

function nextRetainedIndex(
  rootBlockIds: string[],
  desired: DocumentSection[],
  currentIndex: number,
  retainedByKey: Map<string, SyncedSection>,
): number | undefined {
  for (let index = currentIndex + 1; index < desired.length; index++) {
    const retained = retainedByKey.get(desired[index].key);
    if (!retained) continue;
    const rootIndex = contiguousRootIndex(rootBlockIds, retained.blockIds);
    if (rootIndex >= 0) return rootIndex;
  }
  return undefined;
}

function lastRootIndex(rootBlockIds: string[], blockIds: string[]): number {
  return Math.max(
    -1,
    ...blockIds.map((blockId) => rootBlockIds.indexOf(blockId)),
  );
}

function matchTemporaryBlockIds(
  converted: ConvertedBlocks,
  snapshot: DocumentSnapshot,
  actualRootBlockIds: string[],
): Map<string, string> {
  const expected = new Map(
    converted.descendants.map((block) => [String(block.block_id || ""), block]),
  );
  const actual = new Map(
    snapshot.blocks.map((block) => [block.block_id, block]),
  );
  const matched = new Map<string, string>();
  const match = (expectedId: string, actualId: string) => {
    const expectedBlock = expected.get(expectedId);
    const actualBlock = actual.get(actualId);
    if (
      !expectedBlock ||
      !actualBlock ||
      Number(expectedBlock.block_type) !== actualBlock.block_type
    ) {
      throw new Error("Inserted Feishu block tree does not match conversion");
    }
    matched.set(expectedId, actualId);
    const expectedChildren = Array.isArray(expectedBlock.children)
      ? expectedBlock.children.map(String)
      : [];
    const actualChildren = actualBlock.children || [];
    if (expectedChildren.length !== actualChildren.length) {
      throw new Error("Inserted Feishu block children do not match conversion");
    }
    expectedChildren.forEach((childId: string, index: number) =>
      match(childId, actualChildren[index]),
    );
  };
  converted.firstLevelBlockIds.forEach((rootId, index) =>
    match(rootId, actualRootBlockIds[index]),
  );
  return matched;
}
