#!/usr/bin/env node
// ctrlpi-remote: a stdio MCP server that forwards every MCP message to a ctrlpi-mcp, pico-bay
// or pi-bay running in HTTP mode on another machine. It finds the server on the LAN with
// GET /hello, claims its key the first time, and from then on talks to it with that key only.
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const readline = require('readline');

const VERSION = require('./package.json').version;

// The three servers: default port, the list tool that fans out over several hosts, and
// whether only one server may be used (ctrlpi-mcp: two would drive the same agents).
const TARGETS = {
  'ctrlpi-mcp': { port: 8315, listTool: 'mcp_agents_list', single: true },
  'pico-bay': { port: 7426, listTool: 'pico_boards_list', single: false },
  'pi-bay': { port: 3141, listTool: 'pi_devices_list', single: false },
};
const DEFAULT_KEY = 'your-mcp-key';
const MODERN_PROTOCOL = '2026-07-28';
const HELLO_TIMEOUT_MS = Number(process.env.CTRLPI_REMOTE_HELLO_TIMEOUT_MS) || 1500;
const CONNECT_TIMEOUT_MS = 5000;
const SWEEP_PARALLEL = 48;

const USAGE = `Usage: ctrlpi-remote <ctrlpi-mcp | pico-bay | pi-bay> [options]

Options:
  --host ADDRESS   Use the server at this address (no LAN search)
  --port PORT      Its port (default 8315, 7426 or 3141)
  --config PATH    Config folder, or the remote-config.json file itself
  --rotate-keys    Give each server a new random key, save it, and exit
  --help           Show this help
  --version        Show the version`;

// ── Logging: stdout is the protocol channel, so everything else goes to stderr ──
function log(line) { process.stderr.write('ctrlpi-remote: ' + line + '\n'); }

// ── Command line ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { target: null, host: null, port: null, config: null, rotateKey: false, help: false, version: false };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(flag + ' needs a value');
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version') opts.version = true;
    else if (a === '--rotate-keys') opts.rotateKey = true;
    else if (a === '--host') opts.host = value(i++, a);
    else if (a === '--config') opts.config = value(i++, a);
    else if (a === '--port') {
      const n = Number(value(i++, a));
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port must be 1-65535');
      opts.port = n;
    } else if (a.startsWith('-')) throw new Error('unknown option ' + a);
    else if (opts.target) throw new Error('only one target: ctrlpi-mcp, pico-bay or pi-bay');
    else opts.target = a;
  }
  if (!opts.help && !opts.version) {
    if (!opts.target) throw new Error('name a target: ctrlpi-mcp, pico-bay or pi-bay');
    if (!TARGETS[opts.target]) throw new Error('unknown target ' + opts.target + ': use ctrlpi-mcp, pico-bay or pi-bay');
  }
  return opts;
}

// ── Config: ~/.ctrlpi/remote-config.json, a list of servers per target ──────
// --config <folder> holds remote-config.json; a .json path is the file itself.
function resolveConfigFile(configArg) {
  if (!configArg) return path.join(os.homedir(), '.ctrlpi', 'remote-config.json');
  const full = path.resolve(configArg);
  return full.toLowerCase().endsWith('.json') ? full : path.join(full, 'remote-config.json');
}

function loadConfig(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  } catch { return {}; }
}

// A target's saved servers: entries with a valid ip and port.
function savedServers(file, target) {
  const list = loadConfig(file)[target];
  if (!Array.isArray(list)) return [];
  return list.filter(e => e && typeof e.ip === 'string' && e.ip && Number.isInteger(e.port))
    .map(e => ({ ip: e.ip, port: e.port, api_key: typeof e.api_key === 'string' ? e.api_key : '', key_set: e.key_set || '', updated_at: e.updated_at || '' }));
}

// Writes this target's list only; the other targets stay as they are. Readable by the user only.
function saveServers(file, target, servers) {
  const cfg = loadConfig(file);
  cfg[target] = servers.map(s => ({ ip: s.ip, port: s.port, api_key: s.api_key, key_set: s.key_set, updated_at: s.updated_at }));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 4) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on this filesystem */ }
}

