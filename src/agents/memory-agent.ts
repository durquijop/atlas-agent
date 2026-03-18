/**
 * Memory Agent v2 — Atlas Multi-Agent System
 *
 * Sistema de memoria de 3 capas:
 *   L1 — Working Memory: últimas 20 interacciones (en RAM, efímero)
 *   L2 — Episodic Memory: eventos y conversaciones relevantes (Supabase, 90 días)
 *   L3 — Semantic Memory: conocimiento permanente sobre Diego (Supabase, sin expiración)
 *
 * El Memory Agent es el ÚNICO con permiso de escritura.
 * Los demás agentes solo leen vía getRelevantContext().
 *
 * Corre:
 *   - Trigger: cada 5 mensajes (post-conversación)
 *   - Nightly 2AM: consolidación, limpieza, resumen episódico
 */

import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { callLLM } from '../llm-router';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

// ── SCHEMA DE MEMORIA ──
// L2: atlas_episodic_memory  (eventos con expiración)
// L3: atlas_memory           (conocimiento permanente, ya existe)

// ── EXTRACTORES DE ENTIDADES ──
// Qué tipos de información merecen memoria permanente (L3)

const ENTITY_EXTRACTORS = {
  persona: {
    description: 'Persona mencionada con contexto relevante',
    trigger: ['conocí a', 'habló con', 'reunión con', 'llamó', 'escribió', 'socio', 'cliente', 'empleado', 'contacto'],
    category: 'knowledge' as const,
  },
  decision: {
    description: 'Decisión importante tomada por Diego',
    trigger: ['decidí', 'vamos a', 'confirmé', 'acordamos', 'cerramos', 'firmamos', 'cancelamos', 'pausamos'],
    category: 'context' as const,
  },
  proyecto: {
    description: 'Proyecto o empresa con estado actualizado',
    trigger: ['proyecto', 'empresa', 'negocio', 'startup', 'deal', 'contrato', 'inversión', 'socio'],
    category: 'context' as const,
  },
  preferencia: {
    description: 'Cómo Diego quiere que Atlas se comporte',
    trigger: ['no me gusta', 'prefiero', 'siempre', 'nunca', 'quiero que', 'no quiero', 'cambia'],
    category: 'soul' as const,
  },
  dato_financiero: {
    description: 'Número financiero importante',
    trigger: ['recaudo', 'facturó', 'invertimos', 'cuesta', 'presupuesto', 'deuda', 'ingresos'],
    category: 'knowledge' as const,
  },
};

// ── L1: WORKING MEMORY (en RAM) ──

interface WorkingMemoryEntry {
  timestamp: number;
  role: 'user' | 'assistant';
  content: string;
  importance: number; // 0-10
}

class WorkingMemory {
  private entries: WorkingMemoryEntry[] = [];
  private readonly maxSize = 30;

