export interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
}

export interface StabilityConfig {
  loopThreshold?: number;
  confabulationCheck?: boolean;
}

// Patterns that indicate an agent is claiming completion
const COMPLETION_PATTERNS = [
  /\bi(?:'ve|'ve| have) (?:set up|configured|installed|created|deployed|fixed|resolved|completed|finished|updated|implemented|added|removed|deleted|built|written)/i,
  /\bdone[!.]?\s*$/im,
  /\bthat(?:'s| is) (?:all )?(?:done|complete|finished|set up|configured)/i,
  /\bsuccessfully (?:set up|configured|installed|created|deployed|fixed|resolved|completed|finished|updated|implemented)/i,
  /\beverything (?:is|has been) (?:set up|configured|ready|complete)/i,
];

// Tool call patterns that indicate actual work was performed
const WORK_TOOL_PATTERNS = [
  /^(?:write|edit|create|delete|exec|bash|run|deploy|install|build)/i,
  /^(?:file_|fs_|shell_|cmd_)/i,
];

export class StabilityGuard {
  private history: ToolCall[] = [];
  private config: Required<StabilityConfig>;

  constructor(config?: StabilityConfig) {
    this.config = {
      loopThreshold: config?.loopThreshold ?? 5,
      confabulationCheck: config?.confabulationCheck ?? true,
    };
  }

  recordToolCall(call: ToolCall): void {
    this.history.push(call);
  }

  checkLoop(): string | null {
    if (this.history.length < this.config.loopThreshold) return null;

    const recent = this.history.slice(-this.config.loopThreshold);
    const firstName = recent[0].name;

    const allSame = recent.every((call) => call.name === firstName);
    if (allSame) {
      return `WARNING: Tool "${firstName}" has been called ${this.config.loopThreshold} times consecutively. This may indicate a loop. Consider a different approach.`;
    }

    return null;
  }

  checkConfabulation(
    agentOutput: string,
    turnToolCalls: ToolCall[]
  ): string | null {
    if (!this.config.confabulationCheck) return null;

    const claimsCompletion = COMPLETION_PATTERNS.some((p) =>
      p.test(agentOutput)
    );
    if (!claimsCompletion) return null;

    const hasWorkTools = turnToolCalls.some((call) =>
      WORK_TOOL_PATTERNS.some((p) => p.test(call.name))
    );

    if (!hasWorkTools && turnToolCalls.length === 0) {
      return `WARNING: Agent claims to have completed an action, but no tool calls were made this turn. The agent may be confabulating. Verify the claimed actions were actually performed.`;
    }

    return null;
  }

  check(agentOutput: string, turnToolCalls: ToolCall[]): string[] {
    const warnings: string[] = [];

    // Record all tool calls from this turn
    for (const call of turnToolCalls) {
      this.recordToolCall(call);
    }

    const loopWarning = this.checkLoop();
    if (loopWarning) warnings.push(loopWarning);

    const confabWarning = this.checkConfabulation(agentOutput, turnToolCalls);
    if (confabWarning) warnings.push(confabWarning);

    return warnings;
  }

  reset(): void {
    this.history = [];
  }

  getHistory(): ToolCall[] {
    return [...this.history];
  }
}
