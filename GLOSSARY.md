# hcode

一个开源的 AI 编程 **Harness**,面向使用国产模型的开发者 —— 即 Claude Code 不可用、而现有 harness 都假设海外网络的那块空白。Windows 优先,只跑 PowerShell。

## 用词

**Harness**:
本项目书写的一切 —— 工具、权限边界、上下文管理、以及模型借以行动的所有接口。Harness 是载具,它自身不承载智能。
_Avoid_: Agent、工作台、平台、框架、"编程 agent"

**Agent**:
模型本身 —— 那个通过训练获得感知、推理与行动能力的智能体。本项目不构建 Agent,只构建它所栖居的环境。
_Avoid_: 用 "Agent" 指代整个产品,或指代本仓库的任何一部分

**Provider**:
Harness 借以触达模型厂商 API 的那道缝 —— 一个接口、一处约定,只有一道。
_Avoid_: 模型、后端、客户端

**适配器**:
填进 Provider 这道缝里的一份实现,一个厂商一个。GLM、DeepSeek、Claude 各是
一个适配器;换一家模型 = 写一个新适配器,缝不动。
_Avoid_: 用 "Provider" 指某家的具体实现(「GLM 的 Provider」应说「GLM 的适配器」)
