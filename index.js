// index.js — runs the official Kariz agent (kariz-panel) on a host without root/systemd, and
// loads xray.js (Xray with xray-config.json) when that file is next to it.
// No dependencies, Node 18+.
//
// First run:
//   1) In the Kariz panel: Servers -> Add server -> copy the join code (starts with kz1_).
//   2) Put ONLY that code in a file named join_code.txt next to this file (or set JOIN_CODE).
//   3) Start the server. It downloads Kariz, joins the panel, deletes join_code.txt and runs the agent.
// Next runs: it just starts the agent (settings live in ./kariz/agent.toml, which must persist).
//
// Optional env: KARIZ_VERSION (e.g. v2.7.1), KARIZ_UPDATE=1 (re-download), KARIZ_DIR.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

// VLESS server (server.js, next to this file) runs in the same process.
process.env.INTERNAL_PORT = process.env.INTERNAL_PORT || '2096,2086,20443,8443,8080';
try { require(path.join(__dirname, 'server.js')); } catch (e) { console.error('[server.js] failed:', e.message); }

const REPO = 'Erfan-XRay/Kariz';
const BASE = process.env.KARIZ_DIR || path.join(process.cwd(), 'kariz');
const BIN = path.join(BASE, 'bin');
// Binaries live in BASE/bin (inside the image, may be read-only). Everything the agent WRITES
// (agent.toml, tunnel settings, state, systemctl stand-in) goes to a writable data dir:
// KARIZ_DATA, else BASE, else /data, else /tmp/kariz-data.
function pickDataDir() {
  const cands = [process.env.KARIZ_DATA, BASE, '/data', '/tmp/kariz-data'].filter(Boolean);
  for (const d of cands) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const t = path.join(d, '.w' + process.pid);
      fs.writeFileSync(t, 'x');
      fs.unlinkSync(t);
      return d;
    } catch (_) { /* not writable, try the next one */ }
  }
  return BASE;
}
const DATA = pickDataDir();
const CONF = path.join(DATA, 'agent.toml');
const CODE_FILE = path.join(process.cwd(), 'join_code.txt');
// Where the agent keeps tunnel settings (it wants /etc/kariz, which a non-root host cannot write).
const KZ_ETC = path.join(DATA, 'etc');
const KZ_STATE = path.join(DATA, 'state');
// Prefer the stand-in shipped inside the image (kariz/bin/systemctl): the data dir may be mounted noexec.
const SHIM_DIR = fs.existsSync(path.join(BIN, 'systemctl')) ? BIN : path.join(DATA, 'bin');
const SHIM = path.join(SHIM_DIR, 'systemctl');

// Kariz's release signing key (same one the official install script pins).
const RELEASE_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWGxcNhmewk/DsktXLy2UgJ5ZOLS0fktw7D2/obNvjTs=
-----END PUBLIC KEY-----
`;

function log(...a) { console.log('[kariz-launcher]', ...a); }
function fail(msg) { console.error('[kariz-launcher] ERROR:', msg); process.exit(1); }

function httpGetOnce(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'kariz-launcher', Accept: '*/*' }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpGetOnce(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Retries on temporary network/DNS errors (EAI_AGAIN etc.): some hosts bring the network up a few seconds after start.
async function httpGet(url, redirects = 5, timeout) {
  const temp = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'];
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try { return await httpGetOnce(url, redirects, timeout); }
    catch (e) {
      lastErr = e;
      const retryable = temp.includes(e.code) || /timeout|socket hang up/i.test(e.message) || /HTTP (5\d\d|429)/.test(e.message);
      if (!retryable) throw e;
      const wait = Math.min(3000 * (i + 1), 15000);
      console.error(`[net] ${e.code || e.message} for ${url} - retry ${i + 1}/10 in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// minimal tar reader: { basename: Buffer } for regular files (no external `tar` needed)
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

