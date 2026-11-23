'use strict';
// ctrlpi-remote against fake servers on 127.0.0.1 (CTRLPI_REMOTE_SCAN_LAN=0 keeps every
// search on localhost), then against the real ctrlpi-mcp, pico-bay and pi-bay when they
// sit next to this folder in the workspace.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'ctrlpi-remote.js');
const WORKSPACE = path.join(__dirname, '..', '..');
const DEFAULT = 'your-mcp-key';
const LIST_TOOL = { 'ctrlpi-mcp': 'mcp_agents_list', 'pico-bay': 'pico_boards_list', 'pi-bay': 'pi_devices_list' };
const MODERN = '2026-07-28';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlpi-remote-test-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let dirCount = 0;
const newConfigDir = () => {
  const dir = path.join(tmpRoot, 'c' + dirCount++);
  fs.mkdirSync(dir);
  return dir;
};
const readConfig = dir => JSON.parse(fs.readFileSync(path.join(dir, 'remote-config.json'), 'utf8'));

function readAll(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// A server with the three servers' wire behaviour: /hello, /mcp with the key (claimed by
// the first different key), the current revision's header checks, sessions, /remote-config.
async function fake(service, { key = DEFAULT, off = false } = {}) {
  const state = { key, off, keysSeen: [], sessions: new Set(), sessionHeaders: [], calls: [] };
  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/hello') return send(200, { service, key: state.key !== DEFAULT });
    if (req.url === '/remote-config') {
      if (req.headers['api-key'] !== state.key) return send(403, { error: 'Invalid or missing Api-Key header' });
      state.key = JSON.parse(body).api_key;
      return send(200, { key_set: '2026-11-22 10:00:00' });
    }
    if (req.url !== '/mcp' || state.off) { res.writeHead(404); res.end(); return; }
    const provided = req.headers['api-key'];
    state.keysSeen.push(provided);
    if (state.key === DEFAULT && provided && provided !== DEFAULT) state.key = provided;
    else if (provided !== state.key) return send(403, { error: 'Invalid or missing Api-Key header' });
    const msg = JSON.parse(body);
    const meta = msg.params && msg.params._meta;
    if (meta && meta['io.modelcontextprotocol/protocolVersion'] === MODERN) {
      const name = msg.params.name ?? msg.params.uri;
      if (req.headers['mcp-protocol-version'] !== MODERN || req.headers['mcp-method'] !== msg.method ||
          (name !== undefined && req.headers['mcp-name'] !== name)) {
        return send(400, { jsonrpc: '2.0', id: msg.id, error: { code: -32020, message: 'MCP request headers do not match the JSON-RPC body' } });
      }
    }
    if (msg.method === 'initialize') {
      const sid = crypto.randomUUID();
      state.sessions.add(sid);
      return send(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: service } } }, { 'Mcp-Session-Id': sid });
    }
    const sid = req.headers['mcp-session-id'];
    state.sessionHeaders.push(sid);
    if (sid && !state.sessions.has(sid)) { res.writeHead(404); res.end(); return; }
    if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
    if (msg.method === 'ping') return send(200, { jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'tools/list') {
      return send(200, { jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: LIST_TOOL[service], inputSchema: { type: 'object', properties: {} } },
        { name: 'do_thing', inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, additionalProperties: false } },
      ] } });
    }
    if (msg.method === 'tools/call') {
      const args = msg.params.arguments || {};
      state.calls.push(msg.params);
      if (args.ms) await sleep(args.ms);
      return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ port: server.address().port, args }) }] } });
    }
    return send(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server, state, port,
    expire() { state.sessions.clear(); },
    close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}

// A free port nothing listens on.
async function deadPort() {
  const s = http.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}

const running = new Set();
after(() => { for (const child of running) child.kill(); });

