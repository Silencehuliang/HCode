# hcode

An open-source AI coding harness built for Chinese developers using domestic models. Windows-first, PowerShell-only.

> **[中文文档 →](README.zh.md)**

A harness is everything around the model: the tools it can call, the context it gets, what it observes, what it is allowed to do. hcode is that layer, written from scratch, with first-class support for GLM, DeepSeek, and Claude.

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
| `task` | Sends a read-only sub-agent to investigate something and report back a conclusion |
| `skill` | Loads a skill's instructions on demand, instead of paying for all of them up front |

Commands run in a fresh process each time, with an explicit working directory, a default 120-second timeout (the model can ask for longer), UTF-8 output with a GBK fallback, and head/tail truncation with an explicit marker when output is too long. The contract is in [docs/shell-tool-contract.md](docs/shell-tool-contract.md).

## Permissions

Read-only tools (`read_file`, `search_content`, `find_files`) run without asking. Anything that writes, executes, or changes state asks first. A built-in list of destructive patterns — recursive deletes, `git push --force`, `git reset --hard`, disk formatting, execution-policy changes, `iex` of a downloaded script — is refused outright, and each refusal says what to do instead rather than leaving the model to retry with a different spelling.

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
