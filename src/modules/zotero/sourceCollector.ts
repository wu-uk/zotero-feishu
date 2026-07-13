export interface PdfAttachmentSource {
  key: string;
  name: string;
  size: number;
  modifiedAt: number;
}

export interface SourceData {
  key: string;
  title: string;
  year: string;
  itemType: string;
  authors: string;
  publication: string;
  doi: string;
  url: string;
  abstract: string;
  tags: string[];
  notes: Array<{ title: string; html: string }>;
  pdfs: PdfAttachmentSource[];
}

export async function collectSource(item: Zotero.Item): Promise<SourceData> {
  const notes = item.getNotes().map((id: number, index: number) => {
    const note = Zotero.Items.get(id);
    const html = note?.getNote() || "";
    const title =
      typeof (note as any)?.getNoteTitle === "function"
        ? (note as any).getNoteTitle()
        : `Note ${index + 1}`;
    return { title: String(title || `Note ${index + 1}`), html };
  });
  const date = field(item, "date");
  const year = date.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/)?.[1] || "";
  const publication =
    field(item, "publicationTitle") || field(item, "publisher") || "";
  const creators = item.getCreators() as Array<{
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
  const pdfs = await collectPdfAttachments(item);
  return {
    key: item.key,
    title: field(item, "title"),
    year,
    itemType: Zotero.ItemTypes.getName(item.itemTypeID),
    authors: creators
      .map(
        (creator) =>
          creator.name ||
          [creator.firstName, creator.lastName].filter(Boolean).join(" "),
      )
      .filter(Boolean)
      .join(", "),
    publication,
    doi: field(item, "DOI"),
    url: field(item, "url"),
    abstract: field(item, "abstractNote"),
    tags: item.getTags().map((tag: { tag: string }) => tag.tag),
    notes,
    pdfs,
  };
}

async function collectPdfAttachments(
  item: Zotero.Item,
): Promise<PdfAttachmentSource[]> {
  const ioUtils = ztoolkit.getGlobal("IOUtils") as any;
  const attachments = item
    .getAttachments()
    .map((id) => Zotero.Items.get(id))
    .filter((attachment): attachment is Zotero.Item =>
      Boolean(attachment?.isPDFAttachment()),
    );

  return Promise.all(
    attachments.map(async (attachment) => {
      const path = await attachment.getFilePathAsync();
      let size = 0;
      let modifiedAt = 0;
      try {
        if (path) size = Number((await ioUtils.stat(path)).size || 0);
        modifiedAt = Number((await attachment.attachmentModificationTime) || 0);
      } catch (error) {
        ztoolkit.log(
          "Unable to read Zotero PDF attachment metadata",
          attachment.key,
          error,
        );
      }
      return {
        key: attachment.key,
        name:
          attachment.attachmentFilename ||
          attachment.getDisplayTitle() ||
          `${attachment.key}.pdf`,
        size,
        modifiedAt,
      };
    }),
  );
}

function field(item: Zotero.Item, name: string): string {
  const value = item.getField(name as any, false, true);
  return value ? String(value) : "";
}
