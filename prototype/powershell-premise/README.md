# 原型:验证 PowerShell 前提

**这不是产品代码。是一次性测量台,回答了一个问题。**

## 问题与答案

**问**:ADR-0002 决定 Windows 优先、命令工具只跑 PowerShell。它压在一个未经验证的假设上 —— *Claude 级模型在 PowerShell 上的语法成功率,高到"好用"这句承诺站得住*。

**答:假设成立,而且远比预期强。精心准备的缓解措施没有可测量的收益。**

352 条命令、2 个模型、2 种提示、2 种 PATH 环境,**零 Unix 语法尝试**:

| 该诱出的 Unix 写法 | 实际用法 |
| --- | --- |
| `grep -r` | `Get-ChildItem \| Select-String` |
| `diff` | `Compare-Object` |
| `wc -l` | `Measure-Object` |
| `ls -S \| head` | `Sort-Object Length -Descending` |
| `echo $PATH` | `$env:PATH -split ';'` |

`ls -la`、`cat`、`&&`、`export` 一次都没出现。

### 八格结果

| 环境 | 模型 / 臂 | 任务 | 首次成功 | 硬失败 | 乱码 | Unix 语法 |
| --- | --- | --- | --- | --- | --- | --- |
| clean | glm/minimal | 14 | 93% | 0% | 0% | 0% |
| clean | glm/mitigated | 14 | 100% | 0% | 0% | 0% |
| clean | deepseek/minimal | 14 | 93% | 0% | 7% | 0% |
| clean | deepseek/mitigated | 14 | 93% | 0% | 0% | 0% |
| native | glm/minimal | 15 | 93% | 0% | 0% | 0% |
| native | glm/mitigated | 15 | 100% | 0% | 0% | 0% |
| native | deepseek/minimal | 15 | 100% | 0% | 0% | 0% |
| native | deepseek/mitigated | 15 | 93% | 0% | 0% | 0% |

**两臂的差异在噪声范围内。** 命令词汇、成功率、失败模式全都一致。

### 三条附带结论

1. **环境轴是空的。** clean 与 native 完全一致,因为 Unix 工具从未被调用 —— "以哪种环境为设计目标"这个未决问题自动消解。
2. **编码是 harness 的职责,写进提示词反而有害。** 第一版提示词里写了 `chcp 65001; [Console]::OutputEncoding=…`,模型逐字抄进每条命令(8 段对话),而 harness 的前导本来就在做同一件事。
3. **真正的风险在语义,不在语法。** 10 条失败命令里 8 条是查端口 —— `netstat | findstr` 或 `Get-NetTCPConnection` 在端口空闲时退出码为 1。"无结果"与"失败"在 shell 里无法区分,这是 shell 工具必须处理的。

## 实验设计

**两臂对照**,唯一变量是系统提示:

| 臂 | 系统提示 |
| --- | --- |
| `minimal` | 只声明环境(一句话说明 shell 是 PowerShell 5.1) |
| `mitigated` | 声明 + Unix 惯用法映射表 + 引号规则 |

**两环境对照**,唯一变量是 PATH:

| 环境 | 含义 |
| --- | --- |
| `clean` | 剔除 Git/MSYS,模拟没装 Git 的机器 |
| `native` | 开发者本机原样(装了 Git,git.exe 与 Unix 工具同时在 PATH 上) |

每个任务开一段全新对话。

## 跑法

```bash
node run.mjs --dry-run                        # 看计划,不发任何调用
node run.mjs --selftest --path=clean          # 验证仪器本身
node probe-providers.mjs                      # 探第三方 provider 是否支持 tool calling
node run.mjs --path=clean,native              # 实跑
```

凭据从同级 `.env` 读(已 gitignore),或从环境变量。

## 这个原型自身的两处错误(留作教训)

1. **把 harness 的职责写进了提示词。** 见上。
2. **第一版把 `git.exe` 一起从 clean PATH 里剔除了**,导致 `git-log` 在无 Git 环境下被误判成模型失败。修法:任务带 `needs: 'git'` 标记,环境缺程序时跳过。

## 已知的边界

- **只有 2 个模型**,各一个,且都来自本地网关(其后端未知)。
- **15 个任务都偏简单**,夹具很小。没有覆盖大型仓库、长输出、并发编辑。
- **`port-check` 是个设计得差的任务** —— 端口空闲天然返回非零,它测的是退出码语义而不是模型。
- 结论**只对这一代模型成立**。learn-claude-code 的 Windows 分支在它成文时可能是对的。

## 状态

结论已折入 `docs/adr/0002-powershell-as-the-only-shell.md`。本目录是原始出处,保留在一次性分支上,main 只保留已达成的决定。
