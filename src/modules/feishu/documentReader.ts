import type { DocumentSnapshot, FeishuBlock } from "../types";
import { rootBlockIdsFromPreorder } from "./documentSnapshot";
import { asObject, numberValue, parseFeishuBlock, stringValue } from "./dto";
import { FeishuError, FeishuTransport } from "./transport";

export class FeishuDocumentReader {
  constructor(private readonly transport: FeishuTransport) {}

  async inspectDocument(
    documentId: string,
  ): Promise<DocumentSnapshot | undefined> {
    try {
      const data = asObject(
        await this.transport.request("GET", `/docx/v1/documents/${documentId}`),
      );
      const document = asObject(data.document);
      const returnedId = stringValue(document.document_id);
      const title =
        typeof document.title === "string" ? document.title : undefined;
      const revisionId = numberValue(document.revision_id);
      if (!returnedId || title === undefined || revisionId === undefined) {
        throw new Error("Feishu returned incomplete document metadata");
      }
      const blocks = await this.getChildren(documentId, documentId, true);
      return {
        documentId: returnedId,
        title,
        revisionId,
        rootBlockIds: rootBlockIdsFromPreorder(documentId, blocks),
        blocks,
      };
    } catch (error) {
      if (isMissingDocumentError(error)) return undefined;
      throw error;
    }
  }

  async getRootChildren(documentId: string): Promise<FeishuBlock[]> {
    return this.getChildren(documentId, documentId, false);
  }

  private async getChildren(
    documentId: string,
    parentBlockId: string,
    withDescendants: boolean,
  ): Promise<FeishuBlock[]> {
    const items: FeishuBlock[] = [];
    let pageToken = "";
    do {
      const parameters = new URLSearchParams({ page_size: "500" });
      if (withDescendants) parameters.set("with_descendants", "true");
      if (pageToken) parameters.set("page_token", pageToken);
      const data = asObject(
        await this.transport.request(
          "GET",
          `/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children?${parameters}`,
        ),
      );
      const pageItems = Array.isArray(data.items) ? data.items : [];
      items.push(...pageItems.map(parseFeishuBlock));
      pageToken = data.has_more ? stringValue(data.page_token) || "" : "";
    } while (pageToken);
    return items;
  }
}

function isMissingDocumentError(error: unknown): boolean {
  return (
    error instanceof FeishuError &&
    (error.status === 404 ||
      error.code === 1770002 ||
      error.code === 1770003 ||
      error.code === 3380003 ||
      error.code === 1061003 ||
      error.code === 1061007)
  );
}
