// web/src/routes/api/emails/send/+server.ts
import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

interface SendPayload {
	fromAlias?: string;
	fromName?: string;
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	text: string;
	html?: string;
	inReplyTo?: string | null;
	references?: string | null;
}

const recipients = (value: string | string[] | undefined): string[] =>
	(value ? (Array.isArray(value) ? value : value.split(',')) : [])
		.map((address) => address.trim()).filter(Boolean);

export const POST: RequestHandler = async ({ request, locals }) => {
	const db = env.DB;
	const apiKey = env.RESEND_API_KEY;
	if (!db) throw error(500, 'D1 database binding not available');
	if (!apiKey) throw error(500, 'RESEND_API_KEY is not configured');
	const payload = await request.json<SendPayload>();
	const to = recipients(payload.to);
	const cc = recipients(payload.cc);
	const bcc = recipients(payload.bcc);
	if (!to.length || !payload.subject?.trim()) throw error(400, 'Recipient (to) and subject are required');
	const senderEmail = (payload.fromAlias || locals.userEmail || '').trim().toLowerCase();
	if (!/^[^\s@]+@ggacrux\.ca$/.test(senderEmail)) throw error(400, 'Choose a valid @ggacrux.ca sender alias');
	const senderName = (payload.fromName || senderEmail.split('@')[0]).trim().replace(/[\r\n<>]/g, '').slice(0, 100);
	const headers: Record<string, string> = {};
	let updatedReferences: string | null = null;
	if (payload.inReplyTo) {
		headers['In-Reply-To'] = payload.inReplyTo;
		updatedReferences = payload.references ? `${payload.references} ${payload.inReplyTo}`.trim() : payload.inReplyTo;
		headers.References = updatedReferences;
	}
	const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	const htmlBody = payload.html || `<div style="font-family:sans-serif;line-height:1.5;white-space:pre-wrap">${escapeHtml(payload.text || '')}</div>`;
	const resendRes = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ from: `${senderName} <${senderEmail}>`, to, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined, subject: payload.subject.trim(), text: payload.text || '', html: htmlBody, headers: Object.keys(headers).length ? headers : undefined })
	});
	const resendData = await resendRes.json<{ id?: string; message?: string }>();
	if (!resendRes.ok) throw error(resendRes.status, resendData.message || 'Failed to send email via Resend');
	const emailId = crypto.randomUUID();
	const messageId = resendData.id ? `<${resendData.id}@resend.dev>` : `<${emailId}@ggacrux.ca>`;
	await db.prepare(`INSERT INTO emails (id, message_id, in_reply_to, references_header, folder, sender_name, sender_email, recipient_email, subject, text_body, html_body, is_read) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, 1)`)
		.bind(emailId, messageId, payload.inReplyTo || null, updatedReferences, senderName, senderEmail, to.join(', '), payload.subject.trim(), payload.text || '', htmlBody).run();
	return json({ success: true, id: emailId, resendId: resendData.id });
};
