// web/src/routes/api/emails/+server.ts
import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const db = env.DB;
	if (!db) throw error(500, 'D1 database binding not available');

	const folder = url.searchParams.get('folder') || 'inbox';
	const query = (url.searchParams.get('q') || '').trim();

	if (!['inbox', 'sent', 'trash'].includes(folder)) {
		throw error(400, 'Invalid folder');
	}

	let sql = `
		SELECT id, message_id, in_reply_to, references_header, folder,
		       sender_name, sender_email, recipient_email, subject,
		       substr(text_body, 1, 160) AS snippet, is_read, created_at
		FROM emails
		WHERE folder = ?
	`;
	const params: unknown[] = [folder];

	if (query) {
		sql += ` AND (subject LIKE ? OR sender_email LIKE ? OR sender_name LIKE ? OR recipient_email LIKE ? OR text_body LIKE ?)`;
		const like = `%${query}%`;
		params.push(like, like, like, like, like);
	}

	sql += ` ORDER BY datetime(created_at) DESC LIMIT 100`;

	const { results: emails } = await db.prepare(sql).bind(...params).all();

	// Also fetch unread inbox count for the sidebar badge
	const unreadRow = await db
		.prepare(`SELECT COUNT(*) AS count FROM emails WHERE folder = 'inbox' AND is_read = 0`)
		.first<{ count: number }>();

	return json({
		emails: emails ?? [],
		unreadCount: unreadRow?.count ?? 0
	});
};
