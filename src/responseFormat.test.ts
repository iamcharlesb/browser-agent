import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatInstructionFor,
  inferResponseFormat,
  inferResponseFormatForFinish
} from "./responseFormat";

test("response format inference from task", () => {
  assert.equal(
    inferResponseFormat("find flower shrubs 4-5ft shipped to 95119"),
    "shopping"
  );
  assert.equal(inferResponseFormat("compare top 3 CRM tools for landscapers"), "comparison");
  assert.equal(inferResponseFormat("get the goals from all the bots"), "roster");
  assert.equal(inferResponseFormat("what's our GSC clicks for magicsite last 28 days"), "metrics");
  assert.equal(inferResponseFormat("how to connect GA4 to the site step by step"), "steps");
  assert.equal(inferResponseFormat("say hello"), "default");
});

test("finish-time inference can fall back to summary shape", () => {
  assert.equal(
    inferResponseFormatForFinish(
      "thanks",
      "Hibiscus Large 4–5 ft in stock for $194.95 ships to 95119 https://example.com/p"
    ),
    "shopping"
  );
  assert.match(formatInstructionFor("shopping"), /###/);
  assert.match(formatInstructionFor("comparison"), /table/);
});