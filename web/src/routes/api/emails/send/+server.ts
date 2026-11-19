import { json, error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';
import { ensureMailOwnerColumn, requireMailOwner } from '#lib/server/mail-owner';

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
const BIDI_CONTROL_CHARS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function stripBidiControls(value: string): string {
	return value.replace(BIDI_CONTROL_CHARS, '');
}
const recipients = (value: string | string[] | undefined): string[] =>
	(value ? (Array.isArray(value) ? value : value.split(',')) : [])
		.map((address) => address.trim()).filter(Boolean);

function sanitizeHtml(input: string): string {
	const blocked = /<(script|style|iframe|object|embed|form|input|button|textarea|select|video|audio|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
	const blockedSingle = /<(script|style|iframe|object|embed|form|input|button|textarea|select|video|audio|svg|math)\b[^>]*\/?>/gi;
	const allowedTags = new Set(['a','abbr','b','blockquote','br','caption','code','div','em','font','h1','h2','h3','h4','hr','i','li','ol','p','pre','s','span','strong','sub','sup','table','tbody','td','th','thead','tr','u','ul']);
	const safeCssValue = (property: string, value: string): string => {
		const clean = value.trim();
		if (!clean || /url\s*\(|expression\s*\(|javascript:|@import|[<>]/i.test(clean)) return '';
		if (property === 'color') return /^(#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/i.test(clean) ? clean : '';
		if (property === 'font-family') return /^[\w\s,'"-]{1,100}$/.test(clean) ? clean : '';
		if (property === 'font-size') return /^(\d+(\.\d+)?(px|pt|em|rem|%)|small|medium|large|x-small|x-large)$/i.test(clean) ? clean : '';
		return '';
	};
	const safeStyle = (style: string): string => style.split(';').map((declaration) => {
		const colon = declaration.indexOf(':');
		if (colon < 1) return '';
		const property = declaration.slice(0, colon).trim().toLowerCase();
		if (!['color','font-family','font-size'].includes(property)) return '';
		const value = safeCssValue(property, declaration.slice(colon + 1));
		return value ? property + ':' + value : '';
	}).filter(Boolean).join(';');
	let html = stripBidiControls(input).replace(/<!--[\s\S]*?-->/g, '').replace(blocked, '').replace(blockedSingle, '');
	html = html.replace(/<\/?([a-z][\w:-]*)\b([^>]*)>/gi, (tag, rawName: string, rawAttributes: string) => {
		const name = rawName.toLowerCase();
		if (!allowedTags.has(name)) return '';
		const closing = /^<\//.test(tag);
		if (closing) return ['br','hr'].includes(name) ? '' : '</' + name + '>';
		const attrs: string[] = [];
		const attributePattern = /([\w:-]+)\s*=\s*("(.*?)"|'(.*?)'|([^\s"'=<>]+))/g;
		let match: RegExpExecArray | null;
		while ((match = attributePattern.exec(rawAttributes))) {
			const key = match[1].toLowerCase();
			const value = match[3] ?? match[4] ?? match[5] ?? '';
			if (key.startsWith('on') || key === 'srcdoc' || key === 'id' || key === 'class') continue;
			if (key === 'style') {
				const style = safeStyle(value);
				if (style) attrs.push('style="' + style.replace(/"/g, '&quot;') + '"');
			} else if (name === 'font' && key === 'face') {
				const font = safeCssValue('font-family', value);
				if (font) attrs.push('style="font-family:' + font.replace(/"/g, '&quot;') + '"');
			} else if (name === 'font' && key === 'color') {
				const color = safeCssValue('color', value);
				if (color) attrs.push('style="color:' + color.replace(/"/g, '&quot;') + '"');
			} else if (name === 'a' && key === 'href' && /^(https?:|mailto:)/i.test(value.trim())) {
				attrs.push('href="' + value.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"');
			} else if (key === 'title' || key === 'colspan' || key === 'rowspan' || key === 'align') {
				attrs.push(key + '="' + value.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"');
			}
		}
		if (name === 'a') attrs.push('rel="noopener noreferrer"');
		return '<' + name + (attrs.length ? ' ' + attrs.join(' ') : '') + '>';
	});
	return html;
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

	const senderEmail = requireMailOwner(locals.userEmail);
	await ensureMailOwnerColumn(db);

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
	const cleanText = stripBidiControls(payload.text || '');
	const htmlBody = payload.html ? sanitizeHtml(payload.html) : `<div style="font-family:sans-serif;line-height:1.5;white-space:pre-wrap">${cleanText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
	const textBody = cleanText.trim() ? cleanText : htmlToText(htmlBody);
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
			const r2Key = `accounts/${encodeURIComponent(senderEmail)}/emails/${emailId}/${id}`;
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
		await db.prepare(`INSERT INTO emails (owner_email, id, message_id, in_reply_to, references_header, folder, sender_name, sender_email, recipient_email, subject, text_body, html_body, is_read) VALUES (?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, 1)`)
			.bind(senderEmail, emailId, messageId, payload.inReplyTo || null, updatedReferences, senderName, senderEmail, to.join(', '), payload.subject.trim(), textBody, htmlBody).run();
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
