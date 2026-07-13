import type { CalloutBlock, RichBlock } from "./types";
import { OAuthService } from "./oauthService";
import {
  createdFileBlockId,
  prepareCalloutBlock,
  prepareConvertedBlocks,
  toFeishuBlock,
  type ConvertedBlocks,
} from "./feishu/blocks";
import { FeishuMediaUploader, type MediaKind } from "./feishu/media";
import { FeishuError, FeishuTransport } from "./feishu/transport";

export { FeishuError } from "./feishu/transport";
export {
  createdFileBlockId,
  prepareCalloutBlock,
  prepareConvertedBlocks,
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

  async replaceDocument(
    documentId: string,
    blocks: RichBlock[],
    resolveAttachment: (attachmentKey: string) => Promise<string>,
  ): Promise<string[]> {
    const errors: string[] = [];
    const convertedSegments = new Map<RichBlock, ConvertedBlocks>();
    for (const block of blocks) {
      if (block.type === "html") {
        convertedSegments.set(block, await this.convertHtml(block.content));
      }
    }

    const existing = await this.getRootChildren(documentId);
    await this.deleteChildren(documentId, documentId, existing.length);

    let pending: any[] = [];
    const flush = async () => {
      if (!pending.length) return;
      await this.appendBlocks(documentId, pending);
      pending = [];
    };

    for (const block of blocks) {
      if (block.type === "html") {
        await flush();
        await this.appendConvertedBlocks(
          documentId,
          convertedSegments.get(block)!,
        );
        continue;
      }
      if (block.type === "callout") {
        await flush();
        await this.appendCallout(documentId, block);
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
        const created = await this.appendBlocks(documentId, [
          kind === "image"
            ? { block_type: 27, image: {} }
            : { block_type: 23, file: { token: "" } },
        ]);
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
        await this.appendBlocks(documentId, [
          toFeishuBlock({
            type: "paragraph",
            runs: [{ text: `[${message}]` }],
          }),
        ]);
      }
    }
    await flush();
    return errors;
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

  private async deleteChildren(
    documentId: string,
    parentBlockId: string,
    count: number,
  ): Promise<void> {
    if (!count) return;
    await this.transport.waitForDocumentWrite();
    await this.transport.request(
      "DELETE",
      `/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children/batch_delete?document_revision_id=-1`,
      { start_index: 0, end_index: count },
    );
  }

  private async appendBlocks(
    documentId: string,
    children: any[],
    parentBlockId = documentId,
  ): Promise<any[]> {
    await this.transport.waitForDocumentWrite();
    const data = await this.transport.request(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children?document_revision_id=-1`,
      { index: -1, children },
    );
    return data.children || [];
  }

  private async appendCallout(
    documentId: string,
    block: CalloutBlock,
  ): Promise<void> {
    const prepared = prepareCalloutBlock(block);
    await this.transport.waitForDocumentWrite();
    await this.transport.request(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${documentId}/descendant?document_revision_id=-1`,
      { index: -1, ...prepared },
    );
  }

  private async convertHtml(content: string): Promise<ConvertedBlocks> {
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
    return { firstLevelBlockIds, descendants };
  }

  private async appendConvertedBlocks(
    documentId: string,
    converted: ConvertedBlocks,
  ): Promise<void> {
    const { firstLevelBlockIds, descendants } = converted;
    if (!firstLevelBlockIds.length || !descendants.length) return;
    await this.transport.waitForDocumentWrite();
    await this.transport.request(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${documentId}/descendant?document_revision_id=-1`,
      {
        index: -1,
        children_id: firstLevelBlockIds,
        descendants,
      },
    );
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
