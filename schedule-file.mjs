// schedule.yml をパソコンのファイルから読む（Cloudflare では使わない）。

import { readFileSync } from 'node:fs';
import { parseSchedule } from './rules.mjs';

export const SCHEDULE_PATH = process.env.SCHEDULE_FILE ?? new URL('./schedule.yml', import.meta.url);

export const loadSchedule = (path = SCHEDULE_PATH) => parseSchedule(readFileSync(path, 'utf8'));
