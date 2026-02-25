import { describe, it, expect, beforeEach } from "vitest";
import { GraphDB } from "../lib/graph-db.js";

describe("GraphDB", () => {
  let db: GraphDB;

  beforeEach(() => {
    db = new GraphDB(); // in-memory
  });

  describe("addEntity", () => {
    it("creates a new entity and returns its id", () => {
      const id = db.addEntity("Alice", "person");
      expect(id).toBeGreaterThan(0);
    });

    it("normalizes name to lowercase", () => {
      db.addEntity("Alice", "person");
      const entity = db.getEntity("alice");
      expect(entity).not.toBeNull();
      expect(entity!.entity.name).toBe("alice");
      expect(entity!.entity.display_name).toBe("Alice");
    });

    it("upserts on duplicate name", () => {
      const id1 = db.addEntity("Alice", "unknown");
      const id2 = db.addEntity("Alice", "person");
      expect(id1).toBe(id2);
      const entity = db.getEntity("alice");
      expect(entity!.entity.entity_type).toBe("person");
    });

    it("does not overwrite type with unknown on upsert", () => {
      db.addEntity("Alice", "person");
      db.addEntity("Alice", "unknown");
      const entity = db.getEntity("alice");
      expect(entity!.entity.entity_type).toBe("person");
    });
  });

  describe("addTriple", () => {
    it("creates a triple between two entities", () => {
      const id = db.addTriple("Alice", "works_at", "Acme Corp");
      expect(id).toBeGreaterThan(0);
    });

    it("auto-creates entities", () => {
      db.addTriple("Alice", "works_at", "Acme Corp");
      expect(db.getEntity("alice")).not.toBeNull();
      expect(db.getEntity("acme corp")).not.toBeNull();
    });

    it("upserts on duplicate triple", () => {
      const id1 = db.addTriple("Alice", "works_at", "Acme Corp", { confidence: 0.5 });
      const id2 = db.addTriple("Alice", "works_at", "Acme Corp", { confidence: 0.9 });
      expect(id1).toBe(id2);
    });

    it("stores confidence and source", () => {
      db.addTriple("Alice", "works_at", "Acme Corp", {
        confidence: 0.8,
        source: "agent-1",
      });
      const detail = db.getEntity("alice");
      expect(detail!.triples[0].confidence).toBe(0.8);
    });
  });

  describe("addProperty", () => {
    it("adds a property to an entity", () => {
      db.addEntity("Alice", "person");
      db.addProperty("Alice", "email", "alice@example.com");
      const detail = db.getEntity("alice");
      expect(detail!.properties).toHaveLength(1);
      expect(detail!.properties[0].key).toBe("email");
      expect(detail!.properties[0].value).toBe("alice@example.com");
    });

    it("upserts on duplicate key", () => {
      db.addEntity("Alice");
      db.addProperty("Alice", "email", "old@example.com");
      db.addProperty("Alice", "email", "new@example.com");
      const detail = db.getEntity("alice");
      expect(detail!.properties).toHaveLength(1);
      expect(detail!.properties[0].value).toBe("new@example.com");
    });
  });

  describe("query (multi-hop)", () => {
    it("returns direct connections at depth 1", () => {
      db.addTriple("Alice", "works_at", "Acme Corp");
      const results = db.query("alice", 1);
      expect(results.length).toBeGreaterThanOrEqual(2); // alice at depth 0, acme corp at depth 1
      expect(results.some((r) => r.depth === 0)).toBe(true);
      expect(results.some((r) => r.depth === 1)).toBe(true);
    });

    it("traverses multiple hops", () => {
      db.addTriple("Alice", "works_at", "Acme Corp");
      db.addTriple("Acme Corp", "located_in", "New York");
      const results = db.query("alice", 2);
      expect(results.some((r) => r.path.includes("new york"))).toBe(true);
    });

    it("avoids cycles", () => {
      db.addTriple("A", "knows", "B");
      db.addTriple("B", "knows", "C");
      db.addTriple("C", "knows", "A");
      const results = db.query("a", 5);
      // Should not have infinite results despite cycle
      expect(results.length).toBeLessThan(20);
    });

    it("returns empty for unknown entity", () => {
      const results = db.query("nonexistent");
      expect(results).toHaveLength(0);
    });
  });

  describe("search", () => {
    it("finds entities by name", () => {
      db.addEntity("Alice Johnson", "person");
      db.addEntity("Bob Smith", "person");
      const results = db.search("alice");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe("alice johnson");
    });

    it("returns empty for no matches", () => {
      db.addEntity("Alice", "person");
      const results = db.search("zzzznotfound");
      expect(results).toHaveLength(0);
    });
  });

  describe("getEntity", () => {
    it("returns full entity details", () => {
      db.addTriple("Alice", "works_at", "Acme Corp");
      db.addProperty("Alice", "email", "alice@example.com");
      const detail = db.getEntity("alice");
      expect(detail).not.toBeNull();
      expect(detail!.entity.display_name).toBe("Alice");
      expect(detail!.triples).toHaveLength(1);
      expect(detail!.properties).toHaveLength(1);
    });

    it("returns null for unknown entity", () => {
      expect(db.getEntity("nonexistent")).toBeNull();
    });

    it("shows both incoming and outgoing triples", () => {
      db.addTriple("Alice", "works_at", "Acme Corp");
      db.addTriple("Bob", "reports_to", "Alice");
      const detail = db.getEntity("alice");
      expect(detail!.triples).toHaveLength(2);
      const directions = detail!.triples.map((t) => t.direction);
      expect(directions).toContain("outgoing");
      expect(directions).toContain("incoming");
    });
  });

  describe("merge", () => {
    it("merges two entities", () => {
      db.addTriple("Alice", "works_at", "Acme Corp");
      db.addTriple("Alice Smith", "knows", "Bob");
      db.merge("alice", "alice smith");
      // alice smith should no longer exist
      expect(db.getEntity("alice smith")).toBeNull();
      // alice should have all relationships
      const detail = db.getEntity("alice");
      expect(detail!.triples.length).toBeGreaterThanOrEqual(2);
    });

    it("throws for nonexistent entity", () => {
      db.addEntity("Alice");
      expect(() => db.merge("alice", "nonexistent")).toThrow();
    });

    it("stores alias as property", () => {
      db.addEntity("Alice", "person");
      db.addEntity("Alice Smith", "person");
      db.merge("alice", "alice smith");
      const detail = db.getEntity("alice");
      expect(detail!.properties.some((p) => p.key === "alias")).toBe(true);
    });
  });

  describe("prune", () => {
    it("removes orphaned entities", () => {
      db.addEntity("Orphan");
      db.addTriple("Alice", "works_at", "Acme Corp");
      const pruned = db.prune();
      expect(pruned).toContain("orphan");
      expect(db.getEntity("orphan")).toBeNull();
    });

    it("does not remove entities with triples", () => {
      db.addTriple("Alice", "works_at", "Acme Corp");
      const pruned = db.prune();
      expect(pruned).not.toContain("alice");
    });

    it("does not remove entities with properties", () => {
      db.addEntity("Alice");
      db.addProperty("Alice", "email", "alice@example.com");
      const pruned = db.prune();
      expect(pruned).not.toContain("alice");
    });

    it("dry run does not delete", () => {
      db.addEntity("Orphan");
      const pruned = db.prune({ dryRun: true });
      expect(pruned).toContain("orphan");
      expect(db.getEntity("orphan")).not.toBeNull();
    });
  });

  describe("stats", () => {
    it("returns correct counts", () => {
      db.addTriple("Alice", "works_at", "Acme Corp");
      db.addProperty("Alice", "email", "alice@example.com");
      const stats = db.stats();
      expect(stats.entity_count).toBe(2);
      expect(stats.triple_count).toBe(1);
      expect(stats.property_count).toBe(1);
      expect(stats.top_predicates).toHaveLength(1);
      expect(stats.top_predicates[0].predicate).toBe("works_at");
    });
  });

  describe("export/import", () => {
    it("exports all data", () => {
      db.addTriple("Alice", "works_at", "Acme Corp");
      db.addProperty("Alice", "email", "alice@example.com");
      const data = db.exportAll();
      expect(data.entities.length).toBe(2);
      expect(data.triples.length).toBe(1);
      expect(data.properties.length).toBe(1);
    });

    it("imports triples and properties", () => {
      db.importData({
        triples: [
          { subject: "Alice", predicate: "works_at", object: "Acme Corp" },
        ],
        properties: [
          { entity: "Alice", key: "email", value: "alice@example.com" },
        ],
      });
      const detail = db.getEntity("alice");
      expect(detail).not.toBeNull();
      expect(detail!.triples).toHaveLength(1);
      expect(detail!.properties).toHaveLength(1);
    });
  });
});
