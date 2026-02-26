import type { JsonField } from "./types";

/**
 * Walk a JSON body and return a flat list of field paths.
 * Walks first array element as representative, max depth 3.
 */
export function walkJson(body: string): JsonField[] {
  try {
    const parsed: unknown = JSON.parse(body);
    const fields: JsonField[] = [];
    walk(parsed, "", 0, fields);
    return fields;
  } catch {
    return [];
  }
}

function walk(value: unknown, path: string, depth: number, fields: JsonField[]): void {
  if (depth > 3) return;

  if (value === null) {
    fields.push({ path, type: "null", value });
    return;
  }

  if (Array.isArray(value)) {
    fields.push({ path: path || "[]", type: "array", value: `[${value.length} items]` });
    if (value.length > 0) {
      walk(value[0], path ? `${path}[0]` : "[0]", depth + 1, fields);
    }
    return;
  }

  if (typeof value === "object") {
    if (path) {
      fields.push({ path, type: "object", value: "{...}" });
    }
    for (const [key, val] of Object.entries(value)) {
      walk(val, path ? `${path}.${key}` : key, depth + 1, fields);
    }
    return;
  }

  const type = typeof value as "string" | "number" | "boolean";
  fields.push({ path, type, value });
}
