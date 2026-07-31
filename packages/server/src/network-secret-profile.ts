import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NetworkSecretKind, NetworkSecretRecord, NetworkSecretStore } from "@shuvgeist/driver/network-redaction";

interface StoredNetworkSecret {
	source: string;
	kind: NetworkSecretKind;
	value: string;
	updatedAt: string;
}

interface StoredNetworkSecretProfile {
	version: 1;
	slots: Record<string, StoredNetworkSecret>;
}

export class FileNetworkSecretProfile implements NetworkSecretStore {
	private readonly slots = new Map<string, StoredNetworkSecret>();
	private loaded = false;
	private tail: Promise<void> = Promise.resolve();

	constructor(private readonly path: string) {}

	put(record: NetworkSecretRecord): void {
		this.tail = this.tail
			.then(async () => {
				await this.load();
				this.slots.set(record.slot, {
					source: record.source,
					kind: record.kind,
					value: record.value,
					updatedAt: new Date().toISOString(),
				});
				await this.write();
			})
			.catch(() => undefined);
	}

	async flush(): Promise<void> {
		await this.tail;
	}

	async readSlot(slot: string): Promise<StoredNetworkSecret | undefined> {
		await this.flush();
		await this.load();
		const record = this.slots.get(slot);
		return record ? { ...record } : undefined;
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		let contents: string;
		try {
			contents = await readFile(this.path, "utf8");
		} catch {
			return;
		}
		try {
			const parsed = JSON.parse(contents) as unknown;
			if (!isStoredProfile(parsed)) return;
			for (const [slot, record] of Object.entries(parsed.slots)) this.slots.set(slot, record);
		} catch {
			// A corrupt secret profile is never partially recovered or echoed.
		}
	}

	private async write(): Promise<void> {
		const directory = dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
		const profile: StoredNetworkSecretProfile = {
			version: 1,
			slots: Object.fromEntries([...this.slots.entries()].sort(([left], [right]) => left.localeCompare(right))),
		};
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await rename(temporary, this.path);
			await chmod(this.path, 0o600);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}
}

function isStoredProfile(value: unknown): value is StoredNetworkSecretProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const profile = value as Record<string, unknown>;
	if (profile.version !== 1 || !profile.slots || typeof profile.slots !== "object" || Array.isArray(profile.slots)) {
		return false;
	}
	return Object.entries(profile.slots).every(([slot, record]) => {
		if (!/^[a-f0-9]{16}$/u.test(slot) || !record || typeof record !== "object" || Array.isArray(record)) return false;
		const fields = record as Record<string, unknown>;
		return (
			typeof fields.source === "string" &&
			["header", "cookie", "json", "form", "opaque"].includes(String(fields.kind)) &&
			typeof fields.value === "string" &&
			typeof fields.updatedAt === "string" &&
			Object.keys(fields).every((key) => ["source", "kind", "value", "updatedAt"].includes(key))
		);
	});
}
