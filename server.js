'use strict';
/*
 * VLESS server in pure Node.js (only dep: ws)
 * Transports: XHTTP (packet-up / stream-up / stream-one) + WebSocket
 * Env: PORT|SERVER_PORT, UUID, DOMAIN, XHTTP_PATH, WS_PATH, BLOCK_PRIVATE=0
 */
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');

const PORT = +(process.env.SERVER_PORT || process.env.PORT || 3000);
const UUID = (process.env.UUID || 'b3c1a7e4-5d2f-4c8a-9e61-7f0d2a4b8c13').toLowerCase();
const DOMAIN = process.env.DOMAIN || 'qy.manob.ir';
const XHTTP_PATH = process.env.XHTTP_PATH || '/xh';
const WS_PATH = process.env.WS_PATH || '/ws';
const BLOCK_PRIVATE = process.env.BLOCK_PRIVATE !== '0';

const UUID_BUF = Buffer.from(UUID.replace(/-/g, ''), 'hex');
const EMPTY = Buffer.alloc(0);
const MAX_POST = 2 * 1024 * 1024; // max size of one packet-up POST
const MAX_PENDING = 64;           // max out-of-order packets buffered per session
const MAX_SESSIONS = 5000;
const SESSION_WAIT = 30000;       // ms to wait for the download GET

// ---------------------------------------------------------------- helpers
function isPrivate(h) {
  if (!BLOCK_PRIVATE) return false;
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 0 || a === 127 || a === 10 || (a === 169 && b === 254) ||
      (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (net.isIPv6(h)) {
    const l = h.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd');
  }
  return false;
}

// ---------------------------------------------------------------- VLESS core
// t = transport: { eager, write(buf)->bool, drain(cb), close() }
function createVless(t) {
  let state = 0; // 0 = header, 1 = tcp, 2 = udp
  let buf = EMPTY, remote = null, udp = null, ver = 0;
  let hdrSent = false, closed = false;
  let udpBuf = EMPTY, udpHost = '', udpPort = 0, udpTimer = null;

  const out = (data) => {
    if (!hdrSent) {
      hdrSent = true;
      const h = Buffer.from([ver, 0]);
      data = data ? Buffer.concat([h, data]) : h;
    }
    return t.write(data);
  };

  const destroy = () => {
    if (closed) return;
    closed = true;
    clearTimeout(udpTimer);
    if (remote) remote.destroy();
    if (udp) { try { udp.close(); } catch {} }
    t.close();
  };

  function startTcp(host, port, rest) {
    state = 1;
    remote = net.connect({ host, port });
    remote.setNoDelay(true);
    const to = setTimeout(destroy, 10000);
    remote.once('connect', () => { clearTimeout(to); if (t.eager) out(); });
    remote.on('data', (d) => {
      if (!out(d)) { remote.pause(); t.drain(() => remote.resume()); }
    });
    remote.on('error', destroy);
    remote.on('close', () => { clearTimeout(to); destroy(); });
    if (rest.length) remote.write(rest);
    return true;
  }

  function startUdp(host, port, rest) {
    state = 2;
    udpHost = host; udpPort = port;
    udp = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    const touch = () => { clearTimeout(udpTimer); udpTimer = setTimeout(destroy, 60000); };
    touch();
    udp.on('message', (m) => {
      touch();
      const h = Buffer.alloc(2); h.writeUInt16BE(m.length);
      out(Buffer.concat([h, m]));
    });
    udp.on('error', destroy);
    if (t.eager) out();
    return rest.length ? udpIn(rest) : true;
  }

  function udpIn(chunk) {
    udpBuf = udpBuf.length ? Buffer.concat([udpBuf, chunk]) : chunk;
    while (udpBuf.length >= 2) {
      const l = udpBuf.readUInt16BE(0);
      if (udpBuf.length < 2 + l) break;
      udp.send(udpBuf.subarray(2, 2 + l), udpPort, udpHost);
      udpBuf = udpBuf.subarray(2 + l);
    }
    return true;
  }

  function parseHeader() {
    if (buf.length < 18) return true;
    if (!buf.subarray(1, 17).equals(UUID_BUF)) { console.log('[reject] wrong UUID'); destroy(); return true; }
    ver = buf[0];
    let p = 18 + buf[17];
    if (buf.length < p + 4) return true;
    const cmd = buf[p];
    if (cmd !== 1 && cmd !== 2) {
      console.log('[reject] unsupported command', cmd, cmd === 3 ? '(Mux/xudp: turn Mux off in the outbound that connects here)' : '');
      destroy(); return true;
    }
    const port = buf.readUInt16BE(p + 1);
    const at = buf[p + 3];
    p += 4;
    let host;
    if (at === 1) {
      if (buf.length < p + 4) return true;
      host = `${buf[p]}.${buf[p + 1]}.${buf[p + 2]}.${buf[p + 3]}`;
      p += 4;
    } else if (at === 2) {
      if (buf.length < p + 1) return true;
      const l = buf[p];
      if (buf.length < p + 1 + l) return true;
      host = buf.toString('utf8', p + 1, p + 1 + l);
      p += 1 + l;
    } else if (at === 3) {
      if (buf.length < p + 16) return true;
      const g = [];
      for (let i = 0; i < 8; i++) g.push(buf.readUInt16BE(p + i * 2).toString(16));
      host = g.join(':');
      p += 16;
    } else { console.log('[reject] bad address type', at, 'cmd', cmd); destroy(); return true; }

    const rest = buf.subarray(p);
    buf = EMPTY;
    if (isPrivate(host)) { console.log('[reject] private/blocked destination', host); destroy(); return true; }
    if (process.env.DEBUG) console.log('[conn] cmd', cmd, host + ':' + port);
    if (cmd === 1) return startTcp(host, port, rest);
    if (cmd === 2) return startUdp(host, port, rest);
    console.log('[reject] unsupported command', cmd, '(3 = Mux: turn Mux/xudp off on the client)');
    destroy(); // mux (cmd 3) is not supported -> disable Mux on the client
    return true;
  }

  return {
    // returns false when the caller should pause its source and wait for drain()
    onData(chunk) {
      if (closed) return true;
      if (state === 1) return remote.write(chunk);
      if (state === 2) return udpIn(chunk);
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      return parseHeader();
    },
    drain(cb) { if (remote && !closed) remote.once('drain', cb); else cb(); },
    endInput() { if (state === 1 && remote && !closed) remote.end(); },
    destroy,
  };
}

// ---------------------------------------------------------------- XHTTP
const sessions = new Map();
let oneCounter = 0;

function makeSession(id) {
  const s = { id, res: null, queue: [], next: 0, pending: new Map(), vless: null, dead: false, timer: null };
  s.vless = createVless({
    eager: true,
    write: (b) => { if (s.res) return s.res.write(b); s.queue.push(b); return true; },
    drain: (cb) => { if (s.res) s.res.once('drain', cb); else cb(); },
    close: () => killSession(s),
  });
  s.timer = setTimeout(() => killSession(s), SESSION_WAIT);
  sessions.set(id, s);
  return s;
}

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) return null;
    s = makeSession(id);
  }
  return s;
}

