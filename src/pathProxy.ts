export function createPathProxy<T>(
	target: T,
	rootPath: string,
	pathConverter: (globalPath: string, rootPath: string) => string = (p, r) =>
		p.substring(r.length).replace(/^\/+/, ""),
): T {
	return new Proxy(target as any, {
		get(target, prop) {
			const originalMethod = target[prop];
			if (typeof originalMethod === "function") {
				return function (...args: any[]) {
					if (args.length > 0 && typeof args[0] === "string") {
						args[0] = pathConverter(args[0], rootPath);
					}
					return originalMethod.apply(target, args);
				};
			}
			return originalMethod;
		},
	});
}
