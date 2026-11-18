import { error } from '@sveltejs/kit';

/**
 * Adds the ownership column for existing installations and backfills legacy
 * rows. Inbound mail belongs to its recipient; sent mail belongs to its sender.
 * The operation is safe to call from every request while deployments roll out.
 */
let ownerColumnReady = false;

export async function ensureMailOwnerColumn(db: D1Database): Promise<void> {
	if (ownerColumnReady) return;
	const columns = await db.prepare('PRAGMA table_info(emails)').all<{ name: string }>();
	if (!(columns.results ?? []).some((column) => column.name === 'owner_email')) {
		try {
			await db.prepare('ALTER TABLE emails ADD COLUMN owner_email TEXT').run();
		} catch {
			// Another isolate may have added the column concurrently.
		}
	}
	await db.prepare(`
		UPDATE emails
		SET owner_email = lower(trim(CASE WHEN folder = 'sent' THEN sender_email ELSE recipient_email END))
		WHERE (owner_email IS NULL OR trim(owner_email) = '') AND folder IN ('inbox', 'sent')
	`).run();
	await db.prepare(`
		UPDATE emails
		SET owner_email = lower(trim(owner_email))
		WHERE owner_email IS NOT NULL AND owner_email != lower(trim(owner_email))
	`).run();
	await db.prepare('CREATE INDEX IF NOT EXISTS idx_emails_lower_owner_folder_created ON emails(LOWER(owner_email), folder, created_at DESC)').run();
	// Legacy Trash rows are intentionally not inferred: their original direction
	// is unknowable after folder moves, so leaving them unowned prevents disclosure.
	ownerColumnReady = true;
}

export function requireMailOwner(userEmail: string | undefined): string {
	const owner = (userEmail || '').trim().toLowerCase();
	if (!owner || !/^[^\s@]+@ggacrux\.ca$/i.test(owner)) {
		throw error(401, 'An authenticated GGacrux account is required');
	}
	return owner;
}
