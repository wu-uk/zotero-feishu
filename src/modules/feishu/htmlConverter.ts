import type { RichBlock } from "../types";
import {
  normalizeConvertedOrderedListItems,
  prepareConvertedBlocks,
  replaceConvertedImageMarkers,
  restoreConvertedEquations,
  type ConvertedBlocks,
} from "./blocks";
import { asObject, stringArray } from "./dto";
import { FeishuTransport } from "./transport";

type HtmlBlock = Extract<RichBlock, { type: "html" }>;

export class FeishuHtmlConverter {
  constructor(private readonly transport: FeishuTransport) {}

  async convert(block: HtmlBlock): Promise<ConvertedBlocks> {
    const converted = asObject(
      await this.transport.request(
        "POST",
        "/docx/v1/documents/blocks/convert",
        { content_type: "html", content: block.content },
      ),
    );
    const firstLevelBlockIds = stringArray(converted.first_level_block_ids);
    const descendants = prepareConvertedBlocks(
      Array.isArray(converted.blocks) ? converted.blocks : [],
    );
    if (descendants.length > 1000) {
      throw new Error("A converted note segment exceeds 1000 Feishu blocks");
    }
    let result: ConvertedBlocks = { firstLevelBlockIds, descendants };
    if (block.equations?.length) {
      result = restoreConvertedEquations(result, block.equations);
    }
    if (block.normalizeOrderedListItems) {
      result = normalizeConvertedOrderedListItems(result);
    }
    if (block.images?.length) {
      result = replaceConvertedImageMarkers(result, block.images);
    }
    return result;
  }
}
