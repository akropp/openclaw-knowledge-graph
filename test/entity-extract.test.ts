import { describe, it, expect } from "vitest";
import { extractEntities } from "../lib/entity-extract.js";
import { GraphDB } from "../lib/graph-db.js";

describe("extractEntities", () => {
  it("extracts people from text", () => {
    const results = extractEntities("I had a meeting with John Smith yesterday.");
    const names = results.map((r) => r.name.toLowerCase());
    expect(names.some((n) => n.includes("john"))).toBe(true);
  });

  it("extracts IP addresses", () => {
    const results = extractEntities("The server is at 192.168.1.100 and listens on port 8080");
    expect(results.some((r) => r.name === "192.168.1.100" && r.type === "ip_address")).toBe(true);
  });

  it("extracts service names", () => {
    const results = extractEntities("We need to configure nginx and redis for the deployment");
    const names = results.map((r) => r.name.toLowerCase());
    expect(names).toContain("nginx");
    expect(names).toContain("redis");
  });

  it("does not extract common words", () => {
    const results = extractEntities("I would like to have some more information please");
    // All these are stop words, should get nothing meaningful
    expect(results.length).toBe(0);
  });

  it("deduplicates close variants", () => {
    const results = extractEntities("Alice talked to alice about the project");
    const aliceEntries = results.filter((r) =>
      r.name.toLowerCase().includes("alice")
    );
    expect(aliceEntries.length).toBeLessThanOrEqual(1);
  });

  it("extracts hostnames", () => {
    const results = extractEntities("Deploy to api.example.com");
    expect(results.some((r) => r.name === "api.example.com" && r.type === "hostname")).toBe(true);
  });

  it("does not extract file extensions as hostnames", () => {
    const results = extractEntities("Edit the file config.json");
    expect(results.some((r) => r.name === "config.json")).toBe(false);
  });

  it("boosts confidence for entities already in graph", () => {
    const graph = new GraphDB();
    graph.addEntity("Alice", "person");

    const results = extractEntities("I spoke with Alice today", graph);
    const alice = results.find((r) => r.name.toLowerCase() === "alice");
    expect(alice).toBeDefined();
    // Known entity should have boosted confidence
    expect(alice!.confidence).toBeGreaterThanOrEqual(0.8);

    graph.close();
  });

  it("extracts organizations", () => {
    const results = extractEntities("She works at Google in Mountain View");
    const names = results.map((r) => r.name.toLowerCase());
    expect(names.some((n) => n.includes("google"))).toBe(true);
  });

  it("handles empty input", () => {
    const results = extractEntities("");
    expect(results).toHaveLength(0);
  });

  it("extracts multiple services", () => {
    const results = extractEntities(
      "The stack uses postgres, redis, and elasticsearch"
    );
    const names = results.map((r) => r.name.toLowerCase());
    expect(names).toContain("postgres");
    expect(names).toContain("redis");
    expect(names).toContain("elasticsearch");
  });
});
