# CLAUDE.md - ctrlpi-remote

This file provides guidance to Claude Code when working in this repository.

## What this is

A zero-dependency stdio MCP server (`ctrlpi-remote.js`, Node 20+) that forwards every MCP message to a `ctrlpi-mcp`, `pico-bay` or `pi-bay` running in HTTP mode on another machine, picked by the first argument. The npm package is **`ctrlpi-remote`** (unscoped), executable `ctrlpi-remote.js`. The `files` allowlist in `package.json` ships only `ctrlpi-remote.js` (plus npm's own README, LICENSE and package.json), so this file never ships; re-check with `npm pack --dry-run` after touching it.

It lives at `ctrlpi-remote/` in the ctrlpi workspace, its own git repository (the root gitignores it). The root `CLAUDE.md` rules apply here. Publishing is described in the root `CLAUDE.md` only.

## Design

- **Targets** (`TARGETS`): default port, the list tool that fans out, and `single` (ctrlpi-mcp: only the first server found is used, since two would drive the same agents).
- **Config**: `~/.ctrlpi/remote-config.json` (`--config` folder or `.json` path, `resolveConfigFile()`), a list per target of `{ip, port, api_key, key_set, updated_at}`. A write (`saveServers()`) replaces only its own target's list, atomically, mode `0600`. No `--key` flag, ever: keys live only in the file.
- **`resolveServers()`**: `--host` uses that server only. Otherwise every saved address is checked with `GET /hello`; when nothing is saved or a saved address is dead, `sweep()` searches the /24 (`localIp()`: UDP socket to `8.8.8.8:80`, then the interfaces). A found server on the default key is claimed (`claim()`: the key is saved first, sent with a ping, and removed again if refused). A found server already claimed is tried only with the keys of dead entries (a moved server); that is the rule that a saved key goes to a new address only once the old one is dead. A server on the default key is never sent a key it would claim by accident.
- **Forwarding** (`createProxy()`): `POST /mcp` with `Api-Key`, `Mcp-Session-Id`, and `protocolHeaders()` (on the current revision `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` from the body, as pico-bay and pi-bay check; otherwise the negotiated version). `202` writes nothing; `403` is a key error; `404` with a JSON-RPC body is passed on, without one it re-initializes once, then reports "MCP is switched off". Only the connection has a timeout (`CONNECT_TIMEOUT_MS`), never the answer. stdin closing waits for the requests already sent.
- **Several servers**: `tools/list` comes from the first live server with a `host` enum added (required except on the list tool); `tools/call` routes by `host`, or fans the list tool out and merges the results by host. A server that stops answering `/hello` drops out of the enum.
- No servers: the proxy still starts and answers each request with the reason.
- **UI tools** (`pico_ui`, `pi_ui`): forwarded like any tool, so they run on the remote bay. A remote request is never a local desktop, so the browser does not open: the result is `opened: false` and a `url` built from the request's `Host` (checked against a real `pico-bay` and `pi-bay` on b4.local: `http://b4.local:7426` and `:3141`). The user opens that URL themselves. It works only when the bay listens on a reachable address (`--host 0.0.0.0`, or the Pi default; `pico-bay` and `pi-bay` bind to `127.0.0.1` otherwise), and the web UI has no key, so `--host 0.0.0.0` exposes it to the LAN. With `--ui off` the tool refuses with a tool error. `ctrlpi-mcp` has no UI tool.
- `--rotate-keys`: `POST /remote-config` with a new key per server, saved on `200`, then exit.

## Tests

`npm test` runs `test/ctrlpi-remote.test.js`: fake servers in the test process (never `spawnSync` the proxy there, it would block them), with `CTRLPI_REMOTE_SCAN_LAN=0` and `CTRLPI_REMOTE_SCAN_PORTS` keeping every search on `127.0.0.1`. When the workspace has them next to this folder, it also runs against the real `ctrlpi-mcp --http` (subprocess) and `pico-bay` / `pi-bay` (in process, `HOME` moved, only `initialize` and `tools/list`, so no board or SSH device is touched).
