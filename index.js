'use strict';

const http = require('http');
const https = require('https');
const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
const httpProxy = require('http-proxy');
const AdmZip = require('adm-zip');

const HTTP_PORT = Number(process.env.PORT || 3000);              // 平台一般注入 PORT
const WS_PATH = (process.env.WS_PATH || '/ws').startsWith('/') ? (process.env.WS_PATH || '/ws') : `/${process.env.WS_PATH || 'ws'}`;
const XRAY_LOCAL_PORT = Number(process.env.XRAY_LOCAL_PORT || 10000); // 仅容器内本地使用
const UUID = process.env.UUID || crypto.randomUUID();

const INFO_USER = process.env.INFO_USER || '';
const INFO_PASS = process.env.INFO_PASS || '';

const BASE_DIR = process.env.BASE_DIR || '/tmp/vmess-ws';
const BIN_DIR = path.join(BASE_DIR, 'bin');
const XRAY_DIR = path.join(BIN_DIR, 'xray');
const XRAY_BIN = path.join(XRAY_DIR, 'xray');
const XRAY_CONFIG = path.join(BASE_DIR, 'config.json');

const CLOUDFLARED_BIN = path.join(BIN_DIR, 'cloudflared');
const ENABLE_CLOUDFLARED = (process.env.ENABLE_CLOUDFLARED || '1') !== '0'; // 默认开启 Quick Tunnel

// Xray 下载（你日志里就是这个 arm64 包；amd64 也给个常见名兜底）
function defaultXrayZipUrl() {
  if (process.platform !== 'linux') {
    return 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';
  }
  if (process.arch === 'arm64') return 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-arm64-v8a.zip';
  return 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';
}
const XRAY_ZIP_URL = process.env.XRAY_ZIP_URL || defaultXrayZipUrl();

// cloudflared 下载：Cloudflare 官方 Downloads 页面给了 Linux 各架构下载入口:contentReference[oaicite:2]{index=2}
function defaultCloudflaredUrl() {
  if (process.platform !== 'linux') {
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared';
  }
  if (process.arch === 'arm64') return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';
  return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
}
const CLOUDFLARED_URL = process.env.CLOUDFLARED_URL || defaultCloudflaredUrl();

let publicUrl = '';   // https://xxxx.trycloudflare.com
let publicHost = '';  // xxxx.trycloudflare.com
let xrayProc = null;
let cloudflaredProc = null;
let xrayReady = false;

