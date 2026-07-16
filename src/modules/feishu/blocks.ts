import type {
  CalloutBlock,
  EmbeddedImageSource,
  EquationSource,
  TextBlock,
  TextRun,
} from "../types";

export interface ConvertedBlocks {
  firstLevelBlockIds: string[];
  descendants: any[];
  imageBlocks?: ConvertedImageBlock[];
}

export interface ConvertedImageBlock {
  temporaryBlockId: string;
  source: EmbeddedImageSource;
}

export function createdFileBlockId(blocks: any[]): string {
  const file = blocks.find(
    (block) => block?.block_type === 23 && block.block_id,
  );
  if (file) return String(file.block_id);

  const view = blocks.find((block) => block?.block_type === 33);
  const child = view?.children?.[0];
  if (typeof child === "string" && child) return child;
  if (child && typeof child === "object") {
    return createdFileBlockId([child]);
  }
  throw new Error("Feishu did not return a file block ID");
}

export function prepareCalloutBlock(
  block: CalloutBlock,
  calloutId = temporaryBlockId(),
): { children_id: string[]; descendants: any[] } {
  const childIds = block.children.map(
    (_, index) => `${calloutId}_child_${index}`,
  );
  return {
    children_id: [calloutId],
    descendants: [
      {
        block_id: calloutId,
        block_type: 19,
        callout: {
          ...(block.backgroundColor
            ? { background_color: block.backgroundColor }
            : {}),
          ...(block.borderColor ? { border_color: block.borderColor } : {}),
          ...(block.textColor ? { text_color: block.textColor } : {}),
          ...(block.emojiId ? { emoji_id: block.emojiId } : {}),
        },
        children: childIds,
      },
      ...block.children.map((child, index) => ({
        block_id: childIds[index],
        ...toFeishuBlock(child),
        children: [],
      })),
    ],
  };
}

export function prepareConvertedBlocks(blocks: any[]): any[] {
  return blocks.map((source) => {
    const block = JSON.parse(JSON.stringify(source));
    if (block.block_type === 31 && block.table?.property) {
      delete block.table.property.merge_info;
    }
    return block;
  });
}

export function normalizeConvertedOrderedListItems(
  converted: ConvertedBlocks,
): ConvertedBlocks {
  const descendants = converted.descendants;
  const byId = new Map(
    descendants.map((block) => [String(block.block_id || ""), block]),
  );
  const roots = converted.firstLevelBlockIds;
  const normalizedRoots: string[] = [];

  for (let index = 0; index < roots.length;) {
    const anchorId = roots[index];
    const anchor = byId.get(anchorId);
    if (!isExplicitOrderedBlock(anchor)) {
      normalizedRoots.push(anchorId);
      index++;
      continue;
    }

    normalizedRoots.push(anchorId);
    const children = Array.isArray(anchor.children) ? [...anchor.children] : [];
    index++;
    while (index < roots.length) {
      const childId = roots[index];
      const child = byId.get(childId);
      if (isExplicitOrderedBlock(child)) break;

      children.push(childId);
      if (isAutomaticOrderedBlock(child)) {
        const nested = Array.isArray(child.children) ? [...child.children] : [];
        convertOrderedBlockToText(child);
        delete child.children;
        children.push(...nested);
      }
      index++;
    }
    if (children.length) anchor.children = children;
  }

  return { ...converted, firstLevelBlockIds: normalizedRoots, descendants };
}

