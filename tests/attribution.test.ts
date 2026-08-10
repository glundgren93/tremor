import { describe, expect, it } from "vitest";
import { attributeFaults } from "../src/observers/attribution";
import type { ContentState } from "../src/observers/content";
import type { SemanticRegion } from "../src/observers/regions";
import type { FaultReceipt } from "../src/types/chaos";

const metrics = (textLength: number) => ({
  textLength,
  rowCount: textLength,
  itemCount: 0,
  controlCount: 0,
  errorPhraseCount: 0,
  skeletonCount: 0,
  blankCount: 0,
});
const region = (key: string, textLength: number, x = 0): SemanticRegion => ({
  key,
  regionId: key,
  kind: "section",
  rect: { x, y: 0, width: 100, height: 100 },
  viewport: { width: 500, height: 500 },
  visibleRatio: 1,
  count: 1,
  metrics: metrics(textLength),
});
const state = (regions: SemanticRegion[], textDigest = "same"): ContentState => ({
  visibleTextLength: 0,
  textSample: "",
  elementCount: 0,
  headings: [],
  errorPhrases: [],
  spinnerCount: 0,
  imageCount: 0,
  linkCount: 0,
  title: "",
  regions,
  regionFingerprints: Object.fromEntries(
    regions.map((r) => [r.key, `${textDigest}:${JSON.stringify(r.metrics)}`]),
  ),
  regionTextFingerprints: Object.fromEntries(regions.map((r) => [r.key, textDigest])),
});
const receipt = (faultId = "f"): FaultReceipt => ({
  version: 1,
  status: "applied",
  scenarioId: "s",
  faultId,
  method: "GET",
  url: "https://example.test/api/items",
  resourceType: "fetch",
  timestamp: 10,
});

describe("attributeFaults", () => {
  it("links one receipt to one stable factual metric delta", () => {
    const out = attributeFaults([receipt()], state([region("abc", 8)]), state([region("abc", 0)]));
    expect(out).toHaveLength(1);
    const { receiptIndex, ...referenceFields } = out[0]?.receipt ?? { receiptIndex: -1 };
    expect([receipt()][receiptIndex]).toMatchObject(referenceFields);
    expect(out[0]).toMatchObject({
      status: "attributed",
      receipt: { receiptIndex: 0, faultId: "f" },
      regionDeltas: [{ regionId: "abc", changedFields: ["textLength", "rowCount"] }],
    });
  });
  it("orders two sibling region deltas deterministically", () => {
    const out = attributeFaults(
      [receipt()],
      state([region("b", 2, 150), region("a", 1)]),
      state([region("b", 0, 150), region("a", 0)]),
    );
    expect(out[0]?.regionDeltas.map((d) => d.regionId)).toEqual(["a", "b"]);
  });
  it("fails closed for multiple applied receipts", () => {
    const out = attributeFaults(
      [receipt("one"), receipt("two")],
      state([region("a", 1)]),
      state([region("a", 0)]),
    );
    expect(out.map((a) => [a.status, a.regionDeltas.length, a.receipt.receiptIndex])).toEqual([
      ["ambiguous", 0, 0],
      ["ambiguous", 0, 1],
    ]);
  });
  it("detects same-length text changes without exposing text or digests", () => {
    const out = attributeFaults(
      [receipt()],
      state([region("a", 5)], "ready-digest"),
      state([region("a", 5)], "error-digest"),
    );
    expect(out[0]).toMatchObject({
      status: "attributed",
      regionDeltas: [{ changedFields: ["textContent"] }],
    });
    expect(JSON.stringify(out)).not.toMatch(/ready-digest|error-digest|Ready|Error/);
  });
  it("rejects kind, region identity, viewport, and geometry trust drift", () => {
    const before = state([region("a", 5)], "before");
    for (const changed of [
      { ...region("a", 5), kind: "article" },
      { ...region("a", 5), regionId: "other" },
      { ...region("a", 5), viewport: { width: 501, height: 500 } },
      { ...region("a", 5), viewport: { width: Number.NaN, height: 500 } },
      { ...region("a", 5), rect: { x: 80, y: 0, width: 100, height: 100 } },
    ]) {
      const after = state([changed], "after");
      expect(attributeFaults([receipt()], before, after)[0]?.status).toBe("no-region-delta");
    }
  });
  it("handles unchanged and no-applied cases", () => {
    const before = state([region("a", 1)]);
    expect(attributeFaults([receipt()], before, before)[0]).toMatchObject({
      status: "no-region-delta",
      regionDeltas: [],
    });
    expect(attributeFaults([], before, before)).toEqual([]);
  });
  it("serializes no raw locator or editable sentinels", () => {
    const serialized = JSON.stringify(
      attributeFaults([receipt()], state([region("hashed", 8)]), state([region("hashed", 0)])),
    );
    for (const secret of [
      "severity",
      "confidence",
      "accessibleLabel",
      "selector",
      "responseBody",
      "headers",
      "query-secret",
      "raw-testid-sentinel",
      "input-secret",
      "selected-secret",
      "contenteditable-secret",
    ])
      expect(serialized).not.toContain(secret);
    const parsed = JSON.parse(serialized);
    expect(parsed[0].receipt).not.toHaveProperty("url");
    expect(receipt().url).toContain("/api/items");
    expect(["attributed", "ambiguous", "no-region-delta"]).toContain(parsed[0].status);
  });
});
