/**
 * Atlas — Monitor Agent
 * 
 * Responsabilidad ÚNICA: vigilar fuentes externas y escribir eventos al Blackboard.
 * NUNCA habla con Diego directamente.
 * NUNCA llama al LLM.
 * Solo observa → clasifica → escribe al blackboard.
 * 
 * Fuentes monitoreadas:
 * - Email (3 cuentas via gog gmail)
 * - Calendario (eventos próximos via gog calendar)
 * - Meta Ads (performance via Supabase/API)
 * - WHOOP (health data via script)
 * 
 * Cron: cada 30 min de 8AM-8PM EST, L-S
 */

import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';

const execAsync = promisify(exec);
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

// ── Tipos ──

type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

interface BlackboardEvent {
  agent_source: 'monitor';
  event_type: string;
  priority: Priority;
  title: string;
  content: Record<string, unknown>;
}

// ── Escritura al Blackboard ──

async function writeEvent(event: BlackboardEvent): Promise<void> {
  const { error } = await supabase
    .from('atlas_blackboard')
    .insert({ ...event, status: 'pending' });

  if (error) {
    console.error('[monitor] Error writing to blackboard:', error.message);
  } else {
    console.log(`[monitor] Event written: [${event.priority}] ${event.title}`);
  }
}

// Evitar duplicados: no escribir el mismo evento si ya hay uno pendiente reciente (< 1h)
async function eventAlreadyPending(eventType: string, titleMatch: string): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('atlas_blackboard')
    .select('id')
    .eq('agent_source', 'monitor')
    .eq('event_type', eventType)
    .ilike('title', `%${titleMatch.slice(0, 40)}%`)
    .eq('status', 'pending')
    .gte('created_at', oneHourAgo)
    .limit(1);

  return (data?.length ?? 0) > 0;
}

// ── Monitor de Email ──

async function monitorEmail(): Promise<void> {
  const accounts = [
    'dau@urpeailab.com',
    'dau@urpeintegralservices.co',
    'du@soydiegoup.com',
  ];

  for (const account of accounts) {
    try {
      const { stdout } = await execAsync(
        `gog gmail messages --account ${account} --query "is:unread newer_than:1h" --json --max 10`,
        { timeout: 15000 }
      );

      const data = JSON.parse(stdout || '[]');
      const messages = Array.isArray(data) ? data : (data.messages || []);

      for (const msg of messages) {
        const subject = msg.subject || msg.snippet?.slice(0, 80) || 'Sin asunto';
        const from = msg.from || 'Desconocido';
        const snippet = msg.snippet || '';

        // Clasificar prioridad por keywords
        const isUrgent = /urgente|urgent|URGENTE|importante|asap|hoy|today|crítico|critical/i.test(subject + snippet);
        const isFromKey = /jorge|rodrigo|emmanuel|socio|partner|cliente|inversión/i.test(from + subject);

        const priority: Priority = isUrgent ? 'CRITICAL' : isFromKey ? 'HIGH' : 'MEDIUM';

        const alreadyPending = await eventAlreadyPending('email_unread', subject);
        if (alreadyPending) continue;

        await writeEvent({
          agent_source: 'monitor',
          event_type: 'email_unread',
          priority,
          title: `Email: ${subject}`,
          content: { from, subject, snippet: snippet.slice(0, 200), account },
        });
      }
    } catch (err) {
      // Token expirado u otro error — no bloquea el resto
      console.warn(`[monitor] Email error (${account}):`, (err as Error).message?.slice(0, 80));
    }
  }
}

// ── Monitor de Calendario ──

