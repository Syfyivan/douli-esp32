# 豆梨官网

官网是独立的静态展示站，源文件在 [`site/`](../site/)。它不使用主应用数据库、模型密钥或聊天 API，也不请求麦克风。官网示例是虚构的预设交互；小梨是 SVG 品牌插画，不是产品实物图。

正式入口：<https://124-221-36-36.anyip.dev:8443/douli/>。部署结果和版本见本文末尾的验收记录。

## 本地预览

需要 Node.js，无需额外 npm 依赖或前端构建。

```sh
npm run site:check
npm run site:preview
```

打开 `http://127.0.0.1:4180/douli/`，停止时使用 `Ctrl+C`。端口占用可用 `DOULI_SITE_PORT` 指定新端口。预览只监听回环地址，只提供 `site/` 中的受支持静态文件。

## 文件

- `site/index.html`：内容、语义结构、SEO 与 GitHub 文档入口。
- `site/styles.css`：响应式布局、品牌视觉、动效和减少动态效果支持。
- `site/app.js`：菜单、对话示例、原话展开、命令复制和动效控制。不请求后端。
- `site/assets/mark.svg`：基于现有梨形标志延展的原创品牌插画。
- `scripts/check-site.mjs`：检查资源、锚点、文档链接、公开文件类型和 150 KB 源文件预算。
- `site-deploy/Caddyfile.subpath`：添加到已有 HTTPS 站点的独立路由。

## 腾讯云发布

复用用户现有腾讯云服务器和 Caddy。服务器地址、SSH 账号、密钥和证书不写入前端；私钥由现有 SSH Agent 使用，不能导出或提交。不要把 `server/`、`.data/`、`.runtime/` 或整个仓库上传到静态根目录。

1. 检查现有 HTTPS 路由、Caddy 状态以及 `/douli/` 是否已被占用，保存相关既有站点的健康检查结果。
2. 运行静态检查与浏览器验收；只将 `site/` 内容打包，记录 SHA-256。
3. 上传到新的 `/srv/douli/releases/<release-id>/`，核对每个文件的哈希，不覆盖旧发布目录。
4. 备份现有 Caddyfile。将 [`Caddyfile.subpath`](../site-deploy/Caddyfile.subpath) 复制到 `/etc/caddy/douli.caddy`，在目标 HTTPS 站点块内添加一次 `import /etc/caddy/douli.caddy`。不得更改其他路由或证书设置。
5. `/srv/douli/current` 指向已验证的发布目录。以临时符号链接加原子重命名切换。首次添加路由前执行 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`，通过后 reload Caddy。
6. 检查公网首页、CSS、JS、SVG、重定向、错误路径与响应头；核对页面内容哈希和原有站点可用性。查看桌面与移动页面，不能把 SSH 命令成功当作上线成功。

发布后如果发现问题，将 `current` 原子切回先前版本；首次发布可恢复备份配置，验证后 reload。不要删除旧发布目录或修改其他应用的数据来回滚。

静态站点使用现有服务，不新增公网应用端口、Node 服务或数据库。自定义独立域名后续需要用户提供域名及 DNS 管理条件；目前沿用已有的 HTTPS 域名和端口。

官方配置参考：[Caddy handle_path](https://caddyserver.com/docs/caddyfile/directives/handle_path)、[file_server](https://caddyserver.com/docs/caddyfile/directives/file_server)、[命令行验证与重载](https://caddyserver.com/docs/command-line)。腾讯云也提供 [CloudBase 静态托管](https://cloud.tencent.com.cn/document/product/876/46900)，本次沿用现有服务器部署方式。

## 设计与验收

视觉方向：米白纸面、深绿、梨黄色；大字号中文与少量衬线英文；品牌形象、对话示例、生活手记、架构与上手形成不同节奏。交互只用于解释产品。

参考观察包括 [Oura 的 Awwwards 展示](https://www.awwwards.com/sites/oura-ring) 中的产品叙事与留白，以及 [FWA 的 Sleep Well Creative 评述](https://thefwa.com/FWA25/RobFWA.html) 强调的细节、动效和完整体验。参考用于形成检查标准，不复制品牌素材，也不宣称本站获得奖项。

每轮检查 typography、whitespace、visual hierarchy、color、motion、micro-interaction、responsive、originality；发现问题后改动并复查。浏览器结果、实际修订与验证范围记录在 [官网验收记录](WEBSITE_REVIEW.md)。视觉判断具有主观性，交付证据是已完成的检查与修订，不能客观保证“再无任何提升空间”。

## 上线记录 · 2026-11-05

- 首次发布：`20261105-443f5b4a920e`，归档 SHA-256 为 `443f5b4a920ef921d225e777940be96b467c103251f1fa89f9769842582b1420`。仅发布四个静态文件，共 50,892 字节，无运行时依赖。
- 备份既有 Caddyfile，校验候选配置后重载；发布前后抽查两个既有站点，均能正常响应。
- 从公网 HTTPS 分别取回首页、样式、脚本与标志，全部内容哈希匹配发布文件。`/douli` 返回 308 到 `/douli/`；不存在的文件、官网下的 `/api/health` 与数据文件路径返回 404；安全响应头存在。
- 在正式站检查首屏与手机菜单、场景切换；本地完成五档响应式及其他交互回归。无应用安装包或 ESP32 固件发布。

## 实体电子宠物定位更新 · 2026-11-05

本次发布 `20261105-pet-4992732ec77e` 将首页和上手说明改为从 ESP32 实体宠物的唤醒、对话和配对讲起。沿用已有 Caddy 路由，保留首次发布目录供回滚。公网取回四个资源均返回 HTTP 200，内容与本地文件逐字节一致。Chrome 中检查四档视口，均无横向溢出。此次更新仅涉及项目介绍和文档，未重新烧录或测试硬件。