// UTC 'YYYY-MM-DD HH:MM:SS'.
function nowStamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function newKey() { return crypto.randomBytes(18).toString('base64url'); }

// ── HTTP ────────────────────────────────────────────────────────────────────
// One request. `connectTimeout` bounds the connection only, never the answer: tool calls
// (pi-bay commands, pico-bay firmware installs) can take minutes. `timeout` bounds it all.
function request(ip, port, method, urlPath, { headers = {}, body, connectTimeout = CONNECT_TIMEOUT_MS, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: ip, port, method, path: urlPath, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('socket', socket => {
      if (socket.connecting) {
        const timer = setTimeout(() => req.destroy(new Error('connection timed out')), connectTimeout);
        socket.once('connect', () => clearTimeout(timer));
        socket.once('close', () => clearTimeout(timer));
      }
    });
    if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('timed out')));
    req.end(body);
  });
}

// GET /hello: {service, key} or null when nothing (or something else) answers.
async function hello(ip, port, timeout = HELLO_TIMEOUT_MS) {
  try {
    const res = await request(ip, port, 'GET', '/hello', { connectTimeout: timeout, timeout });
    if (res.status !== 200) return null;
    const body = JSON.parse(res.body);
    return body && typeof body.service === 'string' ? { service: body.service, key: body.key === true } : null;
  } catch { return null; }
}

// ── LAN discovery ──────────────────────────────────────────────────────────
function isPrivateIPv4(ip) {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

// The LAN address: a UDP socket "connected" to 8.8.8.8:80 (no packet is sent), else the
// first active non-loopback IPv4 interface. Never a blind guess.
function localIp() {
  return new Promise(resolve => {
    const fallback = () => {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
          if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isPrivateIPv4(a.address)) return a.address;
        }
      }
      for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
          if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) return a.address;
        }
      }
      return null;
    };
    const socket = dgram.createSocket('udp4');
    socket.on('error', () => { socket.close(); resolve(fallback()); });
    try {
      socket.connect(80, '8.8.8.8', () => {
        let address = null;
        try { address = socket.address().address; } catch { /* not connected */ }
        socket.close();
        resolve(address && address !== '0.0.0.0' && !address.startsWith('127.') ? address : fallback());
      });
    } catch { socket.close(); resolve(fallback()); }
  });
}

// Numeric sort key for ip + port.
function addressOrder(a, b) {
  const pa = a.ip.split('.').map(Number), pb = b.ip.split('.').map(Number);
  for (let i = 0; i < 4; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return a.port - b.port;
}

// The hosts to probe: the local /24 on the default port. CTRLPI_REMOTE_SCAN_LAN=0 (tests)
// limits it to 127.0.0.1 on the ports in CTRLPI_REMOTE_SCAN_PORTS (default: the default port).
async function sweepCandidates(port) {
  if (process.env.CTRLPI_REMOTE_SCAN_LAN === '0') {
    const ports = String(process.env.CTRLPI_REMOTE_SCAN_PORTS || port).split(',').map(Number).filter(Number.isInteger);
    return ports.map(p => ({ ip: '127.0.0.1', port: p }));
  }
  const ip = await localIp();
  if (!ip) return [];
  const prefix = ip.split('.').slice(0, 3).join('.');
  const list = [];
  for (let i = 1; i < 255; i++) list.push({ ip: prefix + '.' + i, port });
  return list;
}

// Every host that answers /hello as `service`, lowest address first.
async function sweep(service, port) {
  const candidates = await sweepCandidates(port);
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const c = candidates[next++];
      const h = await hello(c.ip, c.port);
      if (h && h.service === service) found.push({ ...c, keySet: h.key });
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_PARALLEL, candidates.length) }, worker));
  return found.sort(addressOrder);
}

// ── Keys ────────────────────────────────────────────────────────────────────
// Sends a ping to /mcp with `key`. 'ok', 'rejected' (403), 'off' (404: MCP switched off),
// or 'error'.
async function tryKey(ip, port, key) {
  try {
    const res = await request(ip, port, 'POST', '/mcp', {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Api-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ctrlpi-remote-key', method: 'ping' }),
      timeout: 10000,
    });
    if (res.status === 200) return 'ok';
    if (res.status === 403) return 'rejected';
    if (res.status === 404) return 'off';
    return 'error';
  } catch { return 'error'; }
}

