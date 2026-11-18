// web/src/hooks.server.ts
import { error, type Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from 'cloudflare:workers';

type AccessJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
let cachedKeys: { expiresAt: number; keys: AccessJwk[] } | null = null;

function decodeBase64Url(value: string): Uint8Array {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
	return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function decodeJsonPart<T>(value: string): T {
	return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function getCookieJwt(cookie: string): string | null {
	const entry = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('CF_Authorization='));
	if (!entry) return null;
	try { return decodeURIComponent(entry.slice('CF_Authorization='.length)); } catch { return null; }
}

async function getAccessKeys(issuer: string): Promise<AccessJwk[]> {
	if (cachedKeys && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
	const response = await fetch(issuer + '/cdn-cgi/access/certs', { headers: { Accept: 'application/json' } });
	if (!response.ok) throw error(503, 'Unable to verify Cloudflare Access signing keys');
	const payload = await response.json() as { keys?: AccessJwk[] };
	if (!Array.isArray(payload.keys) || payload.keys.length === 0) throw error(503, 'Cloudflare Access signing keys are unavailable');
	cachedKeys = { keys: payload.keys, expiresAt: Date.now() + 5 * 60 * 1000 };
	return payload.keys;
}

async function verifyAccessIdentity(token: string): Promise<string> {
	const config = env as unknown as { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };
	const teamDomain = (config.ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
	const audience = (config.ACCESS_AUD || '').trim();
	if (!teamDomain || !audience) throw error(503, 'Cloudflare Access verification is not configured (ACCESS_TEAM_DOMAIN and ACCESS_AUD are required)');

	const parts = token.split('.');
	if (parts.length !== 3) throw error(403, 'Invalid Cloudflare Access token');
	let header: { alg?: string; kid?: string };
	let claims: { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string; upn?: string; preferred_username?: string };
	try {
		header = decodeJsonPart(parts[0]);
		claims = decodeJsonPart(parts[1]);
	} catch { throw error(403, 'Invalid Cloudflare Access token'); }

	const issuer = 'https://' + teamDomain;
	const now = Math.floor(Date.now() / 1000);
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (header.alg !== 'RS256' || !header.kid || claims.iss !== issuer || !audiences.includes(audience) ||
		typeof claims.exp !== 'number' || claims.exp <= now || (typeof claims.nbf === 'number' && claims.nbf > now)) {
		throw error(403, 'Cloudflare Access token claims are invalid');
	}

	const jwk = (await getAccessKeys(issuer)).find((key) => key.kid === header.kid && (!key.use || key.use === 'sig'));
	if (!jwk) throw error(403, 'Cloudflare Access signing key was not found');
	let valid = false;
	try {
		const publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
		valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, decodeBase64Url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
	} catch { valid = false; }
	if (!valid) throw error(403, 'Cloudflare Access token signature is invalid');

	const email = claims.email || claims.upn || claims.preferred_username;
	if (typeof email !== 'string' || !/^[^\s@]+@ggacrux\.ca$/i.test(email.trim())) {
		throw error(403, 'An authorized @ggacrux.ca identity is required');
	}
	return email.trim().toLowerCase();
}

export const handle: Handle = async ({ event, resolve }) => {
	const isLogoutRequest = event.url.pathname === '/logout' && event.request.method === 'GET';
	if (dev) {
		event.locals.userEmail = 'developer@ggacrux.ca';
	} else if (isLogoutRequest) {
		// The logout response must be reachable after the client expires CF_Authorization.
		event.locals.userEmail = undefined;
	} else {
		const token = event.request.headers.get('Cf-Access-Jwt-Assertion') || getCookieJwt(event.request.headers.get('cookie') || '');
		if (!token) throw error(403, 'Cloudflare Access authentication is required');
		const userEmail = await verifyAccessIdentity(token);
		const headerEmail = event.request.headers.get('Cf-Access-Authenticated-User-Email')?.trim().toLowerCase();
		if (headerEmail && headerEmail !== userEmail) throw error(403, 'Cloudflare Access identity headers do not match');
		event.locals.userEmail = userEmail;
	}
	return resolve(event);
};
