import type {
  CalloutBlock,
  DocumentSection,
  DocumentWriteResult,
  EquationSource,
  FeishuUser,
  RichBlock,
  SyncedSection,
} from "./types";
import { OAuthService } from "./oauthService";
import {
  createdFileBlockId,
  normalizeConvertedOrderedListItems,
  prepareCalloutBlock,
  prepareConvertedBlocks,
  restoreConvertedEquations,
  toFeishuBlock,
  type ConvertedBlocks,
} from "./feishu/blocks";
import { FeishuMediaUploader, type MediaKind } from "./feishu/media";
import { planSectionSync } from "./feishu/sectionSync";
import { FeishuError, FeishuTransport } from "./feishu/transport";

export { FeishuError } from "./feishu/transport";
export {
  createdFileBlockId,
  normalizeConvertedOrderedListItems,
  prepareCalloutBlock,
  prepareConvertedBlocks,
  restoreConvertedEquations,
} from "./feishu/blocks";
export { requireMediaFileToken } from "./feishu/media";

export interface CreatedDocument {
  documentId: string;
  documentUrl: string;
}

export class FeishuClient {
  private readonly transport: FeishuTransport;
  private readonly media: FeishuMediaUploader;

  constructor(oauth: OAuthService) {
    this.transport = new FeishuTransport(oauth);
    this.media = new FeishuMediaUploader(this.transport);
  }

  async getCurrentUser(): Promise<FeishuUser> {
    const data = await this.transport.request("GET", "/authen/v1/user_info");
    const name = String(data.name || data.en_name || data.open_id || "");
    const openId = String(data.open_id || "");
    if (!name) throw new Error("Feishu did not return the current user");
    return { name, openId };
  }

  async testConnection(folderToken: string): Promise<void> {
    if (!folderToken.trim()) {
      await this.getRootFolderToken();
      return;
    }
    const token = parseFolderToken(folderToken);
    await this.transport.request(
      "GET",
      `/drive/explorer/v2/folder/${encodeURIComponent(token)}/meta`,
    );
  }

  async createDocument(
    title: string,
    folderToken: string,
  ): Promise<CreatedDocument> {
    await this.transport.waitForDocumentWrite();
    const resolvedFolderToken = await this.resolveFolderToken(folderToken);
    const data = await this.transport.request("POST", "/docx/v1/documents", {
      title,
      folder_token: resolvedFolderToken,
    });
    const documentId = data.document?.document_id;
    if (!documentId) throw new Error("Feishu did not return a document ID");
    return {
      documentId,
      documentUrl: `https://feishu.cn/docx/${documentId}`,
    };
  }

  async documentExists(documentId: string): Promise<boolean> {
    try {
      await this.transport.request("GET", `/docx/v1/documents/${documentId}`);
      return true;
    } catch (error) {
      if (
        error instanceof FeishuError &&
        (error.status === 404 ||
          error.code === 1770002 ||
          error.code === 1770003 ||
          error.code === 3380003 ||
          error.code === 1061003 ||
          error.code === 1061007)
      ) {
        return false;
      }
      throw error;
    }
  }

  async syncDocumentSections(
    documentId: string,
    sections: DocumentSection[],
    previous: SyncedSection[] | undefined,
    resolveAttachment: (attachmentKey: string) => Promise<string>,
  ): Promise<DocumentWriteResult> {
    const rootBlockIds = (await this.getRootChildren(documentId)).map((block) =>
      String(block.block_id || ""),
    );
    const plan = planSectionSync(rootBlockIds, previous, sections);
    if (plan.mode === "rebuild") {
      return this.rebuildDocument(
        documentId,
        rootBlockIds.length,
        sections,
        resolveAttachment,
      );
    }

    const retainedKeys = new Set(plan.retained.map((section) => section.key));
    const changed = sections.filter(
      (section) => !retainedKeys.has(section.key),
    );
    const convertedSegments = await this.prepareConvertedSegments(changed);
    for (const deletion of plan.deletions) {
      await this.deleteChildRange(
        documentId,
        documentId,
        deletion.startIndex,
        deletion.endIndex,
      );
    }

    const writtenSections: SyncedSection[] = [];
    const errors: string[] = [];
    let retainedIndex = 0;
    let blockIndex = 0;
    for (const section of sections) {
      const retained = plan.retained[retainedIndex];
      if (retained?.key === section.key) {
        writtenSections.push(retained);
        retainedIndex++;
        blockIndex += retained.blockIds.length;
        continue;
      }
      const written = await this.writeSection(
        documentId,
        section,
        blockIndex,
        convertedSegments,
        resolveAttachment,
      );
      writtenSections.push(written.section);
      errors.push(...written.errors);
      blockIndex += written.section.blockIds.length;
    }
    return { sections: writtenSections, errors, rebuilt: false };
  }

