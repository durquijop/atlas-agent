/**
 * Realtime Listener — Atlas Multi-Agent System
 * 
 * En vez de heartbeat cada 4 horas, el Orchestrator despierta
 * EXACTAMENTE cuando el Monitor escribe algo al blackboard.
 * 
 * Supabase Realtime: INSERT en atlas_blackboard → processBlackboard()
 * 
 * Mejora #2 de la investigación: proactividad por contexto, no por horario.
 */

import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import { config } from './config';
import { processBlackboard } from './blackboard';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

let channel: RealtimeChannel | null = null;
let processingDebounce: NodeJS.Timeout | null = null;

export function startRealtimeListener(): void {
  channel = supabase
    .channel('atlas-blackboard-changes')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'atlas_blackboard',
        filter: "status=eq.pending",
      },
      (payload) => {
        const event = payload.new as {
          priority: string;
          title: string;
          event_type: string;
        };

        console.log(`[realtime] New event detected: [${event.priority}] ${event.title}`);

        if (event.priority === 'CRITICAL') {
          // CRITICAL: process immediately, no debounce
          console.log('[realtime] CRITICAL — processing immediately');
          processBlackboard().catch(console.error);
          return;
        }

        // HIGH/MEDIUM: debounce 30s to batch multiple events that arrive together
        if (processingDebounce) clearTimeout(processingDebounce);
        processingDebounce = setTimeout(() => {
          console.log('[realtime] Debounce resolved — processing blackboard');
          processBlackboard().catch(console.error);
        }, 30_000); // 30 seconds
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[realtime] Listening to atlas_blackboard — context-driven proactivity active');
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        console.error('[realtime] Channel error — attempting reconnect in 60s');
        setTimeout(startRealtimeListener, 60_000);
      }
    });
}

export function stopRealtimeListener(): void {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
}
