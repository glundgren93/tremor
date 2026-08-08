import { describe, expect, it } from "vitest";
import { type ContentState, diffContent } from "../src/observers/content";

function state(overrides: Partial<ContentState> = {}): ContentState {
  return {
    visibleTextLength: 1000,
    textSample: "Tasks a, b, c",
    elementCount: 100,
    headings: ["Tasks", "Profile"],
    errorPhrases: [],
    spinnerCount: 0,
    imageCount: 3,
    linkCount: 5,
    title: "App",
    ...overrides,
  };
}

const kinds = (s: ContentState, f: ContentState) => diffContent(s, f).map((o) => o.kind);

describe("diffContent", () => {
  it("says nothing when the page is unchanged", () => {
    expect(diffContent(state(), state())).toEqual([]);
  });

  it("reports substantial text loss", () => {
    const out = diffContent(state(), state({ visibleTextLength: 100 }));
    expect(out[0]?.kind).toBe("content.text-lost");
    expect(out[0]?.facts.percentLost).toBe(90);
  });

  it("ignores minor text churn", () => {
    // A clock or counter changing must not read as content loss.
    expect(kinds(state(), state({ visibleTextLength: 950 }))).not.toContain("content.text-lost");
  });

  it("reports error text that was not there before", () => {
    const out = diffContent(state(), state({ errorPhrases: ["Something went wrong"] }));
    expect(out.map((o) => o.kind)).toContain("content.error-text-appeared");
  });

  it("does not re-report error text that was already present", () => {
    const before = state({ errorPhrases: ["Retry"] });
    const after = state({ errorPhrases: ["Retry"] });
    expect(kinds(before, after)).not.toContain("content.error-text-appeared");
  });

  it("flags a silent failure: section gone, no error, no text loss", () => {
    const after = state({ headings: ["Profile"] });
    expect(kinds(state(), after)).toContain("content.section-missing");
  });

  it("does not call it silent when an error was shown", () => {
    const after = state({ headings: ["Profile"], errorPhrases: ["Failed to load"] });
    const out = kinds(state(), after);
    expect(out).toContain("content.error-text-appeared");
    expect(out).not.toContain("content.section-missing");
  });

  it("reports spinners that outlast the load", () => {
    expect(kinds(state(), state({ spinnerCount: 2 }))).toContain("content.spinner-persisted");
  });

  it("ignores spinners that were already there", () => {
    expect(kinds(state({ spinnerCount: 2 }), state({ spinnerCount: 2 }))).not.toContain(
      "content.spinner-persisted",
    );
  });

  it("catches an unhandled rejection leaking into the title", () => {
    // The real find on the benchmark app: a failed fetch left "undefined".
    const out = diffContent(state({ title: "Ada" }), state({ title: "undefined" }));
    expect(out.map((o) => o.kind)).toContain("content.title-changed");
  });

  it("reports DOM shrinkage", () => {
    expect(kinds(state(), state({ elementCount: 40 }))).toContain("content.elements-lost");
  });

  it("does not divide by zero on an empty baseline", () => {
    expect(() =>
      diffContent(state({ visibleTextLength: 0, elementCount: 0 }), state()),
    ).not.toThrow();
  });
});
