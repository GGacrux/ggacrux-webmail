import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';
import { ensureMailOwnerColumn, requireMailOwner } from '#lib/server/mail-owner';

export const GET: RequestHandler = async ({ params, locals }) => {
	const db = env.DB;
	const bucket = env.ggacrux_attachments;
	if (!db) throw error(500, 'D1 database binding not available');
	if (!bucket) throw error(503, 'R2 attachment storage is not enabled');
	const owner = requireMailOwner(locals.userEmail);
	await ensureMailOwnerColumn(db);
	const attachment = await db.prepare('SELECT a.filename, a.content_type, a.r2_key FROM attachments a JOIN emails e ON e.id = a.email_id WHERE a.id = ? AND LOWER(e.owner_email) = ?').bind(params.id, owner).first<{ filename: string; content_type: string; r2_key: string | null }>();
	if (!attachment?.r2_key) throw error(404, 'Attachment not found');
	const object = await bucket.get(attachment.r2_key);
	if (!object) throw error(404, 'Attachment file missing from R2 storage');
	const headers = new Headers();
	headers.set('Content-Type', attachment.content_type || 'application/octet-stream');
	headers.set('Content-Disposition', `attachment; filename="${attachment.filename.replace(/["\\r\\n]/g, '')}"`);
	headers.set('Cache-Control', 'private, no-store');
	headers.set('X-Content-Type-Options', 'nosniff');
	return new Response(object.body, { headers });
};
