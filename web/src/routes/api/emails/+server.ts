// web/src/routes/api/emails/+server.ts
import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const db = env.DB;
	if (!db) throw error(500, 'D1 database binding not available');
	const folder = url.searchParams.get('folder') || 'inbox';
	const query = (url.searchParams.get('q') || '').trim();
	if (!['inbox', 'sent', 'trash'].includes(folder)) throw error(400, 'Invalid folder');
	const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '25', 10) || 25));
	const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
	let where = ' FROM emails WHERE folder = ?';
	const params: (string | number)[] = [folder];
	if (query) {
		where += ' AND (subject LIKE ? OR sender_email LIKE ? OR sender_name LIKE ? OR recipient_email LIKE ? OR text_body LIKE ?)';
		const like = '%' + query + '%';
		params.push(like, like, like, like, like);
	}
	const [page, total, unread] = await Promise.all([
		db.prepare('SELECT id, message_id, in_reply_to, references_header, folder, sender_name, sender_email, recipient_email, subject, substr(text_body, 1, 160) AS snippet, is_read, created_at' + where + ' ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?').bind(...params, limit, offset).all(),
		db.prepare('SELECT COUNT(*) AS count' + where).bind(...params).first<{ count: number }>(),
		db.prepare("SELECT COUNT(*) AS count FROM emails WHERE folder = 'inbox' AND is_read = 0").first<{ count: number }>()
	]);
	const emails = page.results ?? [];
	const totalCount = total?.count ?? 0;
	return json({ emails, unreadCount: unread?.count ?? 0, totalCount, hasMore: offset + emails.length < totalCount });
};
