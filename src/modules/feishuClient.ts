import type {
  DocumentSection,
  DocumentSnapshot,
  DocumentWriteResult,
  FeishuUser,
  SyncedSection,
} from "./types";
import { OAuthService } from "./oauthService";
import { FeishuBlockWriter } from "./feishu/blockWriter";
import { FeishuDocumentReader } from "./feishu/documentReader";
import { asObject, stringValue } from "./feishu/dto";
import { FeishuHtmlConverter } from "./feishu/htmlConverter";
import { FeishuMediaUploader } from "./feishu/media";
import {
  FeishuSyncExecutor,
  type SectionCheckpoint,
} from "./feishu/syncExecutor";
import { FeishuTransport } from "./feishu/transport";

export { FeishuError } from "./feishu/transport";
export {
  createdFileBlockId,
  normalizeConvertedOrderedListItems,
  prepareCalloutBlock,
  prepareConvertedBlocks,
  replaceConvertedImageMarkers,
  restoreConvertedEquations,
} from "./feishu/blocks";
export { requireMediaFileToken } from "./feishu/media";

export interface CreatedDocument {
  documentId: string;
  documentUrl: string;
}

export class FeishuClient {
  private readonly transport: FeishuTransport;
  private readonly reader: FeishuDocumentReader;
  private readonly writer: FeishuBlockWriter;
  private readonly executor: FeishuSyncExecutor;

  constructor(oauth: OAuthService) {
    this.transport = new FeishuTransport(oauth);
    this.reader = new FeishuDocumentReader(this.transport);
    this.writer = new FeishuBlockWriter(this.transport);
    this.executor = new FeishuSyncExecutor(
      this.reader,
      this.writer,
      new FeishuHtmlConverter(this.transport),
      new FeishuMediaUploader(this.transport),
    );
  }

  async getCurrentUser(): Promise<FeishuUser> {
    const data = asObject(
      await this.transport.request("GET", "/authen/v1/user_info"),
    );
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
    const data = asObject(
      await this.transport.request("POST", "/docx/v1/documents", {
        title,
        folder_token: resolvedFolderToken,
      }),
    );
    const document = asObject(data.document);
    const documentId = stringValue(document.document_id);
    if (!documentId) throw new Error("Feishu did not return a document ID");
    return {
      documentId,
      documentUrl: `https://feishu.cn/docx/${documentId}`,
    };
  }

  inspectDocument(documentId: string): Promise<DocumentSnapshot | undefined> {
    return this.reader.inspectDocument(documentId);
  }

  updateDocumentTitle(documentId: string, title: string): Promise<void> {
    return this.writer.updateDocumentTitle(documentId, title);
  }

  syncDocumentSections(
    documentId: string,
    sections: DocumentSection[],
    previous: SyncedSection[] | undefined,
    resolveAttachment: (attachmentKey: string) => Promise<string>,
    checkpoint: SectionCheckpoint = async () => undefined,
    initialSnapshot?: DocumentSnapshot,
  ): Promise<DocumentWriteResult> {
    return this.executor.syncDocumentSections(
      documentId,
      sections,
      previous,
      resolveAttachment,
      checkpoint,
      initialSnapshot,
    );
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
    const data = asObject(
      await this.transport.request(
        "GET",
        "/drive/explorer/v2/root_folder/meta",
      ),
    );
    const token = stringValue(data.token);
    if (!token) throw new Error("Feishu did not return a root folder token");
    return token;
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