async function ensureBinaries() {
  const panelBin = path.join(BIN, 'kariz-panel');
  const coreBin = path.join(BIN, 'kariz');
  if (!fs.existsSync(panelBin) && !process.env.KARIZ_UPDATE &&
      fs.existsSync(path.join(BASE, 'kariz-panel')) && fs.existsSync(path.join(BASE, 'kariz'))) {
    fs.mkdirSync(BIN, { recursive: true });
    for (const b of ['kariz', 'kariz-panel']) fs.copyFileSync(path.join(BASE, b), path.join(BIN, b));
    log('Copied the existing binaries into', BIN);
  }
  if (fs.existsSync(panelBin) && fs.existsSync(coreBin) && !process.env.KARIZ_UPDATE) {
    for (const b of [panelBin, coreBin]) { try { fs.chmodSync(b, 0o755); } catch (_) {} }
    log('Using the Kariz binaries already in', BIN);
    return;
  }

  const arch = { x64: 'x86_64', arm64: 'aarch64', arm: 'armv7' }[process.arch];
  if (!arch) fail('No Kariz build for CPU ' + process.arch);

  let tag = process.env.KARIZ_VERSION;
  if (!tag) {
    const meta = JSON.parse((await httpGet(`https://api.github.com/repos/${REPO}/releases/latest`)).toString());
    tag = meta.tag_name;
  }
  if (!tag) fail('Could not find the latest release.');
  log('Downloading Kariz', tag, arch);

  const name = `kariz-${tag}-${arch}-linux`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${name}.tar.gz`;
  const tgz = await httpGet(url);
  const sha = await httpGet(url + '.sha256');
  let sig;
  try { sig = await httpGet(url + '.sig'); } catch (e) { fail('This release has no signature, so it will not be installed.'); }

  // 1) the checksum file must be signed by the Kariz release key
  if (!crypto.verify(null, sha, RELEASE_KEY_PEM, sig)) fail('Signature does not match the Kariz release key. Nothing installed.');
  // 2) the signed checksum must be for this archive, and match what we downloaded
  const [expected, fname] = sha.toString().trim().split(/\s+/);
  if ((fname || '').replace(/^\*/, '') !== name + '.tar.gz') fail('The signed checksum is for another file.');
  const actual = crypto.createHash('sha256').update(tgz).digest('hex');
  if (actual !== expected.toLowerCase()) fail('Checksum mismatch: the download is damaged.');
  log('Signature and checksum are good.');

  fs.mkdirSync(BIN, { recursive: true });
  const files = untar(zlib.gunzipSync(tgz));
  for (const b of ['kariz', 'kariz-panel']) {
    if (!files[b]) fail(`${b} is not in the archive.`);
    const dst = path.join(BIN, b);
    fs.writeFileSync(dst + '.new', files[b], { mode: 0o755 });
    fs.renameSync(dst + '.new', dst);
  }
  log('Installed into', BIN);
}

function childEnv() {
  return {
    ...process.env,
    PATH: SHIM_DIR + ':' + BIN + ':' + (process.env.PATH || ''),
    HOME: DATA,
    KZ_BIN: BIN,
    KZ_DIR: KZ_ETC,
    KZ_STATE: KZ_STATE,
  };
}

function joinIfNeeded() {
  if (fs.existsSync(CONF)) return;
  let code = (process.env.JOIN_CODE || '').trim();
  if (!code && fs.existsSync(CODE_FILE)) code = fs.readFileSync(CODE_FILE, 'utf8').trim();
  if (!code.startsWith('kz1_')) {
    fail('No agent settings yet and no join code. Create a code in the panel (Servers -> Add server), ' +
      'put it in join_code.txt, then restart.');
  }
  log('Joining the panel...');
  const r = spawnSync(path.join(BIN, 'kariz-panel'), ['agent', '--join', code, '--no-run', '-c', CONF], {
    stdio: 'inherit', env: childEnv(), cwd: DATA,
  });
  if (r.status !== 0) fail('Joining failed (the code is single-use and expires: make a fresh one).');
  try { fs.unlinkSync(CODE_FILE); } catch (_) {}
  log('Joined. join_code.txt removed.');
}


// A stand-in for `systemctl` (this host has no systemd). The agent starts and stops tunnels with
// `systemctl ... kariz@NAME`; the stand-in runs `kariz run -c <etc>/NAME.toml` instead.
const SHIM_SCRIPT = String.raw`#!/bin/bash
BIN_DIR="$KZ_BIN"
CONF_DIR="$KZ_DIR"
STATE="$KZ_STATE"
mkdir -p "$STATE"
echo "$(date +%T) systemctl $*" >> "$STATE/systemctl.log"

verb=""; now=0; skip=0; units=""
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    --now) now=1 ;;
    -s) skip=1 ;;
    -*) ;;
    *) if [ -z "$verb" ]; then verb="$a"; else units="$units $a"; fi ;;
  esac
