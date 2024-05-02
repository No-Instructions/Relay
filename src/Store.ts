import { writable } from "svelte/store";
import type Live from "./main";

const plugin = writable<Live>();
export default { plugin };
