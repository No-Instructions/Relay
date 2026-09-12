import type { CanvasPoint } from "../CanvasView";

/** The shortest and longest a peer's point is rendered behind its newest sample. */
export const CURSOR_DELAY_MIN_MS = 40;
export const CURSOR_DELAY_MAX_MS = 200;
/** Arrival gaps longer than this are a pause, not evidence about cadence. */
const CADENCE_GAP_MAX_MS = 160;
/** How much a new arrival gap moves the running cadence and jitter estimates. */
const CADENCE_WEIGHT = 0.3;
const JITTER_WEIGHT = 0.3;
/** The delay covers one cadence plus this many jitter deviations plus a margin. */
const JITTER_MULTIPLE = 2.5;
const DELAY_MARGIN_MS = 10;
/** Samples older than the delay window are dropped; this bounds the buffer. */
const MAX_SAMPLES = 32;

/** Anything made of numbers: a point, a box, a box with a pointer offset. */
export type TrackValue<T> = Record<keyof T, number>;

export interface TrackSample<T extends TrackValue<T>> {
	/** Arrival time, ms on the local performance clock. */
	t: number;
	value: T;
}

/** The stretch of trail a new sample added: from the previous sample to it. */
export interface TrackSegment<T extends TrackValue<T>> {
	from: TrackSample<T> | null;
	to: TrackSample<T>;
}

export type TrackedValue<T extends TrackValue<T>> = T & {
	/** True once render time has reached the newest sample: nothing left to play. */
	settled: boolean;
};

/**
 * A timestamped trail of a peer's value, played back a short delay behind
 * arrival by interpolating every field between the two samples around
 * render time. Arrivals may bunch or spread inside the delay without
 * changing the motion on screen, so constant-velocity input renders as
 * constant-velocity motion, and fields sampled together stay together.
 * The delay follows the peer's measured cadence and jitter, so it stays as
 * short as the arrivals allow and grows when the sender stalls, absorbing
 * the stall instead of showing it.
 */
export class PointTrack<T extends TrackValue<T> = CanvasPoint> {
	private samples: TrackSample<T>[] = [];
	private cadence: number | null = null;
	private jitter = 0;

	/** A sample arrived at `t`; returns the segment of trail it added. */
	push(t: number, value: T): TrackSegment<T> {
		const last = this.samples[this.samples.length - 1];
		if (last) {
			const gap = t - last.t;
			if (gap <= 0) {
				// Same instant: the newer value wins.
				last.value = { ...value };
				return { from: null, to: last };
			}
			if (gap <= CADENCE_GAP_MAX_MS) {
				if (this.cadence === null) {
					this.cadence = gap;
				} else {
					this.jitter += (Math.abs(gap - this.cadence) - this.jitter) * JITTER_WEIGHT;
					this.cadence += (gap - this.cadence) * CADENCE_WEIGHT;
				}
			}
		}
		const sample: TrackSample<T> = { t, value: { ...value } };
		this.samples.push(sample);
		if (this.samples.length > MAX_SAMPLES) {
			this.samples.splice(0, this.samples.length - MAX_SAMPLES);
		}
		return { from: last ?? null, to: sample };
	}

	/** How far behind the newest sample the value is rendered; the minimum until a cadence is known. */
	delay(): number {
		if (this.cadence === null) return CURSOR_DELAY_MIN_MS;
		const wanted = this.cadence + this.jitter * JITTER_MULTIPLE + DELAY_MARGIN_MS;
		return Math.min(CURSOR_DELAY_MAX_MS, Math.max(CURSOR_DELAY_MIN_MS, wanted));
	}

	/** The value at wall time `now`, or null before any sample. */
	sample(now: number): TrackedValue<T> | null {
		const samples = this.samples;
		if (samples.length === 0) return null;
		const renderTime = now - this.delay();
		const newest = samples[samples.length - 1];
		if (renderTime >= newest.t) {
			return { ...newest.value, settled: true };
		}
		const oldest = samples[0];
		if (renderTime <= oldest.t) {
			return { ...oldest.value, settled: false };
		}
		let i = samples.length - 2;
		while (i > 0 && samples[i].t > renderTime) i--;
		const a = samples[i];
		const b = samples[i + 1];
		const span = b.t - a.t;
		const f = span > 0 ? (renderTime - a.t) / span : 1;
		// Samples behind render time are never needed again.
		if (i > 0) samples.splice(0, i);
		const out = { ...b.value } as Record<string, number>;
		const older = a.value as Record<string, number>;
		for (const key of Object.keys(out)) {
			const from = older[key];
			const to = out[key];
			// A field the older sample lacks holds the newer value.
			out[key] = typeof from === "number" ? from + (to - from) * f : to;
		}
		return { ...(out as unknown as T), settled: false };
	}

	/** The newest sample, for anchoring things that follow the value exactly. */
	latest(): T | null {
		const newest = this.samples[this.samples.length - 1];
		return newest ? { ...newest.value } : null;
	}

	reset(): void {
		this.samples = [];
		this.cadence = null;
		this.jitter = 0;
	}
}
