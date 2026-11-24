/**
 * Backward-compatible shim re-exporting Pilo's pure Node.js agent runner.
 * Replaced the external `@openai/agents` SDK with `nativeAgentRunner.ts`.
 */
export {
  formatObservationForRunner as formatObservationForSdk,
  runWithNativeAgentRunner as runWithOpenAIAgentsSdk,
  type NativeAgentRunOutcome as OpenAIAgentsSdkRunOutcome,
  type NativeAgentToolResult as OpenAIAgentsSdkToolResult,
  type RunNativeAgentOptions as RunOpenAIAgentsSdkOptions
} from "./nativeAgentRunner";
