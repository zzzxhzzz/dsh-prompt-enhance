# 交接说明（给接手的本地 agent）

这是一份可直接运行的 DeepSeek Harness（dsh）插件源码包，**不是** Node 脚本 / MCP Server / 前端独立页面。请在动手前读完本文，尤其「坑」和「未验证」两节。

- 包名：`dsh-prompt-enhance`　版本：`0.1.0`　许可：MIT
- 功能：在 dsh 聊天输入区加「增强提示词」按钮，点一下用一次轻量 LLM 调用把原始需求改写成更可执行的提示词并回填；失败/超时/空返回/无模型时**原样保留用户输入**，从不自动发送。
- 已验证环境：dsh `0.2.1-rc.2`、Node `v24.18.0`、pnpm `11.28.5`、Windows、profile `desktop`（Electron 托管）。

## 目录结构

```
prompt-enhance/
├─ package.json          # dsh.bundle.patch + dsh.client（平台/包级依赖）
├─ cordis.patch.yml      # 插入 prompt-enhance 行 + 默认 config
├─ lib/
│  ├─ index.js           # host 入口：name / inject / apply + 两条 /api 路由
│  ├─ rewrite.js         # 改写核心：超时、错误码、脱敏、信封
│  ├─ config.js          # 配置校验与默认值（严格：未知键抛错）
│  ├─ prompt.js          # META_PROMPT 元提示 + GenerateOptions 封装
│  └─ client.js          # 浏览器包（__ModuleLoader__ 懒工厂，只 require('react')）
├─ test/                 # node:test，36 个用例，无需依赖、无需密钥
├─ skill/SKILL.md        # 技能保底（手工完成同样的增强）
├─ README.md / LICENSE
└─ HANDOFF.md            # 本文
```

## 一、3 分钟自检（不需要 dsh、不需要密钥、不需要装依赖）

```powershell
cd prompt-enhance
node --test                                   # 期望：tests 36 / pass 36 / fail 0
node --check lib/index.js; node --check lib/client.js
```

测试是一个自足的证据链：配置校验、元提示形状、成功/空/超长、finish 各分支、超时、调用方取消、供应商报错不泄漏 key/URL/原文、`apply()` 真实注册两条路由、405/400/413、信任围栏前置拒绝、日志只含 code、effect 释放后路由被移除。

## 二、装进 dsh（在你自己的机器上）

1. 找到本机 profile 目录：`$env:DSH_PROFILE_DIR`（无则 `~/.dsh/profiles/<name>`）。
2. **不要**手改 profile 的 `package.json` 或 `cordis.patch.yml`，也不要跑 pnpm —— 用官方安装入口：

   ```text
   plugin_manager { action: "install_bundle", target: "<你解压后的绝对路径>/prompt-enhance" }
   ```

   - 期望返回 `"application": "applied"`；`warnings` 必须为空。
   - 这会把依赖写成 `link:<你的路径>` 并追加进 `dsh.profile.bundles`。
3. 站点检查（都无需重启）：

   ```text
   plugin_manager { action:"list_plugins", offset:100 }                       # 找 include:prompt-enhance → fiberPhase:"active"
   cordis_inspect_query { host, Config, listConfigs, { name:"dsh-prompt-enhance" } }   # 有 entry 即补丁已生效
   cordis_inspect_query { client, Slots, listSubTree, { root:"conversation.input.left" } }
                                                                    # occupants 应恰为 1 条：id "prompt-enhance", order 30
   ```
4. 页面打开任一会话，输入框左侧工具行应出现按钮；空输入时禁用。

## 三、坑（都是实测过的，不是猜测）