  add(role: 'user' | 'assistant', content: string, importance = 5): void {
    this.entries.push({ timestamp: Date.now(), role, content, importance });
    if (this.entries.length > this.maxSize) {
      // Keep high-importance entries, drop low-importance old ones
      this.entries.sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp);
      this.entries = this.entries.slice(0, this.maxSize);
      this.entries.sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  getRecent(n = 20): WorkingMemoryEntry[] {
    return this.entries.slice(-n);
  }

  getHighImportance(threshold = 7): WorkingMemoryEntry[] {
    return this.entries.filter(e => e.importance >= threshold);
  }

  clear(): void {
    this.entries = [];
  }
}

export const workingMemory = new WorkingMemory();

// ── L2: EPISODIC MEMORY ──

interface EpisodicEntry {
  id?: number;
  session_date: string;          // YYYY-MM-DD
  summary: string;               // Resumen de la conversación
  key_topics: string[];          // Temas principales
  decisions_made: string[];      // Decisiones tomadas
  people_mentioned: string[];    // Personas mencionadas
  sentiment: 'positive' | 'neutral' | 'negative' | 'stressed';
  importance: number;            // 1-10
  expires_at: string;            // 90 días por defecto
}

async function saveEpisodicMemory(entry: Omit<EpisodicEntry, 'id'>): Promise<void> {
  const { error } = await supabase.from('atlas_episodic_memory').insert(entry);
  if (error) console.error('[memory-agent] Episodic save error:', error.message);
}

async function getRecentEpisodic(days = 30): Promise<EpisodicEntry[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  const { data } = await supabase
    .from('atlas_episodic_memory')
    .select('*')
    .gte('session_date', since)
    .order('importance', { ascending: false })
    .order('session_date', { ascending: false })
    .limit(10);

  return (data || []) as EpisodicEntry[];
}

// ── L3: SEMANTIC MEMORY ──

async function getSemanticMemory(category?: string): Promise<{ title: string; content: string; category: string }[]> {
  let query = supabase
    .from('atlas_memory')
    .select('title, content, category')
    .order('updated_at', { ascending: false });

  if (category) query = query.eq('category', category);

  const { data } = await query.limit(50);
  return (data || []) as { title: string; content: string; category: string }[];
}

async function upsertSemanticMemory(
  category: 'soul' | 'context' | 'knowledge' | 'config',
  title: string,
  content: string,
  tags: string[]
): Promise<void> {
  const { data: existing } = await supabase
    .from('atlas_memory')
    .select('id, content')
    .eq('category', category)
    .eq('title', title)
    .single();

  if (existing) {
    // Merge: don't overwrite, append what's new
    const mergedContent = existing.content === content
      ? content
      : `${existing.content}\n\n[Actualizado ${new Date().toLocaleDateString('es')}]: ${content}`;

    await supabase
      .from('atlas_memory')
      .update({ content: mergedContent, tags, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  } else {
    await supabase
      .from('atlas_memory')
      .insert({ category, title, content, tags });
  }
}

// ── CORE: ANALIZAR CONVERSACIÓN ──

const MEMORY_EXTRACTION_PROMPT = `Eres el Memory Agent de Atlas. Analizas conversaciones entre Diego y Atlas y extraes lo que vale la pena recordar permanentemente.

Diego Urquijo es: CEO de URPE Integral Services (inmigración USA) y URPE AI Lab. Vive en Cumming, GA. Tiene familia (Simón, Samantha). Es emprendedor serial, barranquillero, ambicioso.

EXTRAE SOLO lo que sea:
1. NUEVO (no está en la memoria actual)
2. PERMANENTE (sigue siendo relevante en 6 meses)
3. ACCIONABLE (cambia cómo Atlas debe comportarse o qué debe saber)

NO extraigas:
- Conversación casual sin información nueva
- Información temporal (precios del día, clima, noticias)
- Cosas que ya están documentadas sin cambio
- Preguntas sin respuesta significativa

FORMATO DE RESPUESTA (JSON):
{
  "semantic_updates": [
    {
      "category": "soul|context|knowledge|config",
      "title": "Título corto (máx 50 chars)",
      "content": "Contenido completo y útil",
      "tags": ["tag1", "tag2"],
      "why": "Por qué es importante recordar esto"
    }
  ],
  "episodic_summary": {
    "summary": "Resumen de la conversación en 2-3 líneas",
    "key_topics": ["tema1", "tema2"],
    "decisions_made": ["decisión1"],
    "people_mentioned": ["nombre1"],
    "sentiment": "positive|neutral|negative|stressed",
    "importance": 1-10
  },
  "behavior_updates": [
    {
      "instruction": "Instrucción concreta para Atlas",
      "reason": "Por qué cambiar el comportamiento"
    }
  ]
}

Si no hay nada nuevo, devuelve: {"semantic_updates": [], "episodic_summary": null, "behavior_updates": []}`;

interface ExtractionResult {
  semantic_updates: {
    category: 'soul' | 'context' | 'knowledge' | 'config';
    title: string;
    content: string;
    tags: string[];
    why: string;
  }[];
  episodic_summary: {
    summary: string;
    key_topics: string[];
    decisions_made: string[];
    people_mentioned: string[];
    sentiment: 'positive' | 'neutral' | 'negative' | 'stressed';
    importance: number;
  } | null;
  behavior_updates: {
    instruction: string;
    reason: string;
  }[];
}

async function extractFromConversation(
  messages: { role: string; content: string }[],
  existingMemorySnapshot: string
): Promise<ExtractionResult> {
  const conversation = messages
    .slice(-30) // Últimos 30 mensajes
    .map(m => `${m.role === 'user' ? 'Diego' : 'Atlas'}: ${m.content}`)
    .join('\n');

  const prompt = `CONVERSACIÓN A ANALIZAR:
${conversation}

MEMORIA ACTUAL (para evitar duplicados):
${existingMemorySnapshot}

Extrae lo que vale la pena recordar. Responde en JSON.`;

  try {
    const response = await callLLM('memory', [
      { role: 'system', content: MEMORY_EXTRACTION_PROMPT },
      { role: 'user', content: prompt },
    ]);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { semantic_updates: [], episodic_summary: null, behavior_updates: [] };

    return JSON.parse(jsonMatch[0]) as ExtractionResult;
  } catch (e) {
    console.error('[memory-agent] Extraction error:', e);
    return { semantic_updates: [], episodic_summary: null, behavior_updates: [] };
  }
}

// ── CONSOLIDACIÓN NOCTURNA ──

async function consolidateAndClean(): Promise<void> {
  console.log('[memory-agent] Starting nightly consolidation...');

  const allMemory = await getSemanticMemory();
  if (allMemory.length === 0) return;

  // Find duplicates using simple title similarity
  const seen = new Map<string, typeof allMemory[0]>();
  const duplicates: string[] = [];

  for (const entry of allMemory) {
    const key = entry.title.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) {
      duplicates.push(entry.title);
    } else {
      seen.set(key, entry);
    }
  }

  if (duplicates.length > 0) {
    console.log(`[memory-agent] Found ${duplicates.length} potential duplicates`);
    // TODO: merge logic (phase 2)
  }

  // Clean expired episodic memories
  const now = new Date().toISOString();
  const { data: expired } = await supabase
    .from('atlas_episodic_memory')
    .delete()
    .lt('expires_at', now)
    .select('id');

  if (expired && expired.length > 0) {
    console.log(`[memory-agent] Cleaned ${expired.length} expired episodic memories`);
  }

  console.log('[memory-agent] Nightly consolidation complete');
}

// ── API PÚBLICA ──

export async function triggerMemoryUpdate(
  messages: { role: string; content: string }[]
): Promise<void> {
  if (messages.length < 4) return; // No procesar conversaciones muy cortas

  try {
    // Snapshot de memoria actual para el prompt
    const semantic = await getSemanticMemory();
    const memorySnapshot = semantic
      .slice(0, 20)
      .map(m => `[${m.category}] ${m.title}: ${m.content.substring(0, 150)}`)
      .join('\n');

    const result = await extractFromConversation(messages, memorySnapshot);

    // Guardar actualizaciones semánticas (L3)
    for (const update of result.semantic_updates) {
      await upsertSemanticMemory(update.category, update.title, update.content, update.tags);
      console.log(`[memory-agent] L3 saved: [${update.category}] ${update.title} — ${update.why}`);
    }

    // Guardar behavior updates como instrucciones de soul
    for (const behavior of result.behavior_updates) {
      await upsertSemanticMemory(
        'soul',
        `Instrucción: ${behavior.instruction.substring(0, 40)}`,
        behavior.instruction,
        ['behavior', 'instruction']
      );
      console.log(`[memory-agent] Behavior update: ${behavior.instruction}`);
    }

    // Guardar episodic summary (L2)
    if (result.episodic_summary && result.episodic_summary.importance >= 4) {
      const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      await saveEpisodicMemory({
        session_date: new Date().toISOString().split('T')[0],
        summary: result.episodic_summary.summary,
        key_topics: result.episodic_summary.key_topics,
        decisions_made: result.episodic_summary.decisions_made,
        people_mentioned: result.episodic_summary.people_mentioned,
        sentiment: result.episodic_summary.sentiment,
        importance: result.episodic_summary.importance,
        expires_at: expires,
      });
      console.log(`[memory-agent] L2 episodic saved: importance=${result.episodic_summary.importance}`);
    }

    const total = result.semantic_updates.length + result.behavior_updates.length;
    if (total > 0) {
      console.log(`[memory-agent] Update complete: ${total} semantic, ${result.episodic_summary ? 1 : 0} episodic`);
    }

  } catch (e) {
    console.error('[memory-agent] triggerMemoryUpdate error:', e);
  }
}

// Exponer función para que el LLM pueda incluir contexto episódico
export async function getEpisodicContext(): Promise<string> {
  const recent = await getRecentEpisodic(14); // Últimas 2 semanas
  if (recent.length === 0) return '';

  return '\n## Contexto reciente (últimas sesiones)\n' +
    recent
      .slice(0, 5)
      .map(e => `[${e.session_date}] ${e.summary} (temas: ${e.key_topics.join(', ')})`)
      .join('\n');
}

export function startMemoryAgentCrons(): void {
  // Nightly 2AM: consolidación + limpieza
  cron.schedule('0 2 * * *', async () => {
    console.log('[memory-agent] Starting nightly cycle');
    await consolidateAndClean();
  }, { timezone: 'America/New_York' });

  console.log('[memory-agent] Crons scheduled: nightly 2AM ET');
}
