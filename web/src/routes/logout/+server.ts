import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const cfAccessLogoutUrl = `${url.origin}/cdn-cgi/access/logout`;
	const msLogoutUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(cfAccessLogoutUrl)}`;

	return new Response(null, {
		status: 302,
		headers: {
			'Cache-Control': 'private, no-store',
			'Set-Cookie': 'CF_Authorization=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
			Location: msLogoutUrl
		}
	});
};
