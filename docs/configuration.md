# 配置

## 密钥以明文落盘

先说最要紧的一条:hcode 把密钥**以明文**存在下面这两个 JSON 文件里,不做加密、不做系统钥匙串。

- 用户级:`<你的用户目录>/.hcode/settings.json`(Windows 上是 `C:\Users\<你>\.hcode\settings.json`)
- 项目级:`<项目目录>/.hcode/settings.json`

这件事与 GitHub CLI(`~/.config/gh/hosts.yml`)、AWS CLI(`~/.aws/credentials`)、npm(`~/.npmrc`)一致。说在这里,是为了不让任何人以为它被别的东西保护着。

别把它们提交进版本库。项目级配置放在 `.hcode/` 这个目录里就是为了这个 —— 一个 `.gitignore` 条目

```
.hcode/
```

就能挡住整个目录。hcode 自己不会创建 `.gitignore`,也不会替你写任何密钥。

不想落盘就只用环境变量(见下),代价是每次开终端都要重新设一遍。

## 密钥必须是 ASCII

密钥最终要放进 HTTP 请求头,而请求头只装得下 ASCII。从网页或文档里复制密钥时带进一个全角字符或全角空格,是很常见的事。

hcode 会在启动时检查,直接告诉你**是第几个字符**出了问题,比如:

```
密钥里第 7 个字符是「,」,它不是 ASCII 字符。
```

不检查的话,你要等到发出第一个请求才会看到一句 `Invalid character in header content ["authorization"]` —— 那句话里既没有"密钥"也没有位置。

## 读取顺序

优先级从高到低,高的压过低的:

1. 环境变量
2. 项目级 `settings.json`
3. 用户级 `settings.json`
4. 自动探测(见下)
5. 内置默认(Provider 是 `glm`)

分层是**逐字段**生效的,不是整份替换。项目级只写一行 `model`,其余字段仍然从用户级取 —— 一个仓库想换模型时不必把密钥再抄一遍。

项目级与用户级同时存在时,启动横幅会把两份路径都列出来。这是刻意的:不然"我改了用户级那份怎么没反应"要靠猜。

任何一层配置文件**存在但读不动**(JSON 写坏了、编码不对),hcode 直接报错退出,不会跳过这一层继续跑 —— 跳过的话,你写的设置会一部分生效一部分不生效,而没有任何线索说明为什么。

## 文件形状

```json
{
  "provider": "glm",
  "providers": {
    "glm": { "apiKey": "你的密钥" },
    "deepseek": { "apiKey": "你的密钥", "model": "deepseek-chat" },
    "claude": {
      "apiKey": "你的密钥",
      "proxy": "http://127.0.0.1:7890",
      "thinking": true
    }
  }
}
```

三家可以在同一份配置里共存,切换只改最上面那一行 `provider`。

每家的字段都是可选的,除了 `apiKey`:

| 字段 | 不填时 | 说明 |
| --- | --- | --- |
| `apiKey` | 没有默认值,必须给 | |
| `model` | `glm-5.3` / `deepseek-chat` / `claude-sonnet-5-5` | 按上面选中的那家取 |
| `baseUrl` | 厂商官方端点 | 自建中转、本地网关填这里 |
| `proxy` | 不走代理 | **按家配**,不是全局。见下 |
| `thinking` | 厂商默认 | 开/关思维链 |

`proxy` 为什么按家配:用国产模型的人多半不需要代理,要用 Claude 的人多半必须用。做成全局的话,要么逼前者也配一个,要么更糟 —— 让国产模型的请求也绕一圈到国外代理去。

## 角色文件(agents)

一个角色就是一份 Markdown:`frontmatter` 写它怎么被装配,正文就是它的 system prompt。放在两处,先找到的先赢:

1. `<项目>/.hcode/agents/<名字>.md`
2. `%USERPROFILE%\.hcode\agents\<名字>.md`

同名时项目里的那份赢 —— 所以「这个项目专用」和「我所有项目都用」是同一套写法。**不读 `.claude/agents`**:那边 `tools` 的取值域和 `permission` 的语义是别家的方言,错位兼容比不兼容更糟(理由见 [ADR-0007](adr/0007-agents-as-markdown.md))。frontmatter 里不认识的键忽略、不报错;`description` 缺了会在启动时列为一条问题。