const label = (target, s) => (s.port === TARGETS[target].port ? s.ip : s.ip + ':' + s.port);

// Claims a server still on its default key: the new key is saved first, sent on the first
// request, and removed again when the server does not take it.
async function claim(file, target, server, keep) {
  const entry = { ip: server.ip, port: server.port, api_key: newKey(), key_set: nowStamp(), updated_at: nowStamp() };
  saveServers(file, target, [...keep, entry]);
  const answer = await tryKey(entry.ip, entry.port, entry.api_key);
  if (answer === 'ok') {
    log('claimed ' + target + ' on ' + label(target, entry) + ', key saved to ' + file);
    return entry;
  }
  saveServers(file, target, keep);
  log('could not claim ' + target + ' on ' + label(target, entry) + (answer === 'off' ? ': MCP is switched off there' : answer === 'rejected' ? ': it refused the new key' : ''));
  return null;
}

// The servers to use: the saved ones that answer, moved ones found again (their saved key
// goes to a new address only once the old one is dead), and new ones claimed.
// Returns {servers, problems}.
async function resolveServers({ target, host, port, configFile }) {
  const spec = TARGETS[target];
  const problems = [];
  let saved = savedServers(configFile, target);

  // --host / --port: this server only, no search.
  if (host) {
    const wanted = { ip: host, port: port || spec.port };
    const known = saved.find(s => s.ip === wanted.ip && s.port === wanted.port);
    const h = await hello(wanted.ip, wanted.port);
    if (!h || h.service !== target) {
      return { servers: [], problems: ['no ' + target + ' answers at ' + label(target, wanted) + (h ? ' (it is ' + h.service + ')' : '')] };
    }
    if (known && known.api_key) return { servers: [known], problems };
    if (h.key) return { servers: [], problems: [target + ' on ' + label(target, wanted) + ' is already claimed: put its key in ' + configFile] };
    const others = saved.filter(s => s !== known);
    const entry = await claim(configFile, target, wanted, others);
    return entry ? { servers: [entry], problems } : { servers: [], problems: ['could not claim ' + target + ' on ' + label(target, wanted)] };
  }

  // Check every saved address.
  const alive = [], dead = [];
  await Promise.all(saved.map(async s => {
    const h = await hello(s.ip, s.port);
    if (h && h.service === target) alive.push({ server: s, hello: h });
    else dead.push(s);
  }));
  const servers = [];
  for (const { server, hello: h } of alive) {
    if (server.api_key) servers.push(server);
    else if (h.key) problems.push(target + ' on ' + label(target, server) + ' is already claimed: put its key in ' + configFile);
    else {
      const entry = await claim(configFile, target, server, saved.filter(s => s !== server));
      if (entry) {
        saved = [...saved.filter(s => s !== server), entry];
        servers.push(entry);
      }
    }
  }

  // Search when nothing is saved or a saved address is dead.
  if (saved.length === 0 || dead.length > 0) {
    const known = new Set(alive.map(a => a.server.ip + ':' + a.server.port));
    const found = (await sweep(target, port || spec.port)).filter(f => !known.has(f.ip + ':' + f.port));
    let missing = dead.filter(d => d.api_key);
    for (const f of found) {
      if (spec.single && servers.length) {
        log('another ' + target + ' answers on ' + label(target, f) + ': ignored, ctrlpi-remote uses only one');
        continue;
      }
      if (f.keySet) {
        // A claimed server: one of ours that moved, when a dead entry's key opens it.
        let matched = null;
        for (const d of missing) {
          if (await tryKey(f.ip, f.port, d.api_key) === 'ok') { matched = d; break; }
        }
        if (matched) {
          missing = missing.filter(d => d !== matched);
          const moved = { ...matched, ip: f.ip, port: f.port, updated_at: nowStamp() };
          saved = [...saved.filter(s => s !== matched), moved];
          saveServers(configFile, target, saved);
          log(target + ' moved to ' + label(target, moved) + ', saved');
          servers.push(moved);
        } else {
          log(target + ' on ' + label(target, f) + ' is claimed by another client: skipped (put its key in ' + configFile + ' to use it)');
        }
      } else {
        const entry = await claim(configFile, target, f, saved);
        if (entry) {
          saved = [...saved, entry];
          servers.push(entry);
        }
      }
    }
    for (const d of missing) log(target + ' on ' + label(target, d) + ' does not answer');
  }

  if (spec.single && servers.length > 1) {
    servers.sort(addressOrder);
    for (const s of servers.slice(1)) log('another ' + target + ' is saved for ' + label(target, s) + ': ignored, ctrlpi-remote uses only one');
    servers.length = 1;
  }
  if (!servers.length && !problems.length) problems.push('no ' + target + ' found on the LAN: start it with its HTTP MCP on, or name it with --host');
  return { servers: servers.sort(addressOrder), problems };
}

