import { config } from './config';
import { ConversationMessage, getBusinessSnapshot } from './supabase';
import { buildSystemContext, getConfigValue } from './memory';
import { getEpisodicContext } from './agents/memory-agent';

// Fallback prompt if Supabase memory table doesn't exist yet
const FALLBACK_PROMPT = `Eres Atlas, el mentor CEO personal de Diego Urquijo.
CEO de URPE Integral Services (inmigración USA) y Urpe AI Lab (tech/AI).
Eres su mentor ejecutivo, estratega y sparring partner. NO eres un asistente genérico.
Español, directo, sin rodeos. Tuteas a Diego. Respuestas concisas. Esto es WhatsApp, párrafos cortos.`;

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string; code: number };
}

export async function generateResponse(
  messages: ConversationMessage[],
  userMessage: string,
  includeBusinessData = false
): Promise<string> {
  // Build system prompt from Supabase memory (soul + context + relevant knowledge)
  let systemPrompt: string;
  try {
    systemPrompt = await buildSystemContext(userMessage);
    if (!systemPrompt || systemPrompt.length < 20) systemPrompt = FALLBACK_PROMPT;
  } catch (_) {
    systemPrompt = FALLBACK_PROMPT;
  }

  const systemParts = [systemPrompt];

  // Always include recent episodic context (last 2 weeks)
  try {
    const episodic = await getEpisodicContext();
    if (episodic) systemParts.push(episodic);
  } catch (_) {}

  if (includeBusinessData) {
    try {
      const snapshot = await getBusinessSnapshot();
      systemParts.push(
        `\n\n## Datos del negocio (hoy)\n${JSON.stringify(snapshot, null, 2)}`
      );
    } catch (_) {
      // Business data is optional
    }
  }

  // Check if model override exists in memory config
  try {
    const modelOverride = await getConfigValue('llm_model');
    if (modelOverride) (config as { llmModel: string }).llmModel = modelOverride;
  } catch (_) {}

  const chatMessages = [
    { role: 'system', content: systemParts.join('') },
    ...messages.slice(-20).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: userMessage },
  ];

  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.llmApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages: chatMessages,
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as OpenRouterResponse;

  if (data.error) {
    throw new Error(`LLM error: ${data.error.message}`);
  }

  return data.choices?.[0]?.message?.content || 'No pude generar una respuesta.';
}
