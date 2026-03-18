/**
 * Monitor Agent — Atlas Multi-Agent System
 * 
 * Responsabilidades:
 * - Revisar Gmail (3 cuentas) via Gmail API con OAuth tokens de gog
 * - Revisar calendario de Google
 * - Escribir eventos al atlas_blackboard en Supabase
 * - NUNCA hablar directamente con Diego
 * - Correr cada 30 min de 8AM-8PM L-S
 * 
 * Deploy: Railway con AGENT_ROLE=monitor
 */

import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { getGoogleAccessToken } from '../google-auth';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

const GMAIL_ACCOUNTS = [
  { email: 'dau@urpeailab.com', label: 'AI Lab' },
  { email: 'dau@urpeintegralservices.co', label: 'URPE IS' },
  { email: 'du@soydiegoup.com', label: 'SoyDiegoUp' },
];

// ── Email classification — umbral alto, solo lo que realmente importa ──

// CRITICAL: requiere acción HOY o hay pérdida real
const CRITICAL_KEYWORDS = [
  'urgent', 'urgente', 'overdue', 'vencida', 'shutdown', 'suspended',
  'crashed', 'failed', 'payment failure', 'action required', 'account suspended',
  'service interrupted', 'pago rechazado', 'cuenta bloqueada', 'factura vencida',
  'your account', 'immediate action', 'acción inmediata'
];

// HIGH: dinero o deadline concreto
const HIGH_KEYWORDS = [
  'invoice', 'factura', 'payment due', 'pago vence', 'renewal', 'renovacion',
  'expires', 'expira', 'deadline', 'vence mañana', 'overdue', 'past due',
  'subscription', 'suscripcion', 'cobro', 'cargo rechazado'
];

// AUTO-DESCARTE: newsletters, marketing, notificaciones automáticas
const NOISE_SENDERS = [
  'noreply', 'no-reply', 'newsletter', 'notifications@', 'updates@',
  'hello@', 'team@', 'info@', 'marketing@', 'digest@', 'weekly@',
  'acm.org', 'ieee.org', 'medium.com', 'substack.com', 'mailchimp',
  'constantcontact', 'sendgrid', 'klaviyo', 'hubspot', 'mailerlite'
];

const NOISE_SUBJECTS = [
  'newsletter', 'digest', 'weekly', 'roundup', 'update', 'webinar',
  'invitation', 'join us', 'free', 'offer', 'deal', 'discount',
  'unsubscribe', 'referral', 'you\'re invited', 'don\'t miss'
];

function classifyEmailPriority(subject: string, from: string): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  const text = `${subject} ${from}`.toLowerCase();
  const subjectLower = subject.toLowerCase();
  const fromLower = from.toLowerCase();

  // Auto-descarte: ruido conocido
  if (NOISE_SENDERS.some(n => fromLower.includes(n))) return 'LOW';
  if (NOISE_SUBJECTS.some(n => subjectLower.includes(n))) return 'LOW';

  // CRITICAL: acción urgente requerida
  if (CRITICAL_KEYWORDS.some(k => text.includes(k))) return 'CRITICAL';

  // HIGH: dinero o deadline
  if (HIGH_KEYWORDS.some(k => text.includes(k))) return 'HIGH';

  // Todo lo demás es LOW — no vale molestar a Diego
  return 'LOW';
}



