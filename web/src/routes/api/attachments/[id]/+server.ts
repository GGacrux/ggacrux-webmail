// web/src/routes/api/attachments/[id]/+server.ts
import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const db = env.DB;
	const bucket = env.ggacrux_attachments;

	if (!db) throw error(500, 'D1 database binding not available');
	if (!bucket) throw error(503, 'R2 attachment storage is not enabled');

	const attachment = await db
		.prepare(`SELECT filename, content_type, r2_key FROM attachments WHERE id = ?`)
		.bind(params.id)
		.first<{ filename: string; content_type: string; r2_key: string | null }>();

	if (!attachment || !attachment.r2_key) {
		throw error(404, 'Attachment not found');
	}

	const object = await bucket.get(attachment.r2_key);
	if (!object) {
		throw error(404, 'Attachment file missing from R2 storage');
	}

	const headers = new Headers();
	headers.set('Content-Type', attachment.content_type || 'application/octet-stream');
	headers.set(
		'Content-Disposition',
		`attachment; filename="${attachment.filename.replace(/"/g, '')}"`
	);
	headers.set('Cache-Control', 'private, max-age=3600');

	return new Response(object.body, { headers });
};
