/**
 * MethodContext type — the runtime port injected by swamp into every method execute.
 *
 * Internal _lib type; NOT re-exported from the entry module. Moved here so method
 * modules can import it without depending on the entry.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { GlobalArgsSchema } from "./schemas.ts";

export type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warning: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{
    name: string;
    specName: string;
    kind: string;
    dataId: string;
    version: number;
    size: number;
  }>;
  readResource: (instanceName: string) => Promise<Record<string, unknown> | null>;
};
