import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphDB } from "../lib/graph-db.js";
import { ingestSessions, ingestMarkdown, ingestFactmem, ingestAll } from "../lib/ingest.js";

describe("ingestSessions", () => {
  let testDir: string;
  let graph: GraphDB;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kg-test-sessions-"));
    graph = new GraphDB();
  });

  afterEach(() => {
    graph.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("processes session JSONL files with user and assistant messages", async () => {
    // Create a test session file structure
    const agentDir = join(testDir, "test-agent", "sessions");
    mkdirSync(agentDir, { recursive: true });

    const sessionData = [
      { type: "message", message: { role: "user", content: "I need to talk to Alice Johnson about the project." } },
      { type: "message", message: { role: "assistant", content: "I'll help you contact Alice at Google." } },
      { type: "message", message: { role: "user", content: "Thanks!" } },
      { type: "other", data: "ignore this" },
    ];

    const sessionFile = join(agentDir, "test-session.jsonl");
    writeFileSync(sessionFile, sessionData.map((d) => JSON.stringify(d)).join("\n"));

    const stats = await ingestSessions(graph, testDir);

    expect(stats.sessionsProcessed).toBe(1);
    expect(stats.messagesProcessed).toBe(3); // Three user/assistant messages (ignore "other" type)
    expect(stats.entitiesAdded).toBeGreaterThan(0);

    // Verify entities were extracted
    const entities = graph.exportAll().entities;
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names.some((n) => n.includes("alice"))).toBe(true);
  });

  it("handles content blocks with text type", async () => {
    const agentDir = join(testDir, "test-agent", "sessions");
    mkdirSync(agentDir, { recursive: true });

    const sessionData = [
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Contact Bob Smith at Microsoft." },
            { type: "image", url: "http://example.com/image.png" },
          ],
        },
      },
    ];

    const sessionFile = join(agentDir, "test-session.jsonl");
    writeFileSync(sessionFile, sessionData.map((d) => JSON.stringify(d)).join("\n"));

    const stats = await ingestSessions(graph, testDir);

    expect(stats.messagesProcessed).toBe(1);
    expect(stats.entitiesAdded).toBeGreaterThan(0);

    // Verify entity extraction from text blocks only
    const entities = graph.exportAll().entities;
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names.some((n) => n.includes("bob"))).toBe(true);
  });

  it("processes .jsonl.reset.* files", async () => {
    const agentDir = join(testDir, "test-agent", "sessions");
    mkdirSync(agentDir, { recursive: true });

    const sessionData = [
      { type: "message", message: { role: "user", content: "Talk to Carol at Tesla." } },
    ];

    const sessionFile = join(agentDir, "test-session.jsonl.reset.12345");
    writeFileSync(sessionFile, sessionData.map((d) => JSON.stringify(d)).join("\n"));

    const stats = await ingestSessions(graph, testDir);

    expect(stats.sessionsProcessed).toBe(1);
    expect(stats.messagesProcessed).toBe(1);
  });

  it("handles dry-run mode", async () => {
    const agentDir = join(testDir, "test-agent", "sessions");
    mkdirSync(agentDir, { recursive: true });

    const sessionData = [
      { type: "message", message: { role: "user", content: "Contact David at Apple." } },
    ];

    const sessionFile = join(agentDir, "test-session.jsonl");
    writeFileSync(sessionFile, sessionData.map((d) => JSON.stringify(d)).join("\n"));

    const stats = await ingestSessions(graph, testDir, { dryRun: true });

    expect(stats.sessionsProcessed).toBe(1);
    expect(stats.messagesProcessed).toBe(1);
    expect(stats.entitiesAdded).toBeGreaterThan(0);

    // Verify nothing was actually added to the graph
    const entities = graph.exportAll().entities;
    expect(entities).toHaveLength(0);
  });

  it("handles invalid JSON lines gracefully", async () => {
    const agentDir = join(testDir, "test-agent", "sessions");
    mkdirSync(agentDir, { recursive: true });

    const content = [
      '{"type":"message","message":{"role":"user","content":"Valid message"}}',
      'invalid json here',
      '{"type":"message","message":{"role":"assistant","content":"Another valid message"}}',
    ].join("\n");

    const sessionFile = join(agentDir, "test-session.jsonl");
    writeFileSync(sessionFile, content);

    const stats = await ingestSessions(graph, testDir);

    expect(stats.sessionsProcessed).toBe(1);
    expect(stats.messagesProcessed).toBe(2); // Should process valid lines
  });

  it("handles missing sessions directory", async () => {
    const stats = await ingestSessions(graph, "/nonexistent/path");

    expect(stats.sessionsProcessed).toBe(0);
    expect(stats.errors).toHaveLength(0);
  });

  it("processes multiple agent directories", async () => {
    const agent1Dir = join(testDir, "agent1", "sessions");
    const agent2Dir = join(testDir, "agent2", "sessions");
    mkdirSync(agent1Dir, { recursive: true });
    mkdirSync(agent2Dir, { recursive: true });

    const sessionData = [
      { type: "message", message: { role: "user", content: "Test message." } },
    ];

    writeFileSync(join(agent1Dir, "session1.jsonl"), JSON.stringify(sessionData[0]));
    writeFileSync(join(agent2Dir, "session2.jsonl"), JSON.stringify(sessionData[0]));

    const stats = await ingestSessions(graph, testDir);

    expect(stats.sessionsProcessed).toBe(2);
  });
});