done

name_of() {
  u=$(printf '%s' "$1" | sed 's/\.service$//')
  case "$u" in
    kariz@*) printf '%s' "$u" | sed 's/^kariz@//' ;;
  esac
}
pidf() { echo "$STATE/$1.pid"; }
alive() {
  [ -f "$(pidf "$1")" ] && kill -0 "$(cat "$(pidf "$1")")" 2>/dev/null
}
start_one() {
  n="$1"
  rm -f "$STATE/$n.stopped"
  if alive "$n"; then return 0; fi
  if [ ! -f "$CONF_DIR/$n.toml" ]; then echo "kariz-systemctl: no config for $n" >&2; return 1; fi
  nohup "$BIN_DIR/kariz" run -c "$CONF_DIR/$n.toml" </dev/null >>"$STATE/$n.log" 2>&1 &
  echo $! > "$(pidf "$n")"
  sleep 1
  alive "$n"
}
stop_one() {
  n="$1"
  touch "$STATE/$n.stopped"
  if alive "$n"; then
    p=$(cat "$(pidf "$n")")
    kill "$p" 2>/dev/null
    i=0
    while [ "$i" -lt 20 ] && kill -0 "$p" 2>/dev/null; do sleep 0.2; i=$((i+1)); done
    kill -9 "$p" 2>/dev/null
  fi
  rm -f "$(pidf "$n")"
}

