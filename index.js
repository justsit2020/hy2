const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// 1. 获取配置信息
const PORT = process.env.PORT || 3000;         // 云平台分配的端口
const UUID = process.env.UUID || uuidv4();     // 用户 UUID
const NESTED_PATH = process.env.VMESS_PATH || '/vmess'; // WebSocket 路径
const V2RAY_PORT = 10000;                      // V2Ray 内部监听端口

console.log(`[Info] 启动配置 -> 端口:${PORT} UUID:${UUID} 路径:${NESTED_PATH}`);
// 2. [...](asc_slot://start-slot-3)生成 V2Ray 配置文件 (config.json)
const config = {
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "port": V2RAY_PORT,
    "listen": "127.0.0.1",
    "protocol": "vmess",
    "settings": {
      "clients": [{ "id": UUID, "alterId": 0 }]
    },
    "streamSettings": {
      "network": "ws",
      "wsSettings": { "path": NESTED_PATH }
    }
  }],
  "outbounds": [{ "protocol": "freedom", "settings": {} }]
};

// 写入临时文件
const configPath = path.join('/tmp', 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
// 3. 启动 V2Ray 核心
// 假设 Dockerfile 已经把 xray 放到了 /usr/bin/xray
const v2ray = spawn('xray', ['-c', configPath]);

v2ray.stdout.on('data', (data) => console.log(`[Xray] ${data}`));
v2ray.stderr.on('data', (data) => console.error(`[Xray Error] ${data}`));
v2ray.on('close', (code) => {
  console.log(`[Xray] 进程退出，代码 ${code}`);
  process.exit(code);
});

// 4. 创建 Node.js HTTP 代理服务器 (解决端口监听和健康检查)
const proxy = httpProxy.createProxyServer({});

// 错误处理，防止代理报错导致进程崩溃
proxy.on('error', function (err, req, res) {
  console.error('[Proxy Error]', err);
  if (res && !res.headersSent) {
    res.writeHead(500);
    res.end('Proxy Error');
  }
});

const server = http.createServer(function(req, res) {
  if (req.url === '/') {
    // 健康检查接口：云平台通常会 ping 根路径
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Server is running!');
    res.end();
  } else if (req.url.startsWith(NESTED_PATH)) {
    // 转发 WebSocket 流量到 V2Ray
    proxy.web(req, res, { target: `http://127.0.0.1:${V2RAY_PORT}` });
  } else {
    res.writeHead(404);
    res.end();
  }
});

// 处理 WebSocket 升级请求 (关键)
server.on('upgrade', function (req, socket, head) {
  if (req.url.startsWith(NESTED_PATH)) {
    proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${V2RAY_PORT}` });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[Server] 正在监听端口 ${PORT}，转发流量到 V2Ray`);
});
