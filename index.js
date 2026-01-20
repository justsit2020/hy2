const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const axios = require('axios');

// --- 核心配置 ---
const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || uuidv4();
const NESTED_PATH = process.env.VMESS_PATH || '/vmess';

// Xray 下载地址
const DOWNLOAD_URL = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const TMP_DIR = '/tmp'; 
const XRAY_BIN = path.join(TMP_DIR, 'xray');
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');

console.log(`[Init] 准备启动... UUID: ${UUID}`);

// --- 下载函数 (使用 Axios，自动处理 302 跳转) ---
async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream'
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// --- 主逻辑 ---
async function startServer() {
  try {
    // 1. 检查并安装 Xray
    if (!fs.existsSync(XRAY_BIN)) {
      console.log(`[Init] 核心不存在，开始使用 Axios 下载...`);
      const zipPath = path.join(TMP_DIR, 'xray.zip');
      
      // 下载
      await downloadFile(DOWNLOAD_URL, zipPath);
      console.log(`[Init] 下载完成，正在解压...`);
      
      // 解压
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(TMP_DIR, true);
      
      // 赋予执行权限 (关键步骤)
      fs.chmodSync(XRAY_BIN, 0o755);
      console.log(`[Init] 安装并赋权成功！`);
      
      // 清理压缩包
      fs.unlinkSync(zipPath);
    } else {
      console.log(`[Init] 核心已存在，跳过下载。`);
    }

    // 2. 生成配置
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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

    // 3. 启动 Xray
    console.log(`[Start] 启动 Xray 进程...`);
    const xray = spawn(XRAY_BIN, ['-c', CONFIG_FILE]);

    xray.stdout.on('data', (data) => console.log(`[Xray] ${data}`));
    xray.stderr.on('data', (data) => console.error(`[Xray Err] ${data}`));
    xray.on('close', (code) => {
      console.error(`[Xray] 意外退出，代码: ${code}`);
      process.exit(code);
    });

    // 4. 启动 HTTP 代理 (通过健康检查)
    const proxy = httpProxy.createProxyServer({});
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Service Running via Axios!');
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
      console.log(`[Server] 服务启动成功，监听端口 ${PORT}`);
    });

  } catch (err) {
    console.error(`[Fatal Error] 发生严重错误:`, err.message);
    process.exit(1);
  }
}

startServer();
