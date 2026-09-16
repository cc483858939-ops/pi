# Mini Pi Agent

Mini Pi Agent is a small, testable Agent Runtime for Node.js projects. The CLI bootstraps an injectable runtime, which talks to an OpenAI-compatible Chat Completions endpoint (Ollama by default) and exposes bounded `read`, `write`, `edit`, and `bash` tools.

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
- Ollama or another OpenAI-compatible Chat Completions server

## Install

```bash
npm install
```

For the default configuration, start Ollama and make sure the configured model is available:

```bash
ollama serve
ollama pull qwen3.5:9b
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MINI_PI_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible API base URL |
| `MINI_PI_API_KEY` | `ollama` | API key sent to the SDK |
| `MINI_PI_MODEL` | `qwen3.5:9b` | Chat model name |
| `MINI_PI_THINKING` | unset | Optional DeepSeek-compatible thinking mode: `enabled` or `disabled` |
| `MINI_PI_MAX_ROUNDS` | `20` | Maximum model responses per run |
| `MINI_PI_BASH_TIMEOUT_MS` | `30000` | Default Bash timeout; maximum 300000 ms |
| `MINI_PI_MAX_TOOL_OUTPUT_BYTES` | `65536` | Maximum tool output size in bytes |

`MINI_PI_THINKING` is optional. If omitted, Mini Pi leaves thinking behavior to the API provider/model and does not send a `thinking` field. Invalid values fail during startup; only `enabled` and `disabled` are accepted.

Invalid numeric configuration also fails during startup.

For a DeepSeek-compatible API, thinking can be disabled explicitly:

```powershell
$env:MINI_PI_BASE_URL="https://api.deepseek.com"
$env:MINI_PI_API_KEY="YOUR_DEEPSEEK_API_KEY"
$env:MINI_PI_MODEL="deepseek-flash"
$env:MINI_PI_THINKING="disabled"

npm.cmd run dev -- "读取 package.json，告诉我项目名称"
```

Re-enable thinking with:

```powershell
$env:MINI_PI_THINKING="enabled"
```

To return to provider-default behavior, remove the setting:

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
