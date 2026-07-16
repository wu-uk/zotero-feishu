import { assert } from "chai";
import { planSectionSync } from "../src/modules/feishu/sectionSync";
import type { DocumentSection, SyncedSection } from "../src/modules/types";

describe("section sync planning", function () {
  it("replaces only changed sections while preserving unknown roots", function () {
    const previous = [
      synced("metadata", "metadata-v1", ["metadata"]),
      synced("note:A", "note-a-v1", ["note-a-heading", "note-a-body"]),
      synced("pdfs", "pdfs-v1", ["pdf-heading", "pdf-file"]),
    ];
    const desired = [
      section("metadata", "metadata-v1"),
      section("note:A", "note-a-v2"),
      section("pdfs", "pdfs-v1"),
    ];

    assert.deepEqual(
      planSectionSync(
        [
          "user-before",
          "metadata",
          "note-a-heading",
          "note-a-body",
          "user-middle",
          "pdf-heading",
          "pdf-file",
          "user-after",
        ],
        previous,
        desired,
        remoteHashes(previous),
      ),
      {
        deletions: [previous[1]],
        retained: [previous[0], previous[2]],
      },
    );
  });

  it("repairs a section whose remote content changed", function () {
    const previous = [synced("metadata", "metadata-v1", ["metadata"])];
    assert.deepEqual(
      planSectionSync(
        ["metadata"],
        previous,
        [section("metadata", "metadata-v1")],
        new Map([["metadata", "edited-remotely"]]),
      ),
      {
        deletions: previous,
        retained: [],
      },
    );
  });

  it("repairs a section with a missing or interleaved block", function () {
    const previous = [
      synced("note:A", "note-a-v1", ["note-heading", "note-body"]),
    ];
    assert.deepEqual(
      planSectionSync(
        ["note-heading", "user-block", "note-body"],
        previous,
        [section("note:A", "note-a-v1")],
        remoteHashes(previous),
      ),
      {
        deletions: previous,
        retained: [],
      },
    );
  });

  it("uses an LIS anchor and rebuilds only one moved section", function () {
    const previous = [
      synced("note:A", "note-a-v1", ["note-a"]),
      synced("note:B", "note-b-v1", ["note-b"]),
      synced("note:C", "note-c-v1", ["note-c"]),
    ];
    const plan = planSectionSync(
      ["note-a", "note-b", "note-c"],
      previous,
      [
        section("note:B", "note-b-v1"),
        section("note:A", "note-a-v1"),
        section("note:C", "note-c-v1"),
      ],
      remoteHashes(previous),
    );

    assert.lengthOf(plan.deletions, 1);
    assert.lengthOf(plan.retained, 2);
    assert.deepEqual(
      [...plan.deletions, ...plan.retained].map((value) => value.key).sort(),
      ["note:A", "note:B", "note:C"],
    );
  });

  it("forces migrated sections without remote hashes through local repair", function () {
    const migrated = {
      ...synced("metadata", "metadata-v1", ["metadata"]),
      remoteHash: "",
    };
    assert.deepEqual(
      planSectionSync(
        ["metadata", "user-block"],
        [migrated],
        [section("metadata", "metadata-v1")],
        new Map([["metadata", "remote-metadata"]]),
      ),
      {
        deletions: [migrated],
        retained: [],
      },
    );
  });
});

function section(key: string, sourceHash: string): DocumentSection {
  return {
    key,
    sourceHash,
    blocks: [{ type: "paragraph", runs: [{ text: key }] }],
  };
}

function synced(
  key: string,
  sourceHash: string,
  blockIds: string[],
): SyncedSection {
  return { key, sourceHash, remoteHash: `remote-${key}`, blockIds };
}

function remoteHashes(sections: SyncedSection[]): Map<string, string> {
  return new Map(sections.map((section) => [section.key, section.remoteHash]));
}
