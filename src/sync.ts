type FileInfo = {
	ctime: number;
	folder: string;
	hash: string;
	mtime: number;
	path: string;
	previousPath?: string;
	size: number;
	synchash: string;
	synctime: number;
};

export async function getSyncInfo(
	appId: string,
	filePath: string,
): Promise<FileInfo | null> {
	const dbName = `${appId}-sync`;
	const objectStoreName = "data";

	// First, check if the database exists
	const databases = await indexedDB.databases();
	const dbExists = databases.some((db) => db.name === dbName);

	if (!dbExists) {
		console.log(`Database ${dbName} does not exist.`);
		return null;
	}

	return new Promise((resolve, reject) => {
		const request = indexedDB.open(dbName);

		request.onerror = (event) => {
			reject(
				`Error opening database: ${(event.target as IDBOpenDBRequest).error}`,
			);
		};

		request.onsuccess = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;

			if (!db.objectStoreNames.contains(objectStoreName)) {
				db.close();
				resolve(null);
				return;
			}

			const transaction = db.transaction(objectStoreName, "readonly");
			const objectStore = transaction.objectStore(objectStoreName);

			const getRequest = objectStore.get(filePath);

			getRequest.onerror = (event) => {
				db.close();
				reject(`Error reading data: ${(event.target as IDBRequest).error}`);
			};

			getRequest.onsuccess = (event) => {
				const fileInfo = (event.target as IDBRequest).result as
					| FileInfo
					| undefined;
				db.close();
				resolve(fileInfo || null);
			};
		};
	});
}
