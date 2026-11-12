import type PocketBase from "pocketbase";
import type { RecordAuthResponse, RecordModel } from "pocketbase";
export function refreshRelayToken(pb: PocketBase) {
	return pb.collection("users").authRefresh();
}
export function logoutRelay(pb: PocketBase) {
	pb.cancelAllRequests();
	void pb.realtime.unsubscribe();
	pb.authStore.clear();
}
export function recordOAuthResponse(
	pb: PocketBase,
	data: RecordAuthResponse<RecordModel>,
) {
	return pb
		.collection("oauth2_response")
		.create({
			user: data.record.id,
			oauth_response: data.meta?.rawUser as unknown,
		});
}
