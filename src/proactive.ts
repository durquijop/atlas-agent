/**
 * Atlas — Proactive Orchestrator (reemplaza proactive.ts original)
 * 
 * Cambios vs versión original:
 * 1. Heartbeat lee el blackboard antes de actuar
 * 2. CRITICAL events → alerta inmediata sin esperar heartbeat
 * 3. MEDIUM events → solo se incluyen en el briefing del heartbeat
 * 4. Supabase Realtime watch para CRITICAL events (respuesta inmediata)
 * 
 * Framework de decisión proactiva (orden estricto):
 * P1: ¿Hay algo CRITICAL? → actuar ya
 * P2: ¿Hay algo HIGH pendiente? → incluir en próximo mensaje
 * P3: ¿Hay algo de PRIORITIES.md por adelantar?
 * P4: Mantenimiento silencioso
 * P5: Nada urgente → briefing normal o silencio
 */

import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { getPendingEvents, getCriticalEvents, markDone, markDismissed, buildEventsContext } from './blackboard';
import { generateResponse } from './llm'; // Reutilizar el LLM existente de Atlas
import { sendText } from './whatsapp';
import { config } from './config';

const OWNER = config.ownerNumbers[0];

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

// ── Alertas inmediatas de CRITICAL ──

async function handleCriticalEvents(): Promise<void> {
  const criticals = await getCriticalEvents();
  if (criticals.length === 0) return;

  console.log(`[proactive] ${criticals.length} CRITICAL event(s) found`);

  for (const event of criticals) {
    try {
      const prompt = `
Hay un evento CRÍTICO que Diego necesita saber AHORA.

Evento: ${event.title}
Tipo: ${event.event_type}
Detalles: ${JSON.stringify(event.content).slice(0, 300)}
Hace: ${Math.round((Date.now() - new Date(event.created_at).getTime()) / 60000)} minutos

Redacta UN mensaje corto y directo para Diego. 
Sin emojis innecesarios. Sin rodeos. Máximo 3 líneas.
El mensaje debe decirle exactamente qué pasó y qué necesita hacer.
      `.trim();

      const response = await generateResponse([], prompt, false);
      await sendText(OWNER, response);
      await markDone(event.id, 'orchestrator-critical');

      console.log(`[proactive] CRITICAL sent: ${event.title}`);
    } catch (err) {
      console.error('[proactive] Error handling critical:', err);
    }
  }
}

// ── Heartbeat Principal ──

async function runHeartbeat(timeOfDay: 'morning' | 'midday' | 'afternoon' | 'evening'): Promise<void> {
  console.log(`[proactive] Heartbeat: ${timeOfDay}`);

  try {
    // 1. Leer todos los eventos pendientes del blackboard
    const events = await getPendingEvents(15);

    // 2. Separar por prioridad
    const highEvents = events.filter(e => e.priority === 'HIGH');
    const mediumEvents = events.filter(e => e.priority === 'MEDIUM');

    // 3. Construir contexto para el LLM
    const eventsContext = buildEventsContext([...highEvents, ...mediumEvents]);

    const timePrompts = {
      morning: 'Es la mañana. Dale a Diego un briefing de inicio del día.',
      midday: 'Es el mediodía. Revisa qué está pendiente y qué necesita atención.',
      afternoon: 'Es la tarde. ¿Qué está sin resolver del día?',
      evening: 'Es la noche. Cierre del día: logros, pendientes, y una pregunta de reflexión.',
    };

    // 4. Si no hay nada relevante, silencio (no molestar)
    if (highEvents.length === 0 && mediumEvents.length === 0) {
      console.log('[proactive] No pending events — skipping heartbeat message');
      return;
    }

    const prompt = `
${timePrompts[timeOfDay]}

EVENTOS PENDIENTES DEL SISTEMA (del Monitor Agent):
${eventsContext}

INSTRUCCIONES:
- Si hay eventos HIGH: mencionarlos con claridad y urgencia apropiada
- Si hay eventos MEDIUM: incluir como puntos secundarios del briefing
- Máximo 5-6 líneas en total
- Tono directo, como Atlas habla normalmente con Diego
- Si algo requiere acción de Diego, dilo explícitamente
- No inventar información no presente en los eventos
    `.trim();

    const response = await generateResponse([], prompt, true); // includeBusinessData=true
    await sendText(OWNER, response);

    // 5. Marcar eventos procesados
    for (const event of [...highEvents, ...mediumEvents]) {
      await markDone(event.id, `orchestrator-${timeOfDay}`);
    }

    console.log(`[proactive] Heartbeat sent: ${highEvents.length} HIGH + ${mediumEvents.length} MEDIUM events`);

  } catch (err) {
    console.error('[proactive] Heartbeat error:', err);
  }
}

// ── Supabase Realtime — Watch para CRITICAL inmediatos ──

function watchCriticalEvents(): void {
  supabase
    .channel('atlas-blackboard-critical')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'atlas_blackboard',
        filter: 'priority=eq.CRITICAL',
      },
      async (payload) => {
        console.log('[proactive] Realtime CRITICAL detected:', payload.new?.title);
        // Pequeño delay para asegurar que el INSERT está committed
        setTimeout(() => handleCriticalEvents().catch(console.error), 2000);
      }
    )
    .subscribe();

  console.log('[proactive] Watching atlas_blackboard for CRITICAL events via Realtime');
}

// ── Arranque ──

export function startProactiveCrons(): void {
  // Morning briefing: 8am EST, L-S
  cron.schedule('0 8 * * 1-6', () => {
    runHeartbeat('morning').catch(console.error);
  }, { timezone: 'America/New_York' });

  // Midday check: 12pm EST, L-S
  cron.schedule('0 12 * * 1-6', () => {
    runHeartbeat('midday').catch(console.error);
  }, { timezone: 'America/New_York' });

  // Afternoon check: 4pm EST, L-S
  cron.schedule('0 16 * * 1-6', () => {
    runHeartbeat('afternoon').catch(console.error);
  }, { timezone: 'America/New_York' });

  // Evening close: 8pm EST, L-S
  cron.schedule('0 20 * * 1-6', () => {
    runHeartbeat('evening').catch(console.error);
  }, { timezone: 'America/New_York' });

  // Watcher para CRITICAL events inmediatos (Supabase Realtime)
  watchCriticalEvents();

  console.log('[proactive] Crons: 8am / 12pm / 4pm / 8pm EST (L-S) + Realtime CRITICAL watcher');
}
