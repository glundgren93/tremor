import { describe, expect, it } from "vitest";
import { walkJson } from "../src/core/json-walk";

describe("walkJson", () => {
  it("walks flat object fields", () => {
    const fields = walkJson(JSON.stringify({ name: "Alice", age: 30, active: true }));
    expect(fields).toEqual([
      { path: "name", type: "string", value: "Alice" },
      { path: "age", type: "number", value: 30 },
      { path: "active", type: "boolean", value: true },
    ]);
  });

  it("walks nested objects", () => {
    const fields = walkJson(JSON.stringify({ user: { name: "Alice" } }));
    expect(fields).toEqual([
      { path: "user", type: "object", value: "{...}" },
      { path: "user.name", type: "string", value: "Alice" },
    ]);
  });

  it("walks arrays (first element only)", () => {
    const fields = walkJson(JSON.stringify([{ id: 1 }, { id: 2 }]));
    expect(fields).toEqual([
      { path: "[]", type: "array", value: "[2 items]" },
      { path: "[0]", type: "object", value: "{...}" },
      { path: "[0].id", type: "number", value: 1 },
    ]);
  });

  it("handles null values", () => {
    const fields = walkJson(JSON.stringify({ value: null }));
    expect(fields).toEqual([{ path: "value", type: "null", value: null }]);
  });

  it("respects max depth of 3", () => {
    const deep = { a: { b: { c: { d: { e: "too deep" } } } } };
    const fields = walkJson(JSON.stringify(deep));
    const paths = fields.map((f) => f.path);
    expect(paths).not.toContain("a.b.c.d");
    expect(paths).not.toContain("a.b.c.d.e");
  });

  it("returns empty array for invalid JSON", () => {
    expect(walkJson("not json")).toEqual([]);
  });

  it("walks nested array inside object", () => {
    const data = { results: [{ id: 1, name: "Item" }] };
    const fields = walkJson(JSON.stringify(data));
    expect(fields.map((f) => f.path)).toContain("results");
    expect(fields.map((f) => f.path)).toContain("results[0]");
    expect(fields.map((f) => f.path)).toContain("results[0].id");
  });
});
