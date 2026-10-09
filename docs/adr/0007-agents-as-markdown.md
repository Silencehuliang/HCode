# ADR-0007: 角色 = 一个 Markdown 文件,只收 5 个 frontmatter 字段

日期:2026-10-09
状态:已接受
关联:#14(v2-00)、#13(v2 规格)、ADR-0006(复杂度闸门的先例)

## 背景

hcode v2 的核心是把"角色"从写死在装配处的三样东西(工具集 + 系统提示 + Provider 实例)变成一等概念:可由文件定义、按名发现、按优先级覆盖。要定的第一件事是角色定义的载体格式。

参照系的三个产品 —— opencode、Claude Code、oh-my-pi —— 全部用 **Markdown + YAML frontmatter,正文即系统提示词**。这不是巧合:角色定义是"写给模型看的提示词 + 写给人看的元数据",Markdown 恰好是两者的交集。omo-slim 例外(TS 文件 + config),因为它寄生在宿主上,没有自己的文件格式自由度。

## 决定

1. **一个角色 = `<名>.md` 平铺在 agents 目录下**(不是 skills 那种子目录 + SKILL.md —— 角色是"文件即角色",没有附属资源,套一层目录只多一次跳转)。
2. **发现路径:`<cwd>/.hcode/agents/` → `~/.hcode/agents/`,同名先出现者赢**(项目覆盖用户),与 skills 相同。
3. **frontmatter 只收 5 个字段:`name` / `description` / `tools` / `model` / `permission`。** 之外的一律忽略、不报错。
4. **不引 YAML 库** —— 续用 v1 自写的 `键: 值` 解析器(skills 已在用)。

## 理由

### 为什么 5 个字段,多一个都不要

这 5 个是"能不能派出去、派成什么样"的最小完备集:身份(name)、派发依据(description)、能拿什么(tools)、用哪个模型(model)、边界在哪(permission)。每加一个字段(temperature、max-turns、thinking-level……)都要过一遍"**没有它角色还能不能用**"的拷问 —— 答不上来的,属于调优;调优可以等,复杂度闸门先守住。参照 oh-my-pi 的 frontmatter 有十余个可选字段,换来的是 9.4k stars 但配置文档极长的 omo-slim 式复杂度。

字段语义从简(布尔/字符串/逗号分隔),不引 YAML 库意味着做不了嵌套结构 —— 这是**选择而非遗憾**:角色定义保持是给人和模型都能读懂的 Markdown。真需要复杂配置的那天,再开会定格式,而不是让格式随用例慢慢长毛。

### 为什么不读 `.claude/agents/`

skill 读 `.claude/skills`(v1-#09),角色却**不**读 `.claude/agents`,两处不一致需要交代:

- skills 的跨格式兼容契约只有 `name` + `description` 两个字符串,**没有语义可错位** —— 解析出来是什么就是什么。
- 角色文件的 `tools` 取值域、`permission` 语义、派发约定都是**各家自己的语法契约**。读 `.claude/agents` 等于承诺兼容一个我们控制不了的方言:一份为 Claude Code 写的角色,它的 `tools` 列表里的名字在我们的工具集里可能不存在、`model` 字段的取值域(如 `sonnet`/`opus` 别名)也不是我们的 provider id。oh-my-pi 出于同一理由拒绝读它。
- 错位兼容比不兼容更糟:角色文件被"成功"解析、却在错误的语义下运行,用户查不出来。

真想迁移,把 `.claude/agents/*.md` 拷进 `.hcode/agents/` 改两个字段即可 —— 迁移成本一次,方言维护成本永久。

### 为什么 `origin` 记根目录而不是文件路径

用户最常问的运维问题是"我改的那份怎么没生效"。答案通常是"另一份同名文件盖住了它"。`path` 能定位文件,`origin` 能定位**哪一层赢了** —— 后者才是排障需要的那个。

## 后果

- v2-01(泛化派发)按注册表取 `AgentDef` 装配;v2-02/v2-03 消费 `tools` / `model` / `permission` 三个原始值字段(本票只存不解析,解析语义归各自的票)。
- 不引 YAML 库的决定**由本 ADR 背书** —— 后来者想引库,先推翻本 ADR,不要绕开它。
- 带合法 frontmatter 但缺 description 的文件记进 problems 并在 stderr 显示,不静默(与 skills 同):静默跳过 = 用户一直以为角色在生效。
