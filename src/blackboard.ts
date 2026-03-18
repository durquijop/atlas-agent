/**
 * Atlas — Blackboard Reader
 * 
 * El Orchestrator usa esto para leer eventos pendientes del blackboard
 * y decidir qué merece atención de Diego.
 * 
 * Reglas de procesamiento:
 * - CRITICAL → siempre notificar a Diego
 * - HIGH → notificar si no hay uno similar en las últimas 4h
 * - MEDIUM → solo incluir en el briefing del heartbeat
 * - LOW → ignorar salvo que se acumulen muchos
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

export interface BlackboardEvent {
  id: number;
  created_at: string;
  agent_source: string;
  event_type: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  content: Record<string, unknown>;
  status: string;
}

// Leer eventos pendientes ordenados por prioridad
export async function getPendingEvents(limit = 20): Promise<BlackboardEvent[]> {
  const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

  const { data, error } = await supabase
    .from('atlas_blackboard')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[blackboard] Read error:', error.message);
    return [];
  }

  // Ordenar por prioridad
  return (data || []).sort((a, b) =>
    (priorityOrder[a.priority as keyof typeof priorityOrder] ?? 3) -
    (priorityOrder[b.priority as keyof typeof priorityOrder] ?? 3)
  );
}

// Leer solo los CRITICAL (para alerta inmediata)
export async function getCriticalEvents(): Promise<BlackboardEvent[]> {
  const { data } = await supabase
    .from('atlas_blackboard')
    .select('*')
    .eq('status', 'pending')
    .eq('priority', 'CRITICAL')
    .order('created_at', { ascending: true });

  return data || [];
}

// Marcar evento como procesado
export async function markDone(id: number, processedBy = 'orchestrator'): Promise<void> {
  await supabase
    .from('atlas_blackboard')
    .update({
      status: 'done',
      processed_at: new Date().toISOString(),
      processed_by: processedBy,
    })
    .eq('id', id);
}

// Marcar evento como descartado (no valía la pena)
export async function markDismissed(id: number): Promise<void> {
  await supabase
    .from('atlas_blackboard')
    .update({
      status: 'dismissed',
      processed_at: new Date().toISOString(),
      processed_by: 'orchestrator',
    })
    .eq('id', id);
}

// Registrar outcome (para loop de aprendizaje futuro)
export async function recordOutcome(id: number, outcome: string): Promise<void> {
  await supabase
    .from('atlas_blackboard')
    .update({ outcome, outcome_at: new Date().toISOString() })
    .eq('id', id);
}

// Construir resumen de eventos para el LLM
export function buildEventsContext(events: BlackboardEvent[]): string {
  if (events.length === 0) return 'Sin eventos pendientes.';

  return events.map(e => {
    const age = Math.round((Date.now() - new Date(e.created_at).getTime()) / 60000);
    return `[${e.priority}] ${e.title} (hace ${age} min)\n  Fuente: ${e.agent_source} | Tipo: ${e.event_type}\n  ${JSON.stringify(e.content).slice(0, 150)}`;
  }).join('\n\n');
}
