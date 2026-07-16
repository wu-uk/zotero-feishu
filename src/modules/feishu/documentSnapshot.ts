import { hashValue } from "../../utils/hash";
import type { DocumentSnapshot, FeishuBlock, SyncedSection } from "../types";

const VOLATILE_FIELDS = new Set([
  "block_id",
  "parent_id",
  "comment_ids",
  "revision_id",
  "document_revision_id",
  "create_time",
  "created_time",
  "update_time",
  "updated_time",
]);

export function snapshotBlockMap(
  snapshot: DocumentSnapshot,
): Map<string, FeishuBlock> {
  return new Map(snapshot.blocks.map((block) => [block.block_id, block]));
}

export async function remoteHashForSection(
  snapshot: DocumentSnapshot,
  section: Pick<SyncedSection, "blockIds">,
): Promise<string> {
  const blocks = snapshotBlockMap(snapshot);
  return hashValue(
    section.blockIds.map((blockId) =>
      canonicalBlock(blockId, blocks, new Set()),
    ),
  );
}

export function rootBlockIdsFromPreorder(
  documentId: string,
  blocks: FeishuBlock[],
): string[] {
  const explicit = blocks
    .filter((block) => block.parent_id === documentId)
    .map((block) => block.block_id);
  if (explicit.length) return explicit;

  const childIds = new Set(
    blocks.flatMap((block) =>
      Array.isArray(block.children) ? block.children : [],
    ),
  );
  return blocks
    .filter((block) => !childIds.has(block.block_id))
    .map((block) => block.block_id);
}

function canonicalBlock(
  blockId: string,
  blocks: Map<string, FeishuBlock>,
  ancestors: Set<string>,
): unknown {
  const block = blocks.get(blockId);
  if (!block) throw new Error(`Feishu block ${blockId} is missing`);
  if (ancestors.has(blockId)) {
    throw new Error(`Feishu block tree contains a cycle at ${blockId}`);
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(blockId);
  const canonical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (VOLATILE_FIELDS.has(key) || key === "children") continue;
    canonical[key] = stripVolatileFields(value);
  }
  canonical.children = (block.children || []).map((childId) =>
    canonicalBlock(childId, blocks, nextAncestors),
  );
  return canonical;
}

function stripVolatileFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatileFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !VOLATILE_FIELDS.has(key))
      .map(([key, child]) => [key, stripVolatileFields(child)]),
  );
}
