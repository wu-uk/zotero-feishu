import type { EquationSource } from "../types";

export function replaceMathElements(
  source: Element,
  equations: EquationSource[],
): Element {
  if (source.classList.contains("math")) {
    return equationReplacement(source, equations);
  }
  (Array.from(source.querySelectorAll(".math")) as Element[]).forEach(
    (math) => {
      math.replaceWith(equationReplacement(math, equations));
    },
  );
  return source;
}

function equationReplacement(
  element: Element,
  equations: EquationSource[],
): Element {
  const equation = unwrapMath(element.textContent || "");
  const document = element.ownerDocument;
  if (!document) throw new Error("Zotero math element has no owner document");
  const display = element.tagName.toLowerCase() === "pre";
  const marker = document.createElement(display ? "p" : "span");
  marker.textContent = `__ZOTERO_FEISHU_EQUATION_${equations.length}__`;
  equations.push({ content: equation, display });
  return marker;
}

function unwrapMath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$")) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("$") && trimmed.endsWith("$")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
