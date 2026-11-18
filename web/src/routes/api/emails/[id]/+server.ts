import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';
import { ensureMailOwnerColumn, requireMailOwner } from '#lib/server/mail-owner';

export const GET: RequestHandler = async ({ params, locals }) => {
	const db = env.DB;
	if (!db) throw error(500, 'D1 database binding not available');
	const owner = requireMailOwner(locals.userEmail);
	await ensureMailOwnerColumn(db);
	const email = await db.prepare('SELECT * FROM emails WHERE id = ? AND LOWER(owner_email) = ?').bind(params.id, owner).first();
	if (!email) throw error(404, 'Email not found');
	const { results: attachments } = await db.prepare('SELECT a.id, a.filename, a.content_type, a.size_bytes, a.r2_key FROM attachments a JOIN emails e ON e.id = a.email_id WHERE a.email_id = ? AND e.LOWER(owner_email) = ?').bind(params.id, owner).all();
	return json({ email, attachments: attachments ?? [] }, { headers: { 'Cache-Control': 'private, no-store' } });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const db = env.DB;
	if (!db) throw error(500, 'D1 database binding not available');
	const owner = requireMailOwner(locals.userEmail);
	await ensureMailOwnerColumn(db);
	const body = await request.json<{ is_read?: number; folder?: string }>();
	const updates: string[] = [];
	const values: (string | number)[] = [];
	if (typeof body.is_read === 'number') { updates.push('is_read = ?'); values.push(body.is_read ? 1 : 0); }
	if (body.folder && ['inbox', 'sent', 'trash'].includes(body.folder)) { updates.push('folder = ?'); values.push(body.folder); }
	if (!updates.length) throw error(400, 'No valid fields to update');
	const result = await db.prepare(`UPDATE emails SET ${updates.join(', ')} WHERE id = ? AND LOWER(owner_email) = ?`).bind(...values, params.id, owner).run();
	if (!result.meta.changes) throw error(404, 'Email not found');
	return json({ success: true }, { headers: { 'Cache-Control': 'private, no-store' } });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const db = env.DB;
	const bucket = env.ggacrux_attachments;
	if (!db) throw error(500, 'D1 database binding not available');
	const owner = requireMailOwner(locals.userEmail);
	await ensureMailOwnerColumn(db);
	const email = await db.prepare('SELECT id FROM emails WHERE id = ? AND LOWER(owner_email) = ?').bind(params.id, owner).first();
	if (!email) throw error(404, 'Email not found');
	if (bucket) {
		const { results: attachments } = await db.prepare('SELECT a.r2_key FROM attachments a JOIN emails e ON e.id = a.email_id WHERE e.id = ? AND LOWER(e.owner_email) = ? AND a.r2_key IS NOT NULL').bind(params.id, owner).all<{ r2_key: string }>();
		if (attachments?.length) await bucket.delete(attachments.map((attachment) => attachment.r2_key));
	}
	await db.prepare('DELETE FROM attachments WHERE email_id = ? AND EXISTS (SELECT 1 FROM emails e WHERE e.id = attachments.email_id AND LOWER(e.owner_email) = ?)').bind(params.id, owner).run();
	await db.prepare('DELETE FROM emails WHERE id = ? AND LOWER(owner_email) = ?').bind(params.id, owner).run();
	return json({ success: true }, { headers: { 'Cache-Control': 'private, no-store' } });
};
