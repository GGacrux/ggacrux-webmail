// web/src/hooks.server.ts
import { error, type Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';

function decodeJwtPayload(jwt: string | null): Record<string, unknown> | null {
	if (!jwt) return null;
	try {
		const payloadPart = jwt.split('.')[1];
		if (!payloadPart) return null;
		const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
		const payload = JSON.parse(atob(base64)) as Record<string, unknown>;
		const now = Math.floor(Date.now() / 1000);
		if (typeof payload.exp === 'number' && payload.exp <= now) return null;
		if (typeof payload.nbf === 'number' && payload.nbf > now) return null;
		return payload;
	} catch {
		return null;
	}
}

function extractEmailFromJwt(jwt: string | null): string | null {
	const payload = decodeJwtPayload(jwt);
	const value = payload?.email || payload?.upn || payload?.preferred_username;
	return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function extractCookieJwt(cookie: string): string | null {
	const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('CF_Authorization='));
	return match ? decodeURIComponent(match.slice('CF_Authorization='.length)) : null;
}

export const handle: Handle = async ({ event, resolve }) => {
	if (dev) {
		event.locals.userEmail = 'developer@ggacrux.ca';
	} else {
		const headerEmail = event.request.headers
			.get('Cf-Access-Authenticated-User-Email')
			?.trim()
			.toLowerCase();

		const assertion = event.request.headers.get('Cf-Access-Jwt-Assertion');
		const cookieJwt = extractCookieJwt(event.request.headers.get('cookie') || '');
		const jwtEmail = extractEmailFromJwt(assertion) || extractEmailFromJwt(cookieJwt);

		// Require the Access JWT identity; a forwarded email header alone is not auth.
		const userEmail = jwtEmail;
		if (!userEmail || (headerEmail && headerEmail !== userEmail) || !/^[^\s@]+@ggacrux\.ca$/i.test(userEmail)) {
			throw error(403, 'Forbidden: a valid Cloudflare Access identity for an @ggacrux.ca account is required');
		}
		event.locals.userEmail = userEmail;
	}

	return resolve(event);
};
