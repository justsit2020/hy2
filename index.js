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
const UUID = (process.env.UUID || '16927f80-993d-4c3d-8228-569031a0d844').trim();
let NESTED_PATH = (process.env.VMESS_PATH || '/vless').trim();
if (!NESTED_PATH.startsWith('/')) NESTED_PATH = '/' + NESTED_PATH;

const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');
const INTERNAL_PORT = 10000;

// 既然已经验证是 ARM64，直接锁定下载地址，不再试错
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

console.log(`[Init] 正在启动... 架构锁定: ARM64`);
console.log(`[Init] UUID: ${UUID}`);

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

// --- 安装核心 ---
async function installCore() {
  const binPath = path.join(TMP_DIR, 'xray');
  const zipPath = path.join(TMP_DIR, `xray.zip`);
  
  if (fs.existsSync(binPath)) {
    try {
      // 验证现有文件是否完好
      execSync(`${binPath} -version`);
      console.log(`[Init] 现有核心校验通过`);
      return true;
    } catch(e) { 
      console.log(`[Init] 现有核心损坏，重新下载...`);
      fs.unlinkSync(binPath); 
    }
  }

  try {
    console.log(`[Download] 下载 Xray (ARM64)...`);
    await downloadFile(URL_ARM, zipPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(TMP_DIR, true);
    fs.chmodSync(binPath, 0o755);
    fs.unlinkSync(zipPath);
    execSync(`${binPath} -version`);
    console.log(`[Success] 安装成功`);
    return true;
  } catch (e) {
    console.error(`[Fatal] 安装失败: ${e.message}`);
    return false;
  }
}

// --- 主程序 ---
async function start() {
  if (!await installCore()) process.exit(1);

  // --- 配置文件 (VLESS + VLESS) ---
  const config = {
    "log": { "loglevel": "warning" },
    "inbounds": [{
      "port": INTERNAL_PORT,
      "listen": "127.0.0.1",
      "protocol": "vless",
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
      const vlessLink = `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=${encodeURIComponent(NESTED_PATH)}#Leapcell-ARM64`;
      
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <div style="padding: 20px; font-family: sans-serif;">
          <h2 style="color:green">✅ 系统正常 (ARM64/VLESS)</h2>
          <p><strong>UUID:</strong> ${UUID}</p>
          <hr>
          <h3>🔗 VLESS 链接:</h3>
          <textarea style="width:100%; height:100px;">${vlessLink}</textarea>
        </div>
      `);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // --- 终极无损管道转发 ---
  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith(NESTED_PATH)) {
      // 1. 暂停客户端 socket，防止数据在连接后端前流失
      socket.pause();

      const proxySocket = net.connect(INTERNAL_PORT, '127.0.0.1', () => {
        // 2. 只有连接成功后，才写入握手头
        proxySocket.write(`GET ${NESTED_PATH} HTTP/1.1\r\n` +
                          `Host: ${req.headers.host}\r\n` +
                          `Upgrade: websocket\r\n` +
                          `Connection: Upgrade\r\n` +
                          `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}\r\n` +
                          `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}\r\n` +
                          `\r\n`);
        
        // 3. 写入头部携带的数据 (如果有)
        if (head && head.length > 0) proxySocket.write(head);
        
        // 4. 对接管道
        socket.pipe(proxySocket);
        proxySocket.pipe(socket);
        
        // 5. 恢复数据流
        socket.resume();
        console.log(`[Proxy] 隧道建立: ${req.headers['x-forwarded-for'] || 'Direct'}`);
      });

      proxySocket.on('error', (e) => {
        console.error(`[ProxyErr] 后端断开: ${e.message}`);
        socket.destroy();
      });
      socket.on('error', (e) => {
        proxySocket.destroy();
      });

    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, () => {
    console.log(`[Server] 服务运行在: ${PORT}`);
  });
}

start();
