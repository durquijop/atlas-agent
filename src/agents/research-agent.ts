/**
 * Research Agent — Atlas Multi-Agent System
 *
 * Responsabilidad única: investigar. Nunca habla con Diego directamente.
 * 
 * Capacidades:
 *   - Búsqueda web con Firecrawl (search + scrape + extract)
 *   - Investigación de personas antes de reuniones
 *   - Análisis de competencia
 *   - Fact-checking de claims
 *   - Investigación de tendencias y noticias
 *   - On-demand: se activa cuando el Orchestrator lo necesita
 *
 * Invocación:
 *   - Explícita: Diego dice "investiga a X" o "busca info sobre Y"
 *   - Implícita: Monitor detecta evento → Orchestrator necesita contexto
 *   - Cron: research matutino opcional sobre temas de interés
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../config';
import { generateResponse } from '../llm';

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1';

// ── TIPOS ──

export type ResearchType =
  | 'person'          // Investigar persona antes de reunión
  | 'company'         // Investigar empresa/competencia
  | 'news'            // Noticias recientes sobre tema
  | 'fact_check'      // Verificar un claim
  | 'market'          // Análisis de mercado
  | 'general';        // Búsqueda general

export interface ResearchRequest {
  query: string;
  type: ResearchType;
  context?: string;       // Contexto adicional (ej: "es el CFO de la empresa X")
  depth?: 'quick' | 'deep';  // quick = 1-2 fuentes, deep = 5+ fuentes
  saveToMemory?: boolean;     // Si guardar resultado en atlas_memory
}

export interface ResearchResult {
  query: string;
  type: ResearchType;
  summary: string;          // Resumen ejecutivo
  key_findings: string[];   // Puntos más importantes
  sources: string[];        // URLs consultadas
  confidence: 'high' | 'medium' | 'low';
  timestamp: string;
}

// ── FIRECRAWL API ──

async function firecrawlSearch(query: string, limit = 5): Promise<{ url: string; markdown: string; title: string }[]> {
  const res = await fetch(`${FIRECRAWL_BASE}/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      limit,
      scrapeOptions: { formats: ['markdown'] },
    }),
  });

  if (!res.ok) {
    console.error(`[research] Firecrawl search error: ${res.status}`);
    return [];
  }

  const data = await res.json() as { data?: { url: string; markdown: string; metadata?: { title?: string } }[] };
  return (data.data || []).map(r => ({
    url: r.url,
    markdown: (r.markdown || '').substring(0, 3000), // Truncar para no explotar el contexto
    title: r.metadata?.title || r.url,
  }));
}

function generateFallbackQueries(query: string, type: ResearchType): string[] {
  // Remove common prepositions that confuse search
  const clean = query
    .replace(/\s+de\s+/gi, ' ')
    .replace(/\s+del\s+/gi, ' ')
    .replace(/\.com/gi, '')
    .trim();

  const parts = clean.split(/\s+/);
  const fallbacks: string[] = [];

  // Try name only (first 2-3 words)
  if (parts.length > 2) {
    fallbacks.push(parts.slice(0, 2).join(' '));
    fallbacks.push(parts.slice(0, 3).join(' '));
  }

  // Try with LinkedIn
  fallbacks.push(`${parts.slice(0, 2).join(' ')} LinkedIn`);

  // Try with company name separately
  if (type === 'person' && parts.length > 2) {
    const company = parts.slice(-1)[0];
    fallbacks.push(`${parts.slice(0, 2).join(' ')} ${company} CEO`);
    fallbacks.push(`${company} media director`);
  }

  // Try in English
  fallbacks.push(`${clean} media executive`);

  return [...new Set(fallbacks)]; // Remove duplicates
}

async function firecrawlScrape(url: string): Promise<string> {
  const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
    }),
  });

  if (!res.ok) return '';

  const data = await res.json() as { data?: { markdown?: string } };
  return (data.data?.markdown || '').substring(0, 5000);
}

// ── PROMPTS POR TIPO DE INVESTIGACIÓN ──

function buildResearchPrompt(type: ResearchType, query: string, context?: string): string {
  const contextStr = context ? `\nContexto adicional: ${context}` : '';

  const prompts: Record<ResearchType, string> = {
    person: `Investiga a esta persona para Diego Urquijo, CEO de URPE Integral Services y URPE AI Lab.
Persona a investigar: ${query}${contextStr}

Diego necesita saber:
1. Quién es exactamente (cargo, empresa, trayectoria)
2. Logros o proyectos relevantes recientes
3. Conexiones con la industria de inmigración o IA (si las hay)
4. Estilo de comunicación o personalidad pública (si es conocido)
5. Cualquier red flag o información importante para la reunión

Sé conciso y directo. Formato: hallazgos concretos, no especulaciones.`,

    company: `Analiza esta empresa/competidor para Diego Urquijo.
Empresa: ${query}${contextStr}

Analiza:
1. Qué hacen exactamente y su modelo de negocio
2. Tamaño, financiamiento, tracción actual
3. Fortalezas y debilidades vs URPE
4. Oportunidades de colaboración o amenazas competitivas
5. Noticias recientes relevantes`,

    news: `Busca las noticias más relevantes y recientes sobre:
${query}${contextStr}

Criterios:
- Solo noticias de los últimos 30 días
- Priorizar fuentes confiables
- Relevancia para un CEO de servicios de inmigración e IA en USA
- Impacto potencial en los negocios de Diego`,

    fact_check: `Verifica si esto es verdad y en qué grado:
"${query}"${contextStr}

Busca evidencia a favor y en contra. Determina:
1. ¿Es verdad, parcialmente verdad, o falso?
2. Fuentes que lo confirman o refutan
3. Matices importantes`,

    market: `Análisis de mercado sobre:
${query}${contextStr}

Cubre:
1. Tamaño del mercado y crecimiento
2. Actores principales
3. Tendencias 2026
4. Oportunidades específicas para URPE`,

    general: `Investiga sobre: ${query}${contextStr}

Entrega los hallazgos más relevantes y accionables para Diego Urquijo, CEO emprendedor en inmigración e IA.`,
  };

  return prompts[type];
}

// ── SINTETIZADOR ──

async function synthesizeResearch(
  rawResults: { url: string; markdown: string; title: string }[],
  researchPrompt: string,
  query: string,
  type: ResearchType
): Promise<ResearchResult> {
  const sourcesText = rawResults
    .map((r, i) => `\n--- FUENTE ${i + 1}: ${r.title} (${r.url}) ---\n${r.markdown}`)
    .join('\n\n');

  const synthesisPrompt = `${researchPrompt}

INFORMACIÓN ENCONTRADA:
${sourcesText}

Responde en JSON exacto:
{
  "summary": "Resumen ejecutivo en 3-5 oraciones. Directo al punto, sin paja.",
  "key_findings": ["hallazgo 1", "hallazgo 2", "hallazgo 3"],
  "confidence": "high|medium|low"
}

- high: múltiples fuentes confirman, información reciente y verificable
- medium: una fuente sólida o información algo desactualizada
- low: información escasa, no verificable, o muy general`;

  try {
    const response = await generateResponse(
      [{ role: 'user' as const, content: synthesisPrompt }],
      'Eres el Research Agent de Atlas. Sintetizas información de forma precisa y accionable para Diego Urquijo.',
      false
    );

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]) as {
      summary: string;
      key_findings: string[];
      confidence: 'high' | 'medium' | 'low';
    };

    return {
      query,
      type,
      summary: parsed.summary,
      key_findings: parsed.key_findings || [],
      sources: rawResults.map(r => r.url),
      confidence: parsed.confidence || 'medium',
      timestamp: new Date().toISOString(),
    };

  } catch (e) {
    console.error('[research] Synthesis error:', e);
    return {
      query,
      type,
      summary: 'No se pudo sintetizar la información encontrada.',
      key_findings: rawResults.map(r => r.title).filter(Boolean),
      sources: rawResults.map(r => r.url),
      confidence: 'low',
      timestamp: new Date().toISOString(),
    };
  }
}

// ── API PÚBLICA ──

export async function research(req: ResearchRequest): Promise<ResearchResult> {
  console.log(`[research] Starting: "${req.query}" (type=${req.type}, depth=${req.depth || 'quick'})`);

  const limit = req.depth === 'deep' ? 8 : 4;

  // Búsqueda principal
  const results = await firecrawlSearch(req.query, limit);

  // Si es investigación de persona o empresa, scrape el resultado más relevante
  if ((req.type === 'person' || req.type === 'company') && results.length > 0) {
    const topUrl = results[0].url;
    const deepContent = await firecrawlScrape(topUrl);
    if (deepContent) {
      results[0].markdown = deepContent; // Reemplazar con contenido completo
    }
  }

  // Si no hay resultados, intentar queries alternativos
  if (results.length === 0) {
    console.warn(`[research] No results for: "${req.query}" — trying fallback queries`);

    const fallbackQueries = generateFallbackQueries(req.query, req.type);
    for (const fallback of fallbackQueries) {
      console.log(`[research] Trying fallback: "${fallback}"`);
      const fallbackResults = await firecrawlSearch(fallback, 3);
      if (fallbackResults.length > 0) {
        results.push(...fallbackResults);
        break;
      }
    }

    if (results.length === 0) {
      return {
        query: req.query,
        type: req.type,
        summary: `No encontré información pública sobre "${req.query}". Puede ser una persona o empresa con poca presencia web, o el nombre exacto puede ser diferente.`,
        key_findings: [],
        sources: [],
        confidence: 'low',
        timestamp: new Date().toISOString(),
      };
    }
  }

  const prompt = buildResearchPrompt(req.type, req.query, req.context);
  const result = await synthesizeResearch(results, prompt, req.query, req.type);

  // Guardar en memoria si se solicitó
  if (req.saveToMemory && result.confidence !== 'low') {
    try {
      await supabase.from('atlas_memory').insert({
        category: 'knowledge',
        title: `Research: ${req.query}`,
        content: `${result.summary}\n\nHallazgos:\n${result.key_findings.map(f => `- ${f}`).join('\n')}\n\nFuentes: ${result.sources.join(', ')}`,
        tags: ['research', req.type, ...req.query.split(' ').slice(0, 3)],
      });
      console.log(`[research] Saved to memory: "${req.query}"`);
    } catch (e) {
      console.error('[research] Memory save error:', e);
    }
  }

  console.log(`[research] Complete: confidence=${result.confidence}, sources=${result.sources.length}`);
  return result;
}

// ── DETECTOR DE INTENT ──
// El Orchestrator usa esto para detectar cuando Diego quiere investigación

const RESEARCH_TRIGGERS = [
  // Investigación de persona — flexible, acepta palabras entre "investiga" y el nombre
  { pattern: /investiga(?:r)?(?:\s+\w+){0,3}\s+a\s+(.+)/i, type: 'person' as ResearchType },
  { pattern: /investiga(?:r)?\s+(?:sobre|a)\s+(.+)/i, type: 'person' as ResearchType },
  { pattern: /investiga(?:r)?\s+(.+)/i, type: 'general' as ResearchType },
  { pattern: /busca\s+info(?:rmación)?\s+(?:sobre|de|acerca\s+de)?\s*(.+)/i, type: 'general' as ResearchType },
  { pattern: /busca(?:r)?\s+(?:sobre|a)\s+(.+)/i, type: 'general' as ResearchType },
  { pattern: /quién\s+es\s+(.+)/i, type: 'person' as ResearchType },
  { pattern: /(?:reunión|meeting|call|cita)\s+con\s+(.+)/i, type: 'person' as ResearchType },
  // Investigación de empresa
  { pattern: /analiza(?:r)?\s+(?:la\s+empresa\s+|al?\s+)?(.+)/i, type: 'company' as ResearchType },
  { pattern: /compet(?:idor|encia)\s+(.+)/i, type: 'company' as ResearchType },
  { pattern: /dime\s+(?:algo\s+)?(?:sobre|de)\s+la\s+empresa\s+(.+)/i, type: 'company' as ResearchType },
  // Noticias
  { pattern: /noticias?\s+(?:sobre|de|acerca\s+de)\s+(.+)/i, type: 'news' as ResearchType },
  { pattern: /qué\s+(?:hay|pasó|está\s+pasando)\s+con\s+(.+)/i, type: 'news' as ResearchType },
  { pattern: /qué\s+se\s+sabe\s+(?:de|sobre)\s+(.+)/i, type: 'news' as ResearchType },
  // Fact check
  { pattern: /(?:es\s+verdad|verifica|fact.?check)\s+(?:que\s+)?(.+)/i, type: 'fact_check' as ResearchType },
  // Mercado
  { pattern: /mercado\s+de\s+(.+)/i, type: 'market' as ResearchType },
  { pattern: /tendencias?\s+(?:en|de)\s+(.+)/i, type: 'market' as ResearchType },
];

export function detectResearchIntent(message: string): ResearchRequest | null {
  for (const trigger of RESEARCH_TRIGGERS) {
    const match = message.match(trigger.pattern);
    if (match) {
      return {
        query: match[1].trim(),
        type: trigger.type,
        depth: message.toLowerCase().includes('detallad') || message.toLowerCase().includes('profund') ? 'deep' : 'quick',
        saveToMemory: true,
      };
    }
  }
  return null;
}

// ── FORMATTER: convierte ResearchResult en mensaje WhatsApp ──

export function formatResearchForWhatsApp(result: ResearchResult): string {
  const confidenceEmoji = { high: '✅', medium: '⚠️', low: '❓' }[result.confidence];
  const typeLabel: Record<ResearchType, string> = {
    person: 'Persona',
    company: 'Empresa',
    news: 'Noticias',
    fact_check: 'Verificación',
    market: 'Mercado',
    general: 'Investigación',
  };

  let msg = `${typeLabel[result.type]}: ${result.query} ${confidenceEmoji}\n\n`;
  msg += `${result.summary}\n\n`;

  if (result.key_findings.length > 0) {
    msg += result.key_findings.map(f => `• ${f}`).join('\n');
  }

  if (result.sources.length > 0) {
    msg += `\n\nFuentes: ${result.sources.slice(0, 2).join(', ')}`;
  }

  return msg;
}