// --rotate-keys: a new random key for every server, saved on 200.
async function rotateKeys(opts, configFile) {
  const { servers, problems } = await resolveServers({ ...opts, configFile });
  for (const p of problems) log(p);
  if (!servers.length) return 1;
  let failed = 0;
  for (const s of servers) {
    const key = newKey();
    let res;
    try {
      res = await request(s.ip, s.port, 'POST', '/remote-config', {
        headers: { 'Content-Type': 'application/json', 'Api-Key': s.api_key },
        body: JSON.stringify({ api_key: key }), timeout: 10000,
      });
    } catch (error) { res = { status: 0, body: String(error.message || error) }; }
    if (res.status !== 200) {
      failed++;
      log('could not rotate the key on ' + label(opts.target, s) + ' (' + (res.status || res.body) + ')');
      continue;
    }
    let keySet = nowStamp();
    try { keySet = JSON.parse(res.body).key_set || keySet; } catch { /* keep ours */ }
    const list = savedServers(configFile, opts.target).map(e => (e.ip === s.ip && e.port === s.port ? { ...e, api_key: key, key_set: keySet, updated_at: nowStamp() } : e));
    saveServers(configFile, opts.target, list);
    log('new key for ' + label(opts.target, s) + ', saved to ' + configFile);
  }
  return failed ? 1 : 0;
}

// ── Forwarding ─────────────────────────────────────────────────────────────
// A header value: plain when printable ASCII, else the =?base64?...?= form.
function headerValue(value) {
  const text = String(value);
  return /^[\x20-\x7e]*$/.test(text) ? text : '=?base64?' + Buffer.from(text, 'utf8').toString('base64') + '?=';
}

// The headers a stdio client never sends: on the current revision the servers check that
// MCP-Protocol-Version, Mcp-Method and Mcp-Name match the body.
function protocolHeaders(msg, negotiated) {
  const params = msg && msg.params && typeof msg.params === 'object' ? msg.params : {};
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
  if (meta['io.modelcontextprotocol/protocolVersion'] === MODERN_PROTOCOL) {
    const headers = { 'MCP-Protocol-Version': MODERN_PROTOCOL, 'Mcp-Method': msg.method };
    const name = params.name ?? params.uri;
    if (name !== undefined) headers['Mcp-Name'] = headerValue(name);
    return headers;
  }
  return negotiated && msg.method !== 'initialize' ? { 'MCP-Protocol-Version': negotiated } : {};
}

const isRequest = msg => msg && msg.id !== undefined && msg.id !== null;
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// The JSON-RPC messages in a 200 answer: one JSON body, or the data: lines of an event stream.
function answerMessages(res) {
  if (String(res.headers['content-type'] || '').includes('text/event-stream')) {
    const out = [];
    for (const line of res.body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { out.push(JSON.parse(line.slice(5).trim())); } catch { /* not JSON */ }
    }
    return out;
  }
  try { return [JSON.parse(res.body)]; } catch { return []; }
}

