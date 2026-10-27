// Copier's bookkeeping in a generated project (§ 3 PLX-Updates): the answers
// file records the template (`_src_path`) and the version it was last synced
// to (`_commit`), plus the answers given. A template is a directory carrying a
// `copier.yml`.
import { parse } from 'yaml';

export const ANSWERS_FILE = '.copier-answers.yml';
export const TEMPLATE_FILES = ['copier.yml', 'copier.yaml'];

export interface Answers {
  /** The template's ref the project was last updated to, if recorded. */
  commit?: string;
  /** Where the template comes from, e.g. `gh:plexus-ms/preset-repo-web`. */
  src?: string;
  /** Every other answer, by question name. */
  answers: Record<string, unknown>;
}

export function parseAnswers(text: string): Answers {
  const data: unknown = parse(text);
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new Error('answers file is not a mapping');
  const { _commit, _src_path, ...answers } = data as Record<string, unknown>;
  return {
    commit: _commit === undefined ? undefined : String(_commit),
    src: _src_path === undefined ? undefined : String(_src_path),
    answers,
  };
}
