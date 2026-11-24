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
const PREFIX = { 'ctrlpi-mcp': 'mcp_', 'pico-bay': 'pico_', 'pi-bay': 'pi_' };
const UI_TOOL = { 'pico-bay': 'pico_ui', 'pi-bay': 'pi_ui' };
const BUILTIN = ['remote_rescan', 'remote_servers_list'];
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
// Its tools: the list tool, <prefix>thing, and the UI tool on the bays.
async function fake(service, { key = DEFAULT, off = false, port = 0 } = {}) {
  const state = { key, off, keysSeen: [], sessions: new Set(), sessionHeaders: [], calls: [], uiUrl: null };
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
      const tools = [
        { name: LIST_TOOL[service], inputSchema: { type: 'object', properties: {} } },
        { name: PREFIX[service] + 'thing', inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, additionalProperties: false } },
        { name: 'unprefixed', inputSchema: { type: 'object', properties: {} } },
      ];
      if (UI_TOOL[service]) tools.push({ name: UI_TOOL[service], inputSchema: { type: 'object', properties: {} } });
      return send(200, { jsonrpc: '2.0', id: msg.id, result: { tools } });
    }
    if (msg.method === 'tools/call') {
      const args = msg.params.arguments || {};
      state.calls.push(msg.params);
      if (args.ms) await sleep(args.ms);
      if (msg.params.name === UI_TOOL[service]) {
        const ui = { url: state.uiUrl || 'http://' + req.headers.host, opened: false, message: 'The browser was not opened.' };
        return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(ui) }], structuredContent: ui } });
      }
      return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ service, port: server.address().port, args }) }] } });
    }
    return send(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    server, state, port: server.address().port,
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
function remote(args, scanPorts = [], env = {}) {
  const base = { ...process.env };
  delete base.SSH_CONNECTION;
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { ...base, CTRLPI_REMOTE_SCAN_LAN: '0', CTRLPI_REMOTE_SCAN_PORTS: scanPorts.join(',') || '1', CTRLPI_REMOTE_HELLO_TIMEOUT_MS: '500', ...env },
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
      const reply = replies.find(w.match);
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
  const wait = (match, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ' + what + '\n' + stderr)), 20000);
    waiters.push({ match, resolve: reply => { clearTimeout(timer); resolve(reply); } });
    flush();
  });
  return {
    replies, stderr: () => stderr,
    send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); },
    request(msg) {
      const reply = wait(r => r.id === msg.id, 'reply to ' + msg.id);
      this.send(msg);
      return reply;
    },
    notification(method) { return wait(r => r.method === method, method); },
    close() { child.stdin.end(); return exited; },
  };
}

const initialize = id => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const toolText = reply => JSON.parse(reply.result.content[0].text);
const listTools = async (r, id) => (await r.request({ jsonrpc: '2.0', id, method: 'tools/list' })).result.tools;
const toolNames = tools => tools.map(t => t.name).sort();
const servers = async (r, id) => toolText(await r.request(call(id, 'remote_servers_list')));

