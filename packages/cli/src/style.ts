// Colour for human output: on when stdout is a terminal and NO_COLOR is unset,
// forced either way by --color / --no-color. Four roles, no library.
export interface Style {
  dim(s: string): string;
  bold(s: string): string;
  ok(s: string): string;
  warn(s: string): string;
  info(s: string): string;
  note(s: string): string;
}

export function style(enabled: boolean): Style {
  const wrap = (code: number) => (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s);
  return { dim: wrap(2), bold: wrap(1), ok: wrap(32), warn: wrap(33), info: wrap(36), note: wrap(35) };
}

/** The default for --color: a terminal on stdout and no NO_COLOR in the environment. */
export const colorByDefault = (): boolean => process.stdout.isTTY === true && !process.env.NO_COLOR;
