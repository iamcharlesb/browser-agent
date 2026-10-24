import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessageBus, TOPICS } from "./messageBus";
import {
  LearnModeSession,
  LearnRunOutcome,
  STELLAR_THRESHOLD,
  defaultUserSimulator,
  notesFromScores,
  relevanceOverlap,
  scoreExperience,
  summarizeRunEvents,
  toLearnTurn
} from "./learnMode";
import { AgentEvent } from "./promptLoop";

const greatOutcome: LearnRunOutcome = {
  summary: "Your profile has 1,204 followers and the bio is two lines. Want me to draft three post ideas?",
  success: true,
  stepsTaken: 3,
  elapsedSeconds: 12,
  terminationReason: "finish_task",
  events: [
    { type: "step", toolName: "navigate", ok: true },
    { type: "step", toolName: "extract_page_data", ok: true }
  ]
};

function repeatOutcome(summary: string, overrides: Partial<LearnRunOutcome> = {}): LearnRunOutcome {
  return { ...greatOutcome, summary, ...overrides };
}

test("run telemetry is pulled out of the event stream", () => {
  const events: AgentEvent[] = [
    { type: "step", toolName: "navigate", ok: true },
    { type: "step", toolName: "click_mark", ok: false },
    { type: "step", toolName: "click_mark", ok: true, warning: "no visible change" },
    { type: "privileged_approval_required", toolName: "run_terminal_command" },
    { type: "human_verification" },
    { type: "usage", model: "gpt-6-luna" }
  ];
  const telemetry = summarizeRunEvents(events);
  assert.equal(telemetry.toolCalls, 3);
  assert.equal(telemetry.failedToolCalls, 1);
  assert.equal(telemetry.repeatedToolCalls, 1);
  assert.equal(telemetry.supervisorWarnings, 1);
  assert.equal(telemetry.approvalPrompts, 1);
  assert.equal(telemetry.verificationPauses, 1);
});

test("a clean, fast, finished run scores stellar", () => {
  const scores = scoreExperience([toLearnTurn(0, "check my profile", greatOutcome)]);
  for (const score of scores) {
    assert.ok(score.score >= STELLAR_THRESHOLD, `${score.dimension} scored ${score.score}: ${score.evidence}`);
  }
  assert.deepEqual(notesFromScores(scores), []);
});

test("an unreachable model scores outcome zero and is called out", () => {
  const scores = scoreExperience([
    toLearnTurn(0, "check my profile", {
      ...greatOutcome,
      success: false,
      terminationReason: "llm_error",
      summary: "I couldn't reach the selected model."
    })
  ]);
  const outcome = scores.find((score) => score.dimension === "outcome");
  assert.equal(outcome?.score, 0);
  assert.match(outcome?.evidence ?? "", /unreachable/);
  const notes = notesFromScores(scores);
  assert.equal(notes[0].severity, "blocker");
});

test("stalling on the user instead of looking costs momentum", () => {
  const scores = scoreExperience([
    toLearnTurn(0, "grow my followers", {
      ...greatOutcome,
      stepsTaken: 1,
      summary: "Happy to help! What's your niche?",
      events: []
    })
  ]);
  const momentum = scores.find((score) => score.dimension === "momentum");
  assert.ok((momentum?.score ?? 5) < STELLAR_THRESHOLD, momentum?.evidence);
  assert.match(momentum?.evidence ?? "", /without doing any work/);
});

test("filler openers and bullet walls cost clarity", () => {
  const bulletWall = [
    "Certainly! Here are several strategies:",
    "- **One**: do a thing",
    "- **Two**: do a thing",
    "- **Three**: do a thing",
    "- **Four**: do a thing",
    "- **Five**: do a thing"
  ].join("\n");
  const scores = scoreExperience([toLearnTurn(0, "help me market", repeatOutcome(bulletWall))]);
  const clarity = scores.find((score) => score.dimension === "clarity");
  assert.ok((clarity?.score ?? 5) < STELLAR_THRESHOLD, clarity?.evidence);
  assert.match(clarity?.evidence ?? "", /filler|bullet wall/);
});

