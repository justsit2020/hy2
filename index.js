const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// --- 核心配置 ---
const PORT = process.env.PORT || 3000;
const UUID = process.env.UUID || uuidv4();
const NESTED_PATH = process.env.VMESS_PATH || '/vmess';

// Xray 下载地址 (根据需要修改版本)
const DOWNLOAD_URL = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip';
const TMP_DIR = '/tmp'; // Serverless 环境唯一可写目录
const XRAY_BIN = path.join(TMP_DIR, 'xray');
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');

console.log(`[Init] 准备启动... UUID: ${UUID}`);

// --- 辅助函数：下载文件 ---
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`下载失败，状态码: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// --- 主逻辑 ---
async function startServer() {
  try {
    // 1. 检查并安装 Xray
    if (!fs.existsSync(XRAY_BIN)) {
      console.log(`[Init] Xray 不存在，正在下载: ${DOWNLOAD_URL}`);
      const zipPath = path.join(TMP_DIR, 'xray.zip');
      
      // 下载
      await downloadFile(DOWNLOAD_URL, zipPath);
      console.log(`[Init] 下载完成，正在解压...`);
      
      // 解压
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(TMP_DIR, true);
      
      // 赋予执行权限 (关键)
      fs.chmodSync(XRAY_BIN, 0o755);
      console.log(`[Init] 安装成功！`);
      
      // 清理
      fs.unlinkSync(zipPath);
    } else {
      console.log(`[Init] Xray 已存在，跳过下载。`);
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

    // 3. 启动 Xray 进程
    console.log(`[Start] 启动 Xray...`);
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
        res.end('Service Running');
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
      console.log(`[Server] 服务已就绪，监听端口 ${PORT}`);
    });

  } catch (err) {
    console.error(`[Fatal Error] 启动失败:`, err);
    process.exit(1);
  }
}

// 执行启动
startServer();
