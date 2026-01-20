const fs = require('fs');
const https = require('https');
const { spawn, execSync } = require('child_process');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');

// --- 基础配置 ---
const PORT = process.env.PORT || 3000;
const UUID = (process.env.UUID || '4a03e390-8438-4e86-9a06-7e3e7f4c3912').trim();
let NESTED_PATH = (process.env.VMESS_PATH || '/vless').trim();
if (!NESTED_PATH.startsWith('/')) NESTED_PATH = '/' + NESTED_PATH;

const TMP_DIR = '/tmp';
const CONFIG_FILE = path.join(TMP_DIR, 'config.json');

// 直接锁定 ARM64 (既然之前日志验证了是 ARM)
const URL_ARM = 'https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-arm64-v8a.zip';

console.log(`[Init] 启动直连模式... 架构: ARM64`);
console.log(`[Init] 端口: ${PORT}`);
console.log(`[Init] UUID: ${UUID}`);

// --- 下载函数 ---
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

// --- 主程序 ---
async function start() {
  const binPath = path.join(TMP_DIR, 'xray');
  const zipPath = path.join(TMP_DIR, `xray.zip`);

  // 1. 下载安装
  try {
    if (fs.existsSync(binPath)) fs.unlinkSync(binPath); // 强制重下，确保文件干净
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
      "port": parseInt(PORT), // 直接监听环境变量提供的端口
      "listen": "0.0.0.0",
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

  // 3. 生成并打印链接 (关键！)
  // 由于没有网页了，必须把链接打印到日志里，用户自己复制
  // 此时 host 只能用环境变量或者用户自己填
  const host = process.env.LEAPCELL_APP_URL ? process.env.LEAPCELL_APP_URL.replace('https://', '').replace('/', '') : "你的域名.leapcell.app";
  
  const vlessLink = `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=${encodeURIComponent(NESTED_PATH)}#Leapcell-Direct`;

  console.log(`\n=========================================================`);
  console.log(`✅ 节点配置已生成 (请复制下方链接):`);
  console.log(`---------------------------------------------------------`);
  console.log(`${vlessLink}`);
  console.log(`---------------------------------------------------------`);
  console.log(`如果上方链接中的域名不正确，请手动将 '你的域名.leapcell.app' 替换为你真实的网址。`);
  console.log(`=========================================================\n`);

  // 4. 启动 Xray
  console.log(`[Start] Xray 接管端口 ${PORT}...`);
  const xray = spawn(binPath, ['-c', CONFIG_FILE], { stdio: 'inherit' });
  
  xray.on('close', (code) => {
    console.log(`Xray 退出: ${code}`);
    process.exit(code);
  });
}

start();
