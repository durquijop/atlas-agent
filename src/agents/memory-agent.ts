/**
 * Memory Agent — Atlas Multi-Agent System
 * 
 * El ÚNICO agente con permiso de escritura en atlas_memory.
 * Responsabilidades:
 *   - Analizar conversaciones y decidir qué vale la pena recordar
 *   - Detectar cambios en preferencias, proyectos, personas, decisiones
 *   - Actualizar contexto de Diego automáticamente
 *   - Consolidar memorias duplicadas o contradictorias
 *   - Olvidar lo que ya no es relevante
 * 
 * Corre:
 *   - Después de cada conversación significativa (triggered por Orchestrator)
 *   - Nightly a las 2AM para consolidación
 */

import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { generateResponse } from '../llm';
import { saveMemory, listMemory, deleteMemory, getCoreMemory } from '../memory';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

// ── Types ──

interface ConversationToProcess {
  id: number;
  messages: { role: string; content: string }[];
  phone: string;
  processed_at: string | null;
}

interface MemoryDecision {
  action: 'save' | 'update' | 'delete' | 'ignore';
  category: 'soul' | 'context' | 'knowledge' | 'config';
  title: string;
  content: string;
  tags: string[];
  reason: string;
}

// ── Core: analyze conversation and extract memories ──

const MEMORY_ANALYST_PROMPT = `Eres el Memory Agent de Atlas, el asistente de Diego Urquijo.

Tu trabajo: analizar conversaciones y decidir qué información merece ser guardada en memoria permanente.

CATEGORÍAS DE MEMORIA:
- soul: quién es Diego, sus valores, cómo quiere que Atlas se comporte
- context: proyectos activos, personas clave, situaciones actuales, prioridades
- knowledge: información factual que Atlas debe recordar (datos de empresas, contactos, decisiones tomadas)
- config: preferencias técnicas, configuraciones, instrucciones de comportamiento

REGLAS DE DECISIÓN:
✅ GUARDAR si:
- Diego mencionó algo nuevo sobre sus proyectos o empresas
- Tomó una decisión importante
- Cambió de opinión sobre algo que antes estaba documentado
- Mencionó a una persona nueva con contexto relevante
- Dio una instrucción sobre cómo quiere que Atlas se comporte
- Compartió información financiera, legal o estratégica relevante

❌ IGNORAR si:
- Es conversación casual sin información nueva
- Ya está documentado sin cambios
- Es información temporal (clima, noticias del día)
- Es una pregunta sin respuesta significativa

FORMATO DE RESPUESTA — JSON array:
[
  {
    "action": "save" | "update" | "delete" | "ignore",
    "category": "soul" | "context" | "knowledge" | "config",
    "title": "Título corto y descriptivo",
    "content": "Contenido completo a guardar",
    "tags": ["tag1", "tag2"],
    "reason": "Por qué es importante guardar esto"
  }
]

Si no hay nada que guardar, devuelve: []`;

export async function analyzeConversation(
  messages: { role: string; content: string }[],
  existingMemory: string
): Promise<MemoryDecision[]> {
  if (messages.length < 2) return [];

  const conversation = messages
    .map(m => `${m.role === 'user' ? 'Diego' : 'Atlas'}: ${m.content}`)
    .join('\n');

  const prompt = `Analiza esta conversación y decide qué guardar en memoria:

CONVERSACIÓN:
${conversation}

MEMORIA ACTUAL (para evitar duplicados):
${existingMemory}

Responde con JSON array de decisiones.`;

  try {
    const response = await generateResponse(
      [{ role: 'user' as const, content: prompt }],
      MEMORY_ANALYST_PROMPT,
      false
    );

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const decisions = JSON.parse(jsonMatch[0]) as MemoryDecision[];
    return decisions.filter(d => d.action !== 'ignore');

  } catch (e) {
    console.error('[memory-agent] analyzeConversation error:', e);
    return [];
  }
}

// ── Apply memory decisions ──

export async function applyMemoryDecisions(decisions: MemoryDecision[]): Promise<string[]> {
  const results: string[] = [];

  for (const decision of decisions) {
    try {
      if (decision.action === 'save' || decision.action === 'update') {
        const result = await saveMemory({
          category: decision.category,
          title: decision.title,
          content: decision.content,
          tags: decision.tags,
        });
        results.push(result);
        console.log(`[memory-agent] ${result} — ${decision.reason}`);

      } else if (decision.action === 'delete') {
        const result = await deleteMemory(decision.title);
        results.push(result);
        console.log(`[memory-agent] ${result}`);
      }
    } catch (e) {
      console.error(`[memory-agent] Error applying decision for "${decision.title}":`, e);
    }
  }

  return results;
}

