import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when this module is the process entry point, through symlinks and relative paths. */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
