import Stats, { statsFrame } from "./stats.tsx";
import { mount } from "../src/index.ts";

mount(() => <Stats />, { beforeFrame: statsFrame });
