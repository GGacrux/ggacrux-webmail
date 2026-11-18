import PostalMime from 'postal-mime';

export interface Env {
	DB: D1Database;
	ggacrux_attachments?: R2Bucket; // Optional: gracefully falls back if R2 is not configured
}

export default {
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		try {
			try { await env.DB.prepare('ALTER TABLE emails ADD COLUMN owner_email TEXT').run(); } catch { /* column already exists or another delivery added it */ }
			await env.DB.prepare("UPDATE emails SET owner_email = lower(trim(CASE WHEN folder = 'sent' THEN sender_email ELSE recipient_email END)) WHERE owner_email IS NULL OR trim(owner_email) = ''").run();
			// 1. Read the raw MIME stream into an ArrayBuffer and parse it
			const rawEmail = await new Response(message.raw).arrayBuffer();
			const parser = new PostalMime();
			const parsed = await parser.parse(rawEmail);

			// 2. Extract identifiers & threading headers
			const emailId = crypto.randomUUID();
			const messageId = parsed.messageId || `<${emailId}@ggacrux.ca>`;
			const inReplyTo = parsed.inReplyTo || null;
			const referencesHeader = Array.isArray(parsed.references)
				? parsed.references.join(' ')
				: parsed.references || null;

			// 3. Extract sender & recipient info
			const senderName = parsed.from?.name || null;
			const senderEmail = parsed.from?.address || message.from;
			const recipientEmail = message.to.trim().toLowerCase();
			if (!/^[^\s@]+@ggacrux\.ca$/i.test(recipientEmail)) throw new Error('Inbound recipient is not a supported GGacrux mailbox');
			const subject = parsed.subject || '(No Subject)';
			const textBody = parsed.text || '';
			const htmlBody = parsed.html || null;

			// 4. Insert the email record into D1
			await env.DB.prepare(
				`INSERT INTO emails (
					owner_email, id, message_id, in_reply_to, references_header, folder,
					sender_name, sender_email, recipient_email, subject,
					text_body, html_body, is_read
				) VALUES (?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, 0)`
			)
				.bind(
					recipientEmail,
					emailId,
					messageId,
					inReplyTo,
					referencesHeader,
					senderName,
					senderEmail,
					recipientEmail,
					subject,
					textBody,
					htmlBody
				)
				.run();

			// 5. Process attachments (upload binary to R2 if available, record metadata in D1)
			if (parsed.attachments && parsed.attachments.length > 0) {
				for (const att of parsed.attachments) {
					const attId = crypto.randomUUID();
					const filename = att.filename || `attachment-${attId}`;
					const contentType = att.mimeType || 'application/octet-stream';

					// Normalize content to ArrayBuffer/Uint8Array
					const contentBytes =
						typeof att.content === 'string'
							? new TextEncoder().encode(att.content)
							: new Uint8Array(att.content);

					const sizeBytes = contentBytes.byteLength;
					let r2Key: string | null = null;

					if (env.ggacrux_attachments) {
						r2Key = `accounts/${encodeURIComponent(recipientEmail)}/${emailId}/${attId}`;
						await env.ggacrux_attachments.put(r2Key, contentBytes, {
							httpMetadata: {
								contentType,
								contentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`
							}
						});
					}

					await env.DB.prepare(
						`INSERT INTO attachments (id, email_id, filename, content_type, size_bytes, r2_key)
						 VALUES (?, ?, ?, ?, ?, ?)`
					)
						.bind(attId, emailId, filename, contentType, sizeBytes, r2Key)
						.run();
				}
			}
		} catch (err) {
			console.error('Failed to process inbound email:', err);
			// Reject at SMTP level so the sender knows delivery failed if D1/parsing crashes
			message.setReject(`Internal mail processing error: ${(err as Error).message}`);
		}
	}
};