export function replaceConvertedImageMarkers(
  converted: ConvertedBlocks,
  images: EmbeddedImageSource[],
): ConvertedBlocks {
  if (!images.length) return converted;
  const sources = new Map(images.map((image) => [image.marker, image]));
  const replacements = new Map<string, any[]>();
  const imageBlocks: ConvertedImageBlock[] = [];

  for (const block of converted.descendants) {
    const text = textBlockContent(block);
    if (!text?.elements) continue;
    const tokens = splitImageElements(text.elements, sources);
    if (!tokens.some((token) => token.image)) continue;
    const blockId = String(block.block_id || "");
    if (!blockId) {
      throw new Error("Converted Feishu block is missing its temporary ID");
    }
    const originalChildren = Array.isArray(block.children)
      ? [...block.children]
      : [];
    if (block.block_type === 12 || block.block_type === 13) {
      const [first, ...remaining] = tokens;
      const children: string[] = [];
      if (first?.elements) text.elements = first.elements;
      else text.elements = [];
      for (const token of first?.image ? tokens : remaining) {
        const child = tokenBlock(block, token, imageBlocks, true);
        children.push(child.block_id);
        converted.descendants.push(child);
      }
      block.children = [...children, ...originalChildren];
      continue;
    }

    const blocks = tokens.map((token) =>
      tokenBlock(block, token, imageBlocks, false),
    );
    const childHost = [...blocks]
      .reverse()
      .find((candidate) => candidate.block_type !== 27);
    if (originalChildren.length) {
      if (!childHost) {
        const host = cloneTextBlock(block, temporaryBlockId(), []);
        blocks.push(host);
      }
      const resolvedHost = childHost || blocks[blocks.length - 1];
      resolvedHost.children = originalChildren;
    }
    replacements.set(blockId, blocks);
  }

  if (!replacements.size && !imageBlocks.length) {
    throw new Error(
      "Feishu conversion did not preserve embedded image markers",
    );
  }
  for (const block of converted.descendants) {
    if (!Array.isArray(block.children)) continue;
    block.children = block.children.flatMap((childId: string) => {
      const children = replacements.get(childId);
      return children ? children.map((child) => child.block_id) : childId;
    });
  }
  const firstLevelBlockIds = converted.firstLevelBlockIds.flatMap((blockId) => {
    const roots = replacements.get(blockId);
    return roots ? roots.map((root) => root.block_id) : blockId;
  });
  const replacedIds = new Set(replacements.keys());
  const descendants = converted.descendants.filter(
    (block) => !replacedIds.has(String(block.block_id || "")),
  );
  for (const blocks of replacements.values()) descendants.push(...blocks);
  const matchedMarkers = new Set(
    imageBlocks.map((image) => image.source.marker),
  );
  const missing = images.find((image) => !matchedMarkers.has(image.marker));
  if (missing) {
    throw new Error(`Feishu conversion lost image marker ${missing.marker}`);
  }
  return {
    ...converted,
    firstLevelBlockIds,
    descendants,
    imageBlocks,
  };
}

export function restoreConvertedEquations(
  converted: ConvertedBlocks,
  equations: EquationSource[],
): ConvertedBlocks {
  for (const block of converted.descendants) {
    const text = textBlockContent(block);
    if (!text?.elements) continue;
    const restored = text.elements.map((element: any) =>
      restoreEquationElements(element, equations),
    );
    text.elements = restored.flatMap(
      (result: RestoredEquationElements) => result.elements,
    );
    if (restored.some((result: RestoredEquationElements) => result.display)) {
      text.style = { ...(text.style || {}), align: 2 };
    }
  }
  return converted;
}

export function toFeishuBlock(block: TextBlock | { type: "divider" }): any {
  if (block.type === "divider") return { block_type: 22, divider: {} };
  const mapping: Record<string, [number, string]> = {
    paragraph: [2, "text"],
    heading1: [3, "heading1"],
    heading2: [4, "heading2"],
    heading3: [5, "heading3"],
    heading4: [6, "heading4"],
    heading5: [7, "heading5"],
    heading6: [8, "heading6"],
    bullet: [12, "bullet"],
    ordered: [13, "ordered"],
    code: [14, "code"],
    quote: [15, "quote"],
  };
  const [blockType, property] = mapping[block.type];
  return {
    block_type: blockType,
    [property]: { elements: block.runs.map(toTextElement), style: {} },
  };
}

function textBlockContent(block: any): any {
  const properties = [
    "page",
    "text",
    "heading1",
    "heading2",
    "heading3",
    "heading4",
    "heading5",
    "heading6",
    "heading7",
    "heading8",
    "heading9",
    "bullet",
    "ordered",
    "code",
    "quote",
    "todo",
  ];
  for (const property of properties) {
    if (block?.[property]?.elements) return block[property];
  }
  return undefined;
}

interface ImageElementToken {
  elements?: any[];
  image?: EmbeddedImageSource;
}

