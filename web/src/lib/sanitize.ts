// web/src/lib/sanitize.ts
import DOMPurify from 'dompurify';

export function buildSandboxedEmailHtml(rawHtml: string): string {
	const clean = DOMPurify.sanitize(rawHtml, {
		USE_PROFILES: { html: true },
		FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
		FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur']
	});

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<base target="_blank" rel="noopener noreferrer" />
<style>
	body {
		margin: 0;
		padding: 16px;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		font-size: 14px;
		line-height: 1.6;
		color: #1e293b;
		word-wrap: break-word;
	}
	img { max-width: 100%; height: auto; }
	a { color: #2563eb; }
	blockquote {
		margin: 8px 0;
		padding-left: 12px;
		border-left: 3px solid #cbd5e1;
		color: #475569;
	}
</style>
</head>
<body>${clean}</body>
</html>`;
}
