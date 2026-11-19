<script lang="ts">
	import { onMount } from 'svelte';
	import { buildSandboxedEmailHtml } from '../lib/sanitize';
	import DOMPurify from 'dompurify';

	export let data: { userEmail?: string } = {};

	interface EmailSummary {
		id: string;
		message_id: string | null;
		in_reply_to: string | null;
		references_header: string | null;
		folder: 'inbox' | 'sent' | 'trash';
		sender_name: string | null;
		sender_email: string;
		recipient_email: string;
		subject: string;
		snippet: string;
		is_read: number;
		created_at: string;
	}

	interface EmailDetail extends EmailSummary { text_body: string; html_body: string | null; tags?: string }
	interface StorageUsage { d1: { usedBytes: number; limitBytes: number; emailCount: number }; r2: { usedBytes: number; limitBytes: number; fileCount: number } }
	interface Label { name: string; color: string }

	interface Attachment {
		id: string;
		filename: string;
		content_type: string;
		size_bytes: number;
		r2_key: string | null;
	}

	let folder: 'inbox' | 'sent' | 'trash' = 'inbox';
	let searchQuery = '';
	let unreadOnly = false;
	let emails: EmailSummary[] = [];
	let unreadCount = 0;
	let loadingList = false;
	let loadingMore = false;
	let emailListRequestId = 0;
	let hasMore = false;
	let totalCount = 0;
	let listOffset = 0;
	let sentinelEl: HTMLDivElement;
	let selectedIds: string[] = [];
	let observer: IntersectionObserver | null = null;
	let bulkWorking = false;

	let selectedEmail: EmailDetail | null = null;
	let attachments: Attachment[] = [];
	let loadingDetail = false;
	let emailSelectionRequestId = 0;
	let pollingEmails = false;
	const emailFrameObservers = new WeakMap<HTMLIFrameElement, ResizeObserver>();
	let authRedirectInProgress = false;
	let threadMessages: (EmailDetail & { attachments?: Attachment[] })[] = [];
	let virtualFolder = ''; let activeTag = ''; let labels: Label[] = []; let storage: StorageUsage | null = null;
	let htmlBody = ''; let htmlMode = false; let editorEl: HTMLDivElement;
	let attachmentFiles: File[] = []; let attachmentError = '';
	const attachmentLimit = 10 * 1024 * 1024;

	// Compose / Reply Modal State
	let showCompose = false;
	let composeMinimized = false;
	let composeExpanded = false;
	let showCcBcc = false;
	let sending = false;
	let composeError = '';
	let fromAlias = 'canopus@ggacrux.ca';
	let fromName = 'GGacrux';
	let to = '';
	let cc = '';
	let bcc = '';
	let draftKey = 'ggacrux-mail-draft-v1';
	let restoredDraft = false;
	let quickLinks: { id: string; title: string; url: string }[] = [];
	let showProfile = false;
	let mobileNavOpen = false;
	let mobileShowDetail = false;
	let profileName = 'GGacrux';
	let profilePhoto = '';
	let signatureHtml = '';
	let signatureEditorEl: HTMLDivElement;
	let selectedTheme: 'slate' | 'midnight' | 'nordic' = 'slate';
	$: avatarInitial = (profileName || userEmail || 'G').trim().charAt(0).toUpperCase();
	let subject = '';
	let textBody = '';
	let inReplyTo: string | null = null;
	let references: string | null = null;

	// Toast & refs
	let statusMessage = '';
	let searchTimer: ReturnType<typeof setTimeout>;
	let searchInputEl: HTMLInputElement;

	$: userEmail = data?.userEmail || '';
	$: visibleEmails = unreadOnly ? emails.filter((e) => e.is_read === 0) : emails;

	function saveProfile() {

		fromName = profileName.trim() || (userEmail.split('@')[0] || 'GGacrux');

		localStorage.setItem('ggacrux_profile', JSON.stringify({ displayName: fromName, photo: profilePhoto, signatureHtml, theme: selectedTheme }));

	}

	function changeTheme(theme: 'slate' | 'midnight' | 'nordic') {

		selectedTheme = theme; document.documentElement.dataset.theme = theme;

		localStorage.setItem('ggacrux_theme', theme);

		localStorage.setItem('ggacrux_profile', JSON.stringify({ displayName: profileName, photo: profilePhoto, signatureHtml, theme }));

	}

	function addQuickLink() {

		const title = prompt('Bookmark title'); if (!title?.trim()) return;

		let url = prompt('Bookmark URL'); if (!url?.trim()) return;

		url = url.trim(); if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

		try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); }

		catch { notify('Please enter a valid web address'); return; }

		quickLinks = [...quickLinks, { id: crypto.randomUUID(), title: title.trim(), url }];

		localStorage.setItem('ggacrux_quick_links', JSON.stringify(quickLinks));

	}

	function removeQuickLink(id: string) {

		quickLinks = quickLinks.filter((link) => link.id !== id);

		localStorage.setItem('ggacrux_quick_links', JSON.stringify(quickLinks));

	}

	async function handleProfilePhoto(event: Event) {

		const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (!file) return;

		if (!file.type.startsWith('image/')) { notify('Choose an image file'); return; }

		try {

			const bitmap = await createImageBitmap(file); const canvas = document.createElement('canvas');

			canvas.width = 128; canvas.height = 128; const ctx = canvas.getContext('2d');

			if (!ctx) throw new Error('Canvas is unavailable');

			const side = Math.min(bitmap.width, bitmap.height);

			ctx.drawImage(bitmap, (bitmap.width-side)/2, (bitmap.height-side)/2, side, side, 0, 0, 128, 128);

			profilePhoto = canvas.toDataURL('image/webp', 0.82);

			localStorage.setItem('ggacrux_profile', JSON.stringify({ displayName: profileName, photo: profilePhoto, signatureHtml, theme: selectedTheme }));

		} catch { notify('Could not process that image'); }

	}

	function notify(msg: string) {
		statusMessage = msg;
		setTimeout(() => {
			if (statusMessage === msg) statusMessage = '';
		}, 3500);
	}

	async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
		if (authRedirectInProgress) return new Promise<Response>(() => {});
		try {
			const headers = new Headers(init.headers);
			if (!headers.has('X-Requested-With')) headers.set('X-Requested-With', 'XMLHttpRequest');
			const response = await fetch(input, {
				...init,
				headers,
				credentials: 'same-origin',
				redirect: 'manual'
			});
			const accessRedirect = response.type === 'opaqueredirect' ||
				response.status === 401 ||
				response.status === 403 ||
				response.url.includes('cloudflareaccess.com');
			if (accessRedirect) {
				authRedirectInProgress = true;
				window.location.reload();
				return await new Promise<Response>(() => {});
			}
			return response;
		} catch (cause) {
			if (authRedirectInProgress) return await new Promise<Response>(() => {});
			throw cause;
		}
	}

	async function loadEmails(silent = false) {
		const requestId = ++emailListRequestId;
		loadingMore = false;
		const showLoading = !silent || loadingList;
		if (showLoading) loadingList = true;
		if (!silent) listOffset = 0;
		try {
			const params = new URLSearchParams({ folder, limit: '25', offset: '0' });
			if (virtualFolder) params.set('virtualFolder', virtualFolder); if (activeTag) params.set('tag', activeTag);
			if (searchQuery.trim()) params.set('q', searchQuery.trim());
			const res = await apiFetch(`/api/emails?${params}`);
			if (requestId !== emailListRequestId) return;
			if (!res.ok) throw new Error('Failed to load emails');
			const payload = await res.json();
			if (requestId !== emailListRequestId) return;
			if (silent) {
				const fresh = payload.emails as EmailSummary[];
				const known = new Set(emails.map((item) => item.id));
				emails = [...fresh, ...emails.filter((item) => !known.has(item.id))];
			} else { emails = payload.emails; listOffset = payload.emails.length; }
			unreadCount = payload.unreadCount;
			totalCount = payload.totalCount;
			hasMore = payload.hasMore;
		} catch (err) {
			if (requestId === emailListRequestId && !silent) notify((err as Error).message);
		} finally {
			if (requestId === emailListRequestId && showLoading) loadingList = false;
		}
		if (requestId === emailListRequestId) await loadStorage();
	}

	async function loadMore() {
		if (loadingMore || !hasMore) return;
		const requestId = emailListRequestId;
		loadingMore = true;
		try {
			const params = new URLSearchParams({ folder, limit: '25', offset: String(listOffset) });
			if (virtualFolder) params.set('virtualFolder', virtualFolder); if (activeTag) params.set('tag', activeTag);
			if (searchQuery.trim()) params.set('q', searchQuery.trim());
			const res = await apiFetch(`/api/emails?${params}`);
			if (requestId !== emailListRequestId) return;
			if (!res.ok) throw new Error('Failed to load more messages');
			const payload = await res.json();
			if (requestId !== emailListRequestId) return;
			emails = [...emails, ...payload.emails.filter((item: EmailSummary) => !emails.some((old) => old.id === item.id))];
			listOffset += payload.emails.length;
			hasMore = payload.hasMore;
			totalCount = payload.totalCount;
		} catch (err) {
			if (requestId === emailListRequestId) notify((err as Error).message);
		} finally {
			if (requestId === emailListRequestId) loadingMore = false;
		}
	}

	function handleSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			loadEmails();
		}, 250);
	}

	function switchFolder(nextFolder: 'inbox' | 'sent' | 'trash') {
		emailListRequestId += 1;
		loadingMore = false;
		emailSelectionRequestId += 1;
		loadingDetail = false;
		mobileNavOpen = false;
		mobileShowDetail = false;
		folder = nextFolder;
		virtualFolder = ''; activeTag = '';
		unreadOnly = false;
		selectedEmail = null;
		attachments = [];
		threadMessages = [];
		selectedIds = [];
		loadEmails();
	}

	async function selectEmail(item: EmailSummary) {
		const requestId = ++emailSelectionRequestId;
		mobileShowDetail = true;
		loadingDetail = true;
		try {
			const res = await apiFetch(`/api/emails/${item.id}`);
			if (requestId !== emailSelectionRequestId) return;
			if (!res.ok) throw new Error('Failed to load message');
			const payload = await res.json();
			if (requestId !== emailSelectionRequestId) return;
			selectedEmail = payload.email;
			attachments = payload.attachments || [];

			const threadRes = await apiFetch('/api/emails?threadId=' + encodeURIComponent(item.message_id || item.id));
			if (requestId !== emailSelectionRequestId) return;
			if (threadRes.ok) {
				const threadPayload = await threadRes.json();
				if (requestId !== emailSelectionRequestId) return;
				threadMessages = threadPayload.emails || [];
			} else {
				threadMessages = [{ ...payload.email, attachments: payload.attachments || [] }];
			}

			if (item.is_read === 0) {
				const readResponse = await apiFetch(`/api/emails/${item.id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ is_read: 1 })
				});
				if (requestId !== emailSelectionRequestId) return;
				if (!readResponse.ok) throw new Error('Failed to mark message as read');
				item.is_read = 1;
				if (selectedEmail) selectedEmail = { ...selectedEmail, is_read: 1 };
				emails = [...emails];
				if (folder === 'inbox' && unreadCount > 0) unreadCount -= 1;
			}
		} catch (err) {
			if (requestId === emailSelectionRequestId) notify((err as Error).message);
		} finally {
			if (requestId === emailSelectionRequestId) loadingDetail = false;
		}
	}


	async function bulkUpdate(action: 'read' | 'unread' | 'trash' | 'delete') {
		if (!selectedIds.length || bulkWorking) return;
		if (action === 'delete' && !confirm(`Permanently delete ${selectedIds.length} selected messages?`)) return;
		bulkWorking = true;
		try {
			const idsToUpdate = [...selectedIds];
		await Promise.all(idsToUpdate.map((id) => action === 'delete'
				? apiFetch(`/api/emails/${id}`, { method: 'DELETE' })
				: apiFetch(`/api/emails/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'trash' ? { folder: 'trash' } : { is_read: action === 'read' ? 1 : 0 }) })));
			if (selectedEmail && idsToUpdate.includes(selectedEmail.id) && (action === 'trash' || action === 'delete')) selectedEmail = null;
			selectedIds = [];
			await loadEmails();
			notify('Bulk action complete');
		} catch { notify('Some messages could not be updated'); }
		finally { bulkWorking = false; }
	}

	async function toggleRead(email: EmailDetail) {
		const nextState = email.is_read === 1 ? 0 : 1;
		await apiFetch(`/api/emails/${email.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ is_read: nextState })
		});
		selectedEmail = { ...email, is_read: nextState };
		await loadEmails(true);
	}

	async function markAllRead() {
		const unreadItems = emails.filter((e) => e.is_read === 0);
		if (unreadItems.length === 0 || bulkWorking) return;

		bulkWorking = true;
		try {
			await Promise.all(
				unreadItems.map((item) =>
					apiFetch(`/api/emails/${item.id}`, {
						method: 'PATCH',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ is_read: 1 })
					})
				)
			);
			if (selectedEmail) selectedEmail = { ...selectedEmail, is_read: 1 };
			notify(`Marked ${unreadItems.length} message(s) as read`);
			await loadEmails(true);
		} catch {
			notify('Failed to mark all as read');
		} finally {
			bulkWorking = false;
		}
	}

	async function moveToFolder(id: string, targetFolder: 'inbox' | 'trash') {
		await apiFetch(`/api/emails/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ folder: targetFolder })
		});
		selectedEmail = null;
		attachments = [];
		notify(targetFolder === 'trash' ? 'Moved to Trash' : 'Restored to Inbox');
		await loadEmails();
	}

	async function permanentDelete(id: string) {
		if (!confirm('Permanently delete this email and any stored attachments? This cannot be undone.')) {
			return;
		}
		const res = await apiFetch(`/api/emails/${id}`, { method: 'DELETE' });
		if (res.ok) {
			selectedEmail = null;
			attachments = [];
			notify('Permanently deleted');
			await loadEmails();
		} else {
			notify('Failed to delete email');
		}
	}

	async function emptyTrash() {
		if (folder !== 'trash' || emails.length === 0 || bulkWorking) return;
		if (
			!confirm(
				`Permanently delete all ${emails.length} message(s) in Trash and their attachments? This cannot be undone.`
			)
		) {
			return;
		}

		bulkWorking = true;
		try {
			await Promise.all(emails.map((item) => apiFetch(`/api/emails/${item.id}`, { method: 'DELETE' })));
			selectedEmail = null;
			attachments = [];
			notify('Trash emptied');
			await loadEmails();
		} catch {
			notify('Failed to empty Trash');
		} finally {
			bulkWorking = false;
		}
	}

	async function loadStorage() { try { const r = await apiFetch('/api/storage'); if (r.ok) storage = await r.json(); } catch { /* optional metrics */ } }
	function storagePercent(bytes: number, limit: number) { return Math.min(100, Math.max(0, bytes / limit * 100)); }
	function storageTone(bytes: number, limit: number) { const p = storagePercent(bytes, limit); return p > 90 ? 'danger' : p > 75 ? 'warning' : ''; }
	function selectVirtualView(value: string) {
		emailListRequestId += 1;
		loadingMore = false;
		emailSelectionRequestId += 1;
		loadingDetail = false;
		mobileNavOpen = false;
		mobileShowDetail = false;
		virtualFolder = value;
		activeTag = '';
		selectedEmail = null;
		attachments = [];
		threadMessages = [];
		selectedIds = [];
		loadEmails();
	}

	function selectTag(value: string) {
		emailListRequestId += 1;
		loadingMore = false;
		emailSelectionRequestId += 1;
		loadingDetail = false;
		mobileNavOpen = false;
		mobileShowDetail = false;
		activeTag = activeTag === value ? '' : value;
		virtualFolder = '';
		selectedEmail = null;
		attachments = [];
		threadMessages = [];
		selectedIds = [];
		loadEmails();
	}
	function createLabel() { const name = prompt('Label name'); if (!name?.trim()) return; const color = prompt('Label color (hex)', '#2563eb') || '#2563eb'; labels = [...labels, { name: name.trim(), color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#2563eb' }]; localStorage.setItem('ggacrux_labels', JSON.stringify(labels)); }
	async function toggleEmailTag(email: EmailSummary, tag: string) { let current: string[] = []; try { current = JSON.parse((email as EmailSummary & { tags?: string }).tags || '[]'); } catch {} const next = current.includes(tag) ? current.filter((v) => v !== tag) : [...current, tag]; const r = await apiFetch('/api/emails', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [email.id], tags: next }) }); if (!r.ok) { notify('Could not update labels'); return; } (email as EmailSummary & { tags?: string }).tags = JSON.stringify(next); emails = [...emails]; if (selectedEmail?.id === email.id) selectedEmail = { ...selectedEmail, tags: JSON.stringify(next) }; }
	function handleFiles(event: Event) { const input = event.currentTarget as HTMLInputElement; const next = [...attachmentFiles, ...Array.from(input.files || [])]; if (next.reduce((n, f) => n + f.size, 0) > attachmentLimit) { attachmentError = 'Attachments must total 10 MB or less.'; input.value = ''; return; } attachmentFiles = next; attachmentError = ''; input.value = ''; }
	function removeFile(index: number) { attachmentFiles = attachmentFiles.filter((_, i) => i !== index); attachmentError = ''; }
	function runEditorCommand(target: HTMLDivElement | undefined, command: string, value?: string) {
		target?.focus();
		if (command === 'createLink') {
			const url = prompt('Link URL');
			if (!url || !/^https?:\/\//i.test(url)) return;
			document.execCommand(command, false, url);
		} else document.execCommand(command, false, value);
		if (target === editorEl && editorEl) updateVisualBody();
		if (target === signatureEditorEl && signatureEditorEl) updateSignature();
	}
	function formatCommand(command: string, value?: string) { runEditorCommand(editorEl, command, value); }
	function handleEditorPaste(event: ClipboardEvent) {
		if (!editorEl || !event.clipboardData) return;
		event.preventDefault();

		const html = event.clipboardData.getData('text/html');
		if (html) {
			const cleanHtml = DOMPurify.sanitize(html, {
				USE_PROFILES: { html: true },
				FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'bdo', 'bdi'],
				FORBID_ATTR: ['dir', 'style', 'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur']
			});
			const template = document.createElement('template');
			template.innerHTML = cleanHtml;
			const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
			const bidiControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
			while (walker.nextNode()) {
				const node = walker.currentNode;
				node.textContent = (node.textContent || '').replace(bidiControls, '');
			}
			document.execCommand('insertHTML', false, template.innerHTML);
		} else {
			const plainText = event.clipboardData.getData('text/plain')
				.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
			document.execCommand('insertText', false, plainText);
		}
		updateVisualBody();
	}
	function updateVisualBody() { if (editorEl) { htmlBody = editorEl.innerHTML; textBody = editorEl.innerText; } }
	function updateSignature() {
		if (signatureEditorEl) {
			signatureHtml = signatureEditorEl.innerHTML;
			localStorage.setItem('ggacrux_profile', JSON.stringify({ displayName: profileName, photo: profilePhoto, signatureHtml, theme: selectedTheme }));
		}
	}
	function applyFont(target: HTMLDivElement | undefined, font: string) { runEditorCommand(target, 'fontName', font); }
	function applyTextColor(target: HTMLDivElement | undefined, color: string) { runEditorCommand(target, 'foreColor', color); }
	function escapeHtml(value: string) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
	function plainTextToHtml(value: string) { return value.split('\n').map(escapeHtml).join('<br>'); }
	function signatureText() {
		return signatureHtml.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').trim();
	}
	function signatureBlock() { return signatureHtml.trim() ? '<div>' + signatureHtml + '</div><p><br></p>' : ''; }
	function openCompose() {
		mobileNavOpen = false;
		composeError = '';
		if (userEmail) fromAlias = userEmail;
		fromName = profileName || (userEmail.split('@')[0] || 'GGacrux');
		if (!restoredDraft) { to = ''; cc = ''; bcc = ''; subject = ''; textBody = signatureText() ? signatureText() + '\n\n' : ''; htmlBody = signatureBlock(); }
		composeMinimized = false;
		composeExpanded = false;
		showCcBcc = false;
		inReplyTo = null;
		references = null;
		showCompose = true;
	}

	function openReply(email: EmailDetail) {
		composeError = '';
		if (email.recipient_email?.toLowerCase().endsWith('@ggacrux.ca')) {
			fromAlias = email.recipient_email;
		} else if (data?.userEmail && data.userEmail.toLowerCase().endsWith('@ggacrux.ca')) {
			fromAlias = data.userEmail;
		}

		to = email.folder === 'sent' ? email.recipient_email : email.sender_email;
		subject = email.subject?.toLowerCase().startsWith('re:')
			? email.subject
			: `Re: ${email.subject || ''}`;
		inReplyTo = email.message_id;
		references = [email.references_header, email.message_id].filter(Boolean).join(' ') || null;

		const quotedDate = new Date(
			email.created_at.endsWith('Z') ? email.created_at : email.created_at + 'Z'
		).toLocaleString();
		const quotedText = (email.text_body || '')
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n');
		textBody = (signatureText() ? signatureText() + '\n\n' : '') + '\n\n--- On ' + quotedDate + ', ' + email.sender_email + ' wrote: ---\n' + quotedText;
		htmlBody = signatureBlock() + '<p>On ' + escapeHtml(quotedDate) + ', ' + escapeHtml(email.sender_email) + ' wrote:</p><blockquote>' + plainTextToHtml(quotedText) + '</blockquote>';
		fromName = profileName || fromName;
		showCompose = true;
	}


	function openReplyAll(email: EmailDetail) {
		openReply(email);
		const own = userEmail.toLowerCase();
		const participants = [email.sender_email, email.recipient_email].filter((address) => address && address.toLowerCase() !== own);
		to = [...new Set(participants)].join(', ');
		showCcBcc = true;
	}

	function openForward(email: EmailDetail) {
		composeError = '';
		fromAlias = userEmail;
		to = ''; cc = ''; bcc = '';
		subject = email.subject.toLowerCase().startsWith('fwd:') ? email.subject : `Fwd: ${email.subject}`;
		const forwardedText = '---------- Forwarded message ----------\nFrom: ' + email.sender_email + '\nDate: ' + new Date(email.created_at).toLocaleString() + '\nSubject: ' + email.subject + '\nTo: ' + email.recipient_email + '\n\n' + (email.text_body || '');
		textBody = (signatureText() ? signatureText() + '\n\n' : '') + forwardedText;
		htmlBody = signatureBlock() + '<p>' + plainTextToHtml(forwardedText) + '</p>';
		fromName = profileName || fromName;
		inReplyTo = null; references = null; showCompose = true; composeMinimized = false;
	}

	async function sendEmail() {
		composeError = '';
		if (!to.trim() || !subject.trim()) {
			composeError = 'Recipient and subject are required.';
			return;
		}
		sending = true;
		try {
			const form = new FormData();
			const outgoingHtml = htmlMode ? htmlBody : (editorEl?.innerHTML || htmlBody);
			const outgoingText = htmlMode ? textBody : (editorEl?.innerText || textBody);
			form.set('fromName', fromName); form.set('to', to); form.set('cc', cc); form.set('bcc', bcc); form.set('subject', subject); form.set('text', outgoingText); form.set('html', outgoingHtml);
			if (inReplyTo) form.set('inReplyTo', inReplyTo); if (references) form.set('references', references);
			for (const file of attachmentFiles) form.append('attachments', file, file.name);
			const res = await apiFetch('/api/emails/send', { method: 'POST', body: form });
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.message || 'Failed to send email');

			showCompose = false;
			localStorage.removeItem(draftKey);
			restoredDraft = false;
			to = ''; cc = ''; bcc = ''; subject = ''; textBody = ''; htmlBody = ''; attachmentFiles = []; attachmentError = '';
			notify('Email sent'); await loadStorage();
			if (folder === 'sent') await loadEmails();
		} catch (err) {
			composeError = (err as Error).message;
		} finally {
			sending = false;
		}
	}

	function handleLogout(event: MouseEvent) {
		event.preventDefault();
		try { localStorage.clear(); } catch { /* storage may be unavailable */ }
		try { sessionStorage.clear(); } catch { /* storage may be unavailable */ }
		document.cookie = 'CF_Authorization=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=None';
		window.location.assign('/logout');
	}

	function handleKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		const isTyping =
			target &&
			(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

		if (event.key === 'Escape') {
			if (showCompose) {
				composeMinimized = true;
			} else if (selectedEmail || loadingDetail) {
				emailSelectionRequestId += 1;
				loadingDetail = false;
				selectedEmail = null;
				attachments = [];
				threadMessages = [];
				mobileShowDetail = false;
			}
			return;
		}

		if (isTyping || showCompose || event.metaKey || event.ctrlKey || event.altKey) return;

		if (event.key === 'c' || event.key === 'C') {
			event.preventDefault();
			openCompose();
		} else if (event.key === '/') {
			event.preventDefault();
			searchInputEl?.focus();
		} else if (event.key === 'r' || event.key === 'R') {
			event.preventDefault();
			loadEmails();
			notify('Refreshed');
		} else if (event.key === 'ArrowDown' || event.key.toLowerCase() === 'j') {
			event.preventDefault();
			const index = visibleEmails.findIndex((item) => item.id === selectedEmail?.id);
			const next = visibleEmails[Math.min(index + 1, visibleEmails.length - 1)];
			if (next) selectEmail(next);
		} else if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'k') {
			event.preventDefault();
			const index = visibleEmails.findIndex((item) => item.id === selectedEmail?.id);
			const next = visibleEmails[Math.max(index - 1, 0)];
			if (next) selectEmail(next);
		} else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEmail) {
			event.preventDefault();
			if (selectedEmail.folder !== 'trash') {
				moveToFolder(selectedEmail.id, 'trash');
			} else {
				permanentDelete(selectedEmail.id);
			}
		}
	}

	function resizeEmailFrame(event: Event) {
		const iframe = event.currentTarget as HTMLIFrameElement;
		try {
			const doc = iframe.contentDocument;
			if (!doc) throw new Error('Email frame document is unavailable');
			const resize = () => {
				const body = doc.body;
				const root = doc.documentElement;
				const contentHeight = Math.max(
					body?.scrollHeight ?? 0,
					body?.offsetHeight ?? 0,
					root?.scrollHeight ?? 0,
					root?.offsetHeight ?? 0
				);
				iframe.style.height = Math.max(450, contentHeight + 24) + 'px';
			};
			emailFrameObservers.get(iframe)?.disconnect();
			resize();
			if (typeof ResizeObserver !== 'undefined' && doc.documentElement) {
				const observer = new ResizeObserver(resize);
				observer.observe(doc.documentElement);
				if (doc.body) observer.observe(doc.body);
				emailFrameObservers.set(iframe, observer);
			}
			doc.querySelectorAll('img').forEach((image) => image.addEventListener('load', resize));
		} catch {
			iframe.style.height = '450px';
		}
	}

	function formatDate(iso: string): string {
		const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
		const now = new Date();
		if (d.toDateString() === now.toDateString()) {
			return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		}
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	function getEmailTags(email: EmailSummary): string[] { try { return JSON.parse((email as EmailSummary & { tags?: string }).tags || '[]'); } catch { return []; } }
	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	onMount(() => {
		draftKey = 'ggacrux-mail-draft-v1:' + (userEmail || 'unknown').toLowerCase();
		if (data?.userEmail && data.userEmail.toLowerCase().endsWith('@ggacrux.ca')) {
			fromAlias = data.userEmail;
		}
		if (userEmail) fromAlias = userEmail;
		try {
			const profile = JSON.parse(localStorage.getItem('ggacrux_profile') || '{}');
			profileName = profile.displayName || (userEmail.split('@')[0] || 'GGacrux'); fromName = profileName;
			profilePhoto = profile.photo || ''; signatureHtml = profile.signatureHtml || (profile.signature ? plainTextToHtml(profile.signature) : '');
			selectedTheme = profile.theme || localStorage.getItem('ggacrux_theme') || 'slate';
			document.documentElement.dataset.theme = selectedTheme;
		} catch { profileName = userEmail.split('@')[0] || 'GGacrux'; }
		try { quickLinks = JSON.parse(localStorage.getItem('ggacrux_quick_links') || '[]'); } catch { quickLinks = []; }
		try { labels = JSON.parse(localStorage.getItem('ggacrux_labels') || '[]'); } catch { labels = []; }
		const saved = localStorage.getItem(draftKey);
		if (saved) { try { const draft = JSON.parse(saved); to = draft.to || ''; cc = draft.cc || ''; bcc = draft.bcc || ''; subject = draft.subject || ''; textBody = draft.textBody || ''; htmlBody = draft.htmlBody || ''; fromAlias = userEmail; fromName = draft.fromName || fromName; restoredDraft = true; } catch { localStorage.removeItem(draftKey); } }
		const draftTimer = setInterval(() => { if (showCompose) localStorage.setItem(draftKey, JSON.stringify({ to, cc, bcc, subject, textBody, htmlBody: editorEl?.innerHTML || htmlBody, fromName })); }, 800);
		observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) loadMore(); }, { root: null, rootMargin: '240px' });
		loadEmails().then(() => { if (sentinelEl) observer?.observe(sentinelEl); });

		// Auto-refresh inbox/folder every 30s when tab is active
		const refreshWhenActive = () => {
			if (document.hidden || showCompose || pollingEmails || authRedirectInProgress) return;
			pollingEmails = true;
			void loadEmails(true).finally(() => { pollingEmails = false; });
		};
		const handleVisibilityChange = () => {
			if (!document.hidden) refreshWhenActive();
		};
		const handleWindowFocus = () => refreshWhenActive();
		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.addEventListener('focus', handleWindowFocus);
		const pollInterval = window.setInterval(refreshWhenActive, 30000);

		return () => {
			window.clearInterval(pollInterval);
			window.clearInterval(draftTimer);
			clearTimeout(searchTimer);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('focus', handleWindowFocus);
			observer?.disconnect();
		};
	});
