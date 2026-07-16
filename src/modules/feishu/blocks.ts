import type {
  CalloutBlock,
  EquationSource,
  TextBlock,
  TextRun,
} from "../types";

export interface ConvertedBlocks {
  firstLevelBlockIds: string[];
  descendants: any[];
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

  return { firstLevelBlockIds: normalizedRoots, descendants };
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