| 字段 | 不填时 | 说明 |
| --- | --- | --- |
| `name` | 文件名 | 点名派发用的名字 |
| `description` | 无 | 花名册靠它做自动派发;缺了算是问题 |
| (正文) | 空 | 这个角色的 system prompt |
| `tools` | 继承主对话的全部工具(剥掉 `task`) | 逗号或换行分隔;写了不存在的工具名直接报错,不静默过滤 |
| `model` | 主对话那家 | `glm` / `deepseek:glm-5.3` / `preset:快` 三种写法 |
| `permission` | 全局那套 | 目前只认 `read-only`,只收紧不放宽 |
| `spawns` | 它不能再派 | 允许再派给哪些角色(默认最多两层) |
| `output` | 自由文本 | 结论必须带的字段;两次没带就把原文连同错误退回主对话 |
| `worktree` | 关 | `true` = 在独立 git worktree 里干活,结果留在自己的分支上 |

`worktree` 是唯一一个**值写错就报错**的字段:`true/false` 之外的东西一律拒绝启动,因为「用户以为在车道上、其实子 agent 在改他的工作区」是最坏的错法。其余字段写错最坏是没生效。

怎么派它们出去(自动 / `@点名` / 后台 / 并行 / Council)写在 [README.zh.md](../README.zh.md) 的多角色一节。

## 工具权限(permissions)

默认行为是:**只读工具直接放行,写文件先问,PowerShell 命令默认执行但被一份危险清单拦住**。要在默认之上收紧或放宽,用 `permissions`:

```json
{
  "permissions": {
    "run_command*": "deny",
    "write_file": "ask",
    "todo_*": "allow"
  }
}
```

- 键是**工具名**,支持 `*`(任意长):`run_command*` 匹配 `run_command`, `*` 匹配一切。
- 值是 `allow` / `ask` / `deny` 之一,别的写法**直接报错**——权限是安全设置,把它悄悄降级成默认,你会以为自己收紧生效了,而它没有。
- **键序即优先级**,同一条工具被多条规则命中时,写在前面那条赢。
- 项目级 `.hcode/settings.json` 的规则排在用户级前面;同一个键项目级赢。

三层的关系:

| 层 | 能做什么 |
| --- | --- |
| 危险清单 | **绝对否决**。递归删除、`git push --force`、格式化磁盘这些,任何规则都拦不住、也放不过 —— 理由来自那条命令本身,不来自你的配置。 |
| 你(settings.json) | 天花板。可以放宽默认(比如让 `write_file` 免问),也可以收紧(比如把 `run_command` 整个禁掉)。没写的工具听默认。 |
| 角色文件 | 只能比天花板**更严**。角色声明 `permission: read-only` 时,即便你允许了 `write_file`,这个角色也拿不到写盘工具。 |

## 角色整队换模型(presets)

角色文件里能不能写死"用哪家的哪个模型"?能(`model: deepseek:deepseek-v4.1`),但"哪家便宜"这件事会变:换了套餐、换了网关、试了另一家,写死在角色文件里就得把每个角色改一遍。

所以分成两层:**角色文件写用途,配置文件写这次跑用谁。**

角色文件里引用一个**槽位**:

```markdown
---
name: explorer
description: 只读探查代码库,回答"这个东西在哪、怎么用"
model: preset:scout
permission: read-only
---
```

`presets` 在 `settings.json` 里定义槽位,`preset` 选出这次跑用哪一队:

```json
{
  "presets": {
    "cheap": {
      "scout": "glm:glm-4.5-air",
      "review": "glm"
    },
    "strong": {
      "extends": "cheap",
      "review": "deepseek:deepseek-v4.1"
    }
  },
  "preset": "cheap"
}
```

- 槽位的值是 `provider` 或 `provider:模型` —— 与角色 `model` 字段同一套写法。**同一家可以有两个档**:`glm:glm-4.5-air` 与 `glm:glm-5.3` 是两个模型,不是一个。
- `extends` 先铺另一队,自己的槽位盖住继承来的。可以连着继承(三层也行)。
- 整队切换:`"preset": "strong"`,或者这一次跑 `HCODE_PRESET=strong hcode`(环境变量压过文件)。**角色文件一个字不用改。**
- 当前用的哪一队写在启动横幅上(`preset:cheap`)。
- 项目级 `.hcode/settings.json` 里的同名队**整队**盖住用户级那一份 —— 不是逐槽位混起来,否则继承链会指向一个原作者没想过的组合。

接不上的时候一律**回退主对话的模型并说一声**,不静默、也不拦下整场会话:

