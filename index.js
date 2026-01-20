const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// --- 基础配置 ---
const PORT = process.env.PORT || 3000;
// 固定 UUID，防止变化
const UUID = (process.env.UUID || '88888888-4444-4444-4444-123456789012').trim();
let NESTED_PATH = (process.env.VMESS_PATH || '/vmess').trim();
if (!NESTED_PATH.startsWith('/')) NESTED_PATH = '/' + NESTED_PATH;

const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');

// 锁定 ARM64
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

console.log(`[Init] 启动直连模式 (ARM64)...`);

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

async function start() {
  const binPath = path.join(TMP_DIR, 'xray');
  const zipPath = path.join(TMP_DIR, `xray.zip`);

  // 1. 下载安装
  try {
    if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
    console.log(`[Download] 下载 Xray...`);
    await downloadFile(URL_ARM, zipPath);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(TMP_DIR, true);
    fs.chmodSync(binPath, 0o755);
    fs.unlinkSync(zipPath);
    console.log(`[Success] 安装完毕`);
  } catch (e) {
    console.error(`[Fatal] 下载失败: ${e.message}`);
    process.exit(1);
  }

  // 2. 生成配置 (Xray 直接监听 PORT)
  const config = {
    "log": { "loglevel": "warning" },
    "inbounds": [{
      "port": parseInt(PORT), // 关键：直接监听系统分配端口
      "listen": "0.0.0.0",
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

  // 3. 打印连接信息 (这是你唯一获取链接的地方)
  const host = process.env.LEAPCELL_APP_URL ? process.env.LEAPCELL_APP_URL.replace('https://', '').replace('/', '') : "你的域名.leapcell.app";
  
  const vmessInfo = {
    v: "2",
    ps: "Leapcell-Direct",
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

  console.log(`\n=========================================================`);
  console.log(`✅ 节点链接 (复制下方内容):`);
  console.log(`---------------------------------------------------------`);
  console.log(`${link}`);
  console.log(`---------------------------------------------------------`);
  console.log(`如果上方链接无法使用，请检查客户端配置:`);
  console.log(`地址: ${host}`);
  console.log(`端口: 443`);
  console.log(`UUID: ${UUID}`);
  console.log(`传输: ws`);
  console.log(`路径: ${NESTED_PATH}`);
  console.log(`TLS:  开启 (必须开启!)`);
  console.log(`=========================================================\n`);

  // 4. 启动 Xray
  // 关键：禁用 AEAD 强制验证，防止 unexpected EOF
  const env = Object.assign({}, process.env, { XRAY_VMESS_AEAD_FORCED: "false" });
  
  console.log(`[Start] Xray 直接接管端口 ${PORT}...`);
  const xray = spawn(binPath, ['-c', CONFIG_FILE], { env, stdio: 'inherit' });
  
  xray.on('close', (code) => {
    console.log(`Xray 退出: ${code}`);
    process.exit(code);
  });
}

start();
