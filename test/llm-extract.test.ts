import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractTriplesWithLLM, chunkMessages } from "../lib/llm-extract.js";

// Mock global fetch
const originalFetch = global.fetch;

describe("llm-extract", () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("extractTriplesWithLLM", () => {
    it("should extract triples from LLM response", async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: `{"subject":"Emily Kropp","predicate":"studies_at","object":"LIM College","subject_type":"person","object_type":"organization"}
{"subject":"John Smith","predicate":"works_at","object":"Google","subject_type":"person","object_type":"organization"}`,
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const text = "Emily Kropp studies at LIM College. John Smith works at Google.";
      const triples = await extractTriplesWithLLM(text, {
        ollamaUrl: "http://localhost:11434",
        model: "test-model",
      });

      expect(triples).toHaveLength(2);
      expect(triples[0]).toMatchObject({
        subject: "Emily Kropp",
        predicate: "studies_at",
        object: "LIM College",
        subject_type: "person",
        object_type: "organization",
      });
      expect(triples[1]).toMatchObject({
        subject: "John Smith",
        predicate: "works_at",
        object: "Google",
        subject_type: "person",
        object_type: "organization",
      });

      // Verify fetch was called with correct parameters
      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:11434/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );
    });

    it("should handle malformed JSON lines gracefully", async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: `{"subject":"Valid Name","predicate":"works_at","object":"Valid Org","subject_type":"person","object_type":"organization"}
This is not JSON
{"invalid": "missing required fields"}
{"subject":"Another Valid","predicate":"studies_at","object":"School","subject_type":"person","object_type":"organization"}`,
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as any);

      // Use realistic text that won't be stripped by preprocessText
      const text = "Valid Name works at Valid Org. Another Valid studies at School.";
      const triples = await extractTriplesWithLLM(text, {
        ollamaUrl: "http://localhost:11434",
        model: "test-model",
      });

      // Should only extract valid triples
      expect(triples).toHaveLength(2);
      expect(triples[0].subject).toBe("Valid Name");
      expect(triples[1].subject).toBe("Another Valid");
    });

    it("should return empty array on connection error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

      const triples = await extractTriplesWithLLM("Some text", {
        ollamaUrl: "http://localhost:11434",
        model: "test-model",
      });

      expect(triples).toEqual([]);
    });

    it("should return empty array on non-OK HTTP response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as any);

      const triples = await extractTriplesWithLLM("Some text", {
        ollamaUrl: "http://localhost:11434",
        model: "test-model",
      });

      expect(triples).toEqual([]);
    });

    it("should return empty array when LLM returns empty content", async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: "",
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as any);

      const triples = await extractTriplesWithLLM("Some text", {
        ollamaUrl: "http://localhost:11434",
        model: "test-model",
      });

      expect(triples).toEqual([]);
    });

    it("should use default URL and model when not specified", async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: '{"subject":"Test","predicate":"test","object":"Test","subject_type":"person","object_type":"person"}',
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as any);

      // Use realistic text that won't be stripped
      await extractTriplesWithLLM("Alice works at Microsoft in Seattle.");

      expect(global.fetch).toHaveBeenCalledWith(
        "http://mac-mini.tailcd0984.ts.net:11434/v1/chat/completions",
        expect.objectContaining({
          body: expect.stringContaining('"model":"qwen2.5:14b"'),
        })
      );
    });

    it("should clean text before sending to LLM", async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: '{"subject":"Test","predicate":"test","object":"Test","subject_type":"person","object_type":"person"}',
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as any);

      // Text with code blocks and markdown that should be cleaned
      const dirtyText = `
        Emily works at Google.
        \`\`\`javascript
        const x = 1;
        \`\`\`
        She lives in **New York**.
      `;

      await extractTriplesWithLLM(dirtyText, {
        ollamaUrl: "http://localhost:11434",
        model: "test-model",
      });

      // Verify the request body doesn't contain code blocks
      const callArgs = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      const sentText = body.messages[1].content;

      expect(sentText).not.toContain("```");
      expect(sentText).not.toContain("const x = 1");
      expect(sentText).toContain("Emily");
      expect(sentText).toContain("Google");
    });

    it("should return empty array for very short text after cleaning", async () => {
      // Set up a spy to verify fetch is not called
      global.fetch = vi.fn();
      
      // Very short text that becomes even shorter after cleaning
      const shortText = "```code```";

      const triples = await extractTriplesWithLLM(shortText, {
        ollamaUrl: "http://localhost:11434",
        model: "test-model",
        verbose: true,
      });

      expect(triples).toEqual([]);
      // fetch should not be called since text is too short
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("chunkMessages", () => {
    it("should chunk messages into approximately equal sizes", () => {
      const messages = [
        { role: "user", text: "A".repeat(1500) },
        { role: "assistant", text: "B".repeat(1500) },
        { role: "user", text: "C".repeat(1500) },
      ];

      const chunks = chunkMessages(messages, 2000);

      // Should create at least 2 chunks since each message is ~1500 chars + metadata
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // Each chunk should be roughly under the limit (allowing for some overhead)
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(2200); // Some tolerance for message formatting
      }
    });

    it("should not split messages mid-message", () => {
      const messages = [
        { role: "user", text: "Short message 1" },
        { role: "assistant", text: "Short message 2" },
        { role: "user", text: "A".repeat(2500) }, // This one exceeds maxChars by itself
      ];

      const chunks = chunkMessages(messages, 2000);

      // The long message should be in its own chunk
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      
      // Each chunk should contain complete messages (starts with [role]:)
      for (const chunk of chunks) {
        expect(chunk).toMatch(/^\[(?:user|assistant)\]:/);
      }
    });

    it("should handle single message", () => {
      const messages = [{ role: "user", text: "Single message" }];

      const chunks = chunkMessages(messages, 2000);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain("Single message");
    });

    it("should handle empty messages array", () => {
      const chunks = chunkMessages([], 2000);

      expect(chunks).toEqual([]);
    });
  });
});