// ── Process recent conversations ──

async function processRecentConversations(): Promise<void> {
  try {
    // Get conversations from the last 24h that haven't been processed by memory agent
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: conversations } = await supabase
      .from('wp_conversaciones')
      .select('id, created_at')
      .eq('agente_id', 100) // Atlas agent ID
      .gte('created_at', yesterday)
      .order('created_at', { ascending: false })
      .limit(5);

    if (!conversations || conversations.length === 0) {
      console.log('[memory-agent] No conversations to process');
      return;
    }

    // Get current memory as context
    const coreMemory = await getCoreMemory();
    const existingMemory = coreMemory
      .map(m => `[${m.category}] ${m.title}: ${m.content.substring(0, 200)}`)
      .join('\n');

    let totalSaved = 0;

    for (const conv of conversations) {
      // Get messages for this conversation
      const { data: messages } = await supabase
        .from('wp_mensajes')
        .select('remitente, contenido')
        .eq('conversacion_id', conv.id)
        .order('created_at', { ascending: true })
        .limit(50);

      if (!messages || messages.length < 4) continue; // Skip short conversations

      const formattedMessages = messages.map(m => ({
        role: m.remitente === 'usuario' ? 'user' : 'assistant',
        content: m.contenido,
      }));

      const decisions = await analyzeConversation(formattedMessages, existingMemory);

      if (decisions.length > 0) {
        const results = await applyMemoryDecisions(decisions);
        totalSaved += results.length;
        console.log(`[memory-agent] Conv ${conv.id}: ${results.length} memories saved`);
      }
    }

    console.log(`[memory-agent] Nightly consolidation complete: ${totalSaved} total memories updated`);

  } catch (e) {
    console.error('[memory-agent] processRecentConversations error:', e);
  }
}

// ── Nightly consolidation: merge duplicates, remove stale ──

async function consolidateMemory(): Promise<void> {
  try {
    const allMemory = await listMemory();
    if (allMemory.length === 0) return;

    const memoryList = allMemory
      .map(m => `[${m.id}] [${m.category}] ${m.title}: ${m.content.substring(0, 150)}`)
      .join('\n');

    const consolidatePrompt = `Eres el Memory Agent. Revisa esta lista de memorias y detecta:
1. Duplicados (mismo concepto con distintos títulos)
2. Información contradictoria (dos memorias dicen cosas distintas sobre lo mismo)
3. Memorias obsoletas (información que claramente ya no es relevante)

MEMORIAS ACTUALES:
${memoryList}

Responde con JSON array. Solo incluye memorias que necesiten acción (delete/update).
Si todo está bien, devuelve: []`;

    const response = await generateResponse(
      [{ role: 'user' as const, content: consolidatePrompt }],
      MEMORY_ANALYST_PROMPT,
      false
    );

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const decisions = JSON.parse(jsonMatch[0]) as MemoryDecision[];
    const actionable = decisions.filter(d => d.action !== 'ignore' && d.action !== 'save');

    if (actionable.length > 0) {
      await applyMemoryDecisions(actionable);
      console.log(`[memory-agent] Consolidation: ${actionable.length} changes made`);
    }

  } catch (e) {
    console.error('[memory-agent] consolidateMemory error:', e);
  }
}

// ── Public API: called by Orchestrator after significant conversations ──

export async function triggerMemoryUpdate(
  messages: { role: string; content: string }[]
): Promise<void> {
  try {
    const coreMemory = await getCoreMemory();
    const existingMemory = coreMemory
      .map(m => `[${m.category}] ${m.title}: ${m.content.substring(0, 200)}`)
      .join('\n');

    const decisions = await analyzeConversation(messages, existingMemory);

    if (decisions.length > 0) {
      const results = await applyMemoryDecisions(decisions);
      console.log(`[memory-agent] Triggered update: ${results.length} memories saved`);
    }
  } catch (e) {
    console.error('[memory-agent] triggerMemoryUpdate error:', e);
  }
}

// ── Cron scheduler ──

export function startMemoryAgentCrons(): void {
  // Nightly at 2AM: process recent conversations + consolidate
  cron.schedule('0 2 * * *', async () => {
    console.log('[memory-agent] Starting nightly cycle');
    await processRecentConversations();
    await consolidateMemory();
  }, { timezone: 'America/New_York' });

  console.log('[memory-agent] Cron scheduled: nightly at 2AM ET');
}
