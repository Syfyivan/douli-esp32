# ESP32 跨网连接电脑后台

当前方案由电脑上的 Tailscale Funnel 提供公网 HTTPS 入口，转发到豆梨专用的本机设备网关。ESP32 无需安装 Tailscale；换到其他可访问互联网的 Wi-Fi 后，仍使用同一地址连接这台电脑。

电脑需要开机、不休眠、联网，并保持豆梨后台和 Tailscale 运行。这不是云端托管。手机作为独立后台、跨网管理页面、手机与电脑的跨网数据同步不在此入口内；本地同步规则见 [SYNC.md](SYNC.md)。

## 连接与权限

| 用途 | 入口 | 权限 |
| --- | --- | --- |
| 本机管理 | `127.0.0.1:8788` | 仅本机 |
| 原有局域网配对及设备接口 | `8789` | 保留原有局域网规则 |
| 远程网关 | `127.0.0.1:8792` | 仅本机隧道可转发；设备身份校验 |
| 公网入口 | `https://电脑域名.ts.net:8443` | TLS + 已配对设备令牌 |

远程网关只注册 `/xiaozhi/ota/`（也支持不带结尾 `/`）和 `/xiaozhi/v1/` WebSocket。OTA 查询与 WebSocket 升级均要求 `Device-Id` 和 `Authorization: Bearer ...`，设备必须在本机批准。知道设备 ID 不足以获得令牌或建立连接。管理、记忆、健康、同步、首次配对、激活以及传感器 HTTP 路由不在该网关开放。

未认证请求返回 401；认证后的未知 HTTP 路径返回 404。请求体上限 16 KiB，WebSocket 单消息上限 128 KiB。OTA 返回配置中的固定 `wss://` 地址，不受来访 Host、转发头或局域网 `.local` 发现地址影响。响应禁止缓存。

不要把 8788 或 8789 直接接入公网隧道。原有局域网 OTA 按本地配对流程工作，不具备本入口的远程发现校验。

## 本机配置

已安装并登录的 Tailscale 需要支持 HTTPS、MagicDNS 和 Funnel。配置保存在被 Git 忽略的 `.data/remote-access.json`：

```json
{
  "enabled": true,
  "origin": "https://你的电脑域名.ts.net:8443",
  "port": 8792
}
```

`origin` 只能包含 HTTPS 域名及端口，不能含路径、用户信息、查询或片段。未配置或 `enabled: false` 时不创建远程监听。配置按后台使用的数据目录读取。

先启动后台、确认本机远程网关拒绝未授权请求，再开启隧道：

```powershell
npm run start:background
tailscale funnel --bg --https=8443 http://127.0.0.1:8792
tailscale funnel status
```

本机现有的 443 Serve 服务独立保留。不要执行 `tailscale serve reset` 或 `tailscale funnel reset`。官方说明中 `--bg` 会保存 Funnel 设置，在 Tailscale 重启后恢复；豆梨的 `start:background` 是独立隐藏进程，不等于 Windows 开机自启，电脑重启后仍需启动豆梨。

参考：[Funnel 说明](https://tailscale.com/docs/features/tailscale-funnel)、[Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)。Funnel 使用 TLS，公网端口限 443、8443、10000，并存在带宽限制，具体以官方文档为准。

## 板子配置

需要豆梨固件 `2.5.2.2` 或后续兼容版本，构建步骤见 [FIRMWARE.md](FIRMWARE.md)。保留已配对的 `websocket.token`，同时配置：

- `wifi.ota_url`：`https://同一域名:8443/xiaozhi/ota/`
- `websocket.url`：`wss://同一域名:8443/xiaozhi/v1/`

固件仅在 HTTPS OTA 与已保存 WSS 的域名、端口完全一致时附带现有设备令牌；普通 HTTP 或其他地址不会得到它。新设备应先在可信局域网完成配对。远程入口不提供首次配对。

保持 ESP-IDF 原有 TLS 证书包与主机名校验，不使用自签名绕过或明文公网 WebSocket。待机心跳、30 分钟无有效对话进入待机、结束词快速待机沿用既有逻辑。

修改板端配置前，读取当前完整 Flash 备份，核对实际分区及运行槽。本次只改了已核对 NVS 中两个字符串的内容、长度与 CRC，保留原分配跨度，其余字节相同；只刷应用槽和这份 NVS，不覆盖唤醒资源、分区表、启动器或 OTA 选择。备份含私人配置，只保留在忽略目录。

## 检查与停用

- 本机 `/api/health` 的 `remoteAccess` 表示专用网关已启用。
- `/api/state` 中设备 `connection.remote: true` 表示该连接来自专用远程网关；`persistent`、`standbyConfirmed` 和 `audioFramesReceived` 用于观察长连接与待机音频。该标记本身不能证明两端位于不同局域网。
- 公网验证应使用公共 DNS 返回的中继 IP 并验证证书，避免电脑的 MagicDNS 将域名解析成 Tailscale 内网地址。然后核对已配对请求成功、未授权请求失败。
- 要完整验证不同局域网，可让电脑连接手机热点、板子保留原 Wi-Fi，观察断线后的自动重连和语音操作。换网络或链路恢复可能需要等待重连退避，不能保证瞬时恢复。
- 停用时先把板端两个地址恢复到可达的局域网配置，再执行 `tailscale funnel --https=8443 off`，将 `enabled` 改为 false 并重启后台。不要关闭或重置无关的 Tailscale 服务。

实际验证记录见 [固件真机记录](FIRMWARE.md)。本地日志位于 `.runtime/remote-access/` 与 `.runtime/firmware-repair/`，不进入 Git。
