import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';
import { ensureMailOwnerColumn, requireMailOwner } from '#lib/server/mail-owner';

export const GET: RequestHandler = async ({ locals }) => {
	const db = env.DB;
	if (!db) throw error(500, 'D1 database binding not available');
	const owner = requireMailOwner(locals.userEmail);
	await ensureMailOwnerColumn(db);
	const usage = await db.prepare(`
		SELECT
			(SELECT COALESCE(SUM(LENGTH(COALESCE(text_body,'')) + LENGTH(COALESCE(html_body,'')) + LENGTH(COALESCE(subject,''))), 0) FROM emails WHERE owner_email = ?) AS used_bytes,
			(SELECT COUNT(*) FROM emails WHERE owner_email = ?) AS email_count,
			(SELECT COALESCE(SUM(a.size_bytes), 0) FROM attachments a JOIN emails e ON e.id = a.email_id WHERE e.owner_email = ?) AS attachment_bytes,
			(SELECT COUNT(*) FROM attachments a JOIN emails e ON e.id = a.email_id WHERE e.owner_email = ?) AS attachment_count
	`).bind(owner, owner, owner, owner).first<{ used_bytes: number; email_count: number; attachment_bytes: number; attachment_count: number }>();
	return json({
		d1: { usedBytes: Number(usage?.used_bytes ?? 0), limitBytes: 524288000, emailCount: Number(usage?.email_count ?? 0) },
		r2: { usedBytes: Number(usage?.attachment_bytes ?? 0), limitBytes: 10737418240, fileCount: Number(usage?.attachment_count ?? 0) }
	}, { headers: { 'Cache-Control': 'private, no-store' } });
};
