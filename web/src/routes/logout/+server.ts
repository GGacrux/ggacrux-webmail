import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const cfAccessLogout = `${url.origin}/cdn-cgi/access/logout`;
	const msLogout = `https://login.microsoftonline.com/common/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(cfAccessLogout)}`;
	const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Signing out</title></head>
<body>
<script>
	try { localStorage.clear(); } catch {}
	try { sessionStorage.clear(); } catch {}
	window.location.replace(${JSON.stringify(msLogout)});
</script>
</body>
</html>`;
	const headers = new Headers({
		'Content-Type': 'text/html; charset=utf-8',
		'Clear-Site-Data': '"cookies", "storage", "cache"',
		'Cache-Control': 'no-store, no-cache, must-revalidate'
	});

	headers.append('Set-Cookie', 'CF_Authorization=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=None');
	headers.append('Set-Cookie', 'CF_AppSession=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure');

	return new Response(body, {
		status: 200,
		headers
	});
};
