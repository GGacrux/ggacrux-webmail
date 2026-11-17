// web/src/routes/api/emails/[id]/+server.ts
import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const db = env.DB;
	if (!db) throw error(500, 'D1 database binding not available');

	const email = await db
		.prepare(`SELECT * FROM emails WHERE id = ?`)
		.bind(params.id)
		.first();

	if (!email) throw error(404, 'Email not found');

	const { results: attachments } = await db
		.prepare(`SELECT id, filename, content_type, size_bytes, r2_key FROM attachments WHERE email_id = ?`)
		.bind(params.id)
		.all();

	return json({
		email,
		attachments: attachments ?? []
	});
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	const db = env.DB;
	if (!db) throw error(500, 'D1 database binding not available');

	const body = await request.json<{ is_read?: number; folder?: string }>();
	const updates: string[] = [];
	const values: unknown[] = [];

	if (typeof body.is_read === 'number') {
		updates.push('is_read = ?');
		values.push(body.is_read ? 1 : 0);
	}

	if (body.folder && ['inbox', 'sent', 'trash'].includes(body.folder)) {
		updates.push('folder = ?');
		values.push(body.folder);
	}

	if (updates.length === 0) {
		throw error(400, 'No valid fields to update');
	}

	values.push(params.id);
	await db
		.prepare(`UPDATE emails SET ${updates.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();

	return json({ success: true });
};

export const DELETE: RequestHandler = async ({ params }) => {
	const db = env.DB;
	const bucket = env.ggacrux_attachments;
	if (!db) throw error(500, 'D1 database binding not available');

	// 1. Delete any binary attachments from R2 first so no orphaned objects remain
	if (bucket) {
		const { results: attachments } = await db
			.prepare(`SELECT r2_key FROM attachments WHERE email_id = ? AND r2_key IS NOT NULL`)
			.bind(params.id)
			.all<{ r2_key: string }>();

		if (attachments && attachments.length > 0) {
			const keys = attachments.map((a) => a.r2_key);
			await bucket.delete(keys);
		}
	}

	// 2. Delete attachment records & email record from D1
	await db.prepare(`DELETE FROM attachments WHERE email_id = ?`).bind(params.id).run();
	await db.prepare(`DELETE FROM emails WHERE id = ?`).bind(params.id).run();

	return json({ success: true });
};
