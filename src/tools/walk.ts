import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 这些目录永远不会是用户要找的,进去只有几万文件的噪音和耗时。
 *
 * 刻意写死而不是读 .gitignore:读 .gitignore 要处理它的语法、嵌套与取反规则,
 * 而搜索工具猜错一次(把该找的藏起来)比慢一点糟得多。
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.idea',
  '.vscode',
]);

export type WalkedFile = {
  /** 绝对路径,用来读。 */
  abs: string;
  /** 相对搜索根目录的路径,用正斜杠 —— 给模型看的,统一成一种写法。 */
  rel: string;
};

/**
 * 按目录深度优先遍历文件。符号链接目录不跟随 —— 那会绕成环。
 *
 * limit 是必要的:搜错了根目录(比如 C:\)时,没有上限意味着它会一直跑下去,
 * 而用户只会看到一个不动的光标。
 */
export function walkFiles(root: string, limit = 20_000): WalkedFile[] {
  const found: WalkedFile[] = [];
  const stack = [root];

  while (stack.length > 0 && found.length < limit) {
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // 读不了的目录(权限、路径太长)跳过就好 —— 它不是用户要找的东西的理由,
      // 但也不该让整个搜索失败。
      continue;
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
      } else if (entry.isFile()) {
        found.push({ abs, rel: relative(root, abs).split('\\').join('/') });
        if (found.length >= limit) break;
      }
    }
  }

  return found;
}