// Runs ctrlpi-remote; request() resolves with the reply carrying that id.
function remote(args, scanPorts = []) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, CTRLPI_REMOTE_SCAN_LAN: '0', CTRLPI_REMOTE_SCAN_PORTS: scanPorts.join(',') || '1', CTRLPI_REMOTE_HELLO_TIMEOUT_MS: '500' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  const replies = [];
  const waiters = [];
  let buf = '';
  let stderr = '';
  const flush = () => {
    for (const w of [...waiters]) {
      const reply = replies.find(r => r.id === w.id);
      if (reply) { waiters.splice(waiters.indexOf(w), 1); w.resolve(reply); }
    }
  };
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) replies.push(JSON.parse(line));
    }
    flush();
  });
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  return {
    replies, stderr: () => stderr,
    send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); },
    request(msg) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no reply to ' + msg.id + '\n' + stderr)), 20000);
        waiters.push({ id: msg.id, resolve: reply => { clearTimeout(timer); resolve(reply); } });
        this.send(msg);
        flush();
      });
    },
    close() { child.stdin.end(); return exited; },
  };
}

const initialize = id => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const toolText = reply => JSON.parse(reply.result.content[0].text);

describe('command line', () => {
  test('a missing or unknown target, an unknown flag or a flag without a value exits with code 2', () => {
    for (const args of [[], ['nope'], ['pico-bay', '--key', 'x'], ['pico-bay', '--port'], ['pico-bay', '--port', '0'], ['pico-bay', 'pi-bay']]) {
      const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
      assert.equal(run.status, 2, args.join(' '));
      assert.match(run.stderr, /Usage: ctrlpi-remote/);
    }
  });

  test('--help and --version', () => {
    assert.match(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).stdout, /--rotate-keys/);
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--version'], { encoding: 'utf8' }).stdout.trim(), require('../package.json').version);
  });

  test('--config takes a folder or the .json file itself', () => {
    const { resolveConfigFile } = require('../ctrlpi-remote.js');
    assert.equal(resolveConfigFile('/x/y'), '/x/y/remote-config.json');
    assert.equal(resolveConfigFile('/x/mine.json'), '/x/mine.json');
    assert.equal(resolveConfigFile(null), path.join(os.homedir(), '.ctrlpi', 'remote-config.json'));
  });

  test('protocol headers follow the body on the current revision only', () => {
    const { protocolHeaders } = require('../ctrlpi-remote.js');
    const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN };
    assert.deepEqual(protocolHeaders({ method: 'tools/call', params: { name: 'pico_ui', _meta: meta } }), {
      'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'pico_ui',
    });
    assert.equal(protocolHeaders({ method: 'tools/call', params: { name: 'é', _meta: meta } })['Mcp-Name'], '=?base64?w6k=?=');
    assert.deepEqual(protocolHeaders({ method: 'ping' }, '2025-06-18'), { 'MCP-Protocol-Version': '2025-06-18' });
    assert.deepEqual(protocolHeaders({ method: 'initialize', params: {} }, '2025-06-18'), {});
  });
});

