import { saveMemory, deleteMemory, listMemory, setConfig } from './memory';
import { config } from './config';

export interface CommandResult {
  handled: boolean;
  response?: string;
}

const COMMAND_PREFIXES = [
  { prefix: 'aprende:', handler: handleLearn },
  { prefix: 'recuerda:', handler: handleRemember },
  { prefix: 'olvida:', handler: handleForget },
  { prefix: 'memoria', handler: handleListMemory },
  { prefix: 'modelo:', handler: handleModelChange },
  { prefix: 'atlas modelo', handler: handleShowModel },
];

export async function handleCommand(text: string): Promise<CommandResult> {
  const lower = text.toLowerCase().trim();

  for (const { prefix, handler } of COMMAND_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const arg = text.slice(prefix.length).trim();
      try {
        const response = await handler(arg);
        return { handled: true, response };
      } catch (error) {
        return { handled: true, response: `Error: ${(error as Error).message}` };
      }
    }
  }

  return { handled: false };
}

async function handleLearn(arg: string): Promise<string> {
  // Format: "Aprende: Título - Contenido" or "Aprende: Contenido"
  const dashIdx = arg.indexOf(' - ');
  let title: string;
  let content: string;

  if (dashIdx > 0 && dashIdx < 80) {
    title = arg.slice(0, dashIdx).trim();
    content = arg.slice(dashIdx + 3).trim();
  } else {
    title = arg.slice(0, 60).trim();
    content = arg;
  }

  if (!content) return 'Formato: "Aprende: Título - Contenido"';

  const result = await saveMemory({
    category: 'knowledge',
    title,
    content,
    tags: extractTags(content),
  });

  return `✅ ${result}`;
}

async function handleRemember(arg: string): Promise<string> {
  const dashIdx = arg.indexOf(' - ');
  let title: string;
  let content: string;

  if (dashIdx > 0 && dashIdx < 80) {
    title = arg.slice(0, dashIdx).trim();
    content = arg.slice(dashIdx + 3).trim();
  } else {
    title = arg.slice(0, 60).trim();
    content = arg;
  }

  if (!content) return 'Formato: "Recuerda: Título - Contenido"';

  const result = await saveMemory({
    category: 'context',
    title,
    content,
    tags: extractTags(content),
  });

  return `✅ ${result}`;
}

async function handleForget(title: string): Promise<string> {
  if (!title) return 'Formato: "Olvida: título a borrar"';
  const result = await deleteMemory(title);
  return `🗑️ ${result}`;
}

async function handleListMemory(_arg: string): Promise<string> {
  const entries = await listMemory();

  if (entries.length === 0) return 'No tengo nada guardado en memoria.';

  const grouped: Record<string, string[]> = {};
  for (const e of entries) {
    if (!grouped[e.category]) grouped[e.category] = [];
    grouped[e.category].push(`• ${e.title}`);
  }

  const lines: string[] = [`Tengo ${entries.length} entradas en memoria:\n`];
  for (const [cat, items] of Object.entries(grouped)) {
    lines.push(`*${cat.toUpperCase()}*`);
    lines.push(...items);
    lines.push('');
  }

  return lines.join('\n');
}

async function handleModelChange(model: string): Promise<string> {
  if (!model) return 'Formato: "Modelo: anthropic/claude-opus-4.6"';

  await setConfig('llm_model', model.trim());
  // Also update runtime config
  (config as { llmModel: string }).llmModel = model.trim();

  return `✅ Modelo cambiado a: ${model.trim()}\n(Efectivo inmediatamente)`;
}

async function handleShowModel(_arg: string): Promise<string> {
  return `Modelo actual: ${config.llmModel}`;
}

function extractTags(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/);
  const stopWords = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'en', 'un', 'una', 'que', 'es', 'y', 'a', 'por', 'para', 'con', 'se', 'no', 'su', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'le', 'ya', 'o', 'fue', 'este', 'ha', 'si', 'porque', 'esta', 'son', 'entre', 'cuando', 'muy', 'sin', 'sobre', 'ser', 'también', 'me', 'hasta', 'hay', 'donde', 'quien', 'desde', 'todo', 'nos', 'the', 'is', 'and', 'to', 'of', 'in', 'for', 'on', 'with', 'that', 'this', 'are', 'was', 'be', 'has', 'had', 'have', 'not', 'but']);

  return [...new Set(
    words.filter((w) => w.length > 3 && !stopWords.has(w))
  )].slice(0, 10);
}
