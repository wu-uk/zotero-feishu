import type {
  DocumentModel,
  DocumentSection,
  RichBlock,
  TextBlock,
  TextRun,
} from "./types";
import { noteHtmlToFragments, type NoteFragment } from "./zotero/noteConverter";
import {
  collectSource,
  type PdfAttachmentSource,
  type SourceData,
} from "./zotero/sourceCollector";

const DOCUMENT_SCHEMA_VERSION = 15;

export { noteHtmlToBlocks, noteHtmlToFragments } from "./zotero/noteConverter";

export async function buildDocument(item: Zotero.Item): Promise<DocumentModel> {
  const source = await collectSource(item);
  const sourceHash = await hashSource(source);
  const sections: DocumentSection[] = [];
  sections.push(
    await createSection(
      "source",
      [
        {
          type: "quote",
          runs: [
            { text: "Zotero source: ", style: { bold: true } },
            { text: source.key },
            { text: ` | Synced: ${new Date().toISOString()}` },
          ],
        },
        { type: "divider" },
      ],
      sourceHash,
    ),
    await createSection(
      "metadata",
      [
        {
          type: "callout",
          backgroundColor: 14,
          emojiId: "star",
          children: [
            metadataLine("Authors", source.authors),
            metadataLine("Year", source.year),
            metadataLine("Type", source.itemType),
            metadataLine("Publication", source.publication),
            metadataLine("DOI", source.doi, doiLink(source.doi)),
            metadataLine("URL", source.url, source.url),
            metadataLine("Tags", source.tags.join(", ")),
          ],
        },
      ],
      {
        authors: source.authors,
        year: source.year,
        itemType: source.itemType,
        publication: source.publication,
        doi: source.doi,
        url: source.url,
        tags: source.tags,
      },
    ),
  );

  if (source.abstract) {
    sections.push(
      await createSection(
        "abstract",
        [
          { type: "heading1", runs: [{ text: "Abstract" }] },
          { type: "paragraph", runs: [{ text: source.abstract }] },
        ],
        source.abstract,
      ),
    );
  }

  sections.push(
    await createSection(
      "notes",
      [
        { type: "heading1", runs: [{ text: "Notes" }] },
        ...(!source.notes.length
          ? [
              {
                type: "paragraph" as const,
                runs: [{ text: "No child notes." }],
              },
            ]
          : []),
      ],
      { empty: !source.notes.length },
    ),
  );
  for (const [index, note] of source.notes.entries()) {
    sections.push(...(await buildNoteSections(note, index)));
  }

  if (source.pdfs.length) {
    sections.push(
      await createSection(
        "pdf-attachments",
        pdfAttachmentsToBlocks(source.pdfs),
        source.pdfs,
      ),
    );
  }

  return {
    title: `[${source.year || "n.d."}] ${source.title || "Untitled"}`,
    sections,
    sourceHash,
  };
}

export async function buildNoteSections(
  note: SourceData["notes"][number],
  index: number,
): Promise<DocumentSection[]> {
  const title = note.title || `Note ${index + 1}`;
  const heading = await createSection(
    `note:${note.key}:heading`,
    [{ type: "heading2", runs: [{ text: title }] }],
    title,
  );
  const fragments = noteHtmlToFragments(note.html, note.title);
  return [heading, ...(await buildFragmentSections(note.key, fragments))];
}

export function pdfAttachmentsToBlocks(
  pdfs: Array<Pick<PdfAttachmentSource, "key" | "name">>,
): RichBlock[] {
  if (!pdfs.length) return [];
  return [
    { type: "heading1", runs: [{ text: "PDF Attachments" }] },
    ...pdfs.map((pdf) => ({
      type: "file" as const,
      attachmentKey: pdf.key,
      name: pdf.name,
    })),
  ];
}

function metadataLine(label: string, value: string, link?: string): TextBlock {
  const runs: TextRun[] = [{ text: `${label}: `, style: { bold: true } }];
  runs.push({ text: value || "-", ...(link ? { style: { link } } : {}) });
  return { type: "paragraph", runs };
}

function doiLink(doi: string): string | undefined {
  return doi
    ? `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`
    : undefined;
}

async function hashSource(source: SourceData): Promise<string> {
  return hashValue({ schemaVersion: DOCUMENT_SCHEMA_VERSION, source });
}

async function createSection(
  key: string,
  blocks: RichBlock[],
  source: unknown,
): Promise<DocumentSection> {
  return {
    key,
    blocks,
    sourceHash: await hashValue({
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      key,
      source,
    }),
  };
}

async function buildFragmentSections(
  noteKey: string,
  fragments: NoteFragment[],
): Promise<DocumentSection[]> {
  const sourceHashes = await Promise.all(
    fragments.map((fragment) =>
      hashValue({
        schemaVersion: DOCUMENT_SCHEMA_VERSION,
        type: "note-fragment",
        blocks: fragment.blocks,
      }),
    ),
  );
  const occurrences = new Map<string, number>();
  return fragments.map((fragment, index) => {
    const sourceHash = sourceHashes[index];
    const occurrence = (occurrences.get(sourceHash) || 0) + 1;
    occurrences.set(sourceHash, occurrence);
    return {
      key: `note:${noteKey}:fragment:${sourceHash}:${occurrence}`,
      sourceHash,
      blocks: fragment.blocks,
    };
  });
}

async function hashValue(value: unknown): Promise<string> {
  const win = Zotero.getMainWindow() as any;
  const bytes = new win.TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(
    await win.crypto.subtle.digest("SHA-256", bytes),
  );
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
