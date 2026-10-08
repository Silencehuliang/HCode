import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 起一个真进程,只验一件事:`/exit` 之后它会不会退出。
 *
 * 为什么要起真进程:这是**进程级**的行为,推演不出来。真踩到过的一次是 ——
 * readline 关掉之后 stdin 仍被引用着,只要父进程不关写端(编辑器插件、CI、
 * 另一个程序拉起 hcode),`/exit` 之后进程就挂在那里。在真终端里手敲 `/exit`
 * 一切正常,所以这条路径只有把 stdin 接成管道才看得见。
 *
 * 这个文件不碰终端界面本身(那需要真 TTY,而且快照极不稳定,见规格的 Testing
 * Decisions)。它只问一句:退出了没有。
 */
test('/exit 之后进程会退出,即使 stdin 是一根还开着写端的管道', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hcode-exit-home-'));
  mkdirSync(join(home, '.hcode'), { recursive: true });
  writeFileSync(
    join(home, '.hcode', 'settings.json'),
    JSON.stringify({
      provider: 'glm',
      // 地址指向一个没人监听的端口:这个测试不该发请求,发了就会慢下来。
      providers: { glm: { apiKey: 'test-key', model: 'glm-5.3', baseUrl: 'http://127.0.0.1:9/v1' } },
    }),
    'utf8',
  );

  // dist/tui/repl.test.js → dist/cli/main.js
  const entry = fileURLToPath(new URL('../cli/main.js', import.meta.url));

  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: home };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'HCODE_API_KEY', 'HCODE_PROVIDER']) {
    delete env[key];
  }

  // cwd 设成临时目录,免得把仓库自己的 CLAUDE.md 读进来 —— 那会让这条测试
  // 依赖仓库里恰好有什么文件。
  const child = spawn(process.execPath, [entry], { cwd: home, env });

  try {
    // 关键:只写 /exit,**不关 stdin**。关掉写端会送出一个 EOF,那样即使
    // 修好了也测不出来 —— 进程会因为读到文件尾而退出,不是因为 /exit 处理对了。
    child.stdin.write('/exit\n');

    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve('没退出');
      }, 15_000);
      child.on('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    assert.equal(
      code,
      0,
      '进程没有在 /exit 之后正常退出 —— readline 关掉之后 stdin 还引用着事件循环。' +
        '收尾时要 pause + unref(只 pause 不够,实测过)。',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