function killSession(s) {
  if (s.dead) return;
  s.dead = true;
  clearTimeout(s.timer);
  sessions.delete(s.id);
  s.vless.destroy();
  if (s.res && !s.res.writableEnded) s.res.end();
  s.pending.clear();
  s.queue = [];
}

function baseHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST',
    'X-Padding': '0'.repeat(100 + ((Math.random() * 900) | 0)),
  };
}

function attachDownload(s, res) {
  if (s.res) return false;
  s.res = res;
  clearTimeout(s.timer);
  res.writeHead(200, {
    ...baseHeaders(),
    'Content-Type': 'text/event-stream',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  for (const b of s.queue) res.write(b);
  s.queue = [];
  res.on('close', () => killSession(s));
  return true;
}

function pipeUpload(s, req) {
  req.on('data', (c) => {
    if (!s.vless.onData(c)) {
      req.pause();
      s.vless.drain(() => req.resume());
    }
  });
  req.on('end', () => s.vless.endInput());
  req.on('error', () => killSession(s));
}

function reply(res, code, body) {
  res.writeHead(code, { ...baseHeaders(), 'Content-Type': 'text/plain' });
  res.end(body || '');
}

function handleXhttp(req, res, rest) {
  const parts = rest.split('/').filter(Boolean);
  const m = req.method;

  if (m === 'OPTIONS') return reply(res, 200);

  // stream-one: POST /path  (upload + download in the same request)
  if (parts.length === 0) {
    if (m !== 'POST') return reply(res, 404);
    const s = makeSession('one-' + oneCounter++);
    attachDownload(s, res);
    pipeUpload(s, req);
    return;
  }

  const sid = parts[0];

  if (parts.length === 1) {
    // download: GET /path/<sid>
    if (m === 'GET') {
      const s = getSession(sid);
      if (!s) return reply(res, 503);
      if (!attachDownload(s, res)) return reply(res, 409);
      return;
    }
    // stream-up: POST /path/<sid>  (long-lived upload body)
    if (m === 'POST') {
      const s = getSession(sid);
      if (!s) return reply(res, 503);
      res.writeHead(200, baseHeaders());
      res.flushHeaders();
      pipeUpload(s, req);
      req.on('end', () => res.end());
      return;
    }
    return reply(res, 405);
  }

  // packet-up: POST /path/<sid>/<seq>
  if (parts.length === 2 && m === 'POST') {
    const seq = parseInt(parts[1], 10);
    if (!(seq >= 0)) return reply(res, 400);
    const s = getSession(sid);
    if (!s) return reply(res, 503);

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_POST) { reply(res, 413); req.destroy(); killSession(s); return; }
      chunks.push(c);
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (res.headersSent || s.dead) return reply(res, s.dead ? 410 : 200);
      if (seq < s.next || s.pending.has(seq)) return reply(res, 200); // duplicate
      s.pending.set(seq, chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
      if (s.pending.size > MAX_PENDING) { killSession(s); return reply(res, 400); }

      let ok = true;
      while (s.pending.has(s.next)) {
        const b = s.pending.get(s.next);
        s.pending.delete(s.next);
        s.next++;
        if (!s.vless.onData(b)) ok = false;
      }
      res.writeHead(200, baseHeaders());
      if (ok) res.end(); else s.vless.drain(() => res.end());
    });
    return;
  }

  reply(res, 404);
}

