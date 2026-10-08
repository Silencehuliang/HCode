// 把一次真实的厂商响应录制成测试夹具。
//
// 为什么要有这个脚本:测试面要求"各适配器的请求构造与响应解析对着录制下来的真实
// 响应"(见规格的 Testing Decisions)。手抄响应体会引入"我抄错了但没人知道"的风险,
// 所以录制这件事本身要能重放 —— 换一个厂商、换一个模型,重跑一次即可。
//
// 用法:
//   node scripts/record-provider-response.mjs --vendor <厂商> --out <夹具文件> [--env-file <凭据文件>] [--base-url 覆盖]
//
// 厂商决定两件事:读哪几个环境变量(`<厂商大写>_BASE_URL` / `_API_KEY` / `_MODEL`),
// 以及夹具里导出的常量叫什么(`<厂商>` 打头)。加了第三个厂商就照着同一个命名再来一遍。
//
// 凭据只从 --env-file 或进程环境读,**不落进夹具**。夹具里只会写进响应体。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--')) throw new Error(`无法识别的参数:${key}`);
    args[key.slice(2)] = argv[index + 1];
  }
  return args;
}

function readEnvFile(path) {
  const text = readFileSync(path, 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

const args = parseArgs(process.argv.slice(2));
const env = args['env-file']
  ? { ...readEnvFile(args['env-file']), ...process.env }
  : process.env;

const vendor = args.vendor;
if (!vendor || !/^[a-z][a-z0-9]*$/.test(vendor)) {
  console.error('缺少 --vendor,或厂商名不是小写字母数字(例:--vendor deepseek)。');
  process.exit(1);
}

const envPrefix = vendor.toUpperCase();
const baseUrl = args['base-url'] ?? env[`${envPrefix}_BASE_URL`];
const apiKey = env[`${envPrefix}_API_KEY`];
const model = env[`${envPrefix}_MODEL`];

if (!baseUrl || !apiKey || !model) {
  console.error(
    `缺少 ${envPrefix}_BASE_URL / ${envPrefix}_API_KEY / ${envPrefix}_MODEL —— ` +
      '用 --env-file 指到凭据文件,或设成环境变量。',
  );
  process.exit(1);
}

const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

/** 探测集固定:纯文本、工具调用、厂商报错 —— 适配器要解析的就是这三种形状。 */
const probes = [
  {
    name: 'text',
    note: '模型只回文本,没有工具调用',
    body: {
      model,
      messages: [{ role: 'user', content: '只回答两个字:收到' }],
    },
  },
  {
    name: 'toolCall',
    note: '模型要求执行 run_command',
    body: {
      model,
      messages: [{ role: 'user', content: '当前目录是什么?用工具看。' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'run_command',
            description: '在 PowerShell 里执行一条命令。',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string', description: '要执行的 PowerShell 命令' } },
              required: ['command'],
            },
          },
        },
      ],
    },
  },
  {
    name: 'error',
    note: '模型名不存在时厂商的报错',
    body: { model: '不存在的模型-xyz', messages: [{ role: 'user', content: 'hi' }] },
  },
];

const recorded = [];
for (const probe of probes) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(probe.body),
  });
  const raw = await response.text();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${probe.name} 的响应不是 JSON,无法录成夹具:\n${raw.slice(0, 500)}`);
  }

  recorded.push({ name: probe.name, note: probe.note, status: response.status, value: parsed });
  console.log(`${probe.name}: HTTP ${response.status}`);
}

const header = [
  '// 录制自真实接口的响应。请勿手改 —— 用 scripts/record-provider-response.mjs 重录。',
  '//',
  `// 来源:${endpoint}`,
  `// 模型:${model}`,
  '// 时间:' + new Date().toISOString().slice(0, 10),
  '//',
  '// 内容逐字来自响应体。缩进是重新排版的结果(原始响应是单行),空白之外没有任何改动。',
  '',
].join('\n');

const body = recorded
  .map(
    (item) =>
      `/** HTTP ${item.status} —— ${item.note} */\n` +
      `export const ${vendor}${item.name[0].toUpperCase()}${item.name.slice(1)} = ` +
      `${JSON.stringify(item.value, null, 2)};\n`,
  )
  .join('\n');

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, `${header}\n${body}`);
console.log(`已写入 ${args.out}`);
