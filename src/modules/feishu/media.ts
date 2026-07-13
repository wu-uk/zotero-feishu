import { FeishuTransport } from "./transport";

const SIMPLE_UPLOAD_LIMIT = 20 * 1024 * 1024;
const PART_SIZE = 4 * 1024 * 1024;

export type MediaKind = "file" | "image";

export class FeishuMediaUploader {
  constructor(private readonly transport: FeishuTransport) {}

  async upload(
    documentId: string,
    blockId: string,
    path: string,
    kind: MediaKind,
  ): Promise<void> {
    const ioUtils = ztoolkit.getGlobal("IOUtils") as any;
    const pathUtils = ztoolkit.getGlobal("PathUtils") as any;
    const name = safeMediaFileName(pathUtils.filename(path));
    const size = Number((await ioUtils.stat(path)).size);
    const parentType = kind === "image" ? "docx_image" : "docx_file";
    let uploaded: any;
    if (size <= SIMPLE_UPLOAD_LIMIT) {
      const bytes = (await ioUtils.read(path)) as Uint8Array;
      const form = mediaForm(name, blockId, documentId, parentType, bytes);
      uploaded = await this.transport.mediaRequest(
        "/drive/v1/medias/upload_all",
        form,
      );
    } else {
      const prepared = await this.transport.request(
        "POST",
        "/drive/v1/medias/upload_prepare",
        {
          file_name: name,
          parent_type: parentType,
          parent_node: blockId,
          size,
          extra: JSON.stringify({ drive_route_token: documentId }),
        },
      );
      const uploadId = prepared.upload_id;
      if (!uploadId) throw new Error("Feishu did not return an upload ID");
      const blockSize = Number(prepared.block_size || PART_SIZE);
      const blockNum = Number(
        prepared.block_num || Math.ceil(size / blockSize),
      );
      for (let seq = 0; seq < blockNum; seq++) {
        const offset = seq * blockSize;
        const part = (await ioUtils.read(path, {
          offset,
          maxBytes: Math.min(blockSize, size - offset),
        })) as Uint8Array;
        const win = Zotero.getMainWindow() as any;
        const formData = new win.FormData();
        formData.append("upload_id", uploadId);
        formData.append("seq", String(seq));
        formData.append("size", String(part.byteLength));
        formData.append(
          "file",
          new win.Blob([part], { type: mediaMimeType(name) }),
          name,
        );
        await this.transport.mediaRequest(
          "/drive/v1/medias/upload_part",
          formData,
        );
      }
      uploaded = await this.transport.request(
        "POST",
        "/drive/v1/medias/upload_finish",
        {
          upload_id: uploadId,
          block_num: blockNum,
        },
      );
    }
    const fileToken = requireMediaFileToken(uploaded);
    await this.transport.waitForDocumentWrite();
    await this.transport.request(
      "PATCH",
      `/docx/v1/documents/${documentId}/blocks/${blockId}?document_revision_id=-1`,
      kind === "image"
        ? { replace_image: { token: fileToken } }
        : { replace_file: { token: fileToken } },
    );
  }
}

export function requireMediaFileToken(data: any): string {
  const token = String(data?.file_token || "");
  if (!token) throw new Error("Feishu did not return a media file token");
  return token;
}

function mediaForm(
  name: string,
  blockId: string,
  documentId: string,
  parentType: "docx_file" | "docx_image",
  bytes: Uint8Array,
): FormData {
  const win = Zotero.getMainWindow() as any;
  const form = new win.FormData();
  form.append("file_name", name);
  form.append("parent_type", parentType);
  form.append("parent_node", blockId);
  form.append("size", String(bytes.byteLength));
  form.append("extra", JSON.stringify({ drive_route_token: documentId }));
  form.append(
    "file",
    new win.Blob([bytes], { type: mediaMimeType(name) }),
    name,
  );
  return form;
}

function safeMediaFileName(name: string): string {
  if (name.length <= 250) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${name.slice(0, 250 - extension.length)}${extension}`;
}

function mediaMimeType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  return (
    {
      avif: "image/avif",
      bmp: "image/bmp",
      gif: "image/gif",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      png: "image/png",
      pdf: "application/pdf",
      svg: "image/svg+xml",
      webp: "image/webp",
    }[extension || ""] || "application/octet-stream"
  );
}
