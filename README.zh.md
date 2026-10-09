# hcode

开源的 AI 编程 Harness —— 面向使用国产模型的开发者。Windows 优先,只跑 PowerShell。

> **[English →](README.md)**

Harness 指的是模型之外的一切:它能调用哪些工具、拿到哪些上下文、观察到什么、被允许做什么。hcode 就是这一层,从零写起,原生支持 GLM、DeepSeek 与 Claude。角色是一等的:一个角色一份 Markdown,内置只读的探查者/审查者/规划者,能点名派发、并行派发、后台派发,也能让同一个问题同时问几家模型。

## 环境要求

| | |
| --- | --- |
| 系统 | **Windows 10 / 11** —— x64 或 arm64 |
| Shell | **Windows PowerShell 5.1** 及以上(随 Windows 自带的 5.1 就是兼容性下界) |
| Node.js | **22 及以上** |

hcode 把命令交给 `powershell.exe` 执行。它不支持 bash、cmd 或 WSL,也不能装在 macOS 与 Linux 上(`npm` 会直接拒绝,见 `package.json` 里的 `os`)。PowerShell 7+ 也可以,唯一的要求是 `powershell.exe` 在 `PATH` 上。

5.1 这个下界是为了模型,不是为了你:5.1 没有 `&&`、没有 `??`、没有三元运算符,所以 hcode 会在系统提示里先把 shell 方言讲清楚,而不是让模型从一条条报错里去猜。

## 安装

hcode 还没发布到 npm registry,暂时从源码装:

```powershell
git clone https://github.com/Silencehuliang/HCode.git
cd HCode
npm install
npm run build
npm i -g .
```

