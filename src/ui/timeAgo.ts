export function formatTimeAgo(timestamp: number, now: number): string {
	const seconds = Math.floor((now - timestamp) / 1000);
	if (seconds < 10) return "just now";
	if (seconds < 60) return "a few seconds ago";

	const minutes = Math.floor(seconds / 60);
	if (minutes === 1) return "1 minute ago";
	if (minutes < 60) return `${minutes} minutes ago`;

	const hours = Math.floor(minutes / 60);
	if (hours === 1) return "1 hour ago";
	if (hours < 24) return `${hours} hours ago`;

	const days = Math.floor(hours / 24);
	if (days === 1) return "1 day ago";
	if (days < 7) return `${days} days ago`;

	const weeks = Math.floor(days / 7);
	if (weeks === 1) return "1 week ago";
	if (days < 30) return `${weeks} weeks ago`;

	const months = Math.floor(days / 30);
	if (months === 1) return "1 month ago";
	if (days < 365) return `${months} months ago`;

	const years = Math.floor(days / 365);
	if (years === 1) return "1 year ago";
	return `${years} years ago`;
}
