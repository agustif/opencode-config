import { Effect, Scope } from "effect"
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import Ajv from "ajv/dist/2020"
import type { ErrorObject } from "ajv"
import path from "node:path"
import * as fs from "node:fs"

const HOME = process.env.HOME || "/tmp"
const CONFIG_DIR = path.join(HOME, ".config", "opencode")
const CONFIG_PATH = path.join(CONFIG_DIR, "opencode.json")
const BACKUP_DIR = path.join(CONFIG_DIR, ".config-history")
const TRACKED = path.join(BACKUP_DIR, "config.json")
const VALIDATION_LOG = path.join(BACKUP_DIR, "validation-errors.log")
const SCHEMA_URL = "https://opencode.ai/config.json"
const MODEL_SCHEMA_URL = "https://models.dev/model-schema.json"

const ts = () => new Date().toISOString().replace(/[:.]/g, "-")

type Validator = (config: unknown) => { valid: boolean; errors: Array<ErrorObject> }

const formatError = (err: ErrorObject) => {
  const p = err.instancePath || "."
  if (err.params && "additionalProperty" in err.params)
    return `${p}: unknown key "${err.params.additionalProperty}"`
  if (err.params && "missingProperty" in err.params)
    return `${p}: missing required key "${err.params.missingProperty}"`
  if (err.params && "allowedValues" in err.params)
    return `${p}: must be one of: ${(err.params.allowedValues as Array<unknown>).join(", ")}`
  return `${p}: ${err.message}`
}

const writeValidation = (errors: Array<ErrorObject>) => {
  const msg = errors.length === 0 ? "" : errors.slice(0, 5).map(formatError).join("\n")
  try { fs.writeFileSync(VALIDATION_LOG, msg) } catch {}
}

const createValidator = (schema: unknown, modelSchema: unknown): Validator => {
  const ajv = new Ajv({ allowUnionTypes: true, strict: false })
  ajv.addSchema(modelSchema, "https://models.dev/model-schema.json")
  const validate = ajv.compile(schema)
  return (config: unknown) => {
    const valid = validate(config)
    return { valid, errors: validate.errors ?? [] }
  }
}

// Copy config to a single tracked file. Git stores history via commits —
// no timestamped copies, no unbounded file growth.
// stderr is redirected to /dev/null to avoid polluting the TUI.
const snapshot = async () => {
  await Bun.write(TRACKED, Bun.file(CONFIG_PATH))
  await Bun.$`git -C ${BACKUP_DIR} add config.json`.nothrow().quiet()
  const diff = await Bun.$`git -C ${BACKUP_DIR} diff --cached --quiet`.nothrow().quiet()
  if (diff.exitCode !== 0) {
    await Bun.$`git -C ${BACKUP_DIR} commit -m ${`config ${ts()}`}`.nothrow().quiet()
  }
}

const runValidation = async (validate: Validator | undefined) => {
  if (!validate) return
  try {
    const config = await Bun.file(CONFIG_PATH).text().then(JSON.parse)
    const { valid, errors } = validate(config)
    writeValidation(valid ? [] : errors)
  } catch {
    writeValidation([])
  }
}

const tui: TuiPlugin = async (api) => {
  if (!fs.existsSync(BACKUP_DIR)) return

  let lastContent: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const check = () => {
    const content = fs.existsSync(VALIDATION_LOG)
      ? fs.readFileSync(VALIDATION_LOG, "utf-8").trim()
      : ""
    if (content === lastContent) return
    lastContent = content

    if (content) {
      const lines = content.split("\n").filter(Boolean)
      api.ui.toast({
        variant: "error",
        title: `Config: ${lines.length} issue${lines.length === 1 ? "" : "s"}`,
        message: lines.slice(0, 3).join("; ").slice(0, 150),
      })
      api.attention.notify({
        title: "Config Error",
        message: lines[0] || "Config validation failed",
        notification: { when: "blurred" },
        sound: { name: "error" },
      })
    } else {
      api.ui.toast({ variant: "success", message: "Config valid", duration: 2000 })
    }
  }

  const watcher = fs.watch(BACKUP_DIR, (_e, filename) => {
    if (filename !== "validation-errors.log") return
    clearTimeout(timer)
    timer = setTimeout(check, 200)
  })

  api.lifecycle.onDispose(() => {
    watcher.close()
    clearTimeout(timer)
  })

  check()
}

