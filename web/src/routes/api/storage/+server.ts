import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const db = env.DB;
	const bucket = env.ggacrux_attachments;
	if (!db) throw error(500, 'D1 database binding not available');
	if (!bucket) throw error(503, 'R2 attachment storage is not enabled');

	let usedBytes = 0;
	try {
		const usage = await db.prepare('SELECT (page_count * page_size) AS size_bytes FROM pragma_page_count(), pragma_page_size()').first<{ size_bytes: number }>();
		usedBytes = Number(usage?.size_bytes ?? 0);
	} catch {
		const usage = await db.prepare("SELECT COALESCE(SUM(LENGTH(COALESCE(text_body,'')) + LENGTH(COALESCE(html_body,'')) + LENGTH(COALESCE(subject,''))), 0) AS size_bytes FROM emails").first<{ size_bytes: number }>();
		usedBytes = Number(usage?.size_bytes ?? 0);
	}
	const count = await db.prepare('SELECT COUNT(*) AS count FROM emails').first<{ count: number }>();
	let r2Bytes = 0;
	let fileCount = 0;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ ...(cursor ? { cursor } : {}) });
		for (const object of page.objects) {
			r2Bytes += object.size;
			fileCount += 1;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return json({
		d1: { usedBytes, limitBytes: 524288000, emailCount: Number(count?.count ?? 0) },
		r2: { usedBytes: r2Bytes, limitBytes: 10737418240, fileCount }
	});
};
