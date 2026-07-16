import type { DocumentSection, SyncedSection } from "../types";

export interface SectionDeletion {
  startIndex: number;
  endIndex: number;
}

export type SectionSyncPlan =
  | { mode: "rebuild" }
  | {
      mode: "incremental";
      deletions: SectionDeletion[];
      retained: SyncedSection[];
    };

export function planSectionSync(
  rootBlockIds: string[],
  previous: SyncedSection[] | undefined,
  desired: DocumentSection[],
): SectionSyncPlan {
  if (
    !previous ||
    hasDuplicateKeys(previous) ||
    hasDuplicateKeys(desired) ||
    !sameValues(
      rootBlockIds,
      previous.flatMap((section) => section.blockIds),
    )
  ) {
    return { mode: "rebuild" };
  }

  const desiredByKey = new Map(
    desired.map((section) => [section.key, section]),
  );
  const retained = previous.filter(
    (section) =>
      desiredByKey.get(section.key)?.sourceHash === section.sourceHash,
  );
  const retainedKeys = retained.map((section) => section.key);
  const desiredRetainedKeys = desired
    .filter((section) =>
      retained.some((candidate) => candidate.key === section.key),
    )
    .map((section) => section.key);
  if (!sameValues(retainedKeys, desiredRetainedKeys)) {
    return { mode: "rebuild" };
  }

  let startIndex = 0;
  const deletions: SectionDeletion[] = [];
  for (const section of previous) {
    const endIndex = startIndex + section.blockIds.length;
    if (!retained.includes(section) && endIndex > startIndex) {
      deletions.push({ startIndex, endIndex });
    }
    startIndex = endIndex;
  }
  deletions.reverse();
  return { mode: "incremental", deletions, retained };
}

function hasDuplicateKeys(
  sections: Array<Pick<DocumentSection, "key">>,
): boolean {
  return (
    new Set(sections.map((section) => section.key)).size !== sections.length
  );
}

function sameValues(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
