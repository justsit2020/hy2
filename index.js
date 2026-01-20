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
let NESTED_PATH = (process.env.VMESS_PATH || '/vless').trim();
if (!NESTED_PATH.startsWith('/')) NESTED_PATH = '/' + NESTED_PATH;

const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');
const INTERNAL_PORT = 10000;

const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

console.log(`[Init] 启动准备... 架构: ARM64`);
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
      execSync(`${binPath} -version`);
      console.log(`[Init] 核心校验通过`);
      return true;
    } catch(e) { fs.unlinkSync(binPath); }
  }

  try {
    await downloadFile(URL_ARM, zipPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(TMP_DIR, true);
    fs.chmodSync(binPath, 0o755);
    fs.unlinkSync(zipPath);
    execSync(`${binPath} -version`);
    console.log(`[Success] 安装成功`);
    return true;
  } catch (e) {
    console.error(`[Fatal] 安装失败`);
    return false;
  }
}

// --- 主逻辑 ---
async function start() {
  if (!await installCore()) process.exit(1);

  // --- VLESS 配置 ---
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
      const vlessLink = `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=${encodeURIComponent(NESTED_PATH)}#Leapcell-Fixed`;
      
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <h2>✅ 服务运行中 (透传模式)</h2>
        <p>UUID: ${UUID}</p>
        <textarea style="width:100%; height:100px;">${vlessLink}</textarea>
      `);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // --- 终极透传管道 ---
  server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith(NESTED_PATH)) {
      
      const proxySocket = net.connect(INTERNAL_PORT, '127.0.0.1', () => {
        // 1. 构造请求行
        let headers = `GET ${NESTED_PATH} HTTP/1.1\r\n`;
        
        // 2. 智能透传 Header
        // 遍历所有 Header，除了 Host (我们自己重写) 和 压缩相关的 (防止兼容问题)
        for (let key in req.headers) {
          if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'sec-websocket-extensions') {
            headers += `${key}: ${req.headers[key]}\r\n`;
          }
        }
        
        // 3. 补全必要 Header
        headers += `Host: ${req.headers.host}\r\n`;
        headers += `\r\n`; // 结束头

        // 4. 发送握手
        proxySocket.write(headers);
        
        // 5. 发送 Body (如有)
        if (head && head.length > 0) proxySocket.write(head);
        
        // 6. 建立管道
        socket.pipe(proxySocket);
        proxySocket.pipe(socket);
        
        console.log(`[Proxy] 隧道建立成功`);
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
