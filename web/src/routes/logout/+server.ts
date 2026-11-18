import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from 'cloudflare:workers';

export const GET: RequestHandler = async () => {
	const config = env as unknown as { ACCESS_TEAM_DOMAIN?: string };
	const teamDomain = (config.ACCESS_TEAM_DOMAIN || 'inbox-ggacrux-team.cloudflareaccess.com')
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/+$/, '')
		.toLowerCase();
	if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(teamDomain)) {
		throw error(500, 'ACCESS_TEAM_DOMAIN must be a valid hostname');
	}

	const teamLogout = `https://${teamDomain}/cdn-cgi/access/logout`;
	const msLogout = 'https://login.microsoftonline.com/common/oauth2/v2.0/logout';
	const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signing out</title></head>
<body>
<p>Signing out...</p>
<iframe id="cf-team-logout" src="${teamLogout}" style="display:none" title="Cloudflare logout" aria-hidden="true"></iframe>
<script>
	try { localStorage.clear(); } catch {}
	try { sessionStorage.clear(); } catch {}
	let redirected = false;
	const finishLogout = () => {
		if (redirected) return;
		redirected = true;
		window.location.replace(${JSON.stringify(msLogout)});
	};
	const teamLogoutFrame = document.getElementById('cf-team-logout');
	if (teamLogoutFrame) teamLogoutFrame.addEventListener('load', finishLogout, { once: true });
	window.setTimeout(finishLogout, 900);
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
