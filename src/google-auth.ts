/**
 * Google Auth — Atlas Monitor Agent
 * 
 * Usa refresh tokens de OAuth (extraídos de gog) para obtener
 * access tokens frescos sin depender del Mac ni de un Service Account.
 * 
 * Variable de entorno Railway: GOOGLE_OAUTH_TOKENS (JSON string)
 * Formato: { client_id, client_secret, tokens: { email: refresh_token } }
 */

interface OAuthConfig {
  client_id: string;
  client_secret: string;
  tokens: Record<string, string>; // email → refresh_token
}

interface AccessTokenCache {
  token: string;
  expiresAt: number;
}

const tokenCache: Record<string, AccessTokenCache> = {};

function getOAuthConfig(): OAuthConfig | null {
  const raw = process.env.GOOGLE_OAUTH_TOKENS;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.error('[google-auth] Invalid GOOGLE_OAUTH_TOKENS JSON');
    return null;
  }
}

export async function getGoogleAccessToken(email: string): Promise<string | null> {
  // Check cache first
  const cached = tokenCache[email];
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const config = getOAuthConfig();
  if (!config) {
    console.error('[google-auth] No GOOGLE_OAUTH_TOKENS configured');
    return null;
  }

  const refreshToken = config.tokens[email];
  if (!refreshToken) {
    console.error(`[google-auth] No refresh token for ${email}`);
    return null;
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.client_id,
        client_secret: config.client_secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[google-auth] Token refresh failed for ${email}: ${err}`);
      return null;
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    
    // Cache the token
    tokenCache[email] = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };

    console.log(`[google-auth] Token refreshed for ${email}`);
    return data.access_token;

  } catch (e) {
    console.error(`[google-auth] Error refreshing token for ${email}:`, e);
    return null;
  }
}
