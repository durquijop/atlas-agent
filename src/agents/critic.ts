/**
 * Critic Agent — Atlas Multi-Agent System
 * 
 * Agente adversarial que revisa cualquier output ANTES de enviarlo a Diego.
 * Preguntas clave:
 *   - ¿Es esto realmente urgente o puede esperar?
 *   - ¿Los datos están verificados?
 *   - ¿La recomendación tiene sentido dado el historial?
 *   - ¿Esto le va a generar valor a Diego o es ruido?
 * 
 * Si el output no pasa la revisión → lo bloquea o lo reformula.
 * Nunca habla con Diego directamente.
 */

import { callLLM } from '../llm-router';

export type CriticVerdict = 'APPROVED' | 'REFORMULATED' | 'BLOCKED';

export interface CriticResult {
  verdict: CriticVerdict;
  output: string;           // Output final (original, reformulado, o vacío si bloqueado)
  reasoning: string;        // Por qué tomó esa decisión
  confidenceScore: number;  // 0-100 — qué tan seguro está el crítico
}

interface CriticContext {
  eventType: string;
  priority: string;
  originalTitle: string;
  autonomyHistory?: {
    category: string;
    approvalRate: number;
    totalActions: number;
  };
  recentRejects?: string[];  // Últimas acciones rechazadas por Diego en esta categoría
}

const CRITIC_SYSTEM_PROMPT = `Eres el Agente Crítico de un sistema de asistente personal para un CEO llamado Diego.

Tu trabajo es revisar mensajes ANTES de que lleguen a Diego y tomar UNA de tres decisiones:

1. APPROVED — El mensaje es válido, urgente si dice ser urgente, y agrega valor real.
2. REFORMULATED — El contenido es correcto pero el tono/formato/urgencia está mal. Reescríbelo mejor.
3. BLOCKED — Este mensaje es ruido, no es realmente urgente, o Diego ya sabe esto. No enviarlo.

CRITERIOS PARA BLOQUEAR:
- La información ya fue enviada en las últimas 4 horas
- La "urgencia" es subjetiva y puede esperar al próximo heartbeat
- El mensaje genera ansiedad sin proponer acción concreta
- Es información que Diego claramente ya conoce

CRITERIOS PARA REFORMULAR:
- El contenido es correcto pero demasiado largo, técnico, o alarmista
- La acción sugerida no es la más eficiente
- El tono no coincide con la situación real

CRITERIOS PARA APROBAR:
- Acción concreta requerida HOY
- Información que Diego necesita para tomar una decisión activa
- Crisis real (sistema caído, pago rechazado por segundo intento, evento en <2h)

Responde SIEMPRE en este JSON exacto:
{
  "verdict": "APPROVED" | "REFORMULATED" | "BLOCKED",
  "output": "El mensaje final a enviar (vacío string si BLOCKED)",
  "reasoning": "Una línea explicando la decisión",
  "confidenceScore": número entre 0 y 100
}`;

export async function runCritic(
  draftMessage: string,
  context: CriticContext
): Promise<CriticResult> {
  const userPrompt = `Revisa este mensaje antes de enviarlo a Diego:

---
${draftMessage}
---

Contexto adicional:
- Tipo de evento: ${context.eventType}
- Prioridad asignada: ${context.priority}
- Título original del evento: ${context.originalTitle}
${context.autonomyHistory ? `- Historial de autonomía en categoría "${context.autonomyHistory.category}": ${context.autonomyHistory.approvalRate}% aprobación en ${context.autonomyHistory.totalActions} acciones` : ''}
${context.recentRejects?.length ? `- Últimas acciones rechazadas por Diego en esta categoría: ${context.recentRejects.join(', ')}` : ''}

Toma tu decisión y responde en JSON.`;

  try {
    const response = await callLLM('critic', [
      { role: 'system', content: CRITIC_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ], { temperature: 0.1 }); // Baja temperatura para decisiones consistentes

    // Parse JSON response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[critic] Could not parse JSON from response:', response);
      // Fail-safe: approve if can't parse (don't block unnecessarily)
      return {
        verdict: 'APPROVED',
        output: draftMessage,
        reasoning: 'Parse error — fail-safe approval',
        confidenceScore: 50,
      };
    }

    const result = JSON.parse(jsonMatch[0]) as CriticResult;
    console.log(`[critic] Verdict: ${result.verdict} (${result.confidenceScore}%) — ${result.reasoning}`);
    return result;

  } catch (error) {
    console.error('[critic] Error:', error);
    // Fail-safe: approve
    return {
      verdict: 'APPROVED',
      output: draftMessage,
      reasoning: 'Error in critic — fail-safe approval',
      confidenceScore: 50,
    };
  }
}
