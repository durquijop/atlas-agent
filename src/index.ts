import express from 'express';
import cron from 'node-cron';
import { config, validateConfig } from './config';
import { startProactiveCrons } from './proactive';
import { startPoller } from './poller';
import { processBlackboard } from './blackboard';
import { startMonitorCrons } from './agents/monitor';
import { startRealtimeListener } from './realtime';
import { startMemoryAgentCrons, triggerMemoryUpdate } from './agents/memory-agent';

validateConfig();

const AGENT_ROLE = process.env.AGENT_ROLE || 'orchestrator';

const app = express();
app.use(express.json());

// Health check
app.get('/', (_req, res) => {
  res.json({ 
    status: 'ok', 
    agent: config.agentName, 
    role: AGENT_ROLE,
    uptime: process.uptime() 
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', role: AGENT_ROLE });
});

// Start server
app.listen(config.port, () => {
  console.log(`[${config.agentName}] Running as ${AGENT_ROLE} on port ${config.port}`);

  if (AGENT_ROLE === 'monitor') {
    // Monitor Agent: only runs monitoring crons
    startMonitorCrons();
    console.log('[atlas] Monitor Agent started');

  } else {
    // Orchestrator (default): handles messages + reads blackboard
    startProactiveCrons();
    startPoller();

    // Context-driven proactivity: wake up when Monitor writes to blackboard
    startRealtimeListener();

    // Memory Agent: nightly consolidation + triggered after conversations
    startMemoryAgentCrons();

    // Fallback polling every 15min (catches any missed realtime events)
    cron.schedule('*/15 * * * *', () => {
      processBlackboard().catch(console.error);
    });

    // Process any pending events on startup
    setTimeout(() => {
      processBlackboard().catch(console.error);
    }, 10000);

    console.log('[atlas] Orchestrator started — context-driven (Realtime) + fallback polling (15min)');
  }
});
