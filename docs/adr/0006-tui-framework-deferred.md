# TUI 框架推迟决定,骨架用手写 REPL

规格原本写着「TUI 基于 OpenTUI + React」。这条决定被一次实测推翻了:**OpenTUI 在本项目的 Node 下界上跑不起来。**

`@opentui/core` 声明 `engines.node >= 26.4.0`,它的原生层走 `node:ffi` —— Node 26 才有的实验性内置模块。在 Node 22.21.1 上实测:

- `import('@opentui/core')` **能**成功(它按运行时能力懒加载,导入时不报错)
- 但建立 renderer 的那一刻立刻失败:

  ```
  Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet
  ```

`node:ffi` 在 Node 22 上是 `ERR_UNKNOWN_BUILTIN_MODULE`。也就是说这不是"可能不兼容",是确定的不可用 —— 而且**只做导入检查会得出相反的结论**,这正是它值得被记下来的原因。

Node 22 是 hcode 的下界,而「`npm i -g hcode` 一条命令装好,不需要任何前置」是产品定位的一部分。所以 v1 的骨架不引入 TUI 框架:交互界面用 `readline` 加少量 ANSI 手写。

这不是「先用简单的、以后再换」的临时妥协。它把 TUI 框架的选择从骨架里**摘出去**,让那个决定在信息更充分时单独做 —— 骨架的验收只要求「能进入交互界面、退出后终端状态正常」,手写 REPL 满足它。

## 考虑过的方案

**改用 Ink。** 暂缓:React 选型不变,`node >= 22` 也正好等于下界,生态成熟。但它逐行渲染,不是全屏合成器 —— 分栏、可滚动 diff、悬浮面板这类界面它挡不住,而那是编程工作台迟早要的。现在选它,可能只是把同一个决定推后到代价更高的时候。

**把 Node 下界抬到 26。** 否决:与「降低门槛」的产品定位直接冲突,且 OpenTUI 依赖的 `node:ffi` 在该版本上仍是实验特性(需要 `--experimental-ffi`)。

## 后果

- 规格中「TUI 基于 OpenTUI + React」一句作废。TUI 框架作为**独立决策**重新走一次,在那之前不写死。
- 骨架的交互界面后面要重写。这是已知且被接受的代价。
- `tui` 目录在 v1 里很薄,`cli` 承担大部分交互。分层不变(见 ADR-0001)。
- 重新决策需要现在没有的事实:OpenTUI 在 Windows / PowerShell 5.1 下的实际表现、`node:ffi` 何时转正、以及真实界面需求(要不要全屏合成)有多硬。
