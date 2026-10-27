# dsh-prompt-enhance（增强提示词）

GitHub: https://github.com/zzxhzzz/dsh-prompt-enhance

当前版本：`0.1.0-beta`。首发目标为 DeepSeek Harness 官方桌面版的 `desktop` profile。

在 DeepSeek Harness（dsh）聊天输入区加一枚「增强提示词」按钮：用户输入原始需求后点一下，插件用**一次轻量 LLM 调用**把需求改写成更清晰、更完整、更可执行的提示词，并回填到输入框——不自动发送，用户可继续编辑。

模型调用失败、超时、返回空内容或没配置模型时，**原始输入原样保留**。

## 形态

一个 dsh 官方形态的 Cordis 插件包，含两个 half：

| Half | 文件 | 作用 |
|---|---|---|
| Host | `lib/index.js` | 导出 `name` / `inject` / `apply(ctx, config)`；用 `ctx.webServer` 注册两条路由，用 `ctx.llm` 调用组合里已有的模型 |
| Client | `lib/client.js` | `window.__ModuleLoader__.load({ id, factory })` 浏览器包；注册进 `conversation.input.left`，读草稿、回填草稿 |

`package.json` 的 `dsh` 字段声明 Bundle 与客户端能力：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
}
```

两种 `inject` 不是一回事：

- `dsh.client.inject`：**客户端包级依赖**，只决定浏览器包的激活/到达顺序；
- `lib/client.js` 工厂返回的 `inject: ['slots']`：**客户端运行时服务依赖**，由 Cordis 解析，缺它就不激活；
- `lib/index.js` 的 `export const inject = ['webServer', 'connection', 'llm']`：**Host 端 Cordis 服务依赖**。

不修改 dsh 核心源码，不修改任何已有插件，不使用未公开 API。

## 安装（本地开发挂载）

本包是一个 bundle 包。官方安装入口是 `plugin_manager` 的 `install_bundle`，它写 profile 的 `package.json` 与 `dsh.profile.bundles`，**不要手工编辑这两处**：

1. 在 dsh 会话里让 Agent 调用（`target` 取这个目录的绝对路径）：

   ```text
   plugin_manager { action: "install_bundle", target: "E:\\deepseek harness work\\prompt-enhance" }
   ```

2. 本地目录安装是 link 方式，改代码后 Host 侧通常需要重启进程，浏览器侧由 HMR 重载。

启动/重载、检查、卸载：

```powershell
dsh --profile desktop --dump-config   # ⚠ 本机会被拒绝，见下
```

**本机实测**：`desktop` profile 由 Electron 应用独占管理，CLI 会直接拒绝
（`profile "desktop" is managed exclusively by the Electron application`）。
所以 `--dump-config` 只能用于非托管 profile（例如自建 scratch profile）。
托管 profile 的等价检查用这两条，都是即时、无需重启的：

```text
cordis_inspect_query { platform: "host", provider: "Config", method: "listConfigs", input: { name: "dsh-prompt-enhance" } }
plugin_manager { action: "list_plugins", offset: 100 }   # 找 include:prompt-enhance → fiberPhase: "active"
cordis_inspect_query { platform: "client", provider: "Slots", method: "listSubTree", input: { root: "conversation.input.left" } }
```

- 桌面端：关掉再打开 dsh 即重载；`plugin_manager { action: "remove_bundle", target: "dsh-prompt-enhance" }` 卸载。
- 卸载后按钮、路由、监听器都随 fiber 一起销毁（全部注册都挂在 `ctx.effect` 上）。

从本地 scratch 升级到 npm 包版本：把包发布或 `pnpm pack` 后，用同一 `install_bundle` 以包名/spec 安装，link 依赖即被替换。

## 配置

配置写在这个 plugin 行的 `config` 上（bundle 默认值在 `cordis.patch.yml`，用户可在 profile 的 `cordis.patch.yml` 里按 id 覆盖，升级不丢）：

```yaml
- id: prompt-enhance
  name: dsh-prompt-enhance
  config:
    timeoutMs: 20000
    maxInputLength: 4000
    maxOutputTokens: 1200
    temperature: 0.2
    enableButton: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | 省略 | 必须成对出现；省略则用组合里 `agentDefaultModel` 的当前选择 |
| `timeoutMs` | 20000 | 单次改写总预算 |
| `maxInputLength` | 4000 | 接受的输入字符数（按码点计） |
| `maxOutputTokens` | 1200 | 输出预算；被截断则整体失败、原始输入保留 |
| `temperature` | 0.2 | 采样温度；适度补全但限制自由扩写 |
| `enableButton` | true | 是否渲染按钮 |

**没有 API key / baseURL 字段，这是刻意的。** 模型地址与凭据属于组合里的 provider 行（例如 `@deepseek-ai/dsh-llm-pi-ai` 的 `apiKeyEnv`），本插件只通过官方 `ctx.llm` 服务调用，绝不接触、不转发、不记录凭据。

**也没有 `enableSkillFallback`。** 技能（`skill/SKILL.md`）不经过插件运行，插件没有任何代码路径去开关它；加一个不起作用的布尔值只会骗人。技能本身是常驻的保底能力，见下文。

## 优化模式与反馈