test("repeating an earlier reply on a follow-up costs continuity", () => {
  const transcript = [
    toLearnTurn(0, "check my profile", greatOutcome),
    toLearnTurn(1, "now do the first step", greatOutcome)
  ];
  const continuity = scoreExperience(transcript).find((score) => score.dimension === "continuity");
  assert.ok((continuity?.score ?? 5) < STELLAR_THRESHOLD, continuity?.evidence);
  assert.match(continuity?.evidence ?? "", /repeated an earlier reply/);
});

test("failed tool calls cost reliability", () => {
  const scores = scoreExperience([
    toLearnTurn(0, "open my profile", {
      ...greatOutcome,
      events: [
        { type: "step", toolName: "click_mark", ok: false },
        { type: "step", toolName: "navigate", ok: true }
      ]
    })
  ]);
  const reliability = scores.find((score) => score.dimension === "reliability");
  assert.ok((reliability?.score ?? 5) < STELLAR_THRESHOLD, reliability?.evidence);
  assert.match(reliability?.evidence ?? "", /1\/2 tool call/);
});

test("the simulated user pushes back on a failure and stops after a dead model", () => {
  const firstTurn = defaultUserSimulator({ task: "check my bio", round: 0, transcript: [] });
  assert.equal(firstTurn, "check my bio");

  const afterFailure = defaultUserSimulator({
    task: "check my bio",
    round: 1,
    transcript: [toLearnTurn(0, "check my bio", { ...greatOutcome, success: false, summary: "Could not load the page." })]
  });
  assert.match(afterFailure ?? "", /didn't work/);

  const afterStall = defaultUserSimulator({
    task: "check my bio",
    round: 1,
    transcript: [toLearnTurn(0, "check my bio", repeatOutcome("What's your niche?"))]
  });
  assert.match(afterStall ?? "", /find yourself/);

  const afterLlmError = defaultUserSimulator({
    task: "check my bio",
    round: 1,
    transcript: [toLearnTurn(0, "check my bio", { ...greatOutcome, terminationReason: "llm_error" })]
  });
  assert.equal(afterLlmError, null, "nothing to probe when the model never answered");
});

test("a stellar session proposes no patches, verifies, and reports stellar", async () => {
  const bus = new MessageBus();
  const reportDir = await mkdtemp(join(tmpdir(), "learn-report-"));
  const topics: string[] = [];
  bus.subscribe("learn.#", (message) => { topics.push(message.topic); });
  let proposeCalls = 0;

  const report = await new LearnModeSession({
    task: "read my bio and tell me the follower count",
    bus,
    repoRoot: reportDir,
    reportDir,
    maxRounds: 1,
    runner: async () => greatOutcome,
    verify: async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 1 }] }),
    proposePatches: async () => {
      proposeCalls += 1;
      return [];
    }
  }).run();

  assert.equal(report.verdict, "stellar");
  assert.equal(report.stellar, true);
  assert.equal(report.notes.length, 0);
  assert.equal(proposeCalls, 0, "a stellar session never asks for patches");
  assert.match(report.confirmation, /Verified/);
  assert.ok(topics.includes(TOPICS.learnStarted));
  assert.ok(topics.includes(TOPICS.learnUserTurn));
  assert.ok(topics.includes(TOPICS.learnBotTurn));
  assert.ok(topics.includes(TOPICS.learnVerified));
  assert.ok(topics.includes(TOPICS.learnCompleted));

  const persisted = JSON.parse(await readFile(join(reportDir, "latest.json"), "utf8"));
  assert.equal(persisted.sessionId, report.sessionId);
});