async function monitorCalendar(): Promise<void> {
  const accounts = ['dau@urpeailab.com', 'dau@urpeintegralservices.co'];

  for (const account of accounts) {
    try {
      const { stdout } = await execAsync(
        `gog calendar events primary --account ${account} --today --json`,
        { timeout: 15000 }
      );

      const events = JSON.parse(stdout || '[]');
      const now = new Date();

      for (const event of Array.isArray(events) ? events : []) {
        const startStr = event.start?.dateTime || event.start?.date;
        if (!startStr) continue;

        const start = new Date(startStr);
        const minutesUntil = Math.round((start.getTime() - now.getTime()) / 60000);

        // Solo alertar para eventos entre 15 min y 2 horas
        if (minutesUntil < 15 || minutesUntil > 120) continue;

        const title = event.summary || 'Evento sin título';
        const alreadyPending = await eventAlreadyPending('calendar_upcoming', title);
        if (alreadyPending) continue;

        const priority: Priority = minutesUntil <= 30 ? 'HIGH' : 'MEDIUM';

        await writeEvent({
          agent_source: 'monitor',
          event_type: 'calendar_upcoming',
          priority,
          title: `Evento en ${minutesUntil} min: ${title}`,
          content: {
            eventTitle: title,
            minutesUntil,
            startTime: startStr,
            location: event.location || null,
            meetLink: event.hangoutLink || null,
            account,
          },
        });
      }
    } catch (err) {
      console.warn(`[monitor] Calendar error (${account}):`, (err as Error).message?.slice(0, 80));
    }
  }
}

// ── Monitor de URPE Business Data ──

async function monitorBusiness(): Promise<void> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Leads de hoy
    const { count: leadsHoy } = await supabase
      .from('wp_conversaciones')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', 4)
      .gte('fecha_inicio', today.toISOString());

    // Citas de hoy
    const { data: citasHoy } = await supabase
      .from('wp_citas')
      .select('id, estado, titulo, fecha_hora')
      .eq('empresa_id', 4)
      .gte('fecha_hora', today.toISOString())
      .lt('fecha_hora', new Date(today.getTime() + 86400000).toISOString())
      .order('fecha_hora', { ascending: true });

    // Solo escribir si hay citas próximas
    const citasProximas = (citasHoy || []).filter(c => {
      const diff = new Date(c.fecha_hora).getTime() - Date.now();
      return diff > 0 && diff < 2 * 60 * 60 * 1000; // próximas 2h
    });

    if (citasProximas.length > 0) {
      const alreadyPending = await eventAlreadyPending('business_cita', citasProximas[0].titulo || '');
      if (!alreadyPending) {
        await writeEvent({
          agent_source: 'monitor',
          event_type: 'business_cita',
          priority: 'HIGH',
          title: `${citasProximas.length} cita(s) próxima(s) en URPE IS`,
          content: { citas: citasProximas, leadsHoy: leadsHoy || 0 },
        });
      }
    }

    // Alerta si leads de hoy es 0 y ya son las 10am+ (puede indicar problema)
    const hour = new Date().getHours();
    if ((leadsHoy || 0) === 0 && hour >= 10) {
      const alreadyPending = await eventAlreadyPending('business_no_leads', 'sin leads');
      if (!alreadyPending) {
        await writeEvent({
          agent_source: 'monitor',
          event_type: 'business_no_leads',
          priority: 'MEDIUM',
          title: 'Alerta: 0 leads hoy en URPE IS',
          content: { hora: hour, leads: 0 },
        });
      }
    }
  } catch (err) {
    console.warn('[monitor] Business error:', (err as Error).message?.slice(0, 80));
  }
}

// ── Ciclo completo de monitoreo ──

async function runMonitorCycle(): Promise<void> {
  console.log(`[monitor] Cycle start — ${new Date().toISOString()}`);
  
  await Promise.allSettled([
    monitorEmail(),
    monitorCalendar(),
    monitorBusiness(),
  ]);

  console.log(`[monitor] Cycle done — ${new Date().toISOString()}`);
}

// ── Entry point ──

export function startMonitor(): void {
  console.log('[monitor] Starting — will check email, calendar, business every 30min');

  // Correr inmediatamente al arrancar
  runMonitorCycle().catch(console.error);

  // Luego cada 30 min de 8AM-8PM EST, L-S
  cron.schedule('*/30 8-20 * * 1-6', () => {
    runMonitorCycle().catch(console.error);
  }, { timezone: 'America/New_York' });
}

// Si se corre directamente (AGENT_ROLE=monitor)
if (require.main === module) {
  startMonitor();
}