| 情况 | 结果 |
| --- | --- |
| 角色写了 `preset:scout`,但没选 `preset` | 启动时 stderr 提示"这次跑没选 preset",该角色用主对话的模型 |
| 选中的队里没有 `scout` 这个槽位 | 同上,并列出这一队有哪些槽位 |
| `"preset": "stong"`(队名写错) | 启动时 stderr 列出配置里实际有哪些队,所有槽位引用一并回退 |
| `extends` 指向不存在的队、或绕成环 | 同上(环会把链条整条打出来) |
| `presets` 结构写坏(比如槽位值不是字符串) | **直接报错**,不让 hcode 起来 —— 否则你会以为队伍生效了,其实每个角色都在用主对话的模型 |

不配 `presets` 时行为与之前完全一致:角色 `model` 照旧可以直接写 `provider[:模型]`。

## 车道:让会写文件的角色去独立检出里干活

只读角色(explorer / reviewer / planner)天生安全。会写文件的角色就不是了:它和你共用
同一个工作区,你回到编辑器前才发现它顺手重排了三个文件,那时候"哪一处是它改的"已经说不清。

角色文件里写一行,这个角色就改到另一个地方去:

```markdown
---
name: writer
description: 会改代码的实现者
worktree: true
tools: read_file, write_file, edit_file, search_content
---
```

开了车道之后:

- 它在**仓库旁边**的一间独立检出里干活(`git worktree`),路径是
  `..\.hcode-worktrees\<仓库名>-<分支名>`。你的工作区一个字都没变,`git status` 是空的。
- 车道是从**上一个提交**长出来的:你还没提交的改动不在它那里,它也不该指望它们。
- 它手里还是那几个工具,但相对路径都钉在车道上 —— 它说"读 `src/a.ts`",读的是车道里那份。
- 跑完(或者跑砸了、被 Ctrl+C 打断)由 hcode 自动收尾:把改动做成一次提交到分支
  `hcode/<角色名>-<时间戳>`,提交信息是 `<角色名>: <它这次的任务>`,然后拆掉车道目录。
- **不会自动合并**。结论后面会带一行,写清改了几项、分支叫什么,以及三条命令:

  ```
  git diff HEAD..hcode/writer-20261009-221907   看得
  git merge hcode/writer-20261009-221907        合得
  git branch -D hcode/writer-20261009-221907    不要了
  ```

- 一趟什么都没改,那条分支会跟着拆掉(留着只是攒垃圾)。有任何一步没走顺,现场一律保留
  并把 git 的原话带回结论里。

两条会被当场拒的组合:

| 写法 | 为什么拒 |
| --- | --- |
| `worktree: true` + `permission: read-only` | 只读角色改不了文件,开车道只是让它的搜索范围少掉主工作区的代码。删掉其中一行。 |
| `worktree: true` 的角色用 `background` 派 | 车道要"跑完立刻收尾",后台任务的收尾时刻不在任何人手上。去掉 `background` 直接派。 |

另外两件要说清的事:

- **车道不是权限的旁路。** 车道角色照样过守门器、照样受上面的 `permissions` 约束。想让
  它在车道里改文件别逐次弹窗,是你在 `settings.json` 里写 `"permissions": { "write_file": "allow" }`
  —— 你放宽天花板,而不是 harness 替车道开后门。
- **车道是给会写文件的角色准备的**,在不是 git 仓库的目录里用它,启动派发时会直接给出
  git 的原话和两条出路(到仓库里跑,或把这一行删掉),而不是凑合跑一趟。

> 进程被杀(Ctrl+C 之后直接退、关终端)时,那一趟的收尾不会发生,你仓库旁边会留下一个
> 车道目录和一条分支。`git worktree list` 一眼看得见,`git worktree remove --force "<路径>"`
> 就能拆;分支上的改动一直在。见 [ADR-0010](adr/0010-worktree-lanes.md)。

## 多模型共识(council)

拿不准的问题,可以同时问几家,让一个没有工具的记录员把"哪儿一致、哪儿不一致"写出来:

```
› @council PowerShell 5.1 里 Get-Content -Raw 读 UTF-8 无 BOM 的文件,中文会不会乱?

› @council 只问 glm 和 deepseek:这个重试策略有没有并发上的坑?
```