describe('command line', () => {
  test('an unknown target, an unknown flag, --port without a target or a flag without a value exits with code 2', () => {
    for (const args of [['nope'], ['pico-bay', '--key', 'x'], ['pico-bay', '--port'], ['pico-bay', '--port', '0'], ['pico-bay', 'pi-bay'], ['--port', '7426']]) {
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

  test('the targets served: all three, the "targets" list, or the one named', () => {
    const { enabledTargets } = require('../ctrlpi-remote.js');
    const file = path.join(newConfigDir(), 'remote-config.json');
    assert.deepEqual(enabledTargets(file, null), ['ctrlpi-mcp', 'pico-bay', 'pi-bay']);
    fs.writeFileSync(file, JSON.stringify({ targets: ['pi-bay', 'nope', 'ctrlpi-mcp'] }));
    assert.deepEqual(enabledTargets(file, null), ['ctrlpi-mcp', 'pi-bay']);
    assert.deepEqual(enabledTargets(file, 'pico-bay'), ['pico-bay']);
    fs.writeFileSync(file, JSON.stringify({ targets: [] }));
    assert.deepEqual(enabledTargets(file, null), []);
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

  test('a desktop session: not over SSH, and on Linux only with a display', () => {
    const { localDesktop } = require('../ctrlpi-remote.js');
    assert.equal(localDesktop({ SSH_CONNECTION: '1 2 3 4', DISPLAY: ':0' }), false);
    assert.equal(localDesktop({ DISPLAY: ':0' }), true);
    assert.equal(localDesktop({}), process.platform !== 'linux');
  });
});

describe('keys and discovery', () => {
  test('claims a new server with a random key, saved before use, and reuses it', async () => {
    const f = await fake('pico-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['pico-bay', '--config', dir], [f.port]);
      assert.equal((await r.request(initialize(1))).result.serverInfo.name, 'ctrlpi-remote');
      assert.deepEqual(toolNames(await listTools(r, 2)), [...BUILTIN, 'pico_boards_list', 'pico_thing', 'pico_ui'].sort(), 'tools without the prefix are left out');
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
      await again.request(initialize(1));
      assert.ok((await again.request(call(2, 'pico_thing'))).result);
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
      await r.request(initialize(1));
      assert.deepEqual(toolNames(await listTools(r, 2)), BUILTIN);
      assert.match((await servers(r, 3))['pi-bay'].problems[0], /is already claimed: put its key in/);
      assert.match((await r.request(call(4, 'pi_devices_list'))).error.message, /not connected to a pi-bay server: .*already claimed.*remote_rescan/);
      assert.equal(f.state.key, 'someone-else');
      await r.close();
    } finally { await f.close(); }
  });

  test('--host names a server already claimed: put its key in the config', async () => {
    const f = await fake('pi-bay', { key: 'someone-else' });
    const dir = newConfigDir();
    try {
      const r = remote(['pi-bay', '--host', '127.0.0.1', '--port', String(f.port), '--config', dir]);
      await r.request(initialize(1));
      assert.match((await servers(r, 2))['pi-bay'].problems[0], /already claimed: put its key in/);
      await r.close();
    } finally { await f.close(); }
  });

  test('a wrong saved key comes back as a key error', async () => {
    const f = await fake('pico-bay', { key: 'real-key' });
    const dir = newConfigDir();
    fs.writeFileSync(path.join(dir, 'remote-config.json'), JSON.stringify({ 'pico-bay': [{ ip: '127.0.0.1', port: f.port, api_key: 'stale-key' }] }));
    try {
      const r = remote(['pico-bay', '--config', dir], [f.port]);
      await r.request(initialize(1));
      assert.deepEqual(toolNames(await listTools(r, 2)), BUILTIN);
      assert.match((await servers(r, 3))['pico-bay'].problems.join(), /rejected the key/);
      assert.match((await r.request(call(4, 'pico_thing'))).error.message, /rejected the key/);
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
      await r.request(initialize(1));
      assert.ok((await r.request(call(2, 'pico_thing'))).result);
      const cfg = readConfig(dir);
      assert.deepEqual(cfg['pico-bay'].map(e => [e.port, e.api_key]), [[moved.port, 'moved-key']]);
      assert.equal(cfg['pi-bay'][0].api_key, 'kept', 'other targets are left alone');
      assert.equal(stranger.state.key, 'stranger-key');
      await r.close();

      // The saved address answers now: no search, so the stranger never sees the key.
      stranger.state.keysSeen.length = 0;
      const again = remote(['pico-bay', '--config', dir], [stranger.port, moved.port]);
      await again.request(initialize(1));
      assert.ok((await again.request(call(2, 'pico_thing'))).result);
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
      await r.request(initialize(1));
      const tools = await listTools(r, 2);
      assert.ok(!tools.find(t => t.name === 'mcp_thing').inputSchema.properties.host, 'one server: no host');
      assert.deepEqual(readConfig(dir)['ctrlpi-mcp'].map(e => e.port), [first.port]);
      assert.equal(second.state.key, DEFAULT, 'the second one is not claimed');
      assert.match(r.stderr(), /uses only one/);
      await r.close();
    } finally { await a.close(); await b.close(); }
  });

  test('--rotate-keys sets a new key for every server of every target and saves it', async () => {
    const pico = await fake('pico-bay');
    const pi = await fake('pi-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['--config', dir], [pico.port, pi.port]);
      await r.request(initialize(1));
      await listTools(r, 2);
      await r.close();
      const before = readConfig(dir);
      // Not spawnSync: the fake servers run in this process.
      const rotate = remote(['--config', dir, '--rotate-keys'], [pico.port, pi.port]);
      assert.equal(await rotate.close(), 0, rotate.stderr());
      const cfg = readConfig(dir);
      for (const [t, f] of [['pico-bay', pico], ['pi-bay', pi]]) {
        assert.notEqual(cfg[t][0].api_key, before[t][0].api_key);
        assert.equal(cfg[t][0].key_set, '2026-11-22 10:00:00');
        assert.equal(f.state.key, cfg[t][0].api_key);
      }
    } finally { await pico.close(); await pi.close(); }
  });
});

describe('forwarding', () => {
  test('requests, notifications, concurrency, sessions, current-revision headers and stdin close', async () => {
    const f = await fake('pico-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['pico-bay', '--config', dir], [f.port]);
      const init = await r.request(initialize(1));
      assert.equal(init.result.protocolVersion, '2025-06-18');
      assert.equal(init.result.capabilities.tools.listChanged, true);
      r.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await listTools(r, 2);
      f.state.sessionHeaders.length = 0; // the claim's ping came before any session

      // A slow call and a fast one: the fast answer comes out first.
      const slow = r.request(call(3, 'pico_thing', { ms: 600 }));
      const fast = r.request(call(4, 'pico_thing'));
      await Promise.all([slow, fast]);
      assert.deepEqual(r.replies.map(m => m.id), [1, 2, 4, 3], 'the notification wrote nothing');
      assert.ok(f.state.sessionHeaders.length >= 2 && f.state.sessionHeaders.every(sid => f.state.sessions.has(sid)), 'the session id goes with every call');

      // The current revision: the proxy fills in the headers the server checks.
      const modern = await r.request({
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'pico_thing', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} } },
      });
      assert.ok(modern.result, JSON.stringify(modern));

      // An expired session: initialize again once, then the call goes through.
      f.expire();
      assert.ok((await r.request(call(6, 'pico_thing'))).result);

      assert.equal((await r.request({ jsonrpc: '2.0', id: 7, method: 'ping' })).result !== undefined, true);
      assert.equal((await r.request({ jsonrpc: '2.0', id: 8, method: 'resources/list' })).error.code, -32601);
      assert.match((await r.request(call(9, 'nothing_here'))).error.message, /Unknown tool/);

      // stdin closes while a call runs: it still answers before the exit.
      r.send(call(10, 'pico_thing', { ms: 400 }));
      assert.equal(await r.close(), 0);
      assert.ok(r.replies.find(m => m.id === 10).result);
    } finally { await f.close(); }
  });

  test('MCP switched off on the server', async () => {
    const f = await fake('pico-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['pico-bay', '--config', dir], [f.port]);
      await r.request(initialize(1));
      await listTools(r, 2);
      f.state.off = true;
      f.expire();
      assert.match((await r.request(call(3, 'pico_thing'))).error.message, /MCP is switched off/);
      await r.close();
    } finally { await f.close(); }
  });

  test('nothing found: the proxy still starts, lists its own tools and says why', async () => {
    const dir = newConfigDir();
    const r = remote(['--config', dir], [await deadPort()]);
    assert.ok((await r.request(initialize(1))).result);
    r.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.deepEqual(toolNames(await listTools(r, 2)), BUILTIN);
    assert.match((await r.request(call(3, 'pi_devices_list'))).error.message, /not connected to a pi-bay server: no pi-bay found on the LAN.*--mcp http.*remote_rescan/);
    const report = await servers(r, 4);
    for (const t of ['ctrlpi-mcp', 'pico-bay', 'pi-bay']) assert.deepEqual(report[t].servers, []);
    assert.equal(report.config, path.join(dir, 'remote-config.json'));
    assert.match(report.message, /not connected to any server.*remote_rescan/);
    assert.equal(r.replies.length, 4);
    await r.close();
  });

  test('several servers of one target: each claimed with its own key, host on its tools, list tools fan out', async () => {
    const a = await fake('pico-bay');
    const b = await fake('pico-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['pico-bay', '--config', dir], [a.port, b.port]);
      await r.request(initialize(1));
      const tools = await listTools(r, 2);
      const saved = readConfig(dir)['pico-bay'];
      assert.equal(saved.length, 2);
      assert.notEqual(saved[0].api_key, saved[1].api_key);
      const hosts = [a.port, b.port].sort((x, y) => x - y).map(p => '127.0.0.1:' + p);

      for (const tool of tools.filter(t => !BUILTIN.includes(t.name))) assert.deepEqual(tool.inputSchema.properties.host.enum, hosts);
      assert.ok(!tools.find(t => t.name === 'remote_rescan').inputSchema.properties.host);
      assert.ok(tools.find(t => t.name === 'pico_thing').inputSchema.required.includes('host'));
      assert.ok(!(tools.find(t => t.name === 'pico_boards_list').inputSchema.required || []).includes('host'));

      const routed = await r.request(call(3, 'pico_thing', { host: '127.0.0.1:' + b.port }));
      assert.equal(toolText(routed).port, b.port);
      assert.deepEqual(toolText(routed).args, {}, 'host is not sent on');

      const fanned = toolText(await r.request(call(4, 'pico_boards_list')));
      assert.deepEqual(Object.keys(fanned).sort(), hosts);
      assert.equal(fanned['127.0.0.1:' + a.port].port, a.port);

      assert.match((await r.request(call(5, 'pico_thing'))).error.message, /host is required/);
      assert.match((await r.request(call(6, 'pico_thing', { host: '10.9.9.9' }))).error.message, /Unknown host/);

      // One goes offline: it drops out of the list.
      await b.close();
      const after = await listTools(r, 7);
      assert.deepEqual(after.find(t => t.name === 'pico_thing').inputSchema.properties.host.enum, ['127.0.0.1:' + a.port]);
      await r.close();
    } finally { await a.close(); }
  });
});

describe('all three servers', () => {
  test('one tool list, each call routed to its server by the tool name', async () => {
    const fakes = { 'ctrlpi-mcp': await fake('ctrlpi-mcp'), 'pico-bay': await fake('pico-bay'), 'pi-bay': await fake('pi-bay') };
    const dir = newConfigDir();
    try {
      const r = remote(['--config', dir], Object.values(fakes).map(f => f.port));
      await r.request(initialize(1));
      const tools = await listTools(r, 2);
      assert.deepEqual(toolNames(tools), [...BUILTIN, 'mcp_agents_list', 'mcp_thing', 'pico_boards_list', 'pico_thing', 'pico_ui', 'pi_devices_list', 'pi_thing', 'pi_ui'].sort());
      assert.ok(tools.every(t => !t.inputSchema.properties || !t.inputSchema.properties.host), 'one server each: no host');
      let id = 3;
      for (const [t, f] of Object.entries(fakes)) {
        const reply = toolText(await r.request(call(id++, PREFIX[t] + 'thing', { x: 1 })));
        assert.deepEqual([reply.service, reply.port, reply.args], [t, f.port, { x: 1 }]);
        assert.equal(readConfig(dir)[t][0].port, f.port);
      }
      const report = await servers(r, id++);
      for (const [t, f] of Object.entries(fakes)) assert.deepEqual(report[t], { servers: ['127.0.0.1:' + f.port], problems: [] });
      await r.close();
    } finally { for (const f of Object.values(fakes)) await f.close(); }
  });

  test('"targets" in remote-config.json turns servers off, and a target on the command line wins', async () => {
    const pico = await fake('pico-bay');
    const pi = await fake('pi-bay');
    const dir = newConfigDir();
    fs.writeFileSync(path.join(dir, 'remote-config.json'), JSON.stringify({ targets: ['pico-bay'] }));
    try {
      const r = remote(['--config', dir], [pico.port, pi.port]);
      await r.request(initialize(1));
      assert.deepEqual(toolNames(await listTools(r, 2)), [...BUILTIN, 'pico_boards_list', 'pico_thing', 'pico_ui'].sort());
      assert.match((await servers(r, 3))['pi-bay'].problems[0], /turned off in .*"targets"/);
      assert.equal(pi.state.key, DEFAULT, 'a server turned off is not claimed');
      await r.close();
      assert.deepEqual(readConfig(dir).targets, ['pico-bay'], 'a save keeps "targets"');

      const named = remote(['pi-bay', '--config', dir], [pico.port, pi.port]);
      await named.request(initialize(1));
      assert.deepEqual(toolNames(await listTools(named, 2)), [...BUILTIN, 'pi_devices_list', 'pi_thing', 'pi_ui'].sort());
      await named.close();
    } finally { await pico.close(); await pi.close(); }
  });

  test('host only on the target with several servers', async () => {
    const a = await fake('pico-bay');
    const b = await fake('pico-bay');
    const pi = await fake('pi-bay');
    const dir = newConfigDir();
    try {
      const r = remote(['--config', dir], [a.port, b.port, pi.port]);
      await r.request(initialize(1));
      const tools = await listTools(r, 2);
      assert.ok(tools.find(t => t.name === 'pico_thing').inputSchema.properties.host);
      assert.ok(!tools.find(t => t.name === 'pi_thing').inputSchema.properties.host);
      assert.equal(toolText(await r.request(call(3, 'pi_thing'))).port, pi.port);
      await r.close();
    } finally { await a.close(); await b.close(); await pi.close(); }
  });

  test('a server started later is found only by remote_rescan, and the client is told the tools changed', async () => {
    const pico = await fake('pico-bay');
    const piPort = await deadPort();
    const dir = newConfigDir();
    let pi;
    try {
      const r = remote(['--config', dir], [pico.port, piPort]);
      await r.request(initialize(1));
      assert.ok(!(await listTools(r, 2)).find(t => t.name === 'pi_thing'));
      pi = await fake('pi-bay', { port: piPort });
      await sleep(1000);
      assert.equal(pi.state.key, DEFAULT, 'no search without remote_rescan');
      assert.deepEqual(toolText(await r.request(call(6, 'remote_rescan')))['pi-bay'].servers, ['127.0.0.1:' + piPort]);
      await r.notification('notifications/tools/list_changed');
      assert.ok((await listTools(r, 3)).find(t => t.name === 'pi_thing'));
      assert.equal(toolText(await r.request(call(4, 'pi_thing'))).port, piPort);
      assert.equal(toolText(await r.request(call(5, 'pico_thing'))).port, pico.port, 'the server already in use still answers');
      await r.close();
    } finally { await pico.close(); if (pi) await pi.close(); }
  });

  test('remote_rescan searches again, even when every saved server answers', async () => {
    const a = await fake('pico-bay');
    const bPort = await deadPort();
    const dir = newConfigDir();
    let b;
    try {
      const r = remote(['pico-bay', '--config', dir], [a.port, bPort]);
      await r.request(initialize(1));
      await listTools(r, 2);
      b = await fake('pico-bay', { port: bPort });
      const report = toolText(await r.request(call(3, 'remote_rescan')));
      assert.deepEqual(report['pico-bay'].servers, [a.port, bPort].sort((x, y) => x - y).map(p => '127.0.0.1:' + p));
      await r.notification('notifications/tools/list_changed');
      assert.ok((await listTools(r, 4)).find(t => t.name === 'pico_thing').inputSchema.properties.host);
      await r.close();
    } finally { await a.close(); if (b) await b.close(); }
  });
});

describe('opening a remote UI here', () => {
  const browserScript = out => {
    const script = path.join(newConfigDir(), 'browser.js');
    fs.writeFileSync(script, 'require("fs").appendFileSync(' + JSON.stringify(out) + ', process.argv[2] + "\\n");\n');
    return script;
  };
  const opened = async file => {
    for (let i = 0; i < 40 && !fs.existsSync(file); i++) await sleep(50);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  };

  test('pico_ui and pi_ui: the URL of the server that answered opens here', async () => {
    const pico = await fake('pico-bay');
    const pi = await fake('pi-bay');
    const dir = newConfigDir();
    const out = path.join(dir, 'opened.txt');
    try {
      const r = remote(['--config', dir], [pico.port, pi.port], { CTRLPI_REMOTE_BROWSER: browserScript(out), DISPLAY: ':0' });
      await r.request(initialize(1));
      const ui = await r.request(call(2, 'pico_ui'));
      assert.deepEqual(toolText(ui), { url: 'http://127.0.0.1:' + pico.port, opened: true });
      assert.deepEqual(ui.result.structuredContent, { url: 'http://127.0.0.1:' + pico.port, opened: true });
      assert.equal(toolText(await r.request(call(3, 'pi_ui'))).opened, true);
      await sleep(300);
      assert.deepEqual((await opened(out)).sort(), ['http://127.0.0.1:' + pico.port + '/', 'http://127.0.0.1:' + pi.port + '/'].sort());

      // Any other address is passed on as it is, never opened.
      pico.state.uiUrl = 'http://10.9.9.9:7426';
      assert.deepEqual(toolText(await r.request(call(4, 'pico_ui'))).opened, false);
      await sleep(300);
      assert.equal((await opened(out)).length, 2);
      await r.close();
    } finally { await pico.close(); await pi.close(); }
  });

  test('over SSH the URL is passed on, not opened', async () => {
    const pico = await fake('pico-bay');
    const dir = newConfigDir();
    const out = path.join(dir, 'opened.txt');
    try {
      const r = remote(['--config', dir], [pico.port], { CTRLPI_REMOTE_BROWSER: browserScript(out), DISPLAY: ':0', SSH_CONNECTION: '10.0.0.2 5000 10.0.0.3 22' });
      await r.request(initialize(1));
      const ui = toolText(await r.request(call(2, 'pico_ui')));
      assert.equal(ui.opened, false);
      assert.match(ui.message, /not opened/);
      await sleep(300);
      assert.equal(fs.existsSync(out), false);
      await r.close();
    } finally { await pico.close(); }
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
      await r.request(initialize(1));
      const tools = await listTools(r, 2);
      assert.ok(tools.find(t => t.name === 'mcp_agents_list'));
      assert.equal(tools.length, 18 + BUILTIN.length, 'every ctrlpi-mcp tool has the mcp_ prefix');
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
        await r.request(initialize(1));
        const tools = await listTools(r, 2);
        assert.ok(tools.find(t => t.name === LIST_TOOL[bay.target]));
        assert.ok(tools.every(t => BUILTIN.includes(t.name) || t.name.startsWith(PREFIX[bay.target])));
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