describe('keys and discovery', () => {
  test('claims a new server with a random key, saved before use, and reuses it', async () => {
    const f = await fake('pico-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['pico-bay', '--config', dir], [f.port]);
      assert.ok((await r.request(initialize(1))).result);
      const saved = readConfig(dir)['pico-bay'];
      assert.equal(saved.length, 1);
      assert.equal(saved[0].ip, '127.0.0.1');
      assert.equal(saved[0].port, f.port);
      assert.equal(saved[0].api_key.length, 24);
      assert.match(saved[0].key_set, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
      assert.equal(f.state.key, saved[0].api_key);
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'remote-config.json')).mode & 0o777, 0o600);
      assert.equal(await r.close(), 0);

      const again = remote(['pico-bay', '--config', dir], [f.port]);
      assert.ok((await again.request(initialize(1))).result);
      assert.equal(readConfig(dir)['pico-bay'][0].api_key, saved[0].api_key);
      assert.equal(f.state.key, saved[0].api_key);
      await again.close();
    } finally { await f.close(); }
  });

  test('a server claimed by someone else, with no saved key, is reported', async () => {
    const f = await fake('pi-bay', { key: 'someone-else' });
    const dir = newConfigDir();
    try {
      const r = remote(['pi-bay', '--config', dir], [f.port]);
      const reply = await r.request(initialize(1));
      assert.match(reply.error.message, /no pi-bay found|claimed/);
      assert.match(r.stderr(), /claimed by another client/);
      assert.equal(f.state.key, 'someone-else');
      await r.close();
    } finally { await f.close(); }
  });

  test('--host names a server already claimed: put its key in the config', async () => {
    const f = await fake('pi-bay', { key: 'someone-else' });
    const dir = newConfigDir();
    try {
      const r = remote(['pi-bay', '--host', '127.0.0.1', '--port', String(f.port), '--config', dir]);
      assert.match((await r.request(initialize(1))).error.message, /already claimed: put its key in/);
      await r.close();
    } finally { await f.close(); }
  });

  test('a wrong saved key comes back as a key error', async () => {
    const f = await fake('pico-bay', { key: 'real-key' });
    const dir = newConfigDir();
    fs.writeFileSync(path.join(dir, 'remote-config.json'), JSON.stringify({ 'pico-bay': [{ ip: '127.0.0.1', port: f.port, api_key: 'stale-key' }] }));
    try {
      const r = remote(['pico-bay', '--config', dir], [f.port]);
      assert.match((await r.request(initialize(1))).error.message, /rejected the key/);
      await r.close();
    } finally { await f.close(); }
  });

  test('a moved server is found again with its key, and the key goes nowhere else while the old address answers', async () => {
    const dead = await deadPort();
    const moved = await fake('pico-bay', { key: 'moved-key' });
    const stranger = await fake('pico-bay', { key: 'stranger-key' });
    const dir = newConfigDir();
    fs.writeFileSync(path.join(dir, 'remote-config.json'), JSON.stringify({
      'pico-bay': [{ ip: '127.0.0.1', port: dead, api_key: 'moved-key', key_set: '2026-01-01 00:00:00' }],
      'pi-bay': [{ ip: '10.0.0.9', port: 3141, api_key: 'kept' }],
    }));
    try {
      const r = remote(['pico-bay', '--config', dir], [stranger.port, moved.port]);
      assert.ok((await r.request(initialize(1))).result);
      const cfg = readConfig(dir);
      assert.deepEqual(cfg['pico-bay'].map(e => [e.port, e.api_key]), [[moved.port, 'moved-key']]);
      assert.equal(cfg['pi-bay'][0].api_key, 'kept', 'other targets are left alone');
      assert.equal(stranger.state.key, 'stranger-key');
      await r.close();

      // The saved address answers now: no search, so the stranger never sees the key.
      stranger.state.keysSeen.length = 0;
      const again = remote(['pico-bay', '--config', dir], [stranger.port, moved.port]);
      assert.ok((await again.request(initialize(1))).result);
      assert.deepEqual(stranger.state.keysSeen, []);
      await again.close();
    } finally { await moved.close(); await stranger.close(); }
  });

  test('ctrlpi-mcp: only the first server found is claimed', async () => {
    const a = await fake('ctrlpi-mcp');
    const b = await fake('ctrlpi-mcp');
    const [first, second] = a.port < b.port ? [a, b] : [b, a];
    const dir = newConfigDir();
    try {
      const r = remote(['ctrlpi-mcp', '--config', dir], [a.port, b.port]);
      assert.ok((await r.request(initialize(1))).result);
      assert.deepEqual(readConfig(dir)['ctrlpi-mcp'].map(e => e.port), [first.port]);
      assert.equal(second.state.key, DEFAULT, 'the second one is not claimed');
      assert.match(r.stderr(), /uses only one/);
      await r.close();
    } finally { await a.close(); await b.close(); }
  });

  test('--rotate-keys sets a new key and saves it', async () => {
    const f = await fake('pi-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['pi-bay', '--config', dir], [f.port]);
      await r.request(initialize(1));
      await r.close();
      const before = readConfig(dir)['pi-bay'][0].api_key;
      // Not spawnSync: the fake server runs in this process.
      const rotate = remote(['pi-bay', '--config', dir, '--rotate-keys'], [f.port]);
      assert.equal(await rotate.close(), 0, rotate.stderr());
      const after = readConfig(dir)['pi-bay'][0];
      assert.notEqual(after.api_key, before);
      assert.equal(after.key_set, '2026-11-22 10:00:00');
      assert.equal(f.state.key, after.api_key);
    } finally { await f.close(); }
  });
});

