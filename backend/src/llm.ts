import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import { buildGenerationPrompt } from "./prompts.js";

export type StreamHandlers = {
  onReasoning?: (chunk: string) => void;
  onContent?: (chunk: string) => void;
};

export function createOpenAiClient(config: AppConfig): OpenAI {
  return new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl
  });
}

export async function generateProjectFromIdea(
  config: AppConfig,
  idea: string,
  handlers: StreamHandlers = {}
): Promise<string> {
  const client = createOpenAiClient(config);
  const prompt = buildGenerationPrompt(idea);

  const stream = await client.chat.completions.create({
    model: config.openaiModel,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: 16384,
    stream: true,
    // NVIDIA / reasoning-model compatibility (ignored by OpenAI).
    reasoning_budget: 16384,
    chat_template_kwargs: { enable_thinking: true }
  } as OpenAI.Chat.ChatCompletionCreateParamsStreaming);

  let content = "";

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta as { content?: string; reasoning_content?: string } | undefined;

    const reasoning = delta?.reasoning_content;
    if (reasoning) {
      handlers.onReasoning?.(reasoning);
    }

    const piece = delta?.content ?? "";
    if (piece) {
      content += piece;
      handlers.onContent?.(piece);
    }
  }

  if (!content.trim()) {
    throw new Error("Model returned an empty response");
  }

  return content;
}
