/** Loop engineering: repetition/oscillation detection, context pruning, circuit breaking. */

const STEP_LABEL_PATTERN = /Step (\d+)/;

export class CircuitBreakerTriggered extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CircuitBreakerTriggered";
  }
}

function normalizeInput(toolInput: Record<string, unknown>): string {
  const entries = Object.entries(toolInput)
    .filter(([key]) => key !== "label")
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

interface StepRecord {
  step: number;
  toolName: string;
  toolInputKey: string;
  preStateHash: string;
  postStateHash: string;
  stateChanged: boolean;
}

export interface SupervisionResult {
  zeroDeltaWarning: boolean;
  repetitionDetected: boolean;
  oscillationDetected: boolean;
  directive: string | null;
}

// Minimal content-block shape this module cares about; callers may pass richer message types.
export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}
export interface PrunableMessage {
  content?: ContentBlock[] | string | null;
  [key: string]: unknown;
}

export class LoopGuard {
  readonly maxSteps: number;
  readonly maxDurationSeconds: number;
  private readonly historyWindow: number;
  private history: StepRecord[] = [];
  private startedAtMs: number;

  constructor(maxSteps = 20, maxDurationSeconds = 900.0, historyWindow = 6) {
    if (maxSteps <= 0) {
      throw new Error("maxSteps must be a positive integer");
    }
    if (maxDurationSeconds <= 0) {
      throw new Error("maxDurationSeconds must be positive");
    }
    if (historyWindow < 4) {
      throw new Error("historyWindow must be at least 4 to detect oscillation");
    }
    this.maxSteps = maxSteps;
    this.maxDurationSeconds = maxDurationSeconds;
    this.historyWindow = historyWindow;
    this.startedAtMs = Date.now();
  }

  elapsedSeconds(): number {
    return (Date.now() - this.startedAtMs) / 1000;
  }

  extendDeadline(seconds: number): void {
    if (seconds > 0) {
      this.startedAtMs += seconds * 1000;
    }
  }

  checkCircuitBreaker(currentStep: number): void {
    if (currentStep > this.maxSteps) {
      throw new CircuitBreakerTriggered(`Maximum step budget of ${this.maxSteps} steps exceeded.`);
    }
    const elapsed = this.elapsedSeconds();
    if (elapsed > this.maxDurationSeconds) {
      throw new CircuitBreakerTriggered(
        `Maximum time budget of ${this.maxDurationSeconds.toFixed(0)}s exceeded (elapsed ${elapsed.toFixed(0)}s).`
      );
    }
  }

  recordStep(
    step: number,
    toolName: string,
    toolInput: Record<string, unknown>,
    preStateHash: string,
    postStateHash: string
  ): StepRecord {
    const record: StepRecord = {
      step,
      toolName,
      toolInputKey: normalizeInput(toolInput),
      preStateHash,
      postStateHash,
      stateChanged: preStateHash !== postStateHash
    };
    this.history.push(record);
    if (this.history.length > this.historyWindow) {
      this.history.shift();
    }
    return record;
  }

  detectRepetition(): boolean {
    if (this.history.length < 2) {
      return false;
    }
    const last = this.history[this.history.length - 1];
    const prev = this.history[this.history.length - 2];
    const sameAction = last.toolName === prev.toolName && last.toolInputKey === prev.toolInputKey;
    const bothNoOp = !last.stateChanged && !prev.stateChanged;
    return sameAction && bothNoOp;
  }

  detectOscillation(): boolean {
    if (this.history.length < 4) {
      return false;
    }
    const [a, b, c, d] = this.history.slice(-4);
    const alternates =
      a.toolName === c.toolName &&
      a.toolInputKey === c.toolInputKey &&
      b.toolName === d.toolName &&
      b.toolInputKey === d.toolInputKey &&
      !(a.toolName === b.toolName && a.toolInputKey === b.toolInputKey);
    const returnedToPriorState = d.postStateHash === a.preStateHash;
    return alternates && returnedToPriorState;
  }

  tacticSwitchDirective(): string {
    return (
      "SYSTEM SUPERVISOR WARNING: You appear to be stuck in a repetitive or oscillating loop. " +
      "Do not repeat the last action verbatim. Switch tactics: inspect a different element, " +
      "scroll further to reveal new content, use key_press('Escape') to dismiss an overlay, " +
      "navigate directly to a known URL, or call fail_task if the goal appears unreachable."
    );
  }

  supervise(
    step: number,
    toolName: string,
    toolInput: Record<string, unknown>,
    preStateHash: string,
    postStateHash: string
  ): SupervisionResult {
    const record = this.recordStep(step, toolName, toolInput, preStateHash, postStateHash);
    const repetition = this.detectRepetition();
    const oscillation = this.detectOscillation();
    return {
      zeroDeltaWarning: !record.stateChanged,
      repetitionDetected: repetition,
      oscillationDetected: oscillation,
      directive: repetition || oscillation ? this.tacticSwitchDirective() : null
    };
  }

  /**
   * Replaces image blocks in older turns with text placeholders, in place.
   * Keeps only the `keepRecentImages` most recently appended screenshots intact.
   * Returns the number of screenshots pruned in this call.
   */
  pruneContext(messages: PrunableMessage[], keepRecentImages = 2): number {
    if (keepRecentImages < 0) {
      throw new Error("keepRecentImages must be non-negative");
    }

    const imageLocations: Array<{ msgIdx: number; blockIdx: number; stepLabel: number }> = [];
    messages.forEach((message, msgIdx) => {
      const content = message.content;
      if (!Array.isArray(content)) {
        return;
      }
      let stepLabel = msgIdx + 1;
      content.forEach((block, blockIdx) => {
        if (!block || typeof block !== "object") {
          return;
        }
        if (block.type === "text" && typeof block.text === "string") {
          const match = STEP_LABEL_PATTERN.exec(block.text);
          if (match) {
            stepLabel = Number(match[1]);
          }
        } else if (block.type === "image_url") {
          imageLocations.push({ msgIdx, blockIdx, stepLabel });
        }
      });
    });

    if (imageLocations.length <= keepRecentImages) {
      return 0;
    }

    const toPrune = imageLocations.slice(0, imageLocations.length - keepRecentImages);
    for (const { msgIdx, blockIdx, stepLabel } of toPrune) {
      const content = messages[msgIdx].content as ContentBlock[];
      content[blockIdx] = { type: "text", text: `[Screenshot archived at Step ${stepLabel}]` };
    }
    return toPrune.length;
  }
}
