// See https://svelte.dev/docs/kit/types#app.d.ts
// web/src/app.d.ts
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

declare global {
	namespace App {
		interface Platform {
			env: {
				DB: D1Database;
				BUCKET?: R2Bucket;
				RESEND_API_KEY: string;
			};
		}
	}
}

export {};