test("a poor session records areas, applies a verified fix, and reports improved", async () => {
  const bus = new MessageBus();
  const root = await mkdtemp(join(tmpdir(), "learn-fix-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "promptLoop.ts"), "const rule = 'ask the user first';\n", "utf8");
  const learnings: string[] = [];

  const report = await new LearnModeSession({
    task: "grow my followers",
    bus,
    repoRoot: root,
    maxRounds: 1,
    runner: async () => repeatOutcome("Certainly! What's your niche?", { stepsTaken: 1, events: [] }),
    verify: async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 1 }] }),
    proposePatches: async ({ notes }) => {
      assert.ok(notes.length > 0, "a poor session must produce notes to fix");
      return [
        {
          file: "src/promptLoop.ts",
          find: "'ask the user first'",
          replace: "'look at the page first'",
          rationale: "stop stalling on the user"
        }
      ];
    },
    onFixApproval: (proposal) => {
      assert.equal(proposal.fixes.length, 1);
      assert.match(proposal.fixes[0].preview, /ask the user first/);
      return { approved: true };
    },
    onLearning: ({ text }) => {
      learnings.push(text);
    }
  }).run();

  assert.equal(report.stellar, false);
  assert.equal(report.verdict, "improved");
  assert.equal(report.fix?.applied, true);
  assert.match(await readFile(join(root, "src", "promptLoop.ts"), "utf8"), /look at the page first/);
  assert.ok(report.notes.length > 0);
  assert.ok(learnings.length > 0, "findings are written into the learning KB");
  assert.match(report.confirmation, /Verified/);
});

test("a fix that breaks the build is rolled back and the verdict needs a human", async () => {
  const bus = new MessageBus();
  const root = await mkdtemp(join(tmpdir(), "learn-rollback-"));
  await mkdir(join(root, "src"), { recursive: true });
  const original = "const rule = 'ask the user first';\n";
  await writeFile(join(root, "src", "promptLoop.ts"), original, "utf8");

  const report = await new LearnModeSession({
    task: "grow my followers",
    bus,
    repoRoot: root,
    maxRounds: 1,
    runner: async () => repeatOutcome("Certainly! What's your niche?", { stepsTaken: 1, events: [] }),
    verify: async () => ({ ok: false, checks: [{ name: "typecheck", ok: false, output: "TS1005", durationMs: 1 }] }),
    proposePatches: async () => [
      { file: "src/promptLoop.ts", find: "'ask the user first'", replace: "'broken", rationale: "bad edit" }
    ],
    onFixApproval: () => ({ approved: true })
  }).run();

  assert.equal(report.verdict, "needs_human");
  assert.equal(report.fix?.rolledBack, true);
  assert.equal(await readFile(join(root, "src", "promptLoop.ts"), "utf8"), original, "tree is untouched");
  assert.match(report.confirmation, /Not verified/);
});

test("self-fix off reports the areas and never patches", async () => {
  const bus = new MessageBus();
  const root = await mkdtemp(join(tmpdir(), "learn-nofix-"));
  let proposeCalls = 0;

  const report = await new LearnModeSession({
    task: "grow my followers",
    bus,
    repoRoot: root,
    maxRounds: 1,
    allowSelfFix: false,
    runner: async () => repeatOutcome("Certainly! What's your niche?", { stepsTaken: 1, events: [] }),
    verify: async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 1 }] }),
    proposePatches: async () => {
      proposeCalls += 1;
      return [];
    }
  }).run();

  assert.equal(proposeCalls, 0);
  assert.equal(report.fix, undefined);
  assert.equal(report.verdict, "needs_human");
  assert.ok(report.notes.length > 0);
});

test("a crashing runner ends the session instead of looping", async () => {
  const bus = new MessageBus();
  const root = await mkdtemp(join(tmpdir(), "learn-crash-"));
  let runs = 0;

  const report = await new LearnModeSession({
    task: "do the thing",
    bus,
    repoRoot: root,
    maxRounds: 3,
    runner: async () => {
      runs += 1;
      throw new Error("browser died");
    },
    verify: async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 1 }] })
  }).run();

  assert.equal(runs, 1, "a crash stops the self-play loop");
  assert.equal(report.rounds, 1);
  assert.match(report.transcript[0].botSummary, /browser died/);
  assert.equal(report.verdict, "needs_human");
});