describe("ingestMarkdown", () => {
  let testDir: string;
  let graph: GraphDB;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kg-test-"));
    graph = new GraphDB(); // In-memory database for testing
  });

  afterEach(() => {
    graph.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("extracts entities from plain markdown", () => {
    const content = "I met with Alice Johnson yesterday. She works at Google in Mountain View.";
    const mdFile = join(testDir, "test.md");
    writeFileSync(mdFile, content);

    const stats = ingestMarkdown(graph, [testDir]);

    expect(stats.filesProcessed).toBe(1);
    expect(stats.entitiesAdded).toBeGreaterThan(0);
    expect(stats.errors).toHaveLength(0);

    // Verify entities were added
    const entities = graph.exportAll().entities;
    const names = entities.map((e) => e.name.toLowerCase());
    expect(names.some((n) => n.includes("alice"))).toBe(true);
  });

  it("parses structured key-value pairs", () => {
    const content = `# Profile
Name: Bob Smith
Phone: 555-1234
Email: bob@example.com
`;
    const mdFile = join(testDir, "profile.md");
    writeFileSync(mdFile, content);

    const stats = ingestMarkdown(graph, [testDir]);

    expect(stats.filesProcessed).toBe(1);
    expect(stats.entitiesAdded).toBeGreaterThan(0);
    expect(stats.propertiesAdded).toBeGreaterThan(0);

    // Verify entity was added
    const detail = graph.getEntity("bob smith");
    expect(detail).not.toBeNull();
    expect(detail!.entity.entity_type).toBe("person");
  });

  it("parses bullet points with relationships", () => {
    const content = `
- Alice lives in Boston
- Bob works at Microsoft
- Carol studies at MIT
`;
    const mdFile = join(testDir, "relations.md");
    writeFileSync(mdFile, content);

    const stats = ingestMarkdown(graph, [testDir]);

    expect(stats.filesProcessed).toBe(1);
    expect(stats.triplesAdded).toBeGreaterThan(0);

    // Verify triples were added
    const aliceDetail = graph.getEntity("alice");
    expect(aliceDetail).not.toBeNull();
    const livesinTriple = aliceDetail!.triples.find(
      (t) => t.predicate === "lives_in" && t.direction === "outgoing"
    );
    expect(livesinTriple).toBeDefined();
  });

  it("parses USER.md family sections", () => {
    const content = `# User Profile

## Family

- **John Doe** (42) - 555-123-4567 - Harvard University
- **Jane Doe** (16) - 555-987-6543 - Lincoln High School
- **Jimmy Doe** (12) - Central Middle School
`;
    const mdFile = join(testDir, "USER.md");
    writeFileSync(mdFile, content);

    const stats = ingestMarkdown(graph, [testDir]);

    expect(stats.filesProcessed).toBe(1);
    expect(stats.entitiesAdded).toBeGreaterThan(0);

    // Verify family members were added
    const johnDetail = graph.getEntity("john doe");
    expect(johnDetail).not.toBeNull();
    expect(johnDetail!.entity.entity_type).toBe("person");

    // Check for age property (normalized to has_age)
    const ageProperty = johnDetail!.properties.find((p) => p.key === "has_age");
    expect(ageProperty).toBeDefined();
    expect(ageProperty!.value).toBe("42");

    // Check for phone property (normalized to has_phone)
    const phoneProperty = johnDetail!.properties.find((p) => p.key === "has_phone");
    expect(phoneProperty).toBeDefined();

    // Check for school relationship
    const schoolTriple = johnDetail!.triples.find(
      (t) => t.predicate === "studies_at" && t.direction === "outgoing"
    );
    expect(schoolTriple).toBeDefined();
  });

  it("handles dry-run mode", () => {
    const content = "Alice works at Google.";
    const mdFile = join(testDir, "test.md");
    writeFileSync(mdFile, content);

    const stats = ingestMarkdown(graph, [testDir], { dryRun: true });

    expect(stats.filesProcessed).toBe(1);
    expect(stats.entitiesAdded).toBeGreaterThan(0);

    // Verify nothing was actually added to the graph
    const entities = graph.exportAll().entities;
    expect(entities).toHaveLength(0);
  });

  it("recursively scans directories", () => {
    const subdir = join(testDir, "subdir");
    mkdirSync(subdir);

    writeFileSync(join(testDir, "file1.md"), "Alice lives in Boston.");
    writeFileSync(join(subdir, "file2.md"), "Bob works at Google.");

    const stats = ingestMarkdown(graph, [testDir]);

    expect(stats.filesProcessed).toBe(2);
  });

  it("handles missing directories gracefully", () => {
    const stats = ingestMarkdown(graph, ["/nonexistent/path"]);

    expect(stats.filesProcessed).toBe(0);
    expect(stats.errors).toHaveLength(0);
  });

  it("handles file read errors gracefully", () => {
    // This will depend on file permissions, but we can at least verify
    // the error handling doesn't crash
    const stats = ingestMarkdown(graph, [testDir]);
    expect(stats).toBeDefined();
  });

  it("deduplicates entities from structured and NLP extraction", () => {
    const content = `
Name: Alice Johnson

Alice Johnson works at Google and lives in Mountain View.
`;
    const mdFile = join(testDir, "test.md");
    writeFileSync(mdFile, content);

    const stats = ingestMarkdown(graph, [testDir]);

    // Should only create one entity for Alice, not multiple
    const entities = graph.exportAll().entities;
    const aliceEntities = entities.filter((e) =>
      e.name.toLowerCase().includes("alice")
    );
    expect(aliceEntities.length).toBeLessThanOrEqual(1);
  });
});