改写接口支持三个模式，默认是 `balanced`：

| 模式 | 行为 |
|---|---|
| `conservative` | 只修正语病、歧义、重复和结构，不补充新信息 |
| `balanced` | 补全原文暗示或完成任务必需的最小信息 |
| `task` | 允许更完整地任务化目标、背景、步骤、输出和验收条件，但不允许无关扩展 |

请求体可以附带：

```json
{
  "text": "原始需求",
  "mode": "balanced",
  "feedback": "不要新增部署步骤"
}
```

`feedback` 是可选的定向修正意见。它只在本次调用生效，插件不会保存用户反馈；普通按钮默认发送 `balanced` 且不附带反馈。

## 接口

Host 侧两条精确路由，都位于组合的 `connection` 信任围栏之后（Host/Origin 校验与浏览器认证先行）：

| 路由 | 方法 | 返回 |
|---|---|---|
| `/api/prompt-enhance/config` | GET | `{ enableButton, maxInputLength }`（纯策略，无路由、无 provider） |
| `/api/prompt-enhance/rewrite` | POST | `{ ok: true, result }` 或 `{ ok: false, error: { code, message } }` |

失败码：`INVALID_INPUT`、`INPUT_TOO_LONG`、`MODEL_NOT_CONFIGURED`、`MODEL_TIMEOUT`、`MODEL_FAILED`、`MODEL_TRUNCATED`、`EMPTY_RESULT`。

失败响应只含稳定 code 与产品文案：不含 API key、Authorization、完整请求 URL、内部堆栈、供应商原始错误、用户完整输入。日志只有 `code` 与耗时。

## 可用性

- 按钮只出现一次（slot 用固定 `id: prompt-enhance`；重载/换会话由 slot 注册表接管，不会叠加）；
- 空输入、超长输入禁用按钮并给出原因（Host 端同样校验）；
- 请求期间显示 loading 并阻止重复点击；
- 只有「完整成功且草稿未在此期间被改动」才回填；草稿被改动时提示「输入已变化，未回填」，不动用户内容；
- 不改变原有发送行为，不自动发送。

样式以 React 元素形式渲染在组件内，卸载即移除；不写 `document.body`，不碰其他插件 DOM。

## 测试

```powershell
cd "E:\deepseek harness work\prompt-enhance"
node --test        # 37 个用例
```

| 文件 | 覆盖 |
|---|---|
| `test/config.test.js` | 默认值、非法配置、对外策略不含 provider、码点计数、长度边界 |
| `test/rewrite.test.js` | 元提示与请求形状、成功、空/超长不调用、finish 各分支、空返回 |
| `test/fallback.test.js` | 超时、调用方取消、供应商报错不泄漏 key/URL/原文、失败永远没有 `result` |
| `test/host-route.test.js` | 真实 `apply()` 注册两条路由、405/400/413、信任围栏、日志只含 code |

测试不需要真实 key：`lib/rewrite.js` 的 `stream` 是注入的，用例用假 chunk 流驱动所有失败路径。

## 技能保底

`skill/SKILL.md` 同时安装到 `~/.dsh/skills/prompt-enhance/SKILL.md`。按钮不可用时，模型可据此手工完成同样的增强；它不是插件的替代品。

## 桌面版首发验收清单

当前首发目标是官方 DeepSeek Harness 桌面版（`desktop` profile），不是独立 CLI profile。发布前必须在桌面端完成以下检查：

1. 使用桌面端内置 `plugin_manager` 安装或更新本插件。
2. 完全退出桌面客户端，确认托盘进程也已退出，再重新打开。
3. 聊天输入框工具栏出现一次「增强提示词」按钮。
4. 使用固定测试词验证：
   - `帮我做一个网页。`
   - `把这份周报压缩成三条要点。`
   - `请说明如何将源码提供给他人进行检查和测试，包括需要准备的文件、运行环境、依赖安装方式、启动方法、运行和测试步骤，以及如何报告问题和反馈。`
   - `summarize this report`
   - `请检查这个项目为什么启动失败，并给出修复方案。`
5. 成功时只回填输入框，不自动发送。
6. 失败、超时、无模型或空结果时，原始输入保持不变。
7. 页面刷新、新建会话、插件重载后按钮不重复。
8. 卸载插件后按钮和两条 `/api/prompt-enhance/*` 路由消失。

## 版本与兼容性风险

- 依赖的官方接口：`ctx.webServer.register({ kind, path, handler })`、`ctx.connection.requestRejection(req)`、`ctx.llm.stream(GenerateOptions)`、`ctx.get('agentDefaultModel').currentSelection()`、客户端 `ctx.get('slots')` 的 `inject`/`register`、slot `conversation.input.left` 的标准 props `useInput`/`inputActions`、`window.__ModuleLoader__`。
- 风险点：`conversation.input.left` 是 dsh 的 composer 工具行 slot，键名与标准 props 属 Harness 版本相关；`ctx.llm.stream` 的 chunk 形状（`text-delta`、`finish.reason.kind`）同理。dsh 升级后若这些漂移，表现为按钮消失或改写失败（不会破坏用户输入）。
- 本包没有 DOM 降级实现：既然官方 slot 可用，就不引入选择器和 MutationObserver 这类版本敏感代码。
