# 豆梨：AI 使用与接手指南

这份文档给接手仓库的编码助手、运维助手和通过本地接口操作豆梨的 Agent 使用。先读根目录 [AGENTS.md](../AGENTS.md) 与用户当前要求；本指南是项目说明，不授予修改数据、调用付费服务或执行电脑任务的额外权限。

## 1. 产品与系统分工

豆梨的产品定位是 **ESP32 实体电子宠物**。面向使用者讲解时，从唤醒它、讲话、听回复和回到待机说起。对外使用小梨插画表示角色形象；硬件证据对应具体板型、固件和测试条件。

1. **实体宠物**使用带麦克风和扬声器的 ESP32-S3 板。板端处理本地唤醒、音频采集和播放；查看 [固件说明](FIRMWARE.md) 和 `server/gateway.mjs`。
2. **配套后台与管理端**运行在电脑或支持的 Android 手机上。`server/` 负责识别、对话、合成、工具与本地记忆；`web/` 用来配对、配置和查看资料，也可用于无板调试。
3. **外部 Agent**：通过 Orca CLI 接入的 Codex 会话，负责用户明确交办的电脑任务。豆梨不会因为 Agent 一轮结束就自动证明业务完成。
4. **官网**：`site/` 中的静态展示页面。它没有对话模型、私有数据库、录音功能或云端账户系统。官网上线不代表把豆梨后台迁移到云上。

## 2. 接手顺序

```sh
git status --short --branch
git log -5 --oneline
node --version
npm --version
```

检查是否存在未提交改动、运行中的实例和项目局部约定。不要假定本机路径、模型名称、密钥、设备在线状态与历史文档一致。不要直接输出 `.data/`、完整环境变量、设置内容、聊天记录或配对凭据。

- 正常开发需要 Node.js ≥ 22.13；依赖与命令以 `package.json` / 锁文件为准。
- `npm ci` 会重新安装依赖；依赖已满足且锁文件未变时，不必反复执行。
- 源码默认 `.data/`，验收必须改用新的隔离目录。
- 没有明确授权，不修改现有用户数据，不闪写硬件，不运行真实模型检查。

## 3. 启动与验证

普通用户的启动流程见 [README](../README.md)。AI 做隔离验收时使用新的 `.runtime/` 子目录和空闲端口，例如 PowerShell：

```powershell
$env:DOULI_DATA_DIR = Join-Path $PWD ('.runtime/ai-check-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$env:DOULI_PORT = '18788'
$env:DOULI_DEVICE_PORT = '18789'
$env:DOULI_DEVICE_HOST = '127.0.0.1'
npm run build
npm start
```

运行前检查端口是否空闲。该例为前台服务，停止使用 `Ctrl+C`。如需证明后台独立运行，另用 `Start-Process -WindowStyle Hidden` 或现有 detached 模式启动，记录确切 PID 与数据目录，启动 shell 退出后重新请求健康接口。不要用 `npm run stop` 停止临时隔离实例：该脚本读取的是默认启动器的 `.runtime/process.json`。

```sh
curl http://127.0.0.1:18788/api/health
```

预期 JSON 包含 `ok: true` 与 `name: "douli-esp32"`。健康接口成功只证明后台可响应；模型、音频、设备、界面交互仍需要对应证据。`server/index.mjs` 分别启动管理服务和设备服务；管理端仅监听回环地址。

验收完成后只停止本次记录并核对身份的进程，不停止用户桌面端、代理、其他 Agent 或其他开发服务。

### 验证一轮实体互动

从 [使用指南](USAGE.md) 的 ESP32 接入步骤开始。核对板型与固件，在私人局域网配对，记录设备页的连接状态。请实际操作者唤醒设备、发言、听到回复，再测试插话和结束待机。分别记录观察到的板端行为、后台事件及尚待验证的环节。浏览器试聊与 HTTP 健康检查只覆盖后台路径。

## 4. 如何使用本地接口

接口定义以 [server/app.mjs](../server/app.mjs) 及各功能的注册函数为准。管理接口依赖本机访问和来源校验，**不能作为无需鉴权的公网 API 暴露**。不要伪造跨站来源绕过保护。

多人物数据使用 `x-douli-person` 请求头；不带时使用默认档案。先确认用户要操作的档案，不猜 ID。查询会话或 `/api/state` 可能读取个人内容，任务不需要时优先使用健康接口。

### 进行一轮文字对话

用户已配置并授权使用模型时，向本机发送 `POST /api/chat`，JSON 请求体例如 `{"text":"你好，豆梨。"}`。接口会写入对话并可能调用外部服务。返回的是 `application/x-ndjson`：按换行逐条解析事件，不要把整个响应当成一个 JSON 对象。

- `session` 事件提供 `session.id`；继续同一轮上下文时在下一次请求中传 `{"sessionId":"实际读取的 ID","text":"继续讲。"}`。
- `delta.text` 是增量文本；收到 `done.message` 再认定本轮回复完成。HTTP 200 后仍可能出现 `type: "error"`；流中断且没有完成事件时，先查询原会话，不自动重复发送。
- 需要用户明确打断时，调用 `POST /api/sessions/:id/abort`，只作用于已确认的目标会话。事件种类见 [server/engine.mjs](../server/engine.mjs)，不要把 `tool` 事件等同于外部任务已验收。

### 生活记录示例

