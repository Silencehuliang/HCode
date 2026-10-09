# hcode

开源的 AI 编程 Harness —— 面向使用国产模型的开发者。Windows 优先,只跑 PowerShell。

> **[English →](README.md)**

Harness 指的是模型之外的一切:它能调用哪些工具、拿到哪些上下文、观察到什么、被允许做什么。hcode 就是这一层,从零写起,原生支持 GLM、DeepSeek 与 Claude。

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
| `task` | 派一个只读的子 agent 去查清楚一件事,只把结论带回来 |
| `skill` | 按需加载一份 skill 的正文,而不是一开始就全塞进上下文 |

每次调用都新起一个进程、显式给出工作目录、默认 120 秒超时(模型可以要更长)、UTF-8 输出并在需要时回退到 GBK、输出过长时保留头尾并标出省略量。契约写在 [docs/shell-tool-contract.md](docs/shell-tool-contract.md)。

## 权限

只读工具(`read_file`、`search_content`、`find_files`)不问就执行。凡是写文件、执行命令、改变状态的,一律先问。一份内置的危险清单 —— 递归删除、`git push --force`、`git reset --hard`、格式化磁盘、改执行策略、`iex` 一段下载来的脚本 —— 直接拒绝,而且每条拒绝都会说清该怎么做,而不是让模型换一种写法再试一遍。

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
