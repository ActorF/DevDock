export const MAX_OUTPUT_LENGTH = 128 * 1024
const TRUNCATION_NOTICE = '[较早的输出已截断，仅保留最近的日志]\n'

export function boundedOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output
  return TRUNCATION_NOTICE + output.slice(-(MAX_OUTPUT_LENGTH - TRUNCATION_NOTICE.length))
}
