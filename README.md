# Mini Pi Agent

Mini Pi Agent is a small, testable Agent Runtime for Node.js projects. The CLI bootstraps an injectable runtime, which talks to an OpenAI-compatible Chat Completions endpoint (Atria Dawn Preview by default) and exposes bounded `read`, `write`, `edit`, and `bash` tools.

The runtime owns message history, sequential tool execution, structured tool results, and the configured maximum number of model rounds. The CLI owns configuration, the one-shot question, and final output.

The runtime also exposes lifecycle events without enabling model token streaming:

```ts
for await (const event of agent.stream("...")) {
  console.log(event);
}
```

Events are `round_start`, `assistant`, `tool_start`, `tool_result`, `final`, and `error`. Model requests still use `stream: false`; these events describe runtime activity rather than token deltas.

## Requirements

- Node.js 20 or newer
- npm
- An Atria API key, or credentials for another OpenAI-compatible Chat Completions server

## Install

```bash
npm install
```

For a local OpenAI-compatible server, start it and make sure the configured model is available. For example, with Ollama:

```bash
ollama serve
ollama pull qwen3.5:9b
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MINI_PI_BASE_URL` | `https://api.atria-asi.ai/v1` | OpenAI-compatible API base URL |
| `MINI_PI_API_KEY` | unset | Preferred API key; takes precedence over `ATRIA_API_KEY` |
| `ATRIA_API_KEY` | unset | Fallback Atria API key |
| `MINI_PI_MODEL` | `Atria-Dawn-Preview` | Chat model name |
| `MINI_PI_MAX_ROUNDS` | `20` | Maximum model responses per run |
| `MINI_PI_BASH_TIMEOUT_MS` | `30000` | Default Bash timeout; maximum 300000 ms |
| `MINI_PI_MAX_TOOL_OUTPUT_BYTES` | `65536` | Maximum tool output size in bytes |

Mini Pi resolves the API key from `MINI_PI_API_KEY` first, then `ATRIA_API_KEY`. Empty or whitespace-only values are treated as unset. Startup fails with `MINI_PI_API_KEY or ATRIA_API_KEY must be set.` when neither variable contains a usable key.

Invalid numeric configuration also fails during startup.

The default Atria configuration can be used from PowerShell with:

```powershell
$env:ATRIA_API_KEY="YOUR_ATRIA_API_KEY"

npm.cmd run dev -- "读取 package.json，告诉我项目名称，不要修改任何文件"
```

The explicit equivalent is:

```powershell
$env:MINI_PI_BASE_URL="https://api.atria-asi.ai/v1"
$env:MINI_PI_API_KEY="YOUR_ATRIA_API_KEY"
$env:MINI_PI_MODEL="Atria-Dawn-Preview"

npm.cmd run dev -- "读取 package.json，告诉我项目名称，不要修改任何文件"
```

If an older shell still has the removed thinking variable, clean it up with:

```powershell
Remove-Item Env:MINI_PI_THINKING -ErrorAction SilentlyContinue
```

## Usage

```bash
npm run dev -- "读取 package.json，告诉我项目名称。不要修改文件。"
npm run dev -- "修复测试并运行 npm run check"
```

Without an argument, the agent reads `package.json` and reports the project name without modifying files.

## Tools

- `read`: reads bounded UTF-8 text from a project-relative path and rejects binary files.
- `write`: atomically creates or replaces a project file, creating parent directories as needed.
- `edit`: atomically replaces one unique literal text occurrence; zero or multiple matches fail without modifying the file.
- `bash`: runs a shell command from the project root, captures bounded output, reports exit status, and terminates the process tree on timeout or abort.

All file tools reject absolute paths, `..` escapes, and symbolic-link escapes. Existing targets are checked with `realpath`; new targets validate the nearest existing parent directory before creation.

## Validation

```bash
npm run typecheck
npm test
npm run check
```

Tests use Node.js `node:test`, real temporary directories, real filesystem operations, and a deterministic fake chat model. They do not call Ollama, external APIs, or require network access.

## Security warning

**The `bash` tool executes commands with the current operating-system user's permissions. Restricting the working directory is not a security sandbox. Commands can access resources outside the project. Do not run untrusted models or tasks in environments containing sensitive files or high-privilege credentials.**

This runtime intentionally does not implement Docker or OS-level sandboxing, command approval, or command blacklists. A blacklist would not provide reliable isolation.

## Current limitations

- No TUI
- Runtime lifecycle events are available, but model token streaming and a streaming UI are not implemented
- No sessions, branching, or context compaction
- No MCP or extensions
- No provider or model selection UI
- No multi-agent execution
- Tool calls run sequentially
- Text-only file tooling; no Base64 or binary editing
- No OS-level sandbox

## Roadmap

Potential later milestones include an interactive UI, persistent sessions, context compaction, approval policies, provider management, extension support, and stronger process isolation. These are not part of this runtime refactor.
