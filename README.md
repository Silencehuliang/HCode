# hcode

An open-source AI coding harness built for Chinese developers using domestic models. Windows-first, PowerShell-only.

> **[中文文档 →](README.zh.md)**

A harness is everything around the model: the tools it can call, the context it gets, what it observes, what it is allowed to do. hcode is that layer, written from scratch, with first-class support for GLM, DeepSeek, and Claude. Roles are first-class too: one role is one Markdown file, three read-only ones ship built in, and you can dispatch them by name, in parallel, in the background — or ask several models the same question at once.

## Requirements

| | |
| --- | --- |
| OS | **Windows 10 / 11** — x64 or arm64 |
| Shell | **Windows PowerShell 5.1** or later (the 5.1 that ships with Windows is the compatibility floor) |
| Node.js | **22 or later** |

hcode runs your commands through `powershell.exe`. It does not support bash, cmd, or WSL, and it is not installable on macOS or Linux (`npm` will refuse — see `os` in `package.json`). PowerShell 7+ works too; the only requirement is that `powershell.exe` exists on `PATH`.

The 5.1 floor matters for the model, not for you: 5.1 has no `&&`, no `??`, and no ternary operator, so hcode's system prompt tells the model up front which shell dialect it is writing for instead of letting it find out from errors.

## Install

hcode is not yet on the npm registry. Install from source for now:

```powershell
git clone https://github.com/Silencehuliang/HCode.git
cd HCode
npm install
npm run build
npm i -g .
```

Why the long way: a one-line `npm i -g github:Silencehuliang/HCode` should work, but npm does not install devDependencies before running a git dependency's `prepare` script when installing globally, so the build step finds no `tsc` and the install fails with an empty package. That is [npm/cli#8440](https://github.com/npm/cli/issues/8440), still open. (Once hcode is published, this section becomes `npm i -g hcode` and the problem disappears.)

## Configure

Put your key in `%USERPROFILE%\.hcode\settings.json`:

```json
{
  "provider": "glm",
  "providers": {
    "glm": {
      "apiKey": "your-api-key"
    }
  }
}
```

Then run it:

```powershell
cd C:\path\to\your\project
hcode
```

The banner tells you which provider and model you are actually talking to:

```
hcode · glm / glm-5.3
接口:https://open.bigmodel.cn/api/paas/v4
```

Type a request in plain language, `/exit` to quit.

### Other providers

A note on confidence: the GLM and DeepSeek adapters are verified against live endpoints. The Claude adapter is implemented and unit-tested against hand-written fixtures from Anthropic's documented shapes, but **has never run against a real Anthropic endpoint** — if you have a key, trying it costs you one round-trip, and an issue saying whether it worked would be valuable.

All three can coexist in one settings file, and you switch between them by changing `provider`:

```json
{
  "provider": "deepseek",
  "providers": {
    "glm":      { "apiKey": "..." },
    "deepseek": { "apiKey": "..." },
    "claude":   { "apiKey": "...", "proxy": "http://127.0.0.1:7890" }
  }
}
```

Each provider gets its own `apiKey`, `model`, `baseUrl`, `proxy`, and `thinking` setting. **Proxy is configured per provider, not globally** — if you need one for Claude and not for GLM, that is exactly what you get, and your GLM traffic never leaves the country.

### Already using Claude Code?

If `ANTHROPIC_API_KEY` is already set in your environment, hcode picks it up with no changes — no settings file needed:

```powershell
hcode
# hcode · claude / claude-sonnet-5-5
```

`ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` are honoured too. The same applies to `GLM_*` and `DEEPSEEK_*`.

### Environment variables

Handy for CI or a one-off run. They override the settings file:

| Variable | Meaning |
| --- | --- |
| `HCODE_PROVIDER` | `glm` / `deepseek` / `claude` |
| `HCODE_API_KEY` | Key for the selected provider |
| `HCODE_MODEL` | Model name |
| `HCODE_BASE_URL` | Override the endpoint (self-hosted gateway, relay, …) |
| `HCODE_PROXY` | HTTP proxy, e.g. `http://127.0.0.1:7890` |
| `HCODE_THINKING` | `on` / `off` — extended thinking, where the provider supports it |

**Your key is stored in plain text.** See [docs/configuration.md](docs/configuration.md) for the full reference, including where the files live and how to avoid putting a key on disk at all.

## What it can do

| Tool | What it does |
| --- | --- |
| `run_command` | Runs a PowerShell command and returns stdout, stderr, and the exit code |
| `read_file` / `write_file` / `edit_file` | Reads, writes, and makes targeted edits to files |
| `search_content` / `find_files` | Searches file contents and file names |
| `todo_write` / `todo_update` / `todo_read` | Keeps a task list for work that spans many steps |
| `task` | Sends a role off to do something and brings back the conclusion |
| `task_status` / `task_followup` | Checks on a background task, and lets it keep talking |
| `skill` | Loads a skill's instructions on demand, instead of paying for all of them up front |
| `council` | Asks several models the same question and reports where they agree and disagree |

Commands run in a fresh process each time, with an explicit working directory, a default 120-second timeout (the model can ask for longer), UTF-8 output with a GBK fallback, and head/tail truncation with an explicit marker when output is too long. The contract is in [docs/shell-tool-contract.md](docs/shell-tool-contract.md).

## Roles: one role is one Markdown file

Three roles are built in and ready to use: `explorer` (read-only investigation), `reviewer` (read-only review), `planner` (read-only planning). To write your own, drop in a Markdown file:

