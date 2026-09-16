import OpenAI from "openai";
import type { ThinkingMode } from "../config.ts";

// Use the request-shaped assistant message here so deterministic fakes only
// need to provide the fields an Agent Runtime response actually uses.
export type ChatCompletionMessage = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
export type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatCompletionMessageToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
export type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ChatRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: ChatCompletionMessage;
}

/** The narrow seam consumed by the Agent Runtime and hand-written test fakes. */
export interface ChatClient {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export interface ChatClientConfig {
  baseURL: string;
  apiKey: string;
  thinking?: ThinkingMode;
}

type ThinkingParameter = { type: ThinkingMode };

export type CompatibleChatCompletionParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    thinking?: ThinkingParameter;
  };

/** Build the provider request without adding unsupported fields by default. */
export function buildChatCompletionBody(
  request: ChatRequest,
  options: { thinking?: ThinkingMode } = {},
): CompatibleChatCompletionParams {
  return {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    stream: false,
    ...(options.thinking === undefined
      ? {}
      : { thinking: { type: options.thinking } }),
  };
}

export function createChatClient(config: ChatClientConfig): ChatClient {
  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });

  return {
    async complete(request) {
      const body = buildChatCompletionBody(request, config);
      const response = await client.chat.completions.create(
        body,
        request.signal === undefined ? undefined : { signal: request.signal },
      );
      const choice = response.choices[0];
      if (!choice) {
        throw new Error("No response choice returned from LLM.");
      }
      return { message: choice.message };
    },
  };
}
