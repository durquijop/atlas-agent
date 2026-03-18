/**
 * Atlas Multi-Agent — Entry Point
 * 
 * Variable AGENT_ROLE controla qué agente corre:
 * - 'orchestrator' (default) → Orchestrator + Poller + Proactive crons
 * - 'monitor' → Monitor Agent solamente
 * 
 * En Railway: crear 2 servicios del mismo repo con AGENT_ROLE diferente.
 */

import express from 'express';
import { config, validateConfig } from './config';

validateConfig();

const ROLE = process.env.AGENT_ROLE || 'orchestrator';
const app = express();
app.use(express.json());

// Health check (ambos roles)
app.get('/', (_req, res) => {
  res.json({ status: 'ok', agent: config.agentName, role: ROLE, uptime: process.uptime() });
});
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', role: ROLE });
});

app.listen(config.port, async () => {
  console.log(`[atlas] Role: ${ROLE} | Port: ${config.port}`);

  if (ROLE === 'monitor') {
    // Monitor Agent: solo vigila y escribe al blackboard
    const { startMonitor } = await import('./agents/monitor');
    startMonitor();
    console.log('[atlas] Monitor Agent started');

  } else {
    // Orchestrator: responde mensajes + lee blackboard + crons proactivos
    const { startProactiveCrons } = await import('./proactive');
    const { startPoller } = await import('./poller');

    startProactiveCrons();
    startPoller();
    console.log('[atlas] Orchestrator started');
  }
});