async function checkGmailAccount(email: string, label: string): Promise<void> {
  const token = await getGoogleAccessToken(email);
  if (!token) {
    console.log(`[monitor] No token for ${email}, skipping`);
    return;
  }

  try {
    // Get unread messages from last 2 hours
    const since = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);
    const query = encodeURIComponent(`is:unread after:${since}`);
    
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=10`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!listRes.ok) {
      console.error(`[monitor] Gmail list failed for ${email}: ${listRes.status}`);
      return;
    }

    const listData = await listRes.json() as { messages?: { id: string }[] };
    const messages = listData.messages || [];

    for (const msg of messages.slice(0, 5)) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!msgRes.ok) continue;

      const msgData = await msgRes.json() as { payload?: { headers?: { name: string; value: string }[] } };
      const headers = msgData.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '(sin asunto)';
      const from = headers.find(h => h.name === 'From')?.value || '';
      const priority = classifyEmailPriority(subject, from);

      // Only write to blackboard if MEDIUM or higher
      if (priority === 'LOW') continue;

      await writeToBlackboard({
        agent_source: 'monitor',
        event_type: 'email',
        priority,
        title: `[${label}] ${subject}`,
        content: { from, subject, account: email, message_id: msg.id },
      });
    }
  } catch (e) {
    console.error(`[monitor] Error checking Gmail ${email}:`, e);
  }
}

async function checkCalendar(email: string, label: string): Promise<void> {
  const token = await getGoogleAccessToken(email);
  if (!token) return;

  try {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${in24h.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!res.ok) return;

    const data = await res.json() as { items?: any[] };
    const events = (data.items || []).filter((e: any) => 
      e.summary && !e.summary.toLowerCase().includes('out of office')
    );

    if (events.length === 0) return;

    // Only alert for events in next 2 hours
    const soon = events.filter((e: any) => {
      const start = new Date(e.start?.dateTime || e.start?.date || '');
      const diffMs = start.getTime() - now.getTime();
      return diffMs > 0 && diffMs < 2 * 60 * 60 * 1000;
    });

    for (const event of soon) {
      const start = new Date(event.start?.dateTime || event.start?.date || '');
      const diffMin = Math.round((start.getTime() - now.getTime()) / 60000);
      
      await writeToBlackboard({
        agent_source: 'monitor',
        event_type: 'calendar',
        priority: diffMin <= 30 ? 'HIGH' : 'MEDIUM',
        title: `Evento en ${diffMin} min: ${event.summary}`,
        content: { 
          event_id: event.id, 
          summary: event.summary,
          start: event.start,
          location: event.location,
          account: email,
          diff_minutes: diffMin,
        },
      });
    }
  } catch (e) {
    console.error(`[monitor] Error checking calendar ${email}:`, e);
  }
}

// ── Blackboard writer ──

interface BlackboardEvent {
  agent_source: string;
  event_type: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  content: Record<string, unknown>;
}

async function writeToBlackboard(event: BlackboardEvent): Promise<void> {
  try {
    // Dedup: check if same event_type + title already pending in last 2h
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from('atlas_blackboard')
      .select('id')
      .eq('event_type', event.event_type)
      .eq('title', event.title)
      .eq('status', 'pending')
      .gte('created_at', twoHoursAgo)
      .limit(1);

    if (existing && existing.length > 0) {
      console.log(`[monitor] Dedup: skipping "${event.title}"`);
      return;
    }

    const { error } = await supabase.from('atlas_blackboard').insert(event);
    if (error) {
      console.error('[monitor] Blackboard write error:', error);
    } else {
      console.log(`[monitor] Written [${event.priority}] ${event.title}`);
    }
  } catch (e) {
    console.error('[monitor] writeToBlackboard error:', e);
  }
}

// ── Main monitor cycle ──

async function runMonitorCycle(): Promise<void> {
  console.log('[monitor] Starting cycle:', new Date().toISOString());

  // Check all Gmail accounts
  for (const account of GMAIL_ACCOUNTS) {
    await checkGmailAccount(account.email, account.label);
  }

  // Check calendar (primary account only to avoid duplicates)
  await checkCalendar('dau@urpeailab.com', 'AI Lab');

  console.log('[monitor] Cycle complete');
}

// ── Cron scheduler ──

export function startMonitorCrons(): void {
  // Every 30 min, Mon-Sat, 8AM-8PM ET
  cron.schedule('*/30 8-20 * * 1-6', () => {
    runMonitorCycle().catch(console.error);
  }, { timezone: 'America/New_York' });

  // Run once on startup
  runMonitorCycle().catch(console.error);

  console.log('[monitor] Cron scheduled: every 30min, Mon-Sat 8AM-8PM ET');
}
