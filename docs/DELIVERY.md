# 四阶段开发与验收清单

2026-10-15：软件主流程已实现并启动，助手为「豆梨」，微雪设备为「豆梨床头音箱」。本轮已备份整片 Flash、修复损坏资源、升级官方小智 2.5.2，并配置「你好豆梨」本地唤醒。**用户已确认免按键唤醒并听到回复**；串口记录实际唤醒、连接、识别、播放和恢复收听，后台对应消息完成。激活接口改为无正文响应后，连续 4 次真机重新激活均正常进入待机，没有崩溃或软件重启。**整体目标尚未标为完成**：回声、打断、长期稳定性仍待验证；手指机器人型号未知。

| 阶段 | 已实现与验证 | 待验收 |
|---|---|---|
| 设备与语音 | 独立仓库、Orca 注册、Windows 独立进程；OTA 服务发现、批准/撤销、WebSocket、Opus v1/v2/v3、MCP；微雪板首次真人按键语音通过；整片备份、2.5.2 固件、「你好豆梨」真人免按键唤醒并回复通过；激活兼容修复后 4 次真机复测通过 | 回声、打断、长时间稳定性；macOS 实机 |
| 参考 Typeless 的输入 | 研究报告已读取；PCM/WAV、重采样、RMS 断句、短句、上下文、词典与纠错；原文保留、否定/数字保护；通用桥接的分片与 HTTP 回退测试 | 轻声、噪声、中英混合、改口录音；具体厂商原生实时 ASR 接入 |
| 陪伴与记忆 | 人设、表达、夜间设置；偏好优先、来源记忆、建议确认、冲突、修改、固定、删除；聊天搜索/导出/删除；五种场景、语义分类与快/强模型选择；持久化与模型请求上下文测试 | 真人连续使用与跨日记忆效果；联网搜索真实验证（尚无 Brave Key） |
| 界面与家居 | 五个页面真实 Chrome DOM 检查；模型配置、密钥脱敏、试听；HTTP/HA/MCP 动作；HA 传感器轮询；授权上报、时间/阈值规则、冷却与复位 | 手指机器人真实 API、上下按压、安装力度、续航、灯状态；真实 HA/传感器；可视截图 |

## 本轮证据

