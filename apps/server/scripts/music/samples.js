// Stands in for huashu-motion's cli/lib/samples.js (MIT, see LICENSE). That file plays a pack of recorded
// instruments when one has been downloaded; Producer ships none, so every instrument and drum in score.js is
// synthesized (score.js falls back to its own voices when these return null).
// @ts-nocheck
export const hasSample = () => false;
export const sampler = () => null;
export const samplerStereo = () => null;
export const hit = () => null;
export const hitStereo = () => null;
