import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const client = new OpenAI({
  // Ollama's OpenAI-compatible endpoint does not require a real API key.
  apiKey: "ollama",
  baseURL: "http://127.0.0.1:11434/v1",
});

// ---------- Tool ----------

interface Tool {
  name: string;
  description: string;
  parameters: object;
  execute(args: any): Promise<string>;
}

const readFileTool: Tool = {
  name: "read_file",

  description: "Read a text file from the current project",

  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative file path",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },

  async execute(args: { path: string }) {
    const root = process.cwd();
    const file = path.resolve(root, args.path);

    // 简单防止访问项目目录之外
    if (file !== root && !file.startsWith(root + path.sep)) {
      throw new Error("Cannot read outside project directory");
    }

    return await fs.readFile(file, "utf8");
  },
};

const tools = [readFileTool];

// ---------- Tool Runtime ----------

function findTool(name: string) {
  return tools.find((tool) => tool.name === name);
}

async function executeToolCall(
  call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
) {
  const tool = findTool(call.function.name);

  if (!tool) {
    return {
      role: "tool" as const,
      tool_call_id: call.id,
      content: `Tool not found: ${call.function.name}`,
    };
  }

  try {
    const args = JSON.parse(call.function.arguments);

    console.log(`\n[tool] ${tool.name}`, args);

    const result = await tool.execute(args);

    return {
      role: "tool" as const,
      tool_call_id: call.id,
      content: result,
    };
  } catch (error) {
    return {
      role: "tool" as const,
      tool_call_id: call.id,
      content:
        error instanceof Error
          ? `Error: ${error.message}`
          : "Unknown tool error",
    };
  }
}

// ---------- Agent Loop ----------

async function runAgent(userInput: string) {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `
You are a coding agent.

Use tools when you need information from the project.
Do not guess file contents.
`,
    },

    {
      role: "user",
      content: userInput,
    },
  ];

  while (true) {
    console.log("\n[agent] calling model...");

    const response = await client.chat.completions.create({
      model: "qwen3.5:9b",
      messages,

      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    });

    const assistant = response.choices[0].message;

    messages.push(assistant);

    // 没有 tool call → Agent 完成
    if (!assistant.tool_calls || assistant.tool_calls.length === 0) {
      console.log("\n[assistant]\n", assistant.content);

      return assistant.content;
    }

    // 有 tool call → 执行工具
    for (const call of assistant.tool_calls) {
      if (call.type !== "function") {
        continue;
      }

      const toolResult = await executeToolCall(call);

      messages.push(toolResult);

      console.log(`[tool result] ${toolResult.content.slice(0, 200)}...`);
    }

    // 不 return
    // 继续 while
    // ToolResult 会再次发给 LLM
  }
}

// ---------- Start ----------

const question =
  process.argv.slice(2).join(" ") ||
  "读取 package.json，告诉我这个项目叫什么";

await runAgent(question);
