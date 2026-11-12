import type PocketBase from "pocketbase";
export async function registerDevice(
	pb: PocketBase,
	log: (...values: unknown[]) => void,
	deviceId: string,
	platform: string,
	userId: string,
	error: (...values: unknown[]) => void = log,
): Promise<void> {
	try {
		// Try to create new device record
		await pb.collection("devices").create({
			id: deviceId,
			name: platform,
			platform: platform,
			user: userId,
		});
		log("Created new device record:", deviceId);
	} catch (e) {
		// Record may already exist, try to update
		const status = (e as { status?: number }).status;
		if (status === 400 || status === 409) {
			try {
				await pb.collection("devices").update(deviceId, {
					platform: platform,
					user: userId,
				});
				log("Updated existing device record:", deviceId);
			} catch (updateError) {
				error("Failed to update device:", updateError);
				throw updateError;
			}
		} else {
			throw e;
		}
	}
}

export async function registerVault(
	pb: PocketBase,
	log: (...values: unknown[]) => void,
	vaultId: string,
	deviceId: string,
	userId: string,
	error: (...values: unknown[]) => void = log,
): Promise<void> {
	try {
		// Try to create new vault record
		await pb.collection("vaults").create({
			id: vaultId,
			device: deviceId,
			user: userId,
		});
		log("Created new vault record:", vaultId);
	} catch (e) {
		// Record may already exist, try to update
		const status = (e as { status?: number }).status;
		if (status === 400 || status === 409) {
			try {
				await pb.collection("vaults").update(vaultId, {
					device: deviceId,
				});
				log("Updated existing vault record:", vaultId);
			} catch (updateError) {
				error("Failed to update vault:", updateError);
				throw updateError;
			}
		} else {
			throw e;
		}
	}
}
