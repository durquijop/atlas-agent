/**
 * Composer Agent — Atlas Multi-Agent System
 *
 * Responsabilidad única: redactar contenido de alta calidad.
 * NUNCA busca información, NUNCA actúa en sistemas externos.
 * Solo recibe datos y los convierte en contenido listo para usar.
 *
 * Casos de uso:
 *   - Tweets para @soydiegoup
 *   - Emails profesionales
 *   - Briefings ejecutivos
 *   - Resúmenes de reuniones
 *   - Propuestas y documentos
 *   - Respuestas difíciles (negociaciones, rechazos, follow-ups)
 *
 * Modelo: Claude Sonnet 4.5 (calidad) con opción a Opus para piezas críticas
 */

import { callLLM } from '../llm-router';

// ── TIPOS ──

export type ComposerTaskType =
  | 'tweet'
  | 'email'
  | 'briefing'
  | 'meeting_summary'
  | 'proposal'
  | 'response'        // Respuesta a situación difícil
  | 'report'
  | 'message';        // Mensaje casual/WhatsApp

export interface ComposerRequest {
  task: ComposerTaskType;
  instruction: string;          // Qué escribir
  context?: string;             // Información de fondo (de Research o Memory)
  tone?: 'formal' | 'casual' | 'assertive' | 'empathetic';
  length?: 'short' | 'medium' | 'long';
  examples?: string[];          // Ejemplos del estilo deseado
  useOpus?: boolean;            // Para piezas críticas (negociaciones, propuestas)
}

export interface ComposerResult {
  content: string;
  task: ComposerTaskType;
  wordCount: number;
  alternatives?: string[];      // 2-3 versiones alternativas cuando aplica
}

// ── SYSTEM PROMPTS POR TIPO ──

const COMPOSER_SYSTEM = `Eres el Composer Agent de Atlas, el asistente de Diego Urquijo.

Diego es CEO de URPE Integral Services (inmigración USA) y URPE AI Lab. Barranquillero. Directo, inteligente, con visión. Twitter: @soydiegoup.

Tu trabajo: redactar contenido que suene exactamente como Diego, no como un asistente genérico.

REGLAS ABSOLUTAS:
- Nunca uses frases corporativas vacías
- Nunca uses "en este sentido", "cabe destacar", "es importante mencionar"
- El contenido debe sonar humano, no generado por IA
- Español latino neutral (NO argentino)
- Si es un tweet: máx 240 chars, sin hashtags a menos que se pidan
- Si es un email: subject + body separados claramente
- Siempre entrega la pieza lista para usar, no un borrador`;

const TASK_PROMPTS: Record<ComposerTaskType, string> = {
  tweet: `Escribe un tweet para @soydiegoup.
Estilo: verdades directas sobre negocios, tecnología o liderazgo. Que haga pensar. Sin hashtags innecesarios. Sin emojis a menos que se pida. Máx 240 chars.
Genera 3 versiones, ordenadas de mejor a peor.`,

  email: `Escribe un email profesional en nombre de Diego Urquijo.
Formato:
ASUNTO: [subject line]
CUERPO:
[body]
Tono: directo pero cordial. Sin saludos floridos. Claro en el CTA.`,

  briefing: `Escribe un briefing ejecutivo.
Formato: bullet points concisos. Lo que importa primero. Máx 1 página.
El lector es Diego — no necesita explicaciones básicas, necesita lo accionable.`,

  meeting_summary: `Escribe el resumen de una reunión.
Incluye: decisiones tomadas, próximos pasos con responsables, fecha límite si aplica.
Sin narrativa, solo hechos y acciones.`,

  proposal: `Escribe una propuesta profesional.
Estructura: problema → solución → valor → términos → CTA.
Persuasivo pero honesto. Sin hype vacío.`,

  response: `Ayuda a Diego a responder esta situación difícil.
El mensaje debe ser directo, sin rodeos, pero sin quemar puentes.
Genera la respuesta lista para enviar.`,

  report: `Escribe un reporte ejecutivo.
Formato: headline → datos clave → análisis → recomendación.
Diego lee esto en 2 minutos — que cada línea cuente.`,

  message: `Escribe un mensaje casual pero efectivo.
Tono: cercano, directo, como Diego habla normalmente.
Sin formalidades innecesarias.`,
};

// ── DETECTOR DE INTENT ──

