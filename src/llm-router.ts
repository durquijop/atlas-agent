/**
 * LLM Router — Atlas Multi-Agent System
 * 
 * Cada agente usa el modelo óptimo para su tarea:
 * 
 *   Orchestrator  → Claude Sonnet 4.5  (conversación + razonamiento)
 *   Critic        → Claude Haiku 3.5   (rápido, tarea simple de clasificación)
 *   Research      → Gemini Pro          (síntesis de información larga)
 *   Memory        → Claude Sonnet 4.5  (análisis profundo de conversación)
 *   Monitor       → Claude Haiku 3.5   (clasificar emails, no necesita mucho)
 * 
 * Todos vía OpenRouter — una sola API key, múltiples modelos.
 */

import { config } from './config';

export type AgentRole = 'orchestrator' | 'critic' | 'research' | 'memory' | 'monitor';

const OPUS = 'anthropic/claude-opus-4.6';

const MODEL_MAP: Record<AgentRole, string> = {
  orchestrator: OPUS,
  critic: OPUS,
  research: OPUS,
  memory: OPUS,
  monitor: OPUS,
};

const MAX_TOKENS_MAP: Record<AgentRole, number> = {
  orchestrator: 1024,
  critic: 512,
  research: 2048,
  memory: 1024,
  monitor: 512,
};

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string; code: number };
}

export async function callLLM(
  agent: AgentRole,
  messages: LLMMessage[],
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const model = MODEL_MAP[agent];
  const maxTokens = options?.maxTokens || MAX_TOKENS_MAP[agent];
  const temperature = options?.temperature ?? (agent === 'critic' ? 0.1 : 0.7);

  console.log(`[llm-router] ${agent} → ${model} (max_tokens=${maxTokens})`);

  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.llmApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // Fallback to main model if agent-specific model fails
    if (model !== config.llmModel) {
      console.warn(`[llm-router] ${model} failed (${res.status}), falling back to ${config.llmModel}`);
      return callLLM('orchestrator', messages, options);
    }
    throw new Error(`LLM API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as OpenRouterResponse;
  if (data.error) throw new Error(`LLM error: ${data.error.message}`);

  return data.choices?.[0]?.message?.content || 'No response generated.';
}
