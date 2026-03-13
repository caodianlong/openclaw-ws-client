[中文](./README.md) | [English](./README.en.md)

# OpenClaw Browser Client

纯前端静态项目，用于在浏览器中直连 OpenClaw Gateway，查看会话列表、聊天历史和实时事件流。可直接由 `nginx` 等 Web 服务器部署。

## 当前功能

- 浏览器直连 OpenClaw Gateway WebSocket
- 完成 `connect.challenge -> connect -> hello-ok` 握手
- 首次连接时在浏览器端生成并持久化 Ed25519 设备身份
- 展示连接状态、协议版本、连接 ID、设备 ID、帧数量
- 拉取并展示会话列表
- 拉取并展示指定会话最近 100 条聊天历史
- 接收 `chat` / `agent` 事件并在页面中实时更新流式消息
- 可选启用自动轮询，在缺少实时事件时每 5 秒刷新当前会话历史
- 支持复制原始 WebSocket 帧为 JSON
- 配置与设备身份保存到浏览器 `localStorage`

## 界面说明

- 左侧 `Sessions`：展示会话列表，点击后加载该会话历史
- 顶部 `自动刷新`：切换当前会话的轮询刷新
- 顶部 `状态`：查看当前连接和握手元信息
- 顶部 `设置`：填写或修改 Gateway URL、Token、Scopes
- 主区 `Chat History`：展示历史消息、流式消息，以及工具调用 / 工具结果内容
- `Copy`：复制当前缓存的原始 WebSocket 帧

## 存储项

浏览器会使用以下 `localStorage` 键：

- `openclaw.browser.config`
- `openclaw.browser.identity`

## 部署

将以下文件和目录部署到静态目录：

- `index.html`
- `src/css/styles.css`
- `src/js/app.js`

建议使用 `https` 或 `localhost` 访问页面，因为浏览器端设备签名依赖 WebCrypto。
