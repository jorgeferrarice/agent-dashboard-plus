/**
 * Interface text in every language.
 *
 * Each area of the interface has its own file in ./messages,
 * exporting `<area>En` and `<area>Pt`. `en` defines the keys and
 * `pt` must have every one of them: the types make a missing key
 * a compile error. `{name}` in a message is filled by
 * `t(key, { name })`.
 */

import { chatEn, chatPt } from './messages/chat';
import { coreEn, corePt } from './messages/core';
import { dashboardEn, dashboardPt } from './messages/dashboard';
import { gitEn, gitPt } from './messages/git';
import { tasksEn, tasksPt } from './messages/tasks';
import { terminalEn, terminalPt } from './messages/terminal';

export const en = {
  ...chatEn,
  ...coreEn,
  ...dashboardEn,
  ...gitEn,
  ...tasksEn,
  ...terminalEn,
};

export type Messages = Record<keyof typeof en, string>;

export const pt: Messages = {
  ...chatPt,
  ...corePt,
  ...dashboardPt,
  ...gitPt,
  ...tasksPt,
  ...terminalPt,
};
