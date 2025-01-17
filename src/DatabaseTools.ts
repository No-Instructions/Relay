export interface StoreAnalysis {
	slug: string;
	path: string;
	relay: string;
	appId: string;
	count: number;
	estimatedSizeMB: number;
	isLegacy: boolean;
}

export interface DBSummaryStats {
	totalStores: number;
	totalItems: number;
	totalSizeMB: number;
	databaseCount: number;
	largeStores: StoreAnalysis[];
}

export async function analyzeIndexedDB(options: {
	appId: string;
	filterByAppId: boolean;
	onProgress?: (progress: number) => void;
}): Promise<DBSummaryStats> {
	const { appId, filterByAppId, onProgress } = options;
	const databases = await window.indexedDB.databases();
	const totalDatabases = databases.length;
	const largeStores: StoreAnalysis[] = [];
	let totalStores = 0;
	let totalItems = 0;
	let totalSize = 0;

	let processedDatabases = 0;

	for (const dbInfo of databases) {
		if (!dbInfo.name) continue;

		try {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(dbInfo.name!);
				request.onerror = () => reject(request.error);
				request.onsuccess = (event) =>
					resolve((event.target as IDBRequest<IDBDatabase>).result);
			});

			try {
				const storeNames = Array.from(db.objectStoreNames);
				if (!storeNames.includes("updates") || !storeNames.includes("custom")) {
					continue;
				}

				const tx = db.transaction(["updates", "custom"], "readonly");
				const store = tx.objectStore("updates");
				const customStore = tx.objectStore("custom");

				const dbAppId = await new Promise<string>((resolve) => {
					const request = customStore.get("appId");
					request.onsuccess = () => resolve(request.result || "");
				});

				// Always count totals if it's a relay database structure
				totalStores++;

				const count = await new Promise<number>((resolve, reject) => {
					const countRequest = store.count();
					countRequest.onsuccess = () => resolve(countRequest.result);
					countRequest.onerror = () => reject(countRequest.error);
				});

				totalItems += count;

				if (count > 0) {
					let storeSize = 0;
					await new Promise<void>((resolve, reject) => {
						const cursorRequest = store.openCursor();
						cursorRequest.onsuccess = (event) => {
							const cursor = (event.target as IDBRequest<IDBCursorWithValue>)
								.result;
							if (cursor) {
								const size =
									cursor.value instanceof Uint8Array
										? cursor.value.byteLength
										: JSON.stringify(cursor.value).length;
								storeSize += size;
								cursor.continue();
							} else {
								resolve();
							}
						};
						cursorRequest.onerror = () => reject(cursorRequest.error);
					});

					totalSize += storeSize;

					// Only add to largeStores if it belongs to current vault OR global search is enabled
					if (
						storeSize > 1024 * 1024 &&
						(!filterByAppId || dbAppId === appId)
					) {
						const path = await new Promise<string>((resolve) => {
							const request = customStore.get("path");
							request.onsuccess = () => resolve(request.result || "");
						});

						const relay = await new Promise<string>((resolve) => {
							const request = customStore.get("relay");
							request.onsuccess = () => resolve(request.result || "");
						});

						const isLegacy = !dbInfo.name.startsWith(`${appId}-relay`);

						largeStores.push({
							slug: `${dbInfo.name}/${store.name}`,
							path,
							relay,
							appId: dbAppId || "unknown",
							count,
							estimatedSizeMB:
								Math.round((storeSize / (1024 * 1024)) * 100) / 100,
							isLegacy,
						});
					}
				}
			} finally {
				db.close();
			}
		} catch (error) {
			console.error(`Error processing database ${dbInfo.name}:`, error);
			continue;
		}

		processedDatabases++;
		if (onProgress) {
			onProgress((processedDatabases / databases.length) * 100);
		}
	}

	return {
		totalStores,
		totalItems,
		totalSizeMB: Math.round((totalSize / (1024 * 1024)) * 100) / 100,
		databaseCount: totalDatabases,
		largeStores: largeStores.sort(
			(a, b) => b.estimatedSizeMB - a.estimatedSizeMB,
		),
	};
}

export async function deleteBySlug(slug: string): Promise<void> {
	const [dbName, storeName] = slug.split("/");

	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(dbName);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});

	try {
		const tx = db.transaction(storeName, "readwrite");
		const store = tx.objectStore(storeName);

		await new Promise<void>((resolve, reject) => {
			const request = store.clear();
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	} catch (error) {
		console.error(`Error deleting store: ${slug}`, error);
	} finally {
		db.close();
	}
}
