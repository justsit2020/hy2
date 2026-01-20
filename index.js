const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net'); // 引入 net 模块用于原生管道转发
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// --- 配置区域 ---
const PORT = process.env.PORT || 3000;
const UUID = (process.env.UUID || uuidv4()).trim();
let NESTED_PATH = (process.env.VMESS_PATH || '/vmess').trim();
if (!NESTED_PATH.startsWith('/')) NESTED_PATH = '/' + NESTED_PATH;

const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');
// 内部端口
const INTERNAL_PORT = 10000;

const URL_X64 = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

console.log(`[Init] 启动中... UUID: ${UUID}`);

// --- 下载函数 ---
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (link) => {
      https.get(link, (res) => {
        if (res.statusCode >= 300 && res.headers.location) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
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

// --- 主程序 ---
async function start() {
  let success = await installAndTest('x64', URL_X64);
  if (!success) success = await installAndTest('arm64', URL_ARM);

  if (!success) {
    console.error(`[Fatal] 核心不可用`);
    process.exit(1);
  }

  // --- Xray 配置 ---
  const config = {
    "log": { "loglevel": "warning" },
    "inbounds": [{
      "port": INTERNAL_PORT,
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
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  // --- 禁用 AEAD 强制 ---
  const env = Object.assign({}, process.env, { XRAY_VMESS_AEAD_FORCED: "false" });
  const xray = spawn(path.join(TMP_DIR, 'xray'), ['-c', CONFIG_FILE], { env });
  xray.stdout.on('data', d => console.log(`[Xray] ${d}`));
  xray.stderr.on('data', d => console.error(`[Xray] ${d}`));

  // --- Web 服务器 ---
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const host = req.headers.host;
      const linkConfig = {
        v: "2",
        ps: "Leapcell-Raw",
        add: host,
        port: "443",
        id: UUID,
        aid: "0",
        scy: "auto",
        net: "ws",
        type: "none",
        host: host,
        path: NESTED_PATH,
        tls: "tls"
      };
      const link = 'vmess://' + Buffer.from(JSON.stringify(linkConfig)).toString('base64');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <h2>Vmess Raw-Socket Mode</h2>
        <p>UUID: ${UUID}</p>
        <p>Path: ${NESTED_PATH}</p>
        <textarea style="width:100%; height:120px;">${link}</textarea>
        <p>当前模式：原生 TCP 管道直连 (Raw TCP Pipe)</p>
      `);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // --- 关键修改：原生 TCP 管道转发 ---
  // 不再使用 http-proxy，直接在该层级劫持 Socket 进行转发
  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith(NESTED_PATH)) {
      console.log(`[Proxy] 收到 WS 连接，正在建立直连管道...`);
      
      // 连接后端的 Xray 端口
      const proxySocket = net.connect(INTERNAL_PORT, '127.0.0.1', () => {
        // 1. 写入 HTTP 握手头 (WS Handshake)
        // 必须要把原始的 Upgrade 请求头手动发给 Xray，否则 Xray 不认
        proxySocket.write(`GET ${NESTED_PATH} HTTP/1.1\r\n` +
                          `Host: ${req.headers.host}\r\n` +
                          `Upgrade: websocket\r\n` +
                          `Connection: Upgrade\r\n` +
                          `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}\r\n` +
                          `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}\r\n` +
                          `\r\n`);
        
        // 2. 将 head (如果有) 写入
        if (head && head.length > 0) proxySocket.write(head);
        
        // 3. 建立双向管道 (Pipe)
        socket.pipe(proxySocket);
        proxySocket.pipe(socket);
        
        console.log(`[Proxy] 管道建立成功`);
      });

      proxySocket.on('error', (e) => {
        console.error(`[Proxy Error] 后端连接失败: ${e.message}`);
        socket.destroy();
      });
      
      socket.on('error', (e) => {
        console.error(`[Socket Error] 前端连接断开`);
        proxySocket.destroy();
      });

    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, () => {
    console.log(`[Server] 服务已启动: 端口 ${PORT}`);
  });
}

start();
