// web/src/hooks.server.ts
import { error, type Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';

function decodeJwtPayload(jwt: string | null): Record<string, unknown> | null {
	if (!jwt) return null;
	try {
		const payloadPart = jwt.split('.')[1];
		if (!payloadPart) return null;
		const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
		const payload = JSON.parse(atob(base64));
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

		const userEmail = headerEmail || jwtEmail;

		if (!userEmail || !/^[^\s@]+@ggacrux\.ca$/i.test(userEmail)) {
			throw error(403, `Forbidden: Authorized @ggacrux.ca account required (received: ${userEmail || 'none'})`);
		}
		event.locals.userEmail = userEmail;
	}

	return resolve(event);
};
