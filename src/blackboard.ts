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

    const prompt = buildPrompt(event);
    const response = await generateResponse([], prompt, true);
    
    await sendText(OWNER, response);
    await markEvent(event.id, 'done');

    console.log(`[blackboard] Processed [${event.priority}] ${event.title}`);
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
    const prompt = `Eres Atlas, el asistente de Diego. Tienes ${events.length} alertas de prioridad ${level} para reportar. 
    
Redacta UN SOLO mensaje WhatsApp conciso con estas alertas:
${itemsList}

Reglas:
- Directo al grano, sin saludos floridos
- Si son emails de pagos, menciona que hay que actualizar método de pago
- Si son eventos de calendario, menciona cuánto tiempo falta
- Máximo 5 líneas totales
- Cierra con "— Atlas"`;

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
    return `Eres Atlas. Hay un email URGENTE que Diego necesita saber:
Cuenta: ${event.content.account}
De: ${event.content.from}
Asunto: ${event.content.subject}

Redacta un mensaje WhatsApp muy corto (máx 4 líneas) avisándole. 
Sin saludos, directo al punto. Incluye qué acción necesita tomar si es obvio.
Cierra con "— Atlas"`;
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
