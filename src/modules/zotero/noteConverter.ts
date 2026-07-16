import type { EmbeddedImageSource, EquationSource, RichBlock } from "../types";
import { replaceMathElements } from "./formulaPreprocessor";
import { replaceImageElements } from "./mediaMarkers";
import { noteFragmentNodes } from "./noteFragments";

export interface NoteFragment {
  blocks: RichBlock[];
}

export function noteHtmlToBlocks(
  html: string,
  leadingTitleToOmit = "",
): RichBlock[] {
  return noteHtmlToFragments(html, leadingTitleToOmit).flatMap(
    (fragment) => fragment.blocks,
  );
}

export function noteHtmlToFragments(
  html: string,
  leadingTitleToOmit = "",
): NoteFragment[] {
  const fragments = noteFragmentNodes(html, leadingTitleToOmit).map(
    nodeToFragment,
  );
  return fragments.length ? fragments : [emptyFragment()];
}

function nodeToFragment(node: Node): NoteFragment {
  const equations: EquationSource[] = [];
  const images: EmbeddedImageSource[] = [];
  let content: string;
  let normalizeOrderedListItems = false;
  if (node.nodeType === 1) {
    const element = prepareElementForConversion(
      node as Element,
      equations,
      images,
    );
    if (element.tagName.toLowerCase() === "ol") {
      content = splitOrderedListItems(element);
      normalizeOrderedListItems = true;
    } else {
      content = String(element.outerHTML);
    }
  } else {
    content = `<p>${escapeHtml(node.textContent || "")}</p>`;
  }
  return {
    blocks: [
      {
        type: "html",
        content,
        ...(normalizeOrderedListItems
          ? { normalizeOrderedListItems: true }
          : {}),
        ...(equations.length ? { equations } : {}),
        ...(images.length ? { images } : {}),
      },
    ],
  };
}

function emptyFragment(): NoteFragment {
  return {
    blocks: [{ type: "paragraph", runs: [{ text: "(Empty note)" }] }],
  };
}

function splitOrderedListItems(element: Element): string {
  const items = Array.from(element.children).filter(
    (child) => child.tagName.toLowerCase() === "li",
  );
  if (!items.length) return String(element.outerHTML);

  let sequence = integerAttribute(element, "start") ?? 1;
  return items
    .map((item) => {
      sequence = integerAttribute(item, "value") ?? sequence;
      const list = element.cloneNode(false) as Element;
      list.setAttribute("start", String(sequence));
      list.appendChild(item.cloneNode(true));
      sequence++;
      return String(list.outerHTML);
    })
    .join("");
}

function prepareElementForConversion(
  source: Element,
  equations: EquationSource[],
  images: EmbeddedImageSource[],
): Element {
  let element = source.cloneNode(true) as Element;
  element = replaceMathElements(element, equations);
  element = replaceImageElements(element, images);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!,
  );
}

function integerAttribute(element: Element, name: string): number | undefined {
  const value = element.getAttribute(name);
  if (!value || !/^-?\d+$/.test(value)) return undefined;
  return Number(value);
}