test("patches are proposed, not applied, when nobody is asked", async () => {
  const bus = new MessageBus();
  const root = await mkdtemp(join(tmpdir(), "learn-unapproved-"));
  await mkdir(join(root, "src"), { recursive: true });
  const original = "const rule = 'ask the user first';\n";
  await writeFile(join(root, "src", "promptLoop.ts"), original, "utf8");
  const topics: string[] = [];
  bus.subscribe("learn.#", (message) => { topics.push(message.topic); });

  // No onFixApproval hook at all - the run loop's rule applies: unapproved means it doesn't happen.
  const report = await new LearnModeSession({
    task: "grow my followers",
    bus,
    repoRoot: root,
    maxRounds: 1,
    runner: async () => repeatOutcome("Certainly! What's your niche?", { stepsTaken: 1, events: [] }),
    verify: async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 1 }] }),
    proposePatches: async () => [
      { file: "src/promptLoop.ts", find: "'ask the user first'", replace: "'look first'", rationale: "stop stalling" }
    ]
  }).run();

  assert.equal(await readFile(join(root, "src", "promptLoop.ts"), "utf8"), original, "nothing may be written");
  assert.equal(report.fixDecision, "denied");
  assert.equal(report.fix, undefined);
  assert.equal(report.verdict, "needs_human");
  assert.equal(report.proposal?.fixes.length, 1, "the proposal is kept as a record");
  assert.equal(report.proposal?.fixes[0].id, "fix-1");
  assert.ok(topics.includes(TOPICS.learnFixProposed));
  assert.ok(topics.includes(TOPICS.learnFixDecision));
  assert.ok(!topics.includes(TOPICS.learnFixApplied));
  assert.match(report.confirmation, /waiting - nothing was changed/);
});

test("declining leaves the tree untouched and still records the proposal", async () => {
  const bus = new MessageBus();
  const root = await mkdtemp(join(tmpdir(), "learn-declined-"));
  await mkdir(join(root, "src"), { recursive: true });
  const original = "const rule = 'ask the user first';\n";
  await writeFile(join(root, "src", "promptLoop.ts"), original, "utf8");

  const report = await new LearnModeSession({
    task: "grow my followers",
    bus,
    repoRoot: root,
    maxRounds: 1,
    runner: async () => repeatOutcome("Certainly! What's your niche?", { stepsTaken: 1, events: [] }),
    verify: async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 1 }] }),
    proposePatches: async () => [
      { file: "src/promptLoop.ts", find: "'ask the user first'", replace: "'look first'", rationale: "stop stalling" }
    ],
    onFixApproval: () => ({ approved: false, reason: "I want to read it myself first" })
  }).run();

  assert.equal(await readFile(join(root, "src", "promptLoop.ts"), "utf8"), original);
  assert.equal(report.fixDecision, "denied");
  assert.match(report.fixDecisionReason ?? "", /read it myself/);
  assert.ok(report.proposal, "the proposal survives a denial so it can be acted on later");
});

test("only the ticked patches are applied", async () => {
  const bus = new MessageBus();
  const root = await mkdtemp(join(tmpdir(), "learn-subset-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "promptLoop.ts"), "const a = 'one';\nconst b = 'two';\n", "utf8");

  const report = await new LearnModeSession({
    task: "grow my followers",
    bus,
    repoRoot: root,
    maxRounds: 1,
    runner: async () => repeatOutcome("Certainly! What's your niche?", { stepsTaken: 1, events: [] }),
    verify: async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 1 }] }),
    proposePatches: async () => [
      { file: "src/promptLoop.ts", find: "'one'", replace: "'uno'", rationale: "wanted" },
      { file: "src/promptLoop.ts", find: "'two'", replace: "'dos'", rationale: "not wanted" }
    ],
    onFixApproval: () => ({ approved: true, patchIds: ["fix-1"] })
  }).run();

  const content = await readFile(join(root, "src", "promptLoop.ts"), "utf8");
  assert.match(content, /'uno'/, "the ticked patch applies");
  assert.match(content, /'two'/, "the unticked patch does not");
  assert.equal(report.fix?.patches.length, 1);
  assert.equal(report.verdict, "improved");
});

