import type { CalloutBlock, RichBlock, TextBlock, TextRun } from "./types";
import { OAuthService } from "./oauthService";

const API = "https://open.feishu.cn/open-apis";
const SIMPLE_UPLOAD_LIMIT = 20 * 1024 * 1024;
const PART_SIZE = 4 * 1024 * 1024;

export class FeishuError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: number,
  ) {
    super(message);
  }
}

export interface CreatedDocument {
  documentId: string;
  documentUrl: string;
}

interface ConvertedBlocks {
  firstLevelBlockIds: string[];
  descendants: any[];
}

export class FeishuClient {
  private documentReadyAt = 0;
  private mediaReadyAt = 0;

  constructor(private readonly oauth: OAuthService) {}

  async testConnection(folderToken: string): Promise<void> {
    if (!folderToken.trim()) {
      await this.getRootFolderToken();
      return;
    }
    const token = parseFolderToken(folderToken);
    await this.request(
      "GET",
      `/drive/explorer/v2/folder/${encodeURIComponent(token)}/meta`,
    );
  }

  async createDocument(
    title: string,
    folderToken: string,
  ): Promise<CreatedDocument> {
    await this.documentRateLimit();
    const resolvedFolderToken = await this.resolveFolderToken(folderToken);
    const data = await this.request("POST", "/docx/v1/documents", {
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
      await this.request("GET", `/docx/v1/documents/${documentId}`);
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
    resolveImage: (attachmentKey: string) => Promise<string>,
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
      if (block.type !== "image") {
        pending.push(toFeishuBlock(block));
        if (pending.length === 50) await flush();
        continue;
      }
      await flush();
      try {
        const path = await resolveImage(block.attachmentKey);
        const [created] = await this.appendBlocks(documentId, [
          { block_type: 27, image: {} },
        ]);
        const blockId = created?.block_id;
        if (!blockId)
          throw new Error("Feishu did not return an image block ID");
        await this.uploadImage(documentId, blockId, path);
      } catch (error) {
        const message = `Image ${block.alt || block.attachmentKey}: ${errorMessage(error)}`;
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
    await this.request("DELETE", `/drive/v1/files/${documentId}?type=docx`);
  }

  private async resolveFolderToken(value: string): Promise<string> {
    if (value.trim()) return parseFolderToken(value);
    return this.getRootFolderToken();
  }

  private async getRootFolderToken(): Promise<string> {
    const data = await this.request(
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
      const data = await this.request(
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
    await this.documentRateLimit();
    await this.request(
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
    await this.documentRateLimit();
    const data = await this.request(
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
    await this.documentRateLimit();
    await this.request(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${documentId}/descendant?document_revision_id=-1`,
      { index: -1, ...prepared },
    );
  }

  private async convertHtml(content: string): Promise<ConvertedBlocks> {
    const converted = await this.request(
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
    await this.documentRateLimit();
    await this.request(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${documentId}/descendant?document_revision_id=-1`,
      {
        index: -1,
        children_id: firstLevelBlockIds,
        descendants,
      },
    );
  }

  private async uploadImage(
    documentId: string,
    blockId: string,
    path: string,
  ): Promise<void> {
    const ioUtils = ztoolkit.getGlobal("IOUtils") as any;
    const bytes = (await ioUtils.read(path)) as Uint8Array;
    const pathUtils = ztoolkit.getGlobal("PathUtils") as any;
    const name = pathUtils.filename(path);
    let uploaded: any;
    if (bytes.byteLength <= SIMPLE_UPLOAD_LIMIT) {
      const form = mediaForm(name, blockId, documentId, bytes);
      uploaded = await this.mediaRequest("/drive/v1/medias/upload_all", form);
    } else {
      const prepared = await this.request(
        "POST",
        "/drive/v1/medias/upload_prepare",
        {
          file_name: name,
          parent_type: "docx_image",
          parent_node: blockId,
          size: bytes.byteLength,
          extra: JSON.stringify({ drive_route_token: documentId }),
        },
      );
      const uploadId = prepared.upload_id;
      const blockSize = Number(prepared.block_size || PART_SIZE);
      const blockNum = Number(
        prepared.block_num || Math.ceil(bytes.length / blockSize),
      );
      for (let seq = 0; seq < blockNum; seq++) {
        const part = bytes.slice(
          seq * blockSize,
          Math.min((seq + 1) * blockSize, bytes.length),
        );
        const win = Zotero.getMainWindow() as any;
        const formData = new win.FormData();
        formData.append("upload_id", uploadId);
        formData.append("seq", String(seq));
        formData.append("size", String(part.byteLength));
        formData.append(
          "file",
          new win.Blob([part], { type: imageMimeType(name) }),
          name,
        );
        await this.mediaRequest("/drive/v1/medias/upload_part", formData);
      }
      uploaded = await this.request("POST", "/drive/v1/medias/upload_finish", {
        upload_id: uploadId,
        block_num: blockNum,
      });
    }
    const fileToken = requireMediaFileToken(uploaded);
    await this.documentRateLimit();
    await this.request(
      "PATCH",
      `/docx/v1/documents/${documentId}/blocks/${blockId}?document_revision_id=-1`,
      { replace_image: { token: fileToken } },
    );
  }

  private async mediaRequest(path: string, body: FormData): Promise<any> {
    await this.mediaRateLimit();
    return this.retry(async () => {
      const token = await this.oauth.getAccessToken();
      const response = await (Zotero.getMainWindow() as any).fetch(
        `${API}${path}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body,
        },
      );
      const data = (await response.json()) as any;
      if (!response.ok || data.code) {
        throw new FeishuError(
          data.msg || `Feishu request failed (${response.status})`,
          response.status,
          data.code,
        );
      }
      return data.data || {};
    });
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    return this.retry(async () => {
      const token = await this.oauth.getAccessToken();
      try {
        const response = await Zotero.HTTP.request(method, `${API}${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: body ? JSON.stringify(body) : undefined,
          responseType: "json",
          successCodes: false,
        } as any);
        const data = parseResponse(response);
        const status = Number(response.status || 200);
        if (status < 200 || status >= 300 || data.code) {
          throw new FeishuError(
            data.msg || `Feishu request failed (${status})`,
            status,
            data.code,
          );
        }
        return data.data || {};
      } catch (error) {
        if (error instanceof FeishuError) throw error;
        const xhr = (error as any)?.xmlhttp;
        if (xhr) {
          const data = parseResponse(xhr);
          throw new FeishuError(
            data.msg || `Feishu request failed (${xhr.status})`,
            Number(xhr.status),
            data.code,
          );
        }
        throw error;
      }
    });
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryable(error) || attempt >= 4) throw error;
        const delay = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
        attempt++;
        await Zotero.Promise.delay(delay);
      }
    }
  }

  private async documentRateLimit(): Promise<void> {
    const wait = Math.max(0, this.documentReadyAt - Date.now());
    if (wait) await Zotero.Promise.delay(wait);
    this.documentReadyAt = Date.now() + 350;
  }

  private async mediaRateLimit(): Promise<void> {
    const wait = Math.max(0, this.mediaReadyAt - Date.now());
    if (wait) await Zotero.Promise.delay(wait);
    this.mediaReadyAt = Date.now() + 220;
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

function mediaForm(
  name: string,
  blockId: string,
  documentId: string,
  bytes: Uint8Array,
): FormData {
  const win = Zotero.getMainWindow() as any;
  const form = new win.FormData();
  form.append("file_name", name);
  form.append("parent_type", "docx_image");
  form.append("parent_node", blockId);
  form.append("size", String(bytes.byteLength));
  form.append("extra", JSON.stringify({ drive_route_token: documentId }));
  form.append(
    "file",
    new win.Blob([bytes], { type: imageMimeType(name) }),
    name,
  );
  return form;
}

export function requireMediaFileToken(data: any): string {
  const token = String(data?.file_token || "");
  if (!token) throw new Error("Feishu did not return an image file token");
  return token;
}

function imageMimeType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  return (
    {
      avif: "image/avif",
      bmp: "image/bmp",
      gif: "image/gif",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      png: "image/png",
      svg: "image/svg+xml",
      webp: "image/webp",
    }[extension || ""] || "application/octet-stream"
  );
}

export function prepareCalloutBlock(
  block: CalloutBlock,
  calloutId = temporaryBlockId(),
): { children_id: string[]; descendants: any[] } {
  const childIds = block.children.map(
    (_, index) => `${calloutId}_child_${index}`,
  );
  return {
    children_id: [calloutId],
    descendants: [
      {
        block_id: calloutId,
        block_type: 19,
        callout: {
          ...(block.backgroundColor
            ? { background_color: block.backgroundColor }
            : {}),
          ...(block.borderColor ? { border_color: block.borderColor } : {}),
          ...(block.textColor ? { text_color: block.textColor } : {}),
          ...(block.emojiId ? { emoji_id: block.emojiId } : {}),
        },
        children: childIds,
      },
      ...block.children.map((child, index) => ({
        block_id: childIds[index],
        ...toFeishuBlock(child),
        children: [],
      })),
    ],
  };
}

function temporaryBlockId(): string {
  return `tmp_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function toFeishuBlock(block: TextBlock | { type: "divider" }): any {
  if (block.type === "divider") return { block_type: 22, divider: {} };
  const mapping: Record<string, [number, string]> = {
    paragraph: [2, "text"],
    heading1: [3, "heading1"],
    heading2: [4, "heading2"],
    heading3: [5, "heading3"],
    heading4: [6, "heading4"],
    heading5: [7, "heading5"],
    heading6: [8, "heading6"],
    bullet: [12, "bullet"],
    ordered: [13, "ordered"],
    code: [14, "code"],
    quote: [15, "quote"],
  };
  const [blockType, property] = mapping[block.type];
  return {
    block_type: blockType,
    [property]: { elements: block.runs.map(toTextElement), style: {} },
  };
}

export function prepareConvertedBlocks(blocks: any[]): any[] {
  return blocks.map((source) => {
    const block = JSON.parse(JSON.stringify(source));
    if (block.block_type === 31 && block.table?.property) {
      delete block.table.property.merge_info;
    }
    return block;
  });
}

function toTextElement(run: TextRun): any {
  const style = run.style || {};
  return {
    text_run: {
      content: run.text,
      text_element_style: {
        bold: Boolean(style.bold),
        italic: Boolean(style.italic),
        strikethrough: Boolean(style.strikethrough),
        underline: Boolean(style.underline),
        inline_code: Boolean(style.inlineCode),
        ...(style.link
          ? { link: { url: encodeURIComponent(style.link) } }
          : {}),
      },
    },
  };
}

function parseResponse(request: any): any {
  if (request.response && typeof request.response === "object") {
    return request.response;
  }
  try {
    return JSON.parse(request.responseText || "{}");
  } catch {
    return {};
  }
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof FeishuError)) return false;
  return (
    error.status === 429 ||
    Boolean(error.status && error.status >= 500) ||
    error.code === 99991400 ||
    error.code === 1061045
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