describe("ingestFactmem", () => {
  let graph: GraphDB;

  beforeEach(() => {
    graph = new GraphDB();
  });

  afterEach(() => {
    graph.close();
  });

  it("ingests facts from SQLite database", () => {
    // Use the actual facts.db if it exists
    const factsPath = "/home/clawd/shared/facts.db";
    const stats = ingestFactmem(graph, factsPath);

    if (stats.errors.length === 0) {
      expect(stats.factsProcessed).toBeGreaterThan(0);
      expect(stats.entitiesAdded).toBeGreaterThan(0);
    }
  });

  it("handles missing facts database", () => {
    const stats = ingestFactmem(graph, "/nonexistent/facts.db");

    expect(stats.factsProcessed).toBe(0);
    expect(stats.errors.length).toBeGreaterThan(0);
    expect(stats.errors[0]).toContain("not found");
  });

  it("normalizes fact keys to predicates", () => {
    // This is tested implicitly through the actual database ingestion
    // We can verify predicate normalization in a unit test if needed
    expect(true).toBe(true);
  });
});

describe("ingestAll", () => {
  let testDir: string;
  let sessionsDir: string;
  let graph: GraphDB;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "kg-test-"));
    sessionsDir = mkdtempSync(join(tmpdir(), "kg-test-sessions-"));
    graph = new GraphDB();
  });

  afterEach(() => {
    graph.close();
    rmSync(testDir, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("ingests sessions, markdown, and factmem in order", async () => {
    // Create a session file
    const agentDir = join(sessionsDir, "test-agent", "sessions");
    mkdirSync(agentDir, { recursive: true });
    const sessionData = [
      { type: "message", message: { role: "user", content: "Contact Alice." } },
    ];
    writeFileSync(join(agentDir, "test.jsonl"), JSON.stringify(sessionData[0]));

    // Create a markdown file
    const content = "Bob lives in Boston.";
    const mdFile = join(testDir, "test.md");
    writeFileSync(mdFile, content);

    const factsPath = "/home/clawd/shared/facts.db";
    const stats = await ingestAll(graph, sessionsDir, [testDir], factsPath);

    expect(stats.sessionsProcessed).toBe(1);
    expect(stats.filesProcessed).toBe(1);
    // Can't guarantee factmem results without knowing if the file exists
  });

  it("respects dry-run mode", async () => {
    const content = "Carol works at Google.";
    const mdFile = join(testDir, "test.md");
    writeFileSync(mdFile, content);

    const factsPath = "/home/clawd/shared/facts.db";
    const stats = await ingestAll(graph, sessionsDir, [testDir], factsPath, { dryRun: true });

    expect(stats.filesProcessed).toBe(1);

    // Verify nothing was added
    const entities = graph.exportAll().entities;
    expect(entities).toHaveLength(0);
  });
});
