import type { FeishuBlock } from "../types";

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && Boolean(item),
      )
    : [];
}

export function parseFeishuBlock(value: unknown): FeishuBlock {
  const block = asObject(value);
  const blockId = stringValue(block.block_id);
  const blockType = numberValue(block.block_type);
  if (!blockId || blockType === undefined) {
    throw new Error("Feishu returned an invalid document block");
  }
  return {
    ...block,
    block_id: blockId,
    block_type: blockType,
    ...(stringValue(block.parent_id)
      ? { parent_id: stringValue(block.parent_id) }
      : {}),
    ...(Array.isArray(block.children)
      ? { children: stringArray(block.children) }
      : {}),
    ...(Array.isArray(block.comment_ids)
      ? { comment_ids: stringArray(block.comment_ids) }
      : {}),
  };
}
