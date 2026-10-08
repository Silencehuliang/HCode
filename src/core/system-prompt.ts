/**
 * 系统提示。
 *
 * 只需要一句话声明 shell 环境 —— 这不是偷懒:352 条命令的实测里,精心编写的
 * "Unix 惯用法 → PowerShell 映射表"没有产生任何可测量的收益(零 Unix 语法尝试),
 * 不值得为它投入提示词工程。见 ADR-0002。
 *
 * 进程模型(cd 不保持、每次都是新 shell)不写在这里,而是写在 run_command 的
 * 工具描述里 —— 那是模型决定怎么用这个工具时才需要的东西,放进系统提示等于
 * 每一轮都在重复它。
 */
export const SYSTEM_PROMPT = [
  '你是一个在用户的 Windows 机器上干活的编程助手。',
  '用户的 shell 是 Windows PowerShell(powershell.exe),不是 bash、cmd 或 WSL。',
].join('\n');