| 现象 | 原因 | 正确做法 |
|---|---|---|
| `dsh --profile <desktop> --dump-config` 报 `managed exclusively by the Electron application` | 桌面 profile 由 Electron 独占管理 | 托管 profile 用上面三条 inspect 检查；`--dump-config` 只对自建 profile 有效 |
| `curl http://127.0.0.1:<port>/api/prompt-enhance/config` 一律 401（连 `/` 也 401） | GUI 全站需页面令牌；`connection.requestRejection` 会先拒绝未认证请求 | 别用 curl 判定路由是否注册；用 `list_plugins` 的 `fiberPhase` 判断 |
| `Config.listConfigs` 对该行显示 `status: "absent"` | 本插件**没有**导出 `Config`（避免引入 schemastery 依赖），配置在 `apply` 里手工严格校验 | 属预期，不是缺陷 |
| 改了 `lib/client.js` 页面没变 | 客户端是手写 JS 直接服务，替换已安装包需要新的模块代 | 重启 dsh 进程 |
| 链接安装后源码目录被移动/删除 | profile 里是 `link:` 指向绝对路径 | 先 `remove_bundle` 再搬；或从新路径重新 `install_bundle` |

## 四、配置

写在行 `config`（默认值见 `cordis.patch.yml`，用户侧可在 profile 的 `cordis.patch.yml` 按 id 覆盖）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | 省略 | 必须成对；省略则用组合里 `agentDefaultModel` 的当前选择 |
| `timeoutMs` | 20000 | 单次改写预算 |
| `maxInputLength` | 4000 | 按码点计的输入上限（Host 与 Client 一致） |
| `maxOutputTokens` | 1200 | 输出预算；被截断则整体失败、保留原文 |
| `temperature` | 0.3 | 采样温度 |
| `enableButton` | true | 是否渲染按钮 |

**没有** `baseURL` / `apiKey` / `enableSkillFallback`，这是刻意的：

- 模型地址与凭据属于 provider 行（如 `@deepseek-ai/dsh-llm-pi-ai` 的 `apiKeyEnv`），插件只走官方 `ctx.llm`，不接触、不转发、不记录凭据；
- 技能不经过插件运行，没有任何代码路径可以开关它，加一个布尔值只会骗人。

## 五、已知未验证（接手方最该先补的）

1. **浏览器里真实点击一次** → 模型 → 回填的端到端回合（原开发环境无浏览器控制，且 `/api` 无法从外部绕过认证）。
2. 页面刷新 / 新建会话 / 插件重载后"仍只有一个按钮"的目视确认（机制上是固定 slot id + fiber 归属）。
3. `remove_bundle` → 重装的往返（清理语义已被 disposer 单测覆盖）。
4. dsh 重启后加载（重启会杀掉会话宿主进程）。

## 六、兼容性风险

- `conversation.input.left` 键名与标准 props `useInput` / `inputActions` 版本相关；漂移表现为按钮消失或点击无效，**不会破坏用户输入**。
- `ctx.llm.stream` 的 chunk 契约（`text-delta`、`finish.reason.kind`）：未知 finish kind 已按失败处理。
- `webServer.register({kind:'exact'})` 与 `connection.requestRejection` 的返回约定版本相关。
- 无 DOM 降级实现：官方 slot 可用时不引入选择器 / MutationObserver。

## 七、改代码时请守住的三条线

1. **三种 inject 不要混**：`dsh.client.inject`（客户端包级依赖，只排序激活）／`client.js` 工厂的 `inject: ['slots']`（客户端运行时服务）／`index.js` 的 `export const inject`（host 端 Cordis 服务）。
2. **失败路径只能上报，不能写草稿**：`runRewrite` 返回 `{ ok:false }` 时客户端不得调用 `setDraft`；成功回填前还要比对发出时的文本，用户中途改过就不覆盖。
3. **敏感信息不出 host**：错误信封只允许 `{ code, message }`（产品文案）；日志只允许 code 与耗时。改完跑 `node --test`，泄漏用例会拦你。

## 八、安全与交付

- 包内**不含**任何密钥、Authorization、真实 profile、会话日志；模型调用复用宿主已配置的 provider。
- 不要把 `~/.dsh` 目录、`.credentials.yaml`、profile 的 `package.json` 一起转交。