const effect = (ctx: PluginContext): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.promise(() => Bun.$`mkdir -p ${BACKUP_DIR}`.nothrow().quiet())
    yield* Effect.promise(() => Bun.$`git -C ${BACKUP_DIR} init`.nothrow().quiet())
    yield* Effect.promise(() => Bun.$`git -C ${BACKUP_DIR} config user.email opencode-config@local`.nothrow().quiet())
    yield* Effect.promise(() => Bun.$`git -C ${BACKUP_DIR} config user.name opencode-config`.nothrow().quiet())
    yield* Effect.promise(() => Bun.$`git -C ${BACKUP_DIR} add -A`.nothrow().quiet())
    yield* Effect.promise(() => Bun.$`git -C ${BACKUP_DIR} commit -m init`.nothrow().quiet())
    yield* Effect.promise(() => snapshot())

    try { fs.writeFileSync(VALIDATION_LOG, "") } catch {}

    let validate: Validator | undefined

    // Background schema fetch — plain async, no Effect scope dependency
    setTimeout(async () => {
      try {
        const [configSchema, modelSchema] = await Promise.all([
          fetch(SCHEMA_URL).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() }),
          fetch(MODEL_SCHEMA_URL).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() }),
        ])
        validate = createValidator(configSchema, modelSchema)
        await runValidation(validate)
      } catch {
        writeValidation([])
      }
    }, 500)

    yield* ctx.command.transform((draft) => {
      draft.update("config.lint", (cmd) => {
        cmd.template = [
          "Analyze ~/.config/opencode/opencode.json. For each finding, show the exact key path and how to fix it.",
          "",
          "Report on:",
          "- Keys not recognized by the JSON schema (additionalProperties violations)",
          "- Incorrect types",
          "- Deprecated keys (model, provider whitelist/blacklist, mode block, autoshare)",
          "- Structural issues",
          "- Improvement suggestions",
        ].join("\n")
        cmd.description = "Lint opencode configuration against JSON schema"
      })
      draft.update("config.diff", (cmd) => {
        cmd.template = [
          "Show recent opencode config changes.",
          "Run: git -C ~/.config/opencode/.config-history log --oneline -15",
          "Then: git -C ~/.config/opencode/.config-history show --stat HEAD",
          "Summarize what changed.",
        ].join("\n")
        cmd.description = "Show config change history"
      })
      draft.update("config.doctor", (cmd) => {
        cmd.template = [
          "Check opencode config health:",
          "1. Validate ~/.config/opencode/opencode.json is valid JSON",
          "2. Confirm backups exist in ~/.config/opencode/.config-history/",
          "3. Verify git integrity: git -C ~/.config/opencode/.config-history fsck",
          "4. Test config loads: opencode run 'echo healthy' --log-level ERROR",
          "Report all findings.",
        ].join("\n")
        cmd.description = "Config health check"
      })
      draft.update("config.rollback", (cmd) => {
        cmd.template = [
          "Restore opencode config from git history.",
          "",
          "1. List commits: git -C ~/.config/opencode/.config-history log --oneline -20",
          "2. Show what changed: git -C ~/.config/opencode/.config-history diff <hash>^..<hash> -- config.json",
          "3. Restore: git -C ~/.config/opencode/.config-history show <hash>:config.json > ~/.config/opencode/opencode.json",
          "4. Confirm the file looks correct",
        ].join("\n")
        cmd.description = "Rollback config to a previous version"
      })
      draft.update("config.init", (cmd) => {
        cmd.template = [
          "Generate a starter opencode config interactively.",
          "Ask the user for: preferred model, shell, formatter, providers.",
          "Write to ~/.config/opencode/opencode.json",
          "Validate with: opencode run 'echo ok' --log-level ERROR",
        ].join("\n")
        cmd.description = "Generate a starter config"
      })
    })

    // Watch the FILE directly, not the directory — on macOS, fs.watch on a
    // directory is recursive (FSEvents), so watching CONFIG_DIR would fire
    // when we write snapshots to BACKUP_DIR (a subdirectory), causing an
    // infinite commit loop.
    let debounce: ReturnType<typeof setTimeout> | undefined
    const watcher = fs.watch(CONFIG_PATH, { persistent: false }, () => {
      clearTimeout(debounce)
      debounce = setTimeout(async () => {
        await snapshot()
        await runValidation(validate)
      }, 500)
    })

    yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()))
  })

export default { id: "opencode-config", effect, tui }