function createProxy(target, servers, startupProblems, write) {
  const spec = TARGETS[target];
  const multi = servers.length > 1;
  const labelOf = s => label(target, s);
  for (const s of servers) { s.session = null; s.negotiated = null; s.initMsg = null; }

  // POSTs one message to one server. Returns the messages to write (possibly none).
  async function post(server, msg, retried = false) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Api-Key': server.api_key,
      ...protocolHeaders(msg, server.negotiated),
    };
    if (server.session) headers['Mcp-Session-Id'] = server.session;
    let res;
    try {
      res = await request(server.ip, server.port, 'POST', '/mcp', { headers, body: JSON.stringify(msg) });
    } catch (error) {
      return isRequest(msg) ? [rpcError(msg.id, -32000, 'Cannot reach ' + target + ' on ' + labelOf(server) + ': ' + String(error.message || error))] : [];
    }
    if (res.status === 202) return [];
    if (msg.method === 'initialize' && res.status === 200) {
      if (res.headers['mcp-session-id']) server.session = String(res.headers['mcp-session-id']);
      server.initMsg = msg;
      const [reply] = answerMessages(res);
      if (reply && reply.result && typeof reply.result.protocolVersion === 'string') server.negotiated = reply.result.protocolVersion;
    }
    if (res.status === 200) return answerMessages(res);
    if (res.status === 403) {
      return isRequest(msg) ? [rpcError(msg.id, -32001, target + ' on ' + labelOf(server) + ' rejected the key saved in remote-config.json')] : [];
    }
    if (res.status === 404) {
      // A JSON-RPC body is the server's own answer (an unknown method); anything else means
      // /mcp is not there: MCP was switched off, or the session expired.
      let body = null;
      try { body = JSON.parse(res.body); } catch { /* not JSON */ }
      if (body && body.jsonrpc === '2.0') return [body];
      if (!retried && server.initMsg && msg.method !== 'initialize') {
        server.session = null;
        const again = await post(server, server.initMsg, true);
        if (again.length && again[0].result) {
          await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' }, true);
          return post(server, msg, true);
        }
      }
      return isRequest(msg) ? [rpcError(msg.id, -32002, 'MCP is switched off on ' + target + ' at ' + labelOf(server))] : [];
    }
    let detail = '';
    try { detail = JSON.parse(res.body).error; detail = typeof detail === 'string' ? detail : (detail && detail.message) || ''; } catch { /* no detail */ }
    return isRequest(msg) ? [rpcError(msg.id, -32000, target + ' on ' + labelOf(server) + ' answered HTTP ' + res.status + (detail ? ': ' + detail : ''))] : [];
  }

  // The servers that answer /hello right now.
  async function aliveServers() {
    const checks = await Promise.all(servers.map(async s => ({ s, h: await hello(s.ip, s.port) })));
    return checks.filter(c => c.h && c.h.service === target).map(c => c.s);
  }

  // Several servers: every tool gets a `host` argument naming one of them.
  async function toolsList(msg) {
    const live = await aliveServers();
    if (!live.length) return [rpcError(msg.id, -32000, 'no ' + target + ' answers right now')];
    const replies = await post(live[0], msg);
    const reply = replies[0];
    if (!reply || !reply.result || !Array.isArray(reply.result.tools)) return replies;
    const hosts = live.map(labelOf);
    reply.result.tools = reply.result.tools.map(tool => {
      const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object' };
      const list = tool.name === spec.listTool;
      return {
        ...tool,
        inputSchema: {
          ...schema,
          properties: {
            ...(schema.properties || {}),
            host: {
              type: 'string', enum: hosts,
              description: list ? 'The ' + target + ' host to ask; leave it out to ask every host.' : 'The ' + target + ' host to run this on.',
            },
          },
          required: list ? (schema.required || []) : [...new Set([...(schema.required || []), 'host'])],
        },
      };
    });
    return [reply];
  }

  // Several servers: route by `host`, or fan a list tool out to every host and tag each result.
  async function toolsCall(msg) {
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    const args = params.arguments && typeof params.arguments === 'object' ? { ...params.arguments } : {};
    const host = args.host;
    delete args.host;
    const forward = { ...msg, params: { ...params, arguments: args } };
    if (host !== undefined) {
      const server = servers.find(s => labelOf(s) === host);
      if (!server) return [rpcError(msg.id, -32602, 'Unknown host ' + host + ': use one of ' + servers.map(labelOf).join(', '))];
      return post(server, forward);
    }
    if (params.name !== spec.listTool) {
      return [rpcError(msg.id, -32602, 'host is required: one of ' + servers.map(labelOf).join(', '))];
    }
    const live = await aliveServers();
    const results = await Promise.all(live.map(async s => ({ s, reply: (await post(s, forward))[0] })));
    const merged = {};
    let first = null;
    let allFailed = true;
    for (const { s, reply } of results) {
      const result = reply && reply.result;
      if (result && !first) first = result;
      if (result && !result.isError) allFailed = false;
      const text = result && Array.isArray(result.content) && result.content[0] && result.content[0].text;
      let value;
      if (!result) value = { error: (reply && reply.error && reply.error.message) || 'no answer' };
      else { try { value = JSON.parse(text); } catch { value = text; } }
      merged[labelOf(s)] = value;
    }
    const result = { ...(first || {}), content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }] };
    delete result.structuredContent;
    if (allFailed) result.isError = true; else delete result.isError;
    return [{ jsonrpc: '2.0', id: msg.id, result }];
  }

  async function handle(msg) {
    if (!servers.length) {
      return isRequest(msg) ? [rpcError(msg.id, -32000, 'ctrlpi-remote has no ' + target + ' to talk to: ' + (startupProblems.join('; ') || 'none found'))] : [];
    }
    if (!multi) return post(servers[0], msg);
    if (msg.method === 'initialize' || !isRequest(msg)) {
      // Every server is initialized and gets every notification; the first answer is used.
      const all = await Promise.all(servers.map(s => post(s, msg)));
      if (!isRequest(msg)) return [];
      return [all.map(r => r[0]).find(r => r && r.result) || all[0][0]].filter(Boolean);
    }
    if (msg.method === 'tools/list') return toolsList(msg);
    if (msg.method === 'tools/call') return toolsCall(msg);
    return post(servers[0], msg);
  }

  // One line from stdin: parse, forward, write each answer as one line.
  async function line(text) {
    if (!text.trim()) return;
    let msg;
    try { msg = JSON.parse(text); } catch {
      write(rpcError(null, -32700, 'Parse error'));
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      write(rpcError(null, -32600, 'Invalid Request'));
      return;
    }
    let out;
    try { out = await handle(msg); } catch (error) {
      out = isRequest(msg) ? [rpcError(msg.id, -32603, String(error.message || error))] : [];
    }
    for (const reply of out) write(reply);
  }

  return { line, handle };
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (error) {
    process.stderr.write('ctrlpi-remote: ' + error.message + '\n\n' + USAGE + '\n');
    process.exit(2);
  }
  if (opts.help) { process.stdout.write(USAGE + '\n'); return; }
  if (opts.version) { process.stdout.write(VERSION + '\n'); return; }
  const configFile = resolveConfigFile(opts.config);
  if (opts.rotateKey) {
    process.exitCode = await rotateKeys(opts, configFile);
    return;
  }
  // Start reading at once, so no message is lost while the servers are found. Requests run
  // concurrently, and when stdin closes the ones already sent finish before the process exits.
  const queue = [];
  let proxy = null;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const pending = new Set();
  let closed = false;
  const run = text => {
    const p = proxy.line(text).finally(() => pending.delete(p));
    pending.add(p);
  };
  rl.on('line', text => (proxy ? run(text) : queue.push(text)));
  rl.on('close', () => { closed = true; });

  let resolved;
  try { resolved = await resolveServers({ ...opts, configFile }); } catch (error) {
    resolved = { servers: [], problems: [String(error.message || error)] };
  }
  for (const p of resolved.problems) log(p);
  if (resolved.servers.length) log('forwarding to ' + opts.target + ' on ' + resolved.servers.map(s => label(opts.target, s)).join(', '));
  proxy = createProxy(opts.target, resolved.servers, resolved.problems, msg => process.stdout.write(JSON.stringify(msg) + '\n'));
  for (const text of queue.splice(0)) run(text);
  const finish = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
    process.exit(0);
  };
  if (closed) finish(); else rl.on('close', finish);
}

if (require.main === module) main();

module.exports = {
  TARGETS, parseArgs, resolveConfigFile, savedServers, saveServers, hello, sweep, localIp,
  resolveServers, rotateKeys, protocolHeaders, headerValue, createProxy,
};