function log(...args) {
  console.log(...args);
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function downloadToFile(url, outFile) {
  return new Promise((resolve, reject) => {
    const maxRedirects = 5;

    function go(u, redirectsLeft) {
      const req = https.get(u, (res) => {
        // follow redirects (GitHub latest/download 常见 302)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          res.resume();
          return go(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed: ${res.statusCode} ${res.statusMessage}`));
        }

        const file = fs.createWriteStream(outFile);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      });

      req.on('error', reject);
    }

    go(url, maxRedirects);
  });
}

async function ensureXray() {
  if (fs.existsSync(XRAY_BIN)) {
    log('[init] Xray exists:', XRAY_BIN);
    return;
  }
  await ensureDir(XRAY_DIR);
  const zipPath = path.join(BASE_DIR, 'xray.zip');

  log('[init] Xray not found, downloading...');
  log('[init] XRAY_ZIP_URL=' + XRAY_ZIP_URL);
  await downloadToFile(XRAY_ZIP_URL, zipPath);

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(XRAY_DIR, true);
  await fsp.chmod(XRAY_BIN, 0o755);

  log('[init] Xray ready:', XRAY_BIN);
}

async function writeXrayConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: XRAY_LOCAL_PORT,
        protocol: 'vmess',
        settings: {
          clients: [{ id: UUID, alterId: 0 }]
        },
        streamSettings: {
          network: 'ws',
          wsSettings: { path: WS_PATH }
        }
      }
    ],
    outbounds: [{ protocol: 'freedom', settings: {} }]
  };

  await ensureDir(BASE_DIR);
  await fsp.writeFile(XRAY_CONFIG, JSON.stringify(cfg, null, 2));
  log('[init] Wrote Xray config:', XRAY_CONFIG);
}

async function waitPort(host, port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const s = require('net').connect(port, host, () => {
          s.destroy();
          resolve();
        });
        s.on('error', reject);
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return false;
}

async function startXray() {
  await ensureXray();
  await writeXrayConfig();

  log('[start] starting xray on 127.0.0.1:' + XRAY_LOCAL_PORT + ' ws:' + WS_PATH);

  xrayProc = spawn(XRAY_BIN, ['run', '-c', XRAY_CONFIG], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  xrayProc.stdout.on('data', (d) => process.stdout.write('[xray] ' + d.toString()));
  xrayProc.stderr.on('data', (d) => process.stderr.write('[xray] ' + d.toString()));

  const ok = await waitPort('127.0.0.1', XRAY_LOCAL_PORT, 20000);
  xrayReady = ok;
  log(ok ? '[init] Xray port is ready' : '[warn] Xray port not ready yet');
}

async function ensureCloudflared() {
  if (fs.existsSync(CLOUDFLARED_BIN)) {
    return;
  }
  await ensureDir(BIN_DIR);
  log('[init] cloudflared not found, downloading...');
  log('[init] CLOUDFLARED_URL=' + CLOUDFLARED_URL);
  await downloadToFile(CLOUDFLARED_URL, CLOUDFLARED_BIN);
  await fsp.chmod(CLOUDFLARED_BIN, 0o755);
  log('[init] cloudflared ready:', CLOUDFLARED_BIN);
}

// 从 cloudflared 输出里抓 trycloudflare URL
function extractTryUrl(line) {
  const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return m ? m[0] : '';
}

async function startCloudflared() {
  if (!ENABLE_CLOUDFLARED) return;

  await ensureCloudflared();

  // Quick Tunnel 官方命令：cloudflared tunnel --url http://localhost:8080 :contentReference[oaicite:3]{index=3}
  const target = `http://127.0.0.1:${HTTP_PORT}`;
  log('[cf] starting quick tunnel to', target);

  cloudflaredProc = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', target], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env } // 注意：如果容器里有 .cloudflared/config.yaml，Quick Tunnel 会不工作:contentReference[oaicite:4]{index=4}
  });

  const onData = (prefix) => (buf) => {
    const s = buf.toString();
    process.stdout.write(prefix + s);

    if (!publicUrl) {
      const u = extractTryUrl(s);
      if (u) {
        publicUrl = u;
        publicHost = u.replace('https://', '');
        log('[cf] public url:', publicUrl);
        log('[node] vmess link (cloudflared):');
        log(buildVmessLink(publicHost));
      }
    }
  };

  cloudflaredProc.stdout.on('data', onData('[cloudflared] '));
  cloudflaredProc.stderr.on('data', onData('[cloudflared] '));
}

function buildVmessLink(host) {
  const obj = {
    v: '2',
    ps: 'vmess-ws-cf',
    add: host || 'YOUR_TRYCLOUDFLARE_DOMAIN',
    port: '443',
    id: UUID,
    aid: '0',
    scy: 'auto',
    net: 'ws',
    type: 'none',
    host: host || 'YOUR_TRYCLOUDFLARE_DOMAIN',
    path: WS_PATH,
    tls: 'tls'
  };
  const b64 = Buffer.from(JSON.stringify(obj)).toString('base64');
  return 'vmess://' + b64;
}

function basicAuth(req) {
  if (!INFO_USER || !INFO_PASS) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const raw = Buffer.from(h.slice(6), 'base64').toString();
  const [u, p] = raw.split(':');
  return u === INFO_USER && p === INFO_PASS;
}

async function main() {
  await ensureDir(BASE_DIR);
  await ensureDir(BIN_DIR);

  const app = express();

  app.get('/kaithhealth', (_req, res) => res.status(200).send('ok'));

  // 避免有人用浏览器直接 GET /ws 导致 Xray 看到“非 VMess 数据”
  app.all(WS_PATH, (req, res) => {
    // 只允许 WebSocket upgrade
    if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      return res.status(426).send('Upgrade Required');
    }
    return res.status(400).send('Bad Request');
  });

  app.get('/info', (req, res) => {
    if (!basicAuth(req)) {
      res.set('WWW-Authenticate', 'Basic realm="info"');
      return res.status(401).send('Auth required');
    }
    res.json({
      httpPort: HTTP_PORT,
      wsPath: WS_PATH,
      xrayLocalPort: XRAY_LOCAL_PORT,
      uuid: UUID,
      cloudflaredEnabled: ENABLE_CLOUDFLARED,
      publicUrl,
      vmess: publicHost ? buildVmessLink(publicHost) : '(waiting cloudflared url...)'
    });
  });

  app.get('/sub', (req, res) => {
    if (!basicAuth(req)) {
      res.set('WWW-Authenticate', 'Basic realm="sub"');
      return res.status(401).send('Auth required');
    }
    const link = publicHost ? buildVmessLink(publicHost) : '';
    const body = Buffer.from(link ? (link + '\n') : '').toString('base64');
    res.type('text/plain').send(body);
  });

  const server = http.createServer(app);

  const proxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${XRAY_LOCAL_PORT}`,
    ws: true
  });

  proxy.on('error', (err, _req, _res) => {
    console.error('[proxy] error:', err && err.message ? err.message : err);
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== WS_PATH) {
      socket.destroy();
      return;
    }
    if (!xrayReady) {
      // xray 没就绪，直接拒绝，避免 ECONNREFUSED + 平台反代报错
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    proxy.ws(req, socket, head);
  });

  server.listen(HTTP_PORT, '0.0.0.0', async () => {
    log('[http] listening on :' + HTTP_PORT);
    log('[http] ws path:', WS_PATH);

    if (!INFO_USER || !INFO_PASS) {
      log('[http] WARNING: /info & /sub are PUBLIC. Set INFO_USER/INFO_PASS to protect them.');
    }

    // 先起 xray，再起 cloudflared，减少你之前看到的 ECONNREFUSED
    await startXray();

    // 你要用 cloudflared：它会在日志里打印 trycloudflare.com 链接:contentReference[oaicite:5]{index=5}
    await startCloudflared();

    // 兜底：如果你还想先看到一个“当前配置”的占位
    log('[node] uuid:', UUID);
    log('[node] waiting for cloudflared url... (check logs or /info)');
  });
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