```markdown
---
name: writer
description: The implementer that actually changes code
tools: read_file, edit_file, run_command
model: deepseek
worktree: true
output: conclusion, risks
---

You are this project's implementer. Change one thing at a time and say why;
keep each change small enough to read in one pass, and report which files you
touched and how you verified them.
```

| frontmatter | What it does |
| --- | --- |
| `name` | The name you use to call it. Falls back to the file name |
| `description` | The line that goes into the roster — this is what the model reads when deciding whether to dispatch this role |
| `tools` | Comma-separated tool names. Omitted = inherit the main conversation's full toolset (minus `task` itself) |
| `model` | `glm`, `glm:glm-5.3`, or `preset:<slot>`. Omitted = whatever the main conversation uses |
| `permission` | Only `read-only` today. It can **tighten** the ceiling, never loosen it |
| `spawns` | Which roles this one may dispatch in turn (bounded recursion, two levels by default) |
| `output` | Fields the conclusion must carry; miss them twice and the error plus the raw text goes back to the main conversation |
| `worktree` | `true` = work inside a separate git worktree, with the result left on its own branch |

Files live in `.hcode/agents/<name>.md` (project) or `%USERPROFILE%\.hcode\agents\<name>.md` (user); the project one wins on a name clash. **`.claude/agents` is not read** — its `tools` vocabulary and permission semantics are another tool's dialect, and mismatched compatibility is worse than none ([ADR-0007](docs/adr/0007-agents-as-markdown.md)).

**How to dispatch.** Just say what you want and the model decides from the roster (`have a reviewer look at this change`). Or name the role directly: `@reviewer take a look at src/core/permission.ts`. Ask for several roles in one breath and they run in parallel (three at a time by default). Every dispatch reports its cost:

```
⏺ [explorer · glm-5.3 · ~1.2k token · 12.3s]
```

Say "dispatch it in the background" and you get a task id back: use `task_status` to collect the conclusion, or `task_followup` to let that sub-agent keep going with its own history intact. Background conclusions are **not** pushed into the main conversation (that would break the assumptions context compaction relies on), and the task table lives in memory only — nothing survives the process ([ADR-0008](docs/adr/0008-background-tasks-in-session-only.md)).

Model binding per role, swapping the whole team's models (`presets`), and where worktree lanes are created: [docs/configuration.md](docs/configuration.md).

## Multi-model consensus

```
› @council In PowerShell 5.1, does Get-Content -Raw mangle a UTF-8 file with no BOM?
```

The same question goes to **every** provider you have a key for, all at once; each answer is quoted verbatim, followed by a synthesis with two sections — where they agree, and where they don't (with each side's reasoning and what evidence would settle it, rather than a blended answer). It needs at least two providers: with one key configured, the tool is not offered at all.

**The councilors have no tools.** They cannot see the files on your machine or run anything — you are asking for judgment, not for errands, so hand them the material (code, the actual error, what you already tried). If one provider fails (rate limits happen), the others still answer and the report marks it `(this one didn't answer)`.

## Permissions

Tools with zero blast radius run without asking: the readers (`read_file`, `search_content`, `find_files`), the todo list (`todo_*` — it only touches an in-session list), `task` and `task_status` / `task_followup` (anything a sub-agent gets still goes through the gatekeeper), `skill` (it reads local Markdown), and `council` (its councilors hold no tools at all — it spends tokens, not your files). At worst these read the wrong thing; none of them can touch a byte on your disk. Writing and editing files asks first. PowerShell commands run by default and are only stopped by a built-in list of destructive patterns — recursive deletes, `git push --force`, `git reset --hard`, disk formatting, execution-policy changes, `iex` of a downloaded script — and each refusal says what to do instead rather than leaving the model to retry with a different spelling. Why not confirm every command: a prompt you blindly approve every time is more dangerous than no prompt at all.

Three layers: the destructive list **always wins** (no layer can override it) > the rules you write in `settings.json` under `permissions` (the ceiling — it can loosen or tighten) > a role's own `permission` (tighten only). Syntax in [docs/configuration.md](docs/configuration.md).

## Project instructions

Drop a `HCODE.md` at the root of a project and hcode reads it at startup and follows it. If you already have a `CLAUDE.md` or `AGENTS.md`, hcode reads that instead — in that order of precedence. **It never writes to `CLAUDE.md`**, and the banner tells you which file is in effect.

## Skills

Skills live in `.hcode/skills/<name>/SKILL.md` (project) or `%USERPROFILE%\.hcode\skills\<name>\SKILL.md` (user). Only the name and description of each skill go into the prompt; the body is loaded when the model decides it needs one. `.claude/skills` works too.

## Development

```powershell
git clone https://github.com/Silencehuliang/HCode.git
cd HCode
npm install
npm test          # build + run the test suite
npm run typecheck
npm run hcode     # run from source
```

Layout: `src/provider` (model APIs), `src/core` (the loop, sessions, permissions, compaction), `src/tools` (what the model can call), `src/cli` (config and entry point), `src/tui` (the terminal UI). See [docs/adr](docs/adr) for the decisions behind it.

## License

[Apache-2.0](LICENSE).

This project borrows its layering from [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0, Copyright 2026 Z.AI Co., Ltd) and its build order from [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) (MIT, Copyright (c) 2024 shareAI Lab). See [NOTICE](NOTICE) for the full third-party attributions. Any ZCode source file brought in directly must keep its per-file attribution intact.
