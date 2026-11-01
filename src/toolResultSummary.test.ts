import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeToolResultMessage } from "./toolResultSummary";

test("summarizes live code reads without exposing hashes", () => {
  const raw = JSON.stringify({
    path: "voice-note-macos/Sources/VoiceNoteMacApp/main.swift",
    hash: "d4f4fca17af188262dfc073be4c0262e1ea7eec4035d5da4c8319f1e0b2d227f",
    live: true,
    startLine: 101,
    endLine: 200,
    text: "let x = 1"
  });
  const summary = summarizeToolResultMessage("code_project", raw);
  assert.equal(summary, "Read voice-note-macos/Sources/VoiceNoteMacApp/main.swift · lines 101–200");
  assert.doesNotMatch(summary, /hash|d4f4fca/i);
});

test("summarizes truncated JSON first lines from step payloads", () => {
  const truncated =
    '{"path":"voice-note-macos/Sources/VoiceNoteMacApp/main.swift","hash":"d4f4fca17af188262d';
  assert.equal(
    summarizeToolResultMessage("code_project", truncated),
    "Inspected voice-note-macos/Sources/VoiceNoteMacApp/main.swift"
  );
});

test("falls back to the first line for ordinary tool text", () => {
  assert.equal(
    summarizeToolResultMessage("run_terminal_command", "Terminal ($ ls) exited with code 0 in 12ms:\nok"),
    "Terminal ($ ls) exited with code 0 in 12ms:"
  );
});
