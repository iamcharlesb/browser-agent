import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeCliModelAlias,
  claudeCliResultToChatCompletion,
  flattenMessagesForClaudeCli,
  isClaudeCliModel,
  toolsCatalogForClaudeCli
} from "./claudeCli";
import { TOOLS } from "./agentTools";

test("isClaudeCliModel recognizes cli prefixes only", () => {
  assert.equal(isClaudeCliModel("claude-cli"), true);
  assert.equal(isClaudeCliModel("claude-cli:sonnet"), true);
  assert.equal(isClaudeCliModel("claude-sonnet-4-5"), false);
  assert.equal(isClaudeCliModel("gpt-6-luna"), false);
});

test("claudeCliModelAlias parses optional alias", () => {
  assert.equal(claudeCliModelAlias("claude-cli"), undefined);
  assert.equal(claudeCliModelAlias("claude-cli:sonnet"), "sonnet");
  assert.equal(claudeCliModelAlias("claude-cli:opus"), "opus");
});

test("claudeCliResultToChatCompletion maps structured tool_calls", () => {
  const completion = claudeCliResultToChatCompletion(
    {
      structured: {
        content: "Auditing profile first.",
        tool_calls: [{ name: "navigate", arguments: { url: "https://www.instagram.com/" } }]
      },
      rawResultText: "",
      sessionId: "sess_1",
      model: "claude-sonnet-5",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    },
    "claude-cli"
  );
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.equal(completion.choices[0].message.tool_calls?.[0].function.name, "navigate");
  assert.match(completion.choices[0].message.tool_calls?.[0].function.arguments || "", /instagram/);
  assert.equal(completion.usage?.prompt_tokens, 10);
});

test("flattenMessagesForClaudeCli skips system and keeps tool results", () => {
  const text = flattenMessagesForClaudeCli([
    { role: "system", content: "ignore me" },
    { role: "user", content: "Grow my followers" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", function: { name: "navigate", arguments: "{\"url\":\"https://instagram.com\"}" } }]
    },
    { role: "tool", tool_call_id: "c1", content: "Navigated ok" }
  ]);
  assert.match(text, /Grow my followers/);
  assert.match(text, /ASSISTANT_TOOL_CALL: navigate/);
  assert.match(text, /TOOL_RESULT \(c1\)/);
  assert.doesNotMatch(text, /ignore me/);
});

test("toolsCatalogForClaudeCli lists Pilo tools", () => {
  const catalog = toolsCatalogForClaudeCli(TOOLS);
  assert.match(catalog, /navigate/);
  assert.match(catalog, /finish_task|web_search/);
});
