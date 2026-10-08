# 配置

## 密钥以明文落盘

先说最要紧的一条:hcode 把密钥**以明文**存在下面这两个 JSON 文件里,不做加密、不做系统钥匙串。

- 用户级:`<你的用户目录>/.hcode/settings.json`(Windows 上是 `C:\Users\<你>\.hcode\settings.json`)
- 项目级:`<项目目录>/.hcode/settings.json`

这件事与 GitHub CLI(`~/.config/gh/hosts.yml`)、AWS CLI(`~/.aws/credentials`)、npm(`~/.npmrc`)一致。说在这里,是为了不让任何人以为它被别的东西保护着。

别把它们提交进版本库。项目级配置放在 `.hcode/` 这个目录里就是为了这个 —— 一个 `.gitignore` 条目

```
.hcode/
```

就能挡住整个目录。hcode 自己不会创建 `.gitignore`,也不会替你写任何密钥。

不想落盘就只用环境变量(见下),代价是每次开终端都要重新设一遍。

## 密钥必须是 ASCII

密钥最终要放进 HTTP 请求头,而请求头只装得下 ASCII。从网页或文档里复制密钥时带进一个全角字符或全角空格,是很常见的事。

hcode 会在启动时检查,直接告诉你**是第几个字符**出了问题,比如:

```
密钥里第 7 个字符是「,」,它不是 ASCII 字符。
```

不检查的话,你要等到发出第一个请求才会看到一句 `Invalid character in header content ["authorization"]` —— 那句话里既没有"密钥"也没有位置。

## 读取顺序

优先级从高到低,高的压过低的:

1. 环境变量
2. 项目级 `settings.json`
3. 用户级 `settings.json`
4. 自动探测(见下)
5. 内置默认(Provider 是 `glm`)

分层是**逐字段**生效的,不是整份替换。项目级只写一行 `model`,其余字段仍然从用户级取 —— 一个仓库想换模型时不必把密钥再抄一遍。

项目级与用户级同时存在时,启动横幅会把两份路径都列出来。这是刻意的:不然"我改了用户级那份怎么没反应"要靠猜。

任何一层配置文件**存在但读不动**(JSON 写坏了、编码不对),hcode 直接报错退出,不会跳过这一层继续跑 —— 跳过的话,你写的设置会一部分生效一部分不生效,而没有任何线索说明为什么。

## 文件形状

```json
{
  "provider": "glm",
  "providers": {
    "glm": { "apiKey": "你的密钥" },
    "deepseek": { "apiKey": "你的密钥", "model": "deepseek-chat" },
    "claude": {
      "apiKey": "你的密钥",
      "proxy": "http://127.0.0.1:7890",
      "thinking": true
    }
  }
}
```

三家可以在同一份配置里共存,切换只改最上面那一行 `provider`。

每家的字段都是可选的,除了 `apiKey`:

| 字段 | 不填时 | 说明 |
| --- | --- | --- |
| `apiKey` | 没有默认值,必须给 | |
| `model` | `glm-5.3` / `deepseek-chat` / `claude-sonnet-5-5` | 按上面选中的那家取 |
| `baseUrl` | 厂商官方端点 | 自建中转、本地网关填这里 |
| `proxy` | 不走代理 | **按家配**,不是全局。见下 |
| `thinking` | 厂商默认 | 开/关思维链 |

`proxy` 为什么按家配:用国产模型的人多半不需要代理,要用 Claude 的人多半必须用。做成全局的话,要么逼前者也配一个,要么更糟 —— 让国产模型的请求也绕一圈到国外代理去。

## 环境变量

通用变量,谁都用:

| 变量 | 对应 |
| --- | --- |
| `HCODE_PROVIDER` | `provider` |
| `HCODE_API_KEY` | 当前这家的 `apiKey` |
| `HCODE_MODEL` | 当前这家的 `model` |
| `HCODE_BASE_URL` | 当前这家的 `baseUrl` |
| `HCODE_PROXY` | 当前这家的 `proxy` |
| `HCODE_THINKING` | 当前这家的 `thinking`(`1/true/on/yes` 与 `0/false/off/no`) |

值写成空串当作没设 —— `.env` 里留一行空的 `HCODE_PROVIDER=` 不会把文件里的设置顶掉。

### 认得的既有变量

已经配好 Claude Code 的人**不需要建配置文件**,直接敲 `hcode` 就能用:

| 变量 | 认成 |
| --- | --- |
| `ANTHROPIC_API_KEY` | claude 的密钥 |
| `ANTHROPIC_BASE_URL` | claude 的 `baseUrl` |
| `ANTHROPIC_MODEL` | claude 的 `model` |

同理还有 `GLM_API_KEY` / `GLM_BASE_URL` / `GLM_MODEL` 与 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`(后两组是按厂商自己的叫法定的,方便 `set -a && . .env && set +a` 这类本地网关用法)。

这些变量是**按家**认的:选了 `provider: "claude"` 时,`GLM_BASE_URL` 不会被当成 claude 的接口地址 —— 那会把请求发去一个说不了 Anthropic 话的端点。

## 没有明说用哪家时

按这个顺序:

1. `HCODE_PROVIDER`
2. 配置文件里的 `provider`(项目级优先于用户级)
3. 自动探测:看手上真有哪家的密钥,按 **glm → deepseek → claude** 取第一家
4. `glm`

第 3 步的国产优先是刻意的:顺手 `export` 过一个 `ANTHROPIC_API_KEY` 的人(跑 Claude Code 的人几乎都有,而且很多是别的工具留下的)不该因此被带到国外模型上去 —— 而他手上真要是有国产模型的密钥,那才是他想用的。

反过来,你**写明了**用哪家却没配那一家的密钥时,hcode 照实报错,不会自作聪明换一家跑。

## 指令文件

配置之外,项目约定按 `HCODE.md` → `CLAUDE.md` → `AGENTS.md` 取第一个存在的,启动时点名用了哪一个。`CLAUDE.md` 与 `AGENTS.md` **只读,永不写入**。详见 [ADR-0003](adr/0003-instruction-file-precedence.md)。
