<script lang="ts">
	import { onMount } from 'svelte';
	import { buildSandboxedEmailHtml } from '../lib/sanitize';

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
	let sanitizedSrcDoc = '';
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
	let profileName = 'GGacrux';
	let profilePhoto = '';
	let emailSignature = '';
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

		localStorage.setItem('ggacrux_profile', JSON.stringify({ displayName: fromName, photo: profilePhoto, signature: emailSignature, theme: selectedTheme }));

	}

	function changeTheme(theme: 'slate' | 'midnight' | 'nordic') {

		selectedTheme = theme; document.documentElement.dataset.theme = theme;

		localStorage.setItem('ggacrux_theme', theme);

		localStorage.setItem('ggacrux_profile', JSON.stringify({ displayName: profileName, photo: profilePhoto, signature: emailSignature, theme }));

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

			localStorage.setItem('ggacrux_profile', JSON.stringify({ displayName: profileName, photo: profilePhoto, signature: emailSignature, theme: selectedTheme }));

		} catch { notify('Could not process that image'); }

	}

	function notify(msg: string) {
		statusMessage = msg;
		setTimeout(() => {
			if (statusMessage === msg) statusMessage = '';
		}, 3500);
	}

	async function loadEmails(silent = false) {
		if (!silent) { loadingList = true; listOffset = 0; }
		try {
			const params = new URLSearchParams({ folder, limit: '25', offset: '0' });
			if (virtualFolder) params.set('virtualFolder', virtualFolder); if (activeTag) params.set('tag', activeTag);
			if (searchQuery.trim()) params.set('q', searchQuery.trim());
			const res = await fetch(`/api/emails?${params}`);
			if (!res.ok) throw new Error('Failed to load emails');
			const payload = await res.json();
			if (silent) {
				const fresh = payload.emails as EmailSummary[];
				const known = new Set(emails.map((item) => item.id));
				emails = [...fresh, ...emails.filter((item) => !known.has(item.id))];
			} else { emails = payload.emails; listOffset = payload.emails.length; }
			unreadCount = payload.unreadCount;
			totalCount = payload.totalCount;
			hasMore = payload.hasMore;
		} catch (err) { if (!silent) notify((err as Error).message); }
		finally { if (!silent) loadingList = false; }
	}

	async function loadMore() {
		if (loadingMore || !hasMore) return;
		loadingMore = true;
		try {
			const params = new URLSearchParams({ folder, limit: '25', offset: String(listOffset) });
			if (virtualFolder) params.set('virtualFolder', virtualFolder); if (activeTag) params.set('tag', activeTag);
			if (searchQuery.trim()) params.set('q', searchQuery.trim());
			const res = await fetch(`/api/emails?${params}`);
			if (!res.ok) throw new Error('Failed to load more messages');
			const payload = await res.json();
			emails = [...emails, ...payload.emails.filter((item: EmailSummary) => !emails.some((old) => old.id === item.id))];
			listOffset += payload.emails.length;
			hasMore = payload.hasMore;
			totalCount = payload.totalCount;
		} catch (err) { notify((err as Error).message); }
		finally { loadingMore = false; }
	}

	function handleSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			loadEmails();
		}, 250);
	}

	function switchFolder(nextFolder: 'inbox' | 'sent' | 'trash') {
		folder = nextFolder;
		unreadOnly = false;
		selectedEmail = null;
		attachments = [];
		selectedIds = [];
		loadEmails();
	}

	async function selectEmail(item: EmailSummary) {
		loadingDetail = true;
		try {
			const res = await fetch(`/api/emails/${item.id}`);
			if (!res.ok) throw new Error('Failed to load message');
			const payload = await res.json();
			selectedEmail = payload.email;
			attachments = payload.attachments || [];
			const threadRes = await fetch('/api/emails?threadId=' + encodeURIComponent(item.message_id || item.id));
			if (threadRes.ok) { const threadPayload = await threadRes.json(); threadMessages = threadPayload.emails || []; } else threadMessages = [{ ...payload.email, attachments: payload.attachments || [] }];

			if (selectedEmail?.html_body) {
				sanitizedSrcDoc = buildSandboxedEmailHtml(selectedEmail.html_body);
			} else {
				sanitizedSrcDoc = '';
			}

			// Mark as read automatically if unread
			if (item.is_read === 0) {
				await fetch(`/api/emails/${item.id}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ is_read: 1 })
				});
				item.is_read = 1;
				if (selectedEmail) selectedEmail = { ...selectedEmail, is_read: 1 };
				emails = [...emails];
				if (folder === 'inbox' && unreadCount > 0) unreadCount -= 1;
			}
		} catch (err) {
			notify((err as Error).message);
		} finally {
			loadingDetail = false;
		}
	}


	async function bulkUpdate(action: 'read' | 'unread' | 'trash' | 'delete') {
		if (!selectedIds.length || bulkWorking) return;
		if (action === 'delete' && !confirm(`Permanently delete ${selectedIds.length} selected messages?`)) return;
		bulkWorking = true;
		try {
			const idsToUpdate = [...selectedIds];
		await Promise.all(idsToUpdate.map((id) => action === 'delete'
				? fetch(`/api/emails/${id}`, { method: 'DELETE' })
				: fetch(`/api/emails/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'trash' ? { folder: 'trash' } : { is_read: action === 'read' ? 1 : 0 }) })));
			if (selectedEmail && idsToUpdate.includes(selectedEmail.id) && (action === 'trash' || action === 'delete')) selectedEmail = null;
			selectedIds = [];
			await loadEmails();
			notify('Bulk action complete');
		} catch { notify('Some messages could not be updated'); }
		finally { bulkWorking = false; }
	}

	async function toggleRead(email: EmailDetail) {
		const nextState = email.is_read === 1 ? 0 : 1;
		await fetch(`/api/emails/${email.id}`, {
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
					fetch(`/api/emails/${item.id}`, {
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
		await fetch(`/api/emails/${id}`, {
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
		const res = await fetch(`/api/emails/${id}`, { method: 'DELETE' });
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
			await Promise.all(emails.map((item) => fetch(`/api/emails/${item.id}`, { method: 'DELETE' })));
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

	async function loadStorage() { try { const r = await fetch('/api/storage'); if (r.ok) storage = await r.json(); } catch { /* optional metrics */ } }
	function storagePercent(bytes: number, limit: number) { return Math.min(100, Math.max(0, bytes / limit * 100)); }
	function storageTone(bytes: number, limit: number) { const p = storagePercent(bytes, limit); return p > 90 ? 'danger' : p > 75 ? 'warning' : ''; }
	function selectVirtualView(value: string) { virtualFolder = value; activeTag = ''; selectedEmail = null; threadMessages = []; selectedIds = []; loadEmails(); }
	function createLabel() { const name = prompt('Label name'); if (!name?.trim()) return; const color = prompt('Label color (hex)', '#2563eb') || '#2563eb'; labels = [...labels, { name: name.trim(), color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#2563eb' }]; localStorage.setItem('ggacrux_labels', JSON.stringify(labels)); }
	async function toggleEmailTag(email: EmailSummary, tag: string) { let current: string[] = []; try { current = JSON.parse((email as EmailSummary & { tags?: string }).tags || '[]'); } catch {} const next = current.includes(tag) ? current.filter((v) => v !== tag) : [...current, tag]; const r = await fetch('/api/emails', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [email.id], tags: next }) }); if (!r.ok) { notify('Could not update labels'); return; } (email as EmailSummary & { tags?: string }).tags = JSON.stringify(next); emails = [...emails]; if (selectedEmail?.id === email.id) selectedEmail = { ...selectedEmail, tags: JSON.stringify(next) }; }
	function handleFiles(event: Event) { const input = event.currentTarget as HTMLInputElement; const next = [...attachmentFiles, ...Array.from(input.files || [])]; if (next.reduce((n, f) => n + f.size, 0) > attachmentLimit) { attachmentError = 'Attachments must total 10 MB or less.'; input.value = ''; return; } attachmentFiles = next; attachmentError = ''; input.value = ''; }
	function removeFile(index: number) { attachmentFiles = attachmentFiles.filter((_, i) => i !== index); attachmentError = ''; }
	function formatCommand(command: string) { editorEl?.focus(); if (command === 'createLink') { const url = prompt('Link URL'); if (!url) return; document.execCommand(command, false, url); } else document.execCommand(command); if (editorEl) { htmlBody = editorEl.innerHTML; textBody = editorEl.innerText; } }
	function updateVisualBody() { if (editorEl) { htmlBody = editorEl.innerHTML; textBody = editorEl.innerText; } }
	function openCompose() {
		composeError = '';
		if (userEmail) fromAlias = userEmail;
		fromName = profileName || (userEmail.split('@')[0] || 'GGacrux');
		if (!restoredDraft) { to = ''; cc = ''; bcc = ''; subject = ''; textBody = emailSignature ? '\n\n' + emailSignature : ''; htmlBody = emailSignature ? '<p>' + emailSignature + '</p>' : ''; }
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
		textBody = (emailSignature ? emailSignature + '\n\n' : '') + `\n\n--- On ${quotedDate}, ${email.sender_email} wrote: ---\n${quotedText}`;
		htmlBody = '<p>' + textBody.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>';
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
		textBody = (emailSignature ? emailSignature + '\n\n' : '') + `\n\n---------- Forwarded message ----------\nFrom: ${email.sender_email}\nDate: ${new Date(email.created_at).toLocaleString()}\nSubject: ${email.subject}\nTo: ${email.recipient_email}\n\n${email.text_body || ''}`;
		htmlBody = '<p>' + textBody.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>';
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
			form.set('fromName', fromName); form.set('to', to); form.set('cc', cc); form.set('bcc', bcc); form.set('subject', subject); form.set('text', textBody); form.set('html', htmlMode ? htmlBody : (editorEl?.innerHTML || htmlBody));
			if (inReplyTo) form.set('inReplyTo', inReplyTo); if (references) form.set('references', references);
			for (const file of attachmentFiles) form.append('attachments', file, file.name);
			const res = await fetch('/api/emails/send', { method: 'POST', body: form });
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

	function handleKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		const isTyping =
			target &&
			(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

		if (event.key === 'Escape') {
			if (showCompose) {
				composeMinimized = true;
			} else if (selectedEmail) {
				selectedEmail = null;
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

	function formatDate(iso: string): string {
		const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
		const now = new Date();
		if (d.toDateString() === now.toDateString()) {
			return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		}
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	onMount(() => {
		if (data?.userEmail && data.userEmail.toLowerCase().endsWith('@ggacrux.ca')) {
			fromAlias = data.userEmail;
		}
		if (userEmail) fromAlias = userEmail;
		try {
			const profile = JSON.parse(localStorage.getItem('ggacrux_profile') || '{}');
			profileName = profile.displayName || (userEmail.split('@')[0] || 'GGacrux'); fromName = profileName;
			profilePhoto = profile.photo || ''; emailSignature = profile.signature || '';
			selectedTheme = profile.theme || localStorage.getItem('ggacrux_theme') || 'slate';
			document.documentElement.dataset.theme = selectedTheme;
		} catch { profileName = userEmail.split('@')[0] || 'GGacrux'; }
		try { quickLinks = JSON.parse(localStorage.getItem('ggacrux_quick_links') || '[]'); } catch { quickLinks = []; }
		try { labels = JSON.parse(localStorage.getItem('ggacrux_labels') || '[]'); } catch { labels = []; }
		void loadStorage();
		const saved = localStorage.getItem(draftKey);
		if (saved) { try { const draft = JSON.parse(saved); to = draft.to || ''; cc = draft.cc || ''; bcc = draft.bcc || ''; subject = draft.subject || ''; textBody = draft.textBody || ''; htmlBody = draft.htmlBody || ''; fromAlias = userEmail; fromName = draft.fromName || fromName; restoredDraft = true; } catch { localStorage.removeItem(draftKey); } }
		const draftTimer = setInterval(() => { if (showCompose) localStorage.setItem(draftKey, JSON.stringify({ to, cc, bcc, subject, textBody, htmlBody: editorEl?.innerHTML || htmlBody, fromName })); }, 800);
		observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) loadMore(); }, { root: null, rootMargin: '240px' });
		loadEmails().then(() => { if (sentinelEl) observer?.observe(sentinelEl); });

		// Auto-refresh inbox/folder every 30s when tab is active
		const pollInterval = setInterval(() => {
			if (!document.hidden && !showCompose) {
				loadEmails(true); loadStorage();
			}
		}, 30000);

		return () => { clearInterval(pollInterval); clearInterval(draftTimer); observer?.disconnect(); };
	});
</script>

<svelte:window on:keydown={handleKeydown} />

<svelte:head>
	<title>GGacrux Mail {unreadCount > 0 ? `(${unreadCount})` : ''}</title>
</svelte:head>

<div class="app-shell">
	<!-- Pane 1: Sidebar -->
	<aside class="sidebar">
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

		<div class="quick-links">
			<div class="quick-links-heading"><strong>Quick Links</strong><button class="quick-add" type="button" aria-label="Add quick link" title="Add bookmark" on:click={addQuickLink}>+</button></div>
			{#each quickLinks as link (link.id)}
				<div class="quick-link-item"><a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>{link.title}</a><button type="button" class="quick-remove" aria-label="Remove {link.title}" title="Remove bookmark" on:click={() => removeQuickLink(link.id)}>×</button></div>
			{/each}
		</div>
		<div class="sidebar-footer">
			<button type="button" class="profile-trigger" on:click={() => (showProfile = true)} title="Profile & Appearance">
				{#if profilePhoto}<img class="profile-avatar" src={profilePhoto} alt="Profile photo" />{:else}<span class="profile-avatar profile-initial">{avatarInitial}</span>{/if}
				<span class="profile-label"><strong>{profileName || 'Profile'}</strong><small class="user-email" title={userEmail}>{userEmail}</small></span>
			</button>
			<a href="/cdn-cgi/access/logout" class="btn-logout">Log out</a>
		</div>
	</aside>

	<!-- Pane 2: Message List -->
	<section class="message-list-pane" class:hidden-mobile={selectedEmail !== null}>
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
			<div class="list-subbar"><span>{selectedIds.length} selected</span>
				<button class="btn-link" on:click={() => bulkUpdate('read')}>Mark read</button>
				<button class="btn-link" on:click={() => bulkUpdate('unread')}>Mark unread</button>
				<button class="btn-link danger" on:click={() => bulkUpdate('trash')}>Trash</button>
				<button class="btn-link danger" on:click={() => bulkUpdate('delete')}>Delete permanently</button>
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
	<main class="reading-pane" class:hidden-mobile={selectedEmail === null}>
		{#if loadingDetail}
			<div class="empty-state">Loading conversation...</div>
		{:else if !selectedEmail}
			<div class="empty-state">Select a message to read</div>
		{:else}
			<div class="reading-toolbar">
				<button class="btn-secondary mobile-back" on:click={() => (selectedEmail = null)}>
					← Back
				</button>
				<div class="toolbar-actions">
					<button class="btn-primary" on:click={() => selectedEmail && openReply(selectedEmail)}>Reply</button>
					<button class="btn-secondary" on:click={() => selectedEmail && openReplyAll(selectedEmail)}>Reply all</button>
					<button class="btn-secondary" on:click={() => selectedEmail && openForward(selectedEmail)}>Forward</button>
					<button class="btn-secondary" on:click={() => selectedEmail && toggleRead(selectedEmail)}>
						Mark {selectedEmail.is_read === 1 ? 'Unread' : 'Read'}
					</button>
					{#if selectedEmail.folder !== 'trash'}
						<button
							class="btn-secondary"
							on:click={() => selectedEmail && moveToFolder(selectedEmail.id, 'trash')}
						>
							Trash
						</button>
					{:else}
						<button
							class="btn-secondary"
							on:click={() => selectedEmail && moveToFolder(selectedEmail.id, 'inbox')}
						>
							Restore
						</button>
						<button
							class="btn-danger"
							on:click={() => selectedEmail && permanentDelete(selectedEmail.id)}
						>
							Permanent Delete
						</button>
					{/if}
				</div>
			</div>

			<div class="email-header">
				<h2>{selectedEmail.subject || '(No Subject)'}</h2>
				<div class="meta-grid">
					<div>
						<strong>From:</strong>
						{selectedEmail.sender_name
							? `${selectedEmail.sender_name} <${selectedEmail.sender_email}>`
							: selectedEmail.sender_email}
					</div>
					<div><strong>To:</strong> {selectedEmail.recipient_email}</div>
					<div>
						<strong>Date:</strong>
						{new Date(
							selectedEmail.created_at.endsWith('Z')
								? selectedEmail.created_at
								: selectedEmail.created_at + 'Z'
						).toLocaleString()}
					</div>
				</div>

				{#if attachments.length > 0}
					<div class="attachments-bar">
						{#each attachments as att (att.id)}
							{#if att.r2_key}
								<a class="attachment-chip" href="/api/attachments/{att.id}" download={att.filename}>
									📎 {att.filename} ({formatBytes(att.size_bytes)})
								</a>
							{:else}
								<span class="attachment-chip disabled" title="R2 storage not enabled">
									📎 {att.filename} ({formatBytes(att.size_bytes)} — metadata only)
								</span>
							{/if}
						{/each}
					</div>
				{/if}
			</div>

			<div class="email-body-container">
				{#if sanitizedSrcDoc}
					<iframe
						title="Email content"
						sandbox="allow-popups allow-popups-to-escape-sandbox"
						srcdoc={sanitizedSrcDoc}
					></iframe>
				{:else}
					<pre class="plain-body">{selectedEmail.text_body || '(Empty message)'}</pre>
				{/if}
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
				<div class="form-row">
					<label for="fromAlias">From (@ggacrux.ca)</label>
					<input id="fromAlias" type="email" bind:value={fromAlias} required />
				</div>
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
				<div class="form-row">
					<label for="body">Message</label>
					<textarea id="body" rows="10" bind:value={textBody} required></textarea>
				</div>

				{#if composeError}
					<div class="error-banner">{composeError}</div>
				{/if}

				<div class="modal-footer">
					<button type="button" class="btn-secondary" on:click={() => (composeMinimized = true)}>Minimize</button>
					<button type="submit" class="btn-primary" disabled={sending}>
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
		<section class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
			<div class="modal-header"><h3 id="profile-title">Profile &amp; Appearance</h3><button class="btn-icon" type="button" on:click={() => { saveProfile(); showProfile = false; }}>✕</button></div>
			<div class="profile-editor">
				{#if profilePhoto}<img class="profile-preview" src={profilePhoto} alt="Profile preview" />{:else}<span class="profile-preview profile-initial">{avatarInitial}</span>{/if}
				<div><label class="field-label" for="profile-photo">Profile picture</label><input id="profile-photo" type="file" accept="image/*" on:change={handleProfilePhoto} /><button class="btn-link" type="button" on:click={() => { profilePhoto = ''; saveProfile(); }}>Remove photo</button></div>
			</div>
			<div class="form-row"><label for="profile-name">Display name</label><input id="profile-name" bind:value={profileName} on:input={saveProfile} /></div>
			<div class="form-row"><label for="profile-signature">Email signature</label><textarea id="profile-signature" rows="5" bind:value={emailSignature} on:input={saveProfile} placeholder="Kind regards,&#10;Your name"></textarea></div>
			<div class="form-row"><span class="field-label">Theme</span><div class="theme-options">
				<button type="button" class:theme-active={selectedTheme === 'slate'} on:click={() => changeTheme('slate')}>Slate Light</button>
				<button type="button" class:theme-active={selectedTheme === 'midnight'} on:click={() => changeTheme('midnight')}>Midnight Dark</button>
				<button type="button" class:theme-active={selectedTheme === 'nordic'} on:click={() => changeTheme('nordic')}>Nordic Blue</button>
			</div></div>
			<div class="modal-footer"><button class="btn-primary" type="button" on:click={() => { saveProfile(); showProfile = false; }}>Save changes</button></div>
		</section>
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
	.email-header h2 {
		margin: 0 0 10px 0;
		font-size: 18px;
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
	.email-body-container iframe {
		width: 100%;
		height: 100%;
		border: none;
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

	.mobile-back {
		display: none;
	}
	@media (max-width: 900px) {
		.app-shell { height: 100dvh; }
		.sidebar { overflow-x:auto; }
		.modal-backdrop { padding: 0; align-items: stretch; }
		.modal, .modal.expanded { width:100%; max-width:none; height:100%; border-radius:0; overflow-y:auto; }
		.modal.minimized { right:10px; bottom:10px; height:auto; border-radius:10px; }
		.modal-backdrop:has(.modal.minimized) { padding:0; }
		.reading-toolbar { align-items:flex-start; flex-direction:column; }
		.toolbar-actions { width:100%; }
		.toolbar-actions button { flex:1; }

		.app-shell {
			grid-template-columns: 1fr;
		}
		.sidebar {
			flex-direction: row;
			align-items: center;
			padding: 10px;
		}
		.nav-folders {
			flex-direction: row;
		}
		.sidebar-footer {
			margin-top: 0;
			margin-left: auto;
			padding-top: 0;
			border-top: none;
		}
		.user-email {
			display: none;
		}
		.hidden-mobile {
			display: none;
		}
		.mobile-back {
			display: inline-block;
		}
	}

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
	.settings-modal .form-row input, .settings-modal .form-row textarea { background:var(--bg-surface); color:var(--text-primary); border-color:var(--border-color); }
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

</style>