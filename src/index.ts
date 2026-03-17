import express from 'express';
import { config, validateConfig } from './config';
import { startProactiveCrons } from './proactive';
import { startPoller } from './poller';

validateConfig();

const app = express();
app.use(express.json());

// Health check
app.get('/', (_req, res) => {
  res.json({ status: 'ok', agent: config.agentName, uptime: process.uptime() });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Start server
app.listen(config.port, () => {
  console.log(`[${config.agentName}] Running on port ${config.port}`);
  startProactiveCrons();
  startPoller();
});
