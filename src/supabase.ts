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
const URPE_INTEGRAL_ID = 4; // URPE Integral Services

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

function todayStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function weekStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + 1); // Monday
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function monthStart(): string {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function getBusinessSnapshot(): Promise<Record<string, unknown>> {
  const db = getClient();
  const snapshot: Record<string, unknown> = {};
  const today = todayStart();
  const week = weekStart();
  const month = monthStart();

  // ── URPE Integral Services (empresa_id=4) ──

  // Citas hoy
  try {
    const { data: citasHoy } = await db
      .from('wp_citas')
      .select('id, estado, titulo, fecha_hora')
      .eq('empresa_id', URPE_INTEGRAL_ID)
      .gte('fecha_hora', today)
      .lt('fecha_hora', new Date(Date.now() + 86400000).toISOString())
      .order('fecha_hora', { ascending: true });

    snapshot.citas_hoy = citasHoy || [];
    snapshot.citas_hoy_total = citasHoy?.length || 0;
  } catch (_) {}

  // Citas esta semana por estado
  try {
    const { data: citasSemana } = await db
      .from('wp_citas')
      .select('estado')
      .eq('empresa_id', URPE_INTEGRAL_ID)
      .gte('fecha_hora', week);

    const estadoCount: Record<string, number> = {};
    for (const c of citasSemana || []) {
      estadoCount[c.estado] = (estadoCount[c.estado] || 0) + 1;
    }
    snapshot.citas_semana = estadoCount;
    snapshot.citas_semana_total = citasSemana?.length || 0;
  } catch (_) {}

  // Citas este mes por estado
  try {
    const { data: citasMes } = await db
      .from('wp_citas')
      .select('estado')
      .eq('empresa_id', URPE_INTEGRAL_ID)
      .gte('fecha_hora', month);

    const estadoCount: Record<string, number> = {};
    for (const c of citasMes || []) {
      estadoCount[c.estado] = (estadoCount[c.estado] || 0) + 1;
    }
    snapshot.citas_mes = estadoCount;
    snapshot.citas_mes_total = citasMes?.length || 0;
  } catch (_) {}

  // Conversaciones (leads) hoy por canal
  try {
    const { data: convsHoy } = await db
      .from('wp_conversaciones')
      .select('canal')
      .eq('empresa_id', URPE_INTEGRAL_ID)
      .gte('fecha_inicio', today);

    const canalCount: Record<string, number> = {};
    for (const c of convsHoy || []) {
      canalCount[c.canal || 'desconocido'] = (canalCount[c.canal || 'desconocido'] || 0) + 1;
    }
    snapshot.leads_hoy = canalCount;
    snapshot.leads_hoy_total = convsHoy?.length || 0;
  } catch (_) {}

  // Conversaciones (leads) esta semana por canal
  try {
    const { data: convsSemana } = await db
      .from('wp_conversaciones')
      .select('canal')
      .eq('empresa_id', URPE_INTEGRAL_ID)
      .gte('fecha_inicio', week);

    const canalCount: Record<string, number> = {};
    for (const c of convsSemana || []) {
      canalCount[c.canal || 'desconocido'] = (canalCount[c.canal || 'desconocido'] || 0) + 1;
    }
    snapshot.leads_semana = canalCount;
    snapshot.leads_semana_total = convsSemana?.length || 0;
  } catch (_) {}

  // Conversaciones (leads) este mes por canal
  try {
    const { data: convsMes } = await db
      .from('wp_conversaciones')
      .select('canal')
      .eq('empresa_id', URPE_INTEGRAL_ID)
      .gte('fecha_inicio', month);

    const canalCount: Record<string, number> = {};
    for (const c of convsMes || []) {
      canalCount[c.canal || 'desconocido'] = (canalCount[c.canal || 'desconocido'] || 0) + 1;
    }
    snapshot.leads_mes = canalCount;
    snapshot.leads_mes_total = convsMes?.length || 0;
  } catch (_) {}

  // Contactos nuevos este mes
  try {
    const { count } = await db
      .from('wp_contactos')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', URPE_INTEGRAL_ID)
      .gte('created_at', month);
    snapshot.contactos_nuevos_mes = count || 0;
  } catch (_) {}

  // Total contactos activos
  try {
    const { count } = await db
      .from('wp_contactos')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', URPE_INTEGRAL_ID)
      .eq('is_active', true);
    snapshot.contactos_activos_total = count || 0;
  } catch (_) {}

  // ── Urpe AI Lab (empresa_id=13) ──
  try {
    const { count } = await db
      .from('wp_conversaciones')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', EMPRESA_ID);
    snapshot.ai_lab_conversaciones_total = count || 0;
  } catch (_) {}

  snapshot.timestamp = new Date().toISOString();
  snapshot.empresa = 'URPE Integral Services + Urpe AI Lab';

  return snapshot;
}