</script>

<svelte:window on:keydown={handleKeydown} />

<svelte:head>
	<title>GGacrux Mail {unreadCount > 0 ? `(${unreadCount})` : ''}</title>
</svelte:head>

<div class="app-shell">
	<header class="mobile-header">
		<div class="mobile-header-brand">
			<button type="button" class="mobile-menu-button" aria-label="Open navigation" aria-expanded={mobileNavOpen} on:click={() => (mobileNavOpen = true)}>☰</button>
			<strong>GGacrux Mail</strong>
			<button type="button" class="sidebar-close" aria-label="Close navigation" on:click={() => (mobileNavOpen = false)}>×</button>
		</div>
		<div class="mobile-header-actions">
			<button type="button" class="btn-primary mobile-compose" on:click={openCompose}>+ Compose</button>
			<button type="button" class="mobile-avatar-button" aria-label="Profile & Appearance" title="Profile & Appearance" on:click={() => (showProfile = true)}>
				{#if profilePhoto}<img src={profilePhoto} alt="" />{:else}<span>{avatarInitial}</span>{/if}
			</button>
		</div>
	</header>
	{#if mobileNavOpen}<button type="button" class="mobile-nav-backdrop" aria-label="Close navigation" on:click={() => (mobileNavOpen = false)}></button>{/if}
	<!-- Pane 1: Sidebar -->
	<aside class="sidebar" class:is-open={mobileNavOpen}>
		<div class="brand">
			<span class="logo-dot"></span>
			<strong>GGacrux Mail</strong>
		</div>

		<button class="btn-primary compose-btn" title="Compose (Shortcut: C)" on:click={openCompose}>
			+ Compose
		</button>

		<nav class="nav-folders">
			<button class:active={folder === 'inbox'} on:click={() => switchFolder('inbox')}>
				<span>Inbox</span>
				{#if unreadCount > 0}
					<span class="badge">{unreadCount}</span>
				{/if}
			</button>
			<button class:active={folder === 'sent'} on:click={() => switchFolder('sent')}>
				<span>Sent</span>
			</button>
			<button class:active={folder === 'trash'} on:click={() => switchFolder('trash')}>
				<span>Trash</span>
			</button>
		</nav>

		<div class="smart-views"><strong>Smart Views</strong><button class:active={virtualFolder === "all"} on:click={() => selectVirtualView("all")}>All Mail</button><button class:active={virtualFolder === "attachments"} on:click={() => selectVirtualView("attachments")}>Has Attachments</button>{#each [...new Set(emails.map((mail) => mail.recipient_email).filter(Boolean))] as alias (alias)}<button class:active={virtualFolder === "alias:" + alias} on:click={() => selectVirtualView("alias:" + alias)}>↳ {alias}</button>{/each}</div>
		<div class="label-nav"><div class="quick-links-heading"><strong>Labels</strong><button class="quick-add" type="button" on:click={createLabel}>+</button></div>{#each labels as label (label.name)}<button class:active={activeTag === label.name} on:click={() => selectTag(label.name)}><span class="label-dot" style={"background:" + label.color}></span>{label.name}</button>{/each}</div>
		<div class="quick-links">
			<div class="quick-links-heading"><strong>Quick Links</strong><button class="quick-add" type="button" aria-label="Add quick link" title="Add bookmark" on:click={addQuickLink}>+</button></div>
			{#each quickLinks as link (link.id)}
				<div class="quick-link-item"><a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>{link.title}</a><button type="button" class="quick-remove" aria-label="Remove {link.title}" title="Remove bookmark" on:click={() => removeQuickLink(link.id)}>×</button></div>
			{/each}
		</div>
		<div class="sidebar-footer">
			{#if storage}
				<div class="storage-compact">
					<div class="storage-usage-label"><span>Mail DB</span><small>{formatBytes(storage.d1.usedBytes)} / 500 MB</small></div>
					<div class="storage-track"><span class={storageTone(storage.d1.usedBytes, storage.d1.limitBytes)} style={"width:" + storagePercent(storage.d1.usedBytes, storage.d1.limitBytes) + "%"}></span></div>
					<div class="storage-usage-label"><span>Attachments</span><small>{formatBytes(storage.r2.usedBytes)} / 10 GB</small></div>
					<div class="storage-track"><span class={storageTone(storage.r2.usedBytes, storage.r2.limitBytes)} style={"width:" + storagePercent(storage.r2.usedBytes, storage.r2.limitBytes) + "%"}></span></div>
				</div>
			{/if}
			<div class="sidebar-account-row">
				<button type="button" class="profile-trigger" on:click={() => (showProfile = true)} title="Profile & Appearance">
					{#if profilePhoto}<img class="profile-avatar" src={profilePhoto} alt="User avatar" />{:else}<span class="profile-avatar profile-initial">{avatarInitial}</span>{/if}
					<span class="profile-label"><strong>{profileName || 'Profile'}</strong><small class="user-email" title={userEmail}>{userEmail}</small></span>
				</button>
				<a href="/logout" class="btn-logout" on:click={handleLogout}>Log out</a>
			</div>
		</div>
	</aside>

	<!-- Pane 2: Message List -->
	<section class="message-list-pane" class:mobile-hidden={mobileShowDetail}>
		<div class="list-header">
			<input
				bind:this={searchInputEl}
				type="search"
				placeholder="Search {folder}... (/)"
				bind:value={searchQuery}
				on:input={handleSearchInput}
			/>
			<button
				class="btn-icon"
				class:active-filter={unreadOnly}
				title="Filter unread only"
				on:click={() => (unreadOnly = !unreadOnly)}
			>
				Unread
			</button>
			<button class="btn-icon" title="Refresh (Shortcut: R)" on:click={() => loadEmails()}>
				↻
			</button>
		</div>

		{#if selectedIds.length > 0}
			<div class="list-subbar bulk-toolbar" aria-label="Bulk message actions">
				<strong>{selectedIds.length} selected</strong>
				<div class="icon-toolbar">
					<button class="btn-icon" title="Mark as read" aria-label="Mark as read" on:click={() => bulkUpdate('read')}><svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg></button>
					<button class="btn-icon" title="Mark as unread" aria-label="Mark as unread" on:click={() => bulkUpdate('unread')}><svg viewBox="0 0 24 24"><path d="M4 6h16v12H4zM4 7l8 6 8-6"/></svg></button>
					<button class="btn-icon" title="Move to Trash" aria-label="Move to Trash" on:click={() => bulkUpdate('trash')}><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-10 0 1 14h10l1-14M10 10v6m4-6v6"/></svg></button>
					<button class="btn-icon danger-icon" title="Delete permanently" aria-label="Delete permanently" on:click={() => bulkUpdate('delete')}><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13"/></svg></button>
					<button class="btn-icon" title="Clear selection" aria-label="Clear selection" on:click={() => selectedIds = []}><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
				</div>
			</div>
		{/if}
		{#if folder === 'inbox' && unreadCount > 0}
			<div class="list-subbar">
				<span>{unreadCount} unread</span>
				<button class="btn-link" disabled={bulkWorking} on:click={markAllRead}>
					{bulkWorking ? 'Updating...' : 'Mark all read'}
				</button>
			</div>
		{:else if folder === 'trash' && emails.length > 0}
			<div class="list-subbar">
				<span>{emails.length} in Trash</span>
				<button class="btn-link danger" disabled={bulkWorking} on:click={emptyTrash}>
					{bulkWorking ? 'Emptying...' : 'Empty Trash'}
				</button>
			</div>
		{/if}

		{#if loadingList}
			<div class="skeleton-list" aria-label="Loading messages">{#each Array(6) as _}<div class="skeleton-row"></div>{/each}</div>
		{:else if visibleEmails.length === 0}
			<div class="empty-state">
				{unreadOnly ? `No unread messages in ${folder}.` : `No messages in ${folder}.`}
			</div>
		{:else}
			<ul class="message-list">
				{#each visibleEmails as item (item.id)}
					<li class="message-list-item">
						<label class="select-message"><input type="checkbox" checked={selectedIds.includes(item.id)} on:change={(event) => { selectedIds = (event.currentTarget as HTMLInputElement).checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id); }} aria-label="Select message" /></label>
						<button
							class="message-row"
							class:unread={item.is_read === 0}
							class:selected={selectedEmail?.id === item.id}
							on:click={() => selectEmail(item)}
						>
							<div class="message-row-content">
							<div class="row-top">
								<span class="party">
									{folder === 'sent'
										? `To: ${item.recipient_email}`
										: item.sender_name || item.sender_email}
								</span>
								<span class="date">{formatDate(item.created_at)}</span>
							</div>
							<div class="subject">{item.subject || '(No Subject)'}</div>
							{#if getEmailTags(item).length}<div class="tag-pills">{#each getEmailTags(item) as tag}<span class="tag-pill" style={"background:" + (labels.find((l) => l.name === tag)?.color || "#64748b")}>{tag}</span>{/each}</div>{/if}
							<div class="snippet">{item.snippet || ''}</div>
							</div>
						</button>
					</li>
				{/each}
				<li bind:this={sentinelEl} class="load-sentinel">
					{#if loadingMore}<span>Loading more…</span>{:else if hasMore}<button class="btn-link" on:click={loadMore}>Load more ({Math.max(0, totalCount - emails.length)} remaining)</button>{:else}<span>All messages loaded</span>{/if}
				</li>
			</ul>
		{/if}
	</section>

	<!-- Pane 3: Reading Pane -->
	<main class="reading-pane" class:mobile-hidden={!mobileShowDetail}>
		{#if loadingDetail}
			<div class="empty-state">Loading conversation...</div>
		{:else if !selectedEmail}
			<div class="empty-state">Select a message to read</div>
		{:else}
			<div class="reading-toolbar">
				<button class="btn-secondary mobile-back" on:click={() => { emailSelectionRequestId += 1; loadingDetail = false; mobileShowDetail = false; selectedEmail = null; attachments = []; }} title="Back to messages">← Back</button>
				<div class="icon-toolbar reading-actions">
					<button class="btn-icon" title="Reply" aria-label="Reply" on:click={() => selectedEmail && openReply(selectedEmail)}><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v3"/></svg></button>
					<button class="btn-icon" title="Reply all" aria-label="Reply all" on:click={() => selectedEmail && openReplyAll(selectedEmail)}><svg viewBox="0 0 24 24"><path d="m8 14-5-5 5-5M3 9h9a6 6 0 0 1 6 6v3M15 14l5-5-5-5"/></svg></button>
					<button class="btn-icon" title="Forward" aria-label="Forward" on:click={() => selectedEmail && openForward(selectedEmail)}><svg viewBox="0 0 24 24"><path d="m15 4 5 5-5 5M20 9H10a6 6 0 0 0-6 6v3"/></svg></button>
					<button class="btn-icon" title={selectedEmail.is_read === 1 ? 'Mark unread' : 'Mark read'} aria-label="Toggle read status" on:click={() => selectedEmail && toggleRead(selectedEmail)}><svg viewBox="0 0 24 24"><path d="M4 6h16v12H4zM4 7l8 6 8-6"/></svg></button>
					{#if selectedEmail.folder !== 'trash'}
						<button class="btn-icon" title="Move to Trash" aria-label="Move to Trash" on:click={() => selectedEmail && moveToFolder(selectedEmail.id, 'trash')}><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-10 0 1 14h10l1-14"/></svg></button>
					{:else}
						<button class="btn-icon" title="Restore to Inbox" aria-label="Restore to Inbox" on:click={() => selectedEmail && moveToFolder(selectedEmail.id, 'inbox')}><svg viewBox="0 0 24 24"><path d="M4 12h16M12 4l8 8-8 8"/></svg></button>
						<button class="btn-icon danger-icon" title="Delete permanently" aria-label="Delete permanently" on:click={() => selectedEmail && permanentDelete(selectedEmail.id)}><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13"/></svg></button>
					{/if}
				</div>
				<label class="tag-selector"><span>Labels</span><select aria-label="Labels / Tags" on:change={(event) => selectedEmail && toggleEmailTag(selectedEmail, (event.currentTarget as HTMLSelectElement).value)}><option value="">Add label…</option>{#each labels as label}<option value={label.name}>{label.name}</option>{/each}</select></label>
			</div>
			<header class="subject-header">{selectedEmail.subject || '(No Subject)'}</header>

			<div class="thread-container">
				{#each threadMessages.length ? threadMessages : [selectedEmail] as message, index (message.id)}
					<details class="thread-card" open={index === threadMessages.length - 1 || threadMessages.length === 0}>
						<summary><strong>{message.sender_name || message.sender_email}</strong><span>{formatDate(message.created_at)}</span><span>{message.subject || '(No Subject)'}</span></summary>
						<div class="meta-grid"><div><strong>From:</strong> {message.sender_email}</div><div><strong>To:</strong> {message.recipient_email}</div></div>
						{#if message.attachments?.length}<div class="attachments-bar">{#each message.attachments as att}<a class="attachment-chip" href="/api/attachments/{att.id}" download={att.filename}>📎 {att.filename} ({formatBytes(att.size_bytes)})</a>{/each}</div>{:else if message.id === selectedEmail.id && attachments.length}<div class="attachments-bar">{#each attachments as att}<a class="attachment-chip" href="/api/attachments/{att.id}" download={att.filename}>📎 {att.filename} ({formatBytes(att.size_bytes)})</a>{/each}</div>{/if}
						{#if message.html_body}<iframe class="thread-frame" title="Email content" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin" scrolling="no" srcdoc={buildSandboxedEmailHtml(message.html_body)} on:load={resizeEmailFrame}></iframe>{:else}<pre class="plain-body">{message.text_body || '(Empty message)'}</pre>{/if}
					</details>
				{/each}
			</div>
		{/if}
	</main>
</div>

<!-- Compose / Reply Modal -->
{#if showCompose}
	<div class="modal-backdrop" role="presentation">
		<div class="modal" class:expanded={composeExpanded} class:minimized={composeMinimized}>
			<div class="modal-header">
				<h3>{inReplyTo ? 'Reply' : 'New Message'}</h3>
				<div class="compose-window-actions"><button type="button" class="btn-icon" on:click={() => (composeMinimized = !composeMinimized)}>{composeMinimized ? 'Restore' : '—'}</button><button type="button" class="btn-icon" on:click={() => (composeExpanded = !composeExpanded)}>{composeExpanded ? 'Shrink' : 'Expand'}</button><button type="button" class="btn-icon" on:click={() => { if (confirm('Discard this draft?')) { localStorage.removeItem(draftKey); restoredDraft = false; to = ''; cc = ''; bcc = ''; subject = ''; textBody = ''; showCompose = false; } }}>Discard</button></div>
			</div>

			{#if !composeMinimized}
			<form on:submit|preventDefault={sendEmail}>
				<div class="form-row"><label for="fromAlias">From (locked)</label><input id="fromAlias" type="email" value={userEmail} readonly aria-readonly="true" class="locked-field" /></div>
				<div class="form-row">
					<label for="fromName">From name</label><input id="fromName" bind:value={fromName} />
				</div>
				<div class="form-row">
					<label for="to">To</label>
					<input id="to" type="text" placeholder="recipient@example.com (comma-separated)" bind:value={to} required />
				</div>
				<div class="form-row"><button type="button" class="btn-link" on:click={() => (showCcBcc = !showCcBcc)}>{showCcBcc ? 'Hide CC / BCC' : 'Add CC / BCC'}</button></div>
				{#if showCcBcc}<div class="form-row"><label for="cc">CC</label><input id="cc" bind:value={cc} placeholder="Separate addresses with commas" /></div><div class="form-row"><label for="bcc">BCC</label><input id="bcc" bind:value={bcc} placeholder="Separate addresses with commas" /></div>{/if}
				<div class="form-row">
					<label for="subject">Subject</label>
					<input id="subject" type="text" placeholder="Subject" bind:value={subject} required />
				</div>
				<div class="form-row"><span class="field-label">Message</span>
					<div class="format-toolbar" role="toolbar" aria-label="Message formatting">
						<select aria-label="Font family" title="Font family" on:change={(event) => applyFont(editorEl, (event.currentTarget as HTMLSelectElement).value)}>
							<option value="Arial">Default</option><option value="Arial, sans-serif">Sans-Serif</option><option value="Georgia, serif">Serif</option><option value="monospace">Monospace</option><option value="Georgia">Georgia</option><option value="Verdana">Verdana</option>
						</select>
						<label class="color-control" title="Text color">A<input type="color" aria-label="Text color" on:input={(event) => applyTextColor(editorEl, (event.currentTarget as HTMLInputElement).value)} /></label>
						<button type="button" class="btn-icon" title="Bold" aria-label="Bold" on:click={() => formatCommand('bold')}><svg viewBox="0 0 24 24"><path d="M7 5h7a4 4 0 0 1 0 8H7zM7 13h8a4 4 0 0 1 0 8H7z"/></svg></button>
						<button type="button" class="btn-icon" title="Italic" aria-label="Italic" on:click={() => formatCommand('italic')}><svg viewBox="0 0 24 24"><path d="M14 4h6M4 20h6M14 4 10 20"/></svg></button>
						<button type="button" class="btn-icon" title="Underline" aria-label="Underline" on:click={() => formatCommand('underline')}><svg viewBox="0 0 24 24"><path d="M7 4v7a5 5 0 0 0 10 0V4M5 21h14"/></svg></button>
						<button type="button" class="btn-icon" title="Strikethrough" aria-label="Strikethrough" on:click={() => formatCommand('strikeThrough')}><svg viewBox="0 0 24 24"><path d="M4 12h16M7 7c0-4 10-4 10 0M7 17c0 4 10 4 10 0"/></svg></button>
						<button type="button" class="btn-icon" title="Bulleted list" aria-label="Bulleted list" on:click={() => formatCommand('insertUnorderedList')}><svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg></button>
						<button type="button" class="btn-icon" title="Numbered list" aria-label="Numbered list" on:click={() => formatCommand('insertOrderedList')}><svg viewBox="0 0 24 24"><path d="M10 6h10M10 12h10M10 18h10M4 5h1v3M4 12h2l-2 2h2M4 17h2l-2 2h2"/></svg></button>
						<button type="button" class="btn-icon" title="Blockquote" aria-label="Blockquote" on:click={() => formatCommand('formatBlock','blockquote')}><svg viewBox="0 0 24 24"><path d="M4 7h7v7H5l-1 4M13 7h7v7h-6l-1 4"/></svg></button>
						<button type="button" class="btn-icon" title="Insert link" aria-label="Insert link" on:click={() => formatCommand('createLink')}><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21.1l1.7-1.7"/></svg></button>
						<button type="button" class="btn-icon" title="Clear formatting" aria-label="Clear formatting" on:click={() => formatCommand('removeFormat')}><svg viewBox="0 0 24 24"><path d="m4 7 4-4 12 12-4 4zM3 21h18"/></svg></button>
						<button type="button" class="btn-icon html-toggle" class:active-filter={htmlMode} title="Toggle HTML source" aria-label="Toggle HTML source" on:click={() => { if (!htmlMode) updateVisualBody(); htmlMode = !htmlMode; }}>&lt;&gt;</button>
					</div>
					{#if !htmlMode}<div bind:this={editorEl} class="rich-editor" contenteditable="true" dir="ltr" role="textbox" aria-label="Message body" aria-multiline="true" on:input={updateVisualBody} on:paste={handleEditorPaste}>{@html htmlBody}</div>{:else}<textarea class="html-source" rows="12" bind:value={htmlBody} on:input={() => textBody = htmlBody.replace(/<[^>]*>/g, ' ')}></textarea>{/if}
				</div>
				<div class="form-row"><label for="attachments-picker">Attachments (10 MB total)</label><input id="attachments-picker" type="file" multiple on:change={handleFiles} /><div class="file-chips">{#each attachmentFiles as file, index}<span class="attachment-chip">{file.name} · {formatBytes(file.size)} <button type="button" aria-label="Remove {file.name}" on:click={() => removeFile(index)}>×</button></span>{/each}</div>{#if attachmentError}<div class="error-banner">{attachmentError}</div>{/if}</div>

				{#if composeError}
					<div class="error-banner">{composeError}</div>
				{/if}

				<div class="modal-footer">
					<button type="button" class="btn-secondary" on:click={() => (composeMinimized = true)}>Minimize</button>
					<button type="submit" class="btn-primary" disabled={sending || !!attachmentError || attachmentFiles.reduce((sum, file) => sum + file.size, 0) > attachmentLimit}>
						{sending ? 'Sending...' : 'Send Email'}
					</button>
				</div>
			</form>
			{/if}
		</div>
	</div>
{/if}

{#if showProfile}
	<div class="modal-backdrop settings-backdrop" role="presentation">
		<div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
			<div class="modal-header"><h3 id="profile-title">Profile &amp; Appearance</h3><button class="btn-icon" type="button" on:click={() => { saveProfile(); showProfile = false; }}>✕</button></div>
			<div class="profile-editor">
				{#if profilePhoto}<img class="profile-preview" src={profilePhoto} alt="Profile preview" />{:else}<span class="profile-preview profile-initial">{avatarInitial}</span>{/if}
				<div><label class="field-label" for="profile-photo">Profile picture</label><input id="profile-photo" type="file" accept="image/*" on:change={handleProfilePhoto} /><button class="btn-link" type="button" on:click={() => { profilePhoto = ''; saveProfile(); }}>Remove photo</button></div>
			</div>
			<div class="form-row"><label for="profile-name">Display name</label><input id="profile-name" bind:value={profileName} on:input={saveProfile} /></div>
			<div class="form-row"><span class="field-label">Email signature</span>
				<div class="format-toolbar signature-toolbar" role="toolbar" aria-label="Signature formatting">
					<select aria-label="Signature font family" title="Font family" on:change={(event) => applyFont(signatureEditorEl, (event.currentTarget as HTMLSelectElement).value)}><option value="Arial">Default</option><option value="Arial, sans-serif">Sans-Serif</option><option value="Georgia, serif">Serif</option><option value="monospace">Monospace</option><option value="Georgia">Georgia</option><option value="Verdana">Verdana</option></select>
					<label class="color-control" title="Signature text color">A<input type="color" aria-label="Signature text color" on:input={(event) => applyTextColor(signatureEditorEl, (event.currentTarget as HTMLInputElement).value)} /></label>
					<button type="button" class="btn-icon" title="Bold" aria-label="Bold" on:click={() => runEditorCommand(signatureEditorEl,'bold')}><svg viewBox="0 0 24 24"><path d="M7 5h7a4 4 0 0 1 0 8H7zM7 13h8a4 4 0 0 1 0 8H7z"/></svg></button>
					<button type="button" class="btn-icon" title="Italic" aria-label="Italic" on:click={() => runEditorCommand(signatureEditorEl,'italic')}><svg viewBox="0 0 24 24"><path d="M14 4h6M4 20h6M14 4 10 20"/></svg></button>
					<button type="button" class="btn-icon" title="Underline" aria-label="Underline" on:click={() => runEditorCommand(signatureEditorEl,'underline')}><svg viewBox="0 0 24 24"><path d="M7 4v7a5 5 0 0 0 10 0V4M5 21h14"/></svg></button>
					<button type="button" class="btn-icon" title="Insert link" aria-label="Insert link" on:click={() => runEditorCommand(signatureEditorEl,'createLink')}><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21.1l1.7-1.7"/></svg></button>
					<button type="button" class="btn-icon" title="Clear formatting" aria-label="Clear formatting" on:click={() => runEditorCommand(signatureEditorEl,'removeFormat')}><svg viewBox="0 0 24 24"><path d="m4 7 4-4 12 12-4 4zM3 21h18"/></svg></button>
				</div>
				<div id="profile-signature-editor" bind:this={signatureEditorEl} class="rich-editor signature-editor" contenteditable="true" role="textbox" aria-label="Rich text email signature" aria-multiline="true" on:input={updateSignature}>{@html signatureHtml}</div>
			</div>
			<div class="form-row"><span class="field-label">Theme</span><div class="theme-options">
				<button type="button" class:theme-active={selectedTheme === 'slate'} on:click={() => changeTheme('slate')}>Slate Light</button>
				<button type="button" class:theme-active={selectedTheme === 'midnight'} on:click={() => changeTheme('midnight')}>Midnight Dark</button>
				<button type="button" class:theme-active={selectedTheme === 'nordic'} on:click={() => changeTheme('nordic')}>Nordic Blue</button>
			</div></div>
			{#if storage}<div class="settings-storage"><h4>Storage usage</h4><p><strong>Mail DB (D1):</strong> {formatBytes(storage.d1.usedBytes)} / 500 MB · {storage.d1.emailCount} emails</p><div class="storage-track"><span class={storageTone(storage.d1.usedBytes, storage.d1.limitBytes)} style={"width:" + storagePercent(storage.d1.usedBytes, storage.d1.limitBytes) + "%"}></span></div><p><strong>Attachments (R2):</strong> {formatBytes(storage.r2.usedBytes)} / 10 GB · {storage.r2.fileCount} files</p><div class="storage-track"><span class={storageTone(storage.r2.usedBytes, storage.r2.limitBytes)} style={"width:" + storagePercent(storage.r2.usedBytes, storage.r2.limitBytes) + "%"}></span></div></div>{/if}<div class="modal-footer"><button class="btn-primary" type="button" on:click={() => { saveProfile(); showProfile = false; }}>Save changes</button></div>
		</div>
	</div>
{/if}

{#if statusMessage}
	<div class="toast">{statusMessage}</div>
{/if}

<style>
	:global(*) {
		box-sizing: border-box;
	}
	:global(body) {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		color: #0f172a;
		background: #f8fafc;
	}

	:global(:focus-visible) { outline: 3px solid #60a5fa; outline-offset: 2px; }
	:global(::-webkit-scrollbar) { width: 10px; height: 10px; }
	:global(::-webkit-scrollbar-thumb) { background: #94a3b8; border: 2px solid transparent; background-clip: padding-box; border-radius: 999px; }
	.app-shell {
		display: grid;
		grid-template-columns: 220px 340px 1fr;
		height: 100vh;
		overflow: hidden;
	}

	/* Sidebar */
	.sidebar {
		background: #0f172a;
		color: #f8fafc;
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-width: 0;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 16px;
	}
	.logo-dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #38bdf8;
	}
	.compose-btn {
		width: 100%;
		padding: 10px;
		font-weight: 600;
	}
	.nav-folders {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.nav-folders button {
		display: flex;
		justify-content: space-between;
		align-items: center;
		background: transparent;
		border: none;
		color: #cbd5e1;
		padding: 10px 12px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 14px;
		text-align: left;
	}
	.nav-folders button:hover {
		background: #1e293b;
		color: #fff;
	}
	.nav-folders button.active {
		background: #2563eb;
		color: #fff;
		font-weight: 600;
	}
	.badge {
		background: #38bdf8;
		color: #0f172a;
		font-size: 11px;
		font-weight: 700;
		padding: 2px 7px;
		border-radius: 999px;
	}
	.sidebar-footer {
		margin-top: auto;
		padding-top: 12px;
		border-top: 1px solid #1e293b;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 12px;
		color: #94a3b8;
	}
	.user-email {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.btn-logout {
		flex-shrink: 0;
		padding: 5px 10px;
		border-radius: 5px;
		background: #1e293b;
		color: #e2e8f0;
		text-decoration: none;
		font-weight: 500;
		transition: background 0.15s ease, color 0.15s ease;
	}
	.btn-logout:hover {
		background: #dc2626;
		color: #ffffff;
	}

	/* Message List */
	.message-list-pane {
		border-right: 1px solid #e2e8f0;
		background: #fff;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.list-header {
		padding: 12px;
		border-bottom: 1px solid #e2e8f0;
		display: flex;
		gap: 6px;
	}
	.list-header input {
		flex: 1;
		min-width: 0;
		padding: 8px 10px;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		font-size: 14px;
	}
	.list-subbar {
		padding: 6px 12px;
		background: #f8fafc;
		border-bottom: 1px solid #e2e8f0;
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 12px;
		color: #64748b;
	}
	.btn-link {
		background: none;
		border: none;
		padding: 0;
		font-size: 12px;
		font-weight: 600;
		color: #2563eb;
		cursor: pointer;
	}
	.btn-link:hover {
		text-decoration: underline;
	}
	.btn-link.danger {
		color: #dc2626;
	}
	.btn-link:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.message-list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		flex: 1;
	}
	.message-list-item { display:flex; align-items:stretch; border-bottom:1px solid #f1f5f9; }
	.select-message { display:flex; align-items:flex-start; padding:18px 0 0 10px; }
	.message-list-item .message-row { flex:1; }
	.message-row {
		width: 100%;
		text-align: left;
		background: #fff;
		border: none;
		border-bottom: 1px solid #f1f5f9;
		padding: 12px 14px;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.message-row:hover {
		background: #f8fafc;
	}
	.message-row.selected {
		background: #eff6ff;
		border-left: 3px solid #2563eb;
	}
	.message-row.unread .party,
	.message-row.unread .subject {
		font-weight: 700;
		color: #0f172a;
	}
	.row-top {
		display: flex;
		justify-content: space-between;
		font-size: 13px;
		color: #334155;
	}
	.party {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 220px;
	}
	.date {
		font-size: 12px;
		color: #64748b;
	}
	.subject {
		font-size: 14px;
		color: #1e293b;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.snippet {
		font-size: 12px;
		color: #64748b;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Reading Pane */
	.reading-pane {
		background: #fff;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.reading-toolbar {
		padding: 12px 16px;
		border-bottom: 1px solid #e2e8f0;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
	}
	.toolbar-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.email-header {
		padding: 16px 20px;
		border-bottom: 1px solid #e2e8f0;
	}
	.meta-grid {
		font-size: 13px;
		color: #475569;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.attachments-bar {
		margin-top: 12px;
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.attachment-chip {
		display: inline-block;
		padding: 6px 10px;
		background: #f1f5f9;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		font-size: 12px;
		color: #0f172a;
		text-decoration: none;
	}
	.attachment-chip:hover {
		background: #e2e8f0;
	}
	.attachment-chip.disabled {
		color: #64748b;
	}
	.email-body-container {
		flex: 1;
		overflow: hidden;
		display: flex;
	}
	.plain-body {
		margin: 0;
		padding: 20px;
		white-space: pre-wrap;
		font-family: inherit;
		font-size: 14px;
		line-height: 1.6;
		overflow-y: auto;
		width: 100%;
	}
	.empty-state {
		margin: auto;
		color: #64748b;
		font-size: 14px;
		padding: 24px;
	}

	/* Buttons */
	.btn-primary {
		background: #2563eb;
		color: #fff;
		border: none;
		padding: 8px 14px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
	}
	.btn-primary:hover {
		background: #1d4ed8;
	}
	.btn-secondary {
		background: #f1f5f9;
		color: #0f172a;
		border: 1px solid #cbd5e1;
		padding: 8px 12px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
	}
	.btn-secondary:hover {
		background: #e2e8f0;
	}
	.btn-danger {
		background: #dc2626;
		color: #fff;
		border: none;
		padding: 8px 12px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
	}
	.btn-danger:hover {
		background: #b91c1c;
	}
	.btn-icon {
		background: #f1f5f9;
		color: #0f172a;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 12px;
		cursor: pointer;
	}
	.btn-icon:hover {
		background: #e2e8f0;
	}
	.btn-icon.active-filter {
		background: #2563eb;
		color: #fff;
		border-color: #2563eb;
		font-weight: 600;
	}

	/* Modal */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(15, 23, 42, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
		z-index: 50;
	}
	.modal {
		background: #fff;
		width: 100%;
		max-width: 600px;
		border-radius: 10px;
		padding: 20px;
		box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.15);
	}
	.modal.expanded { max-width: none; width: calc(100vw - 32px); height: calc(100vh - 32px); overflow-y: auto; }
	.modal.minimized { position: fixed; right: 18px; bottom: 18px; width: min(360px, calc(100vw - 36px)); padding: 12px; }
	.modal-backdrop:has(.modal.minimized) { background: transparent; pointer-events: none; align-items: flex-end; justify-content: flex-end; }
	.modal-backdrop:has(.modal.minimized) .modal { pointer-events: auto; }
	.compose-window-actions { display:flex; gap:6px; align-items:center; }
	.skeleton-list { padding: 12px; display:grid; gap:10px; }
	.skeleton-row { height:72px; border-radius:8px; background:linear-gradient(90deg,#f1f5f9,#e2e8f0,#f1f5f9); background-size:200% 100%; animation: shimmer 1.4s infinite; }
	@keyframes shimmer { to { background-position-x:-200%; } }
	.load-sentinel { min-height:42px; display:flex; align-items:center; justify-content:center; color:#64748b; font-size:12px; }
	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 14px;
	}
	.modal-header h3 {
		margin: 0;
	}
	.form-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 12px;
	}
	.form-row label {
		font-size: 12px;
		font-weight: 600;
		color: #475569;
	}
	.form-row input,
	.form-row textarea {
		padding: 8px 10px;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		font-size: 14px;
		font-family: inherit;
	}
	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
	}
	.error-banner {
		background: #fee2e2;
		color: #991b1b;
		padding: 8px 12px;
		border-radius: 6px;
		font-size: 13px;
	}
	.toast {
		position: fixed;
		bottom: 20px;
		right: 20px;
		background: #0f172a;
		color: #fff;
		padding: 10px 16px;
		border-radius: 8px;
		font-size: 13px;
		z-index: 60;
	}

	.mobile-back { display:none; }
	.mobile-header, .mobile-nav-backdrop, .sidebar-close { display:none; }

	:global(:root), :global(:root[data-theme='slate']) {
		--bg-app: #f8fafc; --bg-surface: #ffffff; --bg-sidebar: #0f172a;
		--text-primary: #0f172a; --text-secondary: #64748b; --border-color: #e2e8f0; --accent-color: #2563eb;
	}
	:global(:root[data-theme='midnight']) {
		color-scheme: dark; --bg-app:#0b1220; --bg-surface:#111c2e; --bg-sidebar:#080e19;
		--text-primary:#e5edf8; --text-secondary:#a7b6ca; --border-color:#29384d; --accent-color:#60a5fa;
	}
	:global(:root[data-theme='nordic']) {
		color-scheme: light; --bg-app:#eaf0f6; --bg-surface:#f5f8fc; --bg-sidebar:#26384c;
		--text-primary:#26384c; --text-secondary:#60758d; --border-color:#cbd8e5; --accent-color:#477da8;
	}
	:global(body) { color:var(--text-primary); background:var(--bg-app); }
	.sidebar { background:var(--bg-sidebar); }
	.message-list-pane, .reading-pane { background:var(--bg-surface); color:var(--text-primary); border-color:var(--border-color); }
	.message-row { background:var(--bg-surface); color:var(--text-primary); border-color:var(--border-color); }
	.message-row:hover { background:var(--bg-app); }
	.message-row.unread .party, .message-row.unread .subject, .subject { color:var(--text-primary); }
	.party, .date, .snippet, .meta-grid { color:var(--text-secondary); }
	.list-header, .list-subbar, .reading-toolbar, .email-header { border-color:var(--border-color); background:var(--bg-surface); }
	.btn-primary, .nav-folders button.active { background:var(--accent-color); }
	.message-list-item { display:flex; align-items:stretch; min-width:0; overflow:hidden; border-bottom:1px solid var(--border-color); }
	.select-message { flex:0 0 30px; min-width:30px; display:flex; align-items:flex-start; padding:18px 0 0 10px; }
	.message-list-item .message-row { flex:1; min-width:0; overflow:hidden; padding-right:18px; }
	.message-row-content { flex:1; min-width:0; overflow:hidden; padding-right:4px; }
	.row-top { display:flex; justify-content:space-between; gap:8px; align-items:center; min-width:0; font-size:13px; }
	.party { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:none; }
	.date { flex-shrink:0; white-space:nowrap; font-size:12px; color:var(--text-secondary); }
	.subject, .snippet { display:block; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.quick-links { display:flex; flex-direction:column; gap:4px; padding:4px 2px 12px; border-bottom:1px solid #334155; }
	.quick-links-heading, .quick-link-item { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
	.quick-links-heading { color:#e2e8f0; font-size:12px; padding:0 8px 4px; }
	.quick-add, .quick-remove { border:0; background:transparent; color:#cbd5e1; cursor:pointer; border-radius:4px; font-size:17px; line-height:1; padding:3px 6px; }
	.quick-add:hover, .quick-remove:hover { background:#334155; color:#fff; }
	.quick-link-item a { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#cbd5e1; text-decoration:none; font-size:13px; padding:5px 8px; flex:1; }
	.quick-link-item a:hover { color:#fff; text-decoration:underline; }
	.quick-remove { opacity:0; flex-shrink:0; }
	.quick-link-item:hover .quick-remove, .quick-remove:focus-visible { opacity:1; }
	.sidebar-footer { align-items:center; }
	.profile-trigger { display:flex; align-items:center; gap:9px; min-width:0; flex:1; text-align:left; border:0; padding:4px; border-radius:7px; background:transparent; color:#e2e8f0; cursor:pointer; }
	.profile-trigger:hover { background:#1e293b; }
	.profile-avatar { width:34px; height:34px; flex:0 0 34px; border-radius:50%; object-fit:cover; }
	.profile-initial { display:inline-flex; align-items:center; justify-content:center; background:#38bdf8; color:#0f172a; font-weight:700; }
	.profile-label { display:flex; flex-direction:column; min-width:0; gap:2px; }
	.profile-label strong, .profile-label small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:135px; }
	.profile-label strong { color:#f8fafc; font-size:12px; }
	.profile-label small { color:#94a3b8; font-size:10px; }
	.settings-modal { max-height:calc(100vh - 32px); overflow-y:auto; }
	.profile-editor { display:flex; align-items:center; gap:16px; margin:8px 0 18px; }
	.profile-preview { width:76px; height:76px; flex:0 0 76px; border-radius:50%; object-fit:cover; font-size:28px; }
	.field-label { display:block; font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:6px; }
	.theme-options { display:flex; flex-wrap:wrap; gap:8px; }
	.theme-options button { padding:8px 11px; border:1px solid var(--border-color); border-radius:7px; background:var(--bg-surface); color:var(--text-primary); cursor:pointer; }
	.theme-options button.theme-active { border:2px solid var(--accent-color); background:var(--bg-app); font-weight:700; }
	.settings-modal { background:var(--bg-surface); color:var(--text-primary); }
	.settings-modal .form-row input { background:var(--bg-surface); color:var(--text-primary); border-color:var(--border-color); }
	.settings-modal .modal-header { border-color:var(--border-color); }
	.settings-modal .form-row label { color:var(--text-secondary); }
	:global(:root[data-theme='midnight']) .list-subbar { color:var(--text-secondary); }
	:global(:root[data-theme='midnight']) .btn-secondary, :global(:root[data-theme='midnight']) .btn-icon { background:#1d2b40; color:#e5edf8; border-color:#34465e; }
	:global(:root[data-theme='midnight']) .attachment-chip { background:#1d2b40; color:#e5edf8; border-color:#34465e; }
	@media (max-width:900px) {
		.quick-links { display:none; }
		.profile-label { display:none; }
		.profile-trigger { flex:0 0 auto; }
		.profile-avatar { width:30px; height:30px; flex-basis:30px; }
	}

	.smart-views,.label-nav{display:flex;flex-direction:column;gap:3px;padding:4px 2px 10px;border-bottom:1px solid #334155}.smart-views strong,.label-nav .quick-links-heading{color:#e2e8f0;font-size:12px;padding:3px 8px}.smart-views button,.label-nav>button{display:flex;align-items:center;gap:8px;text-align:left;border:0;border-radius:5px;background:transparent;color:#cbd5e1;padding:7px 9px;cursor:pointer;font-size:12px;overflow:hidden;text-overflow:ellipsis}.smart-views button:hover,.label-nav>button:hover,.smart-views button.active,.label-nav>button.active{background:#334155;color:#fff}.label-dot{width:8px;height:8px;border-radius:50%;flex:0 0 8px}.storage-compact{width:100%;display:grid;gap:4px;color:#cbd5e1;font-size:10px}.storage-compact>div:not(.storage-track){display:flex;justify-content:space-between;gap:5px}.storage-compact small{color:#94a3b8;font-size:9px;white-space:nowrap}.storage-track{height:5px;background:#334155;border-radius:8px;overflow:hidden;width:100%}.storage-track span{display:block;height:100%;background:#38bdf8;border-radius:8px}.storage-track span.warning{background:#f59e0b}.storage-track span.danger{background:#ef4444}.tag-pills{display:flex;gap:4px;overflow:hidden}.tag-pill{font-size:10px;color:#fff;border-radius:10px;padding:2px 7px;white-space:nowrap}.thread-container{flex:1;overflow-y:auto;padding:14px;display:grid;align-content:start;gap:10px}.thread-card{border:1px solid var(--border-color);border-radius:8px;background:var(--bg-surface);overflow:hidden}.thread-card summary{display:flex;gap:12px;align-items:center;padding:12px;cursor:pointer;font-size:12px;color:var(--text-secondary)}.thread-card summary strong{color:var(--text-primary)}.thread-card summary span:last-child{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}.thread-card .meta-grid{padding:0 12px 10px}.thread-frame{width:100%;min-height:240px;border:0;background:#fff}.locked-field{background:#e2e8f0!important;color:#64748b!important;cursor:not-allowed!important}.compose-mode,.format-toolbar,.file-chips{display:flex;flex-wrap:wrap;gap:5px;margin:5px 0}.rich-editor,.html-source{width:100%;min-height:220px;padding:10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#0f172a;font:14px/1.5 sans-serif;overflow:auto}.rich-editor{direction:ltr;unicode-bidi:normal;text-align:left}.rich-editor:focus{outline:2px solid #60a5fa}.file-chips .attachment-chip button{border:0;background:transparent;cursor:pointer;font-size:16px}.settings-storage{margin-top:18px;padding:12px;border:1px solid var(--border-color);border-radius:8px}.settings-storage p{font-size:12px;color:var(--text-secondary)}


	/* Unified one-line icon toolbars and resilient reading pane */
	.icon-toolbar { display:flex; flex-wrap:nowrap; align-items:center; gap:4px; white-space:nowrap; min-width:0; }
	.icon-toolbar .btn-icon,.format-toolbar .btn-icon { width:32px; height:32px; padding:7px; flex:0 0 32px; display:inline-flex; align-items:center; justify-content:center; }
	.icon-toolbar svg,.format-toolbar svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
	.bulk-toolbar { display:flex; flex-wrap:nowrap; align-items:center; justify-content:flex-start; gap:8px; overflow-x:auto; white-space:nowrap; }
	.bulk-toolbar strong { flex:0 0 auto; }
	.reading-toolbar { flex-wrap:nowrap; min-width:0; }
	.reading-actions { overflow-x:auto; scrollbar-width:none; }
	.reading-actions::-webkit-scrollbar { display:none; }
	.tag-selector { display:flex; flex:0 0 auto; align-items:center; gap:6px; white-space:nowrap; font-size:12px; }
	.tag-selector select { max-width:130px; min-width:0; padding:6px; border:1px solid var(--border-color); border-radius:6px; background:var(--bg-surface); color:var(--text-primary); }
	.subject-header { flex:0 0 auto; padding:16px 20px; border-bottom:1px solid var(--border-color); font-size:1.25rem; font-weight:600; line-height:1.35; overflow-wrap:anywhere; }
	.thread-container { display:flex; flex:1 1 auto; flex-direction:column; height:100%; min-height:0; overflow-y:auto; overflow-x:hidden; gap:10px; }
	.thread-card { flex:0 0 auto; overflow:visible; }
	.thread-frame { display:block; width:100%; height:450px; min-height:450px; border:0; background:#fff; flex:0 0 auto; }
	.sidebar-footer { display:flex; flex-direction:column; align-items:stretch; gap:10px; min-width:0; }
	.storage-compact { display:grid; gap:4px; width:100%; white-space:nowrap; }
	.storage-usage-label { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; white-space:nowrap; }
	.storage-usage-label span,.storage-usage-label small { overflow:hidden; text-overflow:ellipsis; }
	.sidebar-account-row { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; padding-top:8px; border-top:1px solid #334155; }
	.sidebar-account-row .profile-trigger { flex:1; min-width:0; display:flex; align-items:center; gap:8px; cursor:pointer; }
	.sidebar-account-row .btn-logout { flex-shrink:0; }
	.profile-avatar { width:32px; height:32px; flex:0 0 32px; }
	.profile-label { min-width:0; flex:1; }
	.profile-label strong,.profile-label small { display:block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.format-toolbar { display:flex; flex-wrap:nowrap; align-items:center; gap:4px; margin:5px 0; overflow-x:auto; scrollbar-width:none; white-space:nowrap; min-width:0; }
	.format-toolbar::-webkit-scrollbar { display:none; }
	.format-toolbar select { height:32px; max-width:150px; flex:0 0 auto; border:1px solid #cbd5e1; border-radius:6px; padding:4px 6px; background:#fff; color:#0f172a; font-size:12px; }
	.color-control { position:relative; display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; flex:0 0 32px; border:1px solid #cbd5e1; border-radius:6px; background:#f1f5f9; color:#0f172a; font-weight:700; cursor:pointer; }
	.color-control input { position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer; padding:0!important; }
	.html-toggle { margin-left:auto; flex:0 0 auto; }
	.signature-editor { min-height:110px; }
	.signature-toolbar { margin-bottom:6px; }
	.danger-icon { color:#dc2626; }
	@media (max-width:900px) {
		.reading-toolbar { flex-direction:row; align-items:center; }
		.reading-actions { flex:1 1 auto; }
		.sidebar-footer { min-width:205px; margin-left:auto; padding-top:8px; border-top:1px solid #334155; }
		.sidebar-account-row .profile-label { display:flex; }
		.sidebar-account-row .profile-avatar { width:32px; height:32px; flex-basis:32px; }
	}


	/* Tablet and mobile: compact header, slide-over navigation, master/detail */
	:global(html), :global(body) { max-width:100%; overflow-x:hidden; }
	.app-shell { min-width:0; max-width:100%; }
	.message-list-pane, .reading-pane { min-width:0; width:100%; }
	.list-header { min-width:0; width:100%; }
	@media (max-width: 960px) {
		:global(html), :global(body) { width:100%; overflow-x:hidden; }
		.app-shell {
			height:100dvh; width:100%; max-width:100vw; min-width:0;
			grid-template-columns:minmax(0, 1fr);
			grid-template-rows:56px minmax(0, 1fr);
			gap:0; overflow-x:hidden;
		}
		.mobile-header {
			grid-row:1; grid-column:1; height:56px; min-width:0; width:100%;
			padding:0 12px; background:var(--bg-sidebar); color:#f8fafc;
			display:flex; align-items:center; justify-content:space-between; gap:10px;
			position:relative; z-index:20;
		}
		.mobile-header-brand, .mobile-header-actions {
			display:flex; align-items:center; min-width:0; gap:10px;
		}
		.mobile-header-brand { flex:1 1 auto; overflow:hidden; }
		.mobile-header-brand strong { white-space:nowrap; font-size:15px; }
		.mobile-menu-button {
			flex:0 0 34px; width:34px; height:34px; border:0; border-radius:6px;
			background:transparent; color:#fff; font-size:22px; cursor:pointer;
		}
		.mobile-header-actions { flex:0 0 auto; gap:9px; }
		.mobile-compose { white-space:nowrap; flex:0 0 auto; padding:8px 10px; font-size:12px; }
		.mobile-avatar-button {
			width:30px; height:30px; flex:0 0 30px; padding:0; border:0; border-radius:50%;
			overflow:hidden; background:#38bdf8; color:#0f172a; font-weight:700; cursor:pointer;
			display:flex; align-items:center; justify-content:center;
		}
		.mobile-avatar-button img { width:100%; height:100%; object-fit:cover; }
		.mobile-nav-backdrop {
			display:block; position:fixed; inset:0; z-index:59; border:0;
			background:rgba(2,6,23,.55);
		}
		.sidebar {
			position:fixed; top:0; left:0; bottom:0; width:270px;
			max-width:calc(100vw - 48px); height:100dvh; z-index:60;
			transform:translateX(-100%); transition:transform .2s ease;
			overflow-y:auto; overflow-x:hidden; flex-direction:column;
			align-items:stretch; padding:16px; gap:16px;
			box-shadow:0 12px 36px rgba(0,0,0,.24);
		}
		.sidebar.is-open { transform:translateX(0); }
		.sidebar .brand { width:100%; }
		.sidebar-close {
			margin-left:auto; display:inline-flex; align-items:center; justify-content:center;
			width:30px; height:30px; border:0; border-radius:6px;
			background:#1e293b; color:#fff; font-size:22px; cursor:pointer;
		}
		.sidebar .compose-btn { width:100%; white-space:nowrap; }
		.sidebar .nav-folders { flex-direction:column; }
		.sidebar .sidebar-footer {
			min-width:0; width:100%; margin:auto 0 0; padding-top:12px;
			border-top:1px solid #334155; align-items:stretch;
		}
		.sidebar .profile-label { display:flex; }
		.sidebar .profile-avatar { width:32px; height:32px; flex-basis:32px; }
		.sidebar .user-email { display:block; }
		.sidebar .quick-links { display:flex; }
		.message-list-pane, .reading-pane {
			grid-column:1; grid-row:2; width:100%; min-width:0;
			max-width:100%; height:100%; overflow:hidden;
		}
		.message-list-pane.mobile-hidden, .reading-pane.mobile-hidden { display:none; }
		.list-header {
			padding:10px 8px; gap:6px; flex-wrap:nowrap; align-items:center;
		}
		.list-header input { flex:1 1 0; width:0; min-width:0; }
		.list-header .btn-icon { flex:0 0 auto; white-space:nowrap; padding:7px 8px; }
		.mobile-back {
			display:inline-flex; align-items:center; justify-content:center;
			flex:0 0 auto; white-space:nowrap; padding:8px 10px; font-weight:600;
		}
		.reading-toolbar {
			flex-direction:row; align-items:center; justify-content:flex-start;
			flex-wrap:nowrap; gap:6px; padding:8px; min-width:0;
		}
		.reading-actions { flex:1 1 auto; min-width:0; }
		.tag-selector { flex:0 1 auto; min-width:0; }
		.tag-selector span { display:none; }
		.tag-selector select { max-width:94px; }
	}
	@media (max-width: 640px) {
		.modal-backdrop { padding:8px; align-items:center; }
		.modal, .modal.expanded {
			width:calc(100vw - 16px); max-width:calc(100vw - 16px);
			max-height:92vh; height:auto; border-radius:10px; overflow-y:auto;
		}
		.modal.expanded { height:92vh; }
		.modal.minimized {
			right:8px; bottom:8px; width:min(360px, calc(100vw - 16px));
			max-width:calc(100vw - 16px); max-height:92vh; height:auto;
		}
		.modal-backdrop:has(.modal.minimized) { padding:8px; }
	}

</style>