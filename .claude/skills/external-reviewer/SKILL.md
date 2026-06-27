---
name: external-reviewer
description: >
  Scaffold external, independent adversarial review into a swamp repo. Use when
  the user wants to set up a @swamp/software-factory whose review (and optionally
  plan-authoring) stages are handled by a SEPARATE external CLI coding agent
  (codex, claude, gemini, ...) via @mgreten/cli-agent, instead of same-context
  dispatch subagents. Triggers on "external reviewer", "independent review",
  "adversarial review with codex/another agent", "set up external-reviewer", and
  questions about wiring a factory review stage to the external-review-findings
  or external-review-plan-author workflows shipped by @atalanta/external-reviewer.
  This skill PRINTS A RUNBOOK for the user to review and run; it does not execute
  the setup commands itself.
---

# External Reviewer Skill

Scaffold a swamp repo so a `@swamp/software-factory` run routes its review (and,
if wanted, plan-authoring) stages to an **independent external CLI agent** rather
than to same-context dispatch subagents.

The pitch: the factory driver *implements*; a separate agent *reviews*. They
never share a context, so the review is genuinely adversarial. This bundle is a
composition of `@swamp/software-factory` (the SDLC state machine) and
`@mgreten/cli-agent` (the external-agent invoker) — it carries only the bridge
between them.

## What this bundle provides

- **`external-review-findings`** — a workflow that runs the external agent as the
  adversarial reviewer over a factory work item and persists its findings JSON.
- **`external-review-plan-author`** — a workflow that runs the external agent to
  author/revise a plan payload from swamp records.
- **This skill** — the scaffolding runbook below.
- **A factory skeleton** — `references/factory-skeleton.yaml`, a generic,
  language-agnostic SDLC graph with review stages already wired to
  `external-review-findings`.

## How the bridge actually works (read this first)

`@mgreten/cli-agent`'s `invokeAndParse` does **not** return the parsed JSON as a
workflow step output. It writes an `invocation-<id>` resource on the reviewer
model whose `parsedResponse` holds the parsed findings/plan payload, tagged with
`{factory, workItem, artifact}`. So the flow is:

1. Driver hits a review stage and runs `external-review-findings` (handing it the
   factory name, work item, the artifact name e.g. `code-review`, and the
   reviewer prompt).
2. The workflow invokes the external agent, which reads the work products from
   swamp itself and returns findings JSON; that JSON lands in `parsedResponse` on
   the reviewer model's `invocation` resource.
3. The driver **queries swamp data** for that invocation and records the findings
   on the factory via `resolve_findings` (or, for the plan author, the payload
   via `record_artifact`).

Query the most recent matching invocation like this (substitute the reviewer
model name, work item, and artifact):

```bash
swamp data query 'modelName == "external-reviewer" && specName == "invocation" \
  && attributes.tags.workItem == "<workItem>" \
  && attributes.tags.artifact == "<artifact>"' \
  --select '{"findings": attributes.parsedResponse, "ok": attributes.success}' --json
```

## Scaffolding runbook

> Review each command before running it. This skill intentionally does not
> execute them for you — instance creation writes a fresh, repo-specific UUID and
> is worth a human glance.

### 1. Pull the dependencies

Latest is fine; note the version floor — the codex provider needs
`@mgreten/cli-agent >= 2026.06.25.1`.

```bash
swamp extension pull @swamp/software-factory
swamp extension pull @mgreten/cli-agent   # >= 2026.06.25.1 for the codex provider
```

### 2. Create the reviewer model instance (fresh UUID per repo)

The instance is named `external-reviewer` (provider-neutral) so it does not lie
if you later swap providers. Defaults to codex / gpt-5.5; change `defaultProvider`
and `defaultModel` to use claude, gemini, opencode, or amp instead.

```bash
swamp model create @mgreten/cli-agent external-reviewer
swamp model edit external-reviewer
```

Set a minimal `globalArguments` — only what the reviewer needs (every key below
is swappable; provider and model are the ones you actually choose):

```yaml
globalArguments:
  defaultProvider: codex      # codex | claude | gemini | opencode | amp
  defaultModel: gpt-5.5       # provider-appropriate model id
  codexPath: codex            # path/alias to the chosen provider's CLI
  wallTimeoutMs: 900000       # hard ceiling per invocation (15 min)
  maxRetries: 1
```

Confirm the chosen provider's CLI is installed and authenticated on this machine
(e.g. `codex`, `claude`, `gemini` on PATH) — the reviewer shells out to it.

### 3. Drop the factory skeleton

The skeleton ships in this skill at `references/factory-skeleton.yaml`. It is
**language-agnostic** and carries placeholders, not project content. Instantiate
a fresh factory and paste the skeleton's `globalArguments` into it (do not copy a
pre-baked instance — let `model create` mint a fresh UUID):

```bash
swamp model create @swamp/software-factory my-factory
swamp model edit my-factory   # paste globalArguments from references/factory-skeleton.yaml
```

Then fill the per-project content the skeleton leaves blank:

- stage `prompt`s,
- artifact/findings `schema`s,
- each stage's `skills` list,
- the `testing` stage's build/test command (point its `mode: method` stage at a
  repo-local `command/shell` model, gated on `exitCode: 0`).

### 4. Verify the wiring

The skeleton's `plan-review` and `code-review` stages are documented to be driven
via `external-review-findings`. Validate the factory graph, then drive as normal:

```bash
swamp model method run my-factory validate
swamp model method run my-factory start --input workItem=<ISSUE>
```

When you reach a review stage, run the bridge workflow (override `cwd` if the
factory repo is not the current directory):

```bash
swamp workflow run @atalanta/external-reviewer/external-review-findings \
  --input factoryName=my-factory \
  --input workItem=<ISSUE> \
  --input artifact=code-review \
  --input prompt='<reviewer prompt: read the work products from swamp and return ONLY findings JSON>' \
  --input cwd=.
```

Then query the invocation (step 0 above) and record the findings with
`resolve_findings`.

## Notes

- **Polarity is a convention, not a lock-in.** "Claude drives, Codex reviews" is
  just how you configure the factory driver vs. the `external-reviewer` instance.
  Reverse it freely by swapping `defaultProvider`/`defaultModel`.
- **`mode: dispatch` fallback.** A repo that wants same-context review without an
  external agent can keep the review stages as vanilla `dispatch` and ignore the
  bridge workflows entirely. The bundle adds capability; it removes nothing.
