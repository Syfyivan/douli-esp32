# 豆包「打电话」与豆梨语音陪伴：代码研究

研究日期：2026-10-16。结论：两者属于同一类连续语音交互产品。豆梨最值得借鉴的是对话节奏、可靠的双向状态管理与低延迟播放；现有记忆、设备接入和工具能力可以继续复用。

**本次实际研究了什么**

用户提供的 [morluto/rea](https://github.com/morluto/rea) 是逆向分析工具。本次使用本机 REA 6.5.0、经固定 SHA-256 校验的 JADX headless 0.7.1，定点分析了豆包官方安卓安装包中的通话模块，并阅读豆梨当前工作区代码。得到的是反编译表示，不是豆包原始工程源码；云端实现与模型权重不在本次可见范围内。[REA Android 分析说明](https://github.com/morluto/rea/blob/main/docs/android-analysis.md)

| 项目 | 本次证据 |
|---|---|
| 安装包来源 | [豆包官方下载页](https://www.doubao.com/download) 的移动端脚本指向 `https://doubao.zlinkurl.cn/o3F9`，该页面提供 APK 地址；下载路径保存于本地 `apk-source.txt` |
| 包名／版本 | `com.larus.nova`，`15.3.0`，versionCode `15030040`；来自解码后的原包 Manifest |
| 原包大小 | 416,796,335 字节 |
| 原包 SHA-256 | `bf4c82fd9dcdeb5923b6a24583647a40b503fe3284f264e7a49beb4e289d9919` |
| 分析工具 | REA 6.5.0；JADX headless 0.7.1；JDK 17.0.10；Node 24.19.0 |
| 代码范围 | 全部 40 个 DEX 的类名索引；重点分析 `classes19.dex` 音频状态／插件与 `classes26.dex` 通话界面／服务 |
| 定点结果 | 13 个类的结构、14 个方法的反编译结果；原始工具输出保存在仓库外 |
| 动态验证 | 未进行豆包真人通话、抓包、锁屏或音质测试；未调用豆包私有接口，未安装／改动豆包 App |

整包首次交给 REA 返回 `unreadable_output`，没有据此确定根因。随后制作两个仅供分析的子集 APK：各保留原始 Manifest、资源表和一个 DEX，所含条目字节不变，逐项记录哈希。子集没有原包签名，不能当作原版安装包；跨 DEX、JNI、反射和云端调用关系未全面追踪。静态代码存在也不能证明某个账号、音色或灰度分支正在使用它。

ProfilePilot 查询真实手机时连接超时，因此改从官网取得安装包，未切换到原生 ADB。本次临时文件最初在 C 盘，下载遇到空间不足后移至 `D:/codex-research/doubao-voice-20261016/`。研究脚本、安装包和反编译内容均放在该目录，没有加入项目源码。

**先分清两种证据**

- **客户端代码证据**：可以确认收听／播报状态、暂停恢复、字幕分发、超时任务、Android 服务等实现结构。
- **官方模型说明**：Seed 于 2026-04-09 说明 Seeduplex 已在豆包 App 上线，核心是同时听说、结合语音与语义动态判停、抑制无关声音造成的误响应。这些是官方公开的模型能力描述，不是本次从客户端反编译得到的算法，也没有在本机复测其宣传指标。[Seed 官方介绍](https://seed.bytedance.com/zh/blog/introducing-seed-full-duplex-speech-llm-attentive-listening-robust-interference-suppression-enabling-more-natural-interaction)

**值得借鉴的功能与优先级**

| 优先级 | 功能与用户收益 | 豆包证据 | 豆梨现状与建议 |
|---|---|---|---|
| P0 | 自然判停：停顿想事情时不抢话，真正说完能及时接话 | 官方说明其结合声音与语义判断轮次结束；客户端有 `QueryBegin`／`QueryEnd` 事件，但本次未得到产生这些事件的云端算法 | `UtteranceBuffer` 基于 RMS 与静音时长；默认 `silenceMs=850`，实际设置可覆盖。先加入真正的语音活动检测和流式识别，再做可撤销的判停；不能仅靠缩短静音阈值追求快 |
| P0 | 可靠插话：说“等一下／不是”能停，键盘声和自身回声不乱打断 | `CallDuplexReducer` 会在说话或思考时处理 `Interrupt`／`QueryBegin`；官方另说明意图与抗干扰能力 | 已有 `BargeInBuffer`、取消请求及清空播放；阈值之上累计 140ms 即可触发，不等于确认人声或对话意图。先真机验收 AEC，再分层判断人声、短确认和真正插话 |
| P0 | 更快出声：避免用户说完后长时间等第一句话 | 官方公开端到端语音路线；APK 同时保留 ASR、TTS、模型、RTC 会话配置，不能据此断言所有模式走同一链路 | 当前为识别→路由／检索→文字模型→按句 TTS；TTS 用 `arrayBuffer()` 等整段结果。先测首音延迟、接流式 TTS／ASR；另设原生实时语音实验入口做对照 |
| P1 | 暂停与继续：临时离开，不必结束整场对话 | `Pause`／`Resume` 为明确事件；下行暂停时保留此前状态，恢复时取回 | 浏览器已有打断／结束，尚无独立暂停恢复流程。区分麦克风静音、暂停播放、打断当前回复、结束会话；状态暂停是否真正停止采音须单独实现和验证 |
| P1 | 字幕随通话走：随时开关，插话后不会串到另一轮 | 字幕插件携带 `queryRound`、`questionId`，有中断回调；界面方法处理字幕开关和显示条件 | 已有识别文字、流式回答和句子事件。补齐轮次／段落标识、播放进度与已打断标记，避免把生成完毕误当作用户已经听完 |
| P1 | 手机像通话一样持续工作：切到后台仍能明确显示状态和结束入口 | Manifest 声明 `RealtimeCallRTCMicAndPlaybackService` 的 `microphone|mediaPlayback` 前台服务类型；销毁时调用 `stopForeground` | 当前 Android 后台是 `connectedDevice` 类型，服务于 ESP32 网关，手机麦克风来自 WebView。若要手机自身承担持续通话，需单独设计原生音频生命周期；现有网关保活不能当作锁屏收音证明 |
| 已有基础 | 跨次聊天记忆：记得偏好，允许用户改正或忘记 | 官方 FAQ 明确记忆可来自实时通话转写，并可通过对话删除 | 豆梨记忆 v2 已有语音记住／更正／忘记、确认、证据、历史版本和混合检索。继续复用，重点做真人跨日效果验收，无需另造一套 |
| P2 | 视频／屏幕共享：聊到眼前内容时提供视觉信息 | 包中存在相关组件；豆包官方隐私说明介绍通话中的屏幕共享 | 对床头 ESP32 陪伴优先级较低，先把纯语音做稳定；本次未验证这些界面的实际运行 |

记忆与屏幕共享信息分别来自[豆包记忆 FAQ](https://www.doubao.com/legal/memory_faq)和[豆包隐私政策](https://www.doubao.com/legal/privacy)。这里引用的是功能说明，不作法律解读。

**最值得借鉴的客户端实现：收听与播放分开管理**

`AVKitDuplexState` 同时保存 `upState` 与 `downState`。`CallDuplexReducer.a()`／`.b()` 的 Kotlin 元数据分别对应 `reduceUp`／`reduceDown`。本次观察到：

- 上行：连接完成进入收听；用户开始说话进入识别；一句结束返回收听；可暂停／恢复。
- 下行：一句结束进入思考；回复到达进入播报；播报或思考时收到用户插话返回等待。
- 下行暂停保留先前状态。恢复时先恢复该状态，没有先前状态则回到等待。
- `CurrentReplyPlayEnd` 只在事件关联状态对象与当前状态相同的时候生效，避免过期结束事件修改当前状态。
- 停止和错误分别有显式状态，不由 UI 字样推断。

以下是对代码结构的概括，不是原始代码，也不是全部状态图：

```mermaid
flowchart LR
    A[同一通话会话] --> B[上行：收听／识别／暂停]
    A --> C[下行：等待／思考／播报／暂停]
    B -->|开始说话或打断事件| C
    C --> D[当前回复的播放结束事件]
    D -->|核对所属回复后| C
```

豆梨 `gateway.mjs` 目前主要用一个 `state` 表示 listening／thinking／speaking，再在 thinking／speaking 时单独检测插话。这已能实现持续收音与可打断回复，不必推倒重写。建议逐步拆为连接状态、输入状态、输出状态；保留已有 `AbortController` 和 `generation` 隔离，同时把轮次标识扩展到客户端播放回调。

额外建议：记录生成文本与实际已播文本／时长，插话后的上下文根据已播放部分处理。**这是针对豆梨的设计建议**；本次没有证明豆包服务端如何截断被打断的历史上下文。拆状态也不能代替模型层的语义判停或全双工能力。

**为什么豆梨会等第一句话：从当前源码可见的等待点**

| 位置 | 本次读到的行为 | 建议 |
|---|---|---|
| `server/audio.mjs`：`UtteranceBuffer.push()` | 静音累计达到配置值才结束一句 | 配合流式识别判断停顿；保留轻声、短词与改口前导音 |
| `server/engine.mjs`：`routeRequest()` | 回答前进行路由；部分连续追问已有复用逻辑 | 按阶段测量后优化闲聊路径，保留复杂问题路由 |
| `server/gateway.mjs`：句子分段正则 | 主要在至少 8 字后的句号等边界，或 120 字后的逗号等边界交给 TTS | 为首段设计更短且语义完整的切分与最长等待时间，避免损害断句和韵律 |
| `server/providers.mjs`：`synthesize()` | 读取整段 PCM 完成后才返回 | 接入服务商真正的音频流并逐块播放；当前按句合成还不等于句内音频流式输出 |
| `web/voice.mjs`：`play()`／`finishPlayback()` | 客户端播放队列有自己的排空时间 | 首音、播完、被打断都应由播放端回报，不能用 LLM 首 token 或 TTS 完成代替 |

建议第一轮只增加不含原始音频和用户文本的时间点：用户最后语音、判停、识别完成、路由完成、首 token、首音频接收、实际首音播放、打断触发、实际停声。最终比较 P50／P95 和误打断率，而非只看一次最快耗时。以上没有本次真机测量值。

**是否直接接豆包实时语音**

值得做一个可切换的实验模式，比较同一设备、同一组说话样例上的效果。火山官方已有 Seeduplex 3.0 的公开 SDK 文档，描述双工 JSON 协议、采播控制与专用实时地址；它与较早版本的实时语音协议存在差异，实施时应按选定版本核对。[全双工 SDK 官方文档](https://docs.volcengine.com/docs/DoubaoVoice/end-to-end-full-duplex-ios-sdk-documentation?lang=zh)

建议由豆梨后端增加独立实时语音适配器，ESP32／浏览器保留现有接入方式；原 ASR→LLM→TTS 路径继续提供可选模型、工具和故障回退。不要把原生端到端语音当成可无条件搭配任意 DeepSeek 模型的 TTS 外壳。火山另有混合编排产品，但当前文档对其中 LLMConfig 的模型来源有限制，也不能自动视作 Seeduplex 3.0 的同等能力。[官方混合编排说明](https://docs.volcengine.com/docs/real_time_communication/Accessend-to-endreal-timespeechlargemodel?lang=zh)

需要先验证的集成点是记忆上下文注入、工具调用、打断后的上下文处理和长连接会话边界。ESP32 与本机后端保持连接，不代表云端语音会话必须常开；尤其床头场景应区分本地唤醒待机和已经开始的通话。官方 SDK 文档说明暂停录音可发送静音包保活，静音仍可能计费，不能把“静音”当成“结束云端会话”。

**建议实施顺序与真人验收**

1. 先记录延迟阶段并验收回声／打断，修好讲话开始、实际停声与旧音频迟到的处理。
2. 再做流式 ASR／TTS 和更自然的判停；用当前模型链路测出基线，同时独立试验原生全双工服务。
3. 补暂停继续、字幕开关与被打断状态；手机自身通话有需求时，再做原生后台采播。
4. 复用现有记忆和家居工具，做真实跨日对话与连续使用验收；视频与屏幕共享后置。

建议覆盖：中途犹豫 1–2 秒后续说、短促“不是”、播报时说“等一下”、仅说“嗯”、键盘声／咳嗽／电视背景、扬声器自身回声、连续两次打断、播报未结束时断网、暂停后继续。分别记录抢话、漏听首字、误打断、停声延迟、串轮和上下文错接。手机另测锁屏／蓝牙切换；ESP32 另测远场和长时间运行。模拟测试只能验证状态逻辑。

**证据定位**

仓库外证据目录：`D:/codex-research/doubao-voice-20261016/`。JSON 为 REA 原始结果，不适合当作文档通读；下列文件可复核主要结论。

| 结论 | 本地证据文件 |
|---|---|
| 原包身份、版本、服务声明 | `rea-slice19-package.json`；`apk-source.txt`；`slice19-provenance.json`；`slice26-provenance.json` |
| 同时维护上行与下行状态 | `class-AVKitDuplexState.json`；`method-CallDuplexReducer-a.json`；`method-CallDuplexReducer-b.json` |
| 暂停恢复、旧播放结束隔离 | `method-CallDuplexReducer-b.json` |
| 其他识别模式与状态事件 | `method-AutoStopAsrDuplexReducer-a.json`；`method-AutoStopAsrDuplexReducer-b.json`；`class-StateTriggerEvent.json` |
| 字幕轮次字段及中断 | `method-RealtimeCallSubtitlePlugin-Z2.json`；`method-RealtimeCallSubtitlePlugin-N2.json` |
| 字幕开关和界面条件 | `method-RealtimeSubtitleComponent-KR.json`；该方法含 JADX 类型推断警告，不据此宣称完整语义还原 |
| 首次连接超时检查任务 | `method-RealtimeCallConnectTimeoutPlugin-a3.json`；`method-RealtimeCallConnectTimeoutPlugin-Z2.json`；具体等待时长未追踪 |
| RTC／ASR／TTS 配置结构 | `method-RealtimeCallParam-toString.json`；只证明配置存在，不证明某一模式的实际服务端架构 |
| Android 前台音频服务 | Manifest 对应 service；`method-RealtimeCallRTCMicAndPlaybackService-onStartCommand.json`；`method-RealtimeCallRTCMicAndPlaybackService-onDestroy.json` |
| 全包类名及相关字符串定位 | `dex-classes.json`；`dex-voice-strings.json`；字符串本身不作为运行行为证明 |

豆梨对照入口：[音频判停与打断](../server/audio.mjs)、[语音网关](../server/gateway.mjs)、[服务商适配](../server/providers.mjs)、[浏览器采播](../web/voice.mjs)、[记忆 v2](MEMORY.md)、[Android Manifest](../android/app/src/main/AndroidManifest.xml)。

以上为研究阶段记录；该阶段只新增研究文档，没有修改业务代码、README、模型配置或运行中的服务，也未执行软件测试。用户随后要求实施全部可借鉴功能，后续实现、部署与待完成的真实验收统一记录于 [VOICE_UPGRADE.md](VOICE_UPGRADE.md)。
