export async function hashValue(value: unknown): Promise<string> {
  const win = Zotero.getMainWindow() as any;
  const bytes = new win.TextEncoder().encode(stableStringify(value));
  const digest = new Uint8Array(
    await win.crypto.subtle.digest("SHA-256", bytes),
  );
  return Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}
