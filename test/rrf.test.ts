import { describe, it, expect } from "vitest";
import { rrfMerge, fuse } from "../lib/rrf.js";
import { GraphDB } from "../lib/graph-db.js";
import type { FusionResult } from "../lib/rrf.js";

describe("rrfMerge", () => {
  it("merges results from multiple sources", () => {
    const set1: FusionResult[] = [
      { text: "Alice works at Acme", score: 1.0, source: "graph" },
      { text: "Alice lives in NYC", score: 0.8, source: "graph" },
    ];
    const set2: FusionResult[] = [
      { text: "Alice lives in NYC", score: 0.9, source: "memory" },
      { text: "Alice is a developer", score: 0.7, source: "memory" },
    ];

    const merged = rrfMerge([set1, set2]);
    expect(merged.length).toBe(3);
    // "Alice lives in NYC" appears in both, should have highest fused score
    const nyc = merged.find((r) => r.text === "Alice lives in NYC");
    expect(nyc).toBeDefined();
    expect(nyc!.score).toBeGreaterThan(
      merged.find((r) => r.text === "Alice works at Acme")!.score
    );
  });

  it("handles empty result sets", () => {
    const merged = rrfMerge([]);
    expect(merged).toHaveLength(0);
  });

  it("handles single result set", () => {
    const set1: FusionResult[] = [
      { text: "fact 1", score: 1.0, source: "a" },
      { text: "fact 2", score: 0.5, source: "a" },
    ];
    const merged = rrfMerge([set1]);
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe("fact 1");
  });

  it("respects k parameter for scoring", () => {
    const set1: FusionResult[] = [
      { text: "A", score: 1.0, source: "s1" },
    ];

    // With k=60: score = 1/(60+0+1) = 1/61
    const merged60 = rrfMerge([set1], 60);
    expect(merged60[0].score).toBeCloseTo(1 / 61, 5);

    // With k=1: score = 1/(1+0+1) = 1/2
    const merged1 = rrfMerge([set1], 1);
    expect(merged1[0].score).toBeCloseTo(1 / 2, 5);
  });

  it("deduplicates by text", () => {
    const set1: FusionResult[] = [
      { text: "same fact", score: 1.0, source: "a" },
    ];
    const set2: FusionResult[] = [
      { text: "same fact", score: 1.0, source: "b" },
    ];
    const merged = rrfMerge([set1, set2]);
    expect(merged).toHaveLength(1);
    // Score should be additive
    expect(merged[0].score).toBeGreaterThan(1 / 61);
  });

  it("sorts by fused score descending", () => {
    const set1: FusionResult[] = [
      { text: "low", score: 0.1, source: "a" },
      { text: "high", score: 0.9, source: "a" },
    ];
    const set2: FusionResult[] = [
      { text: "high", score: 0.9, source: "b" },
    ];

    const merged = rrfMerge([set1, set2]);
    // "high" appears in both sets so should be first
    expect(merged[0].text).toBe("high");
  });
});

describe("fuse", () => {
  it("queries graph and returns results", () => {
    const graph = new GraphDB();
    graph.addTriple("Alice", "works_at", "Acme Corp");

    const results = fuse("Alice", { graph });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.source === "graph")).toBe(true);

    graph.close();
  });

  it("returns empty for no matches", () => {
    const graph = new GraphDB();
    const results = fuse("nonexistent_entity_xyz", { graph });
    expect(results).toHaveLength(0);
    graph.close();
  });

  it("works with no sources", () => {
    const results = fuse("test", {});
    expect(results).toHaveLength(0);
  });
});
