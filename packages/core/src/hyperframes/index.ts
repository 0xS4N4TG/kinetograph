// `@kinetographdev/core/hyperframes`: the runtime of a HyperFrames HTML project (the CLI's loader makes the plan).

export { defineHyperframes, styleDeclarations } from './runtime.js';
export type { HfNode, HfPlan, HfScript, HfStylesheet, HfGoogleFont, HfSvgRule } from './plan.js';
export {
  TimingResolver,
  isClipVisibleAt,
  isInClipWindow,
  localTimelineTime,
  parseNumeric,
  parseStartExpression,
  seekTimelines,
} from './timing.js';
export type { SceneClock, StartExpression, TimedElement, TimelineLike, TimingEnv } from './timing.js';
export { cutToSlots, playbackRateOf, rateSpecOf, sourceOffsetOf } from './timing.js';
export { parseAutomation, rateAt, sampleLane, sourceTimeAt, timeAtSourceTime, laneGain } from './automation.js';
export type { Automation, AutomationLane, RateSpec } from './automation.js';
export { normalizeGrade, gradeFilter, curveFunction, PRESETS as GRADING_PRESETS } from './grading.js';
export type { Grade, GradeFilter, GradeStep } from './grading.js';
