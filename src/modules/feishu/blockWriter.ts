import { asObject, numberValue, stringValue } from "./dto";
import { FeishuTransport } from "./transport";

export interface CreatedFeishuBlock {
  block_id: string;
  block_type: number;
  parent_id?: string;
  children?: Array<string | CreatedFeishuBlock>;
  [property: string]: unknown;
}

export class FeishuBlockWriter {
  constructor(private readonly transport: FeishuTransport) {}

  async updateDocumentTitle(documentId: string, title: string): Promise<void> {
    await this.transport.waitForDocumentWrite();
    await this.transport.request(
      "PATCH",
      `/docx/v1/documents/${documentId}/blocks/${documentId}?document_revision_id=-1`,
      {
        update_text_elements: {
          elements: [
            {
              text_run: {
                content: title,
                text_element_style: {},
              },
            },
          ],
        },
      },
    );
  }

  async deleteChildRange(
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

  async appendBlocks(
    documentId: string,
    children: unknown[],
    parentBlockId = documentId,
    index = -1,
  ): Promise<CreatedFeishuBlock[]> {
    await this.transport.waitForDocumentWrite();
    const data = await this.transport.request(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children?document_revision_id=-1`,
      { index, children },
    );
    return (Array.isArray(data.children) ? data.children : []).map(
      parseCreatedBlock,
    );
  }

  async appendDescendants(
    documentId: string,
    index: number,
    childrenId: string[],
    descendants: unknown[],
  ): Promise<CreatedFeishuBlock[]> {
    await this.transport.waitForDocumentWrite();
    const data = await this.transport.request(
      "POST",
      `/docx/v1/documents/${documentId}/blocks/${documentId}/descendant?document_revision_id=-1`,
      { index, children_id: childrenId, descendants },
    );
    return (Array.isArray(data.children) ? data.children : []).map(
      parseCreatedBlock,
    );
  }
}

function parseCreatedBlock(value: unknown): CreatedFeishuBlock {
  const block = asObject(value);
  const blockId = stringValue(block.block_id);
  const blockType = numberValue(block.block_type);
  if (!blockId || blockType === undefined) {
    throw new Error("Feishu returned an invalid created block");
  }
  return {
    ...block,
    block_id: blockId,
    block_type: blockType,
    ...(stringValue(block.parent_id)
      ? { parent_id: stringValue(block.parent_id) }
      : {}),
    ...(Array.isArray(block.children)
      ? {
          children: block.children.map((child) =>
            typeof child === "string" ? child : parseCreatedBlock(child),
          ),
        }
      : {}),
  };
}