- 首次真机接入：已核对设备编号与串口的 STA MAC 一致并批准。用户短按 BOOT 后确认「灯光有变化，听到回复了」，后台至少三轮用户/助手消息为 complete。旧固件首次按键验收记录为 `.runtime/hardware-voice-acceptance.json`；不能将此当作升级后的真人验收。具体设备编号仅保存在本地记录中。
- 唤醒修复：读回 Flash 发现原 assets 分区开头是固件镜像头，资源索引和模型无法加载。已先备份完整 16 MB Flash，再仅写入官方 2.5.2 应用分区和重建的资源分区，保留 Wi-Fi、OTA 地址等配置。新资源包含 MultiNet7 中文模型及必需的 FST 命令文件，串口确认 `CustomWakeWord` 加载 `ni hao dou li / 你好豆梨`，检测器为 MultiNet。首次自定义打包漏了 FST，已补齐并重新验证，最终启动正常。实际人声检出率和误唤醒率仍待测。
- 激活异常：旧固件能复现激活成功后崩溃；单独升到 2.5.2 后仍复现过一次，因此升级本身不足以解决。检查固件只读取激活 HTTP 状态码，本机 `/xiaozhi/ota/activate` 现返回 200/202、零长度正文及 `Connection: close`，减少连接销毁时未读正文的影响。修复后连续 4 次撤销批准、重启、重新批准的真机检查均激活成功、进入 idle、加载唤醒模型，无 panic/软件重启；这是本次复测结果，不是长期稳定性保证。证据为 `.runtime/firmware-repair/activation-bodyless-run1.json` 至 `run4.json` 及同名日志。
- 原机备份：完整 Flash 备份及 SHA-256 校验清单保存在 `.data/device-backups/`。资源构建脚本、下载校验、写入和启动日志在 `.runtime/firmware-repair/`；本地备份含配网信息，不纳入 Git。
- 升级后真人验收：用户按要求不按 BOOT，说「你好豆梨」再提问，并确认「成功唤醒并回复」。串口 `.runtime/firmware-repair/wake-human-test.log` 记录 `Custom wake word detected`、`idle -> connecting -> listening`、用户识别文字及助手播放，完成后回到 listening；后台 2026-10-15T03:31:18Z 的用户/助手消息均 complete。说明本次实际唤醒及收音→模型→喇叭链路通过，未据此推断远场、噪声、误唤醒或长期稳定性。
- `npm test`：24/24 通过；测试使用隔离数据库和模拟设备，没有操作真实家居。覆盖首次激活轮询、等待静音过滤、快速结束时的流式握手、旧连接取消隔离、MCP 分页、记忆去重和单轮动作去重。本轮新增模型流报错后的语音取消与恢复、空识别结果恢复、设备配置实际影响转写/模型/输出及重连保留、浏览器告别播放排空。
- `npm run build`：通过。lucide 的 `use client` 提示不影响这个纯客户端应用。
- 独立进程：本轮激活接口修复后，启动终端退出后仍运行且健康，监听管理 127.0.0.1:8788 和设备 0.0.0.0:8789。实际 PID 以本地 `.runtime/process.json` 为准。
- 已配置真实硅基流动模型：`Qwen/Qwen3.5-122B-A10B`、`Qwen/Qwen3-ASR-1.7B`、`FunAudioLLM/CosyVoice2-0.5B`，共用用户授权的 Key。
- 短录音检查：合成 545 ms、转写 344 ms、音频 3.36 秒。本轮更新后的完整 WebSocket 检查：识别 1473 ms，返回 5.08 秒音频，正确转写「你好，请用一句话介绍一下你自己。」。是合成录音和单次测量，不是用户麦克风验收或延迟保证。
- 免费 SenseVoice 连续两次 25 秒超时，已换成 Qwen3-ASR。专名曾被识别错误，仍需真人试用和词典确认。
- 实际试聊发现过未接入设备时模型描述传感器/环境的情况；已移除空传感器工具、加强事实约束，工具原始结果独立展示。最后自我介绍检查未再出现，但不能保证模型没有其他幻觉。
- 浏览器五个页面可访问，真实文字发送成功。当前 Chrome 麦克风权限为 `prompt`，已请用户直接点击并授权。
- 本轮通过 ProfilePilot 成功获取并查看刷新后的聊天页截图 `.runtime/audit-ui-current.png`，1920×869 下布局可用；其余页面截图仍间歇返回 `NATIVE_RENDER_UNAVAILABLE`。当前版本的助手、记忆、设备页 DOM 已检查；随后工具返回 `NATIVE_USER_IN_CONTROL`，已停止浏览器操作，没有自动恢复或切换控制通道。
- 本地 Key 泄漏检查：Git 可纳入的源文件中未发现用户 Key；`.data`、`.runtime` 忽略于 Git。
- 本地证据：`.runtime/model-check.json`、`voice-roundtrip.json`、`asr-comparison.json`。
- 真实记忆检查使用隔离临时数据库：模型从测试自述提取两条有原话证据的建议，确认后关闭/重开数据库，在新会话正确回答「你不吃香菜」。记录在 `.runtime/memory-check.json`，测试资料未写入用户数据库；这仍不等于真人跨日效果验收。
- 本轮修复：等待说话时不上传长段静音；保留开始说话前的短音频；纠正原话后，依赖该原话的固定记忆也转为待复核；重复提取同一事实不增加重复建议。明确偏好可以直接修改。
- 对照官方固件 `ota.cc` 和 `application.cc` 补齐激活 challenge 与 `/activate` 轮询，管理页显示设备配对码。激活接口无正文行为及 OTA 更新固件版本号有回归测试，完整 `npm test` 24/24 通过；真机激活另有上述 4 次复测。家居动作去重仍只有软件验收。
- 设备页新增每台 ESP32 独立的对话模式、音量、收音阈值，保存在设备资料中，重新连接生效。协议测试证明弱声音被该设备阈值过滤、指定模型被调用、零音量输出静音、配置及原会话均在重连后保留；不是实际麦克风调参结论。
- 浏览器告别测试使用模拟 WebAudio 和麦克风：确认收到告别后立即释放录音、等待队列末尾再关闭播放。真实扬声器验收仍待用户试聊。
- 智能路由现由 `Qwen/Qwen3.5-4B` 结合上下文分类，再由程序选择模型；五种场景含新增知识学习，支持手动覆盖、连续追问、换话题、低把握与超时回退。日常使用 `Qwen/Qwen3.5-35B-A3B`，质量档使用 `deepseek-ai/DeepSeek-V4-Pro` 并请求思考。原日常 122B 在完整对话和独立请求中连续超时，已改为经真实请求验证可响应的 35B，原配置有本地加密备份。
- 新版真实检查见 `.runtime/routing-check.json`：12 个分类样例符合预期；隔离数据库中的学习→追问→日常三轮均完成，前两轮调用 DeepSeek、最后一轮调用 Qwen，约 7.8、6.6、2.2 秒完成。样例不是医学、法律或整体模型质量认证，也不是延迟保证。自动化测试 45/45 通过，包含 HTTP/语音通道共享路由、真实返回模型名称的记录、已遗忘历史排除、无搜索配置及检索失败提示；语音与搜索部分采用模拟服务，不代表本轮硬件或真实搜索验收。
- 经用户指定释放默认 Chrome Profile 后，在独立 Profile `9224` 通过 ProfilePilot 验证路由设置保存、分类/强模型配置、真实学习回答与连续追问；一次分类在 6 秒超时后仍由强模型完成，页面显示超时原因，下一轮明确追问跳过分类并沿用强模型。截图 `.runtime/routing-settings.png`、`.runtime/routing-chat.png`，记录 `.runtime/routing-ui-check.json`；测试会话已删除。重新独立启动后台并在启动终端退出后确认健康接口正常、三档模型及路由设置保留。
- 样例曾出现虚构听到呼吸、无证据推断争论源于记忆偏差、简短模式偏长；已增加感知边界、证据不足时不判断动机、简短回复要求。复核仍有未经请求的建议和泛化陪伴表达，因此保留真人风格验收，未宣称消除幻觉。

