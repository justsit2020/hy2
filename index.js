const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// 1. 获取配置
const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || uuidv4();
const NESTED_PATH = process.env.VMESS_PATH || '/vmess';

console.log(`[Info] 启动: 端口=${PORT}, UUID=${UUID}, 路径=${NESTED_PATH}`);

// 2. 生成 V2Ray 配置文件
const config = {
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "port": 10000,
    "listen": "127.0.0.1",
    "protocol": "vmess",
    "settings": { "clients": [{ "id": UUID, "alterId": 0 }] },
    "streamSettings": {
      "network": "ws",
      "wsSettings": { "path": NESTED_PATH }
    }
  }],
  "outbounds": [{ "protocol": "freedom", "settings": {} }]
};

// 写入配置到 /tmp 目录 (Serverless 环境唯一可写的地方)
const configPath = path.join('/tmp', 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

// 3. 启动 Xray/V2Ray 核心
// 注意：这里假设 Dockerfile 已经安装好了 xray 到 /usr/bin/xray
// 如果没有，这行代码会报错，但不会报 'adm-zip' 错误
const v2ray = spawn('xray', ['-c', configPath]);

v2ray.stdout.on('data', (data) => console.log(`[Xray] ${data}`));
v2ray.stderr.on('data', (data) => console.error(`[Xray Err] ${data}`));

// 4. 启动 HTTP 代理服务器 (为了通过健康检查)
const proxy = httpProxy.createProxyServer({});
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Leapcell Service is Runing!');
  } else if (req.url.startsWith(NESTED_PATH)) {
    proxy.web(req, res, { target: 'http://127.0.0.1:10000' });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith(NESTED_PATH)) {
    proxy.ws(req, socket, head, { target: 'ws://127.0.0.1:10000' });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
