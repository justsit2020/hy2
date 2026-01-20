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
const UUID = (process.env.UUID || '0890b53a-5c1d-4b84-82f5-30b427493032').trim(); // 固定一个新 UUID

// 定义两个路径
const PATH_VMESS = '/vmess';
const PATH_VLESS = '/vless';

const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');
const URL_X64 = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

// --- 下载与安装 ---
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

async function installAndTest(archName, url) {
  const binPath = path.join(TMP_DIR, 'xray');
  const zipPath = path.join(TMP_DIR, `xray-${archName}.zip`);
  if (fs.existsSync(binPath)) { try { execSync(`${binPath} -version`); return true; } catch(e) { fs.unlinkSync(binPath); } }
  try {
    await downloadFile(url, zipPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(TMP_DIR, true);
    fs.chmodSync(binPath, 0o755);
    fs.unlinkSync(zipPath);
    execSync(`${binPath} -version`);
    console.log(`[Success] 架构 ${archName} 可用`);
    return true;
  } catch (e) { return false; }
}

async function start() {
  let success = await installAndTest('x64', URL_X64);
  if (!success) success = await installAndTest('arm64', URL_ARM);
  if (!success) { console.error(`[Fatal] 核心失败`); process.exit(1); }

  // --- 配置文件：同时开启 VMess(10001) 和 VLESS(10002) ---
  const config = {
    "log": { "loglevel": "warning" },
    "inbounds": [
      {
        "port": 10001,
        "listen": "127.0.0.1",
        "protocol": "vmess",
        "settings": { "clients": [{ "id": UUID, "alterId": 0 }] },
        "streamSettings": { "network": "ws", "wsSettings": { "path": PATH_VMESS } }
      },
      {
        "port": 10002,
        "listen": "127.0.0.1",
        "protocol": "vless",
        "settings": { "clients": [{ "id": UUID }], "decryption": "none" },
        "streamSettings": { "network": "ws", "wsSettings": { "path": PATH_VLESS } }
      }
    ],
    "outbounds": [{ "protocol": "freedom", "settings": {} }]
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  // 禁用 AEAD 强制验证 (兼容旧版 VMess)
  const env = Object.assign({}, process.env, { XRAY_VMESS_AEAD_FORCED: "false" });
  const xray = spawn(path.join(TMP_DIR, 'xray'), ['-c', CONFIG_FILE], { env });
  xray.stdout.on('data', d => console.log(`[Xray] ${d}`));
  xray.stderr.on('data', d => console.error(`[Xray] ${d}`));

  // --- Web 服务器 & 路由分发 ---
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const host = req.headers.host;
      // 生成 VMess 链接
      const vmessInfo = { v:"2", ps:"Leapcell-VMess", add:host, port:"443", id:UUID, aid:"0", scy:"auto", net:"ws", type:"none", host:host, path:PATH_VMESS, tls:"tls" };
      const vmessLink = 'vmess://' + Buffer.from(JSON.stringify(vmessInfo)).toString('base64');
      
      // 生成 VLESS 链接
      const vlessLink = `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=${encodeURIComponent(PATH_VLESS)}#Leapcell-VLESS`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <style>body{font-family:sans-serif;max-width:800px;margin:20px auto;padding:20px;} textarea{width:100%;height:80px;font-family:monospace;background:#f0f0f0;border:1px solid #ccc;} .box{border:1px solid #ddd;padding:15px;margin-bottom:20px;border-radius:5px;}</style>
        <h1>🚀 节点配置中心</h1>
        <p>UUID: <strong>${UUID}</strong></p>
        
        <div class="box">
          <h3 style="color:#007bff">方案 A: VLESS 协议 (推荐, 更稳定)</h3>
          <textarea>${vlessLink}</textarea>
          <ul>
             <li>路径 (Path): <code>${PATH_VLESS}</code></li>
             <li>端口: 443 | 传输: ws | TLS: 开启</li>
          </ul>
        </div>

        <div class="box">
          <h3 style="color:#28a745">方案 B: VMess 协议 (兼容性好)</h3>
          <textarea>${vmessLink}</textarea>
          <ul>
             <li>路径 (Path): <code>${PATH_VMESS}</code></li>
             <li>AlterID: 0 | 端口: 443 | 传输: ws | TLS: 开启</li>
          </ul>
        </div>
      `);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // --- WebSocket 路由转发 ---
  server.on('upgrade', (req, socket, head) => {
    let targetPort = 0;
    
    // 根据路径分流到不同的 Xray 端口
    if (req.url.startsWith(PATH_VMESS)) {
      targetPort = 10001;
    } else if (req.url.startsWith(PATH_VLESS)) {
      targetPort = 10002;
    }

    if (targetPort > 0) {
      const proxySocket = net.connect(targetPort, '127.0.0.1', () => {
        // 重写 WebSocket 握手头
        proxySocket.write(`GET ${req.url} HTTP/1.1\r\n` +
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
    console.log(`[Server] 服务已启动: 端口 ${PORT}`);
  });
}

start();