## 实现边界

- OTA 只做服务发现，不分发固件镜像。本次通过 COM3 USB 刷入官方小智 2.5.2 和自定义唤醒资源；设备配对适用于可信私人局域网，未做硬件密码学身份认证。通用固件仍会探测本板没有的摄像头并打印相关错误，不代表具备摄像功能。
- 当前为整句 HTTP 识别、流式文字、按句语音合成。RMS 断句不是神经网络 VAD，通用流式桥接不等于已经兼容所有厂商实时协议。
- 记忆使用本地关键词/中文片段检索。自动提取只是建议，确认后才参与回答；删除会清除内容，仅保留摘要指纹避免同一内容反复自动建议。
- HA 测试使用模拟服务。实际机器人、实体状态和声音质量需要对应硬件/真人验收。
- Windows 真机已验证；macOS 仅实现平台分支，尚未实际运行。

下一步：验收回声、打断和长时间连续语音 → 确定机器人型号再做家居验收。使用方法见 [USAGE.md](USAGE.md)。

## 等待外部条件的核对

2026-10-15 最新运行状态：服务健康，1 台微雪设备已批准，固件 2.5.2、唤醒资源正常加载；待机时没有 WebSocket 会话属于固件正常行为，唤醒后才建立连接。动作、传感器、自动化规则均为 0。浏览器麦克风权限仍为 `prompt`，板端语音不依赖此权限。

- 电脑实际麦克风、扬声器、轻声、噪声、改口和连续陪伴：需要用户首次授权并实际说话，以及提供体验反馈。
- ESP32：COM3、Wi-Fi、OTA、设备批准、按键语音及升级后真人免按键唤醒/回复已完成。资源与激活兼容修复完成；回声、打断、断线恢复与长期稳定性仍需专项验收。旧日志在 `.runtime/esp32-COM3-*.log`，本次备份、刷写和复测在 `.runtime/firmware-repair/`。
- 手指机器人、开关按压与状态、传感器：需要具体型号、开放接口和实物，当前没有可验收设备。
- 真正跨日记忆效果：需实际使用后验收；隔离数据库重新打开的测试仅证明持久化和本次召回。
- 可选联网搜索尚无 Brave Key，具体厂商原生实时识别协议未实现；现用整句 HTTP 识别和通用流式桥接，不能把它们称为原生端到端实时语音。

四阶段整体不标为完成；服务保持运行。收到试聊反馈、硬件或具体接口信息后继续对应待办，不重做已通过的检查。

## 原始验收清单（保留未完成项，避免把软件测试算成整体完成）

Goal: implement all four agreed stages for a personal bedside voice companion. A checkmark requires evidence, not a placeholder UI or mock-only claim.

## Stage 1: device and voice
- [ ] Independent repository, Orca registration, detached start/stop, Windows/macOS paths.
- [ ] ESP32 OTA discovery, explicit device approval, WebSocket handshake, audio v1/v2/v3, reconnect, per-device configuration.
- [ ] ASR → LLM → TTS → Opus playback; continuous conversation, interruption, wake greeting, farewell and faults.
- [x] Actual Waveshare ESP32 basic end-to-end acceptance: button-initiated speech and, after repair, human-confirmed hands-free wake and spoken reply. Extended stability/echo/interruption remain separate pending checks.

## Stage 2: Typeless-inspired input
- [x] Consume completed research and distinguish evidence from inference.
- [ ] Mono PCM/WAV capture, chunking, silence detection, context, streaming/HTTP recovery and latency diagnostics.
- [x] Personal vocabulary, editable raw/refined text, correction suggestions; preserve negation, hesitation and short utterances in companion mode.
- [ ] Chinese, mixed language, soft voice, noise and self-correction recordings compared with real ASR.

## Stage 3: companion
- [x] Persona, name, tone, brevity, humor, avoid rules, nighttime preferences.
- [x] Explicit preferences independent of generated memories; source-linked memories, search, update/conflict resolution, pin, correction, deletion.
- [x] Searchable/exportable/deletable sessions and optional audio retention.
- [ ] Daily/learning/reasoning/health/debate routing, manual override, grounded tools, honest uncertainty. Routing and model selection are implemented and live-tested; real search and answer-quality acceptance remain pending.
- [ ] Real next-day memory and model response evaluation.

## Stage 4: personal UI and home
- [ ] Chat/assistant/memory/devices/settings interface, local account-free management, browser microphone and playback.
- [ ] Actual finger robot integration, separate on/off action, acknowledged vs verified state distinguished.
- [x] Authenticated sensor ingestion, Home Assistant sensors/actions, time/sensor automation and manual disable (software tested with isolated services; actual hardware pending).
- [ ] Actual rocker switch and sensor acceptance (requires purchased device details/hardware).

Credentials are configured by the user in local Settings. A missing credential is a visible unconfigured state, never simulated conversation. No hardware or model-quality check is complete until exercised on the actual target.
