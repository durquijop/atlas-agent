export const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Kapso
  kapsoApiKey: process.env.KAPSO_API_KEY!,
  phoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID!,

  // Supabase
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE!,

  // LLM (OpenRouter)
  llmApiKey: process.env.LLM_API_KEY!,
  llmModel: process.env.LLM_MODEL || 'anthropic/claude-sonnet-4',
  llmBaseUrl: 'https://openrouter.ai/api/v1',

  // Diego's numbers (owner)
  ownerNumbers: (process.env.OWNER_NUMBERS || '17865698666,16787901191').split(','),

  // Agent identity
  agentName: 'Atlas',
};

export function validateConfig(): void {
  const required = ['kapsoApiKey', 'phoneNumberId', 'supabaseUrl', 'supabaseKey', 'llmApiKey'] as const;
  const missing = required.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }
}
