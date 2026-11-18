import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';
import { ensureMailOwnerColumn, requireMailOwner } from '#lib/server/mail-owner';

let tagsColumnReady = false;
async function ensureTagsColumn(db: D1Database): Promise<void> {
	if (tagsColumnReady) return;
	try { await db.prepare("ALTER TABLE emails ADD COLUMN tags TEXT DEFAULT '[]'").run(); } catch { /* already exists */ }
	tagsColumnReady = true;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	const db = env.DB;
	if (!db) throw error(500, 'D1 database binding not available');
	const owner = requireMailOwner(locals.userEmail);
	await ensureMailOwnerColumn(db);
	await ensureTagsColumn(db);
	const threadId = url.searchParams.get('threadId') || url.searchParams.get('messageId');
	if (threadId) {
		const thread = await db.prepare(`
			WITH RECURSIVE thread(id, message_id, in_reply_to, references_header) AS (
				SELECT id, message_id, in_reply_to, references_header FROM emails
				WHERE owner_email = ? AND (id = ? OR message_id = ?)
				UNION
				SELECT e.id, e.message_id, e.in_reply_to, e.references_header FROM emails e JOIN thread t
				ON e.owner_email = ? AND (
					e.in_reply_to = t.message_id OR t.in_reply_to = e.message_id
					OR (t.message_id IS NOT NULL AND e.references_header LIKE '%' || t.message_id || '%')
					OR (e.message_id IS NOT NULL AND t.references_header LIKE '%' || e.message_id || '%')
				)
			)
			SELECT e.* FROM emails e JOIN thread t ON t.id = e.id
			WHERE e.owner_email = ?
			ORDER BY datetime(e.created_at) ASC, e.id ASC
		`).bind(owner, threadId, threadId, owner, owner).all<Record<string, unknown>>();
		const rows = thread.results ?? [];
		const ids = rows.map((row) => String(row.id));
		const attachmentRows = ids.length ? await db.prepare(`SELECT id, email_id, filename, content_type, size_bytes, r2_key FROM attachments WHERE email_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all() : { results: [] };
		const attachments = attachmentRows.results ?? [];
		return json({ emails: rows.map((row) => ({ ...row, attachments: attachments.filter((a: Record<string, unknown>) => a.email_id === row.id) })), unreadCount: 0, hasMore: false }, { headers: { 'Cache-Control': 'private, no-store' } });
	}
	const folder = url.searchParams.get('folder') || 'inbox';
	const virtualFolder = url.searchParams.get('virtualFolder') || '';
	const query = (url.searchParams.get('q') || url.searchParams.get('search') || '').trim();
	const tag = url.searchParams.get('tag');
	const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
	if (!['inbox', 'sent', 'trash'].includes(folder) && !virtualFolder) throw error(400, 'Invalid folder');
	const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '25', 10) || 25));
	const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
	let where = ' FROM emails WHERE owner_email = ?';
	const params: (string | number)[] = [owner];
	if (virtualFolder === 'all') where += " AND folder != 'trash'";
	else if (virtualFolder === 'attachments') where += ' AND EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = emails.id)';
	else if (virtualFolder.startsWith('alias:')) { where += ' AND lower(recipient_email) = lower(?)'; params.push(virtualFolder.slice(6)); }
	else { where += ' AND folder = ?'; params.push(folder); }
	if (query) { where += ' AND (subject LIKE ? OR sender_email LIKE ? OR sender_name LIKE ? OR recipient_email LIKE ? OR text_body LIKE ?)'; const like = '%' + query + '%'; params.push(like, like, like, like, like); }
	if (unreadOnly) where += ' AND is_read = 0';
	if (tag) { where += " AND EXISTS (SELECT 1 FROM json_each(COALESCE(emails.tags, '[]')) WHERE value = ?)"; params.push(tag); }
	const [page, total, unread] = await Promise.all([
		db.prepare('SELECT id, message_id, in_reply_to, references_header, folder, sender_name, sender_email, recipient_email, subject, substr(text_body, 1, 160) AS snippet, is_read, created_at, COALESCE(tags, \'[]\') AS tags, EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = emails.id) AS has_attachments' + where + ' ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?').bind(...params, limit, offset).all(),
		db.prepare('SELECT COUNT(*) AS count' + where).bind(...params).first<{ count: number }>(),
		db.prepare("SELECT COUNT(*) AS count FROM emails WHERE owner_email = ? AND folder = 'inbox' AND is_read = 0").bind(owner).first<{ count: number }>()
	]);
	const results = page.results ?? [];
	const totalCount = Number(total?.count ?? 0);
	return json({ emails: results, unreadCount: Number(unread?.count ?? 0), totalCount, hasMore: offset + results.length < totalCount }, { headers: { 'Cache-Control': 'private, no-store' } });
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
	const db = env.DB;
	if (!db) throw error(500, 'D1 database binding not available');
	const owner = requireMailOwner(locals.userEmail);
	await ensureMailOwnerColumn(db);
	await ensureTagsColumn(db);
	const body = await request.json<{ ids?: string[]; is_read?: number; folder?: string; tags?: string[] }>();
	const ids = [...new Set((body.ids ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0))];
	if (!ids.length) throw error(400, 'At least one email id is required');
	const updates: string[] = [];
	const values: (string | number)[] = [];
	if (typeof body.is_read === 'number') { updates.push('is_read = ?'); values.push(body.is_read ? 1 : 0); }
	if (body.folder && ['inbox', 'sent', 'trash'].includes(body.folder)) { updates.push('folder = ?'); values.push(body.folder); }
	if (body.tags !== undefined) {
		if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) throw error(400, 'tags must be an array of strings');
		updates.push('tags = ?'); values.push(JSON.stringify([...new Set(body.tags.map((tag) => tag.trim()).filter(Boolean))]));
	}
	if (!updates.length) throw error(400, 'No valid fields to update');
	const result = await db.prepare(`UPDATE emails SET ${updates.join(', ')} WHERE owner_email = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(...values, owner, ...ids).run();
	return json({ success: true, updated: result.meta.changes }, { headers: { 'Cache-Control': 'private, no-store' } });
};
