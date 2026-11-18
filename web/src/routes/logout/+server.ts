import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const microsoftLogout = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/logout');
	microsoftLogout.searchParams.set('post_logout_redirect_uri', url.origin);
	redirect(302, '/cdn-cgi/access/logout?returnTo=' + encodeURIComponent(microsoftLogout.toString()));
};
