import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

let supabase: SupabaseClient;

function getClient(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(config.supabaseUrl, config.supabaseKey);
  }
  return supabase;
}

// Atlas constants
const AGENTE_ID = 100;
const EMPRESA_ID = 13; // Urpe Ai Lab
const NUMERO_ID = 62;

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MentorSession {
  conversacion_id: number;
  contacto_id: number;
  phone: string;
}

// ── Contact management ──

async function getOrCreateContact(phone: string, name?: string): Promise<number> {
  const db = getClient();

  const { data: existing } = await db
    .from('wp_contactos')
    .select('id')
    .eq('telefono', phone)
    .eq('empresa_id', EMPRESA_ID)
    .limit(1)
    .single();

  if (existing) return existing.id;

  const { data: created, error } = await db
    .from('wp_contactos')
    .insert({
      telefono: phone,
      nombre: name || phone,
      empresa_id: EMPRESA_ID,
      origen: 'Whatsapp',
      is_active: true,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Contact create failed: ${error.message}`);
  return created!.id;
}

// ── Session (conversation) management ──

export async function getOrCreateSession(phone: string, contactName?: string): Promise<MentorSession> {
  const db = getClient();
  const contacto_id = await getOrCreateContact(phone, contactName);

  // Find most recent conversation for this contact + agent
  const { data: existing } = await db
    .from('wp_conversaciones')
    .select('id')
    .eq('contacto_id', contacto_id)
    .eq('agente_id', AGENTE_ID)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (existing) {
    // Update last message timestamp
    await db
      .from('wp_conversaciones')
      .update({ fecha_ultimo_mensaje_usuario: new Date().toISOString() })
      .eq('id', existing.id);
    return { conversacion_id: existing.id, contacto_id, phone };
  }

  const { data: created, error } = await db
    .from('wp_conversaciones')
    .insert({
      contacto_id,
      agente_id: AGENTE_ID,
      numero_id: NUMERO_ID,
      empresa_id: EMPRESA_ID,
      canal: 'whatsapp',
      fecha_inicio: new Date().toISOString(),
      fecha_ultimo_mensaje_usuario: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) throw new Error(`Conversation create failed: ${error.message}`);
  return { conversacion_id: created!.id, contacto_id, phone };
}

// ── Message history ──

export async function getRecentMessages(phone: string, limit = 20): Promise<ConversationMessage[]> {
  const db = getClient();

  const { data: contact } = await db
    .from('wp_contactos')
    .select('id')
    .eq('telefono', phone)
    .eq('empresa_id', EMPRESA_ID)
    .limit(1)
    .single();

  if (!contact) return [];

  const { data: conv } = await db
    .from('wp_conversaciones')
    .select('id')
    .eq('contacto_id', contact.id)
    .eq('agente_id', AGENTE_ID)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!conv) return [];

  const { data: messages } = await db
    .from('wp_mensajes')
    .select('remitente, contenido')
    .eq('conversacion_id', conv.id)
    .order('created_at', { ascending: true })
    .limit(limit);

  return (messages || []).map((m: { remitente: string; contenido: string }) => ({
    role: m.remitente === 'usuario' ? 'user' as const : 'assistant' as const,
    content: m.contenido,
  }));
}

export async function saveMessage(phone: string, role: 'user' | 'assistant', content: string): Promise<void> {
  const db = getClient();
  const session = await getOrCreateSession(phone);

  const remitente = role === 'user' ? 'usuario' : 'asistente';

  await db.from('wp_mensajes').insert({
    conversacion_id: session.conversacion_id,
    remitente,
    contenido: content,
    tipo: 'texto',
    status: 'enviado',
    empresa_id: EMPRESA_ID,
  });
}

export async function updateSessionContext(_phone: string, _context: Record<string, unknown>): Promise<void> {
  // No separate context field — context is tracked via messages
}

// ── Business data ──

export async function getBusinessSnapshot(): Promise<Record<string, unknown>> {
  const db = getClient();
  const snapshot: Record<string, unknown> = {};

  try {
    const { count } = await db
      .from('wp_conversaciones')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', EMPRESA_ID);
    snapshot.total_conversations = count || 0;
  } catch (_) {}

  return snapshot;
}
