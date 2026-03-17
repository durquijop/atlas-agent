import cron from 'node-cron';
import { config } from './config';
import { generateResponse, } from './llm';
import { sendText } from './whatsapp';

const OWNER = config.ownerNumbers[0];

async function sendProactive(prompt: string): Promise<void> {
  try {
    const response = await generateResponse([], prompt, true);
    await sendText(OWNER, response);
    console.log(`[proactive] Sent ${response.length} chars`);
  } catch (error) {
    console.error('[proactive] Error:', error);
  }
}

export function startProactiveCrons(): void {
  // Morning briefing: 8am ET (Mon-Fri)
  cron.schedule('0 12 * * 1-5', () => {
    sendProactive(
      'Es lunes a viernes por la mañana. Dale a Diego un briefing corto: qué debería priorizar hoy, recordatorios clave, y una pregunta de accountability sobre sus metas de la semana.'
    );
  }, { timezone: 'America/New_York' });

  // Evening reflection: 8pm ET (Mon-Fri)
  cron.schedule('0 0 * * 2-6', () => {
    sendProactive(
      'Es la noche. Haz una pregunta de reflexión a Diego sobre su día: qué logró, qué quedó pendiente, y un pensamiento estratégico para mañana.'
    );
  }, { timezone: 'America/New_York' });

  // Weekly strategy: Sunday 7pm ET
  cron.schedule('0 23 * * 0', () => {
    sendProactive(
      'Es domingo por la noche. Haz un mini-review semanal con Diego: ¿qué fue el mayor win de la semana? ¿Qué no salió como esperaba? ¿Cuál es la prioridad #1 para la próxima semana?'
    );
  }, { timezone: 'America/New_York' });

  console.log('[proactive] Crons scheduled: morning briefing (8am), evening reflection (8pm), weekly strategy (Sun 7pm)');
}
