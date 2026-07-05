# opencode-config

Protects your opencode config from corruption, maintains versioned git history, validates against the JSON schema, and shows TUI notifications on errors.

## Features

- **Auto-snapshot** — every save to `opencode.json` creates a timestamped git commit in `~/.config/opencode/.config-history/`
- **Schema validation** — fetches the opencode JSON schema and validates your config on startup and on every edit
- **TUI notifications** — shows toast notifications and system alerts when config validation fails
- **5 AI commands** — lint, diff, doctor, rollback, and init via opencode prompts
- **Zero config** — just install and go

## Install

Add to your opencode config:

```json
{
  "plugin": ["opencode-config"]
}
```

## Commands

| Command | Description |
|---------|-------------|
| `config.lint` | Analyze config against JSON schema — catches deprecated keys, type errors, structure issues |
| `config.diff` | Show recent config change history from git |
| `config.doctor` | Full health check: valid JSON, git integrity, backup completeness |
| `config.rollback` | Restore a previous config version from git history |
| `config.init` | Generate a starter config interactively |

## How it works

1. On plugin load, initializes a git repo at `~/.config/opencode/.config-history/`
2. Fetches schemas from `https://opencode.ai/config.json` and `https://models.dev/model-schema.json`
3. Validates the current config with AJV (draft 2020-12)
4. Watches `opencode.json` for changes (file-level watch, not directory — avoids recursive FSEvents loops on macOS)
5. On change: snapshots the file to git, re-validates, writes errors to `validation-errors.log`
6. TUI plugin watches `validation-errors.log` and shows toast/notify on changes

## Development

```sh
bun install
bun run build
```
