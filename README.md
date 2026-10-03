# opencode-chair-guard

Chair guard for [OpenCode](https://opencode.ai). The orchestrator plans, delegates, and reconciles. File edits on that session are refused until a specialist is spawned.

The rule is about the agent, not the model. Opus, an OpenCode Go model, or anything else can sit in the chair. Workers stay on whatever models you already assigned.

It is meant to sit next to an orchestrator that already has specialists, such as [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim). The guard only watches the agent named `orchestrator`.

## Install

OpenCode reads plugins when the process starts. Quit every running `opencode` session after you change the plugin list, then start it again. A session that is already open keeps the hooks it booted with.

### From this checkout

This is the install to use before the package is on npm.

1. Clone the repo:

   ```bash
   git clone git@github.com:timothy-cloudopsguy/opencode-chair-guard.git
   ```

2. Add the absolute `file://` URL to the `plugin` array in `~/.config/opencode/opencode.json`. Put it after your other plugins. On macOS and Linux the path is the same shape:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": [
       "oh-my-opencode-slim",
       "file:///ABSOLUTE/PATH/opencode-chair-guard"
     ]
   }
   ```

   Print the URL for your checkout:

   ```bash
   printf 'file://%s\n' "$(cd /path/to/opencode-chair-guard && pwd)"
   ```

   The directory must contain this `package.json`. OpenCode loads `index.ts` with Bun, so there is no build step.

3. Restart OpenCode. The log line `[chair-guard] loaded` means the plugin initialized.

A project `opencode.json` can list the same `file://` entry when you want the guard in one project only. User config and project config both load, so do not list it in both.

### From npm, after publish

Once `opencode-chair-guard` is published:

```bash
opencode plugin opencode-chair-guard
```

That command installs the package and adds the name to your config. The same entry written by hand is:

```json
"plugin": ["opencode-chair-guard"]
```

Restart OpenCode after either change.

## Configure

Copy the example config if you do not already have one:

```bash
cp examples/chair-guard.json ~/.config/opencode/chair-guard.json
```

`soloEdits` controls the gate:

| Value | Behavior |
| --- | --- |
| `null` or omitted | Wall. Every orchestrator edit is refused until a specialist is spawned. |
| `0` | Gate off. |
| A positive number, such as `3` | One-time nudge. That many solo edits are counted, the last one is refused once, then the chair is left alone. |

```json
{
  "soloEdits": null
}
```

A missing file uses the wall. Invalid JSON is logged and also falls back to the wall.

The gate counts `edit`, `write`, `apply_patch`, and `ast_grep_replace`. A `task`, `task_batch`, or `subagent` call with a specialist name disarms it for the rest of that session. Specialist sessions are never blocked.

## Orchestrator prompt

The hook is what enforces the rule. A short prompt still helps the chair delegate before the first refusal.

If you use oh-my-opencode-slim, copy the example onto the active preset. For a preset named `cal-default`:

```bash
mkdir -p ~/.config/opencode/oh-my-opencode-slim/cal-default
cp examples/orchestrator_append.md ~/.config/opencode/oh-my-opencode-slim/cal-default/orchestrator_append.md
```

Slim loads `~/.config/opencode/oh-my-opencode-slim/<preset>/orchestrator_append.md` after its built-in orchestrator prompt. Replace `<preset>` with the `"preset"` value in `~/.config/opencode/oh-my-opencode-slim.json`.

The example routes by agent name (`@explorer`, `@librarian`, `@fixer`, `@oracle`, `@designer`). Change those names if your specialists are different. The hook's refusal text uses the same names.

## Check that it is on

1. Restart OpenCode.
2. Start an orchestrator session.
3. Ask for a code change.
4. The chair's first `edit` or `write` should come back as an error telling it to spawn a specialist. A later `task` with `subagent_type` set should be allowed, and edits after that spawn should go through.

`bash` is not gated. A chair that writes files from the shell will not trip the guard.

## Develop

```bash
npm test
```

That runs `node --test guard.test.mjs`. Node 20 or newer is enough. The tests do not start OpenCode.

## Publish

From a clean checkout, after `npm login`:

```bash
npm publish
```

The package is public (`publishConfig.access` is `public`). The npm name is `opencode-chair-guard`. After publish, switch installs from the `file://` URL to the package name so updates come from npm.

## Limits

- Only the agent named `orchestrator` is guarded.
- `bash` can still write files.
- The refusal fires in the tool hook. A chair that never calls `edit`, `write`, `apply_patch`, or `ast_grep_replace` is not blocked.
- Hooks load at process start. Install the plugin and keep working in an existing window, and nothing changes until you restart.
