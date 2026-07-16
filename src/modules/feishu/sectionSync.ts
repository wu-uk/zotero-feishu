import type { DocumentSection, SyncedSection } from "../types";

export interface SectionSyncPlan {
  deletions: SyncedSection[];
  retained: SyncedSection[];
}

export function planSectionSync(
  rootBlockIds: string[],
  previous: SyncedSection[] | undefined,
  desired: DocumentSection[],
  currentRemoteHashes: ReadonlyMap<string, string>,
): SectionSyncPlan {
  const stored = previous || [];
  const duplicateStoredKeys = duplicateKeys(stored);
  const duplicateDesiredKeys = duplicateKeys(desired);
  const desiredIndex = new Map(
    desired.map((section, index) => [section.key, index]),
  );
  const desiredByKey = new Map(
    desired.map((section) => [section.key, section]),
  );
  const blockUseCount = new Map<string, number>();
  stored.forEach((section) =>
    section.blockIds.forEach((blockId) =>
      blockUseCount.set(blockId, (blockUseCount.get(blockId) || 0) + 1),
    ),
  );

  const candidates = stored
    .map((section) => ({
      section,
      rootIndex: contiguousRootIndex(rootBlockIds, section.blockIds),
    }))
    .filter(({ section, rootIndex }) => {
      const desiredSection = desiredByKey.get(section.key);
      return Boolean(
        rootIndex >= 0 &&
        desiredSection &&
        !duplicateStoredKeys.has(section.key) &&
        !duplicateDesiredKeys.has(section.key) &&
        section.blockIds.length &&
        section.blockIds.every((blockId) => blockUseCount.get(blockId) === 1) &&
        section.sourceHash &&
        section.remoteHash &&
        desiredSection.sourceHash === section.sourceHash &&
        currentRemoteHashes.get(section.key) === section.remoteHash,
      );
    })
    .sort((left, right) => left.rootIndex - right.rootIndex);

  const retainedInCurrentOrder = longestIncreasingSubsequence(
    candidates,
    ({ section }) => desiredIndex.get(section.key) ?? -1,
  ).map(({ section }) => section);
  const retainedKeys = new Set(
    retainedInCurrentOrder.map((section) => section.key),
  );
  return {
    retained: desired
      .filter((section) => retainedKeys.has(section.key))
      .map((section) => stored.find((stored) => stored.key === section.key)!),
    deletions: stored.filter((section) => !retainedKeys.has(section.key)),
  };
}

function contiguousRootIndex(
  rootBlockIds: string[],
  blockIds: string[],
): number {
  if (!blockIds.length) return -1;
  const start = rootBlockIds.indexOf(blockIds[0]);
  if (start < 0) return -1;
  return blockIds.every(
    (blockId, offset) => rootBlockIds[start + offset] === blockId,
  )
    ? start
    : -1;
}

function duplicateKeys(
  sections: Array<Pick<DocumentSection, "key">>,
): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  sections.forEach((section) => {
    if (seen.has(section.key)) duplicates.add(section.key);
    seen.add(section.key);
  });
  return duplicates;
}

function longestIncreasingSubsequence<T>(
  values: T[],
  rank: (value: T) => number,
): T[] {
  const tails: number[] = [];
  const tailIndices: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  values.forEach((value, index) => {
    const valueRank = rank(value);
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle] < valueRank) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tailIndices[low - 1];
    tails[low] = valueRank;
    tailIndices[low] = index;
  });
  if (!tailIndices.length) return [];
  const indices: number[] = [];
  let index = tailIndices[tailIndices.length - 1];
  while (index >= 0) {
    indices.push(index);
    index = previous[index];
  }
  return indices.reverse().map((valueIndex) => values[valueIndex]);
}
