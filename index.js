'use strict';
/*
 * Rootless Kariz launcher for Pterodactyl / Bot-Hosting (STARTUP_FILE = index.js)
 *  1) loads ./server.js (VLESS XHTTP/WS server)
 *  2) downloads the official Kariz release (checksum + signature verified)
 *  3) joins the panel with the join code, then keeps the agent running
 * Env: KARIZ_JOIN (join code), KARIZ_VERSION (e.g. v2.5.1), KARIZ_UPDATE=1 (re-download), INTERNAL_PORT
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

// Tunnel exit targets on this host: 127.0.0.1:<each port in INTERNAL_PORT>
process.env.INTERNAL_PORT = process.env.INTERNAL_PORT || '2096,2086,20443,8443,8080';
try { require('./server.js'); } catch (e) { console.error('[server.js] failed:', e.message); }

const REPO = 'Erfan-XRay/Kariz';
const DIR = path.join(__dirname, 'kariz');
const PANEL_BIN = path.join(DIR, 'kariz-panel');
const CORE_BIN = path.join(DIR, 'kariz');
const AGENT_CONF = path.join(DIR, 'agent.toml');
const JOIN = process.env.KARIZ_JOIN ||
  'kz1_eyJwIjoidC5oYW1rbS5pcjoyOTkxMyIsInQiOiI1YjBlMzhmMTY3MzJjZjQ4NjIxNzQ2NDQ5ODZkYzk5ZmM4MDk1YWJjZmI2NWNhYmQ1OGEwYTY5OGE5NjFkODc3IiwiaiI6IjY4OTYxYTIyM2JlMGUxZGNhYmYzOWJlYTdlZDg3NzBjIiwibiI6IkZpbmxhbmQyIn0';
const PUBKEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAWGxcNhmewk/DsktXLy2UgJ5ZOLS0fktw7D2/obNvjTs=\n-----END PUBLIC KEY-----\n';

const log = (...a) => console.log('[kariz]', ...a);
const env = { ...process.env, PATH: DIR + ':' + (process.env.PATH || ''), HOME: process.env.HOME || DIR };

async function get(url, json) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'kariz-launcher' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return json ? r.json() : Buffer.from(await r.arrayBuffer());
}

// minimal tar reader: returns { basename: Buffer } for regular files
function untar(buf) {
  const files = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const nm = h.toString('utf8', 0, 100).replace(/\0[\s\S]*$/, '');
    const size = parseInt(h.toString('ascii', 124, 136).replace(/\0[\s\S]*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    off += 512;
    if ((type === '0' || type === '\0') && nm) files[path.basename(nm)] = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

async function install() {
  if (fs.existsSync(PANEL_BIN) && fs.existsSync(CORE_BIN) && !process.env.KARIZ_UPDATE) return;
  fs.mkdirSync(DIR, { recursive: true });
  const arch = { x64: 'x86_64', arm64: 'aarch64', arm: 'armv7' }[process.arch];
  if (!arch) throw new Error('unsupported CPU: ' + process.arch);

  const version = process.env.KARIZ_VERSION ||
    (await get(`https://api.github.com/repos/${REPO}/releases/latest`, true)).tag_name;
  if (!version) throw new Error('could not find the latest release');
  const name = `kariz-${version}-${arch}-linux`;
  const base = `https://github.com/${REPO}/releases/download/${version}/${name}.tar.gz`;
  log('downloading', name);

  const tgz = await get(base);
  const sha = await get(base + '.sha256');
  const sig = await get(base + '.sig');

  const [want, fname] = sha.toString().trim().split(/\s+/);
  if (crypto.createHash('sha256').update(tgz).digest('hex') !== want) throw new Error('checksum mismatch');
  if (String(fname || '').replace(/^\*/, '') !== name + '.tar.gz') throw new Error('signed checksum is for another file');
  if (!crypto.verify(null, sha, PUBKEY, sig)) throw new Error('bad release signature');
  log('checksum and signature OK');

  const files = untar(zlib.gunzipSync(tgz));
  for (const f of ['kariz', 'kariz-panel']) {
    if (!files[f]) { if (f === 'kariz') throw new Error('archive has no ' + f); continue; }
    const dst = path.join(DIR, f);
    fs.writeFileSync(dst + '.new', files[f], { mode: 0o755 });
    fs.renameSync(dst + '.new', dst);
  }
  log('installed to', DIR);
}

function join() {
  if (fs.existsSync(AGENT_CONF)) return;
  log('joining the panel');
  execFileSync(PANEL_BIN, ['agent', '--join', JOIN, '--no-run', '-c', AGENT_CONF], { stdio: 'inherit', env });
}

let child = null;
function run() {
  child = spawn(PANEL_BIN, ['agent', '-c', AGENT_CONF], { stdio: 'inherit', env });
  child.on('error', (e) => { log('spawn error:', e.message); setTimeout(run, 10000); });
  child.on('exit', (code, sig) => {
    log(`agent exited (${code ?? sig}), restarting in 5s`);
    child = null;
    setTimeout(run, 5000);
  });
}

async function main() {
  // best effort: the agent may look for these directories (works only if writable)
  for (const d of ['/etc/kariz', '/etc/kariz-panel']) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
  try {
    await install();
    join();
    run();
  } catch (e) {
    console.error('[kariz] failed:', e.message, '- retrying in 30s');
    setTimeout(main, 30000);
  }
}

for (const s of ['SIGTERM', 'SIGINT']) {
  process.on(s, () => { if (child) child.kill(); process.exit(0); });
}
main();
