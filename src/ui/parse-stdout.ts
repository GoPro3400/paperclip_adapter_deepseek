import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { createStdoutParser, parseStdoutLine } from "../ui-parser.js";

export function parseDeepSeekStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseStdoutLine(line, ts) as TranscriptEntry[];
}

export function createDeepSeekStdoutParser(): { parseLine(line: string, ts: string): TranscriptEntry[]; reset(): void } {
  const parser = createStdoutParser();
  return {
    parseLine: (line, ts) => parser.parseLine(line, ts) as TranscriptEntry[],
    reset: () => parser.reset(),
  };
}
