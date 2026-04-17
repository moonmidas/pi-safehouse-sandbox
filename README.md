# pi-safehouse-sandbox

Safehouse-backed sandboxing for Pi bash execution.

This extension adds `/sandbox` controls and routes both agent `bash` tool calls and user `!` commands through Safehouse when sandboxing is enabled.

## Requirements

> **Required dependency:** this extension needs the **Safehouse CLI** to work.

- Install `safehouse` on your machine.
- Make sure `safehouse` is available on your `PATH`.
- If Safehouse is missing, sandboxed execution is blocked and Pi will show an error.

## Features

- `/sandbox [on|off]` - enable/disable sandbox for the current project
- `/sandbox-allow-web [on|off]` - toggle unrestricted outbound web access
- `/sandbox-allowed-dir add <path> ro|rw` - allow additional directories
- `/sandbox-allowed-dir remove <path>` - remove an allowed directory
- `/sandbox-allowed-dir list` - show current extra allowed directories

Sandbox state is stored per project at:

- `<project-root>/.pi/sandbox-state.json`

## Install

### From a local folder

Copy this folder to:

- `~/.pi/agent/extensions/safehouse-sandbox`

Then start Pi (or run `/reload`).

### From GitHub

After publishing this folder/repo to GitHub:

```bash
pi install git:github.com/<your-user>/<your-repo>
```

Or for project-local install:

```bash
pi install -l git:github.com/<your-user>/<your-repo>
```

## Package metadata

This repo includes a `package.json` with a Pi package manifest:

- `pi.extensions: ["./index.ts"]`

So Pi can load the extension directly when installed via `pi install`.
