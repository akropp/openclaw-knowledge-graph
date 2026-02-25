import { describe, it, expect, beforeEach } from "vitest";
import { StabilityGuard } from "../lib/stability.js";

describe("StabilityGuard", () => {
  let guard: StabilityGuard;

  beforeEach(() => {
    guard = new StabilityGuard({ loopThreshold: 3, confabulationCheck: true });
  });

  describe("loop detection", () => {
    it("detects consecutive identical tool calls", () => {
      guard.recordToolCall({ name: "exec" });
      guard.recordToolCall({ name: "exec" });
      guard.recordToolCall({ name: "exec" });
      const warning = guard.checkLoop();
      expect(warning).not.toBeNull();
      expect(warning).toContain("exec");
      expect(warning).toContain("3 times");
    });

    it("does not trigger below threshold", () => {
      guard.recordToolCall({ name: "exec" });
      guard.recordToolCall({ name: "exec" });
      const warning = guard.checkLoop();
      expect(warning).toBeNull();
    });

    it("does not trigger for mixed tool calls", () => {
      guard.recordToolCall({ name: "exec" });
      guard.recordToolCall({ name: "read" });
      guard.recordToolCall({ name: "exec" });
      const warning = guard.checkLoop();
      expect(warning).toBeNull();
    });

    it("uses default threshold of 5", () => {
      const defaultGuard = new StabilityGuard();
      for (let i = 0; i < 4; i++) {
        defaultGuard.recordToolCall({ name: "exec" });
      }
      expect(defaultGuard.checkLoop()).toBeNull();
      defaultGuard.recordToolCall({ name: "exec" });
      expect(defaultGuard.checkLoop()).not.toBeNull();
    });
  });

  describe("confabulation detection", () => {
    it("detects completion claims with no tool calls", () => {
      const warning = guard.checkConfabulation(
        "I've set up the database and configured everything.",
        []
      );
      expect(warning).not.toBeNull();
      expect(warning).toContain("confabulating");
    });

    it("does not trigger when work tools were called", () => {
      const warning = guard.checkConfabulation(
        "I've set up the database.",
        [{ name: "exec", args: { command: "createdb" } }]
      );
      expect(warning).toBeNull();
    });

    it("does not trigger for non-completion text", () => {
      const warning = guard.checkConfabulation(
        "Let me look into that for you.",
        []
      );
      expect(warning).toBeNull();
    });

    it("detects 'Done!' with no tool calls", () => {
      const warning = guard.checkConfabulation("Done!", []);
      expect(warning).not.toBeNull();
    });

    it("detects 'Successfully configured' pattern", () => {
      const warning = guard.checkConfabulation(
        "Successfully configured the proxy.",
        []
      );
      expect(warning).not.toBeNull();
    });

    it("does not trigger when disabled", () => {
      const noCheck = new StabilityGuard({ confabulationCheck: false });
      const warning = noCheck.checkConfabulation("I've set up everything.", []);
      expect(warning).toBeNull();
    });
  });

  describe("check (combined)", () => {
    it("returns both warnings when applicable", () => {
      // Set up loop condition
      guard.recordToolCall({ name: "exec" });
      guard.recordToolCall({ name: "exec" });

      // Third identical call + confabulation claim
      const warnings = guard.check("I've configured everything.", [
        { name: "exec" },
      ]);
      // Should have loop warning (3 consecutive exec calls now)
      expect(warnings.some((w) => w.includes("loop"))).toBe(true);
    });

    it("returns empty array when no issues", () => {
      const warnings = guard.check("Let me search for that.", [
        { name: "write", args: {} },
      ]);
      expect(warnings).toHaveLength(0);
    });
  });

  describe("reset", () => {
    it("clears history", () => {
      guard.recordToolCall({ name: "exec" });
      guard.recordToolCall({ name: "exec" });
      guard.recordToolCall({ name: "exec" });
      guard.reset();
      expect(guard.checkLoop()).toBeNull();
      expect(guard.getHistory()).toHaveLength(0);
    });
  });

  describe("getHistory", () => {
    it("returns a copy of the history", () => {
      guard.recordToolCall({ name: "exec" });
      guard.recordToolCall({ name: "read" });
      const history = guard.getHistory();
      expect(history).toHaveLength(2);
      // Should be a copy
      history.push({ name: "write" });
      expect(guard.getHistory()).toHaveLength(2);
    });
  });
});
