// web/src/hooks.server.ts
import { error, type Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';

function extractEmailFromJwt(jwt: string | null): string | null {
	if (!jwt) return null;
	try {
		const payloadPart = jwt.split('.')[1];
		if (!payloadPart) return null;
		const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
		const payload = JSON.parse(atob(base64));
		return (payload.email || payload.upn || payload.preferred_username || null)?.toLowerCase() ?? null;
	} catch {
		return null;
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	if (!dev) {
		const headerEmail = event.request.headers
			.get('Cf-Access-Authenticated-User-Email')
			?.trim()
			.toLowerCase();

		const jwtEmail = extractEmailFromJwt(
			event.request.headers.get('Cf-Access-Jwt-Assertion')
		);

		const userEmail = headerEmail || jwtEmail;

		if (!userEmail || !userEmail.endsWith('@ggacrux.ca')) {
			throw error(403, `Forbidden: Authorized @ggacrux.ca account required (received: ${userEmail || 'none'})`);
		}
	}

	return resolve(event);
};