// ---------------------------------------------------------------- HTTP + WS server
function onRequest(req, res) {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === XHTTP_PATH || url.startsWith(XHTTP_PATH + '/')) {
    return handleXhttp(req, res, url.slice(XHTTP_PATH.length));
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE html><html><head><title>Welcome</title></head><body><h1>It works!</h1></body></html>');
}

function makeServer() {
  const s = http.createServer(onRequest);
  s.keepAliveTimeout = 120000;
  s.headersTimeout = 65000;
  s.requestTimeout = 0;
  s.timeout = 0;
  s.on('upgrade', onUpgrade);
  return s;
}

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 8 * 1024 * 1024,
  handleProtocols: (p) => p.values().next().value,
});

function onUpgrade(req, socket, head) {
  const path = (req.url || '').split('?')[0];
  if (path !== WS_PATH) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => onWs(ws, req));
}

function onWs(ws, req) {
  if (ws._socket) ws._socket.setNoDelay(true);
  const v = createVless({
    eager: false,
    write: (b) => {
      if (ws.readyState !== 1) return true;
      ws.send(b, { binary: true });
      return ws.bufferedAmount < (1 << 20);
    },
    drain: (cb) => {
      const i = setInterval(() => {
        if (ws.readyState !== 1 || ws.bufferedAmount < (1 << 18)) { clearInterval(i); cb(); }
      }, 5);
    },
    close: () => { try { ws.close(1000); } catch {} },
  });

  // early data (0-RTT) arrives base64url in Sec-WebSocket-Protocol
  const proto = req.headers['sec-websocket-protocol'];
  if (proto) {
    try {
      const ed = Buffer.from(proto.split(',')[0].trim(), 'base64url');
      if (ed.length) v.onData(ed);
    } catch {}
  }

  ws.on('message', (d) => {
    if (!v.onData(d)) {
      ws.pause && ws.pause();
      v.drain(() => ws.resume && ws.resume());
    }
  });
  ws.on('close', v.destroy);
  ws.on('error', v.destroy);
}

// keep WS alive through CDNs with ~100s idle timeout
setInterval(() => wss.clients.forEach((w) => { try { w.ping(); } catch {} }), 30000);

process.on('uncaughtException', (e) => console.error('uncaught:', e && e.message));
process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.message));

// optional second listener on localhost, used as the Kariz tunnel exit target
// INTERNAL_PORT can be a list: "2096,2086,20443"
for (const ip of String(process.env.INTERNAL_PORT || '').split(',').map((x) => +x.trim()).filter((x) => x > 0 && x < 65536 && x !== PORT)) {
  const srv = makeServer();
  srv.on('error', (e) => console.error(`internal :${ip} failed: ${e.message}`));
  srv.listen(ip, '127.0.0.1', () => console.log(`internal on 127.0.0.1:${ip}`));
}
makeServer().listen(PORT, '0.0.0.0', () => {
  const q = (mode) => `vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}&fp=chrome&alpn=h2&type=xhttp&host=${DOMAIN}&path=${encodeURIComponent(XHTTP_PATH)}&mode=${mode}`;
  console.log(`listening on :${PORT}`);
  console.log(q('packet-up') + '#XHTTP-packet-up');
  console.log(q('stream-up') + '#XHTTP-stream-up');
  console.log(`vless://${UUID}@${DOMAIN}:443?encryption=none&security=tls&sni=${DOMAIN}&fp=chrome&alpn=http/1.1&type=ws&host=${DOMAIN}&path=${encodeURIComponent(WS_PATH)}#WS`);
});
