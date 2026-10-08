# 命令工具只跑 PowerShell,不支持第二种 shell

我们用 `powershell.exe` 作为 Agent 的 shell,**不回退到 Git Bash**。理由是获客而非偏好:要求安装 Git for Windows,会把我们的目标用户 —— Windows 上的中文开发者,也正是我们做差异化的那批人 —— 挡在一次安装之前。这个取舍比 POSIX shell 的便利更值钱。

## 后果

- **语法错配是系统性的,不是偶发的。** 模型的训练语料以 Unix 为绝对多数,它会往一个没有 `ls -la`、`grep -r`、`cat`、`&&` 的 shell 里写这些。这一点必须被主动缓解:系统提示声明 shell 环境,单独一节给出常见 Unix 惯用法到 PowerShell 的映射,并且每一次错配都要记下 agent 写了什么、shell 回了什么 —— 提示词对着这份数据迭代,而不是对着直觉。learn-claude-code 的 `s01` 里带 `os.name == 'nt'` 分支,正是同一个原因。

- **不支持 Git Bash 是刻意的不做,不是遗漏。** 加一条 Unix shell 路径会把这条决定本要避开的 Git 前置条件重新引回来。**不要**在没有重开本 ADR 的情况下"修好"它的缺失。

- 工具描述与集成测试都以 PowerShell 为前提。一个在 POSIX shell 下正常、在这里出错的工具,是工具的 bug,不是平台怪癖。
