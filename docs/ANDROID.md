# 豆梨 Android

目标：手机独立运行核心服务，电脑关机后仍可为 ESP32 提供服务；最终支持自动选择在线的手机/电脑，并同步记忆和聊天记录。

## 当前交付边界

2026-10-16：Android App 已在 realme RMX3700 安装并启动，包含本地 Node 运行库、SQLite、Opus 和管理界面。原生服务运行在单独进程，提供启动/停止、常驻通知、后台设置入口和运行诊断。管理接口监听手机回环地址 8788，设备服务监听 8789。手机最后确认安装的 0.3.2 仅在界面前台录音；新构建的 0.4.0 增加独立原生后台通话和屏幕共享，尚待覆盖安装与真机验收，详见 [VOICE_UPGRADE.md](VOICE_UPGRADE.md)。ESP32 服务独立运行。

用户已确认新版记忆模块完成。现在已接入加密同步、共享局域网名称与主机选举，以及个人健康档案、报告识别核对和医学依据检索。详见 [SYNC.md](SYNC.md) 与 [HEALTH.md](HEALTH.md)。0.3.2 与固件 2.5.2.3 已完成这台 realme 和 ESP32 的实际后台切换，范围与记录见 [BACKEND_SELECTION.md](BACKEND_SELECTION.md)、[FIRMWARE.md](FIRMWARE.md)。

当前检查：Android `assembleDebug` 和 `lintDebug` 通过；移动平台地址/停止鉴权测试通过；Windows 上用隔离数据库启动移动入口，启动 shell 退出后健康检查和两个端口均正常，随后通过授权接口停止。另已完成 realme ARM64 真机启动、前台访问、返回桌面后一分钟联网、健康草稿跨服务重启保存，以及 ESP32 双向切换、电脑服务停止后的自动接手和板子重启接手。锁屏持续运行和手机实际模型语音质量仍需单独验证。

## 安装与使用

安装包：`android/app/build/outputs/apk/debug/app-debug.apk`，版本 0.4.0（versionCode 6）。此包已构建，尚未覆盖安装到手机；手机最后确认安装版本仍为 0.3.2。当前包针对 ARM64 手机，最低 Android 8（API 26），目标 API 35；未宣称所有这些版本均经过实机验证。使用开发签名，仅用于本机开发与用户试用。

1. 安装并打开「豆梨」，点击「启动服务」。由用户处理系统通知/麦克风权限弹窗。
2. 手机、电脑与 ESP32 接入同一私人 Wi-Fi。在「设备与家居」从电脑生成一次性配对信息，粘贴到手机，首次同步采用电脑模型和助手配置。
3. 在「设备与家居」查看共享 OTA 名称，按 [SYNC.md](SYNC.md) 配置 ESP32。需要保持至少一端服务运行和联网。家庭热点模式尚未验证。
4. 常驻通知可停止服务。右上角更多菜单提供运行诊断、刷新和系统后台设置入口。realme RMX3700 的入口为「后台设置 → 耗电管理 → 允许完全后台行为」，系统授权由用户确认；关闭时本次实测出现返回桌面后局域网请求超时，回到 App 后恢复的情况。其他系统或厂商省电策略仍需单独核对。

当前 APK 不含用户 API Key、聊天、音频或设备凭据。配置和数据库保存在应用私有目录，禁止系统云备份/设备迁移。不要卸载后重装来修复运行问题，这会清空应用数据；更新使用同一签名覆盖安装。

## 构建

需要 Node 22.13+、JDK 17、Android SDK 37.0、NDK 29.0.14206865。Gradle Wrapper 为 9.4.1，Android Gradle Plugin 为 9.2.1。

在 `android/local.properties` 配置 SDK，例如 `sdk.dir=C\:/Users/你的用户名/AppData/Local/Android/Sdk`。该文件忽略于 Git。

```powershell
npm ci
npm run android:prepare
.\android\gradlew.bat -p android :app:assembleDebug :app:lintDebug
```

