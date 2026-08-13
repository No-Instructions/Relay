export interface OfflineView {
	document: { disconnect(): unknown } | null;
	offlineBanner?: () => unknown;
}

export function transitionViewsOffline(views: OfflineView[]): void {
	views.forEach((view) => {
		view.document?.disconnect();
		view.offlineBanner?.();
	});
}