rc=0
case "$verb" in
  start|restart|reload|reload-or-restart|try-restart)
    for u in $units; do
      n=$(name_of "$u"); [ -n "$n" ] || continue
      if [ "$verb" != start ]; then stop_one "$n"; fi
      start_one "$n" || rc=1
    done ;;
  enable)
    if [ "$now" = 1 ]; then
      for u in $units; do n=$(name_of "$u"); [ -n "$n" ] || continue; start_one "$n" || rc=1; done
    fi ;;
  stop)
    for u in $units; do n=$(name_of "$u"); [ -n "$n" ] || continue; stop_one "$n"; done ;;
  disable)
    if [ "$now" = 1 ]; then
      for u in $units; do n=$(name_of "$u"); [ -n "$n" ] || continue; stop_one "$n"; done
    fi ;;
  is-active)
    for u in $units; do
      n=$(name_of "$u")
      if [ -n "$n" ] && alive "$n"; then echo active; else echo inactive; rc=3; fi
    done ;;
  is-enabled) echo enabled ;;
  list-units|list-unit-files)
    for f in "$STATE"/*.pid; do
      [ -e "$f" ] || continue
      n=$(basename "$f" .pid)
      if alive "$n"; then echo "kariz@$n.service loaded active running Kariz tunnel $n"; fi
    done ;;
  *) ;;
esac
exit $rc
`;

function writeShim() {
  fs.mkdirSync(KZ_ETC, { recursive: true });
  fs.mkdirSync(KZ_STATE, { recursive: true });
  if (SHIM_DIR === BIN && fs.existsSync(SHIM)) {
    // Shipped with the image; the folder may be read-only, so only try to set the exec bit.
    try { fs.chmodSync(SHIM, 0o755); } catch (_) {}
    return;
  }
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  fs.writeFileSync(SHIM, SHIM_SCRIPT, { mode: 0o755 });
  fs.chmodSync(SHIM, 0o755);
}

// Points the agent's tunnel settings at a folder we can write.
function patchConf() {
  let t = fs.readFileSync(CONF, 'utf8');
  const want = 'kariz_dir = "' + KZ_ETC + '"';
  if (/^kariz_dir\s*=.*$/m.test(t)) {
    if (t.includes(want)) return;
    t = t.replace(/^kariz_dir\s*=.*$/m, () => want);
  } else {
    t += '\n' + want + '\n';
  }
  fs.writeFileSync(CONF, t);
  log('agent.toml: tunnel settings folder is now', KZ_ETC);
}

// Starts every tunnel that has settings and was not stopped on purpose (after a restart, or a crash).
function superviseTunnels() {
  let files = [];
  try { files = fs.readdirSync(KZ_ETC).filter((f) => f.endsWith('.toml')); } catch (_) { return; }
  for (const f of files) {
    const n = f.slice(0, -5);
    if (fs.existsSync(path.join(KZ_STATE, n + '.stopped'))) continue;
    spawnSync(SHIM, ['start', 'kariz@' + n], { env: childEnv(), timeout: 15000 });
  }
}

// Shows new lines of the tunnels' logs (and of the systemctl stand-in) in the console.
const logOffsets = {};
function pumpLogs() {
  let files = [];
  try { files = fs.readdirSync(KZ_STATE).filter((f) => f.endsWith('.log')); } catch (_) { return; }
  for (const f of files) {
    try {
      const p = path.join(KZ_STATE, f);
      const size = fs.statSync(p).size;
      if (!(f in logOffsets)) logOffsets[f] = Math.max(0, size - 1500);
      if (size < logOffsets[f]) logOffsets[f] = 0;
      if (size <= logOffsets[f]) continue;
      const len = Math.min(size - logOffsets[f], 4000);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(p, 'r');
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      logOffsets[f] = size;
      // The systemctl stand-in logs a line every 2 s (is-active checks): hide those so they don't bury Xray's logs.
      const lines = buf.toString().trimEnd().split('\n').filter((l) => !(f === 'systemctl.log' && /is-active|is-enabled/.test(l)));
      if (lines.length) console.log(lines.map((l) => `[${f}] ${l}`).join('\n'));
    } catch (_) {}
  }
}

// What the agent will use, for diagnosing a failing tunnel setup (secret values hidden).
function debugInfo() {
  try {
    if (fs.existsSync(CONF)) {
      const red = fs.readFileSync(CONF, 'utf8').split('\n').map((l) => {
        const m = l.match(/^(\s*[\w.-]+\s*=\s*)(.*)$/);
        return m && /token|secret|key|pass|code|join|auth/i.test(m[1]) ? m[1] + '"<hidden>"' : l;
      }).join('\n');
      console.log('[kariz-launcher] agent.toml (secret values hidden):\n' + red);
    }
    for (const f of fs.existsSync(KZ_ETC) ? fs.readdirSync(KZ_ETC).filter((n) => n.endsWith('.toml')) : []) {
      const red = fs.readFileSync(path.join(KZ_ETC, f), 'utf8').split('\n').map((l) => {
        const m = l.match(/^(\s*[\w.-]+\s*=\s*)(.*)$/);
        return m && /token|secret|key|pass|psk|auth|cert/i.test(m[1]) ? m[1] + '"<hidden>"' : l;
      }).join('\n');
      console.log(`[kariz-launcher] tunnel settings ${f} (secret values hidden):\n` + red);
    }
  } catch (e) {
    console.log('[kariz-launcher] debug info failed:', e.message);
  }
}


let child = null;
let delay = 2000;
function runAgent() {
  const t0 = Date.now();
  let handled = false;
  const again = (why) => {
    if (handled) return;
    handled = true;
    delay = Date.now() - t0 > 60000 ? 2000 : Math.min(delay * 2, 60000);
    console.error(`[kariz-launcher] agent stopped (${why}); restarting in ${Math.round(delay / 1000)}s`);
    setTimeout(runAgent, delay);
  };
  child = spawn(path.join(BIN, 'kariz-panel'), ['agent', '-c', CONF], { stdio: 'inherit', env: childEnv(), cwd: DATA });
  child.on('error', (e) => again(e.message));
  child.on('exit', (c, s) => again(c !== null ? 'exit ' + c : s));
  log('Agent started (pid ' + child.pid + ')');
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { if (child) child.kill(sig); setTimeout(() => process.exit(0), 500); });
}

(async () => {
  try { fs.mkdirSync(BASE, { recursive: true }); } catch (_) {}
  log('Data dir (writable):', DATA);
  try {
    await ensureBinaries();
  } catch (e) {
    fail('Download failed: ' + e.message);
  }
  joinIfNeeded();
  writeShim();
  {
    const t = spawnSync(SHIM, ['is-enabled', 'kariz@selftest'], { env: childEnv(), timeout: 10000 });
    log('systemctl stand-in (' + SHIM + '):', t.error ? 'CANNOT RUN: ' + t.error.code : 'ok');
  }
  patchConf();
  superviseTunnels();
  if (!process.env.NO_DEBUG) debugInfo();
  runAgent();
  setInterval(superviseTunnels, 15000);
  setInterval(pumpLogs, 5000);
})();
