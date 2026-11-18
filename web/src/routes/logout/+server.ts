import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const msLogoutUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(url.origin)}`;
	const headers = new Headers({
		'Cache-Control': 'private, no-store',
		Location: msLogoutUrl
	});
	const expiredCookie = 'CF_Authorization=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:01 GMT; HttpOnly; Secure; SameSite=Lax';

	headers.append('Set-Cookie', expiredCookie);
	headers.append('Set-Cookie', `${expiredCookie}; Domain=.ggacrux.ca`);

	return new Response(null, {
		status: 302,
		headers
	});
};
