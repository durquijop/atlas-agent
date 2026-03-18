/**
 * Blackboard Reader — Atlas Orchestrator
 * 
 * Lee eventos pendientes del atlas_blackboard y los procesa:
 * - Prioriza CRITICAL > HIGH > MEDIUM > LOW
 * - Solo envía a Diego lo que realmente merece atención
 * - Marca eventos como done/dismissed después de procesar
 */

import { createClient } from '@supabase/supabase-js';
import { config } from './config';
import { generateResponse } from './llm';
import { sendText } from './whatsapp';
import { runCritic } from './agents/critic';
import { getAutonomyLevel, getRecentRejects, recordOutcome } from './agents/learning';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);
const OWNER = config.ownerNumbers[0];

interface BlackboardEvent {
  id: number;
  created_at: string;
  agent_source: string;
  event_type: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  content: Record<string, unknown>;
  status: string;
}

// Process pending blackboard events
export async function processBlackboard(): Promise<void> {
  try {
    // Fetch pending events, highest priority first
    const { data: events, error } = await supabase
      .from('atlas_blackboard')
      .select('*')
      .eq('status', 'pending')
      .in('priority', ['CRITICAL', 'HIGH', 'MEDIUM'])
      .order('priority', { ascending: true }) // CRITICAL < HIGH < MEDIUM alphabetically... use custom
      .order('created_at', { ascending: true })
      .limit(10);

    if (error || !events || events.length === 0) return;

    // Sort manually: CRITICAL first
    const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const sorted = events.sort((a: BlackboardEvent, b: BlackboardEvent) => 
      priorityOrder[a.priority] - priorityOrder[b.priority]
    );

    // Group events to avoid spamming Diego
    const criticalEvents = sorted.filter((e: BlackboardEvent) => e.priority === 'CRITICAL');
    const highEvents = sorted.filter((e: BlackboardEvent) => e.priority === 'HIGH');
    const mediumEvents = sorted.filter((e: BlackboardEvent) => e.priority === 'MEDIUM');

    // Always process CRITICAL immediately (one by one)
    for (const event of criticalEvents) {
      await processEvent(event);
    }

    // HIGH: batch if multiple, send as one message
    if (highEvents.length > 0) {
      await processBatch(highEvents, 'HIGH');
    }

    // MEDIUM: only if less than 3 unread, batch them
    if (mediumEvents.length > 0 && mediumEvents.length <= 3) {
      await processBatch(mediumEvents, 'MEDIUM');
    } else if (mediumEvents.length > 3) {
      // Too many medium events — dismiss oldest, keep latest 3
      const tooDismiss = mediumEvents.slice(3);
      for (const e of tooDismiss) {
        await markEvent(e.id, 'dismissed');
      }
      await processBatch(mediumEvents.slice(0, 3), 'MEDIUM');
    }

  } catch (err) {
    console.error('[blackboard] Error processing:', err);
  }
}

async function processEvent(event: BlackboardEvent): Promise<void> {
  try {
    await markEvent(event.id, 'processing');

    // 1. Draft the message
    const prompt = buildPrompt(event);
    const draft = await generateResponse([], prompt, true);

    // 2. Get autonomy context for Critic
    const autonomyLevel = await getAutonomyLevel(event.event_type);
    const recentRejects = await getRecentRejects(event.event_type);

    // 3. Run Critic before sending
    const criticResult = await runCritic(draft, {
      eventType: event.event_type,
      priority: event.priority,
      originalTitle: event.title,
      recentRejects,
    });

    if (criticResult.verdict === 'BLOCKED') {
      console.log(`[blackboard] BLOCKED by Critic: ${criticResult.reasoning}`);
      await markEvent(event.id, 'dismissed');
      await recordOutcome(event.id, event.event_type, 'ignored', `Blocked by Critic: ${criticResult.reasoning}`);
      return;
    }

    // 4. Use Critic's output (original or reformulated)
    const finalMessage = criticResult.output || draft;

    // 5. Send to Diego (only if autonomy level allows or CRITICAL)
    if (autonomyLevel <= 2 || event.priority === 'CRITICAL') {
      await sendText(OWNER, finalMessage);
      console.log(`[blackboard] Sent [${event.priority}] ${event.title} (Critic: ${criticResult.verdict})`);
    } else {
      console.log(`[blackboard] Level 3 — holding for approval: ${event.title}`);
      // TODO: store in pending_approvals table for next Diego interaction
    }

    await markEvent(event.id, 'done');

  } catch (err) {
    console.error(`[blackboard] Error processing event ${event.id}:`, err);
    await markEvent(event.id, 'pending'); // retry later
  }
}

async function processBatch(events: BlackboardEvent[], level: string): Promise<void> {
  try {
    // Mark all as processing
    for (const e of events) await markEvent(e.id, 'processing');

    const itemsList = events.map(e => `- [${e.event_type.toUpperCase()}] ${e.title}`).join('\n');
    const prompt = `Eres Atlas, el asistente personal de Diego. Tienes ${events.length} alertas para reportar.

Alertas:
${itemsList}

Estilo OBLIGATORIO:
- Habla como un asistente cercano, no como un robot corporativo
- Sin bullets con asteriscos, sin emojis de sobre (📬), sin headers en negritas
- Directo: "Diego, tienes X pendiente" — no "Se ha detectado una alerta"
- Si son emails de pagos: di exactamente qué plataforma y qué hacer
- Si son eventos: di cuánto tiempo falta en lenguaje natural
- Máximo 4 líneas
- Cierra con "— Atlas" (sin negritas)`;

    const response = await generateResponse([], prompt, true);
    await sendText(OWNER, response);

    for (const e of events) await markEvent(e.id, 'done');
    console.log(`[blackboard] Batch processed ${events.length} ${level} events`);
  } catch (err) {
    console.error('[blackboard] Batch error:', err);
    for (const e of events) await markEvent(e.id, 'pending');
  }
}

function buildPrompt(event: BlackboardEvent): string {
  const content = JSON.stringify(event.content, null, 2);
  
  if (event.event_type === 'email') {
    return `Eres Atlas, asistente de Diego. Hay un email que necesita su atención:
De: ${event.content.from}
Asunto: ${event.content.subject}
Cuenta: ${event.content.account}

Escríbele a Diego en tono cercano y directo (máx 3 líneas):
- Sin emojis innecesarios, sin bullets, sin negritas
- Dile exactamente qué es y qué tiene que hacer
- Si es un pago, di el nombre de la plataforma y la acción concreta
- Cierra con "— Atlas" sin negritas`;
  }

  if (event.event_type === 'calendar') {
    return `Eres Atlas. Diego tiene un evento próximo:
${event.title}
Faltan ${event.content.diff_minutes} minutos.

Redacta un recordatorio WhatsApp corto (máx 3 líneas). Sin saludos. Cierra con "— Atlas"`;
  }

  return `Eres Atlas. Hay una alerta para Diego:
Tipo: ${event.event_type}
Prioridad: ${event.priority}
Título: ${event.title}
Detalles: ${content}

Redacta un mensaje WhatsApp conciso (máx 4 líneas). Sin saludos. Cierra con "— Atlas"`;
}

async function markEvent(id: number, status: string): Promise<void> {
  await supabase
    .from('atlas_blackboard')
    .update({ 
      status, 
      processed_at: status === 'done' || status === 'dismissed' ? new Date().toISOString() : null,
      processed_by: 'orchestrator',
    })
    .eq('id', id);
}