准备脚本只打包明确列出的服务源码、编译后的网页、生产依赖和许可。前端 React/Lucide 已编译进网页，不重复打包其原始依赖。`.data`、设备备份、`.runtime`、本地密钥均不会进入 APK。修改核心代码后必须重新 prepare 和构建。

```powershell
node --test tests/mobile-platform.test.mjs
node scripts/check-mobile-host.mjs --launch
# 上一个启动 shell 退出后，在新的 shell 中执行：
node scripts/check-mobile-host.mjs --verify
```

主机检查使用 18888/18889 和 `.runtime/android/host-smoke`，不修改正在运行的电脑服务或用户数据库。

## 原生运行库与许可

使用 [fogtape/nodejs-mobile v24.22.0-0 full](https://github.com/fogtape/nodejs-mobile/releases/tag/v24.22.0-0)。这是第三方维护的 **预发布移动构建**，基于 Node.js 提案快照 a5d0eb95dd03b90986ad1a7c0cd3f2de1a0f383c，并非 Node.js 官方发布的 Android 运行时。选择 full 是因为本项目需要 SQLite 与 WebAssembly；后续更新必须重新做手机测试。

Android ZIP SHA-256：`9b068f4ad4c755f26c04b31883c536f037a4831e6575847a699cdf5fa72dde25`。准备脚本下载后校验。完整上游许可保存于 `licenses/nodejs-mobile-LICENSE.txt`，来源为该版本的 LICENSE，并随 APK 打包。Gradle Wrapper 保留标准 Apache 2.0 文件头和分发校验值；其余依赖保留各自的许可文件。

后台服务采用 Android 的 [connectedDevice 前台服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device)。这符合通过网络与外部设备交互的用途，不保证所有厂商系统在任意省电状态下都不终止服务。

## 实机进度

2026-10-15 新版 `assembleDebug`、`lintDebug` 通过，完整 Node 测试 62/62 通过。通过 ProfilePilot USB 连接 realme RMX3700 并提交安装，遇到 realme「安装增强防护」，手机提示先进行深度扫描；已请用户处理系统确认。最初提交的包显示 0.2.0，等待期间补齐 PDF 资源和导航/记忆同步修复，最终包为 0.3.0，尚待覆盖安装。此时不能声称 App 已成功安装或已在手机运行。

2026-10-16：通过 ProfilePilot 确认 realme 上的 0.2.0 已安装，随后成功覆盖安装 0.3.0（55,326,063 字节，SHA-256 `61515fda644b2695b4345b7dbe3a8c3e80499c03c128c5eccd02b131a117892e`）。该次构建与 lint、APK 签名校验通过；构建前 Node 测试 73/73 通过，包含新增语音待机行为。APK 内容与打包时的源码快照一致，不含用户资料。打包后另一个会话继续修改 `app.mjs`、`gateway.mjs` 并新增 `local-origin.mjs`；这些后续改动尚待完成后重新测试、打包并安装。

用户完成通知授权后，0.3.0 在 realme 上成功运行 ARM64 Node v24.22.0，管理页面与设备 HTTP 接口均可访问。真机发现 Android 同时返回 VPN 的 `172.19.0.1` 和家庭 Wi-Fi 地址，VPN 也会携带 Wi-Fi transport；原生地址采集改为显式排除 VPN，并监听 capabilities 变化。依据 Android [NetworkCapabilities 文档](https://developer.android.com/reference/android/net/NetworkCapabilities#NET_CAPABILITY_NOT_VPN)。

0.3.1 原生修复包构建与 lint 通过并覆盖安装，SHA-256 `aa61c6a3b4b4dffa8652e439e0e967f414cd0e89959aae7e8e7730223e243bc0`。保留之前已测试的服务源码快照，未提前合入另一个会话的后续改动。真机再次启动成功，诊断确认网络地址仅剩实际 Wi-Fi。此前返回桌面后的七次局域网请求均超时，重新打开 App 后立即恢复；用户开启「允许完全后台行为」后，返回桌面连续一分钟的七次 OTA HTTP 请求全部返回 200，耗时 10–101ms。该结果不代表锁屏、深度休眠或长期运行已通过。

在手机界面创建明确标记的软件验收报告草稿，停止并重新启动原生服务，再打开报告页确认草稿仍保留，随后通过界面删除并核对不存在。没有发送给模型，没有把测试内容写入已确认病史。

ESP32 USB 串口现已连接，重启日志确认 2.5.2、MultiNet 与「你好豆梨」唤醒资源加载正常。另行备份了分区表和 NVS，并离线验证只替换 OTA 地址可保持其余字节一致，尚未写入共享地址。

后续在另一会话完成服务代码改动后统一构建，验证双向聊天/记忆/健康原件同步、锁屏服务、ESP32 的实际 mDNS 解析与电脑离线后的接手，不能以模拟协议测试替代。

### 2026-10-16 后续交付：0.3.2

已备份手机私有数据与电脑数据，更新 0.3.2（versionCode 4），APK SHA-256 `b3f9fde49ad71ca3bbc4931121d5170cc3803bc654f366030227045cbd933225`。C 盘空间不足后仅清理本项目生成的 Android 中间文件，最终在 D 盘独立构建目录完成 `assembleDebug` 和 `lintDebug`，并把最终 APK 复制回上述标准输出路径。

通过 ProfilePilot 安装，保留现有数据。手机启动服务后与电脑完成真实配对和首轮同步，手机页面可见同步后的设备与记录。固件 2.5.2.3 已验证双向切换、固定手机重启保留、电脑服务停止后的自动接手，以及电脑服务关闭时板子重启接手。手机真实页面的选择器和应用按钮也完成一次切回电脑，页面确认已生效。结束手机控制会话后，手机服务仍可响应。具体时序与局限见 [FIRMWARE.md](FIRMWARE.md)；`.local` 现场解析尚未通过，手机连接使用私人 IP 备用地址。

### 2026-10-16 欢迎语修复包：0.3.3（待安装）

后台修复 ESP32 连续发送 `listen/detect`、`listen/start` 时欢迎语被误取消的问题，明确打断和待机仍可取消播报。完整 Node 测试 97 项通过，Android `assembleDebug`、`lintDebug` 通过，最终 APK 已复制到标准输出路径。电脑后台已部署此修复；手机 ProfilePilot App 暂无响应，因此尚未安装 0.3.3，也未完成手机端实机欢迎语验证。

### 2026-10-16 连续语音升级：0.4.0（待安装）

`VoiceCallService` 独立持有 AudioRecord／AudioTrack 和本机 WebSocket，页面离开后保持通话，重新进入恢复状态；通知提供静音、暂停和结束。支持音频焦点、平台回声消除及可选蓝牙／听筒／扬声器路由。`ScreenShareService` 使用系统 MediaProjection 授权和独立前台通知，每轮只发送一帧；通话结束或撤销分享时释放资源。全双工、流式识别及其他连续语音功能随核心服务一起打包。

最终 APK 56,092,784 字节，SHA-256 `8fdbe5d4949b04af775254dcd55ae002055166b652a7c925d950842db20deeec`；构建、lint（0 errors、8 warnings）、v2 签名校验通过。内嵌源码、网页与许可逐文件核对一致，包中没有用户数据目录、数据库或本地密钥。完整 Node 回归 133 项通过；首次授权期间的原生客户端状态与 ESP32 欢迎语后进入实时会话均有回归覆盖。

realme 当前调试连接离线，无线发现未找到入口；默认 Chrome 仍在另一任务的用户接管状态。尚未进行 0.4.0 覆盖安装、实际锁屏／蓝牙／回声、摄像头和屏幕授权验收。编译与模拟协议测试不能替代这些结果。
