import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';
import { ensureMailOwnerColumn, requireMailOwner } from '$lib/server/mail-owner';

export const GET: RequestHandler = async ({ locals }) => {
	const db = env.DB;
	if (!db) throw error(500, 'D1 database binding not available');
	const owner = requireMailOwner(locals.userEmail);
	await ensureMailOwnerColumn(db);
	const usage = await db.prepare(`
		SELECT
			COALESCE(SUM(DISTINCT LENGTH(COALESCE(e.text_body,'')) + LENGTH(COALESCE(e.html_body,'')) + LENGTH(COALESCE(e.subject,''))), 0) AS used_bytes,
			COUNT(DISTINCT e.id) AS email_count,
			COALESCE(SUM(a.size_bytes), 0) AS attachment_bytes,
			COUNT(a.id) AS attachment_count
		FROM emails e LEFT JOIN attachments a ON a.email_id = e.id
		WHERE e.owner_email = ?
	`).bind(owner).first<{ used_bytes: number; email_count: number; attachment_bytes: number; attachment_count: number }>();
	return json({
		d1: { usedBytes: Number(usage?.used_bytes ?? 0), limitBytes: 524288000, emailCount: Number(usage?.email_count ?? 0) },
		r2: { usedBytes: Number(usage?.attachment_bytes ?? 0), limitBytes: 10737418240, fileCount: Number(usage?.attachment_count ?? 0) }
	}, { headers: { 'Cache-Control': 'private, no-store' } });
};
