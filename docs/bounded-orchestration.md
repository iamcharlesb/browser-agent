# Bounded specialist consultations

Reviewed and implemented 2026-10-25 following two supplied conversation transcripts. The transcripts overlap; they are not two independent experiments. They contain repeated SEO consultations, unresolved readings of the same Search Console screen, lost canonical findings, and replies that echo routing text. More discussion did not collect the missing page or competitor evidence. The previous failure-recovery patch did not bound successful but repetitive consultations.

## Research and its application

| Source | Relevant finding or guidance | Application here |
| --- | --- | --- |
| [Cemri et al., Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) | The MAST taxonomy distinguishes repeated steps, lost history, missed stopping conditions, misalignment, and verification failures. Its examples include continued discussion when essential information is missing. | Evaluate these failures separately. Stop repeated consultations and preserve attributed findings and source references. Do not treat an agent's repetition as additional verification. |
| [Du et al., Improving Factuality and Reasoning through Multiagent Debate](https://arxiv.org/abs/2305.14325) | Reports benefits on particular reasoning/factual tasks using a defined debate procedure. | This does not establish that repeatedly consulting a text-only SEO bot will resolve unreadable browser evidence. Keep independent, bounded questions; measure benefits on this application's own tasks. |
| [Anthropic, Building effective agents](https://www.anthropic.com/research/building-effective-agents) | Ground progress in environmental observations and define stopping conditions; use iterative evaluation where improvement can be assessed. | Admission, budgets, cancellation, and tool permissions are application code. Missing observations produce a stated blocker or conditional recommendation in the final answer. |
| [Anthropic, How we built our multi-agent research system](https://www.anthropic.com/research/multi-agent-research-system) | Specialists need an objective, output format, source/tool guidance, and task boundaries; effort should match task complexity. | Specialists return a conclusion, evidence references, a gap, and a next action. They cannot delegate. The coordinator owns the final recommendation. |
| [LangChain, Organizing Context in a Multi-Agent Harness](https://www.langchain.com/blog/organizing-context-in-a-multi-agent-harness) | Context isolation can reduce irrelevant detail, while insufficiently shared context causes repeated collection. | Pass the bounded consultation record, including earlier supplied observations and replies. Do not inject or replace the specialist's unrelated saved user task. |
| [Chip Huyen, AI Engineering, chapter 6: RAG and Agents](https://www.oreilly.com/library/view/ai-engineering/9781098166298/ch06.html) | The publisher's chapter outline covers tools, planning, agent failure modes, evaluation, and memory. | Used as a book reference for further engineering work. Only the available publisher preview/outline was consulted; no claim of a full-book review or an algorithm derived from its unavailable text. |
| [Shoham and Leyton-Brown, Multiagent Systems](https://www.masfoundations.org/) | The authors' available contents cover distributed optimization, communication, and knowledge/belief. | Background reading for explicit coordination protocols. This implementation is not a game-theoretic solver and does not claim a convergence theorem from the book. |

## Algorithm and guarantees

`DiscussionController` owns the state machine:

```text
consulting -> synthesizing -> completed | failed
     \              \
      +--------------+-----> cancelled
```

Admission requires an open discussion, available total time/call budget, available per-specialist budget, a named non-self target, and a question/context pair not already sent to that specialist. Each admitted consultation has an ID. Claiming that ID before execution prevents duplicate local bus delivery from executing it twice. These are local process guarantees, not distributed exactly-once execution.

A completed worker result advances the coordinator. A failed, empty, delegated, or routing-echo result forces synthesis. A repeated specialist answer also forces synthesis, using Jaccard similarity of normalized token sets. This is a lexical stall heuristic, not a semantic evidence checker or calibrated confidence estimate. It can stop useful refinements early; the final answer must retain uncertainty and recommend the most useful next action. Hard total/per-specialist budgets still terminate paraphrases that evade the heuristic.

The coordinator receives a bounded attributed record containing each question, supplied evidence/context, reply, status, and persisted outcome reference. It must not discard an earlier observation merely because a later narrow browser extraction omits it. Reports remain reports; no model conclusion is automatically promoted to verified fact.

Final synthesis has a separate small step/time budget and offers only answer/failure tools. Both engines reject tool calls excluded by runtime permissions, including unexpected calls to `delegate_to_bot`. Thus a model cannot restart research or hand off again during synthesis. If the model/provider fails, the run ends with a visible failure rather than initiating another discussion.

The UI follows `/api/discussions/:id` and attaches SSE using the exact correlated run ID. It can replay a final run that finished between polls, and does not attach to an unrelated globally active run. Reading status is deterministic and never starts a model.

## Environment configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSER_AGENT_MAX_DISCUSSION_ROUNDS` | 4 | Total admitted consultations, shared across all specialists |
| `BROWSER_AGENT_MAX_CONSULTATIONS_PER_BOT` | 2 | Prevent repeated consultation of one specialist, including installations with a legacy 24-round total |
| `BROWSER_AGENT_MAX_DISCUSSION_SECONDS` | 180 | Shared consultation/diagnostic time budget |
| `BROWSER_AGENT_DISCUSSION_REPEAT_PERCENT` | 85 | Lexical similarity threshold for stopping repeated replies |
| `BROWSER_AGENT_DISCUSSION_CONTEXT_CHARS` | 12000 | Total attributed consultation context budget |
| `BROWSER_AGENT_SPECIALIST_MAX_STEPS` | 24 | Worker and intermediate coordinator tool-step limit |
| `BROWSER_AGENT_SYNTHESIS_MAX_STEPS` | 12 | Final-answer step limit |
| `BROWSER_AGENT_SYNTHESIS_MAX_SECONDS` | 60 | Final-answer time limit |

Existing environment values take precedence. Time budgets are checked at transitions and through per-run circuit breakers; an in-flight provider request is also subject to its configured request timeout. This is not a hard real-time cancellation guarantee.

## Verification and remaining work

Deterministic tests reproduce a fourteen-round repetition pattern and stop after two repeated worker results, enforce global/per-bot/time limits, reject self/duplicate requests and routing echoes, preserve source context, and honor cancellation. Mocked-provider tests exercise both engines' final-answer and disabled-delegation paths. UI tests cover correlation, completed-run replay, and cancelled polls. A real HTTP server test uses an isolated temporary runtime and local fake model provider to exercise repeated replies, worker failures, policy rejections, final SSE delivery, and specialist memory isolation without paid calls.

These tests establish bounded control flow, not improved marketing advice or factual accuracy. A paid, representative task evaluation is still needed to measure answer usefulness, verified actions, time to final answer, model calls/tokens, and the rate of reopening resolved checks. Discussion state remains process-owned; restart interrupts it. Queued continuations with missing discussion state fail explicitly instead of silently restarting the old work.
