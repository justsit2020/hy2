const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// --- 1. 强化环境变量处理 (自动去除空格/换行) ---
const PORT = process.env.PORT || 3000;
// 优先读环境变量，如果没有则生成。关键：使用 .trim() 去除可能的空格
const rawUUID = process.env.UUID || uuidv4();
const UUID = rawUUID.trim(); 

let rawPath = process.env.VMESS_PATH || '/vmess';
rawPath = rawPath.trim();
// 确保路径以 / 开头
const NESTED_PATH = rawPath.startsWith('/') ? rawPath : '/' + rawPath;

const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');
const URL_X64 = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

// --- 2. 打印关键调试信息 ---
console.log(`=============================================`);
console.log(`[Debug] 当前服务器时间: ${new Date().toString()}`);
console.log(`[Debug] 使用 UUID: ${UUID}`);
console.log(`[Debug] 使用 路径: ${NESTED_PATH}`);
console.log(`=============================================`);

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (link) => {
      https.get(link, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    };
    get(url);
  });
}

async function installAndTest(archName, url) {
  const zipPath = path.join(TMP_DIR, `xray-${archName}.zip`);
  const binPath = path.join(TMP_DIR, 'xray');
  
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
    console.log(`[Success] 架构 ${archName} 就绪`);
    return true;
  } catch (e) {
    return false;
  }
}

async function start() {
  let success = await installAndTest('x64', URL_X64);
  if (!success) success = await installAndTest('arm64', URL_ARM);

  if (!success) {
    console.error(`[Fatal] 核心启动失败`);
    process.exit(1);
  }

  // --- 3. 配置 Xray (开启 Debug 日志以便排查) ---
  const config = {
    "log": { 
      "loglevel": "debug", // 开启调试日志，看看到底哪里断了
      "access": "",
      "error": ""
    },
    "inbounds": [{
      "port": 10000,
      "listen": "127.0.0.1",
      "protocol": "vmess",
      "settings": { 
        "clients": [{ 
          "id": UUID, 
          "alterId": 0 
        }] 
      },
      "streamSettings": { 
        "network": "ws", 
        "wsSettings": { 
          "path": NESTED_PATH 
        } 
      }
    }],
    "outbounds": [{ "protocol": "freedom", "settings": {} }]
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  const xray = spawn(path.join(TMP_DIR, 'xray'), ['-c', CONFIG_FILE]);
  // 实时输出 Xray 日志
  xray.stdout.on('data', d => console.log(`[Xray] ${d}`));
  xray.stderr.on('data', d => console.error(`[Xray] ${d}`));

  const proxy = httpProxy.createProxyServer({
    ws: true, // 明确开启 WebSocket 支持
    xfwd: true // 转发 X-Forwarded-* 头
  });

  // 错误处理，防止代理挂掉
  proxy.on('error', (err, req, res) => {
    console.error(`[Proxy Error] ${err.message}`);
    if (res && !res.headersSent) res.end();
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const host = req.headers.host;
      const vmessInfo = {
        v: "2",
        ps: `Leapcell-${UUID.substring(0,4)}`,
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
        <h3>Vmess Debug Mode</h3>
        <p><strong>Server Time:</strong> ${new Date().toString()}</p>
        <p><strong>UUID:</strong> ${UUID}</p>
        <p><strong>Path:</strong> ${NESTED_PATH}</p>
        <textarea style="width:100%; height:100px;">${link}</textarea>
        <p>请检查客户端时间是否与服务器时间误差在 90秒 以内。</p>
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
    console.log(`[Server] 启动完成。端口: ${PORT}`);
  });
}

start();