  private async rebuildDocument(
    documentId: string,
    existingBlockCount: number,
    sections: DocumentSection[],
    resolveAttachment: (attachmentKey: string) => Promise<string>,
  ): Promise<DocumentWriteResult> {
    const convertedSegments = await this.prepareConvertedSegments(sections);
    await this.deleteChildRange(documentId, documentId, 0, existingBlockCount);
    const writtenSections: SyncedSection[] = [];
    const errors: string[] = [];
    let blockIndex = 0;
    for (const section of sections) {
      const written = await this.writeSection(
        documentId,
        section,
        blockIndex,
        convertedSegments,
        resolveAttachment,
      );
      writtenSections.push(written.section);
      errors.push(...written.errors);
      blockIndex += written.section.blockIds.length;
    }
    return { sections: writtenSections, errors, rebuilt: true };
  }

  private async writeSection(
    documentId: string,
    section: DocumentSection,
    startIndex: number,
    convertedSegments: Map<RichBlock, ConvertedBlocks>,
    resolveAttachment: (attachmentKey: string) => Promise<string>,
  ): Promise<{ section: SyncedSection; errors: string[] }> {
    const errors: string[] = [];
    const blockIds: string[] = [];
    let blockIndex = startIndex;
    let pending: any[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const created = await this.appendBlocks(
        documentId,
        pending,
        documentId,
        blockIndex,
      );
      const createdIds = requireCreatedBlockIds(created, pending.length);
      blockIds.push(...createdIds);
      blockIndex += createdIds.length;
      pending = [];
    };

    for (const block of section.blocks) {
      if (block.type === "html") {
        await flush();
        const createdIds = await this.appendConvertedBlocks(
          documentId,
          convertedSegments.get(block)!,
          blockIndex,
        );
        blockIds.push(...createdIds);
        blockIndex += createdIds.length;
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
        continue;
      }
      if (block.type !== "image" && block.type !== "file") {
        pending.push(toFeishuBlock(block));
        if (pending.length === 50) await flush();
        continue;
      }
      await flush();
      try {
        const path = await resolveAttachment(block.attachmentKey);
        const kind: MediaKind = block.type;
        const created = await this.appendBlocks(
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
          kind === "image"
            ? String(created[0]?.block_id || "")
            : createdFileBlockId(created);
        if (!blockId)
          throw new Error(`Feishu did not return a ${kind} block ID`);
        await this.media.upload(documentId, blockId, path, kind);
      } catch (error) {
        const label = block.type === "image" ? "Image" : "PDF";
        const name =
          block.type === "image"
            ? block.alt || block.attachmentKey
            : block.name || block.attachmentKey;
        const message = `${label} ${name}: ${errorMessage(error)}`;
        errors.push(message);
        const created = await this.appendBlocks(
          documentId,
          [
            toFeishuBlock({
              type: "paragraph",
              runs: [{ text: `[${message}]` }],
            }),
          ],
          documentId,
          blockIndex,
        );
        const createdIds = requireCreatedBlockIds(created, 1);
        blockIds.push(...createdIds);
        blockIndex += createdIds.length;
      }
    }
    await flush();
    if (!blockIds.length) {
      throw new Error(`Document section ${section.key} produced no blocks`);
    }
    return {
      section: {
        key: section.key,
        sourceHash: errors.length ? "" : section.sourceHash,
        blockIds,
      },
      errors,
    };
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.transport.request(
      "DELETE",
      `/drive/v1/files/${documentId}?type=docx`,
    );
  }

  private async resolveFolderToken(value: string): Promise<string> {
    if (value.trim()) return parseFolderToken(value);
    return this.getRootFolderToken();
  }

  private async getRootFolderToken(): Promise<string> {
    const data = await this.transport.request(
      "GET",
      "/drive/explorer/v2/root_folder/meta",
    );
    const token = String(data.token || "");
    if (!token) throw new Error("Feishu did not return a root folder token");
    return token;
  }

  private async getRootChildren(documentId: string): Promise<any[]> {
    return this.getChildren(documentId, documentId);
  }

  private async getChildren(
    documentId: string,
    parentBlockId: string,
  ): Promise<any[]> {
    const items: any[] = [];
    let pageToken = "";
    do {
      const suffix = pageToken
        ? `&page_token=${encodeURIComponent(pageToken)}`
        : "";
      const data = await this.transport.request(
        "GET",
        `/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children?page_size=500${suffix}`,
      );
      items.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token || "" : "";
    } while (pageToken);
    return items;
  }

  private async prepareConvertedSegments(
    sections: DocumentSection[],
  ): Promise<Map<RichBlock, ConvertedBlocks>> {
    const convertedSegments = new Map<RichBlock, ConvertedBlocks>();
    for (const section of sections) {
      for (const block of section.blocks) {
        if (block.type !== "html") continue;
        convertedSegments.set(
          block,
          await this.convertHtml(
            block.content,
            Boolean(block.normalizeOrderedListItems),
            block.equations || [],
          ),
        );
      }
    }
    return convertedSegments;
  }

  private async deleteChildRange(
    documentId: string,
    parentBlockId: string,
    startIndex: number,
    endIndex: number,
  ): Promise<void> {
    if (endIndex <= startIndex) return;
    await this.transport.waitForDocumentWrite();
    await this.transport.request(
      "DELETE",
      `/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children/batch_delete?document_revision_id=-1`,
      { start_index: startIndex, end_index: endIndex },
    );
  }

  private async appendBlocks(
    documentId: string,
    children: any[],
    parentBlockId = documentId,
    index = -1,
  ): Promise<any[]> {
    await this.transport.waitForDocumentWrite();
    const data = await this.transport.request(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children?document_revision_id=-1`,
      { index, children },
    );
    return data.children || [];
  }

  private async appendCallout(
    documentId: string,
    block: CalloutBlock,
    index: number,
  ): Promise<string[]> {
    const prepared = prepareCalloutBlock(block);
    await this.transport.waitForDocumentWrite();
    await this.transport.request(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${documentId}/descendant?document_revision_id=-1`,
      { index, ...prepared },
    );
    return this.getInsertedRootBlockIds(documentId, index, 1);
  }

  private async convertHtml(
    content: string,
    normalizeOrderedListItems: boolean,
    equations: EquationSource[],
  ): Promise<ConvertedBlocks> {
    const converted = await this.transport.request(
      "POST",
      "/docx/v1/documents/blocks/convert",
      { content_type: "html", content },
    );
    const firstLevelBlockIds = converted.first_level_block_ids || [];
    const descendants = prepareConvertedBlocks(converted.blocks || []);
    if (descendants.length > 1000) {
      throw new Error("A converted note segment exceeds 1000 Feishu blocks");
    }
    let result = { firstLevelBlockIds, descendants };
    if (equations.length) {
      result = restoreConvertedEquations(result, equations);
    }
    if (normalizeOrderedListItems) {
      result = normalizeConvertedOrderedListItems(result);
    }
    return result;
  }

  private async appendConvertedBlocks(
    documentId: string,
    converted: ConvertedBlocks,
    index: number,
  ): Promise<string[]> {
    const { firstLevelBlockIds, descendants } = converted;
    if (!firstLevelBlockIds.length || !descendants.length) return [];
    await this.transport.waitForDocumentWrite();
    await this.transport.request(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${documentId}/descendant?document_revision_id=-1`,
      {
        index,
        children_id: firstLevelBlockIds,
        descendants,
      },
    );
    return this.getInsertedRootBlockIds(
      documentId,
      index,
      firstLevelBlockIds.length,
    );
  }

  private async getInsertedRootBlockIds(
    documentId: string,
    index: number,
    count: number,
  ): Promise<string[]> {
    const ids = (await this.getRootChildren(documentId))
      .slice(index, index + count)
      .map((block) => String(block.block_id || ""))
      .filter(Boolean);
    if (ids.length !== count) {
      throw new Error("Feishu did not return the inserted root block IDs");
    }
    return ids;
  }
}

export function parseFolderToken(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/\/folder\/([A-Za-z0-9_-]+)/);
  const token = match?.[1] || trimmed;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Invalid Feishu folder URL or token");
  }
  return token;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireCreatedBlockIds(blocks: any[], expected: number): string[] {
  const ids = blocks
    .map((block) => String(block?.block_id || ""))
    .filter(Boolean);
  if (ids.length !== expected) {
    throw new Error("Feishu did not return the created block IDs");
  }
  return ids;
}
