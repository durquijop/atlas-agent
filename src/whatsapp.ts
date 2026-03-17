import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { config } from './config';

let client: WhatsAppClient;

export function getWhatsApp(): WhatsAppClient {
  if (!client) {
    client = new WhatsAppClient({
      baseUrl: 'https://app.kapso.ai/api/meta/',
      kapsoApiKey: config.kapsoApiKey,
    });
  }
  return client;
}

export async function sendText(to: string, body: string): Promise<void> {
  const wa = getWhatsApp();
  const chunks = splitMessage(body, 4000);
  for (const chunk of chunks) {
    await wa.messages.sendText({
      phoneNumberId: config.phoneNumberId,
      to,
      body: chunk,
    });
  }
}

export async function markAsRead(messageId: string): Promise<void> {
  const wa = getWhatsApp();
  await wa.messages.markRead({
    phoneNumberId: config.phoneNumberId,
    messageId,
    typingIndicator: { type: 'text' },
  });
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