以下请求只适用于自己创建的隔离数据库。生产数据写入须有用户对相应操作的授权。

```http
POST /api/memory/diary
Content-Type: application/json

{"text":"虚构验收：去公园散步","kind":"event","occurredAt":"2026-11-05T09:00:00+08:00","topics":["exercise"]}
```

保存返回 `id`、`revision` 和标准化时间。继续修改用 `PUT /api/memory/diary/:id`，携带最新 `revision` 与完整编辑字段；删除用 `DELETE`，请求体为 `{"revision":1}`，版本必须来自实际读取结果。

| 接口 | 行为与注意事项 |
| --- | --- |
| `GET /api/memory/diary?q=&topic=exercise&kind=event&limit=30&offset=0` | 组合筛选；`from` 包含起点，`to` 不包含终点；主题与类型为单值。 |
| `GET /api/memory/episodes/:id/sources` | 追溯原始消息；移除条目后不可通过该入口读取。 |
| `PUT /api/memory/diary/:id` | 旧版本返回 409；重新读取并让用户决策，不盲目覆盖。 |
| `DELETE /api/memory/diary/:id` | 移除整理条目，保留来源原话；不等于删除全部资料。 |
| `GET /api/memory/status` | 查看索引状态，不证明语义效果。 |
| `POST /api/memory/maintenance` | 可能触发外部模型，不能当作无副作用的健康检查。 |

模型接口、电脑任务接口和设备动作可能产生费用或实际执行操作，先读相关模块和用户授权。不要用真实开关、真实语音或用户电脑任务做随意 smoke test。

## 5. 代码导航

| 要处理的问题 | 优先查看 | 回归入口 |
| --- | --- | --- |
| HTTP、权限、档案作用域 | `server/app.mjs`、`server/people.mjs`、`server/local-origin.mjs` | `integration`、`people`、`remote-access` |
| 对话流程、工具与上下文 | `server/engine.mjs`、`server/prompts.mjs`、`server/providers.mjs` | `core`、`prompts`、`providers` |
| ESP32 音频与打断 | `server/gateway.mjs`、`server/voice-state.mjs`、`server/streaming-playback.mjs` | `barge-in`、`voice-standby`、`audio-pacer` |
| 电脑端音频 | `web/voice.mjs`、`web/capture.js`、`web/native-voice.mjs` | `browser-voice`、`native-voice` |
| 记忆一致性、检索与后台 | `server/memory-turn.mjs`、`server/memory-schema.mjs`、`server/memory-search.mjs`、`server/memory-service.mjs` | `memory`、`incremental-memory` |
| 生活记录 | `server/diary.mjs`、`web/diary.jsx` | `diary`、`sync` |
| 电脑任务 | `server/computer-tasks.mjs`、`server/orca-client.mjs` | `computer-tasks` |
| 桌面进程与恢复 | `desktop/main.mjs`、`desktop/service.mjs`、`desktop/connection.mjs` | `desktop`、`desktop-connection` |
| 官网 | `site/`、`scripts/preview-site.mjs` | `npm run site:check`、浏览器验收 |

表中测试名对应 `tests/<name>.test.mjs`。按改动范围选择，不把不同模块的测试通过当作彼此的证据。

## 6. 必须保持的行为

- **来源与结论分开。** 助手回答不是用户事实；记录发生时间、录入时间和原话分别保存。
- **人工修改优先。** 人工修订或移除经历后，同一来源原话暂停自动经历重提取。来源原话被更正/删除时仍按依赖规则失效。
- **异步结果重新核对。** 模型返回后检查最新状态；被删除、更正或取消的数据不能因晚到响应恢复。向量索引每批发送前也检查待发送记录。
- **语义开关与配置生效。** 关闭检索、更换服务/模型/凭据后，旧索引任务不能继续发送后续批次或写回旧结果。已发送的数据无法撤回。
- **打断覆盖整条播放链。** 取消生成、合成与排队播放；服务端发送完毕不等于设备已经播放完毕。
- **任务提交不确定时不盲重试。** 追踪原任务与会话身份，区分已接受、本轮结束、目标完成和已验证。
- **普通资料与健康资料分开。** 健康私密输入不进入普通记忆提取，不向官网复制任何个人资料。
- **尊重已有数据与进程。** 不删除数据库、重置密钥、清理配对或结束外部服务来“修好”测试。

## 7. 验证与交付

```sh
node --test tests/diary.test.mjs tests/memory.test.mjs
npm test
npm run build
git diff --check
```

按修改内容调整第一行。只有官网/说明文档变化时，使用官网静态检查和实际浏览器检查；没有修改应用代码不必重复运行付费验收。项目没有独立 `lint` / `typecheck` 脚本，不编造执行结果。

真实模型、固件刷写、安装包和 Android 检查另行说明版本、设备和范围。文档中的旧测试数与历史实机记录有日期，不能当作当前全量验收。凭据由用户在本机配置，不通过聊天索取秘密。

提交只包含任务相关文件。遵守用户的提交信息协议；不要将日志、数据库、截图中的个人内容、生成的安装包或密钥提交。已有“只推代码”的偏好不等于允许发新安装包；官网部署与应用发布也是两件事。

交付应分别说明：修改文件、测试结果、本地提交、远端分支/哈希、官网部署地址、尚未验证的边界。若没有部署证据，只能报告本地完成。