默认问配置里**所有**配得出密钥的家。想指定哪几家,就在问题里说清楚(像第二行那样)——
工具本身收了 `providers` 参数,模型会把你的要求传进去。点名的家里有没配密钥的会当场拒绝,
并列出现在能问的是哪几家;只点到一家也会当场拒绝。

**前提是至少两家配好密钥**(`settings.json` 的 `providers`,或者对应的环境变量)。只有一家的话
这个工具根本不会出现 —— 问一家不叫共识,而工具一旦在表里,模型就会去用它。

### 议员没有工具

议员和记录员的工具集都是**空的**。它们看不到你这台机器上的文件,也跑不了命令。所以要把材料
一起交给它:相关代码、报错原文、你已经试过什么、你现有的结论。这不是取巧,是这套东西的
前提 —— 给议员工具,每家会走各自的探索路径,最后的分歧里就混进了"谁翻到了什么",而不是对
同一个问题的判断差异。

### 报告长什么样

```
多模型共识 —— 同一个问题同时问了 2 家,下面是各家的回答原样,最后是记录员的合成报告。

问题:...
【glm · glm-5.3】
(这家自己的话,原样)

【deepseek · deepseek-chat】
(这家自己的话,原样)

合成报告:
共识:- ...
- ...
分歧:- ...

(合计 ~4.1k token,估算 —— 这是几家的账,不是一家的。)
```

各家的原话**原样保留**,不被摘要改写 —— 合成报告说"两家都主张 X"时,你要能自己回去核对。
每一家的花费另有一行成本可见:`⏺ [council:glm · glm-5.3 · ~1.2k token · 12.3s]`。

一家没答上来(比如限频)不会拖垮这一轮:它在报告里保留位置,标注「(这一家没答上来)」,
剩下的照常合成。全都答不上来就不去跑合成,直接把错误清单和各家原话回给你。

`council` 是动作不是角色:不进角色名册,也不能被子 agent 派发(见
[ADR-0011](adr/0011-council-multi-model-consensus.md))。

## 环境变量

通用变量,谁都用:

| 变量 | 对应 |
| --- | --- |
| `HCODE_PROVIDER` | `provider` |
| `HCODE_API_KEY` | 当前这家的 `apiKey` |
| `HCODE_MODEL` | 当前这家的 `model` |
| `HCODE_BASE_URL` | 当前这家的 `baseUrl` |
| `HCODE_PROXY` | 当前这家的 `proxy` |
| `HCODE_THINKING` | 当前这家的 `thinking`(`1/true/on/yes` 与 `0/false/off/no`) |

值写成空串当作没设 —— `.env` 里留一行空的 `HCODE_PROVIDER=` 不会把文件里的设置顶掉。

### 认得的既有变量

已经配好 Claude Code 的人**不需要建配置文件**,直接敲 `hcode` 就能用:

| 变量 | 认成 |
| --- | --- |
| `ANTHROPIC_API_KEY` | claude 的密钥 |
| `ANTHROPIC_BASE_URL` | claude 的 `baseUrl` |
| `ANTHROPIC_MODEL` | claude 的 `model` |

同理还有 `GLM_API_KEY` / `GLM_BASE_URL` / `GLM_MODEL` 与 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`(后两组是按厂商自己的叫法定的,方便 `set -a && . .env && set +a` 这类本地网关用法)。

这些变量是**按家**认的:选了 `provider: "claude"` 时,`GLM_BASE_URL` 不会被当成 claude 的接口地址 —— 那会把请求发去一个说不了 Anthropic 话的端点。

## 没有明说用哪家时

按这个顺序:

1. `HCODE_PROVIDER`
2. 配置文件里的 `provider`(项目级优先于用户级)
3. 自动探测:看手上真有哪家的密钥,按 **glm → deepseek → claude** 取第一家
4. `glm`

第 3 步的国产优先是刻意的:顺手 `export` 过一个 `ANTHROPIC_API_KEY` 的人(跑 Claude Code 的人几乎都有,而且很多是别的工具留下的)不该因此被带到国外模型上去 —— 而他手上真要是有国产模型的密钥,那才是他想用的。

反过来,你**写明了**用哪家却没配那一家的密钥时,hcode 照实报错,不会自作聪明换一家跑。

## 指令文件

配置之外,项目约定按 `HCODE.md` → `CLAUDE.md` → `AGENTS.md` 取第一个存在的,启动时点名用了哪一个。`CLAUDE.md` 与 `AGENTS.md` **只读,永不写入**。详见 [ADR-0003](adr/0003-instruction-file-precedence.md)。
