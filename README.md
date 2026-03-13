# OpenClaw Browser Client

纯前端静态项目，可直接由 `nginx` 等 Web 服务器部署。

## 配置来源

首次访问可通过 URL 参数传入：

```text
?gateway=ws://127.0.0.1:18789/ws&token=YOUR_TOKEN
```

支持参数：

- `gateway` 或 `url`
- `token`
- `scopes`，例如 `operator.read,operator.write`

页面会将配置保存到浏览器 `localStorage`，后续优先从 `localStorage` 恢复。

## 当前功能

第一步只实现：

- 浏览器直连 OpenClaw Gateway WebSocket
- `connect.challenge -> connect -> hello-ok` 握手
- 在页面上直接展示上下行原始消息帧

## 部署

将以下文件部署到静态目录：

- `index.html`
- `styles.css`
- `app.js`

建议使用 `https` 或 `localhost` 访问页面，因为浏览器端设备签名依赖 WebCrypto。
