const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// --- 基础配置 ---
const PORT = process.env.PORT || 3000;
// 关键修改：如果没设置环境变量，强制使用这个固定 UUID，防止重启后失效
const UUID = process.env.UUID || 'de04add9-5c68-8bab-950c-08cd5320df18'; 
const NESTED_PATH = process.env.VMESS_PATH || '/vmess';
const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');

const URL_X64 = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

console.log(`[Init] 启动中... UUID 已固定为: ${UUID}`);

// --- 下载辅助函数 ---
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (link) => {
      https.get(link, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    };
    get(url);
  });
}

// --- 架构尝试函数 ---
async function installAndTest(archName, url) {
  const zipPath = path.join(TMP_DIR, `xray-${archName}.zip`);
  const binPath = path.join(TMP_DIR, 'xray');
  
  if (fs.existsSync(binPath)) {
    // 如果已经存在且能运行，直接复用，节省启动时间
    try {
      execSync(`${binPath} -version`);
      console.log(`[Init] 复用已存在的 ${archName} 核心`);
      return true;
    } catch(e) {
      fs.unlinkSync(binPath); // 不能用就删了重下
    }
  }

  try {
    console.log(`[Try] 下载架构: ${archName}`);
    await downloadFile(url, zipPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(TMP_DIR, true);
    fs.chmodSync(binPath, 0o755);
    fs.unlinkSync(zipPath);
    execSync(`${binPath} -version`);
    console.log(`[Success] 架构 ${archName} 可用！`);
    return true;
  } catch (e) {
    console.log(`[Fail] 架构 ${archName} 失败，尝试下一个...`);
    return false;
  }
}

// --- 主程序 ---
async function start() {
  // 1. 安装核心
  let success = await installAndTest('x64', URL_X64);
  if (!success) success = await installAndTest('arm64', URL_ARM);

  if (!success) {
    console.error(`[Fatal] 启动失败：无可用核心。`);
    process.exit(1);
  }

  // 2. 生成配置 (标准 VMess WebSocket)
  const config = {
    "log": { "loglevel": "warning" },
    "inbounds": [{
      "port": 10000,
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

  // 3. 启动 Xray
  const xray = spawn(path.join(TMP_DIR, 'xray'), ['-c', CONFIG_FILE]);
  xray.stdout.on('data', d => console.log(`[Xray] ${d}`));
  xray.stderr.on('data', d => console.error(`[Xray] ${d}`));

  // 4. Web 服务器 + 节点链接生成
  const proxy = httpProxy.createProxyServer({});
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const host = req.headers.host;
      const vmessInfo = {
        v: "2",
        ps: "Leapcell-Fixed",
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
      const link = 'vmess://' + Buffer.from(JSON.stringify(vmessInfo)).toString('base64');
      
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <div style="font-family: sans-serif; padding: 20px;">
          <h2>✅ 节点运行正常</h2>
          <p><strong>UUID (已固定):</strong> ${UUID}</p>
          <hr>
          <h3>🚀 Vmess 链接 (全选复制):</h3>
          <textarea style="width:100%; height:120px; font-size:12px;">${link}</textarea>
          <hr>
          <p style="color: #666; font-size: 14px;">提示：请确保客户端开启了 <strong>TLS</strong> (端口 443)</p>
        </div>
      `);
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
    console.log(`[Server] 服务已启动: https://${process.env.LEAPCELL_APP_URL || 'YOUR-URL'}`);
  });
}

start();
