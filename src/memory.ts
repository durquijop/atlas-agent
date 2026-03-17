import { createClient } from '@supabase/supabase-js';
import { config } from './config';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

// Categories: 'soul' (always loaded), 'context' (always loaded), 'knowledge' (loaded by relevance)
export type MemoryCategory = 'soul' | 'context' | 'knowledge' | 'config';

export interface MemoryEntry {
  id?: number;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  created_at?: string;
  updated_at?: string;
}

// ── Read operations ──

export async function getCoreMemory(): Promise<MemoryEntry[]> {
  const { data, error } = await supabase
    .from('atlas_memory')
    .select('*')
    .in('category', ['soul', 'context'])
    .order('category')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[memory] Error loading core:', error.message);
    return [];
  }
  return data || [];
}

export async function searchKnowledge(query: string): Promise<MemoryEntry[]> {
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  if (keywords.length === 0) return [];

  // Search by title and tags using ilike
  const results: MemoryEntry[] = [];

  for (const kw of keywords.slice(0, 5)) {
    const { data } = await supabase
      .from('atlas_memory')
      .select('*')
      .eq('category', 'knowledge')
      .or(`title.ilike.%${kw}%,content.ilike.%${kw}%`)
      .limit(3);

    if (data) {
      for (const entry of data) {
        if (!results.find((r) => r.id === entry.id)) {
          results.push(entry);
        }
      }
    }
  }

  return results.slice(0, 5);
}

export async function getConfigValue(key: string): Promise<string | null> {
  const { data } = await supabase
    .from('atlas_memory')
    .select('content')
    .eq('category', 'config')
    .eq('title', key)
    .limit(1)
    .single();

  return data?.content || null;
}

// ── Write operations ──

export async function saveMemory(entry: Omit<MemoryEntry, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
  // Check if title already exists in same category
  const { data: existing } = await supabase
    .from('atlas_memory')
    .select('id')
    .eq('category', entry.category)
    .eq('title', entry.title)
    .limit(1)
    .single();

  if (existing) {
    const { error } = await supabase
      .from('atlas_memory')
      .update({ content: entry.content, tags: entry.tags, updated_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (error) throw new Error(`Memory update failed: ${error.message}`);
    return `Actualizado: "${entry.title}"`;
  }

  const { error } = await supabase
    .from('atlas_memory')
    .insert({
      category: entry.category,
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
    });

  if (error) throw new Error(`Memory save failed: ${error.message}`);
  return `Guardado: "${entry.title}" (${entry.category})`;
}

export async function deleteMemory(title: string): Promise<string> {
  const { data, error } = await supabase
    .from('atlas_memory')
    .delete()
    .ilike('title', `%${title}%`)
    .select('title');

  if (error) throw new Error(`Memory delete failed: ${error.message}`);
  if (!data || data.length === 0) return `No encontré nada con "${title}"`;
  return `Eliminado: ${data.map((d) => `"${d.title}"`).join(', ')}`;
}

export async function listMemory(category?: string): Promise<MemoryEntry[]> {
  let query = supabase.from('atlas_memory').select('*').order('category').order('created_at', { ascending: true });
  if (category) query = query.eq('category', category);
  const { data } = await query;
  return data || [];
}

export async function setConfig(key: string, value: string): Promise<void> {
  await saveMemory({ category: 'config', title: key, content: value, tags: ['config'] });
}

// ── Build system prompt from memory ──

export async function buildSystemContext(userMessage: string): Promise<string> {
  const parts: string[] = [];

  // Always load soul + context
  const core = await getCoreMemory();
  const soulEntries = core.filter((e) => e.category === 'soul');
  const contextEntries = core.filter((e) => e.category === 'context');

  if (soulEntries.length > 0) {
    parts.push(soulEntries.map((e) => e.content).join('\n\n'));
  }

  if (contextEntries.length > 0) {
    parts.push('\n## Contexto actual\n' + contextEntries.map((e) => `### ${e.title}\n${e.content}`).join('\n\n'));
  }

  // Search relevant knowledge
  const knowledge = await searchKnowledge(userMessage);
  if (knowledge.length > 0) {
    parts.push(
      '\n## Conocimiento relevante\n' +
        knowledge.map((e) => `### ${e.title}\n${e.content}`).join('\n\n')
    );
  }

  return parts.join('\n\n');
}
