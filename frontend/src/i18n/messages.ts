/**
 * Interface text in every language.
 *
 * Each area of the interface has its own file in ./messages,
 * exporting `<area>En` and `<area>Pt`. `en` defines the keys and
 * `pt` must have every one of them: the types make a missing key
 * a compile error. `{name}` in a message is filled by
 * `t(key, { name })`.
 */

import { coreEn, corePt } from './messages/core';
import { dashboardEn, dashboardPt } from './messages/dashboard';
import { tasksEn, tasksPt } from './messages/tasks';
import { terminalEn, terminalPt } from './messages/terminal';

export const en = {
  ...coreEn,
  ...dashboardEn,
  ...tasksEn,
  ...terminalEn,
};

export type Messages = Record<keyof typeof en, string>;

export const pt: Messages = {
  ...corePt,
  ...dashboardPt,
  ...tasksPt,
  ...terminalPt,
};
