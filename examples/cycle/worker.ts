import { main } from './index.js';

export function worker(): string {
  return typeof main;
}