test("an approval hook that throws is treated as a decline", async () => {
  const bus = new MessageBus();
  const root = await mkdtemp(join(tmpdir(), "learn-hookfail-"));
  await mkdir(join(root, "src"), { recursive: true });
  const original = "const rule = 'ask the user first';\n";
  await writeFile(join(root, "src", "promptLoop.ts"), original, "utf8");

  const report = await new LearnModeSession({
    task: "grow my followers",
    bus,
    repoRoot: root,
    maxRounds: 1,
    runner: async () => repeatOutcome("Certainly! What's your niche?", { stepsTaken: 1, events: [] }),
    verify: async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 1 }] }),
    proposePatches: async () => [
      { file: "src/promptLoop.ts", find: "'ask the user first'", replace: "'look first'", rationale: "x" }
    ],
    onFixApproval: () => {
      throw new Error("UI disconnected");
    }
  }).run();

  assert.equal(await readFile(join(root, "src", "promptLoop.ts"), "utf8"), original);
  assert.equal(report.fixDecision, "denied");
  assert.match(report.fixDecisionReason ?? "", /approval hook failed/);
});

test("the written document carries the findings and the exact diffs", async () => {
  const bus = new MessageBus();
  const reportDir = await mkdtemp(join(tmpdir(), "learn-doc-"));
  await mkdir(join(reportDir, "src"), { recursive: true });
  await writeFile(join(reportDir, "src", "promptLoop.ts"), "const rule = 'ask the user first';\n", "utf8");

  const report = await new LearnModeSession({
    task: "grow my followers",
    bus,
    repoRoot: reportDir,
    reportDir,
    maxRounds: 1,
    runner: async () => repeatOutcome("Certainly! What's your niche?", { stepsTaken: 1, events: [] }),
    verify: async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 1 }] }),
    proposePatches: async () => [
      { file: "src/promptLoop.ts", find: "'ask the user first'", replace: "'look first'", rationale: "stop stalling" }
    ],
    onFixApproval: () => ({ approved: false, reason: "not now" })
  }).run();

  const document = await readFile(join(reportDir, "latest.md"), "utf8");
  assert.match(document, /# Learn session/);
  assert.match(document, /## Scores/);
  assert.match(document, /## Areas to improve/);
  assert.match(document, /## Proposed code changes/);
  assert.match(document, /\*\*Not applied\*\* - not now/);
  // The diff shows the exact find/replace text the patch acts on, not whole lines.
  assert.match(document, /-'ask the user first'/);
  assert.match(document, /\+'look first'/);
  assert.match(document, /What's your niche\?/, "the transcript is in the write-up");
  assert.ok(document.includes(report.sessionId));
});

test("a stellar session writes a document that says nothing needs changing", async () => {
  const bus = new MessageBus();
  const reportDir = await mkdtemp(join(tmpdir(), "learn-doc-ok-"));

  await new LearnModeSession({
    task: "read my bio",
    bus,
    repoRoot: reportDir,
    reportDir,
    maxRounds: 1,
    runner: async () => greatOutcome,
    verify: async () => ({ ok: true, checks: [{ name: "stub", ok: true, output: "", durationMs: 1 }] })
  }).run();

  const document = await readFile(join(reportDir, "latest.md"), "utf8");
  assert.match(document, /None - every dimension cleared the bar/);
  assert.match(document, /None needed\./);
});

test("a long reply that has nothing to do with the question is caught", () => {
  // Taken from a real session: the local engine answered a maths question with film trivia and the
  // process-only rubric scored it a clean 5/5.
  const offTopic =
    "### Local Research Results (Zero Cloud)\n" +
    "Web search results for \"calculate 2 + 2 and tell me the answer\":\n" +
    "- Wikipedia (Guardians of the Galaxy Vol. 2): Covenant. Vol. 2 remained at number two in its " +
    "fourth weekend, this time behind Pirates of the Caribbean: Dead Men Tell No Tales, and crossed " +
    "$337.6 million\n" +
    "- Wikipedia (Avengers: Endgame): visit the Asgardian refugee settlement of New Asgard and " +
    "recruit an overweight, despondent Thor. In Tokyo, Romanoff recruits Clint Barton, who became";

  const scores = scoreExperience([
    toLearnTurn(0, "check my instagram follower count", {
      ...greatOutcome,
      summary: offTopic,
      events: [{ type: "step", toolName: "web_search", ok: true }]
    })
  ]);
  const relevance = scores.find((score) => score.dimension === "relevance");
  assert.ok(relevance, "a long reply must be judged for relevance");
  assert.ok((relevance?.score ?? 5) < STELLAR_THRESHOLD, relevance?.evidence);
  assert.match(relevance?.evidence ?? "", /sharing nothing with the question/);
  assert.ok(notesFromScores(scores).some((note) => note.dimension === "relevance"));
});

test("a short correct answer is never punished for sharing no words with the question", () => {
  const scores = scoreExperience([toLearnTurn(0, "calculate 2 + 2 and tell me the answer", repeatOutcome("4"))]);
  assert.equal(
    scores.find((score) => score.dimension === "relevance"),
    undefined,
    "terse replies are exempt - a correct answer often shares nothing with its question"
  );
  for (const score of scores) {
    assert.ok(score.score >= STELLAR_THRESHOLD, `${score.dimension}: ${score.evidence}`);
  }
});

test("a long on-topic reply still scores relevant", () => {
  const onTopic =
    "Your instagram profile has 1,204 followers, up 38 this week. The bio is two lines and the link " +
    "points at a dead page. Engagement sits around 3.1% on the last nine posts, which is healthy for " +
    "a follower count that size, and the three reels you posted in October account for most of the " +
    "new followers. The profile photo is low resolution on desktop. Want me to draft a tighter bio " +
    "and three post ideas built around what the reels did well, or fix the link first?";
  const scores = scoreExperience([
    toLearnTurn(0, "check my instagram profile and follower count", repeatOutcome(onTopic))
  ]);
  const relevance = scores.find((score) => score.dimension === "relevance");
  assert.ok(relevance, "the reply is long enough to be judged");
  assert.ok((relevance?.score ?? 0) >= STELLAR_THRESHOLD, relevance?.evidence);
});

test("relevance overlap only applies above the word threshold", () => {
  assert.equal(relevanceOverlap("check my profile", "Short answer."), null);
  assert.equal(relevanceOverlap("", "x ".repeat(60)), null, "nothing was asked about");
  // "instagram", "follower" and "count" land; the verb "check" does not, so 3 of 4 content words.
  const overlap = relevanceOverlap("check my instagram follower count", `instagram follower count ${"filler ".repeat(50)}`);
  assert.equal(overlap, 0.75);
});

test("quoting the question back does not count as answering it", () => {
  // The exact shape that slipped through the first version: a tool echoes the request in its
  // header, so every word of the question appeared in the reply and it scored a perfect 5.
  const question = "calculate 2 + 2 and tell me the answer";
  const echoed =
    `### Local Research Results (Zero Cloud)\nWeb search results for "${question}":\n` +
    "- Wikipedia (Guardians of the Galaxy Vol. 2): Covenant. Vol. 2 remained at number two in its " +
    "fourth weekend, behind Pirates of the Caribbean: Dead Men Tell No Tales, crossing $337.6 million\n" +
    "- Wikipedia (Avengers: Endgame): visit the Asgardian refugee settlement of New Asgard and " +
    "recruit an overweight, despondent Thor. In Tokyo, Romanoff recruits Clint Barton, who became";

  assert.equal(relevanceOverlap(question, echoed), 0, "the echoed question must not count");

  const scores = scoreExperience([toLearnTurn(0, question, repeatOutcome(echoed))]);
  const relevance = scores.find((score) => score.dimension === "relevance");
  assert.ok((relevance?.score ?? 5) < STELLAR_THRESHOLD, relevance?.evidence);
  assert.equal(scores.every((score) => score.score >= STELLAR_THRESHOLD), false, "this must not be stellar");
});

test("a reply that reuses some of the asker's words is still on topic", () => {
  // Only a full verbatim echo is stripped; normal word reuse is real relevance.
  const body =
    "Your instagram follower count is 1,204 right now, up 38 this week. Most of that came from the " +
    "three reels you posted in October, which pulled far better engagement than the static posts. " +
    "The follower graph is steady otherwise, and nothing looks like bot traffic. Want me to dig " +
    "into which of the three reels did the heavy lifting, or look at the posting times next?";
  const overlap = relevanceOverlap("check my instagram follower count", body);
  assert.ok(overlap !== null && overlap >= 0.75, `overlap was ${overlap}`);
});

test("one off-topic round is not averaged away by a good one", () => {
  const onTopic =
    "Your instagram follower count is 1,204 right now, up 38 this week. Most of that came from the " +
    "three reels you posted in October, which pulled far better engagement than the static posts. " +
    "The follower graph is otherwise steady and nothing looks like bot traffic at all this month.";
  const offTopic =
    "Wikipedia (Guardians of the Galaxy Vol. 2): Covenant. Vol. 2 remained at number two in its " +
    "fourth weekend, behind Pirates of the Caribbean: Dead Men Tell No Tales, crossing $337.6 " +
    "million worldwide before dropping out of the top five entirely the following weekend overseas.";

  const scores = scoreExperience([
    toLearnTurn(0, "check my instagram follower count", repeatOutcome(onTopic)),
    toLearnTurn(1, "now show me which reel did best", repeatOutcome(offTopic))
  ]);
  const relevance = scores.find((score) => score.dimension === "relevance");
  assert.ok((relevance?.score ?? 5) < STELLAR_THRESHOLD, relevance?.evidence);
  assert.match(relevance?.evidence ?? "", /round 1 .*sharing nothing/);
});

test("follow-up round with defaultUserSimulator prompt is judged against established session topic", () => {
  const round0Proposal =
    "MagicSite serves home-service contractors (HVAC, plumbing, roofing) with website + lead capture. " +
    "Step 1 is a starter keyword map and pillar page brief targeting contractor website software.";
  const round1Execution =
    "First step done: a starter keyword map for MagicSite targeting home-service contractors across the country. " +
    "Commercial pages to prioritize include Website builder for contractors, HVAC marketing software, " +
    "plumbing website design, and roofing lead capture pages with clear booking CTAs, local SEO proof, " +
    "service area landing pages, customer review widgets, and instant quote request forms for field teams.";

  const scores = scoreExperience([
    toLearnTurn(0, "improve our MagicSite SEO content strategy", repeatOutcome(round0Proposal)),
    toLearnTurn(
      1,
      "Good. Now actually do the first concrete step you proposed, and show me the result.",
      repeatOutcome(round1Execution)
    )
  ]);
  const relevance = scores.find((score) => score.dimension === "relevance");
  assert.ok(relevance, "relevance score is present");
  assert.ok((relevance?.score ?? 0) >= STELLAR_THRESHOLD, relevance?.evidence);
});

test("Stop prevents more rehearsal rounds and patch proposals", async () => {
  let stopped = false, rounds = 0, proposals = 0;
  const session = new LearnModeSession({
    task: "Inspect this page", bus: new MessageBus(), repoRoot: process.cwd(),
    shouldAbort: () => stopped,
    userSimulator: () => "Continue inspecting",
    runner: async () => {
      rounds++; stopped = true;
      return repeatOutcome("Stopped by user", { success: false, terminationReason: "stopped" });
    },
    proposePatches: async () => { proposals++; return []; }
  });
  await session.run();
  assert.equal(rounds, 1);
  assert.equal(proposals, 0);
});
