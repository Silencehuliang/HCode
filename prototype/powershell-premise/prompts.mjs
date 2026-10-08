// 两臂系统提示。唯一的变量就是「有没有那节 Unix→PowerShell 映射」。

const BASE = (cwd) =>
  `You are a coding agent at ${cwd}. ` +
  `Environment: Windows. The shell tool runs Windows PowerShell 5.1 (not PowerShell 7, not bash). ` +
  `Use the shell tool to solve tasks. Act, don't explain.`;

// 臂 A:只声明环境。等同 learn-claude-code s01 在 Windows 上的做法。
export const MINIMAL = (cwd) => BASE(cwd);

// 臂 B:声明 + 完整的缓解措施(ADR-0002 计划要做的那一节)。
const MITIGATION = `
## Shell conventions

The shell is Windows PowerShell 5.1. It is NOT bash and NOT PowerShell 7.

Do not use these; they do not exist or mean something else here:
- \`&&\` and \`||\` — not supported in 5.1. Use \`;\` to sequence, or \`if ($?)\` to branch.
- \`grep -r PATTERN PATH\` — use \`Select-String -Path <glob> -Pattern <pat>\`
- \`find . -name\` — use \`Get-ChildItem -Recurse -Filter\`
- \`head\` / \`tail\` — use \`Select-Object -First N\` / \`-Last N\`
- \`wc -l\` — use \`(Get-Content <f>).Count\`
- \`rm -rf\` — use \`Remove-Item -Recurse -Force\`
- \`export X=1\` — use \`$env:X = "1"\`
- \`ls -la\` — \`ls\` exists but is an alias for Get-ChildItem and takes no \`-la\`. Use \`Get-ChildItem -Force\`.

Note: some Unix tools (head, which, grep) may resolve to Git's MSYS binaries if they
happen to be on PATH. Do not rely on them; they will not exist on a clean machine.

## Quoting

PowerShell does NOT use backslash to escape quotes. \`\\"\` does not escape anything —
it terminates the string and raises \`TerminatorExpectedAtEndOfString\`.

- Inside a double-quoted string, escape with a backtick: \`"say \`"hi\`""\`
- Prefer single-quoted strings for regex and paths — nothing is interpolated:
  \`Select-String -Path .\\src\\*.js -Pattern 'require\\(|from '\`
- To include a single quote inside a single-quoted string, double it: \`'it''s'\`
`;

// 注意:这里刻意没有编码相关的指示。输出编码是 harness 的职责,由 shell 工具
// 每次调用前设置,不该写进提示词 —— 实测第一版把 \`chcp 65001; [Console]::OutputEncoding=…\`
// 写进了这里,模型逐字抄进每条命令(8 段对话),而 harness 的前导本来就在做同一件事。

export const MITIGATED = (cwd) => BASE(cwd) + '\n' + MITIGATION;

export const ARMS = {
  minimal:   { label: '只声明环境',   system: MINIMAL },
  mitigated: { label: '声明 + 适配',  system: MITIGATED },
};
