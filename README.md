# Mini Pi Agent

Mini Pi Agent is a minimal local coding agent for Node.js projects. It connects to an OpenAI-compatible Chat Completions endpoint (Ollama by default) and provides a complete coding loop: read files, make precise edits or write files, run commands, inspect failures, and retry until validation succeeds.

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
| `MINI_PI_MAX_ROUNDS` | `20` | Maximum model responses per run |
| `MINI_PI_BASH_TIMEOUT_MS` | `30000` | Default Bash timeout; maximum 300000 ms |
| `MINI_PI_MAX_TOOL_OUTPUT_BYTES` | `65536` | Maximum tool output size in bytes |

Invalid numeric configuration fails during startup.

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

Tests use Node.js `node:test`, real temporary directories, real filesystem operations, real local child processes, and a deterministic fake chat model. They do not call Ollama or external APIs.

## Security warning

**The `bash` tool executes commands with the current operating-system user's permissions. Restricting the working directory is not a security sandbox. Commands can access resources outside the project. Do not run untrusted models or tasks in environments containing sensitive files or high-privilege credentials.**

This milestone intentionally does not implement Docker or OS-level sandboxing, command approval, or command blacklists. A blacklist would not provide reliable isolation.

## Current limitations

- No TUI or streaming interface
- No session persistence, branching, or context compaction
- No MCP, skills, extensions, provider UI, or multi-agent execution
- Tool calls run sequentially
- Text-only file tools; no Base64 or binary editing

## Roadmap

Potential later milestones include an interactive UI, persistent sessions, context compaction, approval policies, provider management, extension support, and stronger process isolation. These are not part of Milestone 2.