function splitImageElements(
  elements: any[],
  sources: Map<string, EmbeddedImageSource>,
): ImageElementToken[] {
  const tokens: ImageElementToken[] = [];
  let current: any[] = [];
  const flush = () => {
    if (current.length) tokens.push({ elements: current });
    current = [];
  };
  for (const element of elements) {
    const textRun = element?.text_run;
    const content = textRun?.content;
    if (typeof content !== "string") {
      current.push(element);
      continue;
    }
    const marker = /__ZOTERO_FEISHU_IMAGE_\d+__/g;
    let cursor = 0;
    let matched = false;
    for (const match of content.matchAll(marker)) {
      const source = sources.get(match[0]);
      if (!source) continue;
      matched = true;
      if (match.index > cursor) {
        current.push({
          text_run: {
            ...textRun,
            content: content.slice(cursor, match.index),
          },
        });
      }
      flush();
      tokens.push({ image: source });
      cursor = match.index + match[0].length;
    }
    if (!matched) {
      current.push(element);
      continue;
    }
    if (cursor < content.length) {
      current.push({
        text_run: { ...textRun, content: content.slice(cursor) },
      });
    }
  }
  flush();
  return tokens;
}

function tokenBlock(
  sourceBlock: any,
  token: ImageElementToken,
  imageBlocks: ConvertedImageBlock[],
  listChild: boolean,
): any {
  const blockId = temporaryBlockId();
  if (token.image) {
    imageBlocks.push({
      temporaryBlockId: blockId,
      source: token.image,
    });
    return {
      block_id: blockId,
      block_type: 27,
      image: {},
      children: [],
    };
  }
  const block = cloneTextBlock(sourceBlock, blockId, token.elements || []);
  if (listChild) convertListCloneToText(block);
  delete block.children;
  return block;
}

function cloneTextBlock(
  sourceBlock: any,
  blockId: string,
  elements: any[],
): any {
  const block = JSON.parse(JSON.stringify(sourceBlock));
  block.block_id = blockId;
  const text = textBlockContent(block);
  if (text) text.elements = elements;
  return block;
}

function convertListCloneToText(block: any): void {
  if (block.block_type === 12) {
    block.text = block.bullet;
    delete block.bullet;
  } else if (block.block_type === 13) {
    block.text = block.ordered;
    delete block.ordered;
  }
  block.block_type = 2;
  if (block.text?.style) delete block.text.style.sequence;
}

interface RestoredEquationElements {
  elements: any[];
  display: boolean;
}

function restoreEquationElements(
  element: any,
  equations: EquationSource[],
): RestoredEquationElements {
  const textRun = element?.text_run;
  const content = textRun?.content;
  if (typeof content !== "string") {
    return { elements: [element], display: false };
  }

  const marker = /__ZOTERO_FEISHU_EQUATION_(\d+)__/g;
  const restored: any[] = [];
  let display = false;
  let cursor = 0;
  for (const match of content.matchAll(marker)) {
    const index = Number(match[1]);
    const equation = equations[index];
    if (equation === undefined) {
      throw new Error("Feishu equation marker does not match its source");
    }
    if (match.index > cursor) {
      restored.push({
        text_run: { ...textRun, content: content.slice(cursor, match.index) },
      });
    }
    restored.push({
      equation: {
        content: equation.content,
        text_element_style: textRun.text_element_style || {},
      },
    });
    display ||= equation.display;
    cursor = match.index + match[0].length;
  }
  if (!restored.length) {
    return { elements: [element], display: false };
  }
  if (cursor < content.length) {
    restored.push({
      text_run: { ...textRun, content: content.slice(cursor) },
    });
  }
  return { elements: restored, display };
}

function isExplicitOrderedBlock(block: any): boolean {
  return (
    block?.block_type === 13 &&
    block.ordered?.style?.sequence &&
    block.ordered.style.sequence !== "auto"
  );
}

function isAutomaticOrderedBlock(block: any): boolean {
  return block?.block_type === 13 && block.ordered?.style?.sequence === "auto";
}

function convertOrderedBlockToText(block: any): void {
  const text = block.ordered;
  if (text?.style) delete text.style.sequence;
  block.block_type = 2;
  block.text = text;
  delete block.ordered;
}

function temporaryBlockId(): string {
  return `tmp_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function toTextElement(run: TextRun): any {
  const style = run.style || {};
  return {
    text_run: {
      content: run.text,
      text_element_style: {
        bold: Boolean(style.bold),
        italic: Boolean(style.italic),
        strikethrough: Boolean(style.strikethrough),
        underline: Boolean(style.underline),
        inline_code: Boolean(style.inlineCode),
        ...(style.link
          ? { link: { url: encodeURIComponent(style.link) } }
          : {}),
      },
    },
  };
}
