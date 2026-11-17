// web/src/routes/api/emails/send/+server.ts
// web/src/routes/api/emails/send/+server.ts
import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

interface SendPayload {
	fromAlias?: string;
	fromName?: string;
	to: string;
	subject: string;
	text: string;
	html?: string;
	inReplyTo?: string | null;
	references?: string | null;
}

export const POST: RequestHandler = async ({ request }) => {
	const db = env.DB;
	const apiKey = env.RESEND_API_KEY;

	if (!db) throw error(500, 'D1 database binding not available');
	if (!apiKey) throw error(500, 'RESEND_API_KEY is not configured');

	const payload = await request.json<SendPayload>();

	if (!payload.to || !payload.subject) {
		throw error(400, 'Recipient (to) and subject are required');
	}

	// Enforce sending strictly from your verified @ggacrux.ca domain
	const senderEmail =
		payload.fromAlias && payload.fromAlias.toLowerCase().endsWith('@ggacrux.ca')
			? payload.fromAlias.trim()
			: 'canopus@ggacrux.ca';

	const senderName = payload.fromName?.trim() || 'GGacrux';
	const formattedFrom = `${senderName} <${senderEmail}>`;

	// Build threading headers if replying to an existing message
	const headers: Record<string, string> = {};
	let updatedReferences: string | null = null;

	if (payload.inReplyTo) {
		headers['In-Reply-To'] = payload.inReplyTo;
		updatedReferences = payload.references
			? `${payload.references} ${payload.inReplyTo}`.trim()
			: payload.inReplyTo;
		headers['References'] = updatedReferences;
	}

	const htmlBody =
		payload.html ||
		`<div style="font-family: sans-serif; line-height: 1.5; white-space: pre-wrap;">${payload.text
			.replace(/&/g, '&')
			.replace(/</g, '<')
			.replace(/>/g, '>')}</div>`;

	// Send via Resend REST API
	const resendRes = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			from: formattedFrom,
			to: [payload.to.trim()],
			subject: payload.subject,
			text: payload.text,
			html: htmlBody,
			headers: Object.keys(headers).length > 0 ? headers : undefined
		})
	});

	const resendData = await resendRes.json<{ id?: string; message?: string }>();

	if (!resendRes.ok) {
		throw error(resendRes.status, resendData.message || 'Failed to send email via Resend');
	}

	// Store sent email in D1
	const emailId = crypto.randomUUID();
	const messageId = resendData.id ? `<${resendData.id}@resend.dev>` : `<${emailId}@ggacrux.ca>`;

	await db
		.prepare(
			`INSERT INTO emails (
				id, message_id, in_reply_to, references_header, folder,
				sender_name, sender_email, recipient_email, subject,
				text_body, html_body, is_read
			) VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, 1)`
		)
		.bind(
			emailId,
			messageId,
			payload.inReplyTo || null,
			updatedReferences,
			senderName,
			senderEmail,
			payload.to.trim(),
			payload.subject,
			payload.text,
			htmlBody
		)
		.run();

	return json({ success: true, id: emailId, resendId: resendData.id });
};
