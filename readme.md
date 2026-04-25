# 匿名聊天室

基于 `Node.js + WebSocket` 的匿名聊天室，支持：

- 匿名加入，无需注册
- 邀请链接分享房间
- 文字消息
- 图片消息
- 输入框粘贴图片发送
- 自动图片压缩
- 撤回自己发送的消息
- 房间最多 10 人
- 同时适配 PC 网页和移动端网页

## 启动方式

```bash
npm install
npm start
```

启动后访问：

```text
http://localhost:3000
```

## 使用方式

- 点击“新建房间”自动生成房间号
- 或者输入房间号后点击“进入房间”
- 进入后可复制邀请链接发给别人
- 支持发送文字和图片
- 支持截图后直接在输入框里粘贴图片
- 自己发送的消息靠右显示，别人发送的消息靠左显示
- 自己发送的消息可以点击“撤回”

## 当前实现说明

- 服务端使用 `Express + ws`
- 前端使用原生 `HTML + CSS + JavaScript`
- 图片在浏览器端压缩后转成 `Base64 Data URL` 再通过 WebSocket 广播
- 服务端为每条消息分配 `messageId`，支持撤回自己发送的消息
- 服务端不保存聊天记录，刷新页面后不会保留历史消息

## Docker 部署

也可以直接使用一键脚本：

```bash
chmod +x ./chatroom-oneclick.sh
bash ./chatroom-oneclick.sh
```

### 方式一：直接构建运行

```bash
docker build -t anonymous-chatroom .
docker run -d --name anonymous-chatroom -p 3000:3000 anonymous-chatroom
```

### 方式二：使用 Docker Compose

```bash
docker compose up -d --build
```

启动后访问：

```text
http://服务器IP:3000
```

## Nginx + 域名 + HTTPS/WSS 部署

### 1. 域名解析

- 将你的域名，例如 `chat.example.com`，解析到服务器公网 IP

### 2. 启动 Node 服务

- 建议先用 Docker 或 `pm2` 启动本项目，监听 `3000` 端口

### 3. 复制 Nginx 配置

- 参考文件：`deploy/nginx/chatroom.conf.example`
- 将其中的 `chat.example.com` 替换成你的真实域名

### 4. 签发 HTTPS 证书

- 推荐使用 `certbot`

```bash
sudo certbot --nginx -d chat.example.com
```

### 5. 重载 Nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 6. 访问地址

```text
https://chat.example.com
```

说明：

- 页面通过 `https` 打开后，前端会自动使用 `wss://当前域名` 建立 WebSocket
- Nginx 配置里已经包含 WebSocket 升级头，支持 `WSS`
- 如果你放在 CDN 或反向代理后面，需要确保它们也允许 WebSocket 透传

## 当前限制

- 单张图片限制为 10MB
- 单条文字限制为 1000 字
- 房间无密码，拿到邀请链接即可进入
- 当前为单机部署版本，重启服务后房间状态会清空
- 撤回仅支持自己发送的消息，且只对当前在线用户可见
