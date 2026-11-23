# ctrlPi Remote

[![Version 0.9.50](https://img.shields.io/badge/version-0.9.50-blue.svg)](https://github.com/ctrlpi/ctrlpi-remote/tags)
[![Node 20+](https://img.shields.io/badge/node-20%2B-blue.svg)](https://nodejs.org/)
[![Protocol: MCP](https://img.shields.io/badge/protocol-MCP-006400.svg)](#how-it-works)
[![License: MIT](https://img.shields.io/badge/license-MIT-188038.svg)](https://github.com/ctrlpi/ctrlpi-remote/blob/main/LICENSE)
![Status: Beta](https://img.shields.io/badge/status-Beta-red.svg)
[![Build Status](https://github.com/ctrlpi/ctrlpi-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/ctrlpi/ctrlpi-remote/actions)

Use `ctrlpi-mcp`, `pico-bay` or `pi-bay` running on a Raspberry Pi (or any other machine on your LAN) from Claude on your desktop.

`ctrlpi-remote` is a small stdio MCP server that runs on your desktop and forwards every MCP message to the server on the Pi. It finds the Pi by itself, gives the server a random key the first time, and from then on talks to it with that key only. Zero npm dependencies.

```
[Claude Desktop / Claude Code]
        │  MCP over stdio
        ▼
   [ctrlpi-remote]  (your desktop)
        │  MCP over HTTP, Api-Key
        ▼
   [pico-bay]  (a Raspberry Pi on your LAN, PI_HOST_ADDR:7426)
```

## Requirements

- Node.js 20 or newer on the desktop.
- On the Pi: `ctrlpi-mcp`, `pico-bay` or `pi-bay` 0.9.50 or newer, with its HTTP MCP on:
  - `npx ctrlpi-mcp --mcp http` (port 8315)
  - `npx pico-bay` (port 7426)
  - `npx pi-bay` (port 3141)

  A Raspberry Pi serves the bays' MCP on the network by default; on another computer, add `--mcp http --host 0.0.0.0`. The bays' web interface has no key: disable it with `--ui off`.

## Install

With the ctrlPi plugins: in Claude Desktop, open Plugins, choose Add > Add marketplace, enter `ctrlpi/claude-plugins`, and install `ctrlpi-mcp-remote`, `pico-bay-remote` or `pi-bay-remote`.

By hand, in any MCP client's config:

```json
{
  "mcpServers": {
    "pico-bay-remote": {
      "command": "npx",
      "args": ["-y", "ctrlpi-remote@0.9.50", "pico-bay"]
    }
  }
}
```

## Usage

```bash
ctrlpi-remote <ctrlpi-mcp | pico-bay | pi-bay> [--host ADDRESS] [--port PORT] [--config PATH] [--rotate-keys]
```

| Flag | Effect |
|---|---|
| `--host ADDRESS` | Use the server at this address; no LAN search. |
| `--port PORT` | Its port (default 8315, 7426 or 3141). |
| `--config PATH` | A folder holding `remote-config.json`, or that file itself. Default `~/.ctrlpi/`. |
| `--rotate-keys` | Give each saved server a new random key, save it, and exit. |

There is no key flag: a key on the command line would show in the process list and in the MCP client's config.

## How it works

1. **Find.** It checks the addresses saved in `~/.ctrlpi/remote-config.json` with `GET /hello`. When nothing is saved, or a saved address no longer answers, it searches your /24 for the server.
2. **Claim.** A server still on its default key (`/hello` says `"key": false`) gets a new random key. The key is saved, then sent; from then on the server accepts only that key. A server already claimed by someone else is skipped: put its key in `remote-config.json` to use it.
3. **Forward.** Every message from the MCP client goes to `POST /mcp` with `Api-Key`, the session id, and the protocol headers the server checks. Calls run side by side, with no time limit (firmware installs and long commands take minutes).

A server that moved to a new address is found again with its key. The saved key is sent to a new address only once the old one is confirmed dead.

If no server can be reached, `ctrlpi-remote` still starts and answers each request with the reason, so Claude can tell you what is wrong.

### Several Pis

`pico-bay` and `pi-bay` found on more than one Pi are all claimed, each with its own key, and shown to Claude as one set of tools with a `host` argument. `pico_boards_list` and `pi_devices_list` without `host` ask every Pi and return the results by host.

`ctrlpi-mcp` is different: two of them on one LAN would drive the same agents, so only the first one found is used, and the others are named in the log.

### Local and remote together

| Remote | Alongside its local plugin? |
|---|---|
| `pico-bay-remote` | Yes: the boards on the Pi are different from the ones on your desktop. |
| `ctrlpi-mcp-remote` | No: both would control the same agents. Use one. |
| `pi-bay-remote` | No: both would reach the same devices. Use one. |

## Config: `~/.ctrlpi/remote-config.json`

A list per target, one entry per server, each with its own key:

```json
{
  "pico-bay": [
    { "ip": "PI_HOST_ADDR", "port": 7426, "api_key": "...", "key_set": "2026-11-22 10:00:00", "updated_at": "2026-11-22 10:00:00" }
  ]
}
```

The file is readable by you only. A server set up by hand (its key already known) can be added here with `ip`, `port` and `api_key`.

## Keys on the server side

Each server keeps its key in its own file in `~/.ctrlpi/` on the Pi: `mcp-config.json` (`ctrlpi-mcp`), `pico-bay-config.json`, `pi-bay-config.json`, as `{"mcp": {"api_key": "...", "key_set": "..."}}`.

- `GET /hello` (no key) answers `{"service": "pico-bay", "key": true}`; `key` is `false` while the server is still on its default key, `your-mcp-key`.
- `POST /remote-config` with the current key in `Api-Key` and `{"api_key": "<new>"}` changes it. `--rotate-keys` uses it.
- Lost the key? Remove `mcp.api_key` from that file on the Pi and restart the server: it is back on the default and can be claimed again.

## Security

- Plain HTTP: the key crosses your LAN unencrypted, as the agents' keys do. Use it on trusted networks only.
- The key never reaches the model: it is not a tool argument, and changing it is not an MCP tool.
- Logs go to stderr only; stdout carries MCP messages.

## Tests

Run the test suite with:

```bash
npm test
```

The test suite runs against fake servers on `127.0.0.1` (`CTRLPI_REMOTE_SCAN_LAN=0` keeps the search on localhost), and against the real `ctrlpi-mcp`, `pico-bay` and `pi-bay` when they sit next to this folder. It needs no Pi on the network.

## License

[MIT](https://github.com/ctrlpi/ctrlpi-remote/blob/main/LICENSE)
