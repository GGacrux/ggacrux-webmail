import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

interface SendPayload {
	fromName?: string;
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	text?: string;
	html?: string;
	inReplyTo?: string | null;
	references?: string | null;
}

interface UploadFile { file: File; filename: string; contentType: string; size: number; }

const MAX_ATTACHMENTS = 10 * 1024 * 1024;
const recipients = (value: string | string[] | undefined): string[] =>
	(value ? (Array.isArray(value) ? value : value.split(',')) : [])
		.map((address) => address.trim()).filter(Boolean);

function sanitizeHtml(input: string): string {
	return input
		.replace(/<(script|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<(script|iframe|object|embed)\b[^>]*\/?>/gi, '')
		.replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
		.replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function htmlToText(html: string): string {
	return html.replace(/<br\s*\/?\s*>/gi, '\n')
		.replace(/<\/(p|div)\s*>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
		.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const POST: RequestHandler = async ({ request, locals }) => {
	const db = env.DB;
	const bucket = env.ggacrux_attachments;
	const apiKey = env.RESEND_API_KEY;
	if (!db) throw error(500, 'D1 database binding not available');
	if (!apiKey) throw error(500, 'RESEND_API_KEY is not configured');

	const authenticated = (locals.userEmail || request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
	const senderEmail = authenticated || (import.meta.env.DEV ? 'canopus@ggacrux.ca' : '');
	if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) throw error(401, 'An authenticated sender address is required');

	let payload: SendPayload;
	const uploads: UploadFile[] = [];
	if (request.headers.get('content-type')?.includes('multipart/form-data')) {
		const form = await request.formData();
		const parseField = (key: string): string => String(form.get(key) ?? '');
		payload = {
			fromName: parseField('fromName'), to: parseField('to'), cc: parseField('cc'), bcc: parseField('bcc'),
			subject: parseField('subject'), text: parseField('text'), html: parseField('html'),
			inReplyTo: parseField('inReplyTo') || null, references: parseField('references') || null
		};
		for (const entry of form.getAll('attachments')) {
			if (entry instanceof File && entry.size > 0) uploads.push({ file: entry, filename: entry.name, contentType: entry.type || 'application/octet-stream', size: entry.size });
		}
	} else {
		payload = await request.json<SendPayload>();
	}
	const to = recipients(payload.to);
	const cc = recipients(payload.cc);
	const bcc = recipients(payload.bcc);
	if (!to.length || !payload.subject?.trim()) throw error(400, 'Recipient (to) and subject are required');
	if (uploads.reduce((sum, item) => sum + item.size, 0) > MAX_ATTACHMENTS) throw error(413, 'Total attachments cannot exceed 10 MB');
	if (uploads.length && !bucket) throw error(503, 'R2 attachment storage is not enabled');

	const senderName = (payload.fromName || senderEmail.split('@')[0]).trim().replace(/[\r\n<>]/g, '').slice(0, 100);
	const htmlBody = payload.html ? sanitizeHtml(payload.html) : `<div style="font-family:sans-serif;line-height:1.5;white-space:pre-wrap">${(payload.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
	const textBody = payload.text?.trim() ? payload.text : htmlToText(htmlBody);
	const headers: Record<string, string> = {};
	let updatedReferences: string | null = null;
	if (payload.inReplyTo) {
		headers['In-Reply-To'] = payload.inReplyTo;
		updatedReferences = payload.references ? `${payload.references} ${payload.inReplyTo}`.trim() : payload.inReplyTo;
		headers.References = updatedReferences;
	}

	const emailId = crypto.randomUUID();
	const uploaded: { id: string; filename: string; contentType: string; size: number; r2Key: string; content: string }[] = [];
	try {
		for (const item of uploads) {
			const id = crypto.randomUUID();
			const r2Key = `emails/${emailId}/${id}`;
			const bytes = await item.file.arrayBuffer();
			await bucket!.put(r2Key, bytes, { httpMetadata: { contentType: item.contentType } });
			let binary = '';
			const data = new Uint8Array(bytes);
			for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
			uploaded.push({ id, filename: item.filename, contentType: item.contentType, size: item.size, r2Key, content: btoa(binary) });
		}

		const resendRes = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				from: `${senderName} <${senderEmail}>`, to, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined,
				subject: payload.subject.trim(), text: textBody, html: htmlBody,
				headers: Object.keys(headers).length ? headers : undefined,
				attachments: uploaded.length ? uploaded.map(({ filename, content }) => ({ filename, content })) : undefined
			})
		});
		const resendData = await resendRes.json<{ id?: string; message?: string }>();
		if (!resendRes.ok) throw error(resendRes.status, resendData.message || 'Failed to send email via Resend');
		const messageId = resendData.id ? `<${resendData.id}@resend.dev>` : `<${emailId}@ggacrux.ca>`;
		await db.prepare(`INSERT INTO emails (id, message_id, in_reply_to, references_header, folder, sender_name, sender_email, recipient_email, subject, text_body, html_body, is_read) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, 1)`)
			.bind(emailId, messageId, payload.inReplyTo || null, updatedReferences, senderName, senderEmail, to.join(', '), payload.subject.trim(), textBody, htmlBody).run();
		for (const item of uploaded) {
			await db.prepare('INSERT INTO attachments (id, email_id, filename, content_type, size_bytes, r2_key) VALUES (?, ?, ?, ?, ?, ?)')
				.bind(item.id, emailId, item.filename, item.contentType, item.size, item.r2Key).run();
		}
		return json({ success: true, id: emailId, resendId: resendData.id });
	} catch (cause) {
		if (uploaded.length && bucket) await bucket.delete(uploaded.map((item) => item.r2Key)).catch(() => undefined);
		throw cause;
	}
};
