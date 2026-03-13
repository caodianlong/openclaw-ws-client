[English](./README.en.md) | [中文](./README.md)

# OpenClaw Browser Client

A pure frontend static project for connecting to an OpenClaw Gateway directly from the browser and inspecting sessions, chat history, and realtime events. It can be deployed directly with a web server such as `nginx`.

## Current Features

- Direct browser connection to the OpenClaw Gateway WebSocket
- Full `connect.challenge -> connect -> hello-ok` handshake
- Browser-side generation and persistence of an Ed25519 device identity on first connection
- Connection status display including protocol version, connection ID, device ID, and frame count
- Session list loading
- Retrieval and rendering of the latest 100 messages for the selected session
- Realtime UI updates from `chat` and `agent` events
- Optional polling fallback that refreshes the active session every 5 seconds when realtime traffic is idle
- Copy raw WebSocket frames as JSON
- Configuration and device identity persisted in browser `localStorage`

## UI Overview

- Left `Sessions`: shows available sessions and loads history when one is selected
- Top `Auto Refresh`: toggles polling for the active session
- Top `Status`: shows connection and handshake metadata
- Top `Settings`: edits Gateway URL, token, and scopes
- Main `Chat History`: renders history messages, live streaming messages, and tool call / tool result content
- `Copy`: copies the currently buffered raw WebSocket frames

## Stored Keys

The browser uses these `localStorage` keys:

- `openclaw.browser.config`
- `openclaw.browser.identity`

## Deployment

Deploy the following files and directories to your static web root:

- `index.html`
- `src/css/styles.css`
- `src/js/app.js`

It is recommended to access the page via `https` or `localhost`, because browser-side device signing depends on WebCrypto.