describe('forwarding', () => {
  test('requests, notifications, concurrency, sessions, current-revision headers and stdin close', async () => {
    const f = await fake('pico-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['pico-bay', '--config', dir], [f.port]);
      assert.equal((await r.request(initialize(1))).result.serverInfo.name, 'pico-bay');
      f.state.sessionHeaders.length = 0; // the claim's ping came before any session
      r.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      // A slow call and a fast one: the fast answer comes out first.
      const slow = r.request(call(2, 'do_thing', { ms: 600 }));
      const fast = r.request(call(3, 'do_thing'));
      await Promise.all([slow, fast]);
      assert.deepEqual(r.replies.map(m => m.id), [1, 3, 2], 'the notification wrote nothing');
      assert.ok(f.state.sessionHeaders.length >= 3 && f.state.sessionHeaders.every(sid => f.state.sessions.has(sid)), 'the session id goes with every call');

      // The current revision: the proxy fills in the headers the server checks.
      const modern = await r.request({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'do_thing', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} } },
      });
      assert.ok(modern.result, JSON.stringify(modern));

      // An expired session: initialize again once, then the call goes through.
      f.expire();
      assert.ok((await r.request(call(5, 'do_thing'))).result);

      // stdin closes while a call runs: it still answers before the exit.
      r.send(call(6, 'do_thing', { ms: 400 }));
      assert.equal(await r.close(), 0);
      assert.ok(r.replies.find(m => m.id === 6).result);
    } finally { await f.close(); }
  });

  test('MCP switched off on the server', async () => {
    const f = await fake('pico-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['pico-bay', '--config', dir], [f.port]);
      await r.request(initialize(1));
      f.state.off = true;
      f.expire();
      assert.match((await r.request(call(2, 'do_thing'))).error.message, /MCP is switched off/);
      assert.match((await r.request(initialize(3))).error.message, /MCP is switched off/);
      await r.close();
    } finally { await f.close(); }
  });

  test('nothing found: the proxy still starts and says why', async () => {
    const dir = newConfigDir();
    const r = remote(['pi-bay', '--config', dir], [await deadPort()]);
    assert.match((await r.request(initialize(1))).error.message, /no pi-bay found on the LAN/);
    r.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.match((await r.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).error.message, /no pi-bay/);
    assert.equal(r.replies.length, 2);
    await r.close();
  });

  test('several servers: each claimed with its own key, one tool list with host, list tools fan out', async () => {
    const a = await fake('pico-bay');
    const b = await fake('pico-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['pico-bay', '--config', dir], [a.port, b.port]);
      assert.ok((await r.request(initialize(1))).result);
      const saved = readConfig(dir)['pico-bay'];
      assert.equal(saved.length, 2);
      assert.notEqual(saved[0].api_key, saved[1].api_key);
      const hosts = [a.port, b.port].sort((x, y) => x - y).map(p => '127.0.0.1:' + p);

      const tools = (await r.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
      for (const tool of tools) assert.deepEqual(tool.inputSchema.properties.host.enum, hosts);
      assert.ok(tools.find(t => t.name === 'do_thing').inputSchema.required.includes('host'));
      assert.ok(!(tools.find(t => t.name === 'pico_boards_list').inputSchema.required || []).includes('host'));

      const routed = await r.request(call(3, 'do_thing', { host: '127.0.0.1:' + b.port }));
      assert.equal(toolText(routed).port, b.port);
      assert.deepEqual(toolText(routed).args, {}, 'host is not sent on');

      const fanned = toolText(await r.request(call(4, 'pico_boards_list')));
      assert.deepEqual(Object.keys(fanned).sort(), hosts);
      assert.equal(fanned['127.0.0.1:' + a.port].port, a.port);

      assert.match((await r.request(call(5, 'do_thing'))).error.message, /host is required/);
      assert.match((await r.request(call(6, 'do_thing', { host: '10.9.9.9' }))).error.message, /Unknown host/);

      // One goes offline: it drops out of the list.
      await b.close();
      const after = (await r.request({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).result.tools;
      assert.deepEqual(after[0].inputSchema.properties.host.enum, ['127.0.0.1:' + a.port]);
      await r.close();
    } finally { await a.close(); }
  });
});

// The real servers, when the workspace has them next to this project.
describe('against the real servers', () => {
  const mcpServer = path.join(WORKSPACE, 'ctrlpi-mcp', 'server.js');
  test('ctrlpi-mcp --mcp http', { skip: !fs.existsSync(mcpServer) && 'ctrlpi-mcp is not next to this project' }, async () => {
    const port = await deadPort();
    const mcpDir = newConfigDir();
    const child = spawn(process.execPath, [mcpServer, '--mcp', 'http', '--host', '127.0.0.1', '--port', String(port), '--config', mcpDir, '--no-scan'], {
      env: { ...process.env, MCP_BRIDGE_SCAN_LAN: '0' }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    running.add(child);
    try {
      for (let i = 0; i < 50 && !(await fetch('http://127.0.0.1:' + port + '/hello').then(() => true, () => false)); i++) await sleep(100);
      const dir = newConfigDir();
      const r = remote(['ctrlpi-mcp', '--config', dir], [port]);
      assert.equal((await r.request(initialize(1))).result.serverInfo.name, 'ctrlpi-mcp');
      const tools = (await r.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
      assert.ok(tools.find(t => t.name === 'mcp_agents_list'));
      const own = JSON.parse(fs.readFileSync(path.join(mcpDir, 'mcp-config.json'), 'utf8'));
      assert.equal(own.mcp.api_key, readConfig(dir)['ctrlpi-mcp'][0].api_key);
      await r.close();
    } finally { child.kill(); }
  });

  // In-process with HOME moved, so neither touches the real ~/.ctrlpi. Only initialize and
  // tools/list: nothing that would open a board's serial port or an SSH connection.
  const bays = [
    { target: 'pico-bay', file: path.join(WORKSPACE, 'pico-bay', 'pico-bay.js'), start: m => m.createServer({ logDevices: false, logErrors: false, mcpOnly: true }) },
    { target: 'pi-bay', file: path.join(WORKSPACE, 'pi-bay', 'server.js'), start: m => { m.setMcpHttp(true); return m.server; } },
  ];
  for (const bay of bays) {
    test(bay.target + ' HTTP MCP', { skip: !fs.existsSync(bay.file) && bay.target + ' is not next to this project' }, async () => {
      const home = process.env.HOME;
      process.env.HOME = newConfigDir();
      let server;
      try {
        server = bay.start(require(bay.file));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const dir = newConfigDir();
        const r = remote([bay.target, '--config', dir], [port]);
        assert.equal((await r.request(initialize(1))).result.serverInfo.name, bay.target);
        const tools = (await r.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
        assert.ok(tools.find(t => t.name === LIST_TOOL[bay.target]));
        const own = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.ctrlpi', bay.target + '-config.json'), 'utf8'));
        assert.equal(own.mcp.api_key, readConfig(dir)[bay.target][0].api_key);
        await r.close();
      } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        process.env.HOME = home;
      }
    });
  }
});
