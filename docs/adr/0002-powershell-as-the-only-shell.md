# 命令工具只跑 PowerShell,不支持第二种 shell

我们用 `powershell.exe` 作为 Agent 的 shell,**不回退到 Git Bash**。理由是获客而非偏好:要求安装 Git for Windows,会把我们的目标用户 —— Windows 上的中文开发者,也正是我们做差异化那批人 —— 挡在一次安装之前。这个取舍比 POSIX shell 的便利更值钱。

## 实测结论:原本的担忧不成立

这条 ADR 最初建立在 learn-claude-code 的 `s01` 为 Windows 写 `os.name == 'nt'` 分支所暗示的担忧上:**模型会习惯性写出 Unix 命令,在 PowerShell 里撞墙。**

`prototype/powershell-premise/` 的实验否掉了它。**352 条命令、两个模型、两种提示、两种 PATH 环境,零 Unix 语法尝试**:

| 该诱出的 Unix 写法 | 实际用法 |
| --- | --- |
| `grep -r` | `Get-ChildItem \| Select-String` |
| `diff` | `Compare-Object` |
| `wc -l` | `Measure-Object` |
| `ls -S \| head` | `Sort-Object Length -Descending` |
| `echo $PATH` | `$env:PATH -split ';'` |

`ls -la`、`cat`、`&&`、`export` 一次都没出现。命令动词分布里 `Get-ChildItem` 154 次、`Get-Content` 44 次,而上述 Unix 命令为 0。

**因此:系统提示里那一句话的环境声明就足够了。** 精心编写的"Unix 惯用法 → PowerShell 映射表"没有产生任何可测量的差异 —— 只声明环境的臂与带完整映射表的臂,成功率和命令词汇完全一致。

那个担忧在它成文时可能是真的。**对 glm-5.3 和 deepseek-v4.1-flash 这一代模型,它不成立了。**

## 编码是 harness 的职责,绝不能写进提示词

本机控制台代码页是 **936(GBK)**,PowerShell 5.1 按 GBK 输出,而调用方按 UTF-8 读 —— 结果是中文报错变成乱码,模型无法据此自我纠正,用户看到的也是一屏乱码。

**修法在 shell 工具实现里**:每次调用前把子进程的输出编码钉成 UTF-8。实测附带一个意外收益 —— 报错会自动变成英文(`A parameter cannot be found that matches parameter name 'la'.`),而英文报错在训练语料里,乱码中文不在。这是模型能否自我纠正的分水岭。

**第一版原型犯过一个错,值得记下来**:把 `chcp 65001 > $null; [Console]::OutputEncoding = [Text.Encoding]::UTF8` 写进了提示词。模型于是**逐字抄进每条命令**(8 段对话里出现),而 harness 的前导本来就在做同一件事。**把 harness 的职责写进提示词,只会让模型重复劳动并浪费 token。**

兜底:若某条命令触发 **PowerShell 解析级**错误(如 `&&`),整串无法解析,前导不生效,输出仍是 GBK。因此解码端需要"UTF-8 失败则回退 GBK"的双路处理,不能只认一种。实测 352 条命令里只漏了 1 条。

## 引号转义:已知陷阱,但低频

PowerShell 不用反斜杠转义,它用反引号 `` ` `` 或成对单引号:

```
Select-String -Pattern "require\(|from ['\"]"   ← \" 不是转义
→ The string is missing the terminator: "
```

早期小样里出现过一次,但**完整 120 段对话里为 0**。保留在测试分类里(它与"写 Unix 命令"是不同类别,混在一起会互相掩盖),但不值得为它写提示词段落。

## PowerShell 5.1 是兼容性下界

"PowerShell"必须指名版本。**Windows PowerShell 5.1(`powershell.exe`)随 Windows 出厂,PowerShell 7(`pwsh`)需要单独安装** —— 所以 5.1 是必须支持的地板,7 是可选的上层。模型写出的每条命令都必须在 5.1 下成立。

实测差异(本机只有 5.1,无 `pwsh`):`&&` 与 `||` 不被支持,报 `The '&&' token is not a valid statement separator in this version`;无三元运算符、无 `??`。

若将来要利用 7 的能力,必须"探测到 `pwsh` 才启用",不能让 5.1 用户撞上语法错误。

## 环境轴已消解

Git for Windows 把 `git.exe` 与 MSYS 的 Unix 工具**捆绑安装,不可分割**。实测对照:

| | 无 Git 的机器 | 装了 Git 的机器 |
| --- | --- | --- |
| `grep` 可见 | 否 | 是 |
| `grep -r parseConfig src` | `CommandNotFoundException` | 成功返回结果 |

我原本以为需要在"以哪种环境为设计目标"之间做决定。**实验证明这个决定不需要做** —— 模型从不调用这些工具,所以它们是否存在同样无关紧要。两种环境下八格结果完全一致。

## 后果

- **一句话声明环境即可。** 不要为"模型会写 Unix 命令"再投入提示词工程 —— 那份投入没有回报。系统提示写清 shell 是 PowerShell 5.1 就够。
- **编码、命令包装、超时、错误归一化都归 shell 工具。** 任何"模型应该自己记住"的机制性约定,都等于让模型每轮重复劳动。
- **不支持 Git Bash 仍是刻意的不做,不是遗漏。** 加一条 Unix shell 路径会把这条决定本要避开的 Git 前置条件重新引回来。不要在没有重开本 ADR 的情况下"修好"它的缺失。
- **真正的风险不在语法,在语义。** 实验中 10 条失败命令里 8 条是查端口:模型用 `netstat \| findstr` 或 `Get-NetTCPConnection`,端口空闲时退出码为 1。命令完全正确,是**退出码语义**问题 —— "无结果"与"失败"在 shell 里无法区分。这是 shell 工具必须处理的,提示词解决不了。