为什么要绕这几步:一行 `npm i -g github:Silencehuliang/HCode` 本该可行,但 npm 全局安装 git 依赖时,不会在跑 `prepare` 脚本**之前**装上 devDependencies —— 构建这一步找不到 `tsc`,装出来的是空包。这是 [npm/cli#8440](https://github.com/npm/cli/issues/8440),至今未修。(发布之后这一节会改成 `npm i -g hcode`,问题自然消失。)

## 配置

把密钥写进 `%USERPROFILE%\.hcode\settings.json`:

```json
{
  "provider": "glm",
  "providers": {
    "glm": {
      "apiKey": "你的密钥"
    }
  }
}
```

然后运行:

```powershell
cd C:\你的项目
hcode
```

横幅会告诉你此刻实际在跟哪一家、哪个模型说话:

```
hcode · glm / glm-5.3
接口:https://open.bigmodel.cn/api/paas/v4
```

用自然语言说要做什么就行,`/exit` 退出。

### 换一家

先说一句把握程度:GLM 与 DeepSeek 的适配器对着真实端点验证过;Claude 的适配器已实现、并按 Anthropic 文档的形状做了单元测试,但**从未对着真实 Anthropic 端点跑过** —— 手上有密钥的话,试一轮只花你一次往返,开个 issue 告诉我们行不行会很有价值。

三家可以共存在同一份配置里,改 `provider` 就切换:

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

每一家各有自己的 `apiKey`、`model`、`baseUrl`、`proxy`、`thinking`。**代理是按家配的,不是全局的** —— 需要给 Claude 挂代理、GLM 不用挂,配出来就是这个样子,发往 GLM 的请求一步都不会绕到国外。

### 已经配好 Claude Code 的人

环境里已经有 `ANTHROPIC_API_KEY` 的话,不用建任何文件,直接就能跑:

```powershell
hcode
# hcode · claude / claude-sonnet-5-5
```

`ANTHROPIC_BASE_URL` 与 `ANTHROPIC_MODEL` 同样认。`GLM_*` 与 `DEEPSEEK_*` 也一样。

### 环境变量

临时跑一次或放进 CI 时方便。环境变量压过配置文件:

| 变量 | 含义 |
| --- | --- |
| `HCODE_PROVIDER` | `glm` / `deepseek` / `claude` |
| `HCODE_API_KEY` | 所选那一家的密钥 |
| `HCODE_MODEL` | 模型名 |
| `HCODE_BASE_URL` | 覆盖接口地址(自建网关、中转……) |
| `HCODE_PROXY` | HTTP 代理,如 `http://127.0.0.1:7890` |
| `HCODE_THINKING` | `on` / `off`,厂商支持时开启思维链 |

**密钥是明文落盘的。** 完整说明见 [docs/configuration.md](docs/configuration.md),包括配置放在哪、以及怎么做到一个字节都不写进磁盘。

## 它能做什么

| 工具 | 作用 |
| --- | --- |
| `run_command` | 执行一条 PowerShell 命令,返回 stdout、stderr 与退出码 |
| `read_file` / `write_file` / `edit_file` | 读、写、定点修改文件 |
| `search_content` / `find_files` | 按内容搜索、按文件名搜索 |
| `todo_write` / `todo_update` / `todo_read` | 维护一份待办清单,应付跨很多步的活 |
| `task` | 派一个角色去做一件事,只把结论带回来 |
| `task_status` / `task_followup` | 查后台派出去的任务、让它接着说话 |
| `skill` | 按需加载一份 skill 的正文,而不是一开始就全塞进上下文 |
| `council` | 同一个问题同时问多家模型,出一份「共识 / 分歧」报告 |

每次调用都新起一个进程、显式给出工作目录、默认 120 秒超时(模型可以要更长)、UTF-8 输出并在需要时回退到 GBK、输出过长时保留头尾并标出省略量。契约写在 [docs/shell-tool-contract.md](docs/shell-tool-contract.md)。

## 多角色:一个角色就是一份 Markdown

内置三个角色开箱能用:`explorer`(只读探查)、`reviewer`(只读审查)、`planner`(只读规划)。想要自己的,放一份 Markdown 进去就行:

```markdown
---
name: writer
description: 动手改代码的实现者
tools: read_file, edit_file, run_command
model: deepseek
worktree: true
output: 结论, 风险
---

你是这个项目的实现者。改一处说一处为什么,改动要小到能一次看明白,
做完把改了哪些文件、怎么验的写清楚。
```

| frontmatter | 作用 |
| --- | --- |
| `name` | 点名用的名字。不写就用文件名 |
| `description` | 进花名册的那一句话 —— 模型靠它判断该不该派、派谁 |
| `tools` | 能用的工具名,逗号分隔。不写 = 继承主对话的全量工具(剥掉 `task` 自己) |
| `model` | `glm`、`glm:glm-5.3`,或 `preset:槽位名`。不写 = 用主对话那家 |
| `permission` | 目前只有 `read-only`。**只能收紧**,放宽不了主对话的天花板 |
| `spawns` | 这个角色能往下派谁(受限递归,默认两层) |
| `output` | 结论必须带上的字段;两次不按约定交,错误和它的原文一起回主对话 |
| `worktree` | `true` = 在一间独立 git worktree 里干活,产出挂在自己的分支上 |

放在 `.hcode/agents/<名字>.md`(项目级)或 `%USERPROFILE%\.hcode\agents\<名字>.md`(用户级),同名的项目级赢。**不读 `.claude/agents`** —— 那边 `tools` 的取值域和权限语义是另一家的方言,错位兼容比不兼容更糟([ADR-0007](docs/adr/0007-agents-as-markdown.md))。

**怎么派**:直接说事,模型照花名册自己判断该不该派(`派个 reviewer 看看这次改动`);也可以点名 —— `@reviewer 看一下 src/core/permission.ts`。一句话里派好几个角色时它们并行跑(默认最多 3 个同时)。每次派完有一行成本可见:

```
⏺ [explorer · glm-5.3 · ~1.2k token · 12.3s]
```

想让它跑着、自己先干别的,就说"后台派":拿回一个任务号,之后查 `task_status` 取结论,或用 `task_followup` 让它带着上一趟的上下文接着说。后台任务的结论**不**自动塞回主对话(那会破坏上下文压缩的前提),任务表也只在内存里 —— 进程一退,没取走的结论就没了([ADR-0008](docs/adr/0008-background-tasks-in-session-only.md))。

角色的模型绑定、整队换模型(`presets`)、车道目录开在哪儿,见 [docs/configuration.md](docs/configuration.md)。

## 多模型共识

```
› @council PowerShell 5.1 里 Get-Content -Raw 读 UTF-8 无 BOM 的文件,中文会不会乱?
```

同一个问题同时问配置里**所有**配得出密钥的家,各家原话原样进报告,最后附一份「共识 / 分歧」——分歧那一节写清各方理由和"还缺什么证据",而不是把答案拌匀。前提是至少两家:只配一家的话这个工具根本不出现。

**议员没有工具**,看不到你这台机器上的文件,也跑不了命令 —— 问的是判断,不是代查。所以把材料(代码、报错原文、你已经试过的)一起交给它。某一家没答上来(比如限频)不会拖垮这一轮,报告里会标出「(这一家没答上来)」。

## 权限

零爆炸半径的工具不问就执行:读文件的三件(`read_file`、`search_content`、`find_files`)、待办清单(`todo_*`,只动会话里的清单)、`task` 与 `task_status` / `task_followup`(派出去的子 agent 自己也要过守门器)、`skill`(读本地 Markdown 正文)和 `council`(议员的工具集是空的,它花的是 token 不是你的文件)—— 这些最坏也碰不到你磁盘上的一个字节。写文件、改文件要先问;PowerShell 命令默认直接执行,只拦一份内置的危险清单 —— 递归删除、`git push --force`、`git reset --hard`、格式化磁盘、改执行策略、`iex` 一段下载来的脚本,每条拒绝都会说清该怎么做,而不是让模型换一种写法再试一遍。为什么不逐条确认命令:每次弹窗都点"允许",比不弹窗更危险。

三层规则:危险清单**绝对否决**(任何一层都改不动)> 你在 `settings.json` 的 `permissions` 里写的规则(天花板,可放宽也可收紧)> 角色文件里的 `permission`(只能更严)。写法见 [docs/configuration.md](docs/configuration.md)。

## 项目约定

在项目根目录放一份 `HCODE.md`,hcode 启动时读它并照做。已经有 `CLAUDE.md` 或 `AGENTS.md` 的话,它会读那一份 —— 优先级依次是 `HCODE.md` → `CLAUDE.md` → `AGENTS.md`。**它从不写入 `CLAUDE.md`**,横幅会告诉你此刻生效的是哪一份。

## Skills

放在 `.hcode/skills/<名字>/SKILL.md`(项目级)或 `%USERPROFILE%\.hcode\skills\<名字>\SKILL.md`(用户级)。进提示词的只有每份 skill 的名字和描述,正文等模型判断需要用的时候才加载。`.claude/skills` 同样认。

## 开发

```powershell
git clone https://github.com/Silencehuliang/HCode.git
cd HCode
npm install
npm test          # 构建 + 跑测试
npm run typecheck
npm run hcode     # 从源码直接跑
```

目录分层:`src/provider`(各家模型接口)、`src/core`(主循环、会话、权限、压缩)、`src/tools`(模型能调用的东西)、`src/cli`(配置与入口)、`src/tui`(终端界面)。背后的取舍见 [docs/adr](docs/adr)。

## 许可

[Apache-2.0](LICENSE)。

本项目借鉴了 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的分层(Apache-2.0,Copyright 2026 Z.AI Co., Ltd)与 [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) 的构建顺序(MIT,Copyright (c) 2024 shareAI Lab)。第三方声明的全文见 [NOTICE](NOTICE)。任何直接引入的 ZCode 源码文件,必须原样保留其逐文件署名。