const COMPOSER_TRIGGERS = [
  // Tweets
  { pattern: /(?:escribe?|crea?|redacta?|genera?)\s+(?:un\s+)?tweet\s+(?:sobre\s+|de\s+|acerca\s+de\s+)?(.+)/i, task: 'tweet' as ComposerTaskType },
  { pattern: /tweet\s+(?:sobre|de|para)\s+(.+)/i, task: 'tweet' as ComposerTaskType },
  // Emails
  { pattern: /(?:escribe?|redacta?)\s+(?:un\s+)?(?:email|correo)\s+(?:a\s+|para\s+)?(.+)/i, task: 'email' as ComposerTaskType },
  { pattern: /(?:email|correo)\s+(?:para|a)\s+(.+)/i, task: 'email' as ComposerTaskType },
  // Briefings
  { pattern: /(?:prepara?|escribe?)\s+(?:un\s+)?briefing\s+(?:sobre|de|para)?\s*(.+)/i, task: 'briefing' as ComposerTaskType },
  // Resumen reunión
  { pattern: /resumen\s+(?:de\s+(?:la\s+)?(?:reunión|meeting|call))\s+(?:con\s+|de\s+)?(.+)/i, task: 'meeting_summary' as ComposerTaskType },
  // Propuestas
  { pattern: /(?:escribe?|redacta?|prepara?)\s+(?:una\s+)?propuesta\s+(?:para|de)\s+(.+)/i, task: 'proposal' as ComposerTaskType },
  // Respuestas difíciles
  { pattern: /(?:cómo|como)\s+(?:le\s+)?respondo\s+(?:a\s+)?(.+)/i, task: 'response' as ComposerTaskType },
  { pattern: /(?:ayúdame|ayuda)\s+(?:a\s+)?respond(?:er|er\s+a|erle)\s+(.+)/i, task: 'response' as ComposerTaskType },
  // Mensajes
  { pattern: /(?:escribe?|redacta?)\s+(?:un\s+)?mensaje\s+(?:para|a)\s+(.+)/i, task: 'message' as ComposerTaskType },
];

export function detectComposerIntent(message: string): ComposerRequest | null {
  const msg = message.trim();
  if (msg.length < 5 || msg.length > 1000) return null;

  for (const trigger of COMPOSER_TRIGGERS) {
    const match = msg.match(trigger.pattern);
    if (match && match[1] && match[1].trim().length > 2) {
      const instruction = match[1].trim().replace(/[.!?]+$/, '');

      // Detectar longitud deseada
      let length: 'short' | 'medium' | 'long' = 'medium';
      if (/corto|breve|rápido|short/i.test(msg)) length = 'short';
      if (/detallado|largo|extenso|completo/i.test(msg)) length = 'long';

      // Detectar tono
      let tone: ComposerRequest['tone'] = 'casual';
      if (/formal|profesional/i.test(msg)) tone = 'formal';
      if (/firme|directo|asserti/i.test(msg)) tone = 'assertive';
      if (/empático|suave|delicado/i.test(msg)) tone = 'empathetic';

      console.log(`[composer-intent] Detected: task=${trigger.task}, instruction="${instruction}"`);

      return {
        task: trigger.task,
        instruction,
        tone,
        length,
        useOpus: trigger.task === 'proposal' || /importante|crítico|urgente/i.test(msg),
      };
    }
  }
  return null;
}

// ── COMPOSER PRINCIPAL ──

export async function compose(req: ComposerRequest): Promise<ComposerResult> {
  console.log(`[composer] Starting: task=${req.task}, length=${req.length || 'medium'}, opus=${req.useOpus}`);

  const systemPrompt = `${COMPOSER_SYSTEM}\n\n${TASK_PROMPTS[req.task]}`;

  const userPrompt = `INSTRUCCIÓN: ${req.instruction}
${req.context ? `\nCONTEXTO ADICIONAL:\n${req.context}` : ''}
${req.tone ? `\nTONO DESEADO: ${req.tone}` : ''}
${req.length ? `\nLONGITUD: ${req.length}` : ''}
${req.examples?.length ? `\nEJEMPLOS DE ESTILO:\n${req.examples.join('\n---\n')}` : ''}

Entrega el contenido listo para usar.`;

  // Usar Sonnet siempre por ahora (Opus cuando lo configure Diego)
  const agentRole = 'orchestrator'; // Claude Sonnet 4.5
  const maxTokens = req.length === 'long' ? 2048 : req.length === 'short' ? 512 : 1024;

  const response = await callLLM(agentRole, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], { maxTokens, temperature: 0.8 });

  // Extraer alternativas si el task es tweet
  let content = response;
  let alternatives: string[] = [];

  if (req.task === 'tweet') {
    const lines = response.split('\n').filter(l => l.trim().length > 10);
    // Las versiones del tweet suelen estar numeradas
    const versions = lines.filter(l => /^[1-3][.)]\s/.test(l) || l.startsWith('Versión') || l.startsWith('Opción'));
    if (versions.length >= 2) {
      content = versions[0].replace(/^[1-3][.)\s]+|^Versión\s+\d+:\s*/i, '').trim();
      alternatives = versions.slice(1).map(v => v.replace(/^[1-3][.)\s]+|^Versión\s+\d+:\s*/i, '').trim());
    }
  }

  console.log(`[composer] Done: ${content.length} chars`);

  return {
    content,
    task: req.task,
    wordCount: content.split(/\s+/).length,
    alternatives: alternatives.length > 0 ? alternatives : undefined,
  };
}

// ── FORMATTER PARA WHATSAPP ──

export function formatComposerForWhatsApp(result: ComposerResult): string {
  let msg = result.content;

  if (result.alternatives && result.alternatives.length > 0) {
    msg += '\n\nAlternativas:\n';
    result.alternatives.forEach((alt, i) => {
      msg += `\n${i + 2}. ${alt}`;
    });
  }

  return msg;
}
