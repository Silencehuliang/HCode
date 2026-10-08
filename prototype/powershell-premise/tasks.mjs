// 原型任务集。每条都是一句自然的开发者请求,不提及 shell、不提示语法。
// 覆盖:文件读取、搜索、git、进程、JSON、中文路径、目录操作。
//
// needs: 该任务在当前环境里必须具备的外部程序。缺失时跳过,不计入成功率 ——
// 否则测的是环境而不是模型(clean 模式没有 git,git-log 物理上无法完成)。

export const TASKS = [
  { id: 'read-manifest', prompt: '看看这个项目的依赖有哪些,列出来。' },
  { id: 'largest-files', prompt: '找出这个目录下最大的 5 个文件。' },
  { id: 'search-usage', prompt: '找出哪些文件里用到了 parseConfig 这个函数。' },
  { id: 'count-files', prompt: '统计 src 目录下有多少个文件。' },
  { id: 'run-tests', prompt: '跑一下这个项目的测试。' },
  { id: 'install-deps', prompt: '安装项目依赖。' },
  { id: 'git-log', prompt: '看看最近 5 次提交都改了什么。', needs: 'git' },
  { id: 'create-file', prompt: '新建一个 notes 目录,在里面写一个 hello.txt,内容是 hello。' },
  { id: 'chinese-path', prompt: '读取 文档 目录下那个中文名文件的内容。' },
  { id: 'process-check', prompt: '看看 node 进程现在有没有在跑。' },
  { id: 'json-field', prompt: '把 config.json 里的 port 字段值读出来。' },
  { id: 'cleanup', prompt: '把 tmp 目录删掉。' },
  { id: 'env-var', prompt: '看看当前 PATH 环境变量里有没有包含 node 的路径。' },
  { id: 'compare-files', prompt: '比较一下 a.txt 和 b.txt 有什么不同。' },
  { id: 'port-check', prompt: '看看 8080 端口有没有被占用。' },
];

// 夹具:一个像真实项目的目录,含包清单、源码、中文名文件、待比较文件。
// 生成在原型目录下,名字显式标注为一次性产物。
export const FIXTURE = {
  'package.json': JSON.stringify({
    name: 'fixture-app', version: '1.0.0', type: 'module',
    scripts: { test: 'node --test' },
    dependencies: { express: '^4.19.0', zod: '^3.23.0' },
    devDependencies: { typescript: '^5.9.0' },
  }, null, 2),
  'config.json': JSON.stringify({ port: 8080, host: '127.0.0.1', debug: true }, null, 2),
  'src/index.js': [
    'import { parseConfig } from "./config.js";',
    'const cfg = parseConfig("./config.json");',
    'console.log(cfg.port);',
  ].join('\n'),
  'src/config.js': [
    'import { readFileSync } from "node:fs";',
    'export function parseConfig(path) {',
    '  return JSON.parse(readFileSync(path, "utf8"));',
    '}',
  ].join('\n'),
  'src/utils.js': 'export const noop = () => {};\n',
  'src/legacy.js': '// legacy: parseConfig was here before the refactor\n',
  'tests/smoke.test.js': [
    'import { test } from "node:test";',
    'import assert from "node:assert";',
    'test("smoke", () => { assert.ok(true); });',
  ].join('\n'),
  '文档/说明.md': '# 说明\n\n这是一个中文文件名的测试文档。\n',
  'a.txt': 'alpha\nbeta\ngamma\n',
  'b.txt': 'alpha\ndelta\ngamma\n',
  'tmp/scratch.txt': 'temporary\n',
};
