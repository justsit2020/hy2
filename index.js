const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// --- 基础配置 ---
const PORT = process.env.PORT || 3000;
// 自动去除 UUID 空格
const UUID = (process.env.UUID || uuidv4()).trim();
// 自动处理路径
let NESTED_PATH = (process.env.VMESS_PATH || '/vless').trim(); // 默认改为 /vless
if (!NESTED_PATH.startsWith('/')) NESTED_PATH = '/' + NESTED_PATH;

const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');
const INTERNAL_PORT = 10000;

// 两个架构下载地址
const URL_X64 = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

console.log(`[Init] 启动准备... UUID: ${UUID}`);

// --- 下载工具 ---
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (link) => {
      https.get(link, (res) => {
        if (res.statusCode >= 300 && res.headers.location) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    };
    get(url);
  });
}

// --- 架构安装 ---
async function installAndTest(archName, url) {
  const binPath = path.join(TMP_DIR, 'xray');
  const zipPath = path.join(TMP_DIR, `xray-${archName}.zip`);
  
  if (fs.existsSync(binPath)) {
    try {
      execSync(`${binPath} -version`);
      return true;
    } catch(e) { fs.unlinkSync(binPath); }
  }

  try {
    await downloadFile(url, zipPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(TMP_DIR, true);
    fs.chmodSync(binPath, 0o755);
    fs.unlinkSync(zipPath);
    execSync(`${binPath} -version`);
    console.log(`[Success] 架构 ${archName} 可用`);
    return true;
  } catch (e) {
    return false;
  }
}

// --- 主逻辑 ---
async function start() {
  let success = await installAndTest('x64', URL_X64);
  if (!success) success = await installAndTest('arm64', URL_ARM);

  if (!success) {
    console.error(`[Fatal] 核心启动失败`);
    process.exit(1);
  }

  // --- 关键：使用 VLESS 协议 ---
  const config = {
    "log": { "loglevel": "warning" },
    "inbounds": [{
      "port": INTERNAL_PORT,
      "listen": "127.0.0.1",
      "protocol": "vless", // 切换为 VLESS
      "settings": { 
        "clients": [{ "id": UUID }],
        "decryption": "none"
      },
      "streamSettings": { 
        "network": "ws", 
        "wsSettings": { "path": NESTED_PATH } 
      }
    }],
    "outbounds": [{ "protocol": "freedom", "settings": {} }]
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  const xray = spawn(path.join(TMP_DIR, 'xray'), ['-c', CONFIG_FILE]);
  xray.stdout.on('data', d => console.log(`[Xray] ${d}`));
  xray.stderr.on('data', d => console.error(`[Xray] ${d}`));

  // --- Web 服务 ---
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const host = req.headers.host;
      // 生成 VLESS 链接
      // 格式: vless://UUID@HOST:443?encryption=none&security=tls&type=ws&host=HOST&path=PATH#REMARK
      const vlessLink = `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=${encodeURIComponent(NESTED_PATH)}#Leapcell-VLESS`;
      
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <div style="font-family: sans-serif; padding: 20px;">
          <h2 style="color: green;">✅ 服务已运行 (VLESS 模式)</h2>
          <p>已切换为 VLESS 协议，连接更稳定。</p>
          <hr>
          <h3>📋 VLESS 链接 (复制导入):</h3>
          <textarea style="width:100%; height:100px; font-family: monospace;">${vlessLink}</textarea>
          <hr>
          <h3>📝 手动配置信息:</h3>
          <ul>
            <li><strong>协议 (Type):</strong> VLESS</li>
            <li><strong>地址 (Address):</strong> ${host}</li>
            <li><strong>端口 (Port):</strong> 443</li>
            <li><strong>用户ID (UUID):</strong> ${UUID}</li>
            <li><strong>传输协议 (Network):</strong> WebSocket (ws)</li>
            <li><strong>路径 (Path):</strong> ${NESTED_PATH}</li>
            <li><strong>TLS:</strong> 开启</li>
          </ul>
        </div>
      `);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // --- 原生 WebSocket 转发 (最稳的方式) ---
  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith(NESTED_PATH)) {
      const proxySocket = net.connect(INTERNAL_PORT, '127.0.0.1', () => {
        proxySocket.write(`GET ${NESTED_PATH} HTTP/1.1\r\n` +
                          `Host: ${req.headers.host}\r\n` +
                          `Upgrade: websocket\r\n` +
                          `Connection: Upgrade\r\n` +
                          `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}\r\n` +
                          `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}\r\n` +
                          `\r\n`);
        if (head && head.length > 0) proxySocket.write(head);
        socket.pipe(proxySocket);
        proxySocket.pipe(socket);
      });
      
      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, () => {
    console.log(`[Server] 服务启动: 端口 ${PORT}`);
  });
}

start();
