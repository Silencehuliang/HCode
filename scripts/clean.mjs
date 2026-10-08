// 删掉 dist/。发包前必须清一次 —— tsc 不会替你删掉上一次构建留下的东西,
// 而开发态构建(带 *.test.js)和发包态构建写的是同一个目录。不清的话,
// 打包进去的会是"最后一次运行 tsc 时的那个混合体"。
//
// 写成脚本而不是 `rm -rf`,是因为它要在 Windows 的 PowerShell 里跑。
import { rmSync } from 'node:fs';

rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
