import type { Tool } from '../core/tool.js';
import { walkFiles } from './walk.js';

const DEFAULT_MAX_RESULTS = 200;

/**
 * 一个够用就好的 glob:`**` 跨目录、`*` 不跨目录、`?` 一个字符。
 *
 * 大小写不敏感 —— Windows 的路径本来就不区分大小写,在这里区分只会让用户困惑。
 */
function globToRegExp(pattern: string): RegExp {
  let out = '^';

  for (let index = 0; index < pattern.length; index++) {
    const ch = pattern.charAt(index);

    if (ch === '*') {
      if (pattern.charAt(index + 1) === '*') {
        index++;
        if (pattern.charAt(index + 1) === '/') {
          index++;
          out += '(?:.*/)?'; // `**/x` 既匹配 x,也匹配 a/b/x
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }

  return new RegExp(`${out}$`, 'i');
}

function find(root: string, pattern: string, maxResults: number): string {
  const files = walkFiles(root);

  // 没有通配符时按子串找。`loop.ts` 是人的自然写法,而拿它做精确的整路径匹配
  // 只会得到零命中 —— 那种"明明有却找不到"最难用。
  const hasGlob = pattern.includes('*') || pattern.includes('?');
  const matches = hasGlob
    ? (() => {
        const regex = globToRegExp(pattern);
        return (rel: string) => regex.test(rel);
      })()
    : (rel: string) => rel.toLowerCase().includes(pattern.toLowerCase());

  const hits = files.filter((file) => matches(file.rel)).map((file) => file.rel);

  if (hits.length === 0) {
    const hasGlobNote = hasGlob ? '' : '(没有通配符时按子串匹配)';
    return `在 ${files.length} 个文件里没有匹配 ${pattern} 的路径。${hasGlobNote}`;
  }

  const shown = hits.slice(0, maxResults);
  const tail = hits.length > shown.length ? `\n…(共 ${hits.length} 个,只显示了前 ${shown.length} 个)` : '';
  return `${shown.join('\n')}${tail}`;
}

/** 按文件名或路径模式找文件。先用它摸清仓库结构,再决定读哪些。 */
export function createFindFilesTool(): Tool {
  return {
    spec: {
      name: 'find_files',
      description:
        '按路径模式列文件。`*` 不跨目录,`**` 跨目录,`?` 一个字符;没有通配符时按子串匹配。大小写不敏感。\n' +
        '默认跳过 node_modules、.git、dist 等目录。',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '例如 `**/*.test.ts` 或 `src/core`' },
          path: { type: 'string', description: '搜索的根目录,默认当前工作目录' },
          max_results: { type: 'number', description: `最多返回多少个,默认 ${DEFAULT_MAX_RESULTS}` },
        },
        required: ['pattern'],
      },
    },

    async run(input) {
      const { pattern, path, max_results: maxResults } = input as {
        pattern: string;
        path?: string;
        max_results?: unknown;
      };
      const limit =
        typeof maxResults === 'number' && Number.isFinite(maxResults) && maxResults >= 1
          ? Math.floor(maxResults)
          : DEFAULT_MAX_RESULTS;

      return find(path ?? process.cwd(), pattern, limit);
    },
  };
}
