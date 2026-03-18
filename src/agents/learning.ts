/**
 * Learning System — Atlas Multi-Agent System
 * 
 * Cierra el loop de aprendizaje:
 *   - Trackea outcomes de cada acción (aprobado / rechazado / ignorado)
 *   - Ajusta autonomía dinámica por categoría basado en track record
 *   - Registra patrones de rechazo para que el Critic los use
 * 
 * Tabla Supabase requerida: atlas_autonomy_tracker
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

// ── Autonomy levels ──
// L1 = actúa silenciosamente
// L2 = actúa y notifica
// L3 = siempre pide permiso

export type AutonomyLevel = 1 | 2 | 3;

export interface ActionCategory {
  name: string;
  defaultLevel: AutonomyLevel;
  minLevel: AutonomyLevel;  // Nunca bajar de esto
  maxLevel: AutonomyLevel;  // Nunca subir de esto
}

// Categorías de acción con niveles por defecto
export const ACTION_CATEGORIES: ActionCategory[] = [
  { name: 'tweet_publish', defaultLevel: 3, minLevel: 2, maxLevel: 3 },
  { name: 'email_send', defaultLevel: 3, minLevel: 3, maxLevel: 3 },      // Siempre pide permiso
  { name: 'email_draft', defaultLevel: 2, minLevel: 1, maxLevel: 2 },
  { name: 'drive_upload', defaultLevel: 2, minLevel: 1, maxLevel: 2 },
  { name: 'calendar_event', defaultLevel: 3, minLevel: 2, maxLevel: 3 },
  { name: 'git_commit', defaultLevel: 1, minLevel: 1, maxLevel: 1 },      // Siempre silencioso
  { name: 'file_organize', defaultLevel: 1, minLevel: 1, maxLevel: 1 },
  { name: 'alert_send', defaultLevel: 2, minLevel: 1, maxLevel: 2 },
  { name: 'report_generate', defaultLevel: 2, minLevel: 1, maxLevel: 2 },
  { name: 'delete_action', defaultLevel: 3, minLevel: 3, maxLevel: 3 },   // Siempre pide permiso
];

// ── Record outcome of an action ──

export async function recordOutcome(
  blackboardEventId: number,
  category: string,
  outcome: 'approved' | 'rejected' | 'ignored' | 'acted_on',
  diegoResponse?: string
): Promise<void> {
  try {
    const { error } = await supabase.from('atlas_autonomy_tracker').insert({
      blackboard_event_id: blackboardEventId,
      category,
      outcome,
      diego_response: diegoResponse || null,
      created_at: new Date().toISOString(),
    });

    if (error) console.error('[learning] recordOutcome error:', error);
    else console.log(`[learning] Recorded: ${category} → ${outcome}`);

    // Update blackboard with outcome
    await supabase
      .from('atlas_blackboard')
      .update({ outcome, outcome_at: new Date().toISOString() })
      .eq('id', blackboardEventId);

    // Recalculate autonomy for this category
    await recalculateAutonomy(category);

  } catch (e) {
    console.error('[learning] Error recording outcome:', e);
  }
}

// ── Get current autonomy level for a category ──

export async function getAutonomyLevel(category: string): Promise<AutonomyLevel> {
  try {
    const { data } = await supabase
      .from('atlas_autonomy_levels')
      .select('current_level')
      .eq('category', category)
      .single();

    if (data) return data.current_level as AutonomyLevel;
  } catch (_) {}

  // Return default if not found
  const cat = ACTION_CATEGORIES.find(c => c.name === category);
  return cat?.defaultLevel || 3;
}

// ── Recalculate autonomy based on recent track record ──

async function recalculateAutonomy(category: string): Promise<void> {
  try {
    const cat = ACTION_CATEGORIES.find(c => c.name === category);
    if (!cat) return;

    // Get last 20 outcomes for this category
    const { data: history } = await supabase
      .from('atlas_autonomy_tracker')
      .select('outcome')
      .eq('category', category)
      .order('created_at', { ascending: false })
      .limit(20);

    if (!history || history.length < 5) return; // Need at least 5 data points

    const total = history.length;
    const positive = history.filter(h =>
      h.outcome === 'approved' || h.outcome === 'acted_on'
    ).length;
    const approvalRate = (positive / total) * 100;

    // Determine new level
    let newLevel: AutonomyLevel = cat.defaultLevel;

    if (approvalRate >= 90 && total >= 10) {
      // High approval → increase autonomy (lower number = more autonomous)
      newLevel = Math.max(cat.minLevel, cat.defaultLevel - 1) as AutonomyLevel;
    } else if (approvalRate < 60) {
      // Low approval → decrease autonomy
      newLevel = Math.min(cat.maxLevel, cat.defaultLevel + 1) as AutonomyLevel;
    } else {
      newLevel = cat.defaultLevel;
    }

    // Clamp to min/max
    newLevel = Math.max(cat.minLevel, Math.min(cat.maxLevel, newLevel)) as AutonomyLevel;

    // Upsert autonomy level
    await supabase.from('atlas_autonomy_levels').upsert({
      category,
      current_level: newLevel,
      approval_rate: approvalRate,
      total_actions: total,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'category' });

    console.log(`[learning] ${category}: ${approvalRate.toFixed(0)}% approval → Level ${newLevel}`);

  } catch (e) {
    console.error('[learning] recalculateAutonomy error:', e);
  }
}

// ── Get recent rejects for Critic context ──

export async function getRecentRejects(category: string, limit = 5): Promise<string[]> {
  try {
    const { data } = await supabase
      .from('atlas_autonomy_tracker')
      .select('diego_response')
      .eq('category', category)
      .eq('outcome', 'rejected')
      .not('diego_response', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    return (data || []).map(d => d.diego_response).filter(Boolean);
  } catch (_) {
    return [];
  }
}

// ── Detect Diego's response to an alert (called from message handler) ──

export async function detectOutcomeFromMessage(
  diegoMessage: string,
  recentBlackboardId?: number
): Promise<void> {
  if (!recentBlackboardId) return;

  const msg = diegoMessage.toLowerCase();

  // Simple sentiment detection for now
  let outcome: 'approved' | 'rejected' | 'acted_on' | 'ignored' = 'ignored';

  if (msg.includes('ok') || msg.includes('gracias') || msg.includes('listo') || msg.includes('hecho')) {
    outcome = 'acted_on';
  } else if (msg.includes('no') || msg.includes('cancela') || msg.includes('para') || msg.includes('ignora')) {
    outcome = 'rejected';
  } else if (msg.includes('bien') || msg.includes('perfecto') || msg.includes('dale')) {
    outcome = 'approved';
  }

  if (outcome !== 'ignored') {
    // Get the blackboard event to get its category
    const { data: event } = await supabase
      .from('atlas_blackboard')
      .select('event_type')
      .eq('id', recentBlackboardId)
      .single();

    if (event) {
      await recordOutcome(recentBlackboardId, event.event_type, outcome, diegoMessage);
    }
  }
}
